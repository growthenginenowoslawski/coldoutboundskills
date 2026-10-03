/**
 * Pure, task-agnostic AI signal intelligence (WHY NOW) logic.
 *
 * Mirrors the structure of src/tasks/personalize.ts — thin adapter that uses
 * the existing execution infrastructure (ModelRouter → Executor → pricing)
 * with NO Trigger.dev imports and NO direct Supabase calls.
 *
 * The full path:
 *   payload → ModelRouter → SignalIntelligenceCapable provider
 *           → execute<SignalIntelligenceResult>() → pricing engine
 *           → AISignalIntelligenceExecution
 *
 * The caller (trigger task or test harness) handles Supabase writes.
 */
import { ModelRouter, type TaskType, type ComplexityHint } from "../providers/ai/model-router";
import { executeSignalIntelligence, type SignalIntelligenceCapable } from "../providers/ai/executor";
import { extractGateway } from "../providers/ai/pricing";
import type { SignalIntelligenceInput, SignalIntelligenceResult } from "../domain/signal-types";

// ── Payload ───────────────────────────────────────────────────────────────────

export interface AISignalIntelligencePayload {
  companyId: string;
  taskType: TaskType;
  idempotencyKey: string;
  clientId?: string;
  input: SignalIntelligenceInput;
  /** Force a specific complexity tier (default: task type's defaultComplexity). */
  complexity?: ComplexityHint;
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface AISignalIntelligenceResult {
  alreadyProcessed: boolean;
  companyId: string;
  taskType: TaskType;
  idempotencyKey: string;
  clientId: string | null;
  // AI output:
  whyNow: string;
  opportunityScore: number;
  relevantSignals: string[];
  reasoning: string;
  confidence: number;
  // Observability:
  gateway: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

export interface AISignalIntelligenceExecution {
  result: AISignalIntelligenceResult;
  /** Raw SignalIntelligenceResult from the provider — stored as output_data. */
  providerResult: SignalIntelligenceResult;
  startedAt: string;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface AISignalIntelligenceOptions {
  /** Inject a provider for offline testing — bypasses ModelRouter. */
  providerFactory?: (taskType: TaskType, tier: ComplexityHint) => SignalIntelligenceCapable;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Run a signal intelligence task through the full AI execution stack.
 *
 * No Supabase writes. No Trigger.dev imports. Safe to call from unit tests.
 */
export async function runAISignalIntelligence(
  payload: AISignalIntelligencePayload,
  opts: AISignalIntelligenceOptions = {},
): Promise<AISignalIntelligenceExecution> {
  const startedAt = new Date().toISOString();
  const tier = payload.complexity ?? ModelRouter.routeConfig(payload.taskType).defaultComplexity;

  const provider: SignalIntelligenceCapable = opts.providerFactory
    ? opts.providerFactory(payload.taskType, tier)
    : (ModelRouter.route(payload.taskType, tier) as unknown as SignalIntelligenceCapable);

  const execution = await executeSignalIntelligence(provider, payload.input);
  const gateway = extractGateway(provider.id);

  const result: AISignalIntelligenceResult = {
    alreadyProcessed: false,
    companyId: payload.companyId,
    taskType: payload.taskType,
    idempotencyKey: payload.idempotencyKey,
    clientId: payload.clientId ?? null,
    // AI output:
    whyNow: execution.result.whyNow,
    opportunityScore: execution.result.opportunityScore,
    relevantSignals: execution.result.relevantSignals,
    reasoning: execution.result.reasoning,
    confidence: execution.result.confidence,
    // Observability:
    gateway,
    model: execution.result.model,
    inputTokens: execution.inputTokens,
    outputTokens: execution.outputTokens,
    costUsd: execution.costUsd,
    latencyMs: execution.latencyMs,
  };

  return { result, providerResult: execution.result, startedAt };
}
