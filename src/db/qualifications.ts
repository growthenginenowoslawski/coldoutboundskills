/**
 * Persist AI qualification runs into `enrichment_runs`.
 *
 * Stage 5: gateway, task_type, latency_ms, cost_usd, error_message,
 * cache_hit, escalated_from_run_id.
 * Stage 6 (pricing): cost_usd is now auto-computed from the pricing registry
 * when opts.costUsd is not explicitly set and tokens + gateway are available.
 * Stage 10: job_id + attempt_number columns; storeEscalationResult is now
 * idempotent — retries return existing row IDs instead of creating duplicates.
 *
 * The `buildQualificationRow` and `buildEscalationAttemptRow` helpers are
 * exported so tests can verify field-mapping and cost-computation logic without
 * hitting the database.
 */
import type { CompanyRecord, QualificationInput, QualificationResult } from "../domain/types";
import type { EscalationAttempt, EscalationResult } from "../providers/ai/escalation-router";
import type { TaskType } from "../providers/ai/model-router";
import { estimateCost, makePriceKey, extractGateway } from "../providers/ai/pricing";
import { getSupabaseAdmin } from "./supabase";

// ── Internal helpers ──────────────────────────────────────────────────────────

// extractGateway is re-exported from pricing.ts for consumers that still import it
// from this module (tests, etc.).  The canonical definition lives in pricing.ts.
export { extractGateway } from "../providers/ai/pricing";

/** Compact, provider-agnostic snapshot of what the AI saw (for provenance). */
function inputSnapshot(input: QualificationInput) {
  const c: CompanyRecord = input.company;
  return {
    company: {
      name: c.name,
      domain: c.domain ?? null,
      industry: c.industry ?? null,
      city: c.city ?? null,
      region: c.region ?? null,
      country: c.country ?? null,
      employeeCount: c.employeeCount ?? null,
    },
    icp: input.icp,
    signals: input.signals ?? [],
  };
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface StoreQualificationOptions {
  /** Also write the score to companies.icp_score (does NOT touch status). */
  updateIcpScore?: boolean;
  /** Tag this call to a client for per-client cost roll-up. */
  clientId?: string;
  // Stage 5 observability fields:
  /** AI gateway used — "anthropic-direct" | "openrouter". */
  gateway?: string;
  /** Routing task type — "icp_qualification" | "personalization" | … */
  taskType?: string;
  /** Wall-clock ms from AI request start to response receipt. */
  latencyMs?: number;
  /** Estimated cost in USD (tokens × model price). Null if unavailable. */
  costUsd?: number;
  /** Human-readable failure reason. Null on successful runs. */
  errorMessage?: string;
  /** FK to the cheaper attempt this run escalated from. */
  escalatedFromRunId?: string;
  /** Stage 10: FK to the jobs row that produced this run. */
  jobId?: string;
  /** Stage 10: 0-based attempt number within the escalation chain. */
  attemptNumber?: number;
}

export interface StoreEscalationOptions {
  /** Tag all attempt rows to a client. */
  clientId?: string;
  /** Also write the score to companies.icp_score (does NOT touch status). */
  updateIcpScore?: boolean;
  /** Total wall-clock ms for the entire escalation (across all attempts). */
  totalLatencyMs?: number;
  /** Stage 10: FK to the jobs row — enables duplicate-run prevention. */
  jobId?: string;
}

// ── Cost resolution ───────────────────────────────────────────────────────────

/**
 * Resolves cost_usd for a DB row:
 *   1. explicit takes priority (even when it's 0)
 *   2. auto-compute from pricing registry when priceKey + both token counts available
 *   3. null otherwise
 */
function resolveCost(
  explicit: number | undefined,
  priceKey: string | null,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  if (explicit !== undefined) return explicit;
  if (!priceKey || inputTokens == null || outputTokens == null) return null;
  const estimate = estimateCost(priceKey, inputTokens, outputTokens);
  return estimate?.totalCostUsd ?? null;
}

// ── Pure row-builders (exported for testing) ──────────────────────────────────

/**
 * Builds the DB row dict for a single qualification result.
 * Pure — no I/O; safe to test without a DB.
 *
 * cost_usd is resolved in this order:
 *   1. opts.costUsd if explicitly provided (even 0)
 *   2. Auto-computed from pricing registry using opts.gateway + result.model + tokens
 *   3. null when gateway or tokens are unavailable / model not in registry
 */
export function buildQualificationRow(
  companyId: string,
  input: QualificationInput,
  result: QualificationResult,
  startedAt: string,
  opts: StoreQualificationOptions = {},
): Record<string, unknown> {
  const costUsd = resolveCost(
    opts.costUsd,
    opts.gateway ? makePriceKey(opts.gateway, result.model) : null,
    result.inputTokens ?? null,
    result.outputTokens ?? null,
  );

  return {
    company_id: companyId,
    provider: result.model,
    operation: "ai_qualification",
    status: opts.errorMessage ? "failed" : "completed",
    input_data: inputSnapshot(input),
    output_data: result,
    started_at: startedAt,
    completed_at: result.qualifiedAt,
    input_tokens: result.inputTokens ?? null,
    output_tokens: result.outputTokens ?? null,
    client_id: opts.clientId ?? null,
    // Stage 5 fields:
    gateway: opts.gateway ?? null,
    task_type: opts.taskType ?? null,
    latency_ms: opts.latencyMs ?? null,
    cost_usd: costUsd,
    error_message: opts.errorMessage ?? null,
    cache_hit: null,
    escalated_from_run_id: opts.escalatedFromRunId ?? null,
    job_id: opts.jobId ?? null,
    attempt_number: opts.attemptNumber ?? null,
  };
}

/**
 * Builds a DB row for a single attempt within an escalation chain.
 * Pure — no I/O; safe to test without a DB.
 *
 * @param attempt          The attempt record from EscalationResult.attempts.
 * @param finalResult      The QualificationResult accepted at this attempt's tier.
 *                         Only meaningful (and only stored in output_data) for the
 *                         final accepted attempt; intermediate attempts store null.
 * @param isFinalAttempt   True only for the last attempt (the one that was accepted).
 * @param escalatedFromRunId  The DB-generated id of the previous attempt's row.
 */
export function buildEscalationAttemptRow(
  companyId: string,
  input: QualificationInput,
  attempt: EscalationAttempt,
  finalResult: QualificationResult | null,
  isFinalAttempt: boolean,
  opts: {
    clientId?: string;
    taskType?: string;
    escalatedFromRunId?: string;
    startedAt: string;
    completedAt?: string;
    /** @deprecated Per-attempt latency is now sourced from attempt.latencyMs. */
    latencyMs?: number;
    /** Stage 10: FK to the jobs row — enables duplicate-run prevention. */
    jobId?: string;
    /** Stage 10: 0-based index of this attempt within the escalation chain. */
    attemptNumber?: number;
  },
): Record<string, unknown> {
  const gateway = extractGateway(attempt.providerId);

  return {
    company_id: companyId,
    provider: attempt.model,
    operation: "ai_qualification",
    status: isFinalAttempt ? "completed" : "escalated",
    input_data: inputSnapshot(input),
    output_data: isFinalAttempt ? (finalResult ?? null) : null,
    started_at: opts.startedAt,
    completed_at: isFinalAttempt ? (opts.completedAt ?? null) : null,
    input_tokens: attempt.inputTokens ?? null,
    output_tokens: attempt.outputTokens ?? null,
    client_id: opts.clientId ?? null,
    // Stage 5 fields:
    gateway,
    task_type: opts.taskType ?? null,
    // Stage 6: per-attempt timing and cost — pre-computed by the executor.
    latency_ms: attempt.latencyMs,
    cost_usd: attempt.costUsd ?? null,
    error_message: null,
    cache_hit: null,
    escalated_from_run_id: opts.escalatedFromRunId ?? null,
    // Stage 10: operation identity
    job_id: opts.jobId ?? null,
    attempt_number: opts.attemptNumber ?? null,
  };
}

// ── Async persistence functions ───────────────────────────────────────────────

/**
 * Persists a single AI qualification result.
 * Pass gateway, taskType, latencyMs etc. in opts for full observability.
 */
export async function storeQualification(
  companyId: string,
  input: QualificationInput,
  result: QualificationResult,
  startedAt: string,
  opts: StoreQualificationOptions = {},
): Promise<{ enrichmentRunId: string }> {
  const db = getSupabaseAdmin();
  const row = buildQualificationRow(companyId, input, result, startedAt, opts);

  const { data, error } = await db
    .from("enrichment_runs")
    .insert(row)
    .select("id")
    .single();
  if (error) throw new Error(`storeQualification failed: ${error.message}`);

  if (opts.updateIcpScore) {
    const { error: upErr } = await db
      .from("companies")
      .update({ icp_score: result.score, updated_at: new Date().toISOString() })
      .eq("id", companyId);
    if (upErr) throw new Error(`icp_score update failed: ${upErr.message}`);
  }

  return { enrichmentRunId: (data as { id: string }).id };
}

/**
 * Persists an EscalationResult as a linked chain of enrichment_run rows —
 * one row per attempt.  Rows are linked via escalated_from_run_id so the
 * full escalation path is queryable.
 *
 * Stage 10: when opts.jobId is provided, each row gets job_id + attempt_number.
 * The unique index on (job_id, attempt_number) makes this call idempotent:
 * a retry that finds an existing row returns its ID without creating a duplicate.
 *
 * Chain layout (example: low → medium → high):
 *   [0] low  attempt  — status: "escalated", escalated_from_run_id: null
 *   [1] mid  attempt  — status: "escalated", escalated_from_run_id: row[0].id
 *   [2] high attempt  — status: "completed", escalated_from_run_id: row[1].id
 *
 * Returns all row IDs in attempt order, plus the final (accepted) run ID.
 */
export async function storeEscalationResult(
  companyId: string,
  input: QualificationInput,
  escalation: EscalationResult,
  taskType: TaskType,
  startedAt: string,
  opts: StoreEscalationOptions = {},
): Promise<{ runIds: string[]; finalRunId: string }> {
  const db = getSupabaseAdmin();
  const runIds: string[] = [];
  const totalAttempts = escalation.attempts.length;

  for (let i = 0; i < totalAttempts; i++) {
    const attempt = escalation.attempts[i];
    const isFinal = i === totalAttempts - 1;

    const row = buildEscalationAttemptRow(
      companyId,
      input,
      attempt,
      isFinal ? escalation.result : null,
      isFinal,
      {
        clientId: opts.clientId,
        taskType,
        escalatedFromRunId: i > 0 ? runIds[i - 1] : undefined,
        startedAt,
        completedAt: isFinal ? escalation.result.qualifiedAt : undefined,
        latencyMs: isFinal ? opts.totalLatencyMs : undefined,
        jobId: opts.jobId,
        attemptNumber: i,
      },
    );

    const runId = await insertOrFindEnrichmentRun(db, row, opts.jobId, i);
    runIds.push(runId);
  }

  if (opts.updateIcpScore) {
    const { error: upErr } = await db
      .from("companies")
      .update({ icp_score: escalation.result.score, updated_at: new Date().toISOString() })
      .eq("id", companyId);
    if (upErr) throw new Error(`icp_score update failed: ${upErr.message}`);
  }

  return { runIds, finalRunId: runIds[runIds.length - 1] };
}

/**
 * Inserts an enrichment_run row. If the (job_id, attempt_number) unique constraint
 * fires (error 23505), looks up and returns the existing row's ID instead.
 *
 * This makes storeEscalationResult idempotent: a Trigger.dev retry that re-runs
 * the enrichment write returns the same IDs without creating duplicate rows.
 */
async function insertOrFindEnrichmentRun(
  db: ReturnType<typeof getSupabaseAdmin>,
  row: Record<string, unknown>,
  jobId: string | undefined,
  attemptNumber: number,
): Promise<string> {
  const { data, error } = await db
    .from("enrichment_runs")
    .insert(row)
    .select("id")
    .single();

  if (!error) return (data as { id: string }).id;

  if (error.code === "23505" && jobId != null) {
    const { data: existing, error: lookupErr } = await db
      .from("enrichment_runs")
      .select("id")
      .eq("job_id", jobId)
      .eq("attempt_number", attemptNumber)
      .single();
    if (lookupErr) {
      throw new Error(`insertOrFindEnrichmentRun lookup failed: ${lookupErr.message}`);
    }
    return (existing as { id: string }).id;
  }

  throw new Error(`storeEscalationResult failed at attempt ${attemptNumber}: ${error.message}`);
}
