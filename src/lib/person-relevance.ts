/**
 * Person relevance pure functions — Stage 23.
 *
 * PURE: no I/O. All inputs passed by caller. Deterministic given identical inputs.
 *
 * Three-step model:
 *
 *   1. classifyTitle(jobTitle)
 *      Normalizes a free-text job title to (function, seniority, confidence).
 *      Keyword-based — no AI. rawTitle intentionally not returned (PII).
 *
 *   2. parseTargetingPersona(targetingLevel)
 *      Extracts target functions and minimum seniority from campaign_strategies.targeting_level.
 *      Same keyword approach as classifyTitle — deterministic.
 *
 *   3. Scoring pipeline (all INITIAL_HYPOTHESIS_NOT_VALIDATED):
 *      a. evaluateHardDisqualifiers()   — binary gate, returns PersonRelevanceReason|null
 *      b. computeFunctionMatchScore()   — 0-100
 *      c. computeSeniorityMatchScore()  — 0-100
 *      d. computeSignalAlignmentBonus() — 0-20
 *      e. computeRelevanceScore()       — weighted combination
 *      f. evaluatePersonRelevantGate()  — boolean threshold gate
 *
 * ── Hard disqualifiers vs scoring ────────────────────────────────────────────
 *
 * Hard disqualifiers fire BEFORE scoring:
 *   NO_TITLE:       contacts.job_title is null or empty
 *   WRONG_FUNCTION: explicit target functions specified AND contact has no
 *                   direct or adjacent function overlap
 *   WRONG_SENIORITY: explicit minimum seniority specified AND contact seniority
 *                    is known AND below the minimum
 *
 * UNKNOWN seniority does NOT trigger WRONG_SENIORITY — it receives a low
 * seniorityMatch score (30) instead. A VP+ target with UNKNOWN seniority gets
 * a low score, not a hard block.
 *
 * ── AI narrative ─────────────────────────────────────────────────────────────
 *
 * buildPersonRelevanceAiInput() constructs a SignalIntelligenceInput that guides
 * the existing analyzeSignals() infrastructure toward person-relevance reasoning.
 * The AI does NOT participate in computing the relevance score — it only explains
 * the deterministic result.
 *
 * Primary evidence in the prompt: function, seniority, signals, campaign targeting.
 * Secondary context (labeled): Stage 22 Why Now narrative (may be null).
 * AI must never treat secondary context as source evidence.
 * Raw job title is passed for natural-language rendering but NOT stored.
 *
 * ── Staleness predicates ─────────────────────────────────────────────────────
 *
 * isContactIntelligenceStale() and isCampaignRelevanceStale() implement the
 * event-driven invalidation model with a 7-day absolute ceiling.
 *
 * Note: contacts table has no updated_at column — title/email changes can only
 * be caught by the 7-day ceiling. Suppression changes ARE detectable via
 * contact_suppression.updated_at.
 *
 * ── Threshold labelling ──────────────────────────────────────────────────────
 *
 * All numeric thresholds carry INITIAL_HYPOTHESIS_NOT_VALIDATED — not validated
 * against campaign outcome data.
 */

import type {
  FunctionBucket,
  SeniorityLevel,
  TitleClassificationConfidence,
  TitleClassification,
  TargetingPersona,
  PersonRelevanceReason,
  SignalPersonaAlignment,
  PersonRelevanceFactorScores,
  PersonRelevanceEvidence,
  ContactIntelligenceRow,
  ContactCampaignRelevanceRow,
} from "../domain/contact-intelligence-types";
import type { WhyNowSignalSummary } from "../domain/signal-types";
import type { SignalIntelligenceInput } from "../domain/signal-types";

// ── Constants (all INITIAL_HYPOTHESIS_NOT_VALIDATED) ──────────────────────────

/**
 * Increment when classifyTitle() keywords, factor weights, adjacency rules, or
 * PERSON_RELEVANCE_MIN_SCORE change. Any stored row with a different version is
 * stale regardless of timestamps and will be re-assessed on next run.
 */
export const SCORING_VERSION = "1.0.0";

/** Minimum relevanceScore for isPersonRelevant=true. INITIAL_HYPOTHESIS_NOT_VALIDATED. */
export const PERSON_RELEVANCE_MIN_SCORE = 30; // INITIAL_HYPOTHESIS_NOT_VALIDATED

/** Minimum relevanceScore before an AI narrative is generated. INITIAL_HYPOTHESIS_NOT_VALIDATED. */
export const AI_RELEVANCE_MIN_SCORE = 40; // INITIAL_HYPOTHESIS_NOT_VALIDATED

/**
 * Maximum days before a contact_intelligence or contact_campaign_relevance row
 * is considered stale regardless of other triggers.
 * 7 days is the safety net for changes not detected by event triggers
 * (e.g., contact title changes — contacts table has no updated_at).
 * INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */
export const RELEVANCE_STALENESS_CEILING_DAYS = 7; // INITIAL_HYPOTHESIS_NOT_VALIDATED

/** Factor weights for relevance score. All INITIAL_HYPOTHESIS_NOT_VALIDATED. */
export const FACTOR_WEIGHTS = {
  functionMatch:  0.55,
  seniorityMatch: 0.45,
} as const;

/** Maximum signal alignment bonus points. INITIAL_HYPOTHESIS_NOT_VALIDATED. */
export const MAX_SIGNAL_BONUS = 20; // INITIAL_HYPOTHESIS_NOT_VALIDATED

// ── Seniority ordering (for comparison) ───────────────────────────────────────

/** Numeric rank for seniority comparison. Higher = more senior. */
export const SENIORITY_ORDER: Record<SeniorityLevel, number> = {
  C_SUITE:  5,
  VP:       4,
  DIRECTOR: 3,
  MANAGER:  2,
  IC:       1,
  UNKNOWN:  0,
};

// ── Function adjacency ────────────────────────────────────────────────────────

/**
 * Adjacent (related) functions for a given target function.
 * Used in hard disqualifier: contact is NOT disqualified if their function is
 * adjacent to (but not identical to) a target function.
 * Also used in scoring: adjacent match scores 60, direct match scores 100.
 */
export const FUNCTION_ADJACENCY: Record<FunctionBucket, FunctionBucket[]> = {
  SALES:       ["MARKETING", "EXECUTIVE", "OPERATIONS"],
  MARKETING:   ["SALES", "EXECUTIVE", "PRODUCT"],
  ENGINEERING: ["PRODUCT", "EXECUTIVE"],
  FINANCE:     ["EXECUTIVE", "OPERATIONS"],
  OPERATIONS:  ["EXECUTIVE", "FINANCE", "SALES"],
  HR:          ["EXECUTIVE", "OPERATIONS"],
  EXECUTIVE:   ["SALES", "MARKETING", "ENGINEERING", "FINANCE", "OPERATIONS", "HR", "PRODUCT", "LEGAL"],
  PRODUCT:     ["ENGINEERING", "MARKETING", "EXECUTIVE"],
  LEGAL:       ["EXECUTIVE", "FINANCE"],
  OTHER:       [],
};

// ── Signal → persona alignment lookup ─────────────────────────────────────────

/**
 * Maps signal types to the persona functions most likely to care about them.
 * Static lookup — not AI, not DB. Used in computeSignalAlignmentBonus().
 * All entries are INITIAL_HYPOTHESIS_NOT_VALIDATED mappings.
 */
export const SIGNAL_FUNCTION_MAP: Record<string, FunctionBucket[]> = {
  funding_round:        ["EXECUTIVE", "SALES", "FINANCE"],
  executive_hire:       ["EXECUTIVE"],
  job_posting:          ["ENGINEERING", "OPERATIONS", "HR"],
  expansion:            ["SALES", "MARKETING", "OPERATIONS", "EXECUTIVE"],
  partnership:          ["SALES", "EXECUTIVE", "MARKETING"],
  product_launch:       ["PRODUCT", "MARKETING", "ENGINEERING", "EXECUTIVE"],
  news_mention:         ["EXECUTIVE", "MARKETING"],
  technology_change:    ["ENGINEERING", "PRODUCT"],
  competitor_mention:   ["SALES", "MARKETING", "EXECUTIVE"],
  award:                ["EXECUTIVE", "MARKETING"],
  website_change:       ["MARKETING", "ENGINEERING", "PRODUCT"],
  // test signal — used in integration tests only
  test:                 ["EXECUTIVE"],
};

// ── Confidence discount ───────────────────────────────────────────────────────

const CONFIDENCE_DISCOUNT: Record<TitleClassificationConfidence, number> = {
  high:   1.0,
  medium: 0.85,
  low:    0.70,
};

// ── C-suite pattern table ─────────────────────────────────────────────────────

interface CSuitePattern { pattern: RegExp; function: FunctionBucket }

/**
 * C-suite patterns matched before general seniority/function patterns.
 * Order matters — more specific entries first.
 */
const C_SUITE_PATTERNS: CSuitePattern[] = [
  { pattern: /\bceo\b|chief executive officer|founders?\b|co[-\s]?founders?\b|owner\b(?!\s+of\s+record)|(?<!vice[ -])president\b|managing director\b|\bgm\b(?=\s|$)|general manager\b/i, function: "EXECUTIVE" },
  { pattern: /\bcfo\b|chief financial officer/i,                   function: "FINANCE" },
  { pattern: /\bcto\b|chief technology officer|chief technical officer/i, function: "ENGINEERING" },
  { pattern: /\bcro\b|chief revenue officer|chief commercial officer/i,   function: "SALES" },
  { pattern: /\bcmo\b|chief marketing officer/i,                   function: "MARKETING" },
  { pattern: /\bcoo\b|chief operating officer/i,                   function: "OPERATIONS" },
  { pattern: /\bcpo\b|chief product officer/i,                     function: "PRODUCT" },
  { pattern: /\bchro\b|chief human resources|chief people officer/i, function: "HR" },
  { pattern: /\bciso\b|chief information security|chief security officer/i, function: "ENGINEERING" },
  { pattern: /\bcdo\b|chief data officer/i,                        function: "ENGINEERING" },
  { pattern: /\bcso\b|chief strategy officer/i,                    function: "EXECUTIVE" },
];

// ── Function pattern table ────────────────────────────────────────────────────

interface FunctionPattern { pattern: RegExp; function: FunctionBucket }

/** Ordered: more specific patterns first to avoid false matches. */
const FUNCTION_PATTERNS: FunctionPattern[] = [
  { pattern: /revenue operations|revops\b/i,                                    function: "OPERATIONS" },
  { pattern: /\bsales\b|account executive|account manager|\bae\b(?=\s|$)|business development|\bbdr\b|\bsdr\b|account executive|quota|business\s+dev/i, function: "SALES" },
  { pattern: /marketing\b|demand generation|brand\b|content\s+market|\bseo\b|social media|\bcommunications\b|advertising\b|growth\s+market/i, function: "MARKETING" },
  { pattern: /growth\b(?!.*\boperations\b)/i,                                    function: "MARKETING" },
  { pattern: /software\s+engineer|web\s+developer|backend\b|frontend\b|full[\s-]?stack|devops\b|site\s+reliability|platform\s+engineer|machine\s+learning|data\s+engineer|\bml\s+engineer/i, function: "ENGINEERING" },
  { pattern: /\bengineer\b|\bdeveloper\b|engineering\b|technical\b/i,             function: "ENGINEERING" },
  { pattern: /\bfinance\b|\bfinancial\b|\baccounting\b|\btreasurer\b|\bcontroller\b/i, function: "FINANCE" },
  { pattern: /\boperations\b|\bops\b|logistics\b|supply chain|program manager|project manager/i, function: "OPERATIONS" },
  { pattern: /human resources|\bhr\b(?=\s|$)|people\s+operations|talent\s+acquisition|\brecruiting\b|\brecruiter\b/i, function: "HR" },
  { pattern: /people\b(?=\s+(partner|lead|director|manager|ops|team))/i,         function: "HR" },
  { pattern: /\bproduct\b|product\s+manager|\bux\b(?=\s|$)|user\s+experience|user\s+research/i, function: "PRODUCT" },
  { pattern: /\blegal\b|\bcounsel\b|\battorney\b|\blawyer\b|\bcompliance\b|\bregulatory\b/i, function: "LEGAL" },
];

// ── Seniority pattern table ───────────────────────────────────────────────────

interface SeniorityPattern { pattern: RegExp; level: SeniorityLevel }

const SENIORITY_PATTERNS: SeniorityPattern[] = [
  { pattern: /\bvp\b|v\.p\.|vice president/i,          level: "VP" },
  { pattern: /\bdirector\b/i,                           level: "DIRECTOR" },
  { pattern: /\bhead of\b|\bhead,\s/i,                  level: "DIRECTOR" },
  { pattern: /\bmanager\b|\bmanagement\b/i,             level: "MANAGER" },
  { pattern: /\blead\b(?!\s+generation)/i,              level: "MANAGER" },
  { pattern: /\bsenior\b|\bsr\.\s|principal\b/i,        level: "IC" },
  { pattern: /\bspecialist\b|\banalyst\b|\bassociate\b|\bcoordinator\b|\bconsultant\b|\brepresentative\b|\bexecutive\b(?!\s+officer)/i, level: "IC" },
];

// ── classifyTitle ─────────────────────────────────────────────────────────────

/**
 * Classify a free-text job title into function bucket and seniority level.
 *
 * Pure — no I/O. Keyword-based — no AI. Deterministic.
 *
 * Algorithm:
 *   1. Check C-suite patterns (most specific — yield function + C_SUITE seniority)
 *   2. Check seniority patterns
 *   3. Check function patterns
 *   4. Set confidence based on match clarity
 *
 * rawTitle is intentionally absent from the return type (PII minimisation).
 * The caller holds the raw title and passes it to AI prompts if needed, but
 * the classification result is stored without it.
 *
 * @param jobTitle  The raw contacts.job_title string, or null.
 */
export function classifyTitle(jobTitle: string | null): TitleClassification {
  if (!jobTitle || jobTitle.trim() === "") {
    return { function: "OTHER", seniority: "UNKNOWN", confidence: "low" };
  }

  const title = jobTitle.trim();

  // 1. C-suite patterns (most specific — short-circuit on first match)
  for (const { pattern, function: fn } of C_SUITE_PATTERNS) {
    if (pattern.test(title)) {
      return { function: fn, seniority: "C_SUITE", confidence: "high" };
    }
  }

  // 2. Seniority patterns
  let seniority: SeniorityLevel = "UNKNOWN";
  for (const { pattern, level } of SENIORITY_PATTERNS) {
    if (pattern.test(title)) {
      seniority = level;
      break;
    }
  }

  // 3. Function patterns
  let fn: FunctionBucket = "OTHER";
  let functionMatched = false;
  for (const { pattern, function: bucket } of FUNCTION_PATTERNS) {
    if (pattern.test(title)) {
      fn = bucket;
      functionMatched = true;
      break;
    }
  }

  // 4. Confidence
  let confidence: TitleClassificationConfidence;
  if (functionMatched && seniority !== "UNKNOWN") {
    confidence = "high";
  } else if (functionMatched || seniority !== "UNKNOWN") {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return { function: fn, seniority, confidence };
}

// ── parseTargetingPersona ─────────────────────────────────────────────────────

/**
 * Parse campaign_strategies.targeting_level into structured targeting criteria.
 *
 * Pure — no I/O. Keyword-based — no AI. Deterministic.
 *
 * When targeting_level is null/empty, returns safe defaults with
 * hasExplicitFunction=false and hasExplicitSeniority=false — no disqualifier fires.
 *
 * @param targetingLevel  campaign_strategies.targeting_level free-text string.
 */
export function parseTargetingPersona(targetingLevel: string | null): TargetingPersona {
  if (!targetingLevel || targetingLevel.trim() === "") {
    return {
      targetFunctions:      [],
      minimumSeniority:     "UNKNOWN",
      hasExplicitFunction:  false,
      hasExplicitSeniority: false,
    };
  }

  const text = targetingLevel.trim();

  // Detect target functions using same patterns as classifyTitle
  const targetFunctions: FunctionBucket[] = [];

  // Check C-suite patterns for function inference
  for (const { pattern, function: fn } of C_SUITE_PATTERNS) {
    if (pattern.test(text) && !targetFunctions.includes(fn)) {
      targetFunctions.push(fn);
    }
  }
  // Generic "executive" / "founder" / "c-suite" → EXECUTIVE
  if (/\bexecutive\b|\bc[\s-]?suite\b|founders?/i.test(text) && !targetFunctions.includes("EXECUTIVE")) {
    targetFunctions.push("EXECUTIVE");
  }
  // Function patterns
  for (const { pattern, function: bucket } of FUNCTION_PATTERNS) {
    if (pattern.test(text) && !targetFunctions.includes(bucket)) {
      targetFunctions.push(bucket);
    }
  }

  // Detect minimum seniority
  let minimumSeniority: SeniorityLevel = "UNKNOWN";
  let hasExplicitSeniority = false;

  if (/\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|\bcmo\b|\bcro\b|chief\b|founders?\b|co[\s-]?founders?\b|\bc[\s-]?suite\b/i.test(text)) {
    minimumSeniority = "C_SUITE"; hasExplicitSeniority = true;
  } else if (/\bvp\b|v\.p\.|vice president/i.test(text)) {
    minimumSeniority = "VP"; hasExplicitSeniority = true;
  } else if (/\bdirector\b|\bhead of\b/i.test(text)) {
    minimumSeniority = "DIRECTOR"; hasExplicitSeniority = true;
  } else if (/\bmanager\b|\bsenior\b/i.test(text)) {
    minimumSeniority = "MANAGER"; hasExplicitSeniority = true;
  }

  return {
    targetFunctions:      [...new Set(targetFunctions)],
    minimumSeniority,
    hasExplicitFunction:  targetFunctions.length > 0,
    hasExplicitSeniority,
  };
}

// ── Hard disqualifiers ────────────────────────────────────────────────────────

/**
 * Evaluate hard disqualifiers against a classified contact and targeting persona.
 *
 * Returns the disqualifier reason if one fires, or null if scoring should proceed.
 *
 * Hard disqualifiers (evaluated before scoring):
 *   WRONG_FUNCTION:   explicit target functions AND contact has no direct OR adjacent match
 *   WRONG_SENIORITY:  explicit minimum seniority AND contact seniority is KNOWN AND below minimum
 *
 * UNKNOWN seniority does NOT trigger WRONG_SENIORITY — it receives a low
 * seniorityMatch score (30) in the scoring step instead.
 *
 * NO_TITLE is evaluated by the caller before classifyTitle() is called.
 */
export function evaluateHardDisqualifiers(
  classification: TitleClassification,
  targetingPersona: TargetingPersona,
): PersonRelevanceReason | null {
  const { function: fn, seniority } = classification;
  const { targetFunctions, minimumSeniority, hasExplicitFunction, hasExplicitSeniority } = targetingPersona;

  // Function disqualifier
  if (hasExplicitFunction && targetFunctions.length > 0) {
    const directMatch = targetFunctions.includes(fn);
    const adjacentMatch = targetFunctions.some(
      (tf) => (FUNCTION_ADJACENCY[tf] ?? []).includes(fn),
    );
    if (!directMatch && !adjacentMatch) {
      return "WRONG_FUNCTION";
    }
  }

  // Seniority disqualifier — UNKNOWN seniority is NOT disqualified (gets low score instead)
  if (hasExplicitSeniority && minimumSeniority !== "UNKNOWN" && seniority !== "UNKNOWN") {
    if (SENIORITY_ORDER[seniority] < SENIORITY_ORDER[minimumSeniority]) {
      return "WRONG_SENIORITY";
    }
  }

  return null;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Compute how well the contact's function aligns with the target functions.
 *
 * Returns 0–100 (before confidence discount):
 *   100 — exact function match
 *    60 — adjacent function match
 *    50 — no explicit targeting (neutral, not penalised)
 *     0 — no match (hard disqualifier should have fired; defensive fallback)
 *
 * Confidence discount is applied: high=1.0, medium=0.85, low=0.70.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED weights.
 */
export function computeFunctionMatchScore(
  contactFunction: FunctionBucket,
  targetFunctions: FunctionBucket[],
  hasExplicitFunction: boolean,
  confidence: TitleClassificationConfidence,
): number {
  let rawScore: number;

  if (!hasExplicitFunction || targetFunctions.length === 0) {
    rawScore = 50; // neutral — no targeting specified
  } else if (targetFunctions.includes(contactFunction)) {
    rawScore = 100;
  } else {
    const isAdjacent = targetFunctions.some(
      (tf) => (FUNCTION_ADJACENCY[tf] ?? []).includes(contactFunction),
    );
    rawScore = isAdjacent ? 60 : 0;
  }

  return Math.round(rawScore * CONFIDENCE_DISCOUNT[confidence]);
}

/**
 * Compute how well the contact's seniority meets the minimum requirement.
 *
 * Returns 0–100:
 *   100 — above minimum
 *    85 — exactly at minimum
 *    50 — no explicit minimum (neutral)
 *    30 — UNKNOWN seniority (not disqualified but uncertain)
 *
 * INITIAL_HYPOTHESIS_NOT_VALIDATED values.
 */
export function computeSeniorityMatchScore(
  contactSeniority: SeniorityLevel,
  minimumSeniority: SeniorityLevel,
  hasExplicitSeniority: boolean,
): number {
  if (!hasExplicitSeniority || minimumSeniority === "UNKNOWN") return 50;
  if (contactSeniority === "UNKNOWN") return 30;

  const contactRank  = SENIORITY_ORDER[contactSeniority];
  const minimumRank  = SENIORITY_ORDER[minimumSeniority];

  if (contactRank > minimumRank) return 100;
  if (contactRank === minimumRank) return 85;
  return 0; // below minimum — hard disqualifier should have fired
}

/**
 * Compute signal-persona alignment bonus.
 *
 * For each unique signal type in topSignals, look up preferred functions in
 * SIGNAL_FUNCTION_MAP. If the contact's function appears, award +10 points per
 * matching unique signal type, capped at MAX_SIGNAL_BONUS.
 *
 * Counts distinct signal types, not individual signals.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */
export function computeSignalAlignmentBonus(
  topSignals: WhyNowSignalSummary[],
  contactFunction: FunctionBucket,
): number {
  const matchedTypes = new Set<string>();
  for (const signal of topSignals) {
    const preferred = SIGNAL_FUNCTION_MAP[signal.signalType] ?? [];
    if (preferred.includes(contactFunction)) {
      matchedTypes.add(signal.signalType);
    }
  }
  return Math.min(matchedTypes.size * 10, MAX_SIGNAL_BONUS);
}

/**
 * Compute the final relevance score from factor components.
 *
 * Formula: clamp(functionMatch * 0.55 + seniorityMatch * 0.45 + signalBonus, 0, 100)
 * All weights are INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */
export function computeRelevanceScore(
  functionScore:  number,
  seniorityScore: number,
  signalBonus:    number,
): number {
  const base = functionScore * FACTOR_WEIGHTS.functionMatch +
               seniorityScore * FACTOR_WEIGHTS.seniorityMatch;
  return Math.min(Math.max(Math.round(base + signalBonus), 0), 100);
}

/**
 * Evaluate the person relevance gate.
 *
 * Returns true when relevanceScore >= PERSON_RELEVANCE_MIN_SCORE.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED threshold.
 */
export function evaluatePersonRelevantGate(relevanceScore: number): boolean {
  return relevanceScore >= PERSON_RELEVANCE_MIN_SCORE;
}

// ── Signal alignments builder ─────────────────────────────────────────────────

/**
 * Build a SignalPersonaAlignment summary for each unique signal type in topSignals.
 * Used in PersonRelevanceEvidence for observability (which signals matched).
 */
export function buildSignalAlignments(
  topSignals: WhyNowSignalSummary[],
  contactFunction: FunctionBucket,
): SignalPersonaAlignment[] {
  const seen = new Set<string>();
  const alignments: SignalPersonaAlignment[] = [];
  for (const signal of topSignals) {
    if (seen.has(signal.signalType)) continue;
    seen.add(signal.signalType);
    const suggestedFunctions = SIGNAL_FUNCTION_MAP[signal.signalType] ?? [];
    alignments.push({
      signalType:         signal.signalType,
      suggestedFunctions,
      alignmentScore:     suggestedFunctions.includes(contactFunction) ? 1 : 0,
    });
  }
  return alignments;
}

// ── AI input builder ──────────────────────────────────────────────────────────

/**
 * Build a SignalIntelligenceInput that frames person relevance for the existing
 * analyzeSignals() AI infrastructure.
 *
 * Reuses the signal intelligence execution path (ModelRouter + executeSignalIntelligence).
 * The AI's result.whyNow becomes the person relevance sentence (whyThisPerson).
 *
 * Evidence hierarchy enforced in the prompt:
 *   PRIMARY:   function, seniority, signals, campaign targeting, value proposition
 *   SECONDARY: Stage 22 Why Now narrative (labeled — not ground truth)
 *
 * rawJobTitle is passed for natural-language rendering but is treated as PII:
 *   - Not stored in any JSONB output
 *   - Not logged
 *   - Not included in any other output field
 *
 * @param rawJobTitle       From contacts.job_title (PII — used in prompt only)
 * @param whyNowNarrative   Stage 22 AI narrative or null
 */
export function buildPersonRelevanceAiInput(
  classification:   TitleClassification,
  targetingPersona: TargetingPersona,
  topSignals:       WhyNowSignalSummary[],
  campaign: {
    campaign_name:      string;
    targeting_level:    string | null;
    value_proposition:  string | null;
  },
  rawJobTitle:      string | null,
  whyNowNarrative:  string | null,
  assessedAt:       string,
): SignalIntelligenceInput {
  const { function: fn, seniority } = classification;

  const evidenceLines = [
    `Contact function: ${fn} (classification confidence: ${classification.confidence})`,
    `Contact seniority: ${seniority}`,
    rawJobTitle ? `Contact title (raw): ${rawJobTitle}` : null,
    `Campaign: ${campaign.campaign_name}`,
    `Campaign targets: ${campaign.targeting_level ?? "not specified"}`,
    `Campaign offer: ${campaign.value_proposition ?? "not specified"}`,
  ].filter(Boolean).join("\n");

  const secondaryCtx = whyNowNarrative
    ? `\n\nSECONDARY CONTEXT (prior AI-generated summary — supplemental only, NOT source data):\n"${whyNowNarrative}"\nNote: This is a previous AI analysis. Do not treat it as ground truth. Reason from the signals and contact details in the EVIDENCE section above.`
    : "";

  const icpDescription =
    `Your task: Write ONE sentence explaining why a ${seniority}-level ${fn} is the right person ` +
    `to contact for this campaign, given the account signals listed. ` +
    `Base your reasoning ONLY on the contact function, seniority, the signals, and the campaign targeting. ` +
    `Do not reference the secondary context directly. ` +
    `Do not invent company facts, biographical details about the contact, or signals not listed.`;

  return {
    company: {
      name:        `Person relevance: ${fn} (${seniority})`,
      description: evidenceLines + secondaryCtx,
      source:      "person-relevance",
      fetchedAt:   assessedAt,
    },
    icp: {
      description: icpDescription,
    },
    signals: topSignals,
  };
}

// ── Staleness predicates ──────────────────────────────────────────────────────

/**
 * Returns true when a contact_intelligence row should be re-assessed.
 *
 * Triggers:
 *   - No prior assessment (contactReadinessAssessedAt is null)
 *   - Absolute ceiling exceeded (RELEVANCE_STALENESS_CEILING_DAYS)
 *   - Suppression record added or modified after last assessment
 *
 * Note: contacts table has no updated_at column. Title/email changes cannot
 * be detected precisely — the absolute ceiling is the safety net for those.
 */
export function isContactIntelligenceStale(
  stored: ContactIntelligenceRow,
  lastSuppressionChange: string | null,
  now: Date,
): boolean {
  const assessedAt = stored.contactReadinessAssessedAt;
  if (!assessedAt) return true;

  const ceilingMs = RELEVANCE_STALENESS_CEILING_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() - new Date(assessedAt).getTime() > ceilingMs) return true;

  if (lastSuppressionChange && lastSuppressionChange > assessedAt) return true;

  return false;
}

/**
 * Returns true when a contact_campaign_relevance row should be re-assessed.
 *
 * Triggers:
 *   - No prior assessment (relevanceAssessedAt is null)
 *   - Absolute ceiling exceeded
 *   - SCORING_VERSION mismatch (rules or weights changed)
 *   - Campaign strategy ID differs (different campaign)
 *   - Campaign was updated after last assessment (targeting changed)
 *   - Account intelligence refreshed (signals may have changed)
 *   - Contact gate snapshot refreshed (email/suppression may have changed)
 */
export function isCampaignRelevanceStale(
  stored:                        ContactCampaignRelevanceRow,
  currentCampaignStrategyId:     string,
  campaignUpdatedAt:             string,
  accountReadinessAssessedAt:    string | null,
  contactIntelligenceAssessedAt: string | null,
  now:                           Date,
): boolean {
  const assessedAt = stored.relevanceAssessedAt;
  if (!assessedAt) return true;

  const ceilingMs = RELEVANCE_STALENESS_CEILING_DAYS * 24 * 60 * 60 * 1000;
  if (now.getTime() - new Date(assessedAt).getTime() > ceilingMs) return true;

  if (stored.scoringVersion !== SCORING_VERSION) return true;
  if (stored.campaignStrategyId !== currentCampaignStrategyId) return true;
  if (campaignUpdatedAt > assessedAt) return true;
  if (accountReadinessAssessedAt && accountReadinessAssessedAt > assessedAt) return true;
  if (contactIntelligenceAssessedAt && contactIntelligenceAssessedAt > assessedAt) return true;

  return false;
}

// ── Evidence builder (pure) ───────────────────────────────────────────────────

/**
 * Build a PersonRelevanceEvidence object from deterministic scoring components.
 * Pure — no I/O.
 */
export function buildRelevanceEvidence(
  classification:   TitleClassification,
  targetingPersona: TargetingPersona,
  topSignals:       WhyNowSignalSummary[],
  factorScores:     PersonRelevanceFactorScores,
  relevanceScore:   number,
  assessedAt:       string,
): PersonRelevanceEvidence {
  return {
    titleClassification: classification,
    targetingPersona,
    signalAlignments:    buildSignalAlignments(topSignals, classification.function),
    factorScores,
    relevanceScore,
    assessedAt,
    scoringVersion:      SCORING_VERSION,
    hypothesis:          "INITIAL_HYPOTHESIS_NOT_VALIDATED",
  };
}
