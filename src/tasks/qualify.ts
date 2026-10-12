/**
 * Pure, task-agnostic AI qualification logic — Stage 8.
 *
 * This module contains the business logic for running an ICP qualification
 * through the AI execution stack.  It has NO dependencies on Trigger.dev and
 * NO direct Supabase calls — both are handled by the caller (trigger task or
 * test harness).
 *
 * The full path wired here:
 *   payload → EscalationRouter → ModelRouter → execute<T>() → pricing engine
 *                              → EscalationResult (with per-attempt cost + timing)
 *
 * Because all AI provider and observability concerns live in the existing layers
 * (executor.ts, escalation-router.ts, pricing.ts), this file has almost no
 * "logic" — it is a thin adapter that maps the AI output into the task result
 * shape and returns the raw escalation data for the caller to persist.
 *
 * Extension pattern for future task types:
 *   - Add runAIPersonalize(), runAICampaignStrategy(), etc. in adjacent files.
 *   - They call execute<T>() directly (no EscalationRouter if single-shot) or
 *     build their own escalation config.
 *   - No execution infrastructure is duplicated.
 */
import {
  EscalationRouter,
  ESCALATION_DEFAULTS,
  type EscalationConfig,
  type EscalationResult,
} from "../providers/ai/escalation-router";
import { extractGateway } from "../providers/ai/pricing";
import type { TaskType, ComplexityHint } from "../providers/ai/model-router";
import type { AIProvider } from "../providers/types";
import type { QualificationInput } from "../domain/types";

// ── Payload ───────────────────────────────────────────────────────────────────

/**
 * Input to runAIQualify.  Also used as the Trigger.dev task payload (the task
 * extends this with dev-mode flags).
 */
export interface AIQualifyPayload {
  /** Supabase companies.id for the company being qualified. */
  companyId: string;
  /** Routing task type — determines escalation defaults + model tier. */
  taskType: TaskType;
  /**
   * Stable business-level key that prevents the same (company, task) pair from
   * being processed twice.  Callers must supply this; a common convention is
   * `${companyId}:${taskType}:${batchId}`.
   */
  idempotencyKey: string;
  /** Multi-tenant ID — propagated to enrichment_runs.client_id. */
  clientId?: string;
  /** The company + ICP data the AI reasons over. */
  input: QualificationInput;
  /** Override specific escalation params without replacing the whole config. */
  escalationOverrides?: Partial<Omit<EscalationConfig, "taskType">>;
}

// ── Result ────────────────────────────────────────────────────────────────────

/** Structured qualification verdict with full observability fields. */
export interface AIQualifyResult {
  /** True when the idempotency check found an existing completed record. */
  alreadyProcessed: boolean;
  companyId: string;
  taskType: TaskType;
  idempotencyKey: string;
  clientId: string | null;
  // AI verdict:
  icpFit: boolean;
  score: number;
  confidence: number | null;
  reason: string;
  // Observability (mirrors enrichment_runs columns):
  gateway: string | null;
  model: string;
  /** Sum of input tokens across ALL escalation attempts. */
  inputTokens: number;
  /** Sum of output tokens across ALL escalation attempts. */
  outputTokens: number;
  /** USD cost for the final accepted attempt only. */
  costUsd: number | null;
  /** Total USD cost summed across ALL escalation attempts. Null if any model unpriced. */
  totalCostUsd: number | null;
  /** Wall-clock ms for the final accepted attempt only. */
  latencyMs: number;
  escalated: boolean;
  attemptCount: number;
}

/**
 * What runAIQualify returns.  The caller (Trigger.dev task) uses:
 *   - result    → return to the dashboard / downstream tasks
 *   - escalation → pass to storeEscalationResult() for DB persistence
 *   - startedAt  → anchor timestamp for DB rows
 */
export interface AIQualifyExecution {
  result: AIQualifyResult;
  /** Raw escalation output — includes per-attempt cost, latency, priceKey. */
  escalation: EscalationResult;
  /** ISO timestamp recorded just before the AI call started. */
  startedAt: string;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface AIQualifyOptions {
  /**
   * Inject a provider factory for offline testing.
   * When provided, bypasses ModelRouter and makes no real API calls.
   * Follows the same _EscalationTestOptions.providerFactory contract.
   */
  providerFactory?: (taskType: TaskType, tier: ComplexityHint) => AIProvider;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Run an ICP qualification through the full AI execution stack.
 *
 * No Supabase writes.  No Trigger.dev imports.  Safe to call from unit tests.
 *
 * Throws when the AI provider throws (network error, auth failure, etc.).
 * The caller is responsible for catching and recording the failure.
 */
export async function runAIQualify(
  payload: AIQualifyPayload,
  opts: AIQualifyOptions = {},
): Promise<AIQualifyExecution> {
  const startedAt = new Date().toISOString();

  // Build escalation config from defaults + any caller overrides.
  // Always force taskType to match the payload to prevent mismatches.
  const config: EscalationConfig = {
    ...ESCALATION_DEFAULTS[payload.taskType],
    ...payload.escalationOverrides,
    taskType: payload.taskType,
  };

  const escalation = await EscalationRouter.qualify(
    payload.input,
    config,
    opts.providerFactory ? { providerFactory: opts.providerFactory } : {},
  );

  const finalAttempt = escalation.attempts[escalation.attempts.length - 1];
  const gateway = extractGateway(escalation.finalProviderId);

  const result: AIQualifyResult = {
    alreadyProcessed: false,
    companyId: payload.companyId,
    taskType: payload.taskType,
    idempotencyKey: payload.idempotencyKey,
    clientId: payload.clientId ?? null,
    // AI verdict:
    icpFit: escalation.result.icpFit,
    score: escalation.result.score,
    confidence: finalAttempt.confidence,
    reason: escalation.result.reason,
    // Observability:
    gateway,
    model: escalation.result.model,
    inputTokens: escalation.totalInputTokens,
    outputTokens: escalation.totalOutputTokens,
    costUsd: finalAttempt.costUsd,
    totalCostUsd: escalation.totalCostUsd,
    latencyMs: finalAttempt.latencyMs,
    escalated: escalation.escalated,
    attemptCount: escalation.attempts.length,
  };

  return { result, escalation, startedAt };
}
