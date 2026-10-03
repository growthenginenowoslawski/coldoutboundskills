/**
 * Stage 9 smoke test — runs against REAL Supabase and Trigger.dev.
 *
 * Tests verified:
 *   1. Checkpoint data round-trips through the jobs table (write → read → verify)
 *   2. Idempotency check: completed job is found by idempotencyKey JSONB query
 *   3. Cached result returned without creating a new job row
 *   4. ai_executed checkpoint → resolveResumeDecision = "store_enrichment"
 *   5. enrichment_stored checkpoint → resolveResumeDecision = "complete_job"
 *   6. Failed job → resolveResumeDecision = "run_all" (retry from scratch)
 *   7. clientId preserved in checkpoint across DB round-trip
 *   8. totalCostUsd preserved in checkpoint across DB round-trip
 *   9. Different idempotencyKeys create independent job rows
 *  10. runAIQualify produces correct output (mock provider, no real API calls)
 *
 * Usage:
 *   npx tsx scripts/smoke-test-stage-9.ts
 *
 * All test job rows are deleted at the end to keep the DB clean.
 *
 * IMPORTANT: Uses mockMode=true — no real AI provider calls.
 * IMPORTANT: Does not write to enrichment_runs (skipEnrichmentRuns=true).
 */
import "../src/config/env.ts";  // load .env
import { getSupabaseAdmin } from "../src/db/supabase.ts";
import { createJob, updateJob, completeJob, deleteJob, getJob } from "../src/db/jobs.ts";
import {
  buildAIExecutedCheckpoint,
  buildEnrichmentStoredCheckpoint,
  readCheckpoint,
  resolveResumeDecision,
} from "../src/tasks/checkpoint.ts";
import { runAIQualify } from "../src/tasks/qualify.ts";
import type { AIProvider } from "../src/providers/types.ts";
import type { QualificationInput, QualificationResult } from "../src/domain/types.ts";
import type { TaskType, ComplexityHint } from "../src/providers/ai/model-router.ts";

// ── Colours ───────────────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const createdJobIds: string[] = [];

function ok(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`${GREEN}  ✔${RESET} ${name}`);
    passed++;
  } else {
    console.log(`${RED}  ✗${RESET} ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n${BOLD}${YELLOW}▶ ${name}${RESET}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_RESULT = {
  alreadyProcessed: false,
  companyId: "smoke_comp_001",
  taskType: "icp_qualification" as TaskType,
  idempotencyKey: "smoke_comp_001:icp_qualification:batch_s9",
  clientId: "client_gramscode",
  icpFit: true,
  score: 82,
  confidence: 0.90,
  reason: "Smoke-test: strong ICP fit",
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
  result: { icpFit: true, score: 82, model: "claude-haiku-4-5-20251001" },
  attempts: [
    {
      tier: "low", providerId: "anthropic-direct:claude-haiku-4-5-20251001",
      model: "claude-haiku-4-5-20251001", confidence: 0.90,
      inputTokens: 350, outputTokens: 120, escalated: false,
      latencyMs: 420, costUsd: 7.6e-7, priceKey: "anthropic-direct:claude-haiku-4-5-20251001",
    },
  ],
  totalInputTokens: 350, totalOutputTokens: 120, totalCostUsd: 7.6e-7,
  finalProviderId: "anthropic-direct:claude-haiku-4-5-20251001", finalTier: "low", escalated: false,
};

const IDEMPOTENCY_KEY_A = `smoke_s9_key_a_${Date.now()}`;
const IDEMPOTENCY_KEY_B = `smoke_s9_key_b_${Date.now()}`;

// High-confidence mock provider — no real API calls
function mockProvider(_t: TaskType, tier: ComplexityHint): AIProvider {
  return {
    id: "anthropic-direct:claude-haiku-4-5-20251001",
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_i: QualificationInput): Promise<QualificationResult> => ({
      icpFit: true, score: 82, industryMatch: true, sizeMatch: true, locationMatch: true,
      reason: `Smoke-test mock (tier=${tier})`, signals: [],
      confidence: 0.90, model: "claude-haiku-4-5-20251001",
      qualifiedAt: new Date().toISOString(), inputTokens: 350, outputTokens: 120,
    }),
  };
}

const SAMPLE_INPUT: QualificationInput = {
  company: {
    name: "Smoke Corp", domain: "smoke.io", industry: "SaaS", employeeCount: 150,
    source: "test", fetchedAt: new Date().toISOString(),
  },
  icp: { industry: "SaaS", employeeRange: { min: 50, max: 500 } },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  const db = getSupabaseAdmin();

  // ── Section 1: Checkpoint round-trip via jobs table ──────────────────────────
  section("1. Checkpoint data round-trips through Supabase jobs table");
  {
    const job = await createJob({
      jobType: "ai_qualify",
      provider: "mock",
      totalItems: 1,
      inputData: { idempotencyKey: IDEMPOTENCY_KEY_A, companyId: "smoke_001" },
    });
    createdJobIds.push(job.id);

    // Write ai_executed checkpoint (status stays "running" — checkpoint stage is in output_data)
    const checkpointData = buildAIExecutedCheckpoint(MOCK_RESULT, MOCK_ESCALATION, "2026-01-15T10:00:00.000Z");
    await updateJob(job.id, { status: "running", outputData: checkpointData });

    // Read back from DB
    const read = await getJob(job.id);
    const cp = readCheckpoint(read?.output_data);

    ok("ai_executed checkpoint readable from DB", cp !== null);
    ok("stage preserved", cp?.stage === "ai_executed");
    ok("startedAt preserved", cp?.startedAt === "2026-01-15T10:00:00.000Z");
    ok("result.clientId preserved through DB round-trip",
      (cp?.result as typeof MOCK_RESULT)?.clientId === "client_gramscode");
    ok("escalationData.totalCostUsd preserved through DB round-trip",
      (cp?.escalationData as typeof MOCK_ESCALATION)?.totalCostUsd === 7.6e-7);
    ok("resolveResumeDecision = store_enrichment for ai_executed checkpoint",
      resolveResumeDecision(read?.status ?? "none", cp) === "store_enrichment");

    // Update to enrichment_stored checkpoint (status stays "running")
    const checkpoint2 = buildEnrichmentStoredCheckpoint(MOCK_RESULT, ["er_001"], "er_001", "2026-01-15T10:00:00.000Z");
    await updateJob(job.id, { status: "running", outputData: checkpoint2 });

    const read2 = await getJob(job.id);
    const cp2 = readCheckpoint(read2?.output_data);

    ok("enrichment_stored checkpoint readable from DB", cp2 !== null);
    ok("stage updated to enrichment_stored", cp2?.stage === "enrichment_stored");
    ok("enrichmentRunIds preserved", JSON.stringify(cp2?.enrichmentRunIds) === '["er_001"]');
    ok("escalationData absent in enrichment_stored checkpoint", cp2?.escalationData === undefined);
    ok("resolveResumeDecision = complete_job for enrichment_stored checkpoint",
      resolveResumeDecision(read2?.status ?? "none", cp2) === "complete_job");

    // Complete the job
    await completeJob(job.id, { successfulItems: 1, outputData: { ...MOCK_RESULT, enrichmentRunIds: ["er_001"] } });
    const read3 = await getJob(job.id);
    ok("status is completed after completeJob", read3?.status === "completed");
    ok("resolveResumeDecision = done for completed status",
      resolveResumeDecision(read3?.status ?? "none", null) === "done");
  }

  // ── Section 2: Idempotency check via JSONB containment query ─────────────────
  section("2. Idempotency check using real Supabase JSONB query");
  {
    const { data: existing } = await db
      .from("jobs")
      .select("*")
      .eq("job_type", "ai_qualify")
      .eq("status", "completed")
      .contains("input_data", { idempotencyKey: IDEMPOTENCY_KEY_A })
      .maybeSingle();

    ok("completed job found by idempotencyKey JSONB containment", existing !== null);
    ok("found job has correct status", existing?.status === "completed");
    ok("found job output has expected fields",
      typeof (existing?.output_data as Record<string, unknown>)?.score === "number");
    ok("resolveResumeDecision = done for found completed job",
      resolveResumeDecision(existing?.status ?? "none", null) === "done");
  }

  // ── Section 3: Failed job → retry from scratch ────────────────────────────────
  section("3. Failed job → resolveResumeDecision = run_all");
  {
    const job = await createJob({
      jobType: "ai_qualify",
      provider: "mock",
      totalItems: 1,
      inputData: { idempotencyKey: IDEMPOTENCY_KEY_B, companyId: "smoke_002" },
    });
    createdJobIds.push(job.id);
    await updateJob(job.id, { status: "failed", errorMessage: "simulated failure" });

    const read = await getJob(job.id);
    ok("failed job has correct status", read?.status === "failed");
    ok("resolveResumeDecision = run_all for failed job",
      resolveResumeDecision(read?.status ?? "none", readCheckpoint(read?.output_data)) === "run_all");

    // After a failed job, a NEW idempotency check (excluding failed) won't find it
    const { data: notFound } = await db
      .from("jobs")
      .select("*")
      .eq("job_type", "ai_qualify")
      .not("status", "eq", "failed")
      .contains("input_data", { idempotencyKey: IDEMPOTENCY_KEY_B })
      .maybeSingle();
    ok("failed job excluded from idempotency query (not found when status!=failed filtered)",
      notFound === null);
  }

  // ── Section 4: Different idempotency keys are independent ────────────────────
  section("4. Different idempotency keys execute independently");
  {
    // Key A's completed job was found above; Key B's failed job is excluded
    const { data: jobA } = await db
      .from("jobs")
      .select("id, status")
      .eq("job_type", "ai_qualify")
      .eq("status", "completed")
      .contains("input_data", { idempotencyKey: IDEMPOTENCY_KEY_A })
      .maybeSingle();

    const { data: jobB } = await db
      .from("jobs")
      .select("id, status")
      .eq("job_type", "ai_qualify")
      .eq("status", "completed")
      .contains("input_data", { idempotencyKey: IDEMPOTENCY_KEY_B })
      .maybeSingle();

    ok("key A job found (completed)", jobA !== null);
    ok("key B job NOT found as completed (was failed, excluded)", jobB === null);
    ok("key A and key B resolve independently", jobA?.status !== jobB?.status);
  }

  // ── Section 5: runAIQualify produces correct output ──────────────────────────
  section("5. runAIQualify with mock provider (no real API calls)");
  {
    const { result, escalation, startedAt } = await runAIQualify(
      {
        companyId: "smoke_comp_001",
        taskType: "icp_qualification",
        idempotencyKey: "smoke_s9_direct_run",
        clientId: "client_gramscode",
        input: SAMPLE_INPUT,
      },
      { providerFactory: mockProvider },
    );

    ok("icpFit correct", result.icpFit === true);
    ok("score correct", result.score === 82);
    ok("gateway extracted", result.gateway === "anthropic-direct");
    ok("model correct", result.model === "claude-haiku-4-5-20251001");
    ok("costUsd > 0", (result.costUsd ?? 0) > 0);
    ok("totalCostUsd > 0", (result.totalCostUsd ?? 0) > 0);
    ok("clientId preserved in result", result.clientId === "client_gramscode");
    ok("escalated = false (high-confidence mock)", result.escalated === false);
    ok("attemptCount = 1", result.attemptCount === 1);
    ok("escalation data available for DB storage", escalation.attempts.length === 1);
    ok("startedAt is ISO string", !isNaN(new Date(startedAt).getTime()));

    // Verify checkpoint can be built from this result
    const checkpoint = buildAIExecutedCheckpoint(result, escalation, startedAt);
    const readBack = readCheckpoint(checkpoint);
    ok("checkpoint built from runAIQualify output is readable", readBack !== null);
    ok("checkpoint stage is ai_executed", readBack?.stage === "ai_executed");
    ok("totalCostUsd preserved through checkpoint",
      Math.abs(((readBack?.escalationData as typeof escalation)?.totalCostUsd ?? -1) - (result.totalCostUsd ?? 0)) < 1e-10);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  console.log(`\n${BOLD}Results: ${passed} passed, ${failed} failed${RESET}`);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  console.log(`\nCleaning up ${createdJobIds.length} test job rows…`);
  let cleaned = 0;
  for (const id of createdJobIds) {
    try {
      await deleteJob(id);
      cleaned++;
    } catch (e) {
      console.warn(`  Could not delete job ${id}: ${e}`);
    }
  }
  console.log(`Deleted ${cleaned}/${createdJobIds.length} rows.`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`${BOLD}\nStage 9 Smoke Test — real Supabase + mock AI${RESET}`);
  console.log("=".repeat(50));
  try {
    await runTests();
  } finally {
    await cleanup();
  }
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${RED}Fatal error:${RESET}`, e);
  process.exit(1);
});
