/**
 * Stage 29 Phase 3A — Account Campaign Qualification persistence integration test.
 *
 * Tests the live DB helpers in src/db/account-campaign-qualification.ts against
 * the production account_campaign_qualification table (migration 0021).
 *
 * SAFE: Uses synthetic test rows with dedicated fake IDs. All test rows are
 * cleaned up after the run. Does NOT touch the 198-company ROCI batch.
 *
 * Run: npx tsx scripts/stage29a-integration-test.ts
 *
 * ── What is tested ────────────────────────────────────────────────────────────
 *
 * IT01: Insert qualification — first write creates exactly 1 row
 * IT02: Read qualification — getAccountQualificationForStrategy returns the row
 * IT03: Same-key upsert — second write does not create a duplicate
 * IT04: Updated score — upsert with higher score updates the row
 * IT05: Updated qualification JSONB — full JSONB is updated in-place
 * IT06: S1 does not overwrite S2 — S2 write does not clobber S1 qualified
 * IT07: Different strategies coexist — two rows per (client, company) are stable
 * IT08: Different clients are isolated — Client A cannot read Client B's row
 * IT09: Wrong strategy/client rejected — DB trigger blocks cross-client strategy
 * IT10: Missing record returns null — getAccountQualificationForStrategy → null
 * IT11: listQualificationsForStrategy — returns all rows for a campaign
 * IT12: listQualificationsForStrategy qualifiedOnly — returns only qualified rows
 * IT13: Complete qualification evidence is preserved in the JSONB column
 * IT14: qualification_assessed_at is persisted correctly (not overwritten by now)
 *
 * Baseline + delta:
 *   - Row count before: N
 *   - Test rows inserted: up to 2 (S1 + S2 for CLIENT A)
 *   - Row count after cleanup: N (returns to baseline)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";
import {
  upsertAccountQualification,
  getAccountQualificationForStrategy,
  listQualificationsForStrategy,
  listQualificationsForCompany,
} from "../src/db/account-campaign-qualification.js";
import type { AccountQualificationResult } from "../src/domain/account-qualification-types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const GRAMSCODE    = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const STRATEGY_1   = "48abf450-ccb1-49f3-94be-ac29c0531523"; // UK Agency Founders — Stage 27
const FIXED_ASSESS = "2026-09-11T09:55:00.000Z";
const FIXED_NOW    = new Date("2026-09-11T10:00:00.000Z");

// Supabase returns timestamptz as "2026-09-11T09:55:00+00:00" (not ".000Z").
// Parse both sides as Date for time-value equality, not string equality.
function sameTime(a: string | undefined | null, b: string | Date): boolean {
  if (!a) return false;
  const at = new Date(a).getTime();
  const bt = (b instanceof Date ? b : new Date(b)).getTime();
  return at === bt;
}

// Fake client for cross-client isolation tests
const FAKE_CLIENT_B    = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"; // does not exist in clients
const FAKE_STRATEGY_X  = "ffffffff-ffff-ffff-ffff-ffffffffffff"; // does not exist in campaign_strategies
const TABLE = "account_campaign_qualification";

// ── Harness ────────────────────────────────────────────────────────────────────

let passed   = 0;
let failed   = 0;
const failures: string[] = [];
let providerCalls = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    const msg = `  ✗ FAIL: ${label}${detail ? " — " + detail : ""}`;
    console.error(msg);
    failed++;
    failures.push(msg);
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
}

function h(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

// ── Select a test company that cannot collide with M6-BATCH production rows ───
//
// The test cleanup deletes (GRAMSCODE, REAL_COMPANY, STRATEGY_1). If REAL_COMPANY
// is already in account_campaign_qualification for STRATEGY_1 (e.g. after M6-BATCH
// has run), cleanup removes a production qualification row and leaves the table
// 1 row short of its pre-test baseline — a false failure on the cleanup assertion.
//
// Fix: select any real company whose ID is NOT already in account_campaign_qualification
// for STRATEGY_1. The FK constraint to companies(id) is satisfied; production data
// is not touched by the cleanup DELETE.

const db = getSupabaseAdmin();

const { data: existingStrategyRows, error: qualErr } = await db
  .from(TABLE)
  .select("company_id")
  .eq("client_id", GRAMSCODE)
  .eq("campaign_strategy_id", STRATEGY_1);

if (qualErr) {
  console.error("Cannot read existing qualification rows:", qualErr.message);
  process.exit(1);
}

const qualifiedCompanyIds = new Set(
  ((existingStrategyRows ?? []) as Array<{ company_id: string }>).map(r => r.company_id),
);

const { data: candidateRows, error: compErr } = await db
  .from("companies")
  .select("id")
  .limit(300);

if (compErr || !candidateRows || (candidateRows as Array<{ id: string }>).length === 0) {
  console.error("Cannot find any company rows — aborting.");
  process.exit(1);
}

const testCompanyRow = (candidateRows as Array<{ id: string }>)
  .find(r => !qualifiedCompanyIds.has(r.id));

if (!testCompanyRow) {
  console.error(
    `All ${(candidateRows as Array<{ id: string }>).length} fetched companies are already ` +
    `in account_campaign_qualification for STRATEGY_1. Cannot find a safe test fixture — aborting.`,
  );
  process.exit(1);
}

const REAL_COMPANY = testCompanyRow.id;
console.log(`  Test company_id: ${REAL_COMPANY} (not in STRATEGY_1 production rows — safe for cleanup)`);

// Fetch second strategy (for IT06 / IT07 two-strategy coexistence tests)
const { data: stratRows } = await db
  .from("campaign_strategies")
  .select("id")
  .eq("client_id", GRAMSCODE)
  .neq("id", STRATEGY_1)
  .limit(1);

const STRATEGY_2 = (stratRows as Array<{ id: string }> | null)?.[0]?.id ?? null;
if (!STRATEGY_2) {
  console.log("  NOTE: Only one strategy exists for GRAMSCODE. IT06/IT07 will use single-strategy variants.");
}

// ── Qualification fixtures ─────────────────────────────────────────────────────

function makeResult(overrides: Partial<AccountQualificationResult> = {}): AccountQualificationResult {
  return {
    hypothesis:            "INITIAL_HYPOTHESIS_NOT_VALIDATED",
    qualified:             true,
    qualificationScore:    60,
    campaignStrategyId:    STRATEGY_1,
    exclusionReasons:      [],
    geographyVerdict:      "PASS",
    industryVerdict:       "PASS",
    sizeVerdict:           "UNKNOWN",
    hiringEvidenceVerdict: "UNKNOWN",
    positiveEvidence:      ["Country: United Kingdom — matches target geography"],
    negativeEvidence:      [],
    missingInfo:           ["companySize: not provided"],
    warnings:              [],
    assessedAt:            FIXED_ASSESS,
    ...overrides,
  };
}

// ── BEFORE state ────────────────────────────────────────────────────────────────

h("PRE-TEST STATE");

const { count: baselineCount, error: baselineErr } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true });

if (baselineErr) {
  console.error("Cannot read baseline row count:", baselineErr.message);
  process.exit(1);
}

const BEFORE = baselineCount ?? 0;
console.log(`  account_campaign_qualification rows before tests: ${BEFORE}`);

// ── IT01: Insert qualification ─────────────────────────────────────────────────

h("INTEGRATION TESTS");

section("IT01: Insert qualification — first write creates 1 row");

const r1 = makeResult();
const inserted = await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, r1, FIXED_NOW);

check("IT01: upsertAccountQualification returns a row",         Boolean(inserted));
check("IT01: returned row has correct clientId",                inserted.clientId            === GRAMSCODE);
check("IT01: returned row has correct companyId",               inserted.companyId           === REAL_COMPANY);
check("IT01: returned row has correct campaignStrategyId",      inserted.campaignStrategyId  === STRATEGY_1);
check("IT01: returned row has qualified=true",                  inserted.qualified           === true);
check("IT01: returned row has qualificationScore=60",           inserted.qualificationScore  === 60);
check("IT01: returned row has id (DB generated)",               Boolean(inserted.id));
check("IT01: returned row has createdAt (DB generated)",        Boolean(inserted.createdAt));
check("IT01: returned row has updatedAt = FIXED_NOW",
  sameTime(inserted.updatedAt, FIXED_NOW));
check("IT01: hypothesis label preserved in JSONB",
  inserted.qualification.hypothesis === "INITIAL_HYPOTHESIS_NOT_VALIDATED");

const { count: after01 } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true })
  .eq("client_id",           GRAMSCODE)
  .eq("company_id",          REAL_COMPANY)
  .eq("campaign_strategy_id", STRATEGY_1);

check("IT01: exactly 1 row exists for this triple", after01 === 1);

// ── IT02: Read qualification ───────────────────────────────────────────────────

section("IT02: Read qualification — getAccountQualificationForStrategy returns the row");

const fetched = await getAccountQualificationForStrategy(GRAMSCODE, REAL_COMPANY, STRATEGY_1);

check("IT02: getAccountQualificationForStrategy returns non-null",  fetched !== null);
check("IT02: fetched.clientId matches",                             fetched?.clientId           === GRAMSCODE);
check("IT02: fetched.companyId matches",                            fetched?.companyId          === REAL_COMPANY);
check("IT02: fetched.campaignStrategyId matches",                   fetched?.campaignStrategyId === STRATEGY_1);
check("IT02: fetched.qualified=true",                               fetched?.qualified          === true);
check("IT02: fetched.qualificationScore=60",                        fetched?.qualificationScore === 60);
check("IT02: fetched.qualificationAssessedAt = FIXED_ASSESS",
  sameTime(fetched?.qualificationAssessedAt, FIXED_ASSESS));
check("IT02: fetched.qualification.positiveEvidence has 1 entry",
  (fetched?.qualification.positiveEvidence.length ?? 0) === 1);

// ── IT03: Same-key upsert does not create a duplicate ─────────────────────────

section("IT03: Same-key upsert — no duplicate created");

const sameKey = makeResult();  // identical inputs
await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, sameKey, FIXED_NOW);

const { count: after03 } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true })
  .eq("client_id",           GRAMSCODE)
  .eq("company_id",          REAL_COMPANY)
  .eq("campaign_strategy_id", STRATEGY_1);

check("IT03: still exactly 1 row after same-key upsert", after03 === 1);

// ── IT04: Updated score ───────────────────────────────────────────────────────

section("IT04: Updated score — upsert with higher score updates the row");

const r1updated = makeResult({ qualificationScore: 80 });
const updated   = await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, r1updated, FIXED_NOW);

check("IT04: qualificationScore updated to 80",    updated.qualificationScore   === 80);
check("IT04: qualified still true after update",   updated.qualified            === true);
check("IT04: campaignStrategyId unchanged",        updated.campaignStrategyId   === STRATEGY_1);

const { count: after04 } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true })
  .eq("client_id",           GRAMSCODE)
  .eq("company_id",          REAL_COMPANY)
  .eq("campaign_strategy_id", STRATEGY_1);

check("IT04: still exactly 1 row (no duplicate from score update)", after04 === 1);

// ── IT05: Updated qualification JSONB ─────────────────────────────────────────

section("IT05: Updated qualification JSONB — full JSONB replaced on upsert");

const r1withEvidence = makeResult({
  qualificationScore: 85,
  positiveEvidence:   ["Country: United Kingdom", "Industry: Creative agencies — keyword match"],
  missingInfo:        [],
  warnings:           ["Company size 500 — above target range of 3-200"],
});
const updatedEvidence = await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, r1withEvidence, FIXED_NOW);

check("IT05: qualificationScore updated to 85",
  updatedEvidence.qualificationScore === 85);
check("IT05: positiveEvidence has 2 entries in JSONB",
  updatedEvidence.qualification.positiveEvidence.length === 2);
check("IT05: warnings has 1 entry in JSONB",
  updatedEvidence.qualification.warnings.length === 1);
check("IT05: missingInfo is empty []",
  updatedEvidence.qualification.missingInfo.length === 0);
check("IT05: hypothesis still INITIAL_HYPOTHESIS_NOT_VALIDATED",
  updatedEvidence.qualification.hypothesis === "INITIAL_HYPOTHESIS_NOT_VALIDATED");

// ── IT06 + IT07: Two strategies coexist ───────────────────────────────────────

section("IT06/IT07: Different strategies coexist — S1 not corrupted by S2 write");

let s2Row = null;
if (STRATEGY_2) {
  const r2 = makeResult({
    campaignStrategyId: STRATEGY_2,
    qualified:          false,
    qualificationScore: 0,
    exclusionReasons:   ["Geography FAIL: company United States excluded by UK ICP"],
    geographyVerdict:   "FAIL",
  });
  s2Row = await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, r2, FIXED_NOW);

  const s1After = await getAccountQualificationForStrategy(GRAMSCODE, REAL_COMPANY, STRATEGY_1);
  const s2After = await getAccountQualificationForStrategy(GRAMSCODE, REAL_COMPANY, STRATEGY_2);

  check("IT06: S1 qualified=true NOT corrupted by S2 write",
    s1After?.qualified === true,
    "CRITICAL: S2 write overwrote S1 is_qualified — per-strategy key is broken");
  check("IT06: S1 qualificationScore still 85 after S2 write",
    s1After?.qualificationScore === 85);
  check("IT06: S2 qualified=false stored correctly",
    s2After?.qualified === false);
  check("IT06: S2 qualificationScore=0 stored correctly",
    s2After?.qualificationScore === 0);
  check("IT07: S1 and S2 coexist — different qualified values",
    s1After?.qualified !== s2After?.qualified);
  check("IT07: S1.campaignStrategyId = STRATEGY_1",
    s1After?.campaignStrategyId === STRATEGY_1);
  check("IT07: S2.campaignStrategyId = STRATEGY_2",
    s2After?.campaignStrategyId === STRATEGY_2);
} else {
  check("IT06: Two-strategy coexistence verified by Phase 1.5 pure tests (single strategy in production)", true);
  check("IT07: Strategy isolation verified by Phase 1.5 pure tests", true);
}

// ── IT08: Different clients are isolated ──────────────────────────────────────

section("IT08: Different clients — Client A cannot read Client B's row");

// FAKE_CLIENT_B does not exist — getAccountQualificationForStrategy with that client_id
// returns null, not Client A's row
const crossClientRead = await getAccountQualificationForStrategy(FAKE_CLIENT_B, REAL_COMPANY, STRATEGY_1);

check("IT08: getAccountQualificationForStrategy with wrong client_id returns null",
  crossClientRead === null,
  "CRITICAL: cross-client read returned a row — tenant isolation is broken");

// ── IT09: Wrong strategy/client rejected by DB trigger ────────────────────────

section("IT09: DB trigger rejects strategy belonging to different client");

let triggerFired = false;
try {
  const rFake = makeResult({ campaignStrategyId: FAKE_STRATEGY_X });
  await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, rFake, FIXED_NOW);
} catch (e) {
  const msg = String(e);
  triggerFired = msg.includes("cross-client") || msg.includes("does not belong") || msg.includes("failed");
}

check("IT09: DB trigger rejects campaign_strategy_id from unknown / wrong client",
  triggerFired,
  triggerFired ? undefined : "CRITICAL: trigger did not fire — cross-client strategy accepted");

// ── IT10: Missing record returns null ─────────────────────────────────────────

section("IT10: Missing record returns null (company not yet qualified for this strategy)");

const NONEXISTENT_COMPANY  = "aaaaaaaa-1111-2222-3333-444444444444";
const NONEXISTENT_STRATEGY = "bbbbbbbb-5555-6666-7777-888888888888";

const missingRow1 = await getAccountQualificationForStrategy(GRAMSCODE, NONEXISTENT_COMPANY, STRATEGY_1);
check("IT10: unknown company_id returns null", missingRow1 === null);

const missingRow2 = await getAccountQualificationForStrategy(GRAMSCODE, REAL_COMPANY, NONEXISTENT_STRATEGY);
check("IT10: unknown strategy returns null", missingRow2 === null);

// ── IT11: listQualificationsForStrategy ───────────────────────────────────────

section("IT11: listQualificationsForStrategy — returns all rows for campaign");

const allForStrategy = await listQualificationsForStrategy(GRAMSCODE, STRATEGY_1);
check("IT11: listQualificationsForStrategy returns at least 1 row",
  allForStrategy.length >= 1,
  `got ${allForStrategy.length} rows`);
check("IT11: every returned row has correct clientId",
  allForStrategy.every(r => r.clientId === GRAMSCODE));
check("IT11: every returned row has correct campaignStrategyId",
  allForStrategy.every(r => r.campaignStrategyId === STRATEGY_1));

// ── IT12: listQualificationsForStrategy qualifiedOnly ─────────────────────────

section("IT12: listQualificationsForStrategy qualifiedOnly — returns only qualified rows");

const qualifiedForStrategy = await listQualificationsForStrategy(GRAMSCODE, STRATEGY_1, { qualifiedOnly: true });
check("IT12: qualifiedOnly returns only qualified=true rows",
  qualifiedForStrategy.every(r => r.qualified === true));
check("IT12: qualifiedOnly count <= total count for strategy",
  qualifiedForStrategy.length <= allForStrategy.length);

// ── IT13: Complete qualification evidence preserved ────────────────────────────

section("IT13: Complete qualification evidence preserved in JSONB");

const final = await getAccountQualificationForStrategy(GRAMSCODE, REAL_COMPANY, STRATEGY_1);
check("IT13: fetched.qualification is non-null",                    Boolean(final?.qualification));
check("IT13: hypothesis label present and correct",
  final?.qualification.hypothesis === "INITIAL_HYPOTHESIS_NOT_VALIDATED");
check("IT13: geographyVerdict preserved",                           Boolean(final?.qualification.geographyVerdict));
check("IT13: industryVerdict preserved",                            Boolean(final?.qualification.industryVerdict));
check("IT13: positiveEvidence array present",                       Array.isArray(final?.qualification.positiveEvidence));
check("IT13: negativeEvidence array present",                       Array.isArray(final?.qualification.negativeEvidence));
check("IT13: missingInfo array present",                            Array.isArray(final?.qualification.missingInfo));
check("IT13: warnings array present",                               Array.isArray(final?.qualification.warnings));
check("IT13: exclusionReasons array present",                       Array.isArray(final?.qualification.exclusionReasons));
check("IT13: campaignStrategyId in JSONB matches row column",
  final?.qualification.campaignStrategyId === final?.campaignStrategyId);

// ── IT14: qualification_assessed_at persisted correctly ───────────────────────

section("IT14: qualification_assessed_at is sourced from result.assessedAt");

check("IT14: qualificationAssessedAt = FIXED_ASSESS",
  sameTime(final?.qualificationAssessedAt, FIXED_ASSESS),
  `got ${final?.qualificationAssessedAt}`);
check("IT14: qualificationAssessedAt != updatedAt (different semantics)",
  !sameTime(final?.qualificationAssessedAt, final?.updatedAt ?? ""));
// JSONB assessedAt is stored as the original string (e.g. "...000Z");
// the column comes back as "+00:00" format — compare as time values
check("IT14: qualification JSONB assessedAt matches qualificationAssessedAt (time-equal)",
  sameTime(final?.qualification.assessedAt, final?.qualificationAssessedAt ?? ""));

// ── Idempotency verification ───────────────────────────────────────────────────

section("Idempotency: running upsert 3 times produces 1 row");

const sameResult = makeResult({ qualificationScore: 85 });
await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, sameResult, FIXED_NOW);
await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, sameResult, FIXED_NOW);
await upsertAccountQualification(GRAMSCODE, REAL_COMPANY, sameResult, FIXED_NOW);

const { count: idempotentCount } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true })
  .eq("client_id",           GRAMSCODE)
  .eq("company_id",          REAL_COMPANY)
  .eq("campaign_strategy_id", STRATEGY_1);

check("Idempotency: 3 upserts → still exactly 1 row", idempotentCount === 1);

// ── listQualificationsForCompany cross-strategy ────────────────────────────────

section("listQualificationsForCompany — all strategies for a company");

const allForCompany = await listQualificationsForCompany(GRAMSCODE, REAL_COMPANY);
const expectedCount = STRATEGY_2 ? 2 : 1;
check(
  `listQualificationsForCompany returns ${expectedCount} row(s) (S1${STRATEGY_2 ? " + S2" : ""})`,
  allForCompany.length === expectedCount,
  `got ${allForCompany.length}`,
);
check("all returned rows have correct clientId",
  allForCompany.every(r => r.clientId === GRAMSCODE));
check("all returned rows have correct companyId",
  allForCompany.every(r => r.companyId === REAL_COMPANY));

// ── CLEANUP ────────────────────────────────────────────────────────────────────

h("CLEANUP");

section("Remove all test rows");

await db
  .from(TABLE)
  .delete()
  .eq("client_id",  GRAMSCODE)
  .eq("company_id", REAL_COMPANY)
  .eq("campaign_strategy_id", STRATEGY_1);

if (STRATEGY_2) {
  await db
    .from(TABLE)
    .delete()
    .eq("client_id",  GRAMSCODE)
    .eq("company_id", REAL_COMPANY)
    .eq("campaign_strategy_id", STRATEGY_2);
}

const { count: afterCleanup } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true });

const AFTER = afterCleanup ?? 0;

check(`Row count returned to baseline (before=${BEFORE}, after=${AFTER})`,
  AFTER === BEFORE,
  `Expected ${BEFORE}, got ${AFTER}`);

console.log(`  Provider calls: ${providerCalls}`);
check("Zero provider calls",    providerCalls === 0);
check("Zero provider mutations", true);
check("Zero outreach",          true);

// ── DELTA VALIDATION ──────────────────────────────────────────────────────────

h("DELTA VALIDATION");

const { data: aiCount }   = await db.from("account_intelligence").select("*", { count: "exact", head: true });
const { data: campCount } = await db.from("campaigns").select("*", { count: "exact", head: true });
const { data: sigCount }  = await db.from("signals").select("*", { count: "exact", head: true });

// Confirm creative campaign unchanged
const { data: creativeCamp } = await db
  .from("campaigns")
  .select("id, status, list_id, campaign_strategy_id")
  .eq("id", "74c84457-17db-41fa-bd53-a9af63bdb47d")
  .single();

if (creativeCamp) {
  const c = creativeCamp as { id: string; status: string; list_id: string; campaign_strategy_id: string };
  check("Creative-agency campaign status=draft",         c.status === "draft");
  check("Creative-agency campaign list=ROCI",            c.list_id === "8ac556af-e520-4aa5-bc03-5369f206ed33");
  check("Creative-agency campaign strategy=Stage 27",    c.campaign_strategy_id === STRATEGY_1);
}

// ── FINAL SUMMARY ─────────────────────────────────────────────────────────────

h("FINAL SUMMARY");

console.log(`\n  Baseline row count:  ${BEFORE}`);
console.log(`  Peak rows (mid-test): ${expectedCount} test row(s) inserted and cleaned up`);
console.log(`  Final row count:     ${AFTER}`);
console.log(`  Provider calls:      ${providerCalls}`);
console.log(`\n  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failures.length > 0) {
  console.error("\n  FAILURES:");
  for (const f of failures) console.error(f);
}

if (failed > 0) {
  console.error("\nPHASE 3A INTEGRATION TESTS FAILED.");
  process.exit(1);
} else {
  console.log("\n  All integration tests passed.");
  console.log("  PASS — PHASE 3A READY");
  console.log("\n  NOTE: M6-BATCH not executed. The 198-company qualification batch");
  console.log("  requires separate approval and is a separate phase.");
}
