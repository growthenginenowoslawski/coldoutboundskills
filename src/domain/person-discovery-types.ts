/**
 * Stage 24 domain types — Person Discovery and Email Enrichment.
 *
 * Two distinct waterfall processes (never combined):
 *   PersonDiscoveryWaterfall  — finds the right person by function/seniority
 *   EmailEnrichmentWaterfall  — finds a usable email for a known person
 *
 * Email enrichment only starts after person discovery returns RELEVANT_FOUND.
 *
 * Neither waterfall produces OUTREACH_READY. Enrollment authorization
 * requires a dedicated activation stage that re-checks all eligibility gates.
 */

// ── Persistence error ─────────────────────────────────────────────────────────

/**
 * Populated on the outcome when the waterfall succeeded but the audit record
 * could not be written to the DB.
 *
 * FK_VIOLATION: one or more FK references (client_id, company_id,
 * campaign_strategy_id) do not exist in the DB. Typically indicates a call
 * with a non-existent clientId or test fixture IDs. The in-memory outcome
 * is still correct.
 *
 * PERSISTENCE_FAILED: unexpected DB error during the write (network failure,
 * table unavailable, etc.) — this is propagated as a thrown exception, not
 * stored here; it appears only if the caller catches the throw and inspects
 * the partial outcome.
 */
export interface PersistenceError {
  code: "FK_VIOLATION";
  message: string;
}

import type { FunctionBucket, SeniorityLevel, PersonRelevanceReason } from "./contact-intelligence-types";

// ── Person search query ───────────────────────────────────────────────────────

/**
 * Input to a PersonDiscoveryProvider.
 * Describes the company to search and the persona to find.
 *
 * companyId is an internal UUID — used by fake providers for deterministic
 * routing in tests. Real providers use companyDomain / companyName.
 */
export interface PersonSearchQuery {
  companyDomain?: string;
  companyName?: string;
  companyId?: string;
  targetPersona: {
    functionBuckets: FunctionBucket[];
    minimumSeniority: SeniorityLevel;
  };
  /** Hard cap on candidates returned per provider call. Cost control. */
  limit: number;
}

/**
 * A person candidate returned by a PersonDiscoveryProvider.
 *
 * This is a raw provider payload — it is NOT a contact row.
 * The waterfall matches candidates to contacts via linkedinUrl (primary)
 * or fullName+companyDomain (fallback). Candidates with no DB match are skipped.
 *
 * PII: linkedinUrl and fullName are identifying but necessary for matching.
 * Do not persist these in DB tables — the candidate is transient.
 */
export interface PersonDiscoveryCandidate {
  fullName: string;
  title?: string;
  companyDomain?: string;
  /** Primary key for contact matching. */
  linkedinUrl?: string;
  source: string;
  sourceRecordId?: string;
  discoveredAt: string;
}

// ── Person discovery error codes ──────────────────────────────────────────────

/**
 * Machine-readable error codes for person discovery provider failures.
 *
 * NOT_FOUND         — provider explicitly has no results for this company; try next
 * PROVIDER_ERROR    — 5xx or malformed response; try next provider
 * RATE_LIMITED      — throttled; try next provider (do not wait)
 * AUTH_ERROR        — credentials bad or missing; waterfall-fatal (stop entire run)
 * TEMPORARY_FAILURE — network timeout / DNS failure; try next provider
 */
export type PersonDiscoveryErrorCode =
  | "NOT_FOUND"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "AUTH_ERROR"
  | "TEMPORARY_FAILURE";

// ── Person discovery waterfall result ─────────────────────────────────────────

export type PersonDiscoveryState =
  | "RELEVANT_FOUND"
  | "PERSON_DISCOVERY_EXHAUSTED";

/** One provider attempt within the waterfall (for audit and test assertions). */
export interface PersonDiscoveryAttemptRecord {
  provider: string;
  attemptedAt: string;
  completedAt: string;
  /** Candidates returned by the provider before Stage 23 evaluation. */
  candidatesReturned: number;
  /** Candidates matched to DB contacts and evaluated via Stage 23. */
  candidatesEvaluated: number;
  /** Best candidate from this attempt (if any candidates were evaluated). */
  bestCandidateContactId?: string;
  bestCandidateScore?: number | null;
  bestCandidateRejectionReason?: PersonRelevanceReason | null;
  /** Null on success / empty result. */
  errorCode?: PersonDiscoveryErrorCode;
  errorMessage?: string;
}

/** The contact selected when the waterfall reaches RELEVANT_FOUND. */
export interface PersonDiscoverySelectedCandidate {
  contactId: string;
  linkedinUrl?: string;
  provider: string;
  relevanceScore: number;
  isPersonRelevant: true;
  /**
   * True only when Stage 17 gates also passed (no suppression, has email, etc.).
   * A selected candidate with isPersonQualified=false is the right person type
   * but currently unreachable — email enrichment or suppression resolution may fix this.
   */
  isPersonQualified: boolean;
}

/** Structured fatal error (AUTH_ERROR or ACCOUNT_NOT_READY). */
export interface PersonDiscoveryFatalError {
  code: "AUTH_ERROR" | "ACCOUNT_NOT_READY" | "CAMPAIGN_NOT_FOUND";
  provider?: string;
  message: string;
}

/** Complete result of running the PersonDiscoveryWaterfall. */
export interface PersonDiscoveryOutcome {
  clientId: string;
  companyId: string;
  campaignStrategyId: string;
  state: PersonDiscoveryState;
  selected?: PersonDiscoverySelectedCandidate;
  /** Set when the waterfall stopped due to a fatal non-provider error. */
  fatalError?: PersonDiscoveryFatalError;
  attempts: PersonDiscoveryAttemptRecord[];
  totalProvidersTried: number;
  /**
   * True when a fresh RELEVANT Stage 23 result was found before providers were called.
   * Providers were NOT queried. Re-assessment used existing contact_campaign_relevance rows.
   */
  reusedExistingResult: boolean;
  startedAt: string;
  completedAt: string;
  /**
   * Set when the audit record could NOT be written to person_discovery_runs/attempts.
   * The waterfall outcome is still correct — only the DB audit trail is missing.
   * Callers should surface or log this so the failure is observable.
   */
  persistenceError?: PersistenceError;
}

// ── Email enrichment types ────────────────────────────────────────────────────

/**
 * Input to an EmailEnrichmentProvider.
 * Describes a known person whose email address is needed.
 */
export interface EmailEnrichmentQuery {
  fullName: string;
  companyDomain?: string;
  /** Optional LinkedIn URL for more precise matching. */
  linkedinUrl?: string;
  source: string;
}

/** Email address candidate returned by an EmailEnrichmentProvider. */
export interface EmailEnrichmentCandidate {
  email: string;
  /** 0.0–1.0 provider-reported confidence. */
  confidence?: number;
  source: string;
  foundAt: string;
}

/** Machine-readable error codes for email enrichment failures. */
export type EmailEnrichmentErrorCode =
  | "NOT_FOUND"
  | "PROVIDER_ERROR"
  | "RATE_LIMITED"
  | "AUTH_ERROR"
  | "TEMPORARY_FAILURE";

export type EmailEnrichmentState =
  | "EMAIL_FOUND"
  | "EMAIL_ENRICHMENT_EXHAUSTED";

/** One email provider attempt record. */
export interface EmailEnrichmentAttemptRecord {
  provider: string;
  attemptedAt: string;
  completedAt: string;
  emailFound: boolean;
  errorCode?: EmailEnrichmentErrorCode;
  errorMessage?: string;
}

/** Complete result of running the EmailEnrichmentWaterfall. */
export interface EmailEnrichmentOutcome {
  clientId: string;
  contactId: string;
  campaignStrategyId: string;
  state: EmailEnrichmentState;
  /**
   * The found email address. Present only when state=EMAIL_FOUND.
   * NEVER log this field — it is PII.
   */
  foundEmail?: string;
  foundProvider?: string;
  attempts: EmailEnrichmentAttemptRecord[];
  totalProvidersTried: number;
  startedAt: string;
  completedAt: string;
  /** Set when the audit record could NOT be written to email_enrichment_runs/attempts. */
  persistenceError?: PersistenceError;
}
