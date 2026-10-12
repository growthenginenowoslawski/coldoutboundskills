/**
 * Stage 6 / 7 — executor tests.
 *
 * Verifies that executeQualification() automatically captures gateway,
 * latency, tokens, and cost from a provider call — without any real API calls.
 *
 * Also verifies the EscalationRouter integration: that EscalationAttempt
 * objects produced by qualify() carry the executor-computed fields.
 *
 * Stage 7 additions: tests for the generic execute<T>() function that prove
 * the execution infrastructure works for non-qualification result types.
 *
 * Coverage:
 *   executeQualification  — all ExecutionResult fields (Stage 6)
 *   Gateway extraction    — anthropic-direct, openrouter, unknown format
 *   Pricing integration   — known model → correct costUsd; unknown → null
 *   Token defaults        — result with no tokens → inputTokens/outputTokens = 0
 *   Latency              — latencyMs is a non-negative integer
 *   EscalationRouter     — attempts carry latencyMs, costUsd, priceKey
 *   EscalationResult     — totalCostUsd sums across attempts; null when any unknown
 *   Mixed pricing         — null propagates correctly in totalCostUsd
 *   Generic execute<T>   — same infrastructure works for any AITaskResult (Stage 7)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  execute,
  executeQualification,
  type AITaskResult,
  type ExecutionResult,
} from "../providers/ai/executor";
import {
  EscalationRouter,
  type EscalationConfig,
  type EscalationAttempt,
} from "../providers/ai/escalation-router";
import type { AIProvider } from "../providers/types";
import type { QualificationInput, QualificationResult } from "../domain/types";
import type { TaskType, ComplexityHint } from "../providers/ai/model-router";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DUMMY_INPUT: QualificationInput = {
  company: {
    name: "Test Corp",
    domain: "test.example.com",
    source: "test",
    fetchedAt: new Date().toISOString(),
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
    reason: "Test match",
    signals: [],
    confidence: 0.85,
    model: "claude-haiku-4-5-20251001",
    qualifiedAt: new Date().toISOString(),
    inputTokens: 350,
    outputTokens: 120,
    ...overrides,
  };
}

/** Build a minimal mock AIProvider that returns a fixed result. */
function mockProvider(id: string, result: QualificationResult): AIProvider {
  return {
    id,
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput) => ({ ...result }),
  };
}

// ── executeQualification — basic field capture ────────────────────────────────

test("executor: returns the result from the provider unchanged", async () => {
  const result = makeResult({ score: 92, confidence: 0.92 });
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.result.score, 92);
  assert.equal(exec.result.confidence, 0.92);
});

test("executor: extracts gateway from anthropic-direct provider", async () => {
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", makeResult());
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.gateway, "anthropic-direct");
});

test("executor: extracts gateway from openrouter provider", async () => {
  const result = makeResult({ model: "anthropic/claude-haiku-4-5-20251001" });
  const provider = mockProvider("openrouter:anthropic/claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.gateway, "openrouter");
});

test("executor: gateway is null when provider id has no colon", async () => {
  const provider = mockProvider("unknown-provider", makeResult());
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.gateway, null);
});

test("executor: latencyMs is a non-negative number", async () => {
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", makeResult());
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.ok(typeof exec.latencyMs === "number");
  assert.ok(exec.latencyMs >= 0);
});

test("executor: captures inputTokens from result", async () => {
  const result = makeResult({ inputTokens: 500 });
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.inputTokens, 500);
});

test("executor: captures outputTokens from result", async () => {
  const result = makeResult({ outputTokens: 200 });
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.outputTokens, 200);
});

test("executor: defaults inputTokens to 0 when result omits it", async () => {
  const result = makeResult({ inputTokens: undefined });
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.inputTokens, 0);
});

test("executor: defaults outputTokens to 0 when result omits it", async () => {
  const result = makeResult({ outputTokens: undefined });
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.outputTokens, 0);
});

// ── executeQualification — pricing integration ────────────────────────────────

test("executor: computes correct costUsd for Haiku (anthropic-direct)", async () => {
  // 1M in / 1M out → $0.80 + $4.00 = $4.80
  const result = makeResult({
    model: "claude-haiku-4-5-20251001",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  });
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.ok(exec.costUsd !== null);
  assert.ok(Math.abs(exec.costUsd! - 4.80) < 1e-8, `Expected ~4.80, got ${exec.costUsd}`);
});

test("executor: computes correct costUsd for Opus (anthropic-direct)", async () => {
  // 2k in / 500 out → (2000/1M * 15) + (500/1M * 75) = 0.03 + 0.0375 = 0.0675
  const result = makeResult({
    model: "claude-opus-4-8",
    inputTokens: 2_000,
    outputTokens: 500,
  });
  const provider = mockProvider("anthropic-direct:claude-opus-4-8", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.ok(exec.costUsd !== null);
  assert.ok(Math.abs(exec.costUsd! - 0.0675) < 1e-10, `Expected 0.0675, got ${exec.costUsd}`);
});

test("executor: computes correct costUsd for Sonnet (openrouter)", async () => {
  // 10k in / 2k out via openrouter → (10k/1M * 3) + (2k/1M * 15) = 0.03 + 0.03 = 0.06
  const result = makeResult({
    model: "anthropic/claude-sonnet-4-6",
    inputTokens: 10_000,
    outputTokens: 2_000,
  });
  const provider = mockProvider("openrouter:anthropic/claude-sonnet-4-6", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.ok(exec.costUsd !== null);
  assert.ok(Math.abs(exec.costUsd! - 0.06) < 1e-10, `Expected 0.06, got ${exec.costUsd}`);
});

test("executor: costUsd is null when model not in pricing registry", async () => {
  const result = makeResult({ model: "some-unknown-model-v99" });
  const provider = mockProvider("anthropic-direct:some-unknown-model-v99", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.costUsd, null);
});

test("executor: costUsd is null when gateway cannot be extracted", async () => {
  const result = makeResult({ model: "claude-haiku-4-5-20251001" });
  const provider = mockProvider("nogateway", result);  // no colon → no gateway
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.costUsd, null);
});

test("executor: costUsd is 0 for zero tokens (not null) on known model", async () => {
  const result = makeResult({
    model: "claude-haiku-4-5-20251001",
    inputTokens: 0,
    outputTokens: 0,
  });
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.ok(exec.costUsd === 0);
});

test("executor: priceKey is correctly formed from gateway and model", async () => {
  const result = makeResult({ model: "claude-haiku-4-5-20251001" });
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", result);
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.priceKey, "anthropic-direct:claude-haiku-4-5-20251001");
});

test("executor: priceKey is null when gateway cannot be extracted", async () => {
  const provider = mockProvider("nogateway", makeResult());
  const exec = await executeQualification(provider, DUMMY_INPUT);
  assert.equal(exec.priceKey, null);
});

// ── EscalationRouter integration ──────────────────────────────────────────────

function pricedProvider(
  gateway: string,
  modelSuffix: string,
  confidence: number,
  inputTokens = 350,
  outputTokens = 120,
): AIProvider {
  const id = `${gateway}:${modelSuffix}`;
  return mockProvider(id, makeResult({ model: modelSuffix, confidence, inputTokens, outputTokens }));
}

const BASE_CONFIG: EscalationConfig = {
  taskType: "icp_qualification",
  startTier: "low",
  confidenceThreshold: 0.75,
  maxTier: "high",
};

test("escalation: each attempt has latencyMs >= 0", async () => {
  const low = pricedProvider("mock", "low-model", 0.40);
  const high = pricedProvider("mock", "high-model", 0.90);
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: (_t: TaskType, tier: ComplexityHint) =>
      tier === "low" ? low : high,
  });
  for (const attempt of result.attempts) {
    assert.ok(typeof attempt.latencyMs === "number");
    assert.ok(attempt.latencyMs >= 0);
  }
});

test("escalation: attempt has costUsd null when provider is not in pricing registry", async () => {
  const provider = pricedProvider("mock", "low-model", 0.90);
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: () => provider,
  });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].costUsd, null);
});

test("escalation: attempt has correct costUsd for known pricing model", async () => {
  // Haiku at 350 in / 120 out → (350/1M * 0.80) + (120/1M * 4.00)
  const expected = (350 / 1_000_000) * 0.80 + (120 / 1_000_000) * 4.00;
  const provider = pricedProvider("anthropic-direct", "claude-haiku-4-5-20251001", 0.90, 350, 120);
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: () => provider,
  });
  assert.equal(result.attempts.length, 1);
  assert.ok(result.attempts[0].costUsd !== null);
  assert.ok(
    Math.abs(result.attempts[0].costUsd! - expected) < 1e-12,
    `Expected ${expected}, got ${result.attempts[0].costUsd}`,
  );
});

test("escalation: attempt has correct priceKey for known provider", async () => {
  const provider = pricedProvider("anthropic-direct", "claude-haiku-4-5-20251001", 0.90);
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: () => provider,
  });
  assert.equal(result.attempts[0].priceKey, "anthropic-direct:claude-haiku-4-5-20251001");
});

test("escalation: totalCostUsd sums per-attempt costs for known models", async () => {
  // low attempt: 200 in / 80 out, Haiku
  const lowExpected = (200 / 1_000_000) * 0.80 + (80 / 1_000_000) * 4.00;
  // high attempt: 1200 in / 400 out, Opus
  const highExpected = (1_200 / 1_000_000) * 15.00 + (400 / 1_000_000) * 75.00;
  const totalExpected = lowExpected + highExpected;

  const low = pricedProvider("anthropic-direct", "claude-haiku-4-5-20251001", 0.40, 200, 80);
  const high = pricedProvider("anthropic-direct", "claude-opus-4-8", 0.90, 1_200, 400);
  // Override model returned by Haiku so low tier escalates
  const lowP = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", makeResult({
    model: "claude-haiku-4-5-20251001",
    confidence: 0.40,
    inputTokens: 200,
    outputTokens: 80,
  }));
  const highP = mockProvider("anthropic-direct:claude-opus-4-8", makeResult({
    model: "claude-opus-4-8",
    confidence: 0.90,
    inputTokens: 1_200,
    outputTokens: 400,
  }));

  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: (_t: TaskType, tier: ComplexityHint) => {
      if (tier === "low") return lowP;
      return highP;
    },
  });

  assert.equal(result.attempts.length, 2);
  assert.ok(result.totalCostUsd !== null);
  assert.ok(
    Math.abs(result.totalCostUsd! - totalExpected) < 1e-12,
    `Expected ${totalExpected}, got ${result.totalCostUsd}`,
  );
});

test("escalation: totalCostUsd is null when any attempt has unknown model", async () => {
  const unknownProvider = mockProvider("mock:unknown-model", makeResult({
    model: "unknown-model",
    confidence: 0.40,
  }));
  const knownProvider = mockProvider("anthropic-direct:claude-opus-4-8", makeResult({
    model: "claude-opus-4-8",
    confidence: 0.90,
  }));

  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: (_t: TaskType, tier: ComplexityHint) => {
      if (tier === "low") return unknownProvider;
      return knownProvider;
    },
  });

  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].costUsd, null, "low attempt with unknown model should have null cost");
  assert.equal(result.totalCostUsd, null, "totalCostUsd should be null when any attempt is null");
});

test("escalation: totalCostUsd is non-null when single known-model attempt", async () => {
  const provider = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", makeResult({
    model: "claude-haiku-4-5-20251001",
    confidence: 0.90,
    inputTokens: 100,
    outputTokens: 50,
  }));
  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: () => provider,
  });
  assert.equal(result.attempts.length, 1);
  assert.ok(result.totalCostUsd !== null);
  assert.ok(result.totalCostUsd! >= 0);
});

test("escalation: result includes escalated flag set correctly with executor", async () => {
  const lowP = mockProvider("anthropic-direct:claude-haiku-4-5-20251001", makeResult({
    model: "claude-haiku-4-5-20251001", confidence: 0.40,
  }));
  const highP = mockProvider("anthropic-direct:claude-opus-4-8", makeResult({
    model: "claude-opus-4-8", confidence: 0.90,
  }));

  const result = await EscalationRouter.qualify(DUMMY_INPUT, BASE_CONFIG, {
    providerFactory: (_t: TaskType, tier: ComplexityHint) =>
      tier === "low" ? lowP : highP,
  });

  assert.equal(result.escalated, true);
  assert.equal(result.attempts[0].escalated, true);
  assert.equal(result.attempts[1].escalated, false);
});

// ── Generic execute<T> — task-agnostic infrastructure (Stage 7) ───────────────
//
// These tests prove that the execution infrastructure works for any AI task
// result type, not just qualification.  No new workflow is added — these use a
// minimal stub type to demonstrate the contract is enforced and honoured.

/** Minimal stub result representing a future personalization task. */
interface PersonalizationStub extends AITaskResult {
  model: string;
  subject: string;
  body: string;
  inputTokens?: number;
  outputTokens?: number;
}

test("execute<T>: works with a non-qualification result type", async () => {
  const stub: PersonalizationStub = {
    model: "claude-haiku-4-5-20251001",
    subject: "Hi {{firstName}}",
    body: "Congrats on the funding round.",
    inputTokens: 200,
    outputTokens: 80,
  };

  const exec = await execute(
    { id: "anthropic-direct:claude-haiku-4-5-20251001" },
    async () => stub,
  );

  assert.equal(exec.result.subject, "Hi {{firstName}}");
  assert.equal(exec.result.body, "Congrats on the funding round.");
  assert.equal(exec.gateway, "anthropic-direct");
  assert.equal(exec.inputTokens, 200);
  assert.equal(exec.outputTokens, 80);
});

test("execute<T>: computes costUsd for non-qualification task using same pricing registry", async () => {
  // Demonstrates that pricing infrastructure is reused unchanged for any task type.
  // Haiku: 200 in / 80 out → (200/1M * 0.80) + (80/1M * 4.00)
  const expected = (200 / 1_000_000) * 0.80 + (80 / 1_000_000) * 4.00;
  const stub: PersonalizationStub = {
    model: "claude-haiku-4-5-20251001",
    subject: "Subject",
    body: "Body",
    inputTokens: 200,
    outputTokens: 80,
  };

  const exec = await execute(
    { id: "anthropic-direct:claude-haiku-4-5-20251001" },
    async () => stub,
  );

  assert.ok(exec.costUsd !== null);
  assert.ok(
    Math.abs(exec.costUsd! - expected) < 1e-12,
    `Expected ${expected}, got ${exec.costUsd}`,
  );
});

test("execute<T>: latency and gateway captured identically across task types", async () => {
  // Same observability fields regardless of what the task result contains.
  // For openrouter, the model name includes the "anthropic/" prefix.
  const stub: PersonalizationStub = {
    model: "anthropic/claude-sonnet-4-6",
    subject: "Subject",
    body: "Body",
    inputTokens: 0,
    outputTokens: 0,
  };

  const exec = await execute(
    { id: "openrouter:anthropic/claude-sonnet-4-6" },
    async () => stub,
  );

  assert.equal(exec.gateway, "openrouter");
  assert.ok(exec.latencyMs >= 0);
  assert.equal(exec.priceKey, "openrouter:anthropic/claude-sonnet-4-6");
});

test("execute<T>: result type is preserved with full TypeScript inference", async () => {
  // TypeScript structural check: exec.result must be the full PersonalizationStub,
  // not narrowed down to AITaskResult.
  const stub: PersonalizationStub = {
    model: "claude-haiku-4-5-20251001",
    subject: "My Subject",
    body: "My Body",
  };

  const exec = await execute({ id: "anthropic-direct:claude-haiku-4-5-20251001" }, async () => stub);

  // Access task-specific fields — would be a compile error if T was erased to AITaskResult.
  const result: PersonalizationStub = exec.result;
  assert.equal(result.subject, "My Subject");
  assert.equal(result.body, "My Body");
});
