/**
 * Task-agnostic AI execution wrapper — Stage 7.
 *
 * The core function execute<T>() wraps ANY AI provider call and automatically
 * captures the observability fields that every task type needs identically:
 *   - Wall-clock latency
 *   - Gateway identifier (extracted from provider.id)
 *   - Token counts (from the result's inputTokens / outputTokens fields)
 *   - USD cost (looked up in the centralized pricing registry)
 *
 * This ensures that ICP qualification, personalization, campaign strategy,
 * prefilter, reply classification, text normalization, and any future GTM
 * task all share the same execution infrastructure without duplication.
 *
 * Contract for result types: any type T used with execute<T>() must extend
 * AITaskResult — the minimum shape the executor needs for observability.
 * QualificationResult already satisfies this contract.  Future task result
 * types (PersonalizationResult, CampaignStrategyResult, …) must too.
 *
 * executeQualification() is a thin convenience wrapper for the current
 * sole consumer.  New task wrappers follow the same pattern:
 *
 *   export function executePersonalization(provider, input) {
 *     return execute(provider, () => provider.personalizeEmail(input));
 *   }
 */
import type { AIProvider } from "../types";
import type { PersonalizationInput, PersonalizationResult, QualificationInput, QualificationResult } from "../../domain/types";
import type { SignalIntelligenceInput, SignalIntelligenceResult } from "../../domain/signal-types";
import { extractGateway, makePriceKey, estimateCost } from "./pricing";

// ── Contract ──────────────────────────────────────────────────────────────────

/**
 * Minimum shape required of any AI task result.
 * The executor reads only these three fields; everything else is task-specific
 * and is passed through to the caller untouched.
 */
export interface AITaskResult {
  /** Model string as reported by the provider (used for pricing lookup). */
  model: string;
  /** Prompt token count. May be absent if the provider doesn't report usage. */
  inputTokens?: number;
  /** Completion token count. May be absent if the provider doesn't report usage. */
  outputTokens?: number;
}

// ── Result type ───────────────────────────────────────────────────────────────

/**
 * Generic result returned by execute<T>().
 * T is the task-specific result type (e.g. QualificationResult).
 * The default preserves backward compat for callers that don't specify T.
 */
export interface ExecutionResult<T extends AITaskResult = QualificationResult> {
  /** The full task-specific result from the provider. */
  result: T;
  /** Gateway extracted from provider.id, e.g. "anthropic-direct" or "openrouter". */
  gateway: string | null;
  /** Pricing registry key used for cost lookup ("gateway:model"), or null. */
  priceKey: string | null;
  /** Wall-clock milliseconds for this single provider call. */
  latencyMs: number;
  /** Input token count (0 when result omits it). */
  inputTokens: number;
  /** Output token count (0 when result omits it). */
  outputTokens: number;
  /** Computed USD cost, or null when the model is not in the pricing registry. */
  costUsd: number | null;
}

// ── Core executor ─────────────────────────────────────────────────────────────

/**
 * Execute any AI task call with automatic observability capture.
 *
 * Usage:
 *   const exec = await execute(provider, () => provider.qualifyCompany(input));
 *   const exec = await execute(provider, () => provider.personalizeEmail(input));
 *
 * @param provider  Any object with an `id` string (used for gateway extraction).
 *                  AIProvider, future PersonalizationProvider, etc. all qualify.
 * @param call      Zero-argument async factory that performs the actual AI call.
 *                  Returning a plain () => promise makes the call injectable for
 *                  testing — mock providers work without any special setup.
 */
export async function execute<T extends AITaskResult>(
  provider: { id: string },
  call: () => Promise<T>,
): Promise<ExecutionResult<T>> {
  const gateway = extractGateway(provider.id);

  const startMs = Date.now();
  const result = await call();
  const latencyMs = Date.now() - startMs;

  const inputTokens = result.inputTokens ?? 0;
  const outputTokens = result.outputTokens ?? 0;

  const priceKey = gateway ? makePriceKey(gateway, result.model) : null;
  const estimate = priceKey ? estimateCost(priceKey, inputTokens, outputTokens) : null;

  if (priceKey && !estimate) {
    console.warn(`[executor] No pricing entry for "${priceKey}" — cost_usd will be null`);
  }

  return {
    result,
    gateway,
    priceKey,
    latencyMs,
    inputTokens,
    outputTokens,
    costUsd: estimate?.totalCostUsd ?? null,
  };
}

// ── Task-specific wrappers ────────────────────────────────────────────────────

/**
 * Convenience wrapper for ICP qualification.
 * Delegates entirely to execute<QualificationResult>().
 * New task types follow the same pattern — no observability logic is repeated.
 */
export function executeQualification(
  provider: AIProvider,
  input: QualificationInput,
): Promise<ExecutionResult<QualificationResult>> {
  return execute(provider, () => provider.qualifyCompany(input));
}

/**
 * Minimum interface required to run a personalization task.
 * Any provider that implements personalizeMessage() satisfies this.
 */
export interface PersonalizationCapable {
  id: string;
  personalizeMessage(input: PersonalizationInput): Promise<PersonalizationResult>;
}

/**
 * Convenience wrapper for personalization.
 * Delegates entirely to execute<PersonalizationResult>() — zero observability
 * logic is repeated; latency, tokens, and cost are captured identically to
 * executeQualification().
 */
export function executePersonalization(
  provider: PersonalizationCapable,
  input: PersonalizationInput,
): Promise<ExecutionResult<PersonalizationResult>> {
  return execute(provider, () => provider.personalizeMessage(input));
}

/**
 * Minimum interface required to run a signal intelligence task.
 * Any provider that implements analyzeSignals() satisfies this.
 */
export interface SignalIntelligenceCapable {
  id: string;
  analyzeSignals(input: SignalIntelligenceInput): Promise<SignalIntelligenceResult>;
}

/**
 * Convenience wrapper for signal intelligence (WHY NOW analysis).
 * Same observability infrastructure as qualification and personalization —
 * latency, tokens, cost, and gateway are captured identically.
 */
export function executeSignalIntelligence(
  provider: SignalIntelligenceCapable,
  input: SignalIntelligenceInput,
): Promise<ExecutionResult<SignalIntelligenceResult>> {
  return execute(provider, () => provider.analyzeSignals(input));
}
