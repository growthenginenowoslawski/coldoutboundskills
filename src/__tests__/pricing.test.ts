/**
 * Comprehensive offline tests for the AI pricing engine (pricing.ts) and
 * its integration with the qualification row-builders (qualifications.ts).
 *
 * No API calls, no database, no environment variables needed.
 *
 * Coverage:
 *   Registry shape      — all 6 entries present, correct types, positive prices
 *   makePriceKey        — format output
 *   getModelPrice       — known / unknown keys
 *   estimateCost        — correct math per model, zero tokens, edge cases
 *   findUnpricedTiers   — registry completeness vs. PROVIDER_TIERS
 *   Cost auto-compute   — buildQualificationRow wires pricing correctly
 *   Explicit override   — explicit costUsd beats auto-compute
 *   Per-attempt cost    — buildEscalationAttemptRow per-attempt auto-compute
 *   Edge cases          — negative tokens, NaN, Infinity, missing gateway
 *   Numeric precision   — large token counts, small cost values
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_PRICING,
  makePriceKey,
  getModelPrice,
  estimateCost,
  findUnpricedTiers,
  type CostEstimate,
  type ModelPrice,
} from "../providers/ai/pricing";

import { PROVIDER_TIERS } from "../providers/ai/model-router";
import { buildQualificationRow, buildEscalationAttemptRow } from "../db/qualifications";
import type { QualificationInput, QualificationResult } from "../domain/types";
import type { EscalationAttempt } from "../providers/ai/escalation-router";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const STARTED_AT = "2026-08-26T10:00:00.000Z";

const DUMMY_INPUT: QualificationInput = {
  company: {
    name: "Acme Ltd",
    domain: "acme.com",
    source: "test",
    fetchedAt: STARTED_AT,
  },
  icp: { industry: "SaaS" },
};

function makeResult(overrides: Partial<QualificationResult> = {}): QualificationResult {
  return {
    icpFit: true,
    score: 80,
    industryMatch: true,
    sizeMatch: true,
    locationMatch: true,
    reason: "Test",
    signals: [],
    confidence: 0.85,
    model: "claude-haiku-4-5-20251001",
    qualifiedAt: "2026-08-26T10:00:01.000Z",
    inputTokens: 1000,
    outputTokens: 500,
    ...overrides,
  };
}

// ── Registry shape ─────────────────────────────────────────────────────────────

test("registry: MODEL_PRICING is exported and is a plain object", () => {
  assert.ok(MODEL_PRICING && typeof MODEL_PRICING === "object");
});

test("registry: contains at least 6 entries (3 models × 2 gateways, plus dot-notation aliases)", () => {
  assert.ok(Object.keys(MODEL_PRICING).length >= 6);
});

test("registry: all entries have positive inputPer1M", () => {
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    assert.ok(price.inputPer1M > 0, `${key}: inputPer1M must be positive`);
  }
});

test("registry: all entries have positive outputPer1M", () => {
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    assert.ok(price.outputPer1M > 0, `${key}: outputPer1M must be positive`);
  }
});

test("registry: output price >= input price for every entry (output tokens cost more)", () => {
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    assert.ok(
      price.outputPer1M >= price.inputPer1M,
      `${key}: outputPer1M (${price.outputPer1M}) should be >= inputPer1M (${price.inputPer1M})`,
    );
  }
});

test("registry: all entries have a non-empty label", () => {
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    assert.ok(price.label && price.label.length > 0, `${key}: label must be non-empty`);
  }
});

test("registry: anthropic-direct:claude-haiku-4-5-20251001 is present", () => {
  assert.ok(MODEL_PRICING["anthropic-direct:claude-haiku-4-5-20251001"]);
});

test("registry: anthropic-direct:claude-sonnet-4-6 is present", () => {
  assert.ok(MODEL_PRICING["anthropic-direct:claude-sonnet-4-6"]);
});

test("registry: anthropic-direct:claude-opus-4-8 is present", () => {
  assert.ok(MODEL_PRICING["anthropic-direct:claude-opus-4-8"]);
});

test("registry: openrouter:anthropic/claude-haiku-4.5 is present", () => {
  assert.ok(MODEL_PRICING["openrouter:anthropic/claude-haiku-4.5"]);
});

test("registry: openrouter:anthropic/claude-sonnet-4-6 is present", () => {
  assert.ok(MODEL_PRICING["openrouter:anthropic/claude-sonnet-4-6"]);
});

test("registry: openrouter:anthropic/claude-opus-4-8 is present", () => {
  assert.ok(MODEL_PRICING["openrouter:anthropic/claude-opus-4-8"]);
});

test("registry: Opus is more expensive than Sonnet (anthropic-direct)", () => {
  const sonnet = MODEL_PRICING["anthropic-direct:claude-sonnet-4-6"];
  const opus = MODEL_PRICING["anthropic-direct:claude-opus-4-8"];
  assert.ok(opus.inputPer1M > sonnet.inputPer1M, "Opus input should cost more than Sonnet");
  assert.ok(opus.outputPer1M > sonnet.outputPer1M, "Opus output should cost more than Sonnet");
});

test("registry: Sonnet is more expensive than Haiku (anthropic-direct)", () => {
  const haiku = MODEL_PRICING["anthropic-direct:claude-haiku-4-5-20251001"];
  const sonnet = MODEL_PRICING["anthropic-direct:claude-sonnet-4-6"];
  assert.ok(sonnet.inputPer1M > haiku.inputPer1M, "Sonnet input should cost more than Haiku");
  assert.ok(sonnet.outputPer1M > haiku.outputPer1M, "Sonnet output should cost more than Haiku");
});

// ── makePriceKey ───────────────────────────────────────────────────────────────

test("makePriceKey: joins gateway and model with colon", () => {
  assert.equal(makePriceKey("anthropic-direct", "claude-opus-4-8"), "anthropic-direct:claude-opus-4-8");
});

test("makePriceKey: works for openrouter model format", () => {
  assert.equal(
    makePriceKey("openrouter", "anthropic/claude-sonnet-4-6"),
    "openrouter:anthropic/claude-sonnet-4-6",
  );
});

test("makePriceKey: result matches the registry key for every PROVIDER_TIERS entry", () => {
  for (const [gateway, tiers] of Object.entries(PROVIDER_TIERS)) {
    for (const [_tier, model] of Object.entries(tiers)) {
      const key = makePriceKey(gateway, model);
      assert.ok(
        key in MODEL_PRICING,
        `makePriceKey("${gateway}", "${model}") = "${key}" not found in MODEL_PRICING`,
      );
    }
  }
});

// ── getModelPrice ─────────────────────────────────────────────────────────────

test("getModelPrice: returns entry for known key", () => {
  const price = getModelPrice("anthropic-direct:claude-opus-4-8");
  assert.ok(price !== null);
  assert.equal(typeof price!.inputPer1M, "number");
});

test("getModelPrice: returns null for unknown key", () => {
  assert.equal(getModelPrice("unknown-gateway:gpt-99"), null);
});

test("getModelPrice: returns null for empty string", () => {
  assert.equal(getModelPrice(""), null);
});

test("getModelPrice: returns null for partial key (gateway only, no model)", () => {
  assert.equal(getModelPrice("anthropic-direct"), null);
});

test("getModelPrice: returns null for inverted key format", () => {
  assert.equal(getModelPrice("claude-opus-4-8:anthropic-direct"), null);
});

// ── estimateCost — correct math ───────────────────────────────────────────────

test("estimateCost: haiku 1M input + 1M output = inputPer1M + outputPer1M", () => {
  const price = MODEL_PRICING["anthropic-direct:claude-haiku-4-5-20251001"] as ModelPrice;
  const result = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 1_000_000, 1_000_000);
  assert.ok(result !== null);
  assert.equal(result!.inputCostUsd, price.inputPer1M);
  assert.equal(result!.outputCostUsd, price.outputPer1M);
  assert.equal(result!.totalCostUsd, price.inputPer1M + price.outputPer1M);
});

test("estimateCost: haiku 1000 input + 500 output", () => {
  // price: $0.80 input / $4.00 output per 1M
  // cost = (1000/1M * 0.80) + (500/1M * 4.00) = 0.0008 + 0.002 = 0.0028
  const result = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 1_000, 500);
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.inputCostUsd - 0.0008) < 1e-10, `inputCostUsd was ${result!.inputCostUsd}`);
  assert.ok(Math.abs(result!.outputCostUsd - 0.002) < 1e-10, `outputCostUsd was ${result!.outputCostUsd}`);
  assert.ok(Math.abs(result!.totalCostUsd - 0.0028) < 1e-10, `totalCostUsd was ${result!.totalCostUsd}`);
});

test("estimateCost: sonnet 10k input + 2k output", () => {
  // $3.00 input / $15.00 output per 1M
  // = (10000/1M * 3.00) + (2000/1M * 15.00) = 0.03 + 0.03 = 0.06
  const result = estimateCost("anthropic-direct:claude-sonnet-4-6", 10_000, 2_000);
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.inputCostUsd - 0.03) < 1e-10);
  assert.ok(Math.abs(result!.outputCostUsd - 0.03) < 1e-10);
  assert.ok(Math.abs(result!.totalCostUsd - 0.06) < 1e-10);
});

test("estimateCost: opus 5k input + 1k output", () => {
  // $15.00 input / $75.00 output per 1M
  // = (5000/1M * 15.00) + (1000/1M * 75.00) = 0.075 + 0.075 = 0.15
  const result = estimateCost("anthropic-direct:claude-opus-4-8", 5_000, 1_000);
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.inputCostUsd - 0.075) < 1e-10);
  assert.ok(Math.abs(result!.outputCostUsd - 0.075) < 1e-10);
  assert.ok(Math.abs(result!.totalCostUsd - 0.15) < 1e-10);
});

test("estimateCost: openrouter haiku — same price as direct", () => {
  const direct = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 1_000, 500);
  const via = estimateCost("openrouter:anthropic/claude-haiku-4.5", 1_000, 500);
  assert.ok(direct !== null && via !== null);
  assert.equal(via!.totalCostUsd, direct!.totalCostUsd);
});

test("estimateCost: openrouter opus — same price as direct", () => {
  const direct = estimateCost("anthropic-direct:claude-opus-4-8", 8_000, 2_000);
  const via = estimateCost("openrouter:anthropic/claude-opus-4-8", 8_000, 2_000);
  assert.ok(direct !== null && via !== null);
  assert.equal(via!.totalCostUsd, direct!.totalCostUsd);
});

test("estimateCost: priceKey is echoed in the result", () => {
  const key = "anthropic-direct:claude-sonnet-4-6";
  const result = estimateCost(key, 1_000, 500);
  assert.equal(result!.priceKey, key);
});

test("estimateCost: inputCostUsd + outputCostUsd === totalCostUsd (float-exact)", () => {
  const result = estimateCost("anthropic-direct:claude-opus-4-8", 123_456, 78_901);
  assert.ok(result !== null);
  assert.equal(result!.totalCostUsd, result!.inputCostUsd + result!.outputCostUsd);
});

// ── estimateCost — zero tokens ─────────────────────────────────────────────────

test("estimateCost: zero input tokens gives inputCostUsd = 0", () => {
  const result = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 0, 500);
  assert.ok(result !== null);
  assert.equal(result!.inputCostUsd, 0);
});

test("estimateCost: zero output tokens gives outputCostUsd = 0", () => {
  const result = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 500, 0);
  assert.ok(result !== null);
  assert.equal(result!.outputCostUsd, 0);
});

test("estimateCost: both zero tokens gives totalCostUsd = 0", () => {
  const result = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 0, 0);
  assert.ok(result !== null);
  assert.equal(result!.totalCostUsd, 0);
});

// ── estimateCost — edge cases ─────────────────────────────────────────────────

test("estimateCost: unknown model returns null", () => {
  assert.equal(estimateCost("anthropic-direct:gpt-4-mega", 1000, 500), null);
});

test("estimateCost: empty priceKey returns null", () => {
  assert.equal(estimateCost("", 1000, 500), null);
});

test("estimateCost: negative inputTokens returns null", () => {
  assert.equal(estimateCost("anthropic-direct:claude-opus-4-8", -1, 500), null);
});

test("estimateCost: negative outputTokens returns null", () => {
  assert.equal(estimateCost("anthropic-direct:claude-opus-4-8", 1000, -1), null);
});

test("estimateCost: NaN inputTokens returns null", () => {
  assert.equal(estimateCost("anthropic-direct:claude-opus-4-8", NaN, 500), null);
});

test("estimateCost: NaN outputTokens returns null", () => {
  assert.equal(estimateCost("anthropic-direct:claude-opus-4-8", 1000, NaN), null);
});

test("estimateCost: Infinity inputTokens returns null", () => {
  assert.equal(estimateCost("anthropic-direct:claude-opus-4-8", Infinity, 500), null);
});

test("estimateCost: Infinity outputTokens returns null", () => {
  assert.equal(estimateCost("anthropic-direct:claude-opus-4-8", 1000, Infinity), null);
});

test("estimateCost: negative-zero is treated as valid zero", () => {
  // -0 passes Number.isFinite and -0 >= 0, so the call is accepted.
  // The computed cost is -0 * price = -0. JS === treats -0 === 0 as true.
  const result = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", -0, -0);
  assert.ok(result !== null);
  assert.ok(result!.totalCostUsd === 0); // use JS === (not Object.is) so -0 passes
});

// ── estimateCost — numeric precision with large token counts ──────────────────

test("estimateCost: 100M input tokens at Haiku price = $80 input", () => {
  const result = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 100_000_000, 0);
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.inputCostUsd - 80.0) < 1e-8, `Expected ~$80, got ${result!.inputCostUsd}`);
});

test("estimateCost: 1M tokens at Opus output price = $75 output", () => {
  const result = estimateCost("anthropic-direct:claude-opus-4-8", 0, 1_000_000);
  assert.ok(result !== null);
  assert.ok(Math.abs(result!.outputCostUsd - 75.0) < 1e-8, `Expected ~$75, got ${result!.outputCostUsd}`);
});

// ── findUnpricedTiers — completeness ─────────────────────────────────────────

test("findUnpricedTiers: returns empty array when registry is complete", () => {
  const missing = findUnpricedTiers();
  assert.deepEqual(
    missing,
    [],
    `Missing pricing for: ${missing.map((m) => m.priceKey).join(", ")}`,
  );
});

test("findUnpricedTiers: covers all 6 provider×tier combinations from PROVIDER_TIERS", () => {
  let totalTiers = 0;
  for (const tiers of Object.values(PROVIDER_TIERS)) {
    totalTiers += Object.keys(tiers).length;
  }
  // 2 providers × 3 tiers = 6. If any are missing, findUnpricedTiers catches it.
  assert.equal(totalTiers, 6);
  assert.equal(findUnpricedTiers().length, 0);
});

// ── Integration: buildQualificationRow auto-computes cost_usd ─────────────────

test("buildQualificationRow: auto-computes cost_usd when gateway + tokens available", () => {
  const result = makeResult({
    model: "claude-haiku-4-5-20251001",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, result, STARTED_AT, {
    gateway: "anthropic-direct",
  });
  // Haiku: $0.80 input + $4.00 output = $4.80 per 1M each
  const expected = 0.80 + 4.00;
  assert.ok(typeof row.cost_usd === "number", "cost_usd should be a number");
  assert.ok(
    Math.abs((row.cost_usd as number) - expected) < 1e-8,
    `Expected ~${expected}, got ${row.cost_usd}`,
  );
});

test("buildQualificationRow: auto-computes Opus cost correctly", () => {
  const result = makeResult({
    model: "claude-opus-4-8",
    inputTokens: 5_000,
    outputTokens: 1_000,
  });
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, result, STARTED_AT, {
    gateway: "anthropic-direct",
  });
  // $15/1M * 5000 + $75/1M * 1000 = 0.075 + 0.075 = 0.15
  assert.ok(Math.abs((row.cost_usd as number) - 0.15) < 1e-10);
});

test("buildQualificationRow: explicit costUsd overrides auto-compute", () => {
  const result = makeResult({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, result, STARTED_AT, {
    gateway: "anthropic-direct",
    costUsd: 999.99,
  });
  assert.equal(row.cost_usd, 999.99);
});

test("buildQualificationRow: explicit costUsd of 0 is respected (not treated as absent)", () => {
  const result = makeResult({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, result, STARTED_AT, {
    gateway: "anthropic-direct",
    costUsd: 0,
  });
  assert.equal(row.cost_usd, 0);
});

test("buildQualificationRow: cost_usd is null when gateway is absent", () => {
  const result = makeResult({ inputTokens: 1_000, outputTokens: 500 });
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, result, STARTED_AT);
  assert.equal(row.cost_usd, null);
});

test("buildQualificationRow: cost_usd is null when tokens are missing", () => {
  const result = makeResult({ inputTokens: undefined, outputTokens: undefined });
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, result, STARTED_AT, {
    gateway: "anthropic-direct",
  });
  assert.equal(row.cost_usd, null);
});

test("buildQualificationRow: cost_usd is null when model not in registry", () => {
  const result = makeResult({ model: "gpt-99-turbo-ultra" });
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, result, STARTED_AT, {
    gateway: "anthropic-direct",
  });
  assert.equal(row.cost_usd, null);
});

test("buildQualificationRow: cost_usd auto-computed for openrouter model", () => {
  const result = makeResult({
    model: "anthropic/claude-sonnet-4-6",
    inputTokens: 10_000,
    outputTokens: 2_000,
  });
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, result, STARTED_AT, {
    gateway: "openrouter",
  });
  // openrouter:anthropic/claude-sonnet-4-6 → $3.00/$15.00 per 1M
  // 10k * 3/1M + 2k * 15/1M = 0.03 + 0.03 = 0.06
  assert.ok(Math.abs((row.cost_usd as number) - 0.06) < 1e-10);
});

// ── Integration: buildEscalationAttemptRow per-attempt cost ──────────────────

test("buildEscalationAttemptRow: stores pre-computed costUsd from attempt", () => {
  // The executor pre-computes cost; the row builder passes it through.
  // Haiku 1M in / 1M out: $0.80 + $4.00 = $4.80
  const attempt: EscalationAttempt = {
    tier: "low",
    providerId: "anthropic-direct:claude-haiku-4-5-20251001",
    model: "claude-haiku-4-5-20251001",
    confidence: 0.60,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    escalated: true,
    latencyMs: 0,
    costUsd: 4.80,
    priceKey: "anthropic-direct:claude-haiku-4-5-20251001",
  };
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, attempt, null, false,
    { startedAt: STARTED_AT },
  );
  assert.ok(Math.abs((row.cost_usd as number) - 4.80) < 1e-8);
});

test("buildEscalationAttemptRow: stores openrouter pre-computed cost from attempt", () => {
  // Opus via openrouter: 5k input + 1k output
  // (5000/1M * 15) + (1000/1M * 75) = 0.075 + 0.075 = 0.15
  const attempt: EscalationAttempt = {
    tier: "high",
    providerId: "openrouter:anthropic/claude-opus-4-8",
    model: "anthropic/claude-opus-4-8",
    confidence: 0.92,
    inputTokens: 5_000,
    outputTokens: 1_000,
    escalated: false,
    latencyMs: 0,
    costUsd: 0.15,
    priceKey: "openrouter:anthropic/claude-opus-4-8",
  };
  const result = makeResult({ model: "anthropic/claude-opus-4-8" });
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, attempt, result, true,
    { startedAt: STARTED_AT, completedAt: result.qualifiedAt },
  );
  assert.ok(Math.abs((row.cost_usd as number) - 0.15) < 1e-10);
});

test("buildEscalationAttemptRow: null costUsd on attempt stores null in row", () => {
  const attempt: EscalationAttempt = {
    tier: "low",
    providerId: "some-gateway:unknown-model",
    model: "unknown-model",
    confidence: 0.90,
    inputTokens: 1_000,
    outputTokens: 500,
    escalated: false,
    latencyMs: 0,
    costUsd: null,
    priceKey: null,
  };
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, attempt, null, true,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.cost_usd, null);
});

test("buildEscalationAttemptRow: each attempt in a chain carries its own pre-computed cost", () => {
  // Haiku: (200/1M * 0.80) + (80/1M * 4.00) = 0.00000016 + 0.00000032 = 0.00000048
  const haikuExpected = (200 / 1_000_000) * 0.80 + (80 / 1_000_000) * 4.00;
  // Sonnet: (500/1M * 3.00) + (150/1M * 15.00) = 0.0000015 + 0.00000225 = 0.00000375
  const sonnetExpected = (500 / 1_000_000) * 3.00 + (150 / 1_000_000) * 15.00;
  // Opus: (1200/1M * 15.00) + (400/1M * 75.00) = 0.000018 + 0.00003 = 0.000048
  const opusExpected = (1_200 / 1_000_000) * 15.00 + (400 / 1_000_000) * 75.00;

  const attempts: EscalationAttempt[] = [
    {
      tier: "low",
      providerId: "anthropic-direct:claude-haiku-4-5-20251001",
      model: "claude-haiku-4-5-20251001",
      confidence: 0.40,
      inputTokens: 200,
      outputTokens: 80,
      escalated: true,
      latencyMs: 0,
      costUsd: haikuExpected,
      priceKey: "anthropic-direct:claude-haiku-4-5-20251001",
    },
    {
      tier: "medium",
      providerId: "anthropic-direct:claude-sonnet-4-6",
      model: "claude-sonnet-4-6",
      confidence: 0.65,
      inputTokens: 500,
      outputTokens: 150,
      escalated: true,
      latencyMs: 0,
      costUsd: sonnetExpected,
      priceKey: "anthropic-direct:claude-sonnet-4-6",
    },
    {
      tier: "high",
      providerId: "anthropic-direct:claude-opus-4-8",
      model: "claude-opus-4-8",
      confidence: 0.90,
      inputTokens: 1_200,
      outputTokens: 400,
      escalated: false,
      latencyMs: 0,
      costUsd: opusExpected,
      priceKey: "anthropic-direct:claude-opus-4-8",
    },
  ];

  const finalResult = makeResult({ model: "claude-opus-4-8" });
  const rows = attempts.map((attempt, i) => {
    const isFinal = i === attempts.length - 1;
    return buildEscalationAttemptRow(
      COMPANY_ID, DUMMY_INPUT, attempt, isFinal ? finalResult : null, isFinal,
      { startedAt: STARTED_AT, completedAt: isFinal ? finalResult.qualifiedAt : undefined },
    );
  });

  assert.ok(Math.abs((rows[0].cost_usd as number) - haikuExpected) < 1e-12);
  assert.ok(Math.abs((rows[1].cost_usd as number) - sonnetExpected) < 1e-12);
  assert.ok(Math.abs((rows[2].cost_usd as number) - opusExpected) < 1e-12);
});

test("buildEscalationAttemptRow: zero costUsd stored correctly (not null)", () => {
  // Zero tokens → executor computes zero cost (not null); row builder stores it as 0.
  const attempt: EscalationAttempt = {
    tier: "low",
    providerId: "anthropic-direct:claude-haiku-4-5-20251001",
    model: "claude-haiku-4-5-20251001",
    confidence: 0.90,
    inputTokens: 0,
    outputTokens: 0,
    escalated: false,
    latencyMs: 0,
    costUsd: 0,
    priceKey: "anthropic-direct:claude-haiku-4-5-20251001",
  };
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, attempt, null, true,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.cost_usd, 0);
});

// ── Example cost calculations (documentation-style assertions) ────────────────

test("example: typical icp_qualification call — Haiku 350 in / 120 out", () => {
  // Representative of a real qualification call
  const estimate = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 350, 120);
  assert.ok(estimate !== null);
  // input: 350/1M * $0.80 = $0.00028
  // output: 120/1M * $4.00 = $0.00048
  // total: $0.00076 per call → $76 per 100,000 calls
  assert.ok(estimate!.totalCostUsd > 0);
  assert.ok(estimate!.totalCostUsd < 0.001, "A single Haiku call should cost well under $0.001");
});

test("example: Opus qualification — 2000 in / 500 out", () => {
  const estimate = estimateCost("anthropic-direct:claude-opus-4-8", 2_000, 500);
  assert.ok(estimate !== null);
  // input: 2000/1M * $15 = $0.03
  // output: 500/1M * $75 = $0.0375
  // total: $0.0675 (Opus is expensive — that's the point of escalation routing)
  assert.ok(estimate!.totalCostUsd > 0);
  assert.ok(estimate!.totalCostUsd < 1.0, "A single Opus call at 2k+500 tokens should be under $1");
  // Opus should cost more than Haiku for the same tokens
  const haikuEstimate = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 2_000, 500);
  assert.ok(estimate!.totalCostUsd > haikuEstimate!.totalCostUsd);
});

test("example: cost ratio Opus/Haiku on same token count is > 10×", () => {
  const haiku = estimateCost("anthropic-direct:claude-haiku-4-5-20251001", 1_000, 500)!;
  const opus = estimateCost("anthropic-direct:claude-opus-4-8", 1_000, 500)!;
  const ratio = opus.totalCostUsd / haiku.totalCostUsd;
  assert.ok(ratio > 10, `Expected Opus to be >10× Haiku cost, got ${ratio.toFixed(1)}×`);
});
