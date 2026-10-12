/**
 * Why Now Engine + Account Readiness — Stage 22.
 *
 * Answers "why should we reach out to this company right now?" using a
 * deterministic evidence builder, a readiness gate, and an optional AI
 * narrative grounded in stored signals.
 *
 * Three-stage pipeline:
 *
 *   1. buildWhyNowEvidence()     — pure, deterministic, no I/O
 *      Assembles signal evidence from stored SignalRows.
 *      Applies the same two-guard exclusion as buildScoreInputs():
 *        status !== "active" OR isExpired() → excluded
 *      Computes freshness scores at analysis time (same algorithm as scoring engine).
 *      Selects top signals by ICP relevance × actionability.
 *      Reuses computeCorroborationFactor() — identical to Stage 12 logic.
 *
 *   2. evaluateReadiness()       — pure, deterministic, no I/O
 *      Compares opportunityScore and activeSignalCount against thresholds.
 *      All thresholds are INITIAL_HYPOTHESIS_NOT_VALIDATED.
 *      Returns a ReadinessAssessment with a machine-readable reason code.
 *
 *   3. generateWhyNowNarrative() — async, AI, optional, cost-gated
 *      Only called when ready=true AND opportunityScore >= AI threshold.
 *      Uses the existing executeSignalIntelligence() / ModelRouter infrastructure.
 *      The AI system prompt explicitly prohibits inventing facts not in evidence.
 *      Signal IDs are embedded in evidence._signalId; post-validation maps AI
 *      signal titles back to UUIDs (best-effort, documented approximation).
 *
 * ── Separation of concerns ────────────────────────────────────────────────────
 *
 * This module adds a NARRATIVE layer above the existing scoring pipeline.
 * It does NOT change or re-implement:
 *   - The opportunity_score formula (src/lib/opportunity-scoring.ts)
 *   - The priority_score decay (src/lib/account-prioritization.ts)
 *   - The signal freshness calculation (src/lib/signal-freshness.ts)
 *   - The Stage 17 contact eligibility account gate (unchanged: opportunityScore > 0)
 *   - Signal ingestion, dedup, or TTL management
 *
 * ── INITIAL_HYPOTHESIS_NOT_VALIDATED labelling ────────────────────────────────
 *
 *   READINESS_MIN_OPPORTUNITY_SCORE       = 1  (any non-zero score → ready candidate)
 *   READINESS_MIN_ACTIVE_SIGNAL_COUNT     = 1  (at least one non-expired active signal)
 *   AI_NARRATIVE_MIN_OPPORTUNITY_SCORE    = 20 (cost gate; higher bar for AI spend)
 *
 * All three are unvalidated hypotheses, NOT commercially validated rules.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * Deterministic evidence and readiness are recomputed on every call.
 * The AI narrative is gated by WHY_NOW_RERUN_WINDOW_MS (23h): if a narrative
 * was generated within this window it is reused, preventing redundant AI spend.
 * Running with now overridden to the same value produces identical evidence/readiness.
 *
 * ── Client isolation ─────────────────────────────────────────────────────────
 *
 * All DB queries are scoped to clientId. The AI prompt does not include clientId
 * to avoid leaking tenant context into external AI calls.
 *
 * ── AI evidence constraints ───────────────────────────────────────────────────
 *
 * The existing signal intelligence system prompt prohibits:
 *   - Inventing events not in the signal list
 *   - Generic timing statements not grounded in specific signals
 *   - Referencing facts not in the company/ICP context
 *
 * ── Failure handling ─────────────────────────────────────────────────────────
 *
 * DB errors (signal fetch, AI row fetch, persist) throw — caller handles retry.
 * AI call failures are caught, logged, and result in narrative=null.
 * The deterministic assessment is ALWAYS persisted even when AI fails.
 *
 * ── Excluded by design ───────────────────────────────────────────────────────
 *
 *   No contact discovery, no lead enrollment, no campaign operations.
 *   No Smartlead, no Stage 21B, no outbound of any kind.
 *   No changes to the canonical opportunity_score or priority_score formulas.
 *   No validation of existing INITIAL_HYPOTHESIS_NOT_VALIDATED scoring assumptions.
 */

import type { SignalRow, SignalIntelligenceInput } from "../domain/signal-types";
import type {
  WhyNowEvidence,
  WhyNowSignalSummary,
  WhyNowNarrative,
  WhyNowAssessment,
  ReadinessReason,
} from "../domain/signal-types";
import { getAccountIntelligence, setWhyNow as persistWhyNow } from "../db/account-intelligence";
import { getSignalsByCompany } from "../db/signals";
import {
  buildScoreInputs,
  getIcpRelevance,
  computeCorroborationFactor,
} from "./opportunity-scoring";
import { computeFreshnessScore, isExpired } from "./signal-freshness";
import { executeSignalIntelligence } from "../providers/ai/executor";
import { ModelRouter } from "../providers/ai/model-router";
import type { SignalIntelligenceCapable } from "../providers/ai/executor";
import type { ComplexityHint } from "../providers/ai/model-router";

// ── Constants (all INITIAL_HYPOTHESIS_NOT_VALIDATED) ──────────────────────────

/**
 * Minimum opportunity_score for an account to be considered ready.
 * Matches the Stage 17 account gate: any non-zero score indicates signal evidence.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED — will be tuned against campaign outcome data.
 */
export const READINESS_MIN_OPPORTUNITY_SCORE = 1; // INITIAL_HYPOTHESIS_NOT_VALIDATED

/**
 * Minimum number of active, non-expired signals required for readiness.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED — conservative starting point.
 */
export const READINESS_MIN_ACTIVE_SIGNAL_COUNT = 1; // INITIAL_HYPOTHESIS_NOT_VALIDATED

/**
 * Minimum opportunity_score before an AI narrative is generated.
 * Higher than the readiness threshold — AI calls cost money and should be
 * reserved for accounts with meaningful signal evidence.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */
export const AI_NARRATIVE_MIN_OPPORTUNITY_SCORE = 20; // INITIAL_HYPOTHESIS_NOT_VALIDATED

/** Reuse an existing narrative if it was generated within this window. */
const WHY_NOW_RERUN_WINDOW_MS = 23 * 60 * 60 * 1000; // 23 hours

/** Maximum signals included in the AI prompt (keeps context manageable). */
export const AI_MAX_SIGNALS = 10;

// ── Operational types (not stored in DB) ──────────────────────────────────────

/**
 * Deterministic readiness gate result.
 * Pure return type — not stored in DB directly.
 * The fields are captured within WhyNowAssessment (which IS stored).
 */
export interface ReadinessAssessment {
  ready:             boolean;
  reason:            ReadinessReason;
  detail:            string;
  opportunityScore:  number;
  activeSignalCount: number;
}

/**
 * Configurable thresholds for a Why Now run.
 * All values are INITIAL_HYPOTHESIS_NOT_VALIDATED.
 * Partial overrides fall back to DEFAULT_WHY_NOW_THRESHOLDS.
 */
export interface WhyNowThresholds {
  /** Minimum opportunity_score for readiness gate. */
  minOpportunityScore:            number;
  /** Minimum active signal count for readiness gate. */
  minActiveSignalCount:           number;
  /** Minimum opportunity_score for AI narrative generation. */
  minAiNarrativeOpportunityScore: number;
}

export const DEFAULT_WHY_NOW_THRESHOLDS: Readonly<WhyNowThresholds> = {
  minOpportunityScore:            READINESS_MIN_OPPORTUNITY_SCORE,
  minActiveSignalCount:           READINESS_MIN_ACTIVE_SIGNAL_COUNT,
  minAiNarrativeOpportunityScore: AI_NARRATIVE_MIN_OPPORTUNITY_SCORE,
};

/** Input to assessWhyNow(). */
export interface WhyNowPayload {
  clientId:  string;
  companyId: string;
  /**
   * When true, readiness is evaluated but no AI call is made.
   * Useful for deterministic-only runs: no cost, fully reproducible.
   */
  skipAiNarrative?: boolean;
  /**
   * Override thresholds for this run.
   * Unspecified fields fall back to DEFAULT_WHY_NOW_THRESHOLDS.
   * All overrides remain INITIAL_HYPOTHESIS_NOT_VALIDATED.
   */
  thresholds?: Partial<WhyNowThresholds>;
  /** ICP context for the AI narrative prompt. Optional. */
  icpContext?: {
    industry?:      string;
    location?:      string;
    employeeRange?: { min?: number; max?: number };
    keywords?:      string[];
    description?:   string;
  };
  /**
   * Company profile for the AI narrative prompt.
   * Optional — AI receives a placeholder name when absent.
   */
  company?: {
    name:           string;
    domain?:        string | null;
    industry?:      string | null;
    employeeCount?: number | null;
    city?:          string | null;
    country?:       string | null;
    description?:   string | null;
  };
  /** ISO 8601 override for deterministic tests. Defaults to new Date(). */
  now?: string;
}

export interface WhyNowResult {
  clientId:        string;
  companyId:       string;
  assessment:      WhyNowAssessment;
  /** True when the assessment was persisted to account_intelligence. */
  persisted:       boolean;
  /** True when an AI call was made on this run. */
  aiCallMade:      boolean;
  /** True when an existing narrative was reused within the idempotency window. */
  narrativeReused: boolean;
}

/** Dependency injection for offline testing. */
export interface WhyNowOptions {
  /** Replace ModelRouter with a fake provider. Used in unit tests. */
  providerFactory?: (complexity: ComplexityHint) => SignalIntelligenceCapable;
}

// ── Pure functions ─────────────────────────────────────────────────────────────

/**
 * Build Why Now evidence from stored signals and account intelligence scores.
 *
 * Pure — no I/O. All inputs are passed by the caller.
 *
 * Applies the same two-guard exclusion as buildScoreInputs() in opportunity-scoring.ts:
 *   1. status !== "active" → excluded (DB-authoritative TTL management)
 *   2. isExpired(expiresAt, now) → excluded (in-memory race-condition guard)
 *
 * Freshness scores are computed at `now` using the same computeFreshnessScore()
 * algorithm used by the scoring engine — consistent with what produced opportunityScore.
 *
 * The corroborationFactor is taken from computeCorroborationFactor() — the exact same
 * function used by the scoring engine. No new cluster detection is introduced.
 *
 * Signal IDs are embedded in evidence._signalId to enable post-validation of AI citations.
 *
 * @param signals         All signals fetched for this (client, company) pair.
 * @param opportunityScore The current opportunity_score from account_intelligence.
 * @param priorityScore    The current priority_score. Null if Stage 14 not yet run.
 * @param now             Override the current time for deterministic tests.
 */
export function buildWhyNowEvidence(
  signals: SignalRow[],
  opportunityScore: number,
  priorityScore: number | null,
  now: Date = new Date(),
): WhyNowEvidence {
  // Two-guard exclusion — same logic as buildScoreInputs()
  const active = signals.filter(
    (s) => s.status === "active" && !isExpired(s.expiresAt, now),
  );

  // Build scored summaries; embed signal ID in evidence for AI citation traceability
  const signalSummaries: WhyNowSignalSummary[] = active.map((s) => ({
    signalId:      s.id,
    signalType:    s.signalType,
    title:         s.signalTitle,
    description:   s.signalDescription,
    evidence:      { ...s.evidence, _signalId: s.id },
    signalStrength: s.signalStrength,
    freshnessScore: computeFreshnessScore(s.occurredAt, s.expiresAt, now),
    occurredAt:    s.occurredAt,
  }));

  // Top signals: sort by ICP relevance × strength × freshness (descending), take top N
  const topSignals = [...signalSummaries]
    .sort((a, b) => {
      const actionabilityScore = (s: WhyNowSignalSummary) =>
        getIcpRelevance(s.signalType) * s.signalStrength * s.freshnessScore;
      return actionabilityScore(b) - actionabilityScore(a);
    })
    .slice(0, AI_MAX_SIGNALS);

  // Corroboration factor — reuses the exact same function as the scoring engine
  const { inputs } = buildScoreInputs(active, now);
  const corroborationFactor = computeCorroborationFactor(inputs, now);

  return {
    opportunityScore,
    priorityScore,
    activeSignalCount: active.length,
    corroborationFactor,
    signalSummaries,
    topSignals,
    assessedAt: now.toISOString(),
  };
}

/**
 * Evaluate whether an account is ready for contact discovery.
 *
 * Pure — no I/O. Two gates (both INITIAL_HYPOTHESIS_NOT_VALIDATED):
 *   1. opportunityScore >= thresholds.minOpportunityScore
 *   2. activeSignalCount >= thresholds.minActiveSignalCount
 *
 * The Stage 17 account gate (opportunity_score > 0) is NOT modified — this is
 * a separate, higher-level concept layered on top of the scoring engine.
 */
export function evaluateReadiness(
  evidence: WhyNowEvidence,
  thresholds: WhyNowThresholds = DEFAULT_WHY_NOW_THRESHOLDS,
): ReadinessAssessment {
  const { opportunityScore, activeSignalCount } = evidence;

  if (opportunityScore < thresholds.minOpportunityScore) {
    return {
      ready:             false,
      reason:            "OPPORTUNITY_SCORE_BELOW_THRESHOLD",
      detail:
        `opportunity_score ${opportunityScore} is below readiness threshold ` +
        `${thresholds.minOpportunityScore}. ` +
        "INITIAL_HYPOTHESIS_NOT_VALIDATED — threshold not validated against campaign data.",
      opportunityScore,
      activeSignalCount,
    };
  }

  if (activeSignalCount < thresholds.minActiveSignalCount) {
    return {
      ready:             false,
      reason:            "INSUFFICIENT_ACTIVE_SIGNALS",
      detail:
        `Only ${activeSignalCount} active signal(s) — below required minimum of ` +
        `${thresholds.minActiveSignalCount}. ` +
        "INITIAL_HYPOTHESIS_NOT_VALIDATED — threshold not validated against campaign data.",
      opportunityScore,
      activeSignalCount,
    };
  }

  return {
    ready:             true,
    reason:            "READY",
    detail:
      `Account has opportunity_score=${opportunityScore} and ${activeSignalCount} active ` +
      "signal(s), meeting readiness thresholds. INITIAL_HYPOTHESIS_NOT_VALIDATED.",
    opportunityScore,
    activeSignalCount,
  };
}

/**
 * Build a SignalIntelligenceInput from Why Now evidence for the AI call.
 *
 * Pure — no I/O. Converts WhyNowEvidence to the existing SignalIntelligenceInput
 * type consumed by the AI provider infrastructure. Uses topSignals (top N by
 * ICP relevance × actionability) to keep the prompt focused.
 *
 * Signal IDs are embedded in evidence._signalId so the AI can reference them
 * in reasoning, enabling post-validation of citations.
 *
 * @param assessedAt  The evidence.assessedAt ISO string — used as CompanyRecord.fetchedAt
 *                    (required field on CompanyRecord).
 */
export function buildWhyNowAiInput(
  evidence: WhyNowEvidence,
  company: WhyNowPayload["company"],
  icpContext: WhyNowPayload["icpContext"],
  assessedAt: string,
): SignalIntelligenceInput {
  return {
    company: {
      name:          company?.name          ?? "(company name not provided)",
      domain:        company?.domain        ?? undefined,
      industry:      company?.industry      ?? undefined,
      employeeCount: company?.employeeCount ?? undefined,
      city:          company?.city          ?? undefined,
      country:       company?.country       ?? undefined,
      description:   company?.description   ?? undefined,
      source:        "why-now",
      fetchedAt:     assessedAt,
    },
    icp: {
      industry:      icpContext?.industry,
      location:      icpContext?.location,
      employeeRange: icpContext?.employeeRange,
      keywords:      icpContext?.keywords,
      description:   icpContext?.description,
    },
    signals: evidence.topSignals,
  };
}

/**
 * Map AI-returned signal titles back to UUIDs from the evidence set.
 *
 * Pure — no I/O.
 *
 * The AI returns relevantSignals as signal titles (the existing contract from
 * SignalIntelligenceResult). This function matches those titles against
 * signalSummaries to recover the original UUIDs.
 *
 * Best-effort: titles not found in the evidence set are excluded from the UUID list.
 * When multiple signals share the same title (unusual), all matching UUIDs are included.
 * The caller stores both relevantSignalTitles (exact AI output) and relevantSignalIds
 * (post-mapped UUIDs) so the mapping quality is transparent.
 */
export function mapTitlesToSignalIds(
  relevantSignalTitles: string[],
  signalSummaries: WhyNowSignalSummary[],
): string[] {
  const titleToIds = new Map<string, string[]>();
  for (const s of signalSummaries) {
    const existing = titleToIds.get(s.title) ?? [];
    existing.push(s.signalId);
    titleToIds.set(s.title, existing);
  }

  const ids: string[] = [];
  for (const title of relevantSignalTitles) {
    const matched = titleToIds.get(title);
    if (matched) ids.push(...matched);
  }
  return [...new Set(ids)];
}

// ── Async orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the full Why Now assessment for a (client, company) pair.
 *
 * Steps:
 *   1. Fetch account_intelligence row → opportunityScore, priorityScore, existing whyNow
 *   2. If no AI row: return not-ready assessment without persisting (no row to UPDATE)
 *   3. Fetch active signals for this (client, company) pair (client-scoped)
 *   4. Build deterministic evidence — pure
 *   5. Evaluate readiness — pure
 *   6. (Conditionally) Generate AI narrative:
 *        Skipped when: ready=false, skipAiNarrative=true, score < AI threshold
 *        Reused when:  existing narrative is within WHY_NOW_RERUN_WINDOW_MS
 *        Attempted:    otherwise (failure → null narrative, assessment still persisted)
 *   7. Persist WhyNowAssessment to account_intelligence via setWhyNow()
 *   8. Return WhyNowResult with observability metadata
 *
 * @throws On DB errors (signal fetch, AI row fetch, persist).
 *         AI call failures are captured (narrative=null) and do NOT throw.
 */
export async function assessWhyNow(
  payload: WhyNowPayload,
  opts: WhyNowOptions = {},
): Promise<WhyNowResult> {
  const { clientId, companyId } = payload;
  const now = payload.now ? new Date(payload.now) : new Date();
  const thresholds: WhyNowThresholds = {
    ...DEFAULT_WHY_NOW_THRESHOLDS,
    ...payload.thresholds,
  };

  // 1. Fetch existing account intelligence
  const aiRow = await getAccountIntelligence(clientId, companyId);

  // 2. No row → no signals have been scored for this pair → not ready, don't persist
  if (!aiRow) {
    const evidence = buildWhyNowEvidence([], 0, null, now);
    const assessment: WhyNowAssessment = {
      clientId,
      companyId,
      ready:           false,
      readinessReason: "NO_ACCOUNT_INTELLIGENCE",
      evidence,
      narrative:       null,
      assessedAt:      now.toISOString(),
      hypothesis:      "INITIAL_HYPOTHESIS_NOT_VALIDATED",
    };
    return {
      clientId,
      companyId,
      assessment,
      persisted:       false,
      aiCallMade:      false,
      narrativeReused: false,
    };
  }

  const opportunityScore = aiRow.opportunityScore;
  const priorityScore    = aiRow.priorityScore ?? null;

  // 3. Fetch active signals (client-scoped)
  const signals = await getSignalsByCompany(companyId, clientId, { status: "active" });

  // 4. Build deterministic evidence
  const evidence = buildWhyNowEvidence(signals, opportunityScore, priorityScore, now);

  // 5. Evaluate readiness
  const readiness = evaluateReadiness(evidence, thresholds);

  // 6. Conditionally generate AI narrative
  let narrative: WhyNowNarrative | null = null;
  let aiCallMade      = false;
  let narrativeReused = false;

  const shouldAttemptAi =
    readiness.ready &&
    !payload.skipAiNarrative &&
    opportunityScore >= thresholds.minAiNarrativeOpportunityScore;

  if (shouldAttemptAi) {
    // Idempotency check: reuse existing narrative if within rerun window
    const existingNarrative  = aiRow.whyNow?.narrative ?? null;
    const existingAssessedAt = aiRow.readinessAssessedAt
      ? new Date(aiRow.readinessAssessedAt).getTime()
      : 0;
    const withinWindow = now.getTime() - existingAssessedAt < WHY_NOW_RERUN_WINDOW_MS;

    if (existingNarrative && withinWindow) {
      narrative       = existingNarrative;
      narrativeReused = true;
    } else {
      narrative  = await generateWhyNowNarrative(evidence, payload, opts);
      aiCallMade = true;
    }
  }

  // 7. Build and persist assessment
  const assessment: WhyNowAssessment = {
    clientId,
    companyId,
    ready:           readiness.ready,
    readinessReason: readiness.reason,
    evidence,
    narrative,
    assessedAt:      now.toISOString(),
    hypothesis:      "INITIAL_HYPOTHESIS_NOT_VALIDATED",
  };

  await persistWhyNow(clientId, companyId, assessment, now);

  return {
    clientId,
    companyId,
    assessment,
    persisted:       true,
    aiCallMade,
    narrativeReused,
  };
}

// ── AI narrative generation (internal) ────────────────────────────────────────

/**
 * Generate a Why Now narrative using the existing AI execution infrastructure.
 *
 * Reuses: ModelRouter("signal_intelligence") → executeSignalIntelligence() →
 * the same provider pipeline as the existing signal intelligence task (Stage 10.5).
 *
 * AI failure is non-fatal: errors are logged and the function returns null.
 * The caller always persists the deterministic assessment regardless.
 *
 * Observability: model, latency, token counts, and cost_usd are captured
 * identically to every other AI task via execute<T>() in executor.ts.
 */
async function generateWhyNowNarrative(
  evidence: WhyNowEvidence,
  payload: WhyNowPayload,
  opts: WhyNowOptions,
): Promise<WhyNowNarrative | null> {
  try {
    const input = buildWhyNowAiInput(evidence, payload.company, payload.icpContext, evidence.assessedAt);

    const provider: SignalIntelligenceCapable = opts.providerFactory
      ? opts.providerFactory("medium")
      : (ModelRouter.route("signal_intelligence", "medium") as unknown as SignalIntelligenceCapable);

    const execution = await executeSignalIntelligence(provider, input);
    const analyzedAt = new Date().toISOString();

    // Post-validate: map returned signal titles back to UUIDs
    const relevantSignalIds = mapTitlesToSignalIds(
      execution.result.relevantSignals,
      evidence.signalSummaries,
    );

    return {
      whyNow:               execution.result.whyNow,
      relevantSignalTitles: execution.result.relevantSignals,
      relevantSignalIds,
      confidence:           execution.result.confidence,
      model:                execution.result.model,
      analyzedAt,
      inputTokens:          execution.inputTokens,
      outputTokens:         execution.outputTokens,
      costUsd:              execution.costUsd,
      latencyMs:            execution.latencyMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[why-now] AI narrative generation failed for company=${payload.companyId}: ${msg}`,
    );
    return null;
  }
}
