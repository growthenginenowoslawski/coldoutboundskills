/**
 * Domain types for Stage 29 — Account Qualification.
 *
 * Qualification is campaign-aware and deterministic.
 * Score and qualification are distinct: a qualified account may still have
 * a low score (sparse evidence). A non-qualified account has score=0.
 *
 * All scoring thresholds: INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */

import type { SignalType, SignalStatus } from "./signal-types";

// ── Dimension verdicts ────────────────────────────────────────────────────────

/** Result of evaluating a single qualification dimension. */
export type DimensionVerdict = "PASS" | "FAIL" | "UNKNOWN";

/** Whether active hiring evidence is visible at this account. */
export type HiringEvidenceVerdict = "PRESENT" | "ABSENT" | "UNKNOWN";

// ── Input types ───────────────────────────────────────────────────────────────

/**
 * Minimal company view consumed by the qualification engine.
 * Only the fields that affect deterministic qualification logic.
 */
export interface QualificationCompany {
  id: string;
  name: string;
  domain: string | null;
  /** companies.industry — structured field from the data source. */
  industry: string | null;
  /** companies.country — structured field. Never parsed from free text. */
  country: string | null;
  city: string | null;
  /** companies.company_size — stored as a range string, e.g. "51-200". */
  companySize: string | null;
  description: string | null;
}

/**
 * ICP answers from icp_onboarding, keyed by question_key.
 * All optional — missing answers produce UNKNOWN for that dimension.
 */
export interface QualificationIcp {
  /** icp_onboarding.answer where question_key = 'geography' */
  geographyAnswer: string | null;
  /** icp_onboarding.answer where question_key = 'industries_in_out' */
  industriesAnswer: string | null;
  /** icp_onboarding.answer where question_key = 'disqualifiers' */
  disqualifiersAnswer: string | null;
  /** icp_onboarding.answer where question_key = 'headcount_range' */
  headcountAnswer: string | null;
  /** icp_onboarding.answer where question_key = 'triggers' */
  triggersAnswer: string | null;
}

/**
 * Campaign-level targeting context, sourced from campaign_strategies.
 * Preserved for provenance — stored inside AccountQualificationResult.
 */
export interface QualificationCampaignContext {
  /** campaign_strategies.id */
  campaignStrategyId: string;
  /**
   * campaign_strategies.list_filters — free-text targeting rules.
   * May supplement the ICP answers with campaign-specific geography or industry constraints.
   */
  listFilters: string | null;
}

/**
 * A signal visible to the qualification engine.
 * Minimal subset of SignalRow — only the fields needed for evidence checks.
 */
export interface QualificationSignal {
  signalType: SignalType;
  /** Short title — checked for hiring keywords. */
  title: string;
  description: string | null;
  /** Provider evidence JSONB — checked for technology hiring keywords. */
  evidence: Record<string, unknown>;
  occurredAt: string;
  status: SignalStatus;
}

/** Input to computeAccountQualification(). */
export interface AccountQualificationInput {
  /** Multi-tenant scope. Never crosses client boundaries. */
  clientId: string;
  company: QualificationCompany;
  icp: QualificationIcp;
  campaign: QualificationCampaignContext;
  /** Active signals for this (clientId, company.id) pair. Empty when not yet ingested. */
  signals: QualificationSignal[];
  /**
   * From account_intelligence.opportunity_score.
   * Used as supporting evidence only — does NOT determine qualification.
   * Null when account intelligence has not yet been computed.
   */
  opportunityScore: number | null;
}

// ── Result type ───────────────────────────────────────────────────────────────

/**
 * Result of computeAccountQualification().
 *
 * Answers: "Why does this company belong in this campaign?" or "Why was it excluded?"
 *
 * hypothesis: INITIAL_HYPOTHESIS_NOT_VALIDATED — scoring weights and the
 * qualification threshold are starting hypotheses, not validated against
 * campaign outcome data. Do not remove this label.
 */
export interface AccountQualificationResult {
  /** Safety label — always "INITIAL_HYPOTHESIS_NOT_VALIDATED". Never remove. */
  readonly hypothesis: "INITIAL_HYPOTHESIS_NOT_VALIDATED";

  /**
   * True when no hard exclusion applies, geography is not FAIL, and
   * qualificationScore meets the minimum threshold.
   *
   * DISTINCT from opportunity_score — qualification is a campaign eligibility
   * gate, not a signal-strength measure. A qualified account may have a low
   * score when evidence is sparse.
   */
  qualified: boolean;

  /**
   * 0-100. Reflects evidence strength when qualified; 0 when hard-excluded.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED — dimension weights are starting hypotheses.
   * Separate from qualified: qualified=true with score=25 is valid (sparse data).
   */
  qualificationScore: number;

  /** Which campaign strategy this result was computed for. Provenance. */
  campaignStrategyId: string;

  // ── Hard exclusions ─────────────────────────────────────────────────────────
  /**
   * If non-empty: this account is hard-excluded. qualified=false, score=0.
   * Each entry is a human-readable reason with specific evidence.
   * AI may NOT override these entries.
   */
  exclusionReasons: string[];

  // ── Dimension verdicts ──────────────────────────────────────────────────────
  geographyVerdict: DimensionVerdict;
  industryVerdict: DimensionVerdict;
  sizeVerdict: DimensionVerdict;
  hiringEvidenceVerdict: HiringEvidenceVerdict;

  // ── Evidence trails ─────────────────────────────────────────────────────────
  /** Observable facts from input data that support qualification. */
  positiveEvidence: string[];
  /** Observable facts from input data that count against qualification. */
  negativeEvidence: string[];
  /** Fields that would strengthen the assessment but are absent in input. */
  missingInfo: string[];
  /** Non-blocking concerns — account is qualified but with caveats. */
  warnings: string[];

  /** ISO — when computeAccountQualification() was called. */
  assessedAt: string;
}
