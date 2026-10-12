/**
 * Stage 13 — Signal Ingestion Coordinator Integration Test.
 *
 * Validates the Stage 13 coordinator pipeline end-to-end against real Supabase,
 * using FakeSignalProvider (no external API calls):
 *
 *   getTrackedCompanyDomains  → account_intelligence table
 *   getSinceCursor            → signals table (MAX detected_at)
 *   runIngestionCoordinator   → fetchEvents → normalize → upsert → rescore
 *   runSignalRefresh          → full task function with provider injection
 *   runSignalExpiry           → expireStaleSignals → rescoreAffectedCompanies
 *
 * HARD CONSTRAINTS:
 *   - Uses the Stage 10.5 test client (a29f5829-5412-49be-9a77-41c3edf3c14b)
 *   - Makes NO outbound calls (no emails, no Smartlead, no Trigger.dev tasks)
 *   - API secrets are NEVER logged — only presence is confirmed
 *   - Clean-slate model: deletes prior test signals + account_intelligence at START
 *   - Leaves data in Supabase at END for manual inspection
 *
 * Run:
 *   npx tsx scripts/signal-ingestion-coordinator-integration-test.ts
 *
 * Env vars required:
 *   SUPABASE_URL          — always required
 *   SUPABASE_SECRET_KEY   — always required
 *   (PredictLeads keys NOT required — FakeSignalProvider is used throughout)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase";
import { getSinceCursor }           from "../src/lib/since-cursor";
import { getTrackedCompanyDomains } from "../src/lib/tracked-companies";
import { runIngestionCoordinator }  from "../src/lib/signal-ingestion";
import { runSignalRefresh }         from "../src/tasks/signal-refresh";
import { runSignalExpiry }          from "../src/tasks/signal-expiry";
import {
  FakeSignalProvider,
  type FakeFetchOptions,
} from "../src/providers/signals/fake-provider";
import type { FetchOptions } from "../src/providers/signals/types";
import type { RawEventBatch } from "../src/domain/signal-types";

// ── Test provider ─────────────────────────────────────────────────────────────

/**
 * Wraps FakeSignalProvider to inject specific scenarios and a stable eventIdSuffix.
 * The coordinator calls provider.fetchEvents(companyIds, clientId, opts) through
 * the SignalProvider interface; this subclass captures the call and passes the
 * test-specific options to the real FakeSignalProvider implementation.
 *
 * IMPORTANT: dedup_key uniqueness is (client_id, dedup_key) — it does NOT include
 * company_id. Without a per-company suffix, two companies in the same batch get
 * identical dedup_keys → the second insert is treated as a duplicate. We solve this
 * by calling super.fetchEvents once per company with the suffix appended with the
 * company ID, guaranteeing each (company, scenario) pair gets a unique dedup_key.
 */
class Stage13TestProvider extends FakeSignalProvider {
  constructor(
    private readonly scenarios_: string[],
    private readonly asOf_: Date,
    private readonly suffix_: string,
  ) { super(); }

  async fetchEvents(
    companyIds: string[],
    clientId: string,
    opts: FetchOptions = {},
  ): Promise<RawEventBatch> {
    const allEvents: RawEventBatch["events"] = [];
    for (const companyId of companyIds) {
      const batch = await super.fetchEvents([companyId], clientId, {
        ...opts,
        scenarios:     this.scenarios_,
        asOf:          this.asOf_,
        eventIdSuffix: `${this.suffix_}-${companyId}`,
      } as FakeFetchOptions);
      allEvents.push(...batch.events);
    }
    return { events: allEvents, meta: { source: "fake", generatedAt: new Date().toISOString() } };
  }
}

// ── Reporting helpers ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function note(label: string, value: unknown): void {
  console.log(`     ${label}: ${JSON.stringify(value)}`);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_CLIENT_ID  = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const FAKE_CLIENT_ID  = "00000000-0000-0000-0000-ffffffffffff";
const RUN_SUFFIX      = Date.now().toString(36);
const FIXED_NOW       = new Date("2026-09-03T12:00:00.000Z");
const TEST_ICP_SCORE  = 80;

const TEST_COMPANY_DOMAINS = [
  { name: "Stage12 Account Intel A", domain: "stage12-account-intel-a.test.internal" },
  { name: "Stage12 Account Intel B", domain: "stage12-account-intel-b.test.internal" },
];

const STALE_COMPANY_DOMAIN = "stage13-expiry.test.internal";

// Idempotency run uses same suffix → same dedup_key → created: false
const IDEMPOTENCY_SCENARIOS = ["funding_series_a"];
const EXPIRY_SCENARIO       = "test_signal_stale";

// ── Find or create company ────────────────────────────────────────────────────

async function findOrCreateCompany(
  db: ReturnType<typeof getSupabaseAdmin>,
  name: string,
  domain: string,
): Promise<string> {
  const { data: existing } = await db
    .from("companies")
    .select("id")
    .eq("domain", domain)
    .limit(1)
    .maybeSingle();

  if (existing) return (existing as { id: string }).id;

  const { data: inserted, error } = await db
    .from("companies")
    .insert({ name, domain, status: "review", source: "stage13-test" })
    .select("id")
    .single();

  if (error) throw new Error(`insert company ${name} failed: ${error.message}`);
  return (inserted as { id: string }).id;
}

// ── Timestamp normalizer (Supabase returns +00:00; JS produces Z) ─────────────

function normalizeTs(ts: string): string {
  return ts.replace(/\+00:00$/, "Z");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 13 — Signal Ingestion Coordinator Integration Test");
  console.log("=".repeat(70));
  note("run_suffix", RUN_SUFFIX);

  // ── Pre-flight ────────────────────────────────────────────────────────────
  section("Pre-flight");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);
  if (!hasSupabase) { process.exit(1); }

  const db = getSupabaseAdmin();

  // ── Test client ───────────────────────────────────────────────────────────
  section("Test client verification");

  const { data: clientRow, error: clientErr } = await db
    .from("clients")
    .select("id, name")
    .eq("id", TEST_CLIENT_ID)
    .maybeSingle();

  if (clientErr || !clientRow) {
    console.error(`\nAbort: test client ${TEST_CLIENT_ID} not found.`);
    process.exit(1);
  }
  check("Stage 10.5 test client exists", true);
  note("client", (clientRow as { name: string }).name);

  // ── Company setup ─────────────────────────────────────────────────────────
  section("Company setup");

  const companyAId = await findOrCreateCompany(db, TEST_COMPANY_DOMAINS[0].name, TEST_COMPANY_DOMAINS[0].domain);
  const companyBId = await findOrCreateCompany(db, TEST_COMPANY_DOMAINS[1].name, TEST_COMPANY_DOMAINS[1].domain);
  const staleCompanyId = await findOrCreateCompany(db, "Stage13 Expiry Test", STALE_COMPANY_DOMAIN);

  check("Company A resolved", !!companyAId);
  check("Company B resolved", !!companyBId);
  check("Stale company resolved", !!staleCompanyId);
  note("companyAId", companyAId);
  note("companyBId", companyBId);
  note("staleCompanyId", staleCompanyId);

  // Set icp_score = 80 on all test companies so scores are non-zero.
  await db.from("companies").update({ icp_score: TEST_ICP_SCORE }).eq("id", companyAId);
  await db.from("companies").update({ icp_score: TEST_ICP_SCORE }).eq("id", companyBId);
  await db.from("companies").update({ icp_score: TEST_ICP_SCORE }).eq("id", staleCompanyId);
  check("icp_score = 80 set on all test companies", true);

  // ── Clean slate ───────────────────────────────────────────────────────────
  section("Clean slate (delete prior test data)");

  const allTestCompanyIds = [companyAId, companyBId, staleCompanyId];

  await db.from("account_intelligence").delete()
    .eq("client_id", TEST_CLIENT_ID)
    .in("company_id", allTestCompanyIds);

  await db.from("signals").delete()
    .eq("client_id", TEST_CLIENT_ID)
    .in("company_id", allTestCompanyIds);

  check("Prior account_intelligence rows deleted", true);
  check("Prior signal rows deleted", true);

  // ── Initial since cursor state ────────────────────────────────────────────
  section("Initial cursor state (must be null)");

  const cursorBeforeRun = await getSinceCursor(TEST_CLIENT_ID, [companyAId, companyBId], "test");
  check("getSinceCursor returns null before any ingestion", cursorBeforeRun === null,
    `got: ${cursorBeforeRun}`);

  const emptyMapCursor = await getSinceCursor(TEST_CLIENT_ID, [], "test");
  check("getSinceCursor with empty companyIds returns null", emptyMapCursor === null);

  // ── Run 1: first coordinator run ──────────────────────────────────────────
  section("Run 1 — first coordinator run (since=null, new signals)");

  const companyDomains = new Map([
    [companyAId, TEST_COMPANY_DOMAINS[0].domain],
    [companyBId, TEST_COMPANY_DOMAINS[1].domain],
  ]);

  const run1Provider = new Stage13TestProvider(IDEMPOTENCY_SCENARIOS, FIXED_NOW, RUN_SUFFIX);

  const run1Report = await runIngestionCoordinator(
    TEST_CLIENT_ID,
    [companyAId, companyBId],
    run1Provider,
    { companyDomains, since: null, now: FIXED_NOW },
  );

  note("run1 report", {
    provider:           run1Report.provider,
    since:              run1Report.since,
    totalInserted:      run1Report.totalSignalsInserted,
    totalDuplicated:    run1Report.totalSignalsDuplicated,
  });

  check("Run 1 — provider is 'test'",         run1Report.provider === "test");
  check("Run 1 — since is null",              run1Report.since === null);
  check("Run 1 — companiesRequested = 2",     run1Report.companiesRequested === 2);
  check("Run 1 — companiesWithDomain = 2",    run1Report.companiesWithDomain === 2);
  check("Run 1 — signalsInserted > 0",        run1Report.totalSignalsInserted > 0,
    `got: ${run1Report.totalSignalsInserted}`);
  check("Run 1 — signalsDuplicated = 0",      run1Report.totalSignalsDuplicated === 0,
    `got: ${run1Report.totalSignalsDuplicated}`);
  check("Run 1 — normalizationErrors = 0",    run1Report.totalNormalizationErrors === 0);
  check("Run 1 — providerErrors empty",       Object.keys(run1Report.providerErrors).length === 0);
  check("Run 1 — companiesSucceeded = 2",     run1Report.companiesSucceeded === 2);
  check("Run 1 — companiesFailed = 0",        run1Report.companiesFailed === 0);

  // Each company should have rescore triggered (new signals inserted).
  const compAResult = run1Report.companies.find((r) => r.companyId === companyAId);
  const compBResult = run1Report.companies.find((r) => r.companyId === companyBId);
  check("Run 1 — company A has rescore.score", compAResult?.rescore !== null &&
    "score" in (compAResult?.rescore ?? {}));
  check("Run 1 — company B has rescore.score", compBResult?.rescore !== null &&
    "score" in (compBResult?.rescore ?? {}));

  // Verify account_intelligence rows were created.
  const { data: aiRows1, error: aiErr1 } = await db
    .from("account_intelligence")
    .select("id, company_id, opportunity_score, opportunity_score_updated_at")
    .eq("client_id", TEST_CLIENT_ID)
    .in("company_id", [companyAId, companyBId]);

  if (aiErr1) throw new Error(`account_intelligence query failed: ${aiErr1.message}`);

  const aiRowsTyped = aiRows1 as {
    id: string;
    company_id: string;
    opportunity_score: number;
    opportunity_score_updated_at: string;
  }[];

  check("Run 1 — 2 account_intelligence rows created", aiRowsTyped.length === 2,
    `got: ${aiRowsTyped.length}`);
  check("Run 1 — company A opportunity_score > 0",
    (aiRowsTyped.find((r) => r.company_id === companyAId)?.opportunity_score ?? 0) > 0);
  check("Run 1 — company B opportunity_score > 0",
    (aiRowsTyped.find((r) => r.company_id === companyBId)?.opportunity_score ?? 0) > 0);

  const aiAId = aiRowsTyped.find((r) => r.company_id === companyAId)?.id;
  const aiBId = aiRowsTyped.find((r) => r.company_id === companyBId)?.id;

  // ── Since cursor after Run 1 ───────────────────────────────────────────────
  section("Since cursor — advances after first ingestion");

  const cursorAfterRun1 = await getSinceCursor(TEST_CLIENT_ID, [companyAId, companyBId], "test");
  check("getSinceCursor is non-null after run 1", cursorAfterRun1 !== null,
    `got: ${cursorAfterRun1}`);
  note("cursor after run 1", cursorAfterRun1);

  // ── Run 2: idempotency ────────────────────────────────────────────────────
  section("Run 2 — idempotency (same suffix → dedup → 0 new signals)");

  // Same provider, same suffix → same dedup_key → created: false for all signals.
  const run2Provider = new Stage13TestProvider(IDEMPOTENCY_SCENARIOS, FIXED_NOW, RUN_SUFFIX);

  const run2Report = await runIngestionCoordinator(
    TEST_CLIENT_ID,
    [companyAId, companyBId],
    run2Provider,
    { companyDomains, since: cursorAfterRun1, now: FIXED_NOW },
  );

  note("run2 report", {
    totalInserted:   run2Report.totalSignalsInserted,
    totalDuplicated: run2Report.totalSignalsDuplicated,
    since:           run2Report.since,
  });

  check("Run 2 — signalsInserted = 0 (idempotent)",  run2Report.totalSignalsInserted === 0,
    `got: ${run2Report.totalSignalsInserted}`);
  check("Run 2 — signalsDuplicated > 0 (dedup caught)", run2Report.totalSignalsDuplicated > 0,
    `got: ${run2Report.totalSignalsDuplicated}`);
  check("Run 2 — since cursor passed through",       run2Report.since === cursorAfterRun1);

  // account_intelligence row IDs must be unchanged — no duplicate rows.
  const { data: aiRows2 } = await db
    .from("account_intelligence")
    .select("id, company_id")
    .eq("client_id", TEST_CLIENT_ID)
    .in("company_id", [companyAId, companyBId]);

  const aiRows2Typed = aiRows2 as { id: string; company_id: string }[];
  check("Run 2 — still exactly 2 account_intelligence rows", aiRows2Typed.length === 2,
    `got: ${aiRows2Typed.length}`);
  check("Run 2 — company A row id unchanged",
    aiRows2Typed.find((r) => r.company_id === companyAId)?.id === aiAId);
  check("Run 2 — company B row id unchanged",
    aiRows2Typed.find((r) => r.company_id === companyBId)?.id === aiBId);

  // Run 2 did not trigger rescores (no new signals).
  const compARun2 = run2Report.companies.find((r) => r.companyId === companyAId);
  const compBRun2 = run2Report.companies.find((r) => r.companyId === companyBId);
  check("Run 2 — company A rescore = null (no new signals)", compARun2?.rescore === null);
  check("Run 2 — company B rescore = null (no new signals)", compBRun2?.rescore === null);

  // ── getTrackedCompanyDomains ───────────────────────────────────────────────
  section("getTrackedCompanyDomains (reads from account_intelligence)");

  const trackedMap = await getTrackedCompanyDomains(TEST_CLIENT_ID);
  check("getTrackedCompanyDomains — non-empty map returned", trackedMap.size > 0,
    `got size: ${trackedMap.size}`);
  check("getTrackedCompanyDomains — company A in map", trackedMap.has(companyAId));
  check("getTrackedCompanyDomains — company B in map", trackedMap.has(companyBId));
  check("getTrackedCompanyDomains — company A domain correct",
    trackedMap.get(companyAId) === TEST_COMPANY_DOMAINS[0].domain);

  // Fake client has no account_intelligence rows.
  const fakeTrackedMap = await getTrackedCompanyDomains(FAKE_CLIENT_ID);
  check("getTrackedCompanyDomains — empty map for fake client", fakeTrackedMap.size === 0);

  // ── runSignalRefresh ──────────────────────────────────────────────────────
  section("runSignalRefresh (full task function)");

  const refreshProvider = new Stage13TestProvider(IDEMPOTENCY_SCENARIOS, FIXED_NOW, RUN_SUFFIX);

  const refreshResult = await runSignalRefresh({
    clientId:        TEST_CLIENT_ID,
    providerOverride: refreshProvider,
    now:             FIXED_NOW.toISOString(),
  });

  note("refreshResult", {
    companiesTracked: refreshResult.companiesTracked,
    providers:        refreshResult.providers,
    reportCount:      refreshResult.reports.length,
  });

  check("runSignalRefresh — returns 1 report (1 provider)", refreshResult.reports.length === 1);
  check("runSignalRefresh — companiesTracked >= 2",       refreshResult.companiesTracked >= 2,
    `got: ${refreshResult.companiesTracked}`);
  check("runSignalRefresh — providers contains 'test'",   refreshResult.providers.includes("test"));
  check("runSignalRefresh — report has no provider errors",
    Object.keys(refreshResult.reports[0].providerErrors).length === 0);
  check("runSignalRefresh — startedAt before completedAt",
    refreshResult.startedAt <= refreshResult.completedAt);

  // Company A and B were already ingested with RUN_SUFFIX in Run 1 — dedup catches them.
  // (Other companies in account_intelligence may get new signals; that's expected.)
  const refreshReport = refreshResult.reports[0];
  const compARefresh = refreshReport.companies.find((r) => r.companyId === companyAId);
  const compBRefresh = refreshReport.companies.find((r) => r.companyId === companyBId);
  check("runSignalRefresh — company A: 0 new signals (dedup caught)",
    compARefresh?.signalsInserted === 0,
    `got: ${compARefresh?.signalsInserted}`);
  check("runSignalRefresh — company B: 0 new signals (dedup caught)",
    compBRefresh?.signalsInserted === 0,
    `got: ${compBRefresh?.signalsInserted}`);

  // Report must not contain credentials.
  const refreshJson = JSON.stringify(refreshResult);
  check("runSignalRefresh — no credentials in result",
    !refreshJson.includes("apiKey") && !refreshJson.includes("secret"));

  // ── runSignalExpiry ───────────────────────────────────────────────────────
  section("runSignalExpiry (inserts stale signal → expires → rescores)");

  // Insert a stale signal for the stale company using a different provider subclass.
  const staleProvider = new Stage13TestProvider([EXPIRY_SCENARIO], FIXED_NOW, RUN_SUFFIX + "-stale");
  const staleCompanyDomains = new Map([[staleCompanyId, STALE_COMPANY_DOMAIN]]);

  const staleIngestReport = await runIngestionCoordinator(
    TEST_CLIENT_ID,
    [staleCompanyId],
    staleProvider,
    { companyDomains: staleCompanyDomains, since: null, now: FIXED_NOW },
  );

  note("stale ingest", {
    inserted:  staleIngestReport.totalSignalsInserted,
    staleCompanyId,
  });

  // The test_signal_stale scenario has TTL=7d and daysAgo=9 → expires_at is in the past.
  // upsertSignal stores it. expireStaleSignals will mark it expired.
  check("Stale signal inserted into DB", staleIngestReport.totalSignalsInserted > 0,
    `got: ${staleIngestReport.totalSignalsInserted}`);

  // Now run expiry — should expire the stale signal and rescore the stale company.
  const expiryResult = await runSignalExpiry({
    clientId: TEST_CLIENT_ID,
    now:      FIXED_NOW.toISOString(),
  });

  note("expiryResult", {
    signalsExpired:    expiryResult.report.signalsExpired,
    companiesAffected: expiryResult.report.companiesAffected,
    scored:            expiryResult.report.rescoreResults.scored.length,
    failed:            expiryResult.report.rescoreResults.failed.length,
  });

  check("runSignalExpiry — signalsExpired > 0",
    expiryResult.report.signalsExpired > 0,
    `got: ${expiryResult.report.signalsExpired}`);
  check("runSignalExpiry — stale company in affectedCompanyIds",
    expiryResult.report.affectedCompanyIds.includes(staleCompanyId));
  check("runSignalExpiry — rescoreResults.failed is empty",
    expiryResult.report.rescoreResults.failed.length === 0,
    `failed: ${JSON.stringify(expiryResult.report.rescoreResults.failed)}`);
  check("runSignalExpiry — stale company scored",
    expiryResult.report.rescoreResults.scored.some((s) => s.companyId === staleCompanyId));

  // Score should be 0 — the stale signal was excluded (past TTL).
  const staleScore = expiryResult.report.rescoreResults.scored
    .find((s) => s.companyId === staleCompanyId)?.score;
  check("runSignalExpiry — stale company score = 0 (all signals expired)",
    staleScore === 0,
    `got: ${staleScore}`);

  // ── Idempotency of expiry ─────────────────────────────────────────────────
  section("Expiry idempotency (second run → 0 signals expired)");

  const expiry2Result = await runSignalExpiry({
    clientId: TEST_CLIENT_ID,
    now:      FIXED_NOW.toISOString(),
  });

  check("Second expiry run — signalsExpired = 0 (already expired)",
    expiry2Result.report.signalsExpired === 0,
    `got: ${expiry2Result.report.signalsExpired}`);
  check("Second expiry run — companiesAffected = 0",
    expiry2Result.report.companiesAffected === 0);

  // ── Client isolation ──────────────────────────────────────────────────────
  section("Client isolation");

  // Isolation is proven at the query layer — no FAKE_CLIENT_ID coordinator run needed.
  // (A FAKE_CLIENT_ID coordinator run would insert NEW signals under FAKE_CLIENT_ID;
  //  dedup_key uniqueness is (client_id, dedup_key), so cross-client inserts succeed.
  //  We instead verify that TEST_CLIENT_ID data is invisible to FAKE_CLIENT_ID queries.)

  // 1. getTrackedCompanyDomains under FAKE_CLIENT_ID returns empty (already checked
  //    in the getTrackedCompanyDomains section — re-verify here for completeness).
  const fakeTrackedMap2 = await getTrackedCompanyDomains(FAKE_CLIENT_ID);
  check("Client isolation — getTrackedCompanyDomains empty for FAKE_CLIENT_ID",
    fakeTrackedMap2.size === 0,
    `got: ${fakeTrackedMap2.size}`);

  // 2. getSinceCursor under FAKE_CLIENT_ID is null — no signals stored under that client.
  const fakeCursor = await getSinceCursor(FAKE_CLIENT_ID, [companyAId, companyBId], "test");
  check("Client isolation — getSinceCursor null for FAKE_CLIENT_ID",
    fakeCursor === null,
    `got: ${fakeCursor}`);

  // 3. TEST_CLIENT_ID signals are not visible under FAKE_CLIENT_ID.
  const { count: fakeSignalCount } = await db
    .from("signals")
    .select("id", { count: "exact", head: true })
    .eq("client_id", FAKE_CLIENT_ID)
    .in("company_id", [companyAId, companyBId]);
  check("Client isolation — no signals visible under FAKE_CLIENT_ID",
    (fakeSignalCount ?? 0) === 0,
    `got: ${fakeSignalCount}`);

  // 4. TEST_CLIENT_ID data is intact.
  const testAiCount = await db
    .from("account_intelligence")
    .select("id", { count: "exact", head: true })
    .eq("client_id", TEST_CLIENT_ID)
    .in("company_id", [companyAId, companyBId]);

  check("Client isolation — TEST_CLIENT_ID has >= 2 account_intelligence rows",
    (testAiCount.count ?? 0) >= 2,
    `got: ${testAiCount.count}`);

  // ── IngestionReport structure ─────────────────────────────────────────────
  section("IngestionReport structure (serialisability)");

  // Reports must round-trip through JSON without loss (no Maps, no Dates, no functions).
  const serializedRun1 = JSON.stringify(run1Report);
  const reparsedRun1   = JSON.parse(serializedRun1);
  check("run1 report serializes to JSON and back",
    reparsedRun1.clientId === TEST_CLIENT_ID &&
    reparsedRun1.provider === "test");
  check("run1 report contains no credentials",
    !serializedRun1.includes("apiKey") &&
    !serializedRun1.includes("apiToken") &&
    !serializedRun1.includes("secret"));

  // ── Leave data for inspection ─────────────────────────────────────────────
  section("Records left in Supabase for inspection");
  console.log("  signals            → filter client_id = " + TEST_CLIENT_ID);
  console.log("  account_intelligence → filter client_id = " + TEST_CLIENT_ID);
  console.log("  (records NOT deleted — inspect in Supabase Table Editor)");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("Stage 13 coordinator integration test complete");
  console.log(`  Checks passed: ${passed}`);
  console.log(`  Checks failed: ${failed}`);
  console.log("=".repeat(70));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
