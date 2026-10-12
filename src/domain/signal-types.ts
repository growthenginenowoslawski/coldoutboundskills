/**
 * Signal Engine domain types.
 *
 * A signal is a normalized, scored, timestamped business event attached to a
 * target account. Raw provider events are converted into these shapes
 * deterministically — no AI calls at the ingestion layer.
 *
 * Downstream: signals feed into the qualification + personalization pipeline.
 * AI reasoning over signals is a future step.
 */

// ── Signal type registry ──────────────────────────────────────────────────────

export const SIGNAL_TYPES = [
  "executive_hire",
  "funding_round",
  "job_posting",
  "news_mention",
  "website_change",
  "product_launch",
  "partnership",
  "technology_change",
  "competitor_mention",
  "award",
  "expansion",
  "test",
] as const;

export type SignalType = (typeof SIGNAL_TYPES)[number];

export const SIGNAL_STATUSES = ["active", "expired", "dismissed"] as const;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

// ── Raw event — what a signal provider emits ─────────────────────────────────

/**
 * The shape a signal provider produces before normalization.
 * Providers normalize INTO this — they never write DB rows directly.
 */
export interface RawSignalEvent {
  /**
   * Provider-assigned stable event ID.
   * Include when the provider has one; omit otherwise.
   * Presence enables tier-1 (strongest) deduplication.
   */
  providerEventId?: string;
  /** Provider name: "linkedin", "crunchbase", "builtwith", "test". */
  source: string;
  signalType: SignalType;
  /** Short human-readable title (shown in dashboards and outreach copy). */
  title: string;
  /** Optional longer description. */
  description?: string;
  /** Provider-specific payload — kept verbatim for audit and downstream AI reasoning. */
  evidence: Record<string, unknown>;
  /** ISO 8601 timestamp of when the underlying business event happened. */
  occurredAt: string;
  /** Optional URL to the original source page. */
  sourceUrl?: string;
  /** Provider-specific extras that don't fit elsewhere. */
  metadata?: Record<string, unknown>;
  /**
   * Provider's own 0-1 confidence score.
   * When absent the engine derives confidence from the dedup tier used.
   */
  confidence?: number;
}

// ── Normalized signal — the engine's canonical shape ──────────────────────────

/**
 * A fully normalized signal ready for DB storage.
 * Every field is deterministic — no AI calls performed during normalization.
 */
export interface NormalizedSignal {
  // Tenant + company identity
  clientId: string;
  companyId: string;
  // Classification
  signalType: SignalType;
  signalSource: string;
  // Human-readable content
  signalTitle: string;
  signalDescription: string | null;
  // Provider payload (stored as opaque JSONB)
  evidence: Record<string, unknown>;
  // Scoring — all deterministic at ingestion time
  signalStrength: number;  // 0-100, base strength for this signal type
  confidence: number;      // 0.000-1.000
  // Timing
  occurredAt: string;      // ISO — when the business event happened
  detectedAt: string;      // ISO — when the engine processed this event
  expiresAt: string;       // ISO — occurred_at + type-specific TTL
  // Provenance
  sourceUrl: string | null;
  metadata: Record<string, unknown> | null;
  // Dedup
  dedupKey: string | null;
  // Lifecycle
  status: SignalStatus;
}

// ── DB row — what comes back from Supabase ────────────────────────────────────

export interface SignalRow extends NormalizedSignal {
  id: string;
  createdAt: string;
}

// ── Provider event wrapper ────────────────────────────────────────────────────

/** A raw event with its routing context, ready for the normalizer. */
export interface SignalProviderEvent {
  companyId: string;
  clientId: string;
  rawEvent: RawSignalEvent;
}

export interface RawEventBatch {
  events: SignalProviderEvent[];
  /** Optional provider-level metadata: rate-limit info, pagination cursor, etc. */
  meta?: Record<string, unknown>;
}

// ── Signal Intelligence (WHY NOW layer) ───────────────────────────────────────

/**
 * A compact signal summary passed to the AI for WHY NOW analysis.
 * Derived from a NormalizedSignal at analysis time — not stored separately.
 */
export interface SignalSummary {
  signalType: SignalType;
  title: string;
  description: string | null;
  /** Key evidence fields — subset of the full evidence JSONB. */
  evidence: Record<string, unknown>;
  /** Base strength 0-100 (deterministic, from computeSignalStrength). */
  signalStrength: number;
  /** Freshness score 0-100 at analysis time (deterministic, from computeFreshnessScore). */
  freshnessScore: number;
  occurredAt: string;
}

/**
 * Input to the signal intelligence task (WHY NOW analysis).
 * Combines company + ICP context with enriched, scored signal summaries.
 */
export interface SignalIntelligenceInput {
  company: import("./types").CompanyRecord;
  icp: {
    industry?: string;
    location?: string;
    employeeRange?: { min?: number; max?: number };
    keywords?: string[];
    description?: string;
  };
  signals: SignalSummary[];
}

/**
 * WHY NOW assessment produced by the signal intelligence task.
 *
 * IMPORTANT: opportunityScore is an AI analytical estimate used to test the
 * architecture. It is NOT a commercially validated scoring model.
 */
export interface SignalIntelligenceResult {
  /** 1-2 sentence timing rationale for outreach right now. */
  whyNow: string;
  /**
   * 0-100 AI-generated opportunity score.
   * ANALYTICAL ESTIMATE ONLY — not commercially validated.
   */
  opportunityScore: number;
  /** Signal titles that most influenced the assessment. */
  relevantSignals: string[];
  /** Full reasoning narrative from the AI. */
  reasoning: string;
  /** 0-1 AI self-reported confidence in the assessment. */
  confidence: number;
  // Observability (satisfies AITaskResult contract):
  model: string;
  analyzedAt: string;
  inputTokens?: number;
  outputTokens?: number;
}

// ── Stage 22: Why Now Engine storable types ───────────────────────────────────
//
// These types are stored in account_intelligence.why_now JSONB.
// They live in domain/ (not lib/) to break the circular dependency between
// lib/why-now.ts (which imports DB helpers) and db/account-intelligence.ts
// (which needs WhyNowAssessment for the row type).
//
// Operational types (WhyNowPayload, WhyNowResult, WhyNowThresholds, WhyNowOptions)
// stay in lib/why-now.ts.

/**
 * Signal summary with UUID for traceability — Stage 22.
 *
 * Extends SignalSummary with the signal's DB UUID, enabling post-validation
 * of AI citations against the actual stored signal rows. Never null.
 */
export interface WhyNowSignalSummary extends SignalSummary {
  /** UUID — traceable to signals.id in the DB. */
  signalId: string;
}

/**
 * Deterministic evidence assembled at Why Now assessment time — Stage 22.
 *
 * Computed once from stored signals and account intelligence.
 * Signal freshness is computed at assessedAt time (decays continuously).
 * This snapshot captures what was true when assessment ran; call
 * assessWhyNow() again to refresh it.
 */
export interface WhyNowEvidence {
  /** From account_intelligence.opportunity_score (deterministic, Stage 12). */
  opportunityScore:    number;
  /** From account_intelligence.priority_score (Stage 14). Null if not yet computed. */
  priorityScore:       number | null;
  /** Signals passing both guards: status=active AND !isExpired(). */
  activeSignalCount:   number;
  /** From computeCorroborationFactor() — range 1.0–1.45. */
  corroborationFactor: number;
  /** All active signals, with freshness scores computed at assessedAt. */
  signalSummaries:     WhyNowSignalSummary[];
  /** Top signals by ICP relevance × actionability (max 10). Used in AI prompt. */
  topSignals:          WhyNowSignalSummary[];
  /** ISO — when evidence was collected. */
  assessedAt:          string;
}

/**
 * Machine-readable reason for a readiness decision — Stage 22.
 * All threshold codes are INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */
export type ReadinessReason =
  | "READY"
  | "NO_ACCOUNT_INTELLIGENCE"           // No account_intelligence row exists yet
  | "OPPORTUNITY_SCORE_BELOW_THRESHOLD" // INITIAL_HYPOTHESIS_NOT_VALIDATED
  | "INSUFFICIENT_ACTIVE_SIGNALS";      // INITIAL_HYPOTHESIS_NOT_VALIDATED

/**
 * AI-generated Why Now narrative — Stage 22.
 *
 * Only generated when: ready=true AND opportunityScore >= AI threshold.
 * The AI must not invent events — output is grounded in signal evidence
 * passed in the prompt.
 *
 * relevantSignalIds provides UUID traceability back to the signals table.
 * Mapping is best-effort (title→ID): titles not found in the evidence
 * set are excluded. Use SELECT * FROM signals WHERE id = ANY(relevantSignalIds)
 * to verify cited evidence.
 */
export interface WhyNowNarrative {
  /** 1-2 sentences explaining why NOW is the right moment, citing actual signals. */
  whyNow:               string;
  /** Signal titles the AI identified as most relevant (from AI response). */
  relevantSignalTitles: string[];
  /**
   * Signal UUIDs mapped from relevantSignalTitles.
   * Best-effort: titles not found in the evidence set are excluded.
   * Traceable to signals.id — SELECT * FROM signals WHERE id = ANY(relevantSignalIds).
   */
  relevantSignalIds:    string[];
  /** AI self-reported confidence (0-1). Does NOT block storage when low. */
  confidence:           number;
  // Observability
  model:        string;
  analyzedAt:   string;
  inputTokens:  number;
  outputTokens: number;
  costUsd:      number | null;
  latencyMs:    number;
}

/**
 * Complete Why Now assessment stored in account_intelligence.why_now JSONB — Stage 22.
 *
 * The hypothesis field is always "INITIAL_HYPOTHESIS_NOT_VALIDATED" to document
 * that readiness thresholds and AI outputs have not been validated against
 * campaign outcome data. Do not remove or silence this label.
 */
export interface WhyNowAssessment {
  clientId:        string;
  companyId:       string;
  ready:           boolean;
  readinessReason: ReadinessReason;
  evidence:        WhyNowEvidence;
  /**
   * AI narrative. Null when not ready, AI skipped, score below AI threshold,
   * AI call failed, or existing narrative was reused from idempotency window.
   */
  narrative:       WhyNowNarrative | null;
  /** ISO — when assessWhyNow() was called. */
  assessedAt:      string;
  /** Always "INITIAL_HYPOTHESIS_NOT_VALIDATED" — thresholds are unvalidated hypotheses. */
  hypothesis:      "INITIAL_HYPOTHESIS_NOT_VALIDATED";
}
