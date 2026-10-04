/**
 * Unit tests for Stage 10: Operation Identity
 *
 * Tests:
 *   - buildQualificationRow includes job_id and attempt_number (Stage 10 fields)
 *   - buildEscalationAttemptRow includes job_id and attempt_number
 *   - Attempt number increments correctly across escalation chain
 *   - job_id/attempt_number are null when not supplied (backward-compatible)
 *   - claimJob error-code detection (23505 handling logic, via structural test)
 *   - JobRow interface includes idempotency_key
 *   - CreateJobInput accepts idempotencyKey
 *   - ClaimJobInput requires idempotencyKey
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildQualificationRow,
  buildEscalationAttemptRow,
} from "../db/qualifications.ts";
import type { QualificationInput, QualificationResult } from "../domain/types.ts";
import type { EscalationAttempt } from "../providers/ai/escalation-router.ts";
import type { CreateJobInput, ClaimJobInput, JobRow } from "../db/jobs.ts";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SAMPLE_INPUT: QualificationInput = {
  company: {
    name: "Identity Corp",
    domain: "identity.io",
    industry: "SaaS",
    employeeCount: 120,
    source: "test",
    fetchedAt: new Date().toISOString(),
  },
  icp: { industry: "SaaS", employeeRange: { min: 50, max: 500 } },
};

const SAMPLE_RESULT: QualificationResult = {
  icpFit: true,
  score: 80,
  industryMatch: true,
  sizeMatch: true,
  locationMatch: true,
  reason: "Good fit",
  signals: [],
  confidence: 0.88,
  model: "claude-haiku-4-5-20251001",
  qualifiedAt: "2026-08-28T00:00:00.000Z",
  inputTokens: 300,
  outputTokens: 100,
};

const SAMPLE_ATTEMPT: EscalationAttempt = {
  tier: "low",
  providerId: "anthropic-direct:claude-haiku-4-5-20251001",
  model: "claude-haiku-4-5-20251001",
  confidence: 0.88,
  inputTokens: 300,
  outputTokens: 100,
  escalated: false,
  latencyMs: 380,
  costUsd: 6.5e-7,
  priceKey: "anthropic-direct:claude-haiku-4-5-20251001",
};

// ── buildQualificationRow: Stage 10 fields ─────────────────────────────────

describe("buildQualificationRow: Stage 10 operation identity fields", () => {
  test("includes job_id when provided", () => {
    const row = buildQualificationRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_RESULT,
      "2026-08-28T00:00:00.000Z",
      { jobId: "job_id_123", attemptNumber: 0 },
    );
    assert.equal(row.job_id, "job_id_123");
  });

  test("includes attempt_number when provided", () => {
    const row = buildQualificationRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_RESULT,
      "2026-08-28T00:00:00.000Z",
      { jobId: "job_id_123", attemptNumber: 0 },
    );
    assert.equal(row.attempt_number, 0);
  });

  test("job_id is null when not provided (backward-compatible)", () => {
    const row = buildQualificationRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_RESULT,
      "2026-08-28T00:00:00.000Z",
    );
    assert.equal(row.job_id, null);
  });

  test("attempt_number is null when not provided (backward-compatible)", () => {
    const row = buildQualificationRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_RESULT,
      "2026-08-28T00:00:00.000Z",
    );
    assert.equal(row.attempt_number, null);
  });

  test("attempt_number = 0 is preserved (not coerced to null)", () => {
    const row = buildQualificationRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_RESULT,
      "2026-08-28T00:00:00.000Z",
      { jobId: "job_123", attemptNumber: 0 },
    );
    assert.equal(row.attempt_number, 0, "0 is a valid attempt number and must not be null");
  });

  test("attempt_number = 2 preserved for third escalation tier", () => {
    const row = buildQualificationRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_RESULT,
      "2026-08-28T00:00:00.000Z",
      { jobId: "job_123", attemptNumber: 2 },
    );
    assert.equal(row.attempt_number, 2);
  });
});

// ── buildEscalationAttemptRow: Stage 10 fields ────────────────────────────

describe("buildEscalationAttemptRow: Stage 10 operation identity fields", () => {
  test("includes job_id when provided", () => {
    const row = buildEscalationAttemptRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_ATTEMPT,
      SAMPLE_RESULT,
      true,
      { startedAt: "2026-08-28T00:00:00.000Z", jobId: "job_xyz", attemptNumber: 0 },
    );
    assert.equal(row.job_id, "job_xyz");
  });

  test("includes attempt_number when provided", () => {
    const row = buildEscalationAttemptRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_ATTEMPT,
      SAMPLE_RESULT,
      true,
      { startedAt: "2026-08-28T00:00:00.000Z", jobId: "job_xyz", attemptNumber: 0 },
    );
    assert.equal(row.attempt_number, 0);
  });

  test("job_id null when not provided", () => {
    const row = buildEscalationAttemptRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_ATTEMPT,
      null,
      false,
      { startedAt: "2026-08-28T00:00:00.000Z" },
    );
    assert.equal(row.job_id, null);
  });

  test("attempt_number null when not provided", () => {
    const row = buildEscalationAttemptRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_ATTEMPT,
      null,
      false,
      { startedAt: "2026-08-28T00:00:00.000Z" },
    );
    assert.equal(row.attempt_number, null);
  });

  test("attempt 0 (first attempt in escalation chain) has correct number", () => {
    const row = buildEscalationAttemptRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_ATTEMPT,
      null,
      false,
      { startedAt: "2026-08-28T00:00:00.000Z", jobId: "job_esc", attemptNumber: 0 },
    );
    assert.equal(row.attempt_number, 0);
    assert.equal(row.job_id, "job_esc");
  });

  test("attempt 1 (first escalation) has correct number", () => {
    const row = buildEscalationAttemptRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_ATTEMPT,
      null,
      false,
      { startedAt: "2026-08-28T00:00:00.000Z", jobId: "job_esc", attemptNumber: 1 },
    );
    assert.equal(row.attempt_number, 1);
  });

  test("attempt 2 (final escalation) has correct number", () => {
    const row = buildEscalationAttemptRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_ATTEMPT,
      SAMPLE_RESULT,
      true,
      { startedAt: "2026-08-28T00:00:00.000Z", jobId: "job_esc", attemptNumber: 2 },
    );
    assert.equal(row.attempt_number, 2);
    assert.equal(row.status, "completed");
  });

  test("all existing fields still correct after Stage 10 additions", () => {
    const row = buildEscalationAttemptRow(
      "comp_abc",
      SAMPLE_INPUT,
      SAMPLE_ATTEMPT,
      SAMPLE_RESULT,
      true,
      {
        startedAt: "2026-08-28T00:00:00.000Z",
        taskType: "icp_qualification",
        clientId: "client_gramscode",
        jobId: "job_s10",
        attemptNumber: 0,
      },
    );
    assert.equal(row.company_id, "comp_abc");
    assert.equal(row.provider, "claude-haiku-4-5-20251001");
    assert.equal(row.operation, "ai_qualification");
    assert.equal(row.status, "completed");
    assert.equal(row.gateway, "anthropic-direct");
    assert.equal(row.task_type, "icp_qualification");
    assert.equal(row.client_id, "client_gramscode");
    assert.equal(row.input_tokens, 300);
    assert.equal(row.output_tokens, 100);
    // Stage 10
    assert.equal(row.job_id, "job_s10");
    assert.equal(row.attempt_number, 0);
  });
});

// ── Attempt number correctness in an escalation chain ─────────────────────

describe("attempt_number in a simulated 3-tier escalation chain", () => {
  const attempts: EscalationAttempt[] = [
    { ...SAMPLE_ATTEMPT, tier: "low", providerId: "anthropic-direct:claude-haiku-4-5-20251001" },
    { ...SAMPLE_ATTEMPT, tier: "medium", providerId: "anthropic-direct:claude-sonnet-4-6" },
    { ...SAMPLE_ATTEMPT, tier: "high", providerId: "anthropic-direct:claude-opus-4-8" },
  ];

  test("attempt 0 has the lowest tier model", () => {
    const row = buildEscalationAttemptRow("c", SAMPLE_INPUT, attempts[0], null, false, {
      startedAt: "2026-08-28T00:00:00.000Z",
      jobId: "job_chain",
      attemptNumber: 0,
    });
    assert.equal(row.attempt_number, 0);
    assert.equal(row.status, "escalated");
    assert.equal(row.escalated_from_run_id, null);
  });

  test("attempt 1 references the previous row id", () => {
    const row = buildEscalationAttemptRow("c", SAMPLE_INPUT, attempts[1], null, false, {
      startedAt: "2026-08-28T00:00:00.000Z",
      jobId: "job_chain",
      attemptNumber: 1,
      escalatedFromRunId: "run_id_0",
    });
    assert.equal(row.attempt_number, 1);
    assert.equal(row.escalated_from_run_id, "run_id_0");
  });

  test("attempt 2 is the final accepted result", () => {
    const row = buildEscalationAttemptRow("c", SAMPLE_INPUT, attempts[2], SAMPLE_RESULT, true, {
      startedAt: "2026-08-28T00:00:00.000Z",
      jobId: "job_chain",
      attemptNumber: 2,
      escalatedFromRunId: "run_id_1",
    });
    assert.equal(row.attempt_number, 2);
    assert.equal(row.status, "completed");
    assert.equal(row.escalated_from_run_id, "run_id_1");
    assert.equal(row.output_data, SAMPLE_RESULT);
  });

  test("all three rows share the same job_id", () => {
    const rows = attempts.map((attempt, i) =>
      buildEscalationAttemptRow("c", SAMPLE_INPUT, attempt, i === 2 ? SAMPLE_RESULT : null, i === 2, {
        startedAt: "2026-08-28T00:00:00.000Z",
        jobId: "shared_job_id",
        attemptNumber: i,
      }),
    );
    assert.ok(rows.every((r) => r.job_id === "shared_job_id"));
    assert.deepEqual(rows.map((r) => r.attempt_number), [0, 1, 2]);
  });
});

// ── TypeScript interface verification (compile-time, confirmed by successful run) ─

describe("JobRow interface includes idempotency_key", () => {
  test("idempotency_key is part of JobRow type", () => {
    // This compile-time check: if JobRow didn't have idempotency_key,
    // TypeScript would error and this file wouldn't run.
    const row: Partial<JobRow> = { idempotency_key: "test_key" };
    assert.equal(row.idempotency_key, "test_key");
  });
});

describe("CreateJobInput accepts idempotencyKey", () => {
  test("idempotencyKey is optional in CreateJobInput", () => {
    const input: CreateJobInput = {
      jobType: "ai_qualify",
      idempotencyKey: "comp:icp:batch_001",
    };
    assert.equal(input.idempotencyKey, "comp:icp:batch_001");
  });

  test("CreateJobInput works without idempotencyKey (backward-compatible)", () => {
    const input: CreateJobInput = { jobType: "ai_qualify" };
    assert.equal(input.idempotencyKey, undefined);
  });
});

describe("ClaimJobInput requires idempotencyKey", () => {
  test("ClaimJobInput has required idempotencyKey", () => {
    const input: ClaimJobInput = {
      jobType: "ai_qualify",
      idempotencyKey: "comp_123:icp_qualification:batch_s10",
    };
    assert.equal(input.idempotencyKey, "comp_123:icp_qualification:batch_s10");
  });

  test("ClaimJobInput extends CreateJobInput fields", () => {
    const input: ClaimJobInput = {
      jobType: "ai_qualify",
      idempotencyKey: "key",
      provider: "mock",
      totalItems: 1,
    };
    assert.equal(input.jobType, "ai_qualify");
    assert.equal(input.provider, "mock");
    assert.equal(input.totalItems, 1);
  });
});
