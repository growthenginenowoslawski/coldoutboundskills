/**
 * GTM System — End-to-End Integration Test
 *
 * Exercises the full pipeline with FAKE/MOCK data:
 *   FAKE DATA → claimJob → checkpoint → runAIQualify → mock provider
 *   → pricing → storeEscalationResult → Supabase → checkpoints → completeJob
 *
 * ⚠️  All AI calls are MOCKED.  No real API keys are used.
 * ⚠️  All company data is clearly marked [E2E-TEST].
 * ⚠️  Test records are cleaned up after the run.
 *
 * Run: npx tsx scripts/e2e-test.ts
 */
import "../src/config/env.ts";
import { getSupabaseAdmin } from "../src/db/supabase.ts";
import { getJob, deleteJob } from "../src/db/jobs.ts";
import { FAKE_SCENARIOS, E2E_SOURCE } from "../src/testing/fake-dataset.ts";
import { createProviderFactory } from "../src/testing/scenario-providers.ts";
import { runE2ETask, type E2ETaskPayload } from "../src/testing/e2e-task-runner.ts";

// ── Client UUIDs (must be valid UUID format for enrichment_runs.client_id) ───

const CLIENT_GRAMSCODE = "e2e00001-0000-0000-0000-000000000001";
const CLIENT_ALPHA     = "e2e0a1fa-0000-0000-0000-000000000002";
const CLIENT_BETA      = "e2e0be7a-0000-0000-0000-000000000003";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Assertion {
  name: string;
  passed: boolean;
  actual: unknown;
  expected: string;
}

interface ScenarioResult {
  scenarioId: number;
  name: string;
  description: string;
  passed: boolean;
  assertions: Assertion[];
  durationMs: number;
  error?: string;
  jobId?: string;
  enrichmentRunIds?: string[];
}

// ── Assertion helpers ─────────────────────────────────────────────────────────

function assert(
  results: Assertion[],
  name: string,
  actual: unknown,
  expected: string,
  test: (v: unknown) => boolean,
): void {
  const passed = test(actual);
  results.push({ name, passed, actual, expected });
  if (!passed) {
    console.error(`  ✗ FAIL: ${name} — expected: ${expected}, got: ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function eq(a: unknown, b: unknown) { return a === b; }
function truthy(v: unknown) { return Boolean(v); }
function falsy(v: unknown) { return !v; }
function gte(min: number) { return (v: unknown) => typeof v === "number" && v >= min; }
function between(lo: number, hi: number) { return (v: unknown) => typeof v === "number" && v >= lo && v <= hi; }
function isUuid(v: unknown) { return typeof v === "string" && /^[0-9a-f-]{36}$/.test(v); }
function lengthEq(n: number) { return (v: unknown) => Array.isArray(v) && v.length === n; }
function lengthGte(n: number) { return (v: unknown) => Array.isArray(v) && v.length >= n; }

// ── DB helpers ────────────────────────────────────────────────────────────────

async function insertFakeCompany(
  dbRow: (typeof FAKE_SCENARIOS)[0]["companyDb"],
): Promise<string> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("companies")
    .insert(dbRow)
    .select("id")
    .single();
  if (error) throw new Error(`insertFakeCompany failed: ${error.message}`);
  return (data as { id: string }).id;
}

async function deleteCompany(id: string): Promise<void> {
  await getSupabaseAdmin().from("companies").delete().eq("id", id);
}

async function getEnrichmentRunsForJob(jobId: string): Promise<unknown[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("enrichment_runs")
    .select("*")
    .eq("job_id", jobId)
    .order("attempt_number", { ascending: true });
  if (error) throw new Error(`getEnrichmentRunsForJob failed: ${error.message}`);
  return (data ?? []) as unknown[];
}

async function deleteEnrichmentRunsForJob(jobId: string): Promise<void> {
  await getSupabaseAdmin().from("enrichment_runs").delete().eq("job_id", jobId);
}

async function countEnrichmentRunsForJob(jobId: string): Promise<number> {
  const runs = await getEnrichmentRunsForJob(jobId);
  return runs.length;
}

// ── Scenario runners ──────────────────────────────────────────────────────────

async function runScenario1(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[0];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 1: Clear ICP Fit ─────────────────────────────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s1`;
  const payload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 1,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  const r = await runE2ETask(payload, { providerFactory: createProviderFactory(1) });

  assert(A, "job created fresh", r.created, "true", eq.bind(null, true));
  assert(A, "job status = completed", r.job.status, "completed", eq.bind(null, "completed"));
  assert(A, "decision = run_all", r.decision, "run_all", eq.bind(null, "run_all"));
  assert(A, "output.icpFit = true", r.output?.icpFit, "true", eq.bind(null, true));
  assert(A, "output.attemptCount = 1", r.output?.attemptCount, "1", eq.bind(null, 1));
  assert(A, "output.escalated = false", r.output?.escalated, "false", eq.bind(null, false));
  assert(A, "output.confidence >= 0.75", r.output?.confidence, ">=0.75", gte(0.75));
  assert(A, "output.score between 0-100", r.output?.score, "0..100", between(0, 100));
  assert(A, "output.totalCostUsd is number", r.output?.totalCostUsd, "number", v => typeof v === "number");
  assert(A, "finalEnrichmentRunId is uuid", r.output?.finalEnrichmentRunId, "uuid", isUuid);

  const runs = await getEnrichmentRunsForJob(r.job.id);
  assert(A, "enrichment_runs count = 1", runs.length, "1", eq.bind(null, 1));
  const run0 = runs[0] as Record<string, unknown>;
  assert(A, "enrichment_run.job_id set", run0.job_id, "jobId", v => v === r.job.id);
  assert(A, "enrichment_run.attempt_number = 0", run0.attempt_number, "0", eq.bind(null, 0));
  assert(A, "enrichment_run.status = completed", run0.status, "completed", eq.bind(null, "completed"));
  assert(A, "enrichment_run.cost_usd is number", run0.cost_usd, "number", v => typeof v === "number");

  return {
    scenarioId: 1, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r.job.id, enrichmentRunIds: r.output?.enrichmentRunIds,
  };
}

async function runScenario2(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[1];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 2: Clear Non-ICP ─────────────────────────────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s2`;
  const payload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 2,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  const r = await runE2ETask(payload, { providerFactory: createProviderFactory(2) });

  assert(A, "job created fresh", r.created, "true", eq.bind(null, true));
  assert(A, "job status = completed", r.job.status, "completed", eq.bind(null, "completed"));
  assert(A, "output.icpFit = false", r.output?.icpFit, "false", eq.bind(null, false));
  assert(A, "output.attemptCount = 1", r.output?.attemptCount, "1", eq.bind(null, 1));
  assert(A, "output.escalated = false", r.output?.escalated, "false", eq.bind(null, false));
  assert(A, "output.confidence >= 0.75", r.output?.confidence, ">=0.75", gte(0.75));
  assert(A, "finalEnrichmentRunId is uuid", r.output?.finalEnrichmentRunId, "uuid", isUuid);

  const runs = await getEnrichmentRunsForJob(r.job.id);
  assert(A, "enrichment_runs count = 1", runs.length, "1", eq.bind(null, 1));
  const run0 = runs[0] as Record<string, unknown>;
  assert(A, "enrichment_run.job_id set", run0.job_id, "jobId", v => v === r.job.id);
  assert(A, "enrichment_run.company_id set", run0.company_id, "companyId", v => v === companyId);

  return {
    scenarioId: 2, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r.job.id,
  };
}

async function runScenario3(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[2];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 3: Borderline ICP ─────────────────────────────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s3`;
  const payload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 3,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  const r = await runE2ETask(payload, { providerFactory: createProviderFactory(3) });

  assert(A, "job status = completed", r.job.status, "completed", eq.bind(null, "completed"));
  assert(A, "output.icpFit = true", r.output?.icpFit, "true", eq.bind(null, true));
  assert(A, "output.attemptCount = 1", r.output?.attemptCount, "1", eq.bind(null, 1));
  assert(A, "output.confidence >= 0.75 (borderline)", r.output?.confidence, ">=0.75", gte(0.75));
  assert(A, "output.confidence < 0.80 (not high)", r.output?.confidence, "<0.80", v => typeof v === "number" && v < 0.80);
  assert(A, "finalEnrichmentRunId is uuid", r.output?.finalEnrichmentRunId, "uuid", isUuid);

  return {
    scenarioId: 3, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r.job.id,
  };
}

async function runScenario4(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[3];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 4: LOW → MEDIUM Escalation ───────────────────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s4`;
  const payload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 4,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  const r = await runE2ETask(payload, { providerFactory: createProviderFactory(4) });

  assert(A, "job status = completed", r.job.status, "completed", eq.bind(null, "completed"));
  assert(A, "output.icpFit = true", r.output?.icpFit, "true", eq.bind(null, true));
  assert(A, "output.attemptCount = 2", r.output?.attemptCount, "2", eq.bind(null, 2));
  assert(A, "output.escalated = true", r.output?.escalated, "true", eq.bind(null, true));
  assert(A, "output.model = sonnet (medium)", r.output?.model, "claude-sonnet-4-6",
    eq.bind(null, "claude-sonnet-4-6"));

  const runs = await getEnrichmentRunsForJob(r.job.id);
  assert(A, "enrichment_runs count = 2", runs.length, "2", eq.bind(null, 2));
  const run0 = runs[0] as Record<string, unknown>;
  const run1 = runs[1] as Record<string, unknown>;
  assert(A, "attempt-0 status = escalated", run0.status, "escalated", eq.bind(null, "escalated"));
  assert(A, "attempt-1 status = completed", run1.status, "completed", eq.bind(null, "completed"));
  assert(A, "attempt-0 number = 0", run0.attempt_number, "0", eq.bind(null, 0));
  assert(A, "attempt-1 number = 1", run1.attempt_number, "1", eq.bind(null, 1));
  assert(A, "attempt-1 escalated_from_run_id = attempt-0 id",
    run1.escalated_from_run_id, "run0.id", v => v === run0.id);

  return {
    scenarioId: 4, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r.job.id,
  };
}

async function runScenario5(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[4];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 5: LOW → MEDIUM (alt company) ─────────────────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s5`;
  const payload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 5,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  const r = await runE2ETask(payload, { providerFactory: createProviderFactory(5) });

  assert(A, "job status = completed", r.job.status, "completed", eq.bind(null, "completed"));
  assert(A, "output.escalated = true", r.output?.escalated, "true", eq.bind(null, true));
  assert(A, "output.attemptCount = 2", r.output?.attemptCount, "2", eq.bind(null, 2));

  const runs = await getEnrichmentRunsForJob(r.job.id);
  assert(A, "enrichment_runs count = 2", runs.length, "2", eq.bind(null, 2));

  return {
    scenarioId: 5, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r.job.id,
  };
}

async function runScenario6(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[5];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 6: Full 3-Tier Escalation (LOW→MED→HIGH) ──────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s6`;
  const payload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 6,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  const r = await runE2ETask(payload, { providerFactory: createProviderFactory(6) });

  assert(A, "job status = completed", r.job.status, "completed", eq.bind(null, "completed"));
  assert(A, "output.escalated = true", r.output?.escalated, "true", eq.bind(null, true));
  assert(A, "output.attemptCount = 3", r.output?.attemptCount, "3", eq.bind(null, 3));
  assert(A, "output.model = opus (high tier)", r.output?.model, "claude-opus-4-8",
    eq.bind(null, "claude-opus-4-8"));
  assert(A, "output.totalCostUsd > 0", r.output?.totalCostUsd, ">0", gte(0.000001));

  const runs = await getEnrichmentRunsForJob(r.job.id);
  assert(A, "enrichment_runs count = 3", runs.length, "3", eq.bind(null, 3));

  const r0 = runs[0] as Record<string, unknown>;
  const r1 = runs[1] as Record<string, unknown>;
  const r2 = runs[2] as Record<string, unknown>;
  assert(A, "attempt-0 escalated", r0.status, "escalated", eq.bind(null, "escalated"));
  assert(A, "attempt-1 escalated", r1.status, "escalated", eq.bind(null, "escalated"));
  assert(A, "attempt-2 completed", r2.status, "completed", eq.bind(null, "completed"));
  assert(A, "attempt-0 number = 0", r0.attempt_number, "0", eq.bind(null, 0));
  assert(A, "attempt-1 number = 1", r1.attempt_number, "1", eq.bind(null, 1));
  assert(A, "attempt-2 number = 2", r2.attempt_number, "2", eq.bind(null, 2));
  assert(A, "escalation chain linked r1→r0", r1.escalated_from_run_id, "r0.id", v => v === r0.id);
  assert(A, "escalation chain linked r2→r1", r2.escalated_from_run_id, "r1.id", v => v === r1.id);
  assert(A, "enrichment_run output_data set on final", truthy(r2.output_data), "truthy", truthy);

  return {
    scenarioId: 6, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r.job.id,
    enrichmentRunIds: [r0.id as string, r1.id as string, r2.id as string],
  };
}

async function runScenario7(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[6];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 7: Provider Failure ───────────────────────────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s7`;
  const payload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 7,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  const r = await runE2ETask(payload, { providerFactory: createProviderFactory(7) });

  assert(A, "task returned failure reason", truthy(r.failureReason), "truthy", truthy);
  assert(A, "failure reason contains TEST marker", r.failureReason, "contains [TEST]",
    v => typeof v === "string" && v.includes("[TEST]"));
  assert(A, "job status = failed", r.job.status, "failed", eq.bind(null, "failed"));

  // Re-fetch to confirm the DB write
  const latestJob = await getJob(r.job.id);
  assert(A, "DB job.status = failed", latestJob?.status, "failed", eq.bind(null, "failed"));

  const runCount = await countEnrichmentRunsForJob(r.job.id);
  assert(A, "enrichment_runs = 0 (AI failed before DB write)", runCount, "0", eq.bind(null, 0));

  return {
    scenarioId: 7, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r.job.id,
    error: r.failureReason,
  };
}

async function runScenario8(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[7];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 8: Retry After Checkpoint-1 ──────────────────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s8`;
  const basePayload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 8,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  // ── Run 1: stop after AI checkpoint ─────────────────────────────────────

  console.log("  [Run 1/2] stopAfterAI=true...");
  const r1 = await runE2ETask(basePayload, {
    providerFactory: createProviderFactory(8),
    stopAfterAI: true,
  });

  assert(A, "run1 created fresh job", r1.created, "true", eq.bind(null, true));
  assert(A, "run1 stoppedAt = ai_executed", r1.stoppedAt, "ai_executed", eq.bind(null, "ai_executed"));
  assert(A, "run1 job status = running", r1.job.status, "running", eq.bind(null, "running"));
  assert(A, "run1 no enrichment_runs yet", await countEnrichmentRunsForJob(r1.job.id), "0", eq.bind(null, 0));

  // Verify checkpoint-1 was written
  const jobAfterRun1 = await getJob(r1.job.id);
  const outputData = jobAfterRun1?.output_data as Record<string, unknown> | null;
  const cpStage = (outputData?._checkpoint as Record<string, unknown>)?.stage;
  assert(A, "checkpoint stage = ai_executed in DB", cpStage, "ai_executed", eq.bind(null, "ai_executed"));

  // ── Run 2: resume from checkpoint ───────────────────────────────────────

  console.log("  [Run 2/2] resuming from checkpoint-1...");
  const r2 = await runE2ETask(basePayload, { providerFactory: createProviderFactory(8) });

  assert(A, "run2 found existing job", r2.created, "false", eq.bind(null, false));
  assert(A, "run2 decision = store_enrichment", r2.decision, "store_enrichment",
    eq.bind(null, "store_enrichment"));
  assert(A, "run2 job status = completed", r2.job.status, "completed", eq.bind(null, "completed"));

  const runs = await getEnrichmentRunsForJob(r2.job.id);
  assert(A, "exactly 1 enrichment run (no duplicate from AI)", runs.length, "1", eq.bind(null, 1));
  assert(A, "finalEnrichmentRunId is uuid", r2.output?.finalEnrichmentRunId, "uuid", isUuid);

  return {
    scenarioId: 8, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r2.job.id,
  };
}

async function runScenario9(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[8];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 9: Duplicate Submission ──────────────────────────");

  const idempotencyKey = `e2e:${companyId}:icp_qualification:s9`;
  const payload: E2ETaskPayload & { _scenarioId: number } = {
    _scenarioId: 9,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey,
    clientId: undefined,
    input: scenario.qualInput,
  };

  // ── First submission ─────────────────────────────────────────────────────

  console.log("  [Submit 1/2] first submission...");
  const r1 = await runE2ETask(payload, { providerFactory: createProviderFactory(9) });

  assert(A, "first: created = true", r1.created, "true", eq.bind(null, true));
  assert(A, "first: status = completed", r1.job.status, "completed", eq.bind(null, "completed"));
  assert(A, "first: output.icpFit = true", r1.output?.icpFit, "true", eq.bind(null, true));

  const jobIdFirstRun = r1.job.id;
  const runsAfterFirst = await countEnrichmentRunsForJob(jobIdFirstRun);
  assert(A, "first: 1 enrichment run written", runsAfterFirst, "1", eq.bind(null, 1));

  // ── Second submission (duplicate) ────────────────────────────────────────

  console.log("  [Submit 2/2] duplicate submission...");
  const r2 = await runE2ETask(payload, { providerFactory: createProviderFactory(9) });

  assert(A, "second: created = false (found existing)", r2.created, "false", eq.bind(null, false));
  assert(A, "second: decision = done", r2.decision, "done", eq.bind(null, "done"));
  assert(A, "second: same job ID", r2.job.id, jobIdFirstRun, eq.bind(null, jobIdFirstRun));
  assert(A, "second: status still completed", r2.job.status, "completed", eq.bind(null, "completed"));

  // Verify no extra enrichment runs were written
  const runsAfterSecond = await countEnrichmentRunsForJob(jobIdFirstRun);
  assert(A, "still only 1 enrichment run (no duplicate write)", runsAfterSecond, "1", eq.bind(null, 1));

  return {
    scenarioId: 9, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: r1.job.id,
  };
}

async function runScenario10(companyId: string): Promise<ScenarioResult> {
  const scenario = FAKE_SCENARIOS[9];
  const A: Assertion[] = [];
  const t0 = Date.now();
  console.log("\n── Scenario 10: Multi-Client Isolation ────────────────────────");

  // Isolation is tested at the job level (separate keys → separate jobs).
  // client_id is null in enrichment_runs (FK constraint prevents fake UUIDs).
  const keyA = `e2e:${companyId}:icp_qualification:s10:alpha`;
  const keyB = `e2e:${companyId}:icp_qualification:s10:beta`;

  const makePayload = (key: string): E2ETaskPayload & { _scenarioId: number } => ({
    _scenarioId: 10,
    companyId,
    taskType: "icp_qualification",
    idempotencyKey: key,
    clientId: undefined,
    input: scenario.qualInput,
  });

  console.log("  [Client A — key suffix: alpha]...");
  const rA = await runE2ETask(makePayload(keyA), { providerFactory: createProviderFactory(10) });

  console.log("  [Client B — key suffix: beta]...");
  const rB = await runE2ETask(makePayload(keyB), { providerFactory: createProviderFactory(10) });

  assert(A, "clientA: created fresh job", rA.created, "true", eq.bind(null, true));
  assert(A, "clientB: created fresh job", rB.created, "true", eq.bind(null, true));
  assert(A, "two distinct job IDs", rA.job.id, "!= rB.job.id", v => v !== rB.job.id);
  assert(A, "clientA: status completed", rA.job.status, "completed", eq.bind(null, "completed"));
  assert(A, "clientB: status completed", rB.job.status, "completed", eq.bind(null, "completed"));

  // Each client should have their own enrichment run
  const runsA = await getEnrichmentRunsForJob(rA.job.id);
  const runsB = await getEnrichmentRunsForJob(rB.job.id);
  assert(A, "clientA: 1 enrichment run", runsA.length, "1", eq.bind(null, 1));
  assert(A, "clientB: 1 enrichment run", runsB.length, "1", eq.bind(null, 1));

  const runA0 = (runsA[0] ?? {}) as Record<string, unknown>;
  const runB0 = (runsB[0] ?? {}) as Record<string, unknown>;
  // Isolation proven via separate job_ids on each enrichment_run
  assert(A, "clientA enrichment: job_id = rA.job.id", runA0.job_id, "rA.job.id", v => v === rA.job.id);
  assert(A, "clientB enrichment: job_id = rB.job.id", runB0.job_id, "rB.job.id", v => v === rB.job.id);
  assert(A, "enrichment run IDs are distinct", runA0.id, "!= runB0.id", v => v !== undefined && v !== runB0.id);

  return {
    scenarioId: 10, name: scenario.name, description: scenario.description,
    passed: A.every(a => a.passed), assertions: A,
    durationMs: Date.now() - t0, jobId: rA.job.id,
  };
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(companyIds: string[], jobIds: string[]): Promise<void> {
  console.log("\n── Cleanup ────────────────────────────────────────────────────");
  for (const jobId of jobIds) {
    if (!jobId) continue;
    try {
      await deleteEnrichmentRunsForJob(jobId);
      await deleteJob(jobId);
      console.log(`  deleted job ${jobId}`);
    } catch (e) {
      console.warn(`  cleanup warning for job ${jobId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (const cid of companyIds) {
    try {
      await deleteCompany(cid);
      console.log(`  deleted company ${cid}`);
    } catch (e) {
      console.warn(`  cleanup warning for company ${cid}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

function printReport(results: ScenarioResult[], totalDurationMs: number): void {
  const totalAssertions = results.reduce((s, r) => s + r.assertions.length, 0);
  const passedAssertions = results.reduce((s, r) => s + r.assertions.filter(a => a.passed).length, 0);
  const passedScenarios = results.filter(r => r.passed).length;

  console.log(`
═══════════════════════════════════════════════════════════════
GTM SYSTEM END-TO-END TEST — ${new Date().toISOString().slice(0, 10)}
───────────────────────────────────────────────────────────────
Environment : TEST (FAKE data, MOCK AI provider)
Run mode    : Integration (real Supabase, mocked AI)
AI API calls: 0 (all mocked — no real tokens consumed)
Total time  : ${(totalDurationMs / 1000).toFixed(2)}s
───────────────────────────────────────────────────────────────
SCENARIOS   : ${passedScenarios}/${results.length} passed
ASSERTIONS  : ${passedAssertions}/${totalAssertions} passed
OVERALL     : ${passedScenarios === results.length ? "✓ PASS" : "✗ FAIL"}
═══════════════════════════════════════════════════════════════
`);

  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    const failedAssertions = r.assertions.filter(a => !a.passed);
    console.log(`${icon} Scenario ${r.scenarioId}: ${r.name}`);
    console.log(`  ${r.description}`);
    console.log(`  Assertions: ${r.assertions.filter(a => a.passed).length}/${r.assertions.length}  |  ${r.durationMs}ms`);
    if (!r.passed) {
      for (const fa of failedAssertions) {
        console.log(`  ✗ ${fa.name}: expected "${fa.expected}", got ${JSON.stringify(fa.actual)}`);
      }
    }
    if (r.error) {
      console.log(`  Error: ${r.error.slice(0, 100)}`);
    }
    console.log();
  }
}

function printCommunicationMap(): void {
  console.log(`
═══════════════════════════════════════════════════════════════
COMMUNICATION MAP — GTM PIPELINE DATA FLOW
═══════════════════════════════════════════════════════════════

  [E2E Test] → claimJob({ jobType:"ai_qualify", idempotencyKey, ... })
     ↓ sends:   job_type, idempotency_key, status:"pending"
     ↓ to:      Supabase.jobs INSERT (partial unique index enforces 1 active job per key)
     ← returns: { job: JobRow, created: boolean }
     → stored:  jobs.idempotency_key, jobs.status="pending"

  [E2E Task Runner] → readCheckpoint(job.output_data)
     ↓ reads:   jobs.output_data._checkpoint.stage
     ← returns: AITaskCheckpoint | null

  [E2E Task Runner] → resolveResumeDecision(status, checkpoint)
     ← returns: "done" | "complete_job" | "store_enrichment" | "run_all"

  ── If decision = "run_all" (fresh execution) ──

  [E2E Task Runner] → updateJob(id, { status:"running" })
     → stored:  jobs.status = "running"

  [E2E Task Runner] → runAIQualify(payload, { providerFactory })
     ↓ sends:   QualificationInput (company + ICP data)
     ↓ to:      EscalationRouter.qualify(input, config, { providerFactory })
       ↓ calls: providerFactory("icp_qualification", "low")
         ↓ to:  MockProvider.qualifyCompany(input)
         ← returns: QualificationResult { icpFit, confidence, score, model, inputTokens, outputTokens }
       ↓ calls: executeQualification(provider, input)
         ← returns: ExecutionResult { result, latencyMs, costUsd, inputTokens, outputTokens }
       ↓ if confidence < 0.75 AND tier < high → escalate to next tier
     ← returns: EscalationResult { result, attempts[], totalCostUsd, escalated }
   ← returns: AIQualifyExecution { result: AIQualifyResult, escalation, startedAt }
   → stored:  (in memory only at this point)

  [E2E Task Runner] → updateJob(id, { outputData: buildAIExecutedCheckpoint(...) })
     ↓ sends:   { _checkpoint: { stage:"ai_executed", result, escalationData, startedAt } }
     → stored:  jobs.output_data._checkpoint.stage = "ai_executed"
     ← note:    If task crashes here, retry will read checkpoint and skip AI re-run

  ── If decision = "store_enrichment" (retry from checkpoint-1) ──
  ← reads AI result + escalation from checkpoint instead of re-calling AI

  [E2E Task Runner] → storeEscalationResult(companyId, input, escalation, taskType, startedAt, { clientId, jobId })
     ↓ for each attempt in escalation.attempts:
       ↓ calls: insertOrFindEnrichmentRun(db, row, jobId, attemptNumber)
         ↓ sends:  enrichment_runs INSERT with:
                   company_id, job_id, attempt_number, provider, operation, status,
                   input_data, output_data (final only), gateway, task_type,
                   latency_ms, cost_usd, escalated_from_run_id
         → stored: enrichment_runs row
         ← returns: enrichment_run.id
         ← on duplicate (23505): SELECT existing by (job_id, attempt_number) → return existing id
     ← returns: { runIds: string[], finalRunId: string }

  [E2E Task Runner] → updateJob(id, { outputData: buildEnrichmentStoredCheckpoint(...) })
     → stored:  jobs.output_data._checkpoint.stage = "enrichment_stored"

  [E2E Task Runner] → completeJob(id, { successfulItems:1, outputData: finalOutput })
     → stored:  jobs.status = "completed", jobs.completed_at = now()
                jobs.output_data = { icpFit, score, confidence, model, gateway,
                                     totalCostUsd, attemptCount, escalated,
                                     enrichmentRunIds[], finalEnrichmentRunId }

  ← [E2E Test] verifies: job.status, enrichment_runs count, attempt chain, cost_usd, etc.

═══════════════════════════════════════════════════════════════
`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("GTM System — End-to-End Integration Test");
  console.log("⚠  All data is TEST/FAKE. No real AI API calls.\n");

  const t0 = Date.now();
  const companyIds: string[] = [];
  const results: ScenarioResult[] = [];
  const allJobIds: string[] = [];

  // Insert all 10 fake companies upfront
  console.log("── Inserting fake company rows ────────────────────────────────");
  for (const scenario of FAKE_SCENARIOS) {
    try {
      const id = await insertFakeCompany(scenario.companyDb);
      companyIds.push(id);
      console.log(`  [s${scenario.scenarioId}] inserted: ${scenario.companyDb.name} → ${id}`);
    } catch (e) {
      console.error(`  [s${scenario.scenarioId}] INSERT FAILED: ${e instanceof Error ? e.message : e}`);
      companyIds.push(""); // keep index alignment
    }
  }

  // Run all scenarios
  const scenarioRunners = [
    () => runScenario1(companyIds[0]),
    () => runScenario2(companyIds[1]),
    () => runScenario3(companyIds[2]),
    () => runScenario4(companyIds[3]),
    () => runScenario5(companyIds[4]),
    () => runScenario6(companyIds[5]),
    () => runScenario7(companyIds[6]),
    () => runScenario8(companyIds[7]),
    () => runScenario9(companyIds[8]),
    () => runScenario10(companyIds[9]),
  ];

  for (const run of scenarioRunners) {
    try {
      const result = await run();
      results.push(result);
      if (result.jobId) allJobIds.push(result.jobId);
      // Scenario 10 has a second job (client B)
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`  Scenario runner threw: ${err}`);
      results.push({
        scenarioId: results.length + 1,
        name: "unknown",
        description: "scenario runner crashed",
        passed: false,
        assertions: [{ name: "runner did not throw", passed: false, actual: err, expected: "no error" }],
        durationMs: 0,
        error: err,
      });
    }
  }

  // Collect scenario-10 client B job ID for cleanup
  // (we can't easily get it from results without more plumbing; clean by source instead)
  // Clean up all e2e jobs by scanning for the test source
  console.log("\n── Collecting scenario-10 extra job for cleanup...");
  try {
    const db = getSupabaseAdmin();
    const { data: extraJobs } = await db
      .from("jobs")
      .select("id")
      .like("idempotency_key", "e2e:%:s10:%");
    if (extraJobs) {
      for (const j of extraJobs as { id: string }[]) allJobIds.push(j.id);
    }
  } catch { /* non-critical */ }

  // Cleanup
  await cleanup(companyIds.filter(Boolean), allJobIds.filter(Boolean));

  // Delete probe script
  try { await import("node:fs").then(fs => fs.promises.unlink(new URL("../scripts/_probe-companies.ts", import.meta.url))); } catch { /* ok */ }

  // Report
  printReport(results, Date.now() - t0);
  printCommunicationMap();

  const allPassed = results.every(r => r.passed);
  if (!allPassed) process.exit(1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
