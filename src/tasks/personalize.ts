/**
 * Pure, task-agnostic AI personalization logic.
 *
 * Mirrors the structure of src/tasks/qualify.ts — thin adapter that uses the
 * existing execution infrastructure (ModelRouter → Executor → pricing engine)
 * with NO Trigger.dev imports and NO direct Supabase calls.
 *
 * The full path:
 *   payload → ModelRouter → PersonalizationCapable provider
 *           → execute<PersonalizationResult>() → pricing engine
 *           → AIPersonalizeExecution
 *
 * Extension pattern proves task-agnosticism:
 *   - No observability logic is duplicated.
 *   - The executor captures latency, tokens, and cost identically to qualification.
 *   - The caller (trigger task or test harness) handles Supabase writes.
 */
import { ModelRouter, type TaskType, type ComplexityHint } from "../providers/ai/model-router";
import { executePersonalization, type PersonalizationCapable } from "../providers/ai/executor";
import { extractGateway } from "../providers/ai/pricing";
import type { PersonalizationInput, PersonalizationResult } from "../domain/types";

// ── Payload ───────────────────────────────────────────────────────────────────

export interface AIPersonalizePayload {
  companyId: string;
  taskType: TaskType;
  idempotencyKey: string;
  clientId?: string;
  input: PersonalizationInput;
  /** Force a specific complexity tier (default: task type's defaultComplexity). */
  complexity?: ComplexityHint;
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface AIPersonalizeResult {
  alreadyProcessed: boolean;
  companyId: string;
  taskType: TaskType;
  idempotencyKey: string;
  clientId: string | null;
  // AI output:
  subject: string;
  message: string;
  tone: string;
  confidence: number | null;
  // Observability:
  gateway: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
}

export interface AIPersonalizeExecution {
  result: AIPersonalizeResult;
  /** Raw PersonalizationResult from the provider — stored as output_data. */
  providerResult: PersonalizationResult;
  startedAt: string;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface AIPersonalizeOptions {
  /** Inject a provider for offline testing — bypasses ModelRouter. */
  providerFactory?: (taskType: TaskType, tier: ComplexityHint) => PersonalizationCapable;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Run a personalization task through the full AI execution stack.
 *
 * No Supabase writes. No Trigger.dev imports. Safe to call from unit tests.
 */
export async function runAIPersonalize(
  payload: AIPersonalizePayload,
  opts: AIPersonalizeOptions = {},
): Promise<AIPersonalizeExecution> {
  const startedAt = new Date().toISOString();
  const tier = payload.complexity ?? ModelRouter.routeConfig(payload.taskType).defaultComplexity;

  const provider: PersonalizationCapable = opts.providerFactory
    ? opts.providerFactory(payload.taskType, tier)
    : (ModelRouter.route(payload.taskType, tier) as unknown as PersonalizationCapable);

  const execution = await executePersonalization(provider, payload.input);
  const gateway = extractGateway(provider.id);

  const result: AIPersonalizeResult = {
    alreadyProcessed: false,
    companyId: payload.companyId,
    taskType: payload.taskType,
    idempotencyKey: payload.idempotencyKey,
    clientId: payload.clientId ?? null,
    // AI output:
    subject: execution.result.subject,
    message: execution.result.message,
    tone: execution.result.tone,
    confidence: typeof execution.result.confidence === "number" ? execution.result.confidence : null,
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
