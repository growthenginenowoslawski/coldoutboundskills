/**
 * Unit tests for src/tasks/checkpoint.ts — Stage 9.
 *
 * Tests the generic, pure checkpoint functions that make Trigger.dev retries
 * safe across ALL AI task types (icp_qualification, personalization,
 * campaign_strategy, reply_classify, signal_analysis, enrichment).
 *
 * No Supabase. No Trigger.dev. No real AI calls.
 *
 * Coverage map (matching Stage 9 requirements):
 *   1.  successful first execution   → buildAIExecutedCheckpoint structure
 *   2.  duplicate execution          → resolveResumeDecision("completed")
 *   3.  retry after failure          → resolveResumeDecision("failed")
 *   4.  retry after partial          → resolveResumeDecision + ai_executed checkpoint
 *   5.  escalation + retry           → escalation data round-trips through checkpoint
 *   6.  cost preservation            → totalCostUsd preserved via checkpoint
 *   7.  enrichment_run preservation  → enrichmentRunIds preserved via checkpoint
 *   8.  client isolation             → clientId preserved in checkpointed result
 *   9.  different idempotency keys   → each resolves to "run_all" with no existing job
 *  10.  concurrent duplicates        → documented limitation; decision logic tested
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  readCheckpoint,
  buildAIExecutedCheckpoint,
  buildEnrichmentStoredCheckpoint,
  checkpointIs,
  resolveResumeDecision,
  type AITaskCheckpoint,
  type CheckpointJobOutput,
} from "../tasks/checkpoint";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_RESULT = {
  alreadyProcessed: false,
  companyId: "comp_001",
  taskType: "icp_qualification",
  idempotencyKey: "comp_001:icp_qualification:batch_01",
  clientId: "client_gramscode",
  icpFit: true,
  score: 82,
  confidence: 0.90,
  reason: "Strong ICP fit",
  gateway: "anthropic-direct",
  model: "claude-haiku-4-5-20251001",
  inputTokens: 350,
  outputTokens: 120,
  costUsd: 7.6e-7,
  totalCostUsd: 7.6e-7,
  latencyMs: 420,
  escalated: false,
  attemptCount: 1,
};

const MOCK_ESCALATION = {
  result: { icpFit: true, score: 82, model: "claude-haiku-4-5-20251001", confidence: 0.90 },
  attempts: [
    {
      tier: "low",
      providerId: "anthropic-direct:claude-haiku-4-5-20251001",
      model: "claude-haiku-4-5-20251001",
      confidence: 0.90,
      inputTokens: 350,
      outputTokens: 120,
      escalated: false,
      latencyMs: 420,
      costUsd: 7.6e-7,
      priceKey: "anthropic-direct:claude-haiku-4-5-20251001",
    },
  ],
  totalInputTokens: 350,
  totalOutputTokens: 120,
  totalCostUsd: 7.6e-7,
  finalProviderId: "anthropic-direct:claude-haiku-4-5-20251001",
  finalTier: "low",
  escalated: false,
};

const ESCALATED_MOCK_ESCALATION = {
  result: { icpFit: true, score: 78, model: "claude-sonnet-4-6", confidence: 0.88 },
  attempts: [
    {
      tier: "low",
      providerId: "anthropic-direct:claude-haiku-4-5-20251001",
      model: "claude-haiku-4-5-20251001",
      confidence: 0.60,
      inputTokens: 350,
      outputTokens: 120,
      escalated: true,
      latencyMs: 310,
      costUsd: 7.6e-7,
      priceKey: "anthropic-direct:claude-haiku-4-5-20251001",
    },
    {
      tier: "medium",
      providerId: "anthropic-direct:claude-sonnet-4-6",
      model: "claude-sonnet-4-6",
      confidence: 0.88,
      inputTokens: 420,
      outputTokens: 150,
      escalated: false,
      latencyMs: 890,
      costUsd: 3.51e-6,
      priceKey: "anthropic-direct:claude-sonnet-4-6",
    },
  ],
  totalInputTokens: 770,
  totalOutputTokens: 270,
  totalCostUsd: 4.29e-6,
  finalProviderId: "anthropic-direct:claude-sonnet-4-6",
  finalTier: "medium",
  escalated: true,
};

const STARTED_AT = "2026-01-15T10:00:00.000Z";
const ENRICHMENT_RUN_IDS = ["er_001", "er_002"];
const FINAL_ENRICHMENT_RUN_ID = "er_002";

// ── readCheckpoint ────────────────────────────────────────────────────────────

describe("readCheckpoint: invalid inputs", () => {
  test("returns null for null", () => {
    assert.equal(readCheckpoint(null), null);
  });

  test("returns null for undefined", () => {
    assert.equal(readCheckpoint(undefined), null);
  });

  test("returns null for a number", () => {
    assert.equal(readCheckpoint(42), null);
  });

  test("returns null for an array", () => {
    assert.equal(readCheckpoint([]), null);
  });

  test("returns null for an object with no _checkpoint key", () => {
    assert.equal(readCheckpoint({ someOtherKey: "value" }), null);
  });

  test("returns null when _checkpoint is not an object", () => {
    assert.equal(readCheckpoint({ _checkpoint: "not-an-object" }), null);
  });

  test("returns null when stage is missing", () => {
    assert.equal(readCheckpoint({ _checkpoint: { startedAt: STARTED_AT } }), null);
  });

  test("returns null when startedAt is missing", () => {
    assert.equal(readCheckpoint({ _checkpoint: { stage: "ai_executed" } }), null);
  });

  test("returns null when stage is an unknown value", () => {
    assert.equal(
      readCheckpoint({ _checkpoint: { stage: "unknown_stage", startedAt: STARTED_AT } }),
      null,
    );
  });
});

describe("readCheckpoint: valid inputs", () => {
  test("returns checkpoint for a valid ai_executed payload", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT);
    const read = readCheckpoint(cp);
    assert.notEqual(read, null);
    assert.equal(read!.stage, "ai_executed");
  });

  test("returns checkpoint for a valid enrichment_stored payload", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT,
      ENRICHMENT_RUN_IDS,
      FINAL_ENRICHMENT_RUN_ID,
      STARTED_AT,
    );
    const read = readCheckpoint(cp);
    assert.notEqual(read, null);
    assert.equal(read!.stage, "enrichment_stored");
  });

  test("ignores extra keys in output_data alongside _checkpoint", () => {
    const cp = {
      ...buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT),
      someUnrelatedField: "ignored",
    };
    const read = readCheckpoint(cp);
    assert.notEqual(read, null);
    assert.equal(read!.stage, "ai_executed");
  });
});

// ── buildAIExecutedCheckpoint ─────────────────────────────────────────────────

describe("buildAIExecutedCheckpoint", () => {
  test("stage is 'ai_executed'", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT);
    assert.equal(cp._checkpoint.stage, "ai_executed");
  });

  test("result is preserved (scenario 1: successful first execution)", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT);
    assert.deepEqual(cp._checkpoint.result, MOCK_RESULT);
  });

  test("escalationData is preserved (needed for enrichment_runs write on retry)", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT);
    assert.deepEqual(cp._checkpoint.escalationData, MOCK_ESCALATION);
  });

  test("enrichmentRunIds is absent (not yet written at this stage)", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT);
    assert.equal(cp._checkpoint.enrichmentRunIds, undefined);
  });

  test("startedAt is preserved", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT);
    assert.equal(cp._checkpoint.startedAt, STARTED_AT);
  });

  test("savedAt is a valid ISO string", () => {
    const before = Date.now();
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT);
    const after = Date.now();
    const savedMs = new Date(cp._checkpoint.savedAt).getTime();
    assert.ok(savedMs >= before && savedMs <= after, "savedAt should be within test window");
  });

  test("scenario 5: escalation data with two attempts round-trips correctly", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, ESCALATED_MOCK_ESCALATION, STARTED_AT);
    const stored = cp._checkpoint.escalationData as typeof ESCALATED_MOCK_ESCALATION;
    assert.equal(stored.attempts.length, 2);
    assert.equal(stored.escalated, true);
    assert.equal(stored.totalInputTokens, 770);
    assert.equal(stored.totalOutputTokens, 270);
  });

  test("scenario 6: totalCostUsd preserved through checkpoint round-trip", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, ESCALATED_MOCK_ESCALATION, STARTED_AT);
    const stored = cp._checkpoint.escalationData as typeof ESCALATED_MOCK_ESCALATION;
    assert.ok(stored.totalCostUsd !== null, "totalCostUsd should not be null");
    assert.ok(
      Math.abs((stored.totalCostUsd ?? 0) - 4.29e-6) < 1e-10,
      `expected 4.29e-6, got ${stored.totalCostUsd}`,
    );
  });

  test("scenario 8: clientId preserved in checkpointed result", () => {
    const resultWithClient = { ...MOCK_RESULT, clientId: "client_gramscode" };
    const cp = buildAIExecutedCheckpoint(resultWithClient, MOCK_ESCALATION, STARTED_AT);
    const read = cp._checkpoint.result as typeof resultWithClient;
    assert.equal(read.clientId, "client_gramscode");
  });
});

// ── buildEnrichmentStoredCheckpoint ───────────────────────────────────────────

describe("buildEnrichmentStoredCheckpoint", () => {
  test("stage is 'enrichment_stored'", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    );
    assert.equal(cp._checkpoint.stage, "enrichment_stored");
  });

  test("result is preserved", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    );
    assert.deepEqual(cp._checkpoint.result, MOCK_RESULT);
  });

  test("scenario 7: enrichmentRunIds preserved", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    );
    assert.deepEqual(cp._checkpoint.enrichmentRunIds, ENRICHMENT_RUN_IDS);
  });

  test("finalEnrichmentRunId preserved", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    );
    assert.equal(cp._checkpoint.finalEnrichmentRunId, FINAL_ENRICHMENT_RUN_ID);
  });

  test("escalationData is absent (cleaned up — no longer needed)", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    );
    assert.equal(cp._checkpoint.escalationData, undefined);
  });

  test("handles empty enrichmentRunIds (skipEnrichmentRuns=true case)", () => {
    const cp = buildEnrichmentStoredCheckpoint(MOCK_RESULT, [], null, STARTED_AT);
    assert.deepEqual(cp._checkpoint.enrichmentRunIds, []);
    assert.equal(cp._checkpoint.finalEnrichmentRunId, null);
  });
});

// ── checkpointIs ──────────────────────────────────────────────────────────────

describe("checkpointIs", () => {
  test("returns true when stage matches ai_executed", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT)._checkpoint as AITaskCheckpoint;
    assert.equal(checkpointIs(cp, "ai_executed"), true);
  });

  test("returns true when stage matches enrichment_stored", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    )._checkpoint as AITaskCheckpoint;
    assert.equal(checkpointIs(cp, "enrichment_stored"), true);
  });

  test("returns false when stage doesn't match", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT)._checkpoint as AITaskCheckpoint;
    assert.equal(checkpointIs(cp, "enrichment_stored"), false);
  });

  test("returns false for null checkpoint", () => {
    assert.equal(checkpointIs(null, "ai_executed"), false);
  });

  test("returns false for undefined checkpoint", () => {
    assert.equal(checkpointIs(undefined, "ai_executed"), false);
  });
});

// ── resolveResumeDecision ─────────────────────────────────────────────────────

describe("resolveResumeDecision: done scenarios (scenario 2: duplicate execution)", () => {
  test("'completed' status → done", () => {
    assert.equal(resolveResumeDecision("completed", null), "done");
  });

  test("'completed' with any checkpoint → done (status takes priority)", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT)._checkpoint as AITaskCheckpoint;
    assert.equal(resolveResumeDecision("completed", cp), "done");
  });
});

describe("resolveResumeDecision: complete_job scenarios (scenario 7: enrichment preserved)", () => {
  // The jobs table constraint does not allow custom status values like "enrichment_stored".
  // The checkpoint stage lives ONLY in output_data._checkpoint.stage.
  // resolveResumeDecision reads it from there regardless of the status column value.

  test("'running' + enrichment_stored checkpoint → complete_job", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    )._checkpoint as AITaskCheckpoint;
    assert.equal(resolveResumeDecision("running", cp), "complete_job");
  });

  test("'pending' + enrichment_stored checkpoint → complete_job (checkpoint takes precedence)", () => {
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    )._checkpoint as AITaskCheckpoint;
    assert.equal(resolveResumeDecision("pending", cp), "complete_job");
  });

  test("'failed' + enrichment_stored checkpoint → complete_job (checkpoint survives failure)", () => {
    // Edge case: if the job status was set to "failed" AFTER the enrichment checkpoint
    // was written (e.g., completeJob itself failed), a retry should still complete the job.
    const cp = buildEnrichmentStoredCheckpoint(
      MOCK_RESULT, ENRICHMENT_RUN_IDS, FINAL_ENRICHMENT_RUN_ID, STARTED_AT,
    )._checkpoint as AITaskCheckpoint;
    assert.equal(resolveResumeDecision("failed", cp), "complete_job");
  });
});

describe("resolveResumeDecision: store_enrichment scenarios (scenario 4: retry after partial)", () => {
  // AI ran and saved the checkpoint; enrichment_runs not yet written.
  // The checkpoint stage (not the status column) drives this decision.

  test("'running' + ai_executed checkpoint → store_enrichment", () => {
    const cp = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, STARTED_AT)._checkpoint as AITaskCheckpoint;
    assert.equal(resolveResumeDecision("running", cp), "store_enrichment");
  });

  test("scenario 5: escalation + retry → store_enrichment (escalation data in checkpoint)", () => {
    // After an escalated run, the checkpoint contains the full escalation.
    // On retry, the decision is store_enrichment — AI is NOT re-run.
    const cp = buildAIExecutedCheckpoint(
      MOCK_RESULT, ESCALATED_MOCK_ESCALATION, STARTED_AT,
    )._checkpoint as AITaskCheckpoint;
    assert.equal(resolveResumeDecision("ai_executed", cp), "store_enrichment");
    // Verify escalation data is accessible (would be used to call storeEscalationResult)
    const esData = cp.escalationData as typeof ESCALATED_MOCK_ESCALATION;
    assert.equal(esData.escalated, true);
    assert.equal(esData.attempts.length, 2);
  });
});

describe("resolveResumeDecision: run_all scenarios (scenario 3: retry after failure)", () => {
  test("'failed' status + null checkpoint → run_all (retry from scratch)", () => {
    assert.equal(resolveResumeDecision("failed", null), "run_all");
  });

  test("'pending' status + null checkpoint → run_all", () => {
    assert.equal(resolveResumeDecision("pending", null), "run_all");
  });

  test("'running' status + null checkpoint → run_all", () => {
    // Running with no checkpoint: the previous invocation died before saving any
    // durable progress. Safest choice is to re-run everything.
    assert.equal(resolveResumeDecision("running", null), "run_all");
  });

  test("'none' (no existing job found) → run_all (scenario 9: different idempotency keys)", () => {
    // When no existing job is found for the idempotencyKey, the task creates a
    // new job and runs everything. Each unique key executes independently.
    assert.equal(resolveResumeDecision("none", null), "run_all");
  });

  test("unknown status + null checkpoint → run_all", () => {
    assert.equal(resolveResumeDecision("some_unknown_state", null), "run_all");
  });
});

// ── Scenario tests ────────────────────────────────────────────────────────────

describe("scenario 9: different idempotency keys execute independently", () => {
  test("two different keys both resolve to run_all when no existing job", () => {
    const d1 = resolveResumeDecision("none", null);
    const d2 = resolveResumeDecision("none", null);
    assert.equal(d1, "run_all");
    assert.equal(d2, "run_all");
    // Each would create its own job row and its own enrichment_runs records
  });

  test("key A completed does not affect key B (no interference)", () => {
    // Simulate: key A is completed, key B has no job
    const decisionA = resolveResumeDecision("completed", null);
    const decisionB = resolveResumeDecision("none", null);
    assert.equal(decisionA, "done");
    assert.equal(decisionB, "run_all");
  });
});

describe("scenario 10: concurrent duplicate requests", () => {
  test("two concurrent run_all decisions → both execute (documented limitation)", () => {
    // When two invocations run simultaneously and BOTH find no existing job,
    // BOTH resolve to run_all.  This means two jobs will be created and two
    // enrichment_run rows will be written — a known limitation addressed in Stage 12
    // via a DB-level unique constraint on (job_type, idempotencyKey).
    //
    // Trigger.dev's own .trigger(payload, { idempotencyKey }) prevents this at the
    // orchestration layer.  Our check is defense-in-depth for direct/manual triggers.
    //
    // This test documents the known behavior rather than asserting a fix.
    const concurrent1 = resolveResumeDecision("none", null);  // before job creation
    const concurrent2 = resolveResumeDecision("none", null);  // same point in time
    assert.equal(concurrent1, "run_all");
    assert.equal(concurrent2, "run_all");
    // Both would proceed. The Trigger.dev idempotencyKey prevents this in practice.
  });

  test("concurrent request arriving after first completes is idempotent", () => {
    // If the race is won by one invocation (it completes), the second finds
    // status="completed" and returns the cached result.
    const secondArrivalDecision = resolveResumeDecision("completed", null);
    assert.equal(secondArrivalDecision, "done");
  });
});
