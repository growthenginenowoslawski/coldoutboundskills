/**
 * Contact Intelligence domain types — Stage 23.
 *
 * Stored in two tables:
 *   contact_intelligence          (campaign-agnostic, per client/company/contact)
 *   contact_campaign_relevance    (campaign-specific, per client/company/contact/campaign)
 *
 * Types live here (not in lib/) so that lib/contact-intelligence.ts and
 * db/contact-intelligence.ts can both import them without circular dependencies.
 *
 * ── Two-table separation ──────────────────────────────────────────────────────
 *
 * campaign-agnostic (ContactIntelligenceRow):
 *   titleClassification, gateSnapshot, isContactReady
 *   — does not vary between campaigns; reused when multi-campaign assessed
 *
 * campaign-specific (ContactCampaignRelevanceRow):
 *   relevanceScore, isPersonRelevant, isPersonQualified, evidence, narrative
 *   — changes when campaign targeting or scoring rules change
 *
 * ── PII handling ──────────────────────────────────────────────────────────────
 *
 * TitleClassification intentionally does NOT store rawTitle. Job title is
 * potentially personal data (attributable to a named individual with email and
 * name on the same contacts row). The raw title stays exclusively in
 * contacts.job_title. Stage 23 stores only the classification result
 * (function bucket, seniority, confidence). The raw title is passed to the AI
 * call at assessment time, then discarded — it is never written to JSONB.
 *
 * ── Snapshot semantics ───────────────────────────────────────────────────────
 *
 * ContactGateSnapshot.isContactReady is a DISCOVERY artifact, not an authorization.
 * A stored isContactReady=true does NOT authorize outreach. Suppression, email
 * validity, and account state can change after the snapshot. The activation stage
 * (Stage 24+) MUST re-run evaluateContactEligibility() live immediately before
 * any enrollment or outreach action.
 *
 * ── State ownership ───────────────────────────────────────────────────────────
 *
 * Stage 23 produces: isPersonRelevant, isContactReady, isPersonQualified.
 * Stage 23 does NOT produce OUTREACH_READY — that requires downstream checks
 * (Why Now currency, personalization, human review, campaign state, rate limits,
 * deliverability) and belongs to a future activation stage.
 *
 * ── Threshold labelling ──────────────────────────────────────────────────────
 *
 * All numeric thresholds are INITIAL_HYPOTHESIS_NOT_VALIDATED — not validated
 * against campaign outcome data. See lib/person-relevance.ts for constants.
 */

// ── Function and seniority buckets ────────────────────────────────────────────

export type FunctionBucket =
  | "SALES"
  | "MARKETING"
  | "ENGINEERING"
  | "FINANCE"
  | "OPERATIONS"
  | "HR"
  | "EXECUTIVE"
  | "PRODUCT"
  | "LEGAL"
  | "OTHER";

export type SeniorityLevel =
  | "C_SUITE"
  | "VP"
  | "DIRECTOR"
  | "MANAGER"
  | "IC"
  | "UNKNOWN";

export type TitleClassificationConfidence = "high" | "medium" | "low";

/**
 * Deterministic job title classification result.
 *
 * rawTitle is intentionally absent (see PII handling note above).
 * The function/seniority/confidence triple is what Stage 23 stores and
 * reasons from — the raw source string is not needed beyond the AI call.
 */
export interface TitleClassification {
  function:   FunctionBucket;
  seniority:  SeniorityLevel;
  confidence: TitleClassificationConfidence;
}

// ── Targeting persona (parsed from campaign_strategies.targeting_level) ────────

/**
 * Persona targeting parsed from campaign_strategies.targeting_level by
 * parseTargetingPersona() — deterministic, no I/O.
 *
 * When hasExplicitFunction=false, targeting_level contained no recognisable
 * function signal — the WRONG_FUNCTION hard disqualifier does NOT fire.
 * Same semantics for hasExplicitSeniority.
 */
export interface TargetingPersona {
  /** Functions explicitly targeted. Empty when hasExplicitFunction=false. */
  targetFunctions:      FunctionBucket[];
  /** Minimum seniority required. UNKNOWN when hasExplicitSeniority=false. */
  minimumSeniority:     SeniorityLevel;
  hasExplicitFunction:  boolean;
  hasExplicitSeniority: boolean;
}

// ── Person relevance ──────────────────────────────────────────────────────────

/**
 * Machine-readable reason for person relevance outcome.
 * SCORE_BELOW_THRESHOLD fires only after hard disqualifiers passed.
 */
export type PersonRelevanceReason =
  | "RELEVANT"
  | "NO_TITLE"
  | "WRONG_FUNCTION"
  | "WRONG_SENIORITY"
  | "SCORE_BELOW_THRESHOLD";

export interface SignalPersonaAlignment {
  signalType:         string;
  suggestedFunctions: FunctionBucket[];
  /** 0 or 1: whether the contact's function appears in suggestedFunctions. */
  alignmentScore:     number;
}

export interface PersonRelevanceFactorScores {
  /** 0–100. INITIAL_HYPOTHESIS_NOT_VALIDATED. */
  functionMatch:  number;
  /** 0–100. INITIAL_HYPOTHESIS_NOT_VALIDATED. */
  seniorityMatch: number;
  /** 0–20 bonus. INITIAL_HYPOTHESIS_NOT_VALIDATED. */
  signalBonus:    number;
}

/**
 * Deterministic evidence for a person relevance assessment.
 * Stored in contact_campaign_relevance.evidence JSONB.
 *
 * scoringVersion is embedded so the invalidation check can detect when
 * SCORING_VERSION was bumped (keyword rules or factor weights changed).
 */
export interface PersonRelevanceEvidence {
  titleClassification: TitleClassification;
  targetingPersona:    TargetingPersona;
  signalAlignments:    SignalPersonaAlignment[];
  factorScores:        PersonRelevanceFactorScores;
  /** 0–100 final weighted score. INITIAL_HYPOTHESIS_NOT_VALIDATED. */
  relevanceScore:      number;
  assessedAt:          string;
  scoringVersion:      string;
  hypothesis:          "INITIAL_HYPOTHESIS_NOT_VALIDATED";
}

/**
 * AI-generated person relevance sentence — Stage 23.
 *
 * Only generated when: isPersonRelevant=true AND
 *   relevanceScore >= AI_RELEVANCE_MIN_SCORE (INITIAL_HYPOTHESIS_NOT_VALIDATED).
 *
 * AI must not invent facts not in the evidence manifest. Stage 22 Why Now
 * narrative may only be secondary context — never treated as source evidence.
 * Raw job title is passed to the AI but is never stored here.
 *
 * Stored in contact_campaign_relevance.narrative JSONB. Null when not generated.
 */
export interface PersonRelevanceNarrative {
  /** One sentence: why this person's function/seniority fits this campaign. */
  whyThisPerson: string;
  /** 0–1 AI self-reported confidence. Does not block storage when low. */
  confidence:    number;
  // Observability (same fields as WhyNowNarrative for consistency)
  model:        string;
  analyzedAt:   string;
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number | null;
  latencyMs:    number;
}

// ── Contact eligibility gate snapshot ─────────────────────────────────────────

/**
 * Snapshot of Stage 17 gate evaluation results at contactReadinessAssessedAt.
 * Stored in contact_intelligence.gate_snapshot JSONB.
 *
 * IMPORTANT: This is a DISCOVERY artifact only. isContactReady=true here does
 * NOT authorize outreach. The activation stage MUST re-run
 * evaluateContactEligibility() live before any enrollment action.
 *
 * accountGate is always snapshotted as true — Stage 23 only processes accounts
 * where account_intelligence.is_ready=true, which implies opportunityScore > 0.
 */
export interface ContactGateSnapshot {
  accountGate:     true;        // invariant: Stage 22 prerequisite confirmed
  contactGate:     boolean;
  emailGate:       boolean;
  suppressionGate: boolean;
  /** Which gate blocked, if any. Null when all gates passed. */
  blockingGate:    string | null;
  /** Human-readable detail from the gate evaluator. Null when eligible. */
  blockingReason:  string | null;
  evaluatedAt:     string;
}

// ── DB row domain types ───────────────────────────────────────────────────────

/**
 * Domain object for a contact_intelligence row.
 *
 * Campaign-agnostic. Stores title classification and contact eligibility gate
 * snapshot. These facts are shared across all campaigns.
 *
 * isContactReady is a DISCOVERY snapshot — not an authorization.
 */
export interface ContactIntelligenceRow {
  id:                         string;
  clientId:                   string;
  companyId:                   string;
  contactId:                   string;
  titleClassification:         TitleClassification | null;
  gateSnapshot:                ContactGateSnapshot | null;
  /** Snapshot of Stage 17 gate result. True = passed. DISCOVERY ONLY. */
  isContactReady:              boolean | null;
  contactReadinessAssessedAt:  string | null;
  createdAt:                   string;
  updatedAt:                   string;
}

/**
 * Domain object for a contact_campaign_relevance row.
 *
 * Campaign-specific. Relevance score and AI narrative depend on the campaign's
 * targeting criteria. The same contact may be RELEVANT for one campaign and
 * NOT RELEVANT for another.
 *
 * scoringVersion is promoted to a column (not buried in evidence JSONB) so
 * the staleness check can compare it to SCORING_VERSION without parsing JSONB.
 *
 * isPersonQualified = isPersonRelevant AND isContactReady (from contact_intelligence).
 * It does NOT imply OUTREACH_READY.
 */
export interface ContactCampaignRelevanceRow {
  id:                  string;
  clientId:            string;
  companyId:            string;
  contactId:            string;
  campaignStrategyId:   string;
  /** 0–100. INITIAL_HYPOTHESIS_NOT_VALIDATED. Null until assessed. */
  relevanceScore:       number | null;
  isPersonRelevant:     boolean | null;
  /** isPersonRelevant AND isContactReady. Does NOT imply OUTREACH_READY. */
  isPersonQualified:    boolean | null;
  relevanceReason:      PersonRelevanceReason | null;
  evidence:             PersonRelevanceEvidence | null;
  narrative:            PersonRelevanceNarrative | null;
  scoringVersion:       string | null;
  relevanceAssessedAt:  string | null;
  createdAt:            string;
  updatedAt:            string;
}
