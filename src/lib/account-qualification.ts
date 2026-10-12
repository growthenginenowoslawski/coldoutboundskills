/**
 * Stage 29 — Account Qualification.
 *
 * Deterministic, campaign-aware qualification engine.
 * Pure — no AI calls, no DB reads, no side effects. Safe to call from tests.
 *
 * Answers: "Why does this company belong in this campaign?" (or "why is it excluded?")
 *
 * Three outputs:
 *   qualified           — boolean eligibility gate (true/false)
 *   qualificationScore  — 0-100 evidence strength (separate from qualified)
 *   reasons             — human-readable explanation for both verdicts
 *
 * Key invariants:
 *   1. Hard exclusions → qualified=false, score=0, always.
 *   2. Geography FAIL → qualified=false, score=0, always.
 *   3. Missing data → UNKNOWN verdict (never FAIL on missing information).
 *   4. AI may not override exclusionReasons.
 *   5. Score and qualification are distinct: qualified=true with score=25 is valid.
 *
 * All scoring weights: INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */

import type {
  AccountQualificationInput,
  AccountQualificationResult,
  DimensionVerdict,
  HiringEvidenceVerdict,
  QualificationSignal,
} from "../domain/account-qualification-types";

// ── Scoring constants — INITIAL_HYPOTHESIS_NOT_VALIDATED ──────────────────────

const SCORE_GEOGRAPHY_PASS    = 35; // INITIAL_HYPOTHESIS_NOT_VALIDATED
const SCORE_GEOGRAPHY_UNKNOWN = 5;  // INITIAL_HYPOTHESIS_NOT_VALIDATED
const SCORE_INDUSTRY_PASS     = 25; // INITIAL_HYPOTHESIS_NOT_VALIDATED
const SCORE_INDUSTRY_UNKNOWN  = 5;  // INITIAL_HYPOTHESIS_NOT_VALIDATED
const SCORE_HIRING_PRESENT    = 20; // INITIAL_HYPOTHESIS_NOT_VALIDATED
const SCORE_SIZE_PASS         = 10; // INITIAL_HYPOTHESIS_NOT_VALIDATED
const SCORE_SIZE_UNKNOWN      = 2;  // INITIAL_HYPOTHESIS_NOT_VALIDATED
const SCORE_OPPORTUNITY_MAX   = 10; // INITIAL_HYPOTHESIS_NOT_VALIDATED — bonus from opportunity_score
const QUALIFICATION_SCORE_MIN = 20; // INITIAL_HYPOTHESIS_NOT_VALIDATED — below → qualified=false

// ── Country alias map ─────────────────────────────────────────────────────────
// Maps canonical country name → lowercase aliases matched against company.country.
// Extend as the system targets new geographies.

const COUNTRY_ALIASES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["United Kingdom",  new Set(["united kingdom", "uk", "gb", "great britain", "britain", "england", "scotland", "wales", "northern ireland"])],
  ["United States",   new Set(["united states", "usa", "us", "u.s.", "u.s.a.", "america"])],
  ["Germany",         new Set(["germany", "deutschland"])],
  ["France",          new Set(["france"])],
  ["Australia",       new Set(["australia", "au"])],
  ["Canada",          new Set(["canada"])],
  ["Ireland",         new Set(["ireland", "republic of ireland", "eire"])],
  ["Netherlands",     new Set(["netherlands", "holland", "nl"])],
  ["Sweden",          new Set(["sweden", "sverige"])],
  ["Denmark",         new Set(["denmark", "danmark"])],
  ["Norway",          new Set(["norway", "norge"])],
  ["Finland",         new Set(["finland", "suomi"])],
  ["Switzerland",     new Set(["switzerland", "schweiz", "suisse", "svizzera"])],
]);

// ── Technology hiring keywords ────────────────────────────────────────────────
// Checked in job_posting signal titles/descriptions to detect technology hiring demand.
// Used when the ICP context is a recruitment agency targeting employers.
// INITIAL_HYPOTHESIS_NOT_VALIDATED — this keyword list has not been validated.

const TECH_HIRING_KEYWORDS = [
  "software engineer", "software developer", "devops", "platform engineer",
  "infrastructure engineer", "cloud engineer", "security engineer",
  "data engineer", "ml engineer", "machine learning", "ai engineer",
  "site reliability", "sre", "backend engineer", "frontend engineer",
  "full stack", "fullstack", "engineering manager", "head of engineering",
  "vp engineering", "cto", "technical lead", "tech lead",
  "typescript", "python", "java", "golang", "rust", "kotlin", "scala",
  "kubernetes", "aws", "azure", "gcp", "react", "node",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Escape special regex characters in a literal string. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract significant words (>= 5 chars) from a rule phrase for keyword matching.
 * Filters short function words that produce false positives.
 */
function extractRuleKeywords(phrase: string): string[] {
  return phrase.split(/\s+/).filter((w) => w.length >= 5);
}

// ── ICP parsers ───────────────────────────────────────────────────────────────

/**
 * Extract canonical country names targeted by this ICP geography answer.
 * Uses word-boundary matching to prevent short aliases (e.g. "us") from matching
 * inside unrelated words (e.g. "focus"). Returns [] when no known country found.
 */
export function extractTargetCountries(geographyAnswer: string | null): string[] {
  if (!geographyAnswer) return [];
  const lower = geographyAnswer.toLowerCase();
  const found: string[] = [];
  for (const [canonical, aliases] of COUNTRY_ALIASES) {
    for (const alias of aliases) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`);
      if (pattern.test(lower)) {
        found.push(canonical);
        break;
      }
    }
  }
  return found;
}

/**
 * Parse the "IN: ..., OUT: ..." format of the industries_in_out ICP answer.
 * Returns lowercase phrase arrays for include and exclude keyword matching.
 * Parenthetical notes (e.g. "WPP, Publicis etc.") are stripped BEFORE splitting
 * so commas inside parentheses don't produce fragmented tokens.
 */
export function parseIndustryRules(
  industriesAnswer: string | null,
): { include: string[]; exclude: string[] } {
  if (!industriesAnswer) return { include: [], exclude: [] };

  const include: string[] = [];
  const exclude: string[] = [];

  const inMatch = industriesAnswer.match(/\bIN\s*:\s*([\s\S]+?)(?=\bOUT\s*:|$)/i);
  if (inMatch) {
    inMatch[1]
      .replace(/\(.*?\)/g, "")  // strip parens before splitting
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 3)
      .forEach((s) => include.push(s));
  }

  const outMatch = industriesAnswer.match(/\bOUT\s*:\s*([\s\S]+?)(?=\bIN\s*:|$)/i);
  if (outMatch) {
    outMatch[1]
      .replace(/\(.*?\)/g, "")  // strip parens before splitting
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 3)
      .forEach((s) => exclude.push(s));
  }

  return { include, exclude };
}

/**
 * Parse min/max headcount from the headcount_range ICP answer.
 * Matches patterns like "3–200", "3-200", "3 to 200".
 * Returns null when no parseable range is found — not an error.
 */
export function parseHeadcountRange(
  headcountAnswer: string | null,
): { min: number; max: number } | null {
  if (!headcountAnswer) return null;
  const match = headcountAnswer.match(/(\d[\d,]*)\s*[–\-–—to ]+\s*(\d[\d,]*)/);
  if (!match) return null;
  const min = parseInt(match[1].replace(/,/g, ""), 10);
  const max = parseInt(match[2].replace(/,/g, ""), 10);
  if (isNaN(min) || isNaN(max) || min > max) return null;
  return { min, max };
}

/**
 * Parse semicolon-separated disqualifier phrases from the ICP disqualifiers answer.
 * Returns lowercase phrases for fuzzy matching against company fields.
 */
export function parseDisqualifiers(disqualifiersAnswer: string | null): string[] {
  if (!disqualifiersAnswer) return [];
  return disqualifiersAnswer
    .split(/[;]/)
    .map((s) => s.replace(/\(.*?\)/g, "").trim().toLowerCase())
    .filter((s) => s.length >= 5);
}

// ── Dimension checks ──────────────────────────────────────────────────────────

/**
 * Check whether the company is in the target geography.
 *
 * Uses company.country (structured DB field — never parses free text on the company side).
 * Returns UNKNOWN when company.country is null/empty or when no target countries
 * could be extracted from the ICP answer. Never returns FAIL on missing company data.
 */
export function checkGeography(
  companyCountry: string | null,
  targetCountries: string[],
): DimensionVerdict {
  if (!companyCountry || companyCountry.trim() === "") return "UNKNOWN";
  if (targetCountries.length === 0) return "UNKNOWN";

  const normalised = companyCountry.toLowerCase().trim();
  for (const canonical of targetCountries) {
    const aliases = COUNTRY_ALIASES.get(canonical);
    if (!aliases) continue;
    if (aliases.has(normalised)) return "PASS";
    for (const alias of aliases) {
      if (normalised.includes(alias)) return "PASS";
    }
  }
  return "FAIL";
}

/**
 * Check the company's industry against the ICP include/exclude lists.
 *
 * Returns PASS (matched include), FAIL (matched exclude), or UNKNOWN.
 * FAIL from this function triggers a hard exclusion at the caller.
 *
 * Matching: extracts significant keywords (>= 5 chars) from each rule phrase,
 * then checks whether ANY keyword appears in the company's industry string
 * (case-insensitive). This bidirectional approach handles the case where the
 * rule says "Advertising agencies" and the company field says "Advertising & Marketing".
 */
export function checkIndustry(
  companyIndustry: string | null,
  rules: { include: string[]; exclude: string[] },
): DimensionVerdict {
  if (!companyIndustry) return "UNKNOWN";
  const lower = companyIndustry.toLowerCase();

  // Exclude wins first: any significant keyword from the exclude phrase found → FAIL
  for (const excl of rules.exclude) {
    const kws = extractRuleKeywords(excl);
    if (kws.some((kw) => lower.includes(kw))) return "FAIL";
  }

  // Include: any significant keyword from the include phrase found → PASS
  for (const incl of rules.include) {
    const kws = extractRuleKeywords(incl);
    if (kws.some((kw) => lower.includes(kw))) return "PASS";
  }

  return "UNKNOWN";
}

/**
 * Check the company size against the ICP headcount range.
 *
 * Returns PASS when the company's size range overlaps with the ICP range.
 * Returns FAIL when there is no overlap.
 * Returns UNKNOWN when company.companySize is null or unparseable.
 *
 * IMPORTANT: UNKNOWN (not FAIL) is returned for missing size — per spec:
 * "do not discard companies when headcount is unknown."
 */
export function checkCompanySize(
  companySizeStr: string | null,
  icpRange: { min: number; max: number } | null,
): DimensionVerdict {
  if (!companySizeStr) return "UNKNOWN";
  if (!icpRange) return "UNKNOWN";

  const matches = companySizeStr.match(/(\d[\d,]*)/g);
  if (!matches || matches.length === 0) return "UNKNOWN";

  const lower = parseInt(matches[0].replace(/,/g, ""), 10);
  if (isNaN(lower)) return "UNKNOWN";
  const upper = matches.length > 1 ? parseInt(matches[matches.length - 1].replace(/,/g, ""), 10) : lower;

  const hasOverlap = lower <= icpRange.max && upper >= icpRange.min;
  return hasOverlap ? "PASS" : "FAIL";
}

/**
 * Check for active hiring evidence from the signals array.
 *
 * Returns PRESENT when any active job_posting signals exist.
 * Returns UNKNOWN when no signals have been ingested (empty array or all non-active).
 * Does NOT return ABSENT — absence of evidence ≠ evidence of absence.
 * Signals are absent when the signal ingestion pipeline hasn't run for this company.
 */
export function checkHiringEvidence(signals: QualificationSignal[]): HiringEvidenceVerdict {
  const active = signals.filter((s) => s.status === "active");
  if (active.length === 0) return "UNKNOWN";

  const hasJobPosting = active.some((s) => s.signalType === "job_posting");
  return hasJobPosting ? "PRESENT" : "UNKNOWN";
}

/**
 * Extract technology-specific hiring evidence strings from job_posting signals.
 * Returns one evidence string per signal that contains technology-related keywords.
 * Returns [] when no technology keywords are detected.
 */
export function extractTechHiringEvidence(signals: QualificationSignal[]): string[] {
  return signals
    .filter((s) => s.status === "active" && s.signalType === "job_posting")
    .flatMap((sig) => {
      const text = [sig.title, sig.description ?? ""].join(" ").toLowerCase();
      const found = TECH_HIRING_KEYWORDS.filter((kw) => text.includes(kw));
      if (found.length === 0) return [];
      return [`Technology hiring signal: "${sig.title}" (${found.slice(0, 3).join(", ")})`];
    });
}

/**
 * Check company name, industry, and description against parsed disqualifier phrases.
 * Returns an array of exclusion reason strings (empty = no match).
 *
 * Matching is best-effort: long phrases are unlikely to match short company fields,
 * so this check has low recall but high precision (low false-positive rate).
 * Documented as best-effort — the check fires correctly when it does match.
 */
export function checkDisqualifiers(
  company: { name: string; industry: string | null; description: string | null },
  disqualifiers: string[],
): string[] {
  const textToCheck = [
    company.name.toLowerCase(),
    (company.industry ?? "").toLowerCase(),
    (company.description ?? "").toLowerCase(),
  ].join(" ");

  for (const disq of disqualifiers) {
    // Require minimum length to avoid spurious matches on fragments
    if (disq.length >= 8 && textToCheck.includes(disq)) {
      return [`Company matches disqualifier: "${disq}"`];
    }
  }
  return [];
}

// ── Score computation ─────────────────────────────────────────────────────────

/**
 * Compute the qualification score from dimension verdicts and opportunity score.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED — all weights are starting hypotheses.
 *
 * Returns 0 when hard exclusions exist or geography FAIL (hard blocks always zero).
 * Possible range: 0–100.
 */
export function computeQualificationScore(opts: {
  hasExclusions: boolean;
  geographyVerdict: DimensionVerdict;
  industryVerdict: DimensionVerdict;
  sizeVerdict: DimensionVerdict;
  hiringEvidenceVerdict: HiringEvidenceVerdict;
  opportunityScore: number | null;
}): number {
  if (opts.hasExclusions || opts.geographyVerdict === "FAIL") return 0;

  let score = 0;

  if (opts.geographyVerdict === "PASS")         score += SCORE_GEOGRAPHY_PASS;
  else if (opts.geographyVerdict === "UNKNOWN")  score += SCORE_GEOGRAPHY_UNKNOWN;

  if (opts.industryVerdict === "PASS")           score += SCORE_INDUSTRY_PASS;
  else if (opts.industryVerdict === "UNKNOWN")   score += SCORE_INDUSTRY_UNKNOWN;

  if (opts.hiringEvidenceVerdict === "PRESENT")  score += SCORE_HIRING_PRESENT;

  if (opts.sizeVerdict === "PASS")               score += SCORE_SIZE_PASS;
  else if (opts.sizeVerdict === "UNKNOWN")       score += SCORE_SIZE_UNKNOWN;

  if (opts.opportunityScore !== null && opts.opportunityScore > 0) {
    score += Math.round((opts.opportunityScore / 100) * SCORE_OPPORTUNITY_MAX);
  }

  return Math.min(100, score);
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Compute account qualification for a (client, company, campaign) triple.
 *
 * Pure — no DB reads, no AI calls, no side effects.
 *
 * @param input  All data needed for qualification — pre-fetched by the caller.
 * @param now    Override the assessment timestamp. Defaults to new Date().
 */
export function computeAccountQualification(
  input: AccountQualificationInput,
  now: Date = new Date(),
): AccountQualificationResult {
  const assessedAt       = now.toISOString();
  const positiveEvidence: string[] = [];
  const negativeEvidence: string[] = [];
  const missingInfo:      string[] = [];
  const warnings:         string[] = [];
  const exclusionReasons: string[] = [];

  // ── Parse ICP rules ───────────────────────────────────────────────────────
  const targetCountries = extractTargetCountries(input.icp.geographyAnswer);
  const industryRules   = parseIndustryRules(input.icp.industriesAnswer);
  const headcountRange  = parseHeadcountRange(input.icp.headcountAnswer);
  const disqualifiers   = parseDisqualifiers(input.icp.disqualifiersAnswer);

  // ── A. Geography ──────────────────────────────────────────────────────────
  const geographyVerdict = checkGeography(input.company.country, targetCountries);

  if (geographyVerdict === "PASS") {
    positiveEvidence.push(
      `Geography: company is in ${input.company.country ?? "target geography"}`,
    );
  } else if (geographyVerdict === "FAIL") {
    exclusionReasons.push(
      `Geography: company country "${input.company.country}" is not in the target geography` +
      (targetCountries.length > 0 ? ` (${targetCountries.join(", ")})` : ""),
    );
  } else {
    if (!input.company.country) {
      missingInfo.push("Company country is unknown — enrich before outreach");
    } else if (targetCountries.length === 0) {
      warnings.push("ICP geography answer did not yield parseable country names — geography not verified");
    } else {
      warnings.push(
        `Company country "${input.company.country}" could not be matched against target geography — verify`,
      );
    }
  }

  // ── B. Industry — include/exclude list ───────────────────────────────────
  const industryVerdict = checkIndustry(input.company.industry, industryRules);

  if (industryVerdict === "PASS") {
    positiveEvidence.push(
      `Industry: "${input.company.industry}" matches ICP target industries`,
    );
  } else if (industryVerdict === "FAIL") {
    exclusionReasons.push(
      `Industry: "${input.company.industry}" is in the ICP excluded industry list`,
    );
    negativeEvidence.push(
      `Industry "${input.company.industry}" matched the OUT list`,
    );
  } else {
    if (!input.company.industry) {
      missingInfo.push("Company industry is unknown — enrich before outreach");
    } else {
      warnings.push(
        `Company industry "${input.company.industry}" could not be matched against ICP industry list`,
      );
    }
  }

  // ── C. Explicit disqualifiers ─────────────────────────────────────────────
  if (disqualifiers.length > 0) {
    const disqMatches = checkDisqualifiers(
      {
        name:        input.company.name,
        industry:    input.company.industry,
        description: input.company.description,
      },
      disqualifiers,
    );
    if (disqMatches.length > 0) {
      exclusionReasons.push(...disqMatches);
      negativeEvidence.push(...disqMatches);
    }
  }

  // ── D. Company size ───────────────────────────────────────────────────────
  const sizeVerdict = checkCompanySize(input.company.companySize, headcountRange);

  if (sizeVerdict === "PASS") {
    positiveEvidence.push(
      `Company size: "${input.company.companySize}" is within the ICP range` +
      (headcountRange ? ` (${headcountRange.min}–${headcountRange.max} employees)` : ""),
    );
  } else if (sizeVerdict === "FAIL") {
    // Size FAIL is a WARNING, not a hard exclusion — ICP answers say not to discard on size
    warnings.push(
      `Company size "${input.company.companySize}" may be outside the ICP range` +
      (headcountRange ? ` (${headcountRange.min}–${headcountRange.max} employees)` : "") +
      " — verify before excluding",
    );
    negativeEvidence.push(
      `Company size out of ICP range: "${input.company.companySize}"`,
    );
  } else {
    missingInfo.push(
      headcountRange
        ? `Company size is unknown — ICP targets ${headcountRange.min}–${headcountRange.max} employees`
        : "Company size is unknown",
    );
  }

  // ── E. Hiring evidence (from signals) ────────────────────────────────────
  const hiringEvidenceVerdict = checkHiringEvidence(input.signals);

  if (hiringEvidenceVerdict === "PRESENT") {
    const techEvidence = extractTechHiringEvidence(input.signals);
    if (techEvidence.length > 0) {
      positiveEvidence.push(...techEvidence);
    } else {
      const count = input.signals.filter(
        (s) => s.status === "active" && s.signalType === "job_posting",
      ).length;
      positiveEvidence.push(`Hiring signal: ${count} active job posting signal(s)`);
    }
  } else if (hiringEvidenceVerdict === "UNKNOWN" && input.signals.length === 0) {
    missingInfo.push("No signals ingested for this company — hiring evidence unavailable");
  }

  // ── F. Additional positive signals ────────────────────────────────────────
  const BONUS_SIGNAL_TYPES = ["funding_round", "expansion", "executive_hire"] as const;
  for (const sigType of BONUS_SIGNAL_TYPES) {
    const matching = input.signals.filter(
      (s) => s.status === "active" && s.signalType === sigType,
    );
    if (matching.length > 0) {
      positiveEvidence.push(
        `${sigType.replace(/_/g, " ")}: "${matching[0].title}"`,
      );
    }
  }

  // ── G. Opportunity score context ─────────────────────────────────────────
  if (input.opportunityScore !== null && input.opportunityScore > 0) {
    positiveEvidence.push(
      `Opportunity score: ${input.opportunityScore}/100 (deterministic signal-based score)`,
    );
  } else if (input.opportunityScore === null) {
    missingInfo.push("Opportunity score not yet computed — signal ingestion required");
  }

  // ── H. Qualification score ────────────────────────────────────────────────
  const qualificationScore = computeQualificationScore({
    hasExclusions:         exclusionReasons.length > 0,
    geographyVerdict,
    industryVerdict,
    sizeVerdict,
    hiringEvidenceVerdict,
    opportunityScore:      input.opportunityScore,
  });

  // ── I. Qualified determination ────────────────────────────────────────────
  const hasHardBlock = exclusionReasons.length > 0 || geographyVerdict === "FAIL";
  const qualified = !hasHardBlock && qualificationScore >= QUALIFICATION_SCORE_MIN;

  if (!hasHardBlock && qualificationScore > 0 && qualificationScore < QUALIFICATION_SCORE_MIN) {
    warnings.push(
      `Qualification score ${qualificationScore}/100 is below the minimum threshold ` +
      `(${QUALIFICATION_SCORE_MIN} — INITIAL_HYPOTHESIS_NOT_VALIDATED). ` +
      "Enrich company data to improve confidence.",
    );
  }

  return {
    hypothesis:              "INITIAL_HYPOTHESIS_NOT_VALIDATED",
    qualified,
    qualificationScore,
    campaignStrategyId:      input.campaign.campaignStrategyId,
    exclusionReasons,
    geographyVerdict,
    industryVerdict,
    sizeVerdict,
    hiringEvidenceVerdict,
    positiveEvidence,
    negativeEvidence,
    missingInfo,
    warnings,
    assessedAt,
  };
}
