/**
 * Centralized AI model pricing registry.
 *
 * Responsibilities:
 *   - Store input and output prices per model, per gateway
 *   - Calculate input cost, output cost, and total cost from token counts
 *   - Be the single place to update when provider pricing changes
 *
 * NOT responsible for:
 *   - Routing or model selection (see model-router.ts)
 *   - Persisting cost data (see qualifications.ts)
 *   - Client budget policies (Stage 6)
 *
 * Pricing key format: "gateway:model" — matches AIProvider.id exactly, so
 * EscalationAttempt.providerId can be used as a key without transformation.
 *
 * Prices are in USD per 1,000,000 tokens (the industry-standard unit).
 *
 * TO UPDATE PRICES: edit MODEL_PRICING below. The key names must stay stable
 * because they are stored in enrichment_runs.gateway / provider columns.
 */

import { PROVIDER_TIERS } from "./model-router";
import type { ProviderName } from "./provider-registry";
import type { ComplexityHint } from "./model-router";

// ── Registry types ────────────────────────────────────────────────────────────

export interface ModelPrice {
  /** USD cost per 1,000,000 input (prompt) tokens. */
  inputPer1M: number;
  /** USD cost per 1,000,000 output (completion) tokens. */
  outputPer1M: number;
  /** Human-readable label for logs and display. */
  label: string;
}

export interface CostEstimate {
  /** USD cost for the input tokens alone. */
  inputCostUsd: number;
  /** USD cost for the output tokens alone. */
  outputCostUsd: number;
  /** Total USD cost (inputCostUsd + outputCostUsd). */
  totalCostUsd: number;
  /** The registry key that was matched ("gateway:model"). */
  priceKey: string;
}

// ── Pricing registry ──────────────────────────────────────────────────────────
//
// Source: Anthropic pricing page + OpenRouter pricing page.
// OpenRouter passes through Anthropic list prices for these models.
//
// VERIFY AND UPDATE prices here whenever Anthropic or OpenRouter publishes
// new rates. The structure stays the same; only the numbers change.
//
// Last verified: 2026-08-26 (approximate — confirm at console.anthropic.com/pricing
// and openrouter.ai/models before relying on these for billing).

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // ── Anthropic Direct (native SDK, no gateway markup) ──────────────────────
  "anthropic-direct:claude-haiku-4-5-20251001": {
    label: "Claude Haiku 4.5 (Anthropic Direct)",
    inputPer1M: 0.80,
    outputPer1M: 4.00,
  },
  "anthropic-direct:claude-sonnet-4-6": {
    label: "Claude Sonnet 4.6 (Anthropic Direct)",
    inputPer1M: 3.00,
    outputPer1M: 15.00,
  },
  "anthropic-direct:claude-opus-4-8": {
    label: "Claude Opus 4.8 (Anthropic Direct)",
    inputPer1M: 15.00,
    outputPer1M: 75.00,
  },

  // ── OpenRouter (Anthropic models via gateway, list price pass-through) ─────
  "openrouter:anthropic/claude-haiku-4.5": {
    label: "Claude Haiku 4.5 (OpenRouter)",
    inputPer1M: 0.80,
    outputPer1M: 4.00,
  },
  "openrouter:anthropic/claude-sonnet-4-6": {
    label: "Claude Sonnet 4.6 (OpenRouter)",
    inputPer1M: 3.00,
    outputPer1M: 15.00,
  },
  // OpenRouter returns dot notation in response.model — alias for the same model
  "openrouter:anthropic/claude-sonnet-4.6": {
    label: "Claude Sonnet 4.6 (OpenRouter)",
    inputPer1M: 3.00,
    outputPer1M: 15.00,
  },
  "openrouter:anthropic/claude-opus-4-8": {
    label: "Claude Opus 4.8 (OpenRouter)",
    inputPer1M: 15.00,
    outputPer1M: 75.00,
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extracts the gateway name from a provider id or pricing key.
 * Provider ids follow the "gateway:model" format, e.g.:
 *   "anthropic-direct:claude-opus-4-8"  → "anthropic-direct"
 *   "openrouter:anthropic/claude-haiku" → "openrouter"
 * Returns null for ids that don't match the pattern.
 */
export function extractGateway(providerId: string): string | null {
  const colonIdx = providerId.indexOf(":");
  if (colonIdx <= 0) return null;
  return providerId.slice(0, colonIdx);
}

/**
 * Build the pricing registry key from a gateway name and model string.
 * Produces the same format as AIProvider.id ("gateway:model").
 */
export function makePriceKey(gateway: string, model: string): string {
  return `${gateway}:${model}`;
}

/**
 * Look up the price entry for a given key.
 * Returns null when the model is not in the registry (cost will be unknown).
 */
export function getModelPrice(priceKey: string): ModelPrice | null {
  return MODEL_PRICING[priceKey] ?? null;
}

/**
 * Estimate the USD cost for an AI call given token counts.
 *
 * Returns null when:
 *   - The priceKey is not in the registry (unknown model)
 *   - Either token count is negative, NaN, or non-finite (invalid input)
 *
 * Returns a CostEstimate with inputCostUsd, outputCostUsd, and totalCostUsd
 * when pricing is available.  Zero tokens produce a zero cost (valid).
 */
export function estimateCost(
  priceKey: string,
  inputTokens: number,
  outputTokens: number,
): CostEstimate | null {
  const price = getModelPrice(priceKey);
  if (!price) return null;

  if (
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return null;
  }

  const inputCostUsd = (inputTokens / 1_000_000) * price.inputPer1M;
  const outputCostUsd = (outputTokens / 1_000_000) * price.outputPer1M;
  const totalCostUsd = inputCostUsd + outputCostUsd;

  return { inputCostUsd, outputCostUsd, totalCostUsd, priceKey };
}

// ── Registry completeness guard (used in tests) ───────────────────────────────

/**
 * Returns all provider+tier combinations from PROVIDER_TIERS that are missing
 * a pricing entry.  An empty array means the registry is complete.
 * Call this in tests and monitoring to catch gaps when new models are added.
 */
export function findUnpricedTiers(): Array<{ gateway: ProviderName; tier: ComplexityHint; model: string; priceKey: string }> {
  const missing: Array<{ gateway: ProviderName; tier: ComplexityHint; model: string; priceKey: string }> = [];

  for (const [gateway, tiers] of Object.entries(PROVIDER_TIERS) as [ProviderName, Record<ComplexityHint, string>][]) {
    for (const [tier, model] of Object.entries(tiers) as [ComplexityHint, string][]) {
      const priceKey = makePriceKey(gateway, model);
      if (!getModelPrice(priceKey)) {
        missing.push({ gateway, tier, model, priceKey });
      }
    }
  }

  return missing;
}
