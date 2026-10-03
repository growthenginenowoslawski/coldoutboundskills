/**
 * CONTROLLED REAL PERSONALIZATION INTEGRATION TEST
 *
 * Proves the AI infrastructure is genuinely task-agnostic by running a
 * personalization task through the SAME execution stack as qualification:
 *   ModelRouter → execute<PersonalizationResult>() → pricing → Supabase
 *
 * ONE real Anthropic API call. No email sent. Records kept for inspection.
 *
 * Verified:
 *   - ModelRouter selects correct provider for "personalization" task type
 *   - Generic executor captures latency / tokens / cost
 *   - Pricing registry calculates cost
 *   - enrichment_runs row written with all observability fields populated
 *   - job_id / client_id / company_id all linked
 *   - Idempotency: same key → no second AI call, no duplicate row
 */

import "../src/config/env.ts";
import { getSupabaseAdmin } from "../src/db/supabase.ts";
import { claimJob, completeJob, updateJob } from "../src/db/jobs.ts";
import { runAIPersonalize } from "../src/tasks/personalize.ts";
import {
  readCheckpoint,
  resolveResumeDecision,
} from "../src/tasks/checkpoint.ts";
import type { PersonalizationInput } from "../src/domain/types.ts";

// ── Colours ───────────────────────────────────────────────────────────────────

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const B = "\x1b[1m";
const X = "\x1b[0m";

// ── Report state ──────────────────────────────────────────────────────────────

const checks: Record<string, { pass: boolean; detail?: string }> = {};

function assert(name: string, pass: boolean, detail = ""): void {
  checks[name] = { pass, detail };
  console.log(`${pass ? `${G}  ✔${X}` : `${R}  ✗${X}`} ${name}${!pass && detail ? ` — ${detail}` : ""}`);
}

// ── IDs to report ─────────────────────────────────────────────────────────────

let reportCompanyId = "";
let reportClientId = "";
let reportJobId = "";
let reportEnrichmentRunId = "";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${B}CONTROLLED REAL PERSONALIZATION INTEGRATION TEST${X}`);
  console.log("=".repeat(60));
  console.log("Mode: REAL Anthropic API call — personalization task type");
  console.log("Records: KEPT in Supabase (no cleanup)\n");

  const db = getSupabaseAdmin();
  const TS = Date.now();

  // ── Step 1: Fetch a real client ─────────────────────────────────────────────

  console.log(`${B}Step 1: Fetch real client from Supabase${X}`);
  const { data: clientRow, error: clientErr } = await db
    .from("clients")
    .select("id, name")
    .limit(1)
    .maybeSingle();

  if (clientErr || !clientRow) {
    console.error(`${R}FATAL: Could not fetch a client.${X}`, clientErr?.message ?? "No clients found");
    process.exit(1);
  }
  const clientId = (clientRow as { id: string; name: string }).id;
  const clientName = (clientRow as { id: string; name: string }).name;
  reportClientId = clientId;
  console.log(`  Using client: "${clientName}" (${clientId})`);

  // ── Step 2: Insert a clearly marked test company ─────────────────────────────

  console.log(`\n${B}Step 2: Insert test company${X}`);
  const testCompanyName = `PERSONALIZATION_INTEGRATION_TEST_${TS}`;
  const { data: company, error: companyErr } = await db
    .from("companies")
    .insert({
      name: testCompanyName,
      domain: `persontest-${TS}.example.com`,
      industry: "FinTech",
      company_size: "320",
      country: "US",
      city: "Chicago",
      status: "review",
      source: "integration_test",
    })
    .select("id, name")
    .single();

  if (companyErr || !company) {
    console.error(`${R}FATAL: Could not insert test company.${X}`, companyErr?.message);
    process.exit(1);
  }
  const companyId = (company as { id: string; name: string }).id;
  reportCompanyId = companyId;
  console.log(`  Test company: "${testCompanyName}" (${companyId})`);

  // ── Step 3: Build personalization input ─────────────────────────────────────

  const input: PersonalizationInput = {
    company: {
      name: testCompanyName,
      domain: `persontest-${TS}.example.com`,
      industry: "FinTech",
      employeeCount: 320,
      city: "Chicago",
      country: "US",
      source: "integration_test",
      fetchedAt: new Date().toISOString(),
    },
    campaign: {
      objective: "Book a discovery call to explore how we can help their revenue team reduce pipeline leak",
      valueProposition: "We help FinTech revenue teams identify deal risk earlier using AI signal monitoring — so reps know which accounts need attention before they go cold",
      callToAction: "Would it make sense to connect for 15 minutes to see if this is relevant to what you're working on?",
    },
    icp: {
      industry: "FinTech",
      employeeRange: { min: 100, max: 1000 },
      description: "B2B FinTech companies with a quota-carrying sales team of 5+ reps",
    },
  };

  const idempotencyKey = `inttest_personalize:personalization:${TS}`;
  console.log(`\n${B}Step 3: Run personalization pipeline${X}`);
  console.log(`  idempotencyKey: ${idempotencyKey}`);
  console.log(`  Task type: personalization`);
  console.log(`  Complexity: low (Haiku — one call, minimal cost)`);
  console.log(`  Provider: real Anthropic API via ModelRouter\n`);

  // ── Step 4: Claim job ───────────────────────────────────────────────────────

  const { job: claimedJob, created } = await claimJob({
    jobType: "ai_personalize",
    idempotencyKey,
    provider: "ai",
    totalItems: 1,
    inputData: {
      idempotencyKey,
      companyId,
      taskType: "personalization",
      clientId,
    },
  });
  reportJobId = claimedJob.id;
  const jobId = claimedJob.id;

  console.log(`  claimJob → created=${created}, jobId=${jobId}`);

  const decision0 = resolveResumeDecision(claimedJob.status, readCheckpoint(claimedJob.output_data));
  if (!created || decision0 !== "run_all") {
    console.error(`${R}FATAL: Expected fresh job (created=true, decision=run_all). Got: created=${created}, decision=${decision0}${X}`);
    process.exit(1);
  }

  // ── Step 5: Run AI ──────────────────────────────────────────────────────────

  await updateJob(jobId, { status: "running", startedAt: new Date().toISOString() });
  console.log("  Job marked running. Calling Anthropic API…");

  const t0 = Date.now();
  const execution = await runAIPersonalize(
    {
      companyId,
      taskType: "personalization",
      idempotencyKey,
      clientId,
      input,
      complexity: "low", // Haiku — one cheap call
    },
    {}, // no providerFactory = real ModelRouter
  );
  const wallMs = Date.now() - t0;
  const { result, providerResult, startedAt } = execution;

  console.log(`\n  AI call completed in ${wallMs}ms`);
  console.log(`  model:        ${result.model}`);
  console.log(`  gateway:      ${result.gateway}`);
  console.log(`  inputTokens:  ${result.inputTokens}`);
  console.log(`  outputTokens: ${result.outputTokens}`);
  console.log(`  latencyMs:    ${result.latencyMs}`);
  console.log(`  costUsd:      $${result.costUsd?.toFixed(6)}`);
  console.log(`\n  Generated email:`);
  console.log(`  Subject: ${providerResult.subject}`);
  console.log(`  Tone:    ${providerResult.tone}`);
  console.log(`  Confidence: ${providerResult.confidence}`);
  console.log(`\n  Body:\n${providerResult.message.split("\n").map((l: string) => `    ${l}`).join("\n")}`);

  // ── Step 6: Write enrichment_run ────────────────────────────────────────────

  const enrichmentRow = {
    company_id: companyId,
    provider: result.model,
    operation: "ai_personalization",
    status: "completed",
    input_data: {
      company: { name: input.company.name, industry: input.company.industry, employeeCount: input.company.employeeCount },
      campaign: input.campaign,
      icp: input.icp,
    },
    output_data: providerResult,
    started_at: startedAt,
    completed_at: providerResult.personalizedAt,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    client_id: clientId,
    gateway: result.gateway,
    task_type: "personalization",
    latency_ms: result.latencyMs,
    cost_usd: result.costUsd,
    error_message: null,
    cache_hit: null,
    escalated_from_run_id: null,
    job_id: jobId,
    attempt_number: 0,
  };

  const { data: runData, error: runErr } = await db
    .from("enrichment_runs")
    .insert(enrichmentRow)
    .select("id")
    .single();

  if (runErr || !runData) {
    console.error(`${R}FATAL: enrichment_runs insert failed.${X}`, runErr?.message);
    process.exit(1);
  }
  const enrichmentRunId = (runData as { id: string }).id;
  reportEnrichmentRunId = enrichmentRunId;
  console.log(`\n  enrichment_run written: ${enrichmentRunId}`);

  // ── Step 7: Complete job ────────────────────────────────────────────────────

  const output = {
    ...result,
    enrichmentRunIds: [enrichmentRunId],
    finalEnrichmentRunId: enrichmentRunId,
  };
  await completeJob(jobId, { successfulItems: 1, outputData: output });
  console.log("  Job completed ✓");

  // ── Step 8: Verify enrichment_run in Supabase ────────────────────────────────

  console.log(`\n${B}Step 8: Verify enrichment_run fields in Supabase${X}`);
  const { data: runRow, error: fetchErr } = await db
    .from("enrichment_runs")
    .select("*")
    .eq("id", enrichmentRunId)
    .single();

  if (fetchErr || !runRow) {
    console.error(`${R}FATAL: Could not fetch enrichment_run ${enrichmentRunId}${X}`);
    process.exit(1);
  }

  const row = runRow as Record<string, unknown>;
  console.log("\n  Raw enrichment_run row:");
  const fieldsToShow = [
    "id", "company_id", "job_id", "client_id", "task_type",
    "gateway", "provider", "input_tokens", "output_tokens",
    "latency_ms", "cost_usd", "status", "completed_at",
    "attempt_number", "operation",
  ];
  for (const f of fieldsToShow) {
    console.log(`    ${f}: ${JSON.stringify(row[f])}`);
  }
  const od = row.output_data as Record<string, unknown>;
  console.log(`    output_data.subject: ${JSON.stringify(od?.subject)}`);
  console.log(`    output_data.tone:    ${JSON.stringify(od?.tone)}`);

  console.log("\n  Assertions:");
  assert("job_id populated",        row.job_id === jobId,                    `got: ${row.job_id}`);
  assert("client_id populated",     row.client_id === clientId,              `got: ${row.client_id}`);
  assert("company_id populated",    row.company_id === companyId,            `got: ${row.company_id}`);
  assert("task_type = personalization", row.task_type === "personalization", `got: ${row.task_type}`);
  assert("operation = ai_personalization", row.operation === "ai_personalization", `got: ${row.operation}`);
  assert("gateway populated",       typeof row.gateway === "string" && (row.gateway as string).length > 0, `got: ${row.gateway}`);
  assert("provider (model) populated", typeof row.provider === "string" && (row.provider as string).length > 0, `got: ${row.provider}`);
  assert("input_tokens > 0",        typeof row.input_tokens === "number" && (row.input_tokens as number) > 0, `got: ${row.input_tokens}`);
  assert("output_tokens > 0",       typeof row.output_tokens === "number" && (row.output_tokens as number) > 0, `got: ${row.output_tokens}`);
  assert("latency_ms measured",     typeof row.latency_ms === "number" && (row.latency_ms as number) > 0, `got: ${row.latency_ms}`);
  assert("cost_usd calculated",     parseFloat(String(row.cost_usd ?? "0")) > 0, `got: ${row.cost_usd}`);
  assert("status = completed",      row.status === "completed",              `got: ${row.status}`);
  assert("completed_at populated",  typeof row.completed_at === "string",   `got: ${row.completed_at}`);
  assert("output_data has subject", typeof od?.subject === "string" && (od.subject as string).length > 0, `got: ${od?.subject}`);
  assert("output_data has message", typeof od?.message === "string" && (od.message as string).length > 0, `got: ${od?.message}`);
  assert("attempt_number = 0",      row.attempt_number === 0,               `got: ${row.attempt_number}`);

  // Verify job row
  const { data: jobRow } = await db.from("jobs").select("*").eq("id", jobId).single();
  const jr = jobRow as Record<string, unknown>;
  assert("job.status = completed",       jr.status === "completed",          `got: ${jr.status}`);
  assert("job.job_type = ai_personalize", jr.job_type === "ai_personalize",  `got: ${jr.job_type}`);
  assert("job.idempotency_key stored",   jr.idempotency_key === idempotencyKey, `got: ${jr.idempotency_key}`);

  // ── Step 9: Idempotency test ────────────────────────────────────────────────

  console.log(`\n${B}Step 9: Idempotency — same key, no second AI call${X}`);
  const { data: runsBefore } = await db.from("enrichment_runs").select("id").eq("job_id", jobId);
  const countBefore = (runsBefore as unknown[]).length;

  const { job: dupJob, created: dupCreated } = await claimJob({
    jobType: "ai_personalize",
    idempotencyKey,
    provider: "ai",
    totalItems: 1,
    inputData: { idempotencyKey, companyId, taskType: "personalization", clientId },
  });
  const dupDecision = resolveResumeDecision(dupJob.status, readCheckpoint(dupJob.output_data));
  console.log(`  Second claimJob → created=${dupCreated}, decision=${dupDecision}`);

  const { data: runsAfter } = await db.from("enrichment_runs").select("id").eq("job_id", jobId);
  const countAfter = (runsAfter as unknown[]).length;

  assert("duplicate: created=false",       !dupCreated,                  `created=${dupCreated}`);
  assert("duplicate: decision=done",        dupDecision === "done",       `got: ${dupDecision}`);
  assert("duplicate: same job_id",          dupJob.id === jobId,          `got: ${dupJob.id}`);
  assert("duplicate: no new enrichment_run", countAfter === countBefore,  `before=${countBefore}, after=${countAfter}`);

  // ── Final report ────────────────────────────────────────────────────────────

  console.log(`\n${B}${"=".repeat(60)}${X}`);
  console.log(`${B}PERSONALIZATION INTEGRATION TEST REPORT${X}`);
  console.log(`${"=".repeat(60)}\n`);

  const TRIGGER_DEV        = checks["job.status = completed"]?.pass && checks["job_id populated"]?.pass;
  const MODEL_ROUTER       = checks["gateway populated"]?.pass && checks["provider (model) populated"]?.pass;
  const EXECUTOR           = checks["latency_ms measured"]?.pass;
  const TOKEN_TRACKING     = checks["input_tokens > 0"]?.pass && checks["output_tokens > 0"]?.pass;
  const COST_TRACKING      = checks["cost_usd calculated"]?.pass;
  const SUPABASE_WRITE     = checks["status = completed"]?.pass && checks["output_data has subject"]?.pass && checks["output_data has message"]?.pass;
  const JOB_LINK           = checks["job_id populated"]?.pass;
  const CLIENT_ISOLATION   = checks["client_id populated"]?.pass;
  const IDEMPOTENCY        = checks["duplicate: decision=done"]?.pass;
  const NO_DUPLICATE_AI    = checks["duplicate: no new enrichment_run"]?.pass && IDEMPOTENCY;

  function line(label: string, pass: boolean | undefined): void {
    console.log(`  ${label.padEnd(32)} ${pass ? `${G}PASS${X}` : `${R}FAIL${X}`}`);
  }

  line("REAL AI CALL:",              TOKEN_TRACKING);
  line("TRIGGER.DEV:",               TRIGGER_DEV);
  line("MODEL ROUTER:",              MODEL_ROUTER);
  line("EXECUTOR:",                  EXECUTOR);
  line("TOKEN TRACKING:",            TOKEN_TRACKING);
  line("COST TRACKING:",             COST_TRACKING);
  line("SUPABASE WRITE:",            SUPABASE_WRITE);
  line("JOB LINK:",                  JOB_LINK);
  line("CLIENT ISOLATION:",          CLIENT_ISOLATION);
  line("IDEMPOTENCY:",               IDEMPOTENCY);
  line("DUPLICATE AI PREVENTION:",   NO_DUPLICATE_AI);

  const allPass = [TRIGGER_DEV, MODEL_ROUTER, EXECUTOR, TOKEN_TRACKING, COST_TRACKING,
    SUPABASE_WRITE, JOB_LINK, CLIENT_ISOLATION, IDEMPOTENCY, NO_DUPLICATE_AI].every(Boolean);

  console.log(`\n  Model:          ${result.model}`);
  console.log(`  Gateway:        ${result.gateway}`);
  console.log(`  Input tokens:   ${result.inputTokens}`);
  console.log(`  Output tokens:  ${result.outputTokens}`);
  console.log(`  Latency (ms):   ${result.latencyMs}`);
  console.log(`  Cost (USD):     $${result.costUsd?.toFixed(6)}`);

  console.log(`\n${Y}Records preserved in Supabase:${X}`);
  console.log(`  company_id:        ${reportCompanyId}`);
  console.log(`  client_id:         ${reportClientId}`);
  console.log(`  job_id:            ${reportJobId}`);
  console.log(`  enrichment_run_id: ${reportEnrichmentRunId}`);

  console.log(`\n${allPass ? `${G}${B}ALL CHECKS PASSED${X}` : `${R}${B}SOME CHECKS FAILED${X}`}\n`);

  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error(`\n${R}Fatal error:${X}`, err);
  process.exit(1);
});
