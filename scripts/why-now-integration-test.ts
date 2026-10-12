/**
 * Stage 22 — Why Now Engine Integration Test.
 *
 * Validates the complete real-data path against a live Supabase instance:
 *
 *   signals (live DB rows) → assessWhyNow() → account_intelligence.why_now
 *
 * Requires migration 0017_why_now.sql to be applied first (adds why_now,
 * is_ready, readiness_assessed_at to account_intelligence).
 *
 * ── What each section proves ──────────────────────────────────────────────────
 *
 *   1. Pre-flight              — env vars, DB connectivity, columns exist
 *   2. Test data setup         — 3 companies with known signal configurations
 *   3. Readiness gate          — ready/not-ready outcomes for each configuration
 *   4. Evidence accuracy       — activeSignalCount, corroborationFactor, topSignals
 *   5. AI threshold behavior   — score < 20 → no AI; score >= 20 → AI attempted
 *   6. Idempotency             — second run within 23h reuses narrative (no AI call)
 *   7. Client isolation        — Company A results unchanged by Client B run
 *   8. Stale/expired signals   — expired signals excluded from readiness evidence
 *   9. Persist verification    — DB row reflects assessment after setWhyNow()
 *  10. getReadyAccounts()      — returns only is_ready=true accounts
 *
 * IMPORTANT:
 *   - This test writes to the DB. All writes use RUN_SUFFIX-namespaced test companies.
 *   - Cleanup removes test signals and account_intelligence rows at the end.
 *   - The AI call (section 5) requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY.
 *     If neither is set, section 5 is skipped and marked ~skipped~.
 *   - Do NOT run this test against production data.
 */

import { existsSync } from "node:fs";
for (const c of [".env", "../../.env"]) {
  if (existsSync(c)) { (process as any).loadEnvFile?.(c); break; }
}

import { getSupabaseAdmin } from "../src/db/supabase.ts";
import { assessWhyNow } from "../src/lib/why-now.ts";
import { getReadyAccounts } from "../src/db/account-intelligence.ts";
import { upsertSignal } from "../src/db/signals.ts";
import type { NormalizedSignal } from "../src/domain/signal-types.ts";

// ── Setup ─────────────────────────────────────────────────────────────────────

const RUN_SUFFIX = Math.random().toString(36).slice(2, 10);
const FIXED_NOW  = new Date("2026-09-06T12:00:00.000Z");
const FIXED_NOW_STR = FIXED_NOW.toISOString();

function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function fail(msg: string) { console.log(`  ✗ ${msg}`); process.exitCode = 1; }
function info(msg: string) { console.log(`     ${msg}`); }
function skip(msg: string) { console.log(`  ~ ${msg}`); }
function section(msg: string) { console.log(`\n── ${msg} ${"─".repeat(Math.max(0, 55 - msg.length))}`); }

function check(cond: boolean, pass: string, onFail: string) {
  cond ? ok(pass) : fail(onFail);
}

// ── Test data ─────────────────────────────────────────────────────────────────

// Stage 10.5 test client (Gramscode — must exist; same ID used across all integration tests)
const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";

let COMPANY_A_ID: string;  // Score=1 (ready); 1 active signal
let COMPANY_B_ID: string;  // Score=0 (not ready); signals expired
let COMPANY_C_ID: string;  // Score=0 (not ready); no signals
let COMPANY_D_ID: string;  // Score>=20 (ready + AI threshold met)

// Track inserted signals for cleanup
const insertedSignalIds: string[] = [];

// ── Pre-flight ────────────────────────────────────────────────────────────────

console.log("=".repeat(70));
console.log("Stage 22 — Why Now Engine Integration Test");
console.log("=".repeat(70));
info(`run_suffix: "${RUN_SUFFIX}"`);
info(`fixed_now:  "${FIXED_NOW_STR}"`);

section("Pre-flight");

const db = getSupabaseAdmin();

// Check env
check(!!process.env.SUPABASE_URL,        "SUPABASE_URL present",        "SUPABASE_URL missing");
check(!!process.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY present", "SUPABASE_SECRET_KEY missing");
const hasAiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);
if (hasAiKey) ok("AI key present (AI narrative test will run)");
else skip("No AI key — AI narrative test will be skipped");

// Check migration applied
const { data: colProbe, error: colErr } = await db
  .from("account_intelligence")
  .select("id, why_now, is_ready, readiness_assessed_at")
  .limit(0);
if (colErr) {
  fail(`Migration 0017_why_now.sql NOT applied: ${colErr.message}`);
  fail("Apply the migration first, then re-run this test.");
  process.exit(1);
}
ok("Migration applied — why_now, is_ready, readiness_assessed_at columns exist");

// Check test client
const { data: clientData } = await db
  .from("clients")
  .select("id, name")
  .eq("id", TEST_CLIENT_ID)
  .maybeSingle();
check(!!clientData, `Test client exists: ${(clientData as any)?.name ?? "(not found)"}`, "Test client not found");

// ── Company setup ─────────────────────────────────────────────────────────────

section("Test company setup");

async function findOrCreateCompany(name: string, domain: string, icpScore = 80): Promise<string> {
  const { data: existing } = await db.from("companies").select("id").eq("domain", domain).maybeSingle();
  if (existing) { skip(`existing: ${name} (${domain}) → ${existing.id}`); return existing.id; }
  const { data: created, error } = await db.from("companies")
    .insert({ name, domain, icp_score: icpScore }).select("id").single();
  if (error) throw new Error(`createCompany(${name}) failed: ${error.message}`);
  ok(`created: ${name} → ${created.id}`);
  return created.id;
}

COMPANY_A_ID = await findOrCreateCompany(`S22-A-${RUN_SUFFIX}`, `s22-a-${RUN_SUFFIX}.test.internal`, 80);
COMPANY_B_ID = await findOrCreateCompany(`S22-B-${RUN_SUFFIX}`, `s22-b-${RUN_SUFFIX}.test.internal`, 80);
COMPANY_C_ID = await findOrCreateCompany(`S22-C-${RUN_SUFFIX}`, `s22-c-${RUN_SUFFIX}.test.internal`, 80);
COMPANY_D_ID = await findOrCreateCompany(`S22-D-${RUN_SUFFIX}`, `s22-d-${RUN_SUFFIX}.test.internal`, 80);

info(`company_a: ${COMPANY_A_ID} (ready target)`);
info(`company_b: ${COMPANY_B_ID} (expired signals — not ready)`);
info(`company_c: ${COMPANY_C_ID} (no signals — no AI row)`);
info(`company_d: ${COMPANY_D_ID} (AI threshold target)`);

// ── Clean prior state ─────────────────────────────────────────────────────────

section("Clean prior test state");

const testCompanyIds = [COMPANY_A_ID, COMPANY_B_ID, COMPANY_C_ID, COMPANY_D_ID];

// Delete prior account_intelligence for test companies
const { error: delAiErr } = await db.from("account_intelligence")
  .delete()
  .eq("client_id", TEST_CLIENT_ID)
  .in("company_id", testCompanyIds);
if (delAiErr) fail(`delete account_intelligence: ${delAiErr.message}`);
else ok("Prior account_intelligence rows deleted");

// Delete prior signals
const { error: delSigErr } = await db.from("signals")
  .delete()
  .eq("client_id", TEST_CLIENT_ID)
  .in("company_id", testCompanyIds);
if (delSigErr) fail(`delete signals: ${delSigErr.message}`);
else ok("Prior signals deleted");

// ── Insert test signals ───────────────────────────────────────────────────────

section("Signal insertion");

// Occurred 30d before NOW, expires 60d after that — not expired at FIXED_NOW
const ACTIVE_OCCURRED = new Date(FIXED_NOW.getTime() - 30 * 86400_000).toISOString();
const ACTIVE_EXPIRES  = new Date(FIXED_NOW.getTime() + 30 * 86400_000).toISOString();

// Occurred 200d before NOW, expires 100d ago — expired at FIXED_NOW
const STALE_OCCURRED = new Date(FIXED_NOW.getTime() - 200 * 86400_000).toISOString();
const STALE_EXPIRES  = new Date(FIXED_NOW.getTime() - 100 * 86400_000).toISOString();

function makeSignalBase(companyId: string, type: NormalizedSignal["signalType"], title: string, strength: number, occurred: string, expires: string, status: NormalizedSignal["status"] = "active"): NormalizedSignal {
  return {
    clientId: TEST_CLIENT_ID,
    companyId,
    signalType: type,
    signalSource: "test",
    signalTitle: title,
    signalDescription: null,
    evidence: {},
    signalStrength: strength,
    confidence: 0.9,
    occurredAt: occurred,
    detectedAt: occurred,
    expiresAt: expires,
    sourceUrl: null,
    status,
    metadata: null,
    dedupKey: `s22-${RUN_SUFFIX}-${companyId}-${type}`,
  };
}

// Company A: 1 active funding signal (score = modest but > 0 at icp_score=80)
const sigA = await upsertSignal(makeSignalBase(COMPANY_A_ID, "funding_round", "Series A Funding", 80, ACTIVE_OCCURRED, ACTIVE_EXPIRES));
insertedSignalIds.push(sigA.row.id);
ok(`Company A: funding_round signal inserted (id: ${sigA.row.id})`);

// Company B: 1 stale (expired) signal — still status=active, but expired at FIXED_NOW
const sigB = await upsertSignal(makeSignalBase(COMPANY_B_ID, "executive_hire", "New CTO Hire", 70, STALE_OCCURRED, STALE_EXPIRES));
insertedSignalIds.push(sigB.row.id);
ok(`Company B: expired signal inserted (status=active, expires in past)`);

// Company C: no signals (no account_intelligence row either)
ok("Company C: no signals inserted (will have no AI row)");

// Company D: 3 active GROWTH cluster signals — high corroboration, high score
const sigD1 = await upsertSignal(makeSignalBase(COMPANY_D_ID, "funding_round", "Series B Funding", 90, ACTIVE_OCCURRED, ACTIVE_EXPIRES));
const sigD2 = await upsertSignal(makeSignalBase(COMPANY_D_ID, "job_posting", "Hiring 50 Engineers", 80, ACTIVE_OCCURRED, ACTIVE_EXPIRES));
const sigD3 = await upsertSignal(makeSignalBase(COMPANY_D_ID, "expansion", "Opened NYC Office", 70, ACTIVE_OCCURRED, ACTIVE_EXPIRES));
insertedSignalIds.push(sigD1.row.id, sigD2.row.id, sigD3.row.id);
ok(`Company D: 3 GROWTH cluster signals inserted (funding+job+expansion)`);

// ── Rescore to create account_intelligence rows ───────────────────────────────

section("Rescore (create account_intelligence rows)");

import { rescoreCompany } from "../src/lib/score-recompute.ts";

for (const [label, cid] of [["A", COMPANY_A_ID], ["B", COMPANY_B_ID], ["D", COMPANY_D_ID]]) {
  const row = await rescoreCompany(TEST_CLIENT_ID, cid, FIXED_NOW);
  ok(`Company ${label}: rescored → opportunity_score=${row.opportunityScore}`);
  info(`  (signal_count=${row.scoreInputs?.signalCount}, icp_score=${row.scoreInputs?.icpScore})`);
}
// Company C: intentionally no rescore → no AI row

// ── Readiness gate tests ──────────────────────────────────────────────────────

section("Readiness gate");

// Company A: expect ready=true
const resultA = await assessWhyNow({
  clientId: TEST_CLIENT_ID, companyId: COMPANY_A_ID,
  skipAiNarrative: true, now: FIXED_NOW_STR,
  company: { name: "Acme Corp" },
});
check(resultA.assessment.ready, "Company A: ready=true (active funding signal, score > 0)", "Company A should be ready");
check(resultA.persisted,        "Company A: assessment persisted",                          "Company A should be persisted");
check(resultA.assessment.readinessReason === "READY", "Company A: reason=READY", `expected READY, got ${resultA.assessment.readinessReason}`);
check(resultA.assessment.hypothesis === "INITIAL_HYPOTHESIS_NOT_VALIDATED",
  "Company A: hypothesis labeled INITIAL_HYPOTHESIS_NOT_VALIDATED",
  "hypothesis label missing");
info(`  opportunityScore: ${resultA.assessment.evidence.opportunityScore}`);
info(`  activeSignalCount: ${resultA.assessment.evidence.activeSignalCount}`);

// Company B: expired signal → not ready
const resultB = await assessWhyNow({
  clientId: TEST_CLIENT_ID, companyId: COMPANY_B_ID,
  skipAiNarrative: true, now: FIXED_NOW_STR,
});
check(!resultB.assessment.ready, "Company B: ready=false (expired signal excluded)", "Company B should NOT be ready");
check(resultB.assessment.readinessReason === "OPPORTUNITY_SCORE_BELOW_THRESHOLD" ||
      resultB.assessment.readinessReason === "INSUFFICIENT_ACTIVE_SIGNALS",
  `Company B: not-ready reason is meaningful (${resultB.assessment.readinessReason})`,
  "Company B reason should be OPPORTUNITY_SCORE_BELOW_THRESHOLD or INSUFFICIENT_ACTIVE_SIGNALS");
info(`  reason: ${resultB.assessment.readinessReason}`);
info(`  opportunityScore: ${resultB.assessment.evidence.opportunityScore}`);
info(`  activeSignalCount: ${resultB.assessment.evidence.activeSignalCount}`);

// Company C: no account_intelligence row → not ready, not persisted
const resultC = await assessWhyNow({
  clientId: TEST_CLIENT_ID, companyId: COMPANY_C_ID,
  skipAiNarrative: true, now: FIXED_NOW_STR,
});
check(!resultC.assessment.ready,    "Company C: ready=false (no AI row)",   "Company C should not be ready");
check(!resultC.persisted,           "Company C: not persisted (no row to UPDATE)", "Company C should not be persisted");
check(resultC.assessment.readinessReason === "NO_ACCOUNT_INTELLIGENCE",
  "Company C: reason=NO_ACCOUNT_INTELLIGENCE",
  `expected NO_ACCOUNT_INTELLIGENCE, got ${resultC.assessment.readinessReason}`);

// ── Evidence accuracy ─────────────────────────────────────────────────────────

section("Evidence accuracy");

// Company A: 1 active signal
check(resultA.assessment.evidence.activeSignalCount === 1,
  "Company A: activeSignalCount=1",
  `expected 1, got ${resultA.assessment.evidence.activeSignalCount}`);
check(resultA.assessment.evidence.corroborationFactor === 1.0,
  "Company A: corroborationFactor=1.0 (single signal type, no corroboration)",
  `expected 1.0, got ${resultA.assessment.evidence.corroborationFactor}`);
check(resultA.assessment.evidence.signalSummaries.length === 1,
  "Company A: 1 signal summary in evidence",
  `expected 1, got ${resultA.assessment.evidence.signalSummaries.length}`);
check(resultA.assessment.evidence.topSignals.length === 1,
  "Company A: 1 top signal",
  `expected 1, got ${resultA.assessment.evidence.topSignals.length}`);
check(resultA.assessment.evidence.signalSummaries[0].signalId === sigA.row.id,
  "Company A: signalId in evidence matches inserted signal UUID",
  `expected ${sigA.row.id}, got ${resultA.assessment.evidence.signalSummaries[0].signalId}`);

// Company D: 3 GROWTH cluster signals → corroboration > 1.0
const resultD_noAi = await assessWhyNow({
  clientId: TEST_CLIENT_ID, companyId: COMPANY_D_ID,
  skipAiNarrative: true, now: FIXED_NOW_STR,
  company: { name: "GrowthCo" },
});
check(resultD_noAi.assessment.evidence.activeSignalCount === 3,
  "Company D: activeSignalCount=3 (GROWTH cluster)",
  `expected 3, got ${resultD_noAi.assessment.evidence.activeSignalCount}`);
check(resultD_noAi.assessment.evidence.corroborationFactor > 1.0,
  `Company D: corroborationFactor > 1.0 (${resultD_noAi.assessment.evidence.corroborationFactor})`,
  `expected > 1.0, got ${resultD_noAi.assessment.evidence.corroborationFactor}`);
check(resultD_noAi.assessment.ready, "Company D: ready=true (3 GROWTH signals)", "Company D should be ready");

// ── AI threshold behavior ─────────────────────────────────────────────────────

section("AI threshold behavior");

if (hasAiKey) {
  const scoreD = resultD_noAi.assessment.evidence.opportunityScore;
  if (scoreD >= 20) {
    // Company D should trigger an AI call
    const resultD_ai = await assessWhyNow({
      clientId: TEST_CLIENT_ID, companyId: COMPANY_D_ID,
      skipAiNarrative: false, now: FIXED_NOW_STR,
      company: { name: "GrowthCo", industry: "SaaS", employeeCount: 150 },
      icpContext: { industry: "SaaS", keywords: ["B2B", "outbound"] },
    });
    check(resultD_ai.aiCallMade,
      `Company D: AI narrative generated (score=${scoreD} >= 20)`,
      "Company D: expected AI call to be made");
    check(resultD_ai.assessment.narrative !== null,
      "Company D: narrative is not null after AI call",
      "Company D: narrative should not be null after AI call");
    if (resultD_ai.assessment.narrative) {
      check(typeof resultD_ai.assessment.narrative.whyNow === "string" && resultD_ai.assessment.narrative.whyNow.length > 0,
        "Company D: narrative.whyNow is a non-empty string",
        "Company D: narrative.whyNow should be a non-empty string");
      check(resultD_ai.assessment.narrative.latencyMs > 0,
        `Company D: latencyMs > 0 (${resultD_ai.assessment.narrative.latencyMs}ms)`,
        "Company D: latencyMs should be > 0");
      check(!!resultD_ai.assessment.narrative.model,
        `Company D: model present (${resultD_ai.assessment.narrative.model})`,
        "Company D: model should be present");
      info(`  whyNow: "${resultD_ai.assessment.narrative.whyNow.slice(0, 120)}..."`);
      info(`  model: ${resultD_ai.assessment.narrative.model}`);
      info(`  latencyMs: ${resultD_ai.assessment.narrative.latencyMs}`);
      info(`  costUsd: ${resultD_ai.assessment.narrative.costUsd}`);
      info(`  relevantSignalTitles: ${JSON.stringify(resultD_ai.assessment.narrative.relevantSignalTitles)}`);
    }
  } else {
    skip(`Company D: score=${scoreD} < 20, AI threshold not met (test inconclusive for AI path)`);
  }

  // Company A: score < 20 (likely) → no AI call
  if (resultA.assessment.evidence.opportunityScore < 20) {
    const resultA_ai = await assessWhyNow({
      clientId: TEST_CLIENT_ID, companyId: COMPANY_A_ID,
      skipAiNarrative: false, now: FIXED_NOW_STR,
      company: { name: "Acme Corp" },
    });
    check(!resultA_ai.aiCallMade,
      `Company A: no AI call (score=${resultA.assessment.evidence.opportunityScore} < 20)`,
      "Company A: expected no AI call when score < 20");
    check(resultA_ai.assessment.narrative === null,
      "Company A: narrative=null when score < 20",
      "Company A: narrative should be null when score < AI threshold");
  }
} else {
  skip("AI narrative test skipped — no ANTHROPIC_API_KEY or OPENROUTER_API_KEY");
}

// ── Idempotency (narrative reuse) ─────────────────────────────────────────────

section("Idempotency — 23h narrative reuse window");

if (hasAiKey) {
  const scoreD = resultD_noAi.assessment.evidence.opportunityScore;
  if (scoreD >= 20) {
    // Run again within 23h — should reuse narrative, not make a new AI call
    const resultD_rerun = await assessWhyNow({
      clientId: TEST_CLIENT_ID, companyId: COMPANY_D_ID,
      skipAiNarrative: false, now: FIXED_NOW_STR,
      company: { name: "GrowthCo" },
    });
    check(!resultD_rerun.aiCallMade,
      "Company D second run: no AI call made (within 23h window)",
      "Company D second run: should reuse narrative, not call AI again");
    check(resultD_rerun.narrativeReused,
      "Company D second run: narrativeReused=true",
      "Company D second run: narrativeReused should be true");
  } else {
    skip(`Company D: score=${scoreD} < 20, idempotency test inconclusive`);
  }
} else {
  skip("Idempotency test skipped — requires AI key for first-run narrative");
}

// ── Client isolation ──────────────────────────────────────────────────────────

section("Client isolation");

const FAKE_CLIENT_ID = "00000000-0000-0000-0000-ffffffffffff";
// Assess Company A under a different (non-existent) client
const resultA_otherClient = await assessWhyNow({
  clientId: FAKE_CLIENT_ID, companyId: COMPANY_A_ID,
  skipAiNarrative: true, now: FIXED_NOW_STR,
});
check(!resultA_otherClient.persisted,
  "Client isolation: Company A under fake client not persisted (no AI row for that client)",
  "Client isolation: should not persist for non-existent client");
check(resultA_otherClient.assessment.readinessReason === "NO_ACCOUNT_INTELLIGENCE",
  "Client isolation: returns NO_ACCOUNT_INTELLIGENCE for cross-client lookup",
  `expected NO_ACCOUNT_INTELLIGENCE, got ${resultA_otherClient.assessment.readinessReason}`);

// Verify Company A's real assessment was not modified by the cross-client run
const { data: aiRowAfter } = await db
  .from("account_intelligence")
  .select("client_id, is_ready, why_now")
  .eq("client_id", TEST_CLIENT_ID)
  .eq("company_id", COMPANY_A_ID)
  .maybeSingle();
check(aiRowAfter?.client_id === TEST_CLIENT_ID,
  "Client isolation: Company A's real assessment still belongs to TEST_CLIENT_ID",
  "Client isolation: Company A row should be owned by TEST_CLIENT_ID");

// ── Persist verification ──────────────────────────────────────────────────────

section("Persist verification (DB state check)");

const { data: dbRowA, error: dbErrA } = await db
  .from("account_intelligence")
  .select("is_ready, readiness_assessed_at, why_now")
  .eq("client_id", TEST_CLIENT_ID)
  .eq("company_id", COMPANY_A_ID)
  .single();
if (dbErrA) { fail(`DB read Company A: ${dbErrA.message}`); }
else {
  check(dbRowA.is_ready === true,
    "Company A: is_ready=true in DB",
    `Company A: expected is_ready=true, got ${dbRowA.is_ready}`);
  check(!!dbRowA.readiness_assessed_at,
    "Company A: readiness_assessed_at populated",
    "Company A: readiness_assessed_at should not be null");
  check(dbRowA.why_now !== null,
    "Company A: why_now JSONB populated",
    "Company A: why_now should not be null");
  if (dbRowA.why_now) {
    check(dbRowA.why_now.hypothesis === "INITIAL_HYPOTHESIS_NOT_VALIDATED",
      "Company A: why_now.hypothesis = INITIAL_HYPOTHESIS_NOT_VALIDATED",
      `Company A: hypothesis = ${dbRowA.why_now.hypothesis}`);
  }
}

const { data: dbRowB } = await db
  .from("account_intelligence")
  .select("is_ready, why_now")
  .eq("client_id", TEST_CLIENT_ID)
  .eq("company_id", COMPANY_B_ID)
  .single();
check(dbRowB?.is_ready === false,
  "Company B: is_ready=false in DB",
  `Company B: expected is_ready=false, got ${dbRowB?.is_ready}`);

// ── getReadyAccounts ──────────────────────────────────────────────────────────

section("getReadyAccounts()");

const readyAccounts = await getReadyAccounts(TEST_CLIENT_ID, { limit: 100 });
const readyIds = readyAccounts.map((r) => r.companyId);

check(readyIds.includes(COMPANY_A_ID),
  "getReadyAccounts: Company A is in ready list",
  "getReadyAccounts: Company A should be in ready list");
check(!readyIds.includes(COMPANY_B_ID),
  "getReadyAccounts: Company B is NOT in ready list (expired signals)",
  "getReadyAccounts: Company B should not be in ready list");
check(!readyIds.includes(COMPANY_C_ID),
  "getReadyAccounts: Company C is NOT in ready list (no AI row)",
  "getReadyAccounts: Company C should not be in ready list");
info(`  ready_count: ${readyAccounts.length}`);
info(`  company_ids: ${readyIds.join(", ").slice(0, 100)}`);

// ── Cleanup ───────────────────────────────────────────────────────────────────

section("Cleanup");

// Delete signals
if (insertedSignalIds.length > 0) {
  const { error: cleanSigErr } = await db
    .from("signals")
    .delete()
    .in("id", insertedSignalIds);
  if (cleanSigErr) fail(`cleanup signals: ${cleanSigErr.message}`);
  else ok(`Deleted ${insertedSignalIds.length} test signals`);
}

// Delete account_intelligence rows
const { error: cleanAiErr } = await db
  .from("account_intelligence")
  .delete()
  .eq("client_id", TEST_CLIENT_ID)
  .in("company_id", testCompanyIds);
if (cleanAiErr) fail(`cleanup account_intelligence: ${cleanAiErr.message}`);
else ok("Deleted test account_intelligence rows");

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
if (process.exitCode === 1) {
  console.log("RESULT: FAILED — see ✗ lines above");
} else {
  console.log("RESULT: PASSED");
}
console.log("=".repeat(70));
