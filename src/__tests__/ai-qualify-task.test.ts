/**
 * Unit tests for runAIQualify() — Stage 8.
 *
 * These tests exercise the pure task logic in src/tasks/qualify.ts.
 * All providers are injected mocks — no real API calls, no Supabase writes.
 *
 * Coverage:
 *   - Verdict fields propagated correctly from AI result
 *   - All observability fields populated (gateway, model, tokens, cost, latency)
 *   - Single-attempt path (no escalation)
 *   - Two-attempt escalation path (low → medium)
 *   - Token/cost accounting across all attempts
 *   - Error propagation (provider throws → runAIQualify throws)
 *   - Caller-supplied escalationOverrides respected
 *   - Raw EscalationResult returned for downstream DB storage
 *   - startedAt is a valid ISO 8601 timestamp
 *   - alreadyProcessed is always false (set by the Trigger.dev task, not this fn)
 *   - idempotent computation: same inputs → same result shape
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  runAIQualify,
  type AIQualifyPayload,
  type AIQualifyOptions,
} from "../tasks/qualify";
import type { AIProvider } from "../providers/types";
import type { QualificationInput, QualificationResult, CompanyRecord } from "../domain/types";
import type { TaskType, ComplexityHint } from "../providers/ai/model-router";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const COMPANY: CompanyRecord = {
  name: "Acme Corp",
  domain: "acme.com",
  industry: "SaaS B2B",
  employeeCount: 150,
  source: "test",
  fetchedAt: "2026-01-15T10:00:00.000Z",
};

const INPUT: QualificationInput = {
  company: COMPANY,
  icp: {
    industry: "SaaS",
    employeeRange: { min: 50, max: 500 },
    keywords: ["B2B", "outbound"],
    description: "Series A SaaS companies using Salesforce",
  },
  signals: ["uses-salesforce"],
};

const BASE_PAYLOAD: AIQualifyPayload = {
  companyId: "comp_acme_001",
  taskType: "icp_qualification",
  idempotencyKey: "comp_acme_001:icp_qualification:batch_q1",
  input: INPUT,
};

// ── Mock provider factories ───────────────────────────────────────────────────

/** High confidence on any tier — no escalation. Uses Haiku pricing (priced model). */
function makeHighConfProvider(_taskType: TaskType, _tier: ComplexityHint): AIProvider {
  return {
    id: "anthropic-direct:claude-haiku-4-5-20251001",
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput): Promise<QualificationResult> => ({
      icpFit: true,
      score: 82,
      industryMatch: true,
      sizeMatch: true,
      locationMatch: true,
      reason: "Strong ICP fit: SaaS B2B, 150 employees, uses Salesforce",
      signals: ["b2b-saas", "crm-salesforce"],
      confidence: 0.90,
      model: "claude-haiku-4-5-20251001",
      qualifiedAt: "2026-01-15T10:00:05.000Z",
      inputTokens: 350,
      outputTokens: 120,
    }),
  };
}

/**
 * Tiered mock — low tier returns confidence 0.60 (below icp_qualification
 * threshold 0.75, so escalation fires); medium tier returns 0.88 (accepted).
 */
function makeTieredProvider(_taskType: TaskType, tier: ComplexityHint): AIProvider {
  const isLow = tier === "low";
  return {
    id: isLow
      ? "anthropic-direct:claude-haiku-4-5-20251001"
      : "anthropic-direct:claude-sonnet-4-6",
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput): Promise<QualificationResult> => ({
      icpFit: !isLow,
      score: isLow ? 40 : 78,
      industryMatch: !isLow,
      sizeMatch: true,
      locationMatch: true,
      reason: isLow ? "Low confidence — escalating to stronger model" : "Good ICP fit",
      signals: [],
      confidence: isLow ? 0.60 : 0.88,
      model: isLow ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6",
      qualifiedAt: new Date().toISOString(),
      inputTokens: isLow ? 350 : 420,
      outputTokens: isLow ? 120 : 150,
    }),
  };
}

/** Always throws — used to test error propagation. */
function makeFailingProvider(_taskType: TaskType, _tier: ComplexityHint): AIProvider {
  return {
    id: "anthropic-direct:claude-haiku-4-5-20251001",
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput): Promise<QualificationResult> => {
      throw new Error("Simulated provider failure: rate limit exceeded");
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Run with the high-confidence single-tier mock (common case). */
async function runSingle(overrides: Partial<AIQualifyPayload> = {}) {
  return runAIQualify(
    { ...BASE_PAYLOAD, ...overrides },
    { providerFactory: makeHighConfProvider },
  );
}

/** Run with the tiered mock (forces escalation low → medium). */
async function runEscalated(overrides: Partial<AIQualifyPayload> = {}) {
  return runAIQualify(
    {
      ...BASE_PAYLOAD,
      ...overrides,
      escalationOverrides: {
        startTier: "low",
        maxTier: "medium",
        confidenceThreshold: 0.75,
        ...overrides.escalationOverrides,
      },
    },
    { providerFactory: makeTieredProvider },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runAIQualify: AI verdict fields", () => {
  test("icpFit comes from the AI result", async () => {
    const { result } = await runSingle();
    assert.equal(result.icpFit, true);
  });

  test("score comes from the AI result", async () => {
    const { result } = await runSingle();
    assert.equal(result.score, 82);
  });

  test("reason comes from the AI result", async () => {
    const { result } = await runSingle();
    assert.match(result.reason, /SaaS B2B/);
  });

  test("confidence comes from the final accepted attempt", async () => {
    const { result } = await runSingle();
    assert.equal(result.confidence, 0.90);
  });

  test("alreadyProcessed is always false — only the Trigger.dev task sets it", async () => {
    const { result } = await runSingle();
    assert.equal(result.alreadyProcessed, false);
  });
});

describe("runAIQualify: payload fields propagated to result", () => {
  test("companyId propagated", async () => {
    const { result } = await runSingle();
    assert.equal(result.companyId, "comp_acme_001");
  });

  test("taskType propagated", async () => {
    const { result } = await runSingle();
    assert.equal(result.taskType, "icp_qualification");
  });

  test("idempotencyKey propagated", async () => {
    const { result } = await runSingle();
    assert.equal(result.idempotencyKey, "comp_acme_001:icp_qualification:batch_q1");
  });

  test("clientId propagated when present", async () => {
    const { result } = await runSingle({ clientId: "client_gramscode" });
    assert.equal(result.clientId, "client_gramscode");
  });

  test("clientId defaults to null when absent", async () => {
    const { result } = await runSingle();
    assert.equal(result.clientId, null);
  });
});

describe("runAIQualify: observability fields (single-attempt path)", () => {
  test("gateway extracted from finalProviderId", async () => {
    const { result } = await runSingle();
    assert.equal(result.gateway, "anthropic-direct");
  });

  test("model comes from the AI result", async () => {
    const { result } = await runSingle();
    assert.equal(result.model, "claude-haiku-4-5-20251001");
  });

  test("inputTokens correct for single attempt", async () => {
    const { result } = await runSingle();
    assert.equal(result.inputTokens, 350);
  });

  test("outputTokens correct for single attempt", async () => {
    const { result } = await runSingle();
    assert.equal(result.outputTokens, 120);
  });

  test("costUsd > 0 when model is in pricing registry (Haiku)", async () => {
    const { result } = await runSingle();
    assert.notEqual(result.costUsd, null);
    assert.ok((result.costUsd as number) > 0, `expected costUsd > 0, got ${result.costUsd}`);
  });

  test("totalCostUsd equals costUsd for a single-attempt run", async () => {
    const { result } = await runSingle();
    assert.equal(result.totalCostUsd, result.costUsd);
  });

  test("latencyMs is a non-negative number", async () => {
    const { result } = await runSingle();
    assert.ok(typeof result.latencyMs === "number");
    assert.ok(result.latencyMs >= 0, `expected latencyMs >= 0, got ${result.latencyMs}`);
  });

  test("escalated is false for single-attempt run", async () => {
    const { result } = await runSingle();
    assert.equal(result.escalated, false);
  });

  test("attemptCount is 1 for single-attempt run", async () => {
    const { result } = await runSingle();
    assert.equal(result.attemptCount, 1);
  });
});

describe("runAIQualify: escalation path (low → medium)", () => {
  test("escalated is true when two attempts were used", async () => {
    const { result } = await runEscalated();
    assert.equal(result.escalated, true);
  });

  test("attemptCount is 2 after one escalation", async () => {
    const { result } = await runEscalated();
    assert.equal(result.attemptCount, 2);
  });

  test("model comes from the final (medium/Sonnet) attempt", async () => {
    const { result } = await runEscalated();
    assert.equal(result.model, "claude-sonnet-4-6");
  });

  test("inputTokens is the sum across both attempts (350 + 420 = 770)", async () => {
    const { result } = await runEscalated();
    assert.equal(result.inputTokens, 770);
  });

  test("outputTokens is the sum across both attempts (120 + 150 = 270)", async () => {
    const { result } = await runEscalated();
    assert.equal(result.outputTokens, 270);
  });

  test("totalCostUsd > costUsd because it includes the cheaper first attempt", async () => {
    const { result } = await runEscalated();
    assert.notEqual(result.totalCostUsd, null);
    assert.notEqual(result.costUsd, null);
    assert.ok(
      (result.totalCostUsd as number) > (result.costUsd as number),
      `expected totalCostUsd (${result.totalCostUsd}) > costUsd (${result.costUsd})`,
    );
  });

  test("icpFit comes from the accepted final attempt (medium = fit)", async () => {
    const { result } = await runEscalated();
    assert.equal(result.icpFit, true);
  });
});

describe("runAIQualify: raw escalation data returned for DB storage", () => {
  test("escalation field contains the raw EscalationResult", async () => {
    const { escalation } = await runSingle();
    assert.ok(escalation, "escalation field should be present");
    assert.ok(Array.isArray(escalation.attempts), "escalation.attempts should be an array");
  });

  test("escalation.escalated matches result.escalated for single-attempt run", async () => {
    const { result, escalation } = await runSingle();
    assert.equal(escalation.escalated, result.escalated);
  });

  test("escalation.attempts has the per-attempt cost and latency for DB rows", async () => {
    const { escalation } = await runEscalated();
    for (const attempt of escalation.attempts) {
      assert.ok(typeof attempt.latencyMs === "number", "each attempt should have latencyMs");
      // costUsd is null if model unpriced; our mocks use priced models so it should be set
      assert.notEqual(attempt.costUsd, null, "each attempt should have costUsd for these mocks");
    }
  });

  test("startedAt is a valid ISO 8601 timestamp", async () => {
    const { startedAt } = await runSingle();
    assert.ok(typeof startedAt === "string");
    assert.doesNotThrow(() => {
      const d = new Date(startedAt);
      if (isNaN(d.getTime())) throw new Error("invalid date");
    }, `expected valid ISO date, got "${startedAt}"`);
  });
});

describe("runAIQualify: escalationOverrides respected", () => {
  test("maxTier=low forces single attempt even when confidence is below threshold", async () => {
    // With the tiered provider, low tier returns confidence 0.60 < 0.75.
    // But maxTier=low means we can't escalate — the result is accepted anyway.
    const { result } = await runAIQualify(
      {
        ...BASE_PAYLOAD,
        escalationOverrides: { startTier: "low", maxTier: "low", confidenceThreshold: 0.75 },
      },
      { providerFactory: makeTieredProvider },
    );
    assert.equal(result.attemptCount, 1);
    assert.equal(result.escalated, false);
    assert.equal(result.model, "claude-haiku-4-5-20251001");
  });

  test("confidenceThreshold=0.0 accepts the very first attempt regardless of confidence", async () => {
    // Even the tiered provider's low-confidence result (0.60) should be accepted.
    const { result } = await runAIQualify(
      {
        ...BASE_PAYLOAD,
        escalationOverrides: { startTier: "low", maxTier: "medium", confidenceThreshold: 0.0 },
      },
      { providerFactory: makeTieredProvider },
    );
    assert.equal(result.attemptCount, 1);
    assert.equal(result.escalated, false);
  });
});

describe("runAIQualify: error handling", () => {
  test("throws when the AI provider throws (error propagates to Trigger.dev for retry)", async () => {
    await assert.rejects(
      () => runAIQualify(BASE_PAYLOAD, { providerFactory: makeFailingProvider }),
      (err: Error) => {
        assert.match(err.message, /rate limit exceeded/);
        return true;
      },
    );
  });
});

describe("runAIQualify: idempotent computation", () => {
  test("same payload + same mock provider produces the same result shape across two calls", async () => {
    // runAIQualify is not truly idempotent (latencyMs differs) but the observable
    // result shape (icpFit, score, model, escalated, attemptCount) is deterministic
    // given a deterministic mock provider.
    const [exec1, exec2] = await Promise.all([runSingle(), runSingle()]);
    assert.equal(exec1.result.icpFit, exec2.result.icpFit);
    assert.equal(exec1.result.score, exec2.result.score);
    assert.equal(exec1.result.model, exec2.result.model);
    assert.equal(exec1.result.escalated, exec2.result.escalated);
    assert.equal(exec1.result.attemptCount, exec2.result.attemptCount);
    assert.equal(exec1.result.inputTokens, exec2.result.inputTokens);
    assert.equal(exec1.result.outputTokens, exec2.result.outputTokens);
  });
});
