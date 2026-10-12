/**
 * Deterministic mock AI providers for E2E integration testing.
 *
 * Each scenario factory returns a `providerFactory` function compatible with
 * AIQualifyOptions.providerFactory.  The factory is stateful per scenario so
 * it can return different confidence values on successive tier calls (escalation).
 *
 * Provider IDs use the real gateway:model format so the pricing engine computes
 * real cost_usd values — no special-casing required downstream.
 *
 * ⚠️  These providers never make real API calls.
 */
import type { AIProvider } from "../providers/types.ts";
import type { QualificationInput, QualificationResult } from "../domain/types.ts";
import type { TaskType, ComplexityHint } from "../providers/ai/model-router.ts";

// ── Provider ID constants (match pricing registry keys) ───────────────────────

const HAIKU_ID   = "anthropic-direct:claude-haiku-4-5-20251001";
const SONNET_ID  = "anthropic-direct:claude-sonnet-4-6";
const OPUS_ID    = "anthropic-direct:claude-opus-4-8";

const TIER_IDS: Record<ComplexityHint, string> = {
  low:    HAIKU_ID,
  medium: SONNET_ID,
  high:   OPUS_ID,
};

const TIER_MODELS: Record<ComplexityHint, string> = {
  low:    "claude-haiku-4-5-20251001",
  medium: "claude-sonnet-4-6",
  high:   "claude-opus-4-8",
};

const TIER_TOKENS: Record<ComplexityHint, { input: number; output: number }> = {
  low:    { input: 340,  output: 110 },
  medium: { input: 520,  output: 180 },
  high:   { input: 780,  output: 260 },
};

// ── Builder helpers ───────────────────────────────────────────────────────────

function makeResult(
  tier: ComplexityHint,
  confidence: number,
  icpFit: boolean,
  score: number,
  reason: string,
): QualificationResult {
  const tokens = TIER_TOKENS[tier];
  return {
    icpFit,
    score,
    confidence,
    industryMatch: icpFit,
    sizeMatch: icpFit,
    locationMatch: true,
    reason: `[TEST] ${reason} (tier=${tier}, confidence=${confidence})`,
    signals: [`[TEST] mock-signal-${tier}`],
    model: TIER_MODELS[tier],
    qualifiedAt: new Date().toISOString(),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  };
}

function makeProvider(tier: ComplexityHint, result: QualificationResult): AIProvider {
  return {
    id: TIER_IDS[tier],
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput) => result,
  };
}

// ── Scenario factory type ─────────────────────────────────────────────────────

export type ProviderFactory = (taskType: TaskType, tier: ComplexityHint) => AIProvider;

// ── Per-scenario provider factories ──────────────────────────────────────────

/**
 * Scenario 1: Clear ICP fit.
 * Single low-tier call → confidence=0.92 (above 0.75 threshold) → accepted.
 */
function scenario1(): ProviderFactory {
  return (_taskType, tier) =>
    makeProvider(tier, makeResult(tier, 0.92, true, 88, "Strong ICP fit: B2B SaaS in GTM space"));
}

/**
 * Scenario 2: Clear non-ICP.
 * Single low-tier call → confidence=0.90, icpFit=false → accepted.
 */
function scenario2(): ProviderFactory {
  return (_taskType, tier) =>
    makeProvider(tier, makeResult(tier, 0.90, false, 12, "Not ICP: construction, no sales tech"));
}

/**
 * Scenario 3: Borderline ICP.
 * Single low-tier call → confidence=0.77 (barely above 0.75) → accepted.
 */
function scenario3(): ProviderFactory {
  return (_taskType, tier) =>
    makeProvider(tier, makeResult(tier, 0.77, true, 65, "Borderline fit: analytics with weak outbound signals"));
}

/**
 * Scenario 4: LOW → MEDIUM escalation.
 * low=0.60 (below 0.75) → escalate → medium=0.85 → accepted.
 */
function scenario4(): ProviderFactory {
  const RESPONSES: Partial<Record<ComplexityHint, QualificationResult>> = {
    low:    makeResult("low",    0.60, true, 60, "Low confidence: e-commerce SaaS, ambiguous ICP signals"),
    medium: makeResult("medium", 0.85, true, 78, "Medium confirmed: e-commerce SaaS qualifies after deeper review"),
  };
  return (_taskType, tier) =>
    makeProvider(tier, RESPONSES[tier] ?? makeResult(tier, 0.85, true, 78, "Fallback"));
}

/**
 * Scenario 5: LOW → MEDIUM (second instance, different confidence curve).
 * low=0.55 → medium=0.82 → accepted.
 */
function scenario5(): ProviderFactory {
  const RESPONSES: Partial<Record<ComplexityHint, QualificationResult>> = {
    low:    makeResult("low",    0.55, true, 55, "Low confidence: martech SaaS with outbound motion unclear"),
    medium: makeResult("medium", 0.82, true, 75, "Medium confirmed: martech qualifies with B2B email automation"),
  };
  return (_taskType, tier) =>
    makeProvider(tier, RESPONSES[tier] ?? makeResult(tier, 0.82, true, 75, "Fallback"));
}

/**
 * Scenario 6: LOW → MEDIUM → HIGH (3-tier full escalation).
 * low=0.40, medium=0.50 (both below 0.75) → high=0.91 (maxTier, always accepted).
 */
function scenario6(): ProviderFactory {
  const RESPONSES: Partial<Record<ComplexityHint, QualificationResult>> = {
    low:    makeResult("low",    0.40, true, 40, "Low confidence: large enterprise, signals mixed"),
    medium: makeResult("medium", 0.50, true, 52, "Medium confidence: still ambiguous, escalate to high"),
    high:   makeResult("high",   0.91, true, 84, "High confidence: enterprise SaaS with US expansion confirmed"),
  };
  return (_taskType, tier) =>
    makeProvider(tier, RESPONSES[tier] ?? makeResult(tier, 0.91, true, 84, "Fallback"));
}

/**
 * Scenario 7: Provider failure.
 * All tiers throw a deterministic error.
 */
function scenario7(): ProviderFactory {
  return (_taskType, tier) => ({
    id: TIER_IDS[tier],
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput): Promise<QualificationResult> => {
      throw new Error("[TEST] Simulated provider failure: connection timeout after 30000ms");
    },
  });
}

/**
 * Scenario 8: Normal single-tier provider (for retry-after-checkpoint test).
 * The task runner handles the checkpoint logic; the provider just returns a result.
 */
function scenario8(): ProviderFactory {
  return (_taskType, tier) =>
    makeProvider(tier, makeResult(tier, 0.88, true, 82, "DevOps SaaS: strong GTM signals, CI/CD market fit"));
}

/**
 * Scenario 9: Duplicate submission — same provider as scenario 1.
 * Provider only runs on the first submission; second returns cached output.
 */
function scenario9(): ProviderFactory {
  return (_taskType, tier) =>
    makeProvider(tier, makeResult(tier, 0.92, true, 88, "Sales enablement SaaS: clear ICP fit"));
}

/**
 * Scenario 10: Multi-client — same provider used by both clients.
 * Each client gets their own job with their own enrichment run rows.
 */
function scenario10(): ProviderFactory {
  return (_taskType, tier) =>
    makeProvider(tier, makeResult(tier, 0.89, true, 85, "Revenue intelligence: strong B2B SaaS fit"));
}

// ── Public registry ───────────────────────────────────────────────────────────

const SCENARIO_FACTORIES: Record<number, () => ProviderFactory> = {
  1:  scenario1,
  2:  scenario2,
  3:  scenario3,
  4:  scenario4,
  5:  scenario5,
  6:  scenario6,
  7:  scenario7,
  8:  scenario8,
  9:  scenario9,
  10: scenario10,
};

/**
 * Returns a fresh providerFactory for the given scenario.
 * Call once per test run — factories may be stateful.
 */
export function createProviderFactory(scenarioId: number): ProviderFactory {
  const factory = SCENARIO_FACTORIES[scenarioId];
  if (!factory) throw new Error(`No provider factory for scenario ${scenarioId}`);
  return factory();
}
