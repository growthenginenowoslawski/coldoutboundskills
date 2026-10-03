/**
 * Stage 5 — AI observability: offline tests for the pure row-builder functions.
 *
 * No database, no API keys.  Tests verify that buildQualificationRow and
 * buildEscalationAttemptRow map every field correctly to the DB column names
 * expected by the 0008_ai_observability migration.
 *
 * Coverage:
 *   extractGateway           — providerId → gateway name
 *   buildQualificationRow    — all columns including Stage 5 additions
 *   buildEscalationAttemptRow — intermediate vs. final attempt rows
 *   Escalation chain linking — escalated_from_run_id, status field
 *   Token tracking           — per-attempt token fields
 *   Error / failure rows     — status=failed, error_message
 *   Defaults / nullability   — cache_hit always null, optional fields default to null
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractGateway,
  buildQualificationRow,
  buildEscalationAttemptRow,
} from "../db/qualifications";
import type { StoreQualificationOptions } from "../db/qualifications";
import type { QualificationInput, QualificationResult } from "../domain/types";
import type { EscalationAttempt } from "../providers/ai/escalation-router";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DUMMY_INPUT: QualificationInput = {
  company: {
    name: "Acme Ltd",
    domain: "acme.com",
    industry: "SaaS",
    city: "London",
    region: "England",
    country: "UK",
    employeeCount: 50,
    source: "test",
    fetchedAt: "2026-08-26T10:00:00.000Z",
  },
  icp: {
    industry: "SaaS",
    location: "UK",
    employeeRange: { min: 10, max: 200 },
  },
  signals: ["recently hired VP Sales"],
};

const DUMMY_RESULT: QualificationResult = {
  icpFit: true,
  score: 82,
  industryMatch: true,
  sizeMatch: true,
  locationMatch: true,
  reason: "Strong ICP match",
  signals: ["SaaS industry confirmed"],
  confidence: 0.87,
  model: "claude-haiku-4-5-20251001",
  qualifiedAt: "2026-08-26T10:00:01.500Z",
  inputTokens: 350,
  outputTokens: 120,
};

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const STARTED_AT = "2026-08-26T10:00:00.000Z";

// ── extractGateway ────────────────────────────────────────────────────────────

test("extractGateway: anthropic-direct providerId", () => {
  assert.equal(extractGateway("anthropic-direct:claude-opus-4-8"), "anthropic-direct");
});

test("extractGateway: openrouter providerId", () => {
  assert.equal(extractGateway("openrouter:anthropic/claude-haiku-4-5-20251001"), "openrouter");
});

test("extractGateway: haiku full openrouter id", () => {
  assert.equal(
    extractGateway("openrouter:anthropic/claude-haiku-4-5-20251001"),
    "openrouter",
  );
});

test("extractGateway: id with no colon returns null", () => {
  assert.equal(extractGateway("anthropic-direct"), null);
});

test("extractGateway: empty string returns null", () => {
  assert.equal(extractGateway(""), null);
});

test("extractGateway: colon at position 0 returns null (no gateway name)", () => {
  assert.equal(extractGateway(":model"), null);
});

test("extractGateway: only captures the part before the FIRST colon", () => {
  // openrouter model names sometimes have colons in unusual formats
  assert.equal(extractGateway("my-gateway:model:with:colons"), "my-gateway");
});

// ── buildQualificationRow — core fields ───────────────────────────────────────

test("buildQualificationRow: company_id is set", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.company_id, COMPANY_ID);
});

test("buildQualificationRow: provider stores model name from result", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.provider, "claude-haiku-4-5-20251001");
});

test("buildQualificationRow: operation is always ai_qualification", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.operation, "ai_qualification");
});

test("buildQualificationRow: status is completed by default", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.status, "completed");
});

test("buildQualificationRow: status is failed when errorMessage is present", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    errorMessage: "API timeout",
  });
  assert.equal(row.status, "failed");
});

test("buildQualificationRow: started_at is passed through", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.started_at, STARTED_AT);
});

test("buildQualificationRow: completed_at comes from result.qualifiedAt", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.completed_at, DUMMY_RESULT.qualifiedAt);
});

test("buildQualificationRow: input_tokens from result", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.input_tokens, 350);
});

test("buildQualificationRow: output_tokens from result", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.output_tokens, 120);
});

test("buildQualificationRow: input_tokens is null when result has none", () => {
  const r = { ...DUMMY_RESULT, inputTokens: undefined };
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, r, STARTED_AT);
  assert.equal(row.input_tokens, null);
});

test("buildQualificationRow: output_tokens is null when result has none", () => {
  const r = { ...DUMMY_RESULT, outputTokens: undefined };
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, r, STARTED_AT);
  assert.equal(row.output_tokens, null);
});

// ── buildQualificationRow — Stage 5 observability fields ─────────────────────

test("buildQualificationRow: gateway stored from opts.gateway", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    gateway: "anthropic-direct",
  });
  assert.equal(row.gateway, "anthropic-direct");
});

test("buildQualificationRow: task_type stored from opts.taskType", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    taskType: "icp_qualification",
  });
  assert.equal(row.task_type, "icp_qualification");
});

test("buildQualificationRow: latency_ms stored from opts.latencyMs", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    latencyMs: 1500,
  });
  assert.equal(row.latency_ms, 1500);
});

test("buildQualificationRow: cost_usd stored from opts.costUsd", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    costUsd: 0.00042,
  });
  assert.equal(row.cost_usd, 0.00042);
});

test("buildQualificationRow: error_message stored from opts.errorMessage", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    errorMessage: "Rate limit exceeded",
  });
  assert.equal(row.error_message, "Rate limit exceeded");
});

test("buildQualificationRow: escalated_from_run_id stored from opts", () => {
  const prevId = "11111111-0000-0000-0000-000000000000";
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    escalatedFromRunId: prevId,
  });
  assert.equal(row.escalated_from_run_id, prevId);
});

test("buildQualificationRow: cache_hit is always null (caching not implemented)", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    gateway: "openrouter",
  });
  assert.equal(row.cache_hit, null);
});

// ── buildQualificationRow — null defaults ─────────────────────────────────────

test("buildQualificationRow: all Stage 5 fields default to null when opts omitted", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  assert.equal(row.gateway, null);
  assert.equal(row.task_type, null);
  assert.equal(row.latency_ms, null);
  assert.equal(row.cost_usd, null);
  assert.equal(row.error_message, null);
  assert.equal(row.cache_hit, null);
  assert.equal(row.escalated_from_run_id, null);
  assert.equal(row.client_id, null);
});

test("buildQualificationRow: clientId maps to client_id column", () => {
  const clientId = "22222222-0000-0000-0000-000000000002";
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, {
    clientId,
  });
  assert.equal(row.client_id, clientId);
});

// ── buildQualificationRow — input_data snapshot ───────────────────────────────

test("buildQualificationRow: input_data contains company name", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  const snap = row.input_data as { company: { name: string } };
  assert.equal(snap.company.name, "Acme Ltd");
});

test("buildQualificationRow: input_data contains icp", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  const snap = row.input_data as { icp: { industry?: string } };
  assert.equal(snap.icp.industry, "SaaS");
});

test("buildQualificationRow: input_data contains signals array", () => {
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT);
  const snap = row.input_data as { signals: string[] };
  assert.deepEqual(snap.signals, ["recently hired VP Sales"]);
});

test("buildQualificationRow: input_data omits raw company payload", () => {
  const inputWithRaw: QualificationInput = {
    ...DUMMY_INPUT,
    company: { ...DUMMY_INPUT.company, raw: { secret: "internal-data" } },
  };
  const row = buildQualificationRow(COMPANY_ID, inputWithRaw, DUMMY_RESULT, STARTED_AT);
  const snap = row.input_data as Record<string, unknown>;
  assert.ok(!("raw" in (snap.company as object)), "raw payload must not appear in input_data");
});

test("buildQualificationRow: input_data signals defaults to empty array when absent", () => {
  const inputNoSignals: QualificationInput = { company: DUMMY_INPUT.company, icp: DUMMY_INPUT.icp };
  const row = buildQualificationRow(COMPANY_ID, inputNoSignals, DUMMY_RESULT, STARTED_AT);
  const snap = row.input_data as { signals: unknown[] };
  assert.deepEqual(snap.signals, []);
});

// ── buildEscalationAttemptRow — intermediate attempt ─────────────────────────

const INTERMEDIATE_ATTEMPT: EscalationAttempt = {
  tier: "low",
  providerId: "anthropic-direct:claude-haiku-4-5-20251001",
  model: "claude-haiku-4-5-20251001",
  confidence: 0.50,
  inputTokens: 200,
  outputTokens: 80,
  escalated: true,
  latencyMs: 150,
  costUsd: 0.00042,
  priceKey: "anthropic-direct:claude-haiku-4-5-20251001",
};

const FINAL_ATTEMPT: EscalationAttempt = {
  tier: "high",
  providerId: "anthropic-direct:claude-opus-4-8",
  model: "claude-opus-4-8",
  confidence: 0.92,
  inputTokens: 800,
  outputTokens: 300,
  escalated: false,
  latencyMs: 800,
  costUsd: 0.0345,
  priceKey: "anthropic-direct:claude-opus-4-8",
};

test("buildEscalationAttemptRow: intermediate — status is escalated", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.status, "escalated");
});

test("buildEscalationAttemptRow: final — status is completed", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, FINAL_ATTEMPT, DUMMY_RESULT, true,
    { startedAt: STARTED_AT, completedAt: DUMMY_RESULT.qualifiedAt },
  );
  assert.equal(row.status, "completed");
});

test("buildEscalationAttemptRow: intermediate — output_data is null", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.output_data, null);
});

test("buildEscalationAttemptRow: final — output_data contains the result", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, FINAL_ATTEMPT, DUMMY_RESULT, true,
    { startedAt: STARTED_AT, completedAt: DUMMY_RESULT.qualifiedAt },
  );
  const od = row.output_data as QualificationResult;
  assert.equal(od.model, "claude-haiku-4-5-20251001");
  assert.equal(od.score, 82);
});

test("buildEscalationAttemptRow: provider comes from attempt.model", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.provider, "claude-haiku-4-5-20251001");
});

test("buildEscalationAttemptRow: gateway extracted from attempt.providerId", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.gateway, "anthropic-direct");
});

test("buildEscalationAttemptRow: openrouter gateway extracted correctly", () => {
  const orAttempt: EscalationAttempt = {
    ...INTERMEDIATE_ATTEMPT,
    providerId: "openrouter:anthropic/claude-haiku-4-5-20251001",
    model: "anthropic/claude-haiku-4-5-20251001",
    priceKey: "openrouter:anthropic/claude-haiku-4-5-20251001",
  };
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, orAttempt, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.gateway, "openrouter");
});

test("buildEscalationAttemptRow: input_tokens from attempt", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.input_tokens, 200);
});

test("buildEscalationAttemptRow: output_tokens from attempt", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.output_tokens, 80);
});

test("buildEscalationAttemptRow: task_type from opts", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT, taskType: "icp_qualification" },
  );
  assert.equal(row.task_type, "icp_qualification");
});

// ── Escalation chain linking ──────────────────────────────────────────────────

test("chain: first attempt has escalated_from_run_id null", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },  // no escalatedFromRunId
  );
  assert.equal(row.escalated_from_run_id, null);
});

test("chain: second attempt has escalated_from_run_id pointing to first row", () => {
  const firstRowId = "aaaaaaaa-0000-0000-0000-000000000001";
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, FINAL_ATTEMPT, DUMMY_RESULT, true,
    {
      startedAt: STARTED_AT,
      completedAt: DUMMY_RESULT.qualifiedAt,
      escalatedFromRunId: firstRowId,
    },
  );
  assert.equal(row.escalated_from_run_id, firstRowId);
});

test("chain: three-attempt chain — middle row links to first, final links to middle", () => {
  const firstId = "aaaa-0000-0000-0000-000000000001";
  const middleId = "bbbb-0000-0000-0000-000000000002";

  const mediumAttempt: EscalationAttempt = {
    tier: "medium",
    providerId: "anthropic-direct:claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
    confidence: 0.60,
    inputTokens: 400,
    outputTokens: 150,
    escalated: true,
    latencyMs: 350,
    costUsd: null,
    priceKey: null,
  };

  const middleRow = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, mediumAttempt, null, false,
    { startedAt: STARTED_AT, escalatedFromRunId: firstId },
  );
  assert.equal(middleRow.escalated_from_run_id, firstId);
  assert.equal(middleRow.status, "escalated");

  const finalRow = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, FINAL_ATTEMPT, DUMMY_RESULT, true,
    {
      startedAt: STARTED_AT,
      completedAt: DUMMY_RESULT.qualifiedAt,
      escalatedFromRunId: middleId,
    },
  );
  assert.equal(finalRow.escalated_from_run_id, middleId);
  assert.equal(finalRow.status, "completed");
});

// ── Timing fields ─────────────────────────────────────────────────────────────

test("buildEscalationAttemptRow: intermediate — completed_at is null", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.completed_at, null);
});

test("buildEscalationAttemptRow: final — completed_at set from opts", () => {
  const completedAt = "2026-08-26T10:00:02.000Z";
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, FINAL_ATTEMPT, DUMMY_RESULT, true,
    { startedAt: STARTED_AT, completedAt },
  );
  assert.equal(row.completed_at, completedAt);
});

test("buildEscalationAttemptRow: intermediate — latency_ms from attempt (not null)", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  assert.equal(row.latency_ms, INTERMEDIATE_ATTEMPT.latencyMs);
});

test("buildEscalationAttemptRow: final — latency_ms from attempt (not from opts)", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, FINAL_ATTEMPT, DUMMY_RESULT, true,
    { startedAt: STARTED_AT, latencyMs: 3200 },  // opts.latencyMs ignored — attempt wins
  );
  assert.equal(row.latency_ms, FINAL_ATTEMPT.latencyMs);
});

// ── cache_hit invariant ───────────────────────────────────────────────────────

test("buildEscalationAttemptRow: cache_hit is always null", () => {
  const intermediate = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, INTERMEDIATE_ATTEMPT, null, false,
    { startedAt: STARTED_AT },
  );
  const final = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, FINAL_ATTEMPT, DUMMY_RESULT, true,
    { startedAt: STARTED_AT },
  );
  assert.equal(intermediate.cache_hit, null);
  assert.equal(final.cache_hit, null);
});

// ── Per-attempt token tracking ────────────────────────────────────────────────

test("token tracking: each attempt row carries its own token counts", () => {
  const attempts: EscalationAttempt[] = [
    {
      tier: "low",
      providerId: "openrouter:anthropic/claude-haiku-4-5-20251001",
      model: "anthropic/claude-haiku-4-5-20251001",
      confidence: 0.40,
      inputTokens: 100,
      outputTokens: 40,
      escalated: true,
      latencyMs: 120,
      costUsd: null,
      priceKey: null,
    },
    {
      tier: "medium",
      providerId: "openrouter:anthropic/claude-sonnet-4-6",
      model: "anthropic/claude-sonnet-4-6",
      confidence: 0.88,
      inputTokens: 300,
      outputTokens: 90,
      escalated: false,
      latencyMs: 400,
      costUsd: null,
      priceKey: null,
    },
  ];

  const rows = attempts.map((attempt, i) => {
    const isFinal = i === attempts.length - 1;
    return buildEscalationAttemptRow(
      COMPANY_ID, DUMMY_INPUT, attempt, isFinal ? DUMMY_RESULT : null, isFinal,
      { startedAt: STARTED_AT, taskType: "icp_qualification" },
    );
  });

  assert.equal(rows[0].input_tokens, 100);
  assert.equal(rows[0].output_tokens, 40);
  assert.equal(rows[1].input_tokens, 300);
  assert.equal(rows[1].output_tokens, 90);
});

// ── Full observability — all new columns present in row ───────────────────────

test("buildQualificationRow: all Stage 5 column names are present in the row", () => {
  const opts: StoreQualificationOptions = {
    gateway: "anthropic-direct",
    taskType: "icp_qualification",
    latencyMs: 1234,
    costUsd: 0.0012,
    errorMessage: undefined,
    escalatedFromRunId: undefined,
    clientId: "some-client-uuid",
  };
  const row = buildQualificationRow(COMPANY_ID, DUMMY_INPUT, DUMMY_RESULT, STARTED_AT, opts);

  const EXPECTED_COLUMNS = [
    "company_id", "provider", "operation", "status",
    "input_data", "output_data", "started_at", "completed_at",
    "input_tokens", "output_tokens", "client_id",
    // Stage 5:
    "gateway", "task_type", "latency_ms", "cost_usd",
    "error_message", "cache_hit", "escalated_from_run_id",
  ];
  for (const col of EXPECTED_COLUMNS) {
    assert.ok(col in row, `Missing column: ${col}`);
  }
});

test("buildEscalationAttemptRow: all Stage 5 column names are present in the row", () => {
  const row = buildEscalationAttemptRow(
    COMPANY_ID, DUMMY_INPUT, FINAL_ATTEMPT, DUMMY_RESULT, true,
    {
      startedAt: STARTED_AT,
      completedAt: DUMMY_RESULT.qualifiedAt,
      taskType: "icp_qualification",
      clientId: "some-client-uuid",
      latencyMs: 2000,
    },
  );

  const EXPECTED_COLUMNS = [
    "company_id", "provider", "operation", "status",
    "input_data", "output_data", "started_at", "completed_at",
    "input_tokens", "output_tokens", "client_id",
    "gateway", "task_type", "latency_ms", "cost_usd",
    "error_message", "cache_hit", "escalated_from_run_id",
  ];
  for (const col of EXPECTED_COLUMNS) {
    assert.ok(col in row, `Missing column: ${col}`);
  }
});
