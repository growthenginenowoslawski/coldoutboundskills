/**
 * Offline tests for EscalationRouter (Stage 4).
 *
 * No real API calls. All providers are injected mocks via _testOpts.providerFactory.
 * Covers:
 *   - No escalation (confidence above threshold)
 *   - Single escalation (low → medium)
 *   - Multiple escalations (low → medium → high)
 *   - Max tier reached without meeting threshold
 *   - Invalid confidence values (NaN, Infinity, out-of-range, missing)
 *   - Invalid confidence forces escalation to maxTier
 *   - Provider fallback (factory returns a fallback-labelled provider)
 *   - Token / cost tracking across attempts
 *   - Escalation history structure and ordering
 *   - startTier > maxTier config error
 *   - Single-tier config (startTier === maxTier)
 *   - ESCALATION_DEFAULTS shape validation
 *   - qualifyWithDefaults convenience wrapper
 *   - escalated flag correctness
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EscalationRouter,
  ESCALATION_DEFAULTS,
  type EscalationConfig,
  type EscalationAttempt,
} from "../providers/ai/escalation-router";
import type { TaskType, ComplexityHint } from "../providers/ai/model-router";
import type { AIProvider } from "../providers/types";
import type { QualificationInput, QualificationResult } from "../domain/types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal QualificationInput — content doesn't matter for these tests. */
const DUMMY_INPUT: QualificationInput = {
  company: {
    name: "Acme Ltd",
    domain: "acme.com",
    source: "test",
    fetchedAt: new Date().toISOString(),
  },
  icp: { industry: "SaaS", location: "UK" },
};

/** Build a mock AIProvider that always returns a fixed QualificationResult. */
function mockProvider(opts: {
  id: string;
  confidence: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
}): AIProvider {
  const result: QualificationResult = {
    icpFit: opts.confidence >= 0.5,
    score: Math.round(opts.confidence * 100),
    industryMatch: true,
    sizeMatch: true,
    locationMatch: true,
    reason: `Mock result — confidence ${opts.confidence}`,
    signals: [],
    confidence: opts.confidence,
    model: opts.model ?? opts.id,
    qualifiedAt: new Date().toISOString(),
    inputTokens: opts.inputTokens ?? 100,
    outputTokens: opts.outputTokens ?? 50,
  };
  return {
    id: opts.id,
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput) => ({ ...result }),
  };
}

/**
 * Build a mock provider that returns a specific raw confidence value
 * including intentionally invalid ones (NaN, Infinity, negative, > 1).
 */
function mockProviderRaw(id: string, rawConfidence: unknown, inputTokens = 100, outputTokens = 50): AIProvider {
  return {
    id,
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput): Promise<QualificationResult> => ({
      icpFit: true,
      score: 50,
      industryMatch: true,
      sizeMatch: true,
      locationMatch: true,
      reason: "Mock",
      signals: [],
      confidence: rawConfidence as number,
      model: id,
      qualifiedAt: new Date().toISOString(),
      inputTokens,
      outputTokens,
    }),
  };
}

/** Standard config for icp_qualification used across many tests. */
const BASE_CONFIG: EscalationConfig = {
  taskType: "icp_qualification",
  startTier: "low",
  confidenceThreshold: 0.75,
  maxTier: "high",
};

/** Build a tier-keyed factory from a map of tier → mock provider. */
function tierFactory(
  map: Partial<Record<ComplexityHint, AIProvider>>,
  fallback?: AIProvider,
): (_taskType: TaskType, tier: ComplexityHint) => AIProvider {
  return (_taskType: TaskType, tier: ComplexityHint) => {
    const p = map[tier] ?? fallback;
    if (!p) throw new Error(`tierFactory: no provider registered for tier "${tier}"`);
    return p;
  };
}

// ── ESCALATION_DEFAULTS shape ────────────────────────────────────────────────

test("ESCALATION_DEFAULTS: every TaskType has an entry", () => {
  const taskTypes: TaskType[] = [
    "icp_qualification",
    "icp_prefilter",
    "personalization",
    "reply_classify",
    "text_normalize",
    "campaign_strategy",
  ];
  for (const t of taskTypes) {
    assert.ok(ESCALATION_DEFAULTS[t], `Missing default for task "${t}"`);
  }
});

test("ESCALATION_DEFAULTS: each entry has valid tier ordering", () => {
  const TIER_ORDER: ComplexityHint[] = ["low", "medium", "high"];
  for (const [taskType, cfg] of Object.entries(ESCALATION_DEFAULTS) as [TaskType, EscalationConfig][]) {
    const startIdx = TIER_ORDER.indexOf(cfg.startTier);
    const maxIdx = TIER_ORDER.indexOf(cfg.maxTier);
    assert.ok(startIdx >= 0, `${taskType}: unknown startTier "${cfg.startTier}"`);
    assert.ok(maxIdx >= 0, `${taskType}: unknown maxTier "${cfg.maxTier}"`);
    assert.ok(startIdx <= maxIdx,
      `${taskType}: startTier "${cfg.startTier}" should not be above maxTier "${cfg.maxTier}"`);
  }
});

test("ESCALATION_DEFAULTS: thresholds are in [0, 1]", () => {
  for (const [taskType, cfg] of Object.entries(ESCALATION_DEFAULTS) as [TaskType, EscalationConfig][]) {
    assert.ok(
      cfg.confidenceThreshold >= 0 && cfg.confidenceThreshold <= 1,
      `${taskType}: threshold ${cfg.confidenceThreshold} should be in [0, 1]`,
    );
  }
});

test("ESCALATION_DEFAULTS: icp_qualification starts low, allows up to high", () => {
  const cfg = ESCALATION_DEFAULTS["icp_qualification"];
  assert.equal(cfg.startTier, "low");
  assert.equal(cfg.maxTier, "high");
});

test("ESCALATION_DEFAULTS: text_normalize is capped at low (never escalates)", () => {
  const cfg = ESCALATION_DEFAULTS["text_normalize"];
  assert.equal(cfg.startTier, "low");
  assert.equal(cfg.maxTier, "low");
});

// ── No escalation ─────────────────────────────────────────────────────────────

test("no escalation: high confidence at first tier stops immediately", async () => {
  const lowProvider = mockProvider({ id: "mock-low", confidence: 0.90, inputTokens: 100, outputTokens: 50 });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: tierFactory({ low: lowProvider }),
  });

  assert.equal(result.attempts.length, 1, "Should make exactly one attempt");
  assert.equal(result.finalTier, "low");
  assert.equal(result.escalated, false);
  assert.equal(result.attempts[0].escalated, false);
  assert.equal(result.attempts[0].confidence, 0.90);
});

test("no escalation: exact threshold confidence stops immediately", async () => {
  const lowProvider = mockProvider({ id: "mock-low", confidence: 0.75 });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: tierFactory({ low: lowProvider }),
  });

  assert.equal(result.attempts.length, 1);
  assert.equal(result.finalTier, "low");
  assert.equal(result.escalated, false);
});

test("no escalation: escalated flag is false with single attempt", async () => {
  const lowProvider = mockProvider({ id: "mock-low", confidence: 0.95 });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: tierFactory({ low: lowProvider }),
  });
  assert.equal(result.escalated, false);
  assert.equal(result.finalProviderId, "mock-low");
});

// ── Single escalation ────────────────────────────────────────────────────────

test("one escalation: low confidence at low tier escalates to medium", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.60 }),
    medium: mockProvider({ id: "mock-medium", confidence: 0.85 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].tier, "low");
  assert.equal(result.attempts[0].escalated, true);
  assert.equal(result.attempts[1].tier, "medium");
  assert.equal(result.attempts[1].escalated, false);
  assert.equal(result.finalTier, "medium");
  assert.equal(result.escalated, true);
});

test("one escalation: finalProviderId matches the medium tier provider", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "haiku-provider", confidence: 0.50 }),
    medium: mockProvider({ id: "sonnet-provider", confidence: 0.90 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.finalProviderId, "sonnet-provider");
  assert.equal(result.finalTier, "medium");
});

test("one escalation: result returned is from the escalated tier", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.50 }),
    medium: mockProvider({ id: "mock-medium", confidence: 0.88 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  // The returned result should be from medium (confidence 0.88)
  assert.ok(result.result.confidence !== undefined);
  assert.ok((result.result.confidence as number) >= 0.8);
});

// ── Multiple escalations ─────────────────────────────────────────────────────

test("multiple escalations: low → medium → high", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.40 }),
    medium: mockProvider({ id: "mock-medium", confidence: 0.55 }),
    high: mockProvider({ id: "mock-high", confidence: 0.92 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts.length, 3);
  assert.equal(result.attempts[0].tier, "low");
  assert.equal(result.attempts[0].escalated, true);
  assert.equal(result.attempts[1].tier, "medium");
  assert.equal(result.attempts[1].escalated, true);
  assert.equal(result.attempts[2].tier, "high");
  assert.equal(result.attempts[2].escalated, false);
  assert.equal(result.finalTier, "high");
  assert.equal(result.escalated, true);
});

test("multiple escalations: attempts are in tier order", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "low", confidence: 0.30 }),
    medium: mockProvider({ id: "mid", confidence: 0.50 }),
    high: mockProvider({ id: "high", confidence: 0.95 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  const tiers = result.attempts.map((a: EscalationAttempt) => a.tier);
  assert.deepEqual(tiers, ["low", "medium", "high"]);
});

// ── Max tier reached ──────────────────────────────────────────────────────────

test("max tier reached: result accepted even when confidence below threshold", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.40 }),
    medium: mockProvider({ id: "mock-medium", confidence: 0.50 }),
    high: mockProvider({ id: "mock-high", confidence: 0.60 }),  // still below 0.75
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.finalTier, "high");
  assert.equal(result.attempts.length, 3);
  // Final attempt is NOT marked escalated even though confidence was below threshold
  assert.equal(result.attempts[2].escalated, false);
  assert.equal(result.escalated, true);
});

test("max tier reached: all attempt.escalated flags are correct", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.30 }),
    medium: mockProvider({ id: "mock-medium", confidence: 0.40 }),
    high: mockProvider({ id: "mock-high", confidence: 0.50 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].escalated, true);    // low → escalated
  assert.equal(result.attempts[1].escalated, true);    // medium → escalated
  assert.equal(result.attempts[2].escalated, false);   // high → accepted (maxTier)
});

test("maxTier=low: single attempt even when confidence is below threshold", async () => {
  const cfg: EscalationConfig = {
    taskType: "text_normalize",
    startTier: "low",
    confidenceThreshold: 0.90,
    maxTier: "low",
  };
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.50 }),  // below threshold
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, cfg, {
    providerFactory: factory,
  });

  assert.equal(result.attempts.length, 1);
  assert.equal(result.finalTier, "low");
  assert.equal(result.escalated, false);
  assert.equal(result.attempts[0].escalated, false);
});

// ── Invalid confidence ────────────────────────────────────────────────────────

test("invalid confidence NaN: recorded as null and treated as below threshold", async () => {
  const factory = tierFactory({
    low: mockProviderRaw("mock-low", NaN),
    medium: mockProvider({ id: "mock-medium", confidence: 0.90 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].confidence, null, "NaN should be sanitised to null");
  assert.equal(result.attempts[0].escalated, true, "null confidence should trigger escalation");
  assert.equal(result.finalTier, "medium");
});

test("invalid confidence Infinity: recorded as null, escalation continues", async () => {
  const factory = tierFactory({
    low: mockProviderRaw("mock-low", Infinity),
    medium: mockProvider({ id: "mock-medium", confidence: 0.80 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].confidence, null);
  assert.equal(result.attempts[0].escalated, true);
  assert.equal(result.finalTier, "medium");
});

test("invalid confidence negative: recorded as null, escalation continues", async () => {
  const factory = tierFactory({
    low: mockProviderRaw("mock-low", -0.1),
    medium: mockProvider({ id: "mock-medium", confidence: 0.85 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].confidence, null);
  assert.equal(result.attempts[0].escalated, true);
});

test("invalid confidence > 1: recorded as null, escalation continues", async () => {
  const factory = tierFactory({
    low: mockProviderRaw("mock-low", 1.01),
    medium: mockProvider({ id: "mock-medium", confidence: 0.80 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].confidence, null);
  assert.equal(result.attempts[0].escalated, true);
});

test("invalid confidence at maxTier: result accepted regardless", async () => {
  const cfg: EscalationConfig = {
    taskType: "icp_qualification",
    startTier: "high",   // only one tier available
    confidenceThreshold: 0.75,
    maxTier: "high",
  };
  const factory = tierFactory({
    high: mockProviderRaw("mock-high", NaN, 500, 200),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, cfg, {
    providerFactory: factory,
  });

  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].confidence, null);
  assert.equal(result.attempts[0].escalated, false);  // maxTier — no escalation possible
  assert.equal(result.escalated, false);
});

test("all-invalid confidence chain escalates to maxTier and accepts", async () => {
  const factory = tierFactory({
    low: mockProviderRaw("mock-low", NaN),
    medium: mockProviderRaw("mock-medium", Infinity),
    high: mockProviderRaw("mock-high", -1),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts.length, 3);
  for (const attempt of result.attempts.slice(0, 2)) {
    assert.equal(attempt.confidence, null);
    assert.equal(attempt.escalated, true);
  }
  // Final attempt at high: null confidence, but maxTier — accepted
  assert.equal(result.attempts[2].confidence, null);
  assert.equal(result.attempts[2].escalated, false);
  assert.equal(result.finalTier, "high");
});

// ── Provider fallback ─────────────────────────────────────────────────────────

test("provider fallback: factory can return a fallback-labelled provider", async () => {
  // Simulates: primary (anthropic-direct) not configured → factory returns openrouter fallback
  const factory = tierFactory({
    low: mockProvider({ id: "openrouter:anthropic/claude-haiku-4-5-20251001", confidence: 0.95 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].providerId, "openrouter:anthropic/claude-haiku-4-5-20251001");
  assert.equal(result.finalProviderId, "openrouter:anthropic/claude-haiku-4-5-20251001");
  assert.equal(result.escalated, false);
});

test("provider fallback: different providers per tier are recorded correctly", async () => {
  // Primary for low is openrouter (Anthropic direct not configured)
  // For high, primary is anthropic-direct (key added mid-run, or a separate flow)
  const factory = tierFactory({
    low: mockProvider({ id: "openrouter:haiku", confidence: 0.40 }),
    medium: mockProvider({ id: "openrouter:sonnet", confidence: 0.50 }),
    high: mockProvider({ id: "anthropic-direct:opus", confidence: 0.90 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].providerId, "openrouter:haiku");
  assert.equal(result.attempts[1].providerId, "openrouter:sonnet");
  assert.equal(result.attempts[2].providerId, "anthropic-direct:opus");
  assert.equal(result.finalProviderId, "anthropic-direct:opus");
});

// ── Token / cost tracking ─────────────────────────────────────────────────────

test("token tracking: no escalation — only one attempt's tokens counted", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.90, inputTokens: 200, outputTokens: 80 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.totalInputTokens, 200);
  assert.equal(result.totalOutputTokens, 80);
  assert.equal(result.attempts[0].inputTokens, 200);
  assert.equal(result.attempts[0].outputTokens, 80);
});

test("token tracking: one escalation — tokens summed across both attempts", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.50, inputTokens: 150, outputTokens: 60 }),
    medium: mockProvider({ id: "mock-medium", confidence: 0.90, inputTokens: 400, outputTokens: 120 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.totalInputTokens, 150 + 400, "input tokens should be summed");
  assert.equal(result.totalOutputTokens, 60 + 120, "output tokens should be summed");
});

test("token tracking: full escalation — all three attempts' tokens summed", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "low", confidence: 0.30, inputTokens: 100, outputTokens: 40 }),
    medium: mockProvider({ id: "mid", confidence: 0.50, inputTokens: 300, outputTokens: 80 }),
    high: mockProvider({ id: "high", confidence: 0.92, inputTokens: 800, outputTokens: 200 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.totalInputTokens, 100 + 300 + 800);
  assert.equal(result.totalOutputTokens, 40 + 80 + 200);
});

test("token tracking: each attempt records its own tokens independently", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "low", confidence: 0.40, inputTokens: 111, outputTokens: 22 }),
    medium: mockProvider({ id: "mid", confidence: 0.45, inputTokens: 333, outputTokens: 66 }),
    high: mockProvider({ id: "high", confidence: 0.95, inputTokens: 777, outputTokens: 111 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].inputTokens, 111);
  assert.equal(result.attempts[0].outputTokens, 22);
  assert.equal(result.attempts[1].inputTokens, 333);
  assert.equal(result.attempts[1].outputTokens, 66);
  assert.equal(result.attempts[2].inputTokens, 777);
  assert.equal(result.attempts[2].outputTokens, 111);
});

test("token tracking: provider with no token info defaults to 0", async () => {
  // Provider returns result without inputTokens/outputTokens set
  const noTokenProvider: AIProvider = {
    id: "no-token-provider",
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (): Promise<QualificationResult> => ({
      icpFit: true,
      score: 80,
      industryMatch: true,
      sizeMatch: true,
      locationMatch: true,
      reason: "Mock",
      signals: [],
      confidence: 0.95,
      model: "mock",
      qualifiedAt: new Date().toISOString(),
      // inputTokens and outputTokens intentionally omitted
    }),
  };
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: () => noTokenProvider,
  });

  assert.equal(result.totalInputTokens, 0);
  assert.equal(result.totalOutputTokens, 0);
  assert.equal(result.attempts[0].inputTokens, 0);
  assert.equal(result.attempts[0].outputTokens, 0);
});

// ── Escalation history ────────────────────────────────────────────────────────

test("escalation history: attempt contains all required fields", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "haiku-provider", confidence: 0.60, inputTokens: 200, outputTokens: 80, model: "claude-haiku-4-5" }),
    medium: mockProvider({ id: "sonnet-provider", confidence: 0.88, inputTokens: 400, outputTokens: 120, model: "claude-sonnet-4-6" }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  const attempt = result.attempts[0];
  assert.ok("tier" in attempt);
  assert.ok("providerId" in attempt);
  assert.ok("model" in attempt);
  assert.ok("confidence" in attempt);
  assert.ok("inputTokens" in attempt);
  assert.ok("outputTokens" in attempt);
  assert.ok("escalated" in attempt);
});

test("escalation history: providerId and model are recorded from provider response", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "haiku-provider", confidence: 0.55, model: "claude-haiku-4-5-20251001" }),
    medium: mockProvider({ id: "sonnet-provider", confidence: 0.92, model: "claude-sonnet-4-6" }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.attempts[0].providerId, "haiku-provider");
  assert.equal(result.attempts[0].model, "claude-haiku-4-5-20251001");
  assert.equal(result.attempts[1].providerId, "sonnet-provider");
  assert.equal(result.attempts[1].model, "claude-sonnet-4-6");
});

test("escalation history: only last attempt has escalated=false", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "low", confidence: 0.30 }),
    medium: mockProvider({ id: "mid", confidence: 0.50 }),
    high: mockProvider({ id: "high", confidence: 0.95 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  for (let i = 0; i < result.attempts.length - 1; i++) {
    assert.equal(result.attempts[i].escalated, true,
      `Attempt ${i} should be marked escalated`);
  }
  assert.equal(result.attempts.at(-1)?.escalated, false, "Last attempt should not be escalated");
});

// ── Config validation ─────────────────────────────────────────────────────────

test("config error: startTier above maxTier throws", async () => {
  const badConfig: EscalationConfig = {
    taskType: "icp_qualification",
    startTier: "high",
    confidenceThreshold: 0.75,
    maxTier: "low",
  };
  await assert.rejects(
    () => EscalationRouter.qualify(DUMMY_INPUT, badConfig, {
      providerFactory: tierFactory({ high: mockProvider({ id: "x", confidence: 0.9 }) }),
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /startTier.*above.*maxTier/i);
      return true;
    },
  );
});

test("config: single tier (startTier === maxTier) makes one call", async () => {
  const singleTierConfig: EscalationConfig = {
    taskType: "icp_qualification",
    startTier: "medium",
    confidenceThreshold: 0.75,
    maxTier: "medium",
  };
  const factory = tierFactory({
    medium: mockProvider({ id: "mock-medium", confidence: 0.50 }),  // below threshold
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, singleTierConfig, {
    providerFactory: factory,
  });

  assert.equal(result.attempts.length, 1);
  assert.equal(result.finalTier, "medium");
  assert.equal(result.escalated, false);
});

test("config: startTier=medium skips low tier entirely", async () => {
  const cfg: EscalationConfig = {
    taskType: "campaign_strategy",
    startTier: "medium",
    confidenceThreshold: 0.80,
    maxTier: "high",
  };
  const tiersUsed: ComplexityHint[] = [];
  const factory = (_taskType: TaskType, tier: ComplexityHint) => {
    tiersUsed.push(tier);
    if (tier === "medium") return mockProvider({ id: "sonnet", confidence: 0.90 });
    return mockProvider({ id: "opus", confidence: 0.95 });
  };
  const result = await EscalationRouter.qualify(DUMMY_INPUT, cfg, {
    providerFactory: factory,
  });

  assert.ok(!tiersUsed.includes("low"), "low tier should never be called");
  assert.equal(result.finalTier, "medium");
  assert.equal(result.attempts.length, 1);
});

// ── qualifyWithDefaults ───────────────────────────────────────────────────────

test("qualifyWithDefaults: uses ESCALATION_DEFAULTS for the task type", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.95 }),
  });
  const result = await EscalationRouter.qualifyWithDefaults(
    DUMMY_INPUT,
    "icp_qualification",
    {},
    { providerFactory: factory },
  );

  assert.equal(result.finalTier, "low");
  assert.equal(result.escalated, false);
});

test("qualifyWithDefaults: override confidenceThreshold is respected", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.80 }),       // meets 0.75 default
    medium: mockProvider({ id: "mock-medium", confidence: 0.92 }), // but not raised 0.85
  });

  // Default threshold is 0.75 — low would pass. Raise it to 0.85 so it escalates.
  const result = await EscalationRouter.qualifyWithDefaults(
    DUMMY_INPUT,
    "icp_qualification",
    { confidenceThreshold: 0.85 },
    { providerFactory: factory },
  );

  assert.equal(result.attempts.length, 2, "Should have escalated with raised threshold");
  assert.equal(result.finalTier, "medium");
  assert.equal(result.escalated, true);
});

test("qualifyWithDefaults: override maxTier caps escalation", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.30 }),
    medium: mockProvider({ id: "mock-medium", confidence: 0.50 }),  // still below 0.75
    // high would be next but we cap at medium
  });

  const result = await EscalationRouter.qualifyWithDefaults(
    DUMMY_INPUT,
    "icp_qualification",
    { maxTier: "medium" },
    { providerFactory: factory },
  );

  assert.equal(result.finalTier, "medium");
  assert.equal(result.attempts.length, 2);
  // Should never have called high
  assert.ok(!result.attempts.some((a: EscalationAttempt) => a.tier === "high"));
});

test("qualifyWithDefaults: override startTier skips lower tiers", async () => {
  const tiersUsed: ComplexityHint[] = [];
  const factory = (_taskType: TaskType, tier: ComplexityHint) => {
    tiersUsed.push(tier);
    return mockProvider({ id: `mock-${tier}`, confidence: 0.95 });
  };

  await EscalationRouter.qualifyWithDefaults(
    DUMMY_INPUT,
    "icp_qualification",
    { startTier: "high" },
    { providerFactory: factory },
  );

  assert.ok(!tiersUsed.includes("low"));
  assert.ok(!tiersUsed.includes("medium"));
  assert.ok(tiersUsed.includes("high"));
});

// ── EscalationResult shape ────────────────────────────────────────────────────

test("EscalationResult: all required fields are present", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "mock-low", confidence: 0.90 }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.ok("result" in result);
  assert.ok("attempts" in result);
  assert.ok("totalInputTokens" in result);
  assert.ok("totalOutputTokens" in result);
  assert.ok("finalTier" in result);
  assert.ok("finalProviderId" in result);
  assert.ok("escalated" in result);
  assert.ok(Array.isArray(result.attempts));
});

test("EscalationResult: final result.model matches the last attempt's model", async () => {
  const factory = tierFactory({
    low: mockProvider({ id: "low", confidence: 0.40, model: "haiku" }),
    medium: mockProvider({ id: "mid", confidence: 0.50, model: "sonnet" }),
    high: mockProvider({ id: "high", confidence: 0.92, model: "opus" }),
  });
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: factory,
  });

  assert.equal(result.result.model, "opus");
  assert.equal(result.attempts.at(-1)?.model, "opus");
});
