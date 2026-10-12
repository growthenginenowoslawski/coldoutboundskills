/**
 * Stage 12, Step 8 — Account Intelligence Full Lifecycle Integration Test.
 *
 * Validates the complete real-data path against a live Supabase instance:
 *
 *   FakeSignalProvider events
 *     → normalizeBatch() → upsertSignal() → signals table
 *     → rescoreCompany() → buildScoreInputs() → computeOpportunityScore()
 *     → upsertAccountIntelligence() → account_intelligence table
 *     → getRankedAccounts() → RankedAccountEntry[]
 *
 * What each section proves:
 *    1. Pre-flight              — env vars and Stage 10.5 test client present
 *    2. Company setup           — 3 test companies resolved (find-or-create)
 *    3. Signal insertion        — clean slate + 1 deterministic signal per company
 *    4. Initial rescore         — rescoreCompany() for all 3; expected ordering
 *    5. Ranking order           — getRankedAccounts() returns A > B > C by score
 *    6. Company identity        — companyName and companyDomain in each ranked entry
 *    7. score_inputs            — full breakdown preserved; signal UUIDs traceable
 *    8. Score accuracy          — ranked score == computeOpportunityScore() (independent)
 *    9. Client isolation        — getRankedAccounts() under fake clientId returns empty
 *   10. Idempotency             — second rescore → same score, same row id, count=1
 *   11. score_updated_at        — rescore with later now → opportunityScoreUpdatedAt changes
 *   12. Expiry lifecycle        — stale signal expires → rescoreAffectedCompanies
 *                                 → getRankedAccounts() reflects the updated timestamp
 *   13. Targeted rescore        — Company A untouched during Company C expiry cycle
 *
 * Uses FakeSignalProvider — NO external API calls.
 * Uses the Stage 10.5 test client (pre-existing; not re-created here).
 *
 * Cleanup model:
 *   Signals and account_intelligence rows for the 3 Step 8 test companies are
 *   DELETED at the start of each run, then re-inserted fresh. This prevents
 *   score drift from accumulated signals across runs while keeping the data in
 *   Supabase for inspection after each run. Company rows are left as-is.
 *
 * Run:
 *   npx tsx scripts/account-intelligence-integration-test.ts
 *
 * Env vars required:
 *   SUPABASE_URL        — always required
 *   SUPABASE_SECRET_KEY — always required
 *
 * API secrets are NEVER logged — only their presence is confirmed.
 * NO outbound calls (no emails, no Smartlead, no Trigger.dev tasks).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase";
import { upsertSignal, getSignalsByCompany, expireStaleSignals } from "../src/db/signals";
import {
  getAccountIntelligence,
  getRankedAccounts,
} from "../src/db/account-intelligence";
import type { RankedAccountEntry } from "../src/db/account-intelligence";
import { normalizeBatch } from "../src/providers/signals/normalizer";
import { FakeSignalProvider } from "../src/providers/signals/fake-provider";
import type { NormalizedSignal } from "../src/domain/signal-types";
import {
  rescoreCompany,
  rescoreAffectedCompanies,
} from "../src/lib/score-recompute";
import { buildScoreInputs, computeOpportunityScore } from "../src/lib/opportunity-scoring";
import { getCompanyIcpScore } from "../src/db/companies";

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

// Supabase returns timestamptz as "...+00:00"; JS Date.toISOString() produces "...Z".
// Both represent UTC — normalize before comparing.
function normalizeTs(ts: string): string {
  return ts.replace(/\+00:00$/, "Z");
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Stage 10.5 test client (must already exist — run Stage 10.5 integration test first)
const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
// Fake client that never exists in DB — used only to prove query isolation
const FAKE_CLIENT_ID = "00000000-0000-0000-0000-ffffffffffff";

// Run-unique suffix so each run creates distinct providerEventIds (dedup-safe)
const RUN_SUFFIX = Date.now().toString(36);

// Fixed reference timestamps for deterministic scoring across the test
const FIXED_NOW = new Date();
// 60 seconds later — used to verify opportunityScoreUpdatedAt changes on rescore
const LATER_NOW = new Date(FIXED_NOW.getTime() + 60_000);

// ICP score set on all test companies (must be > 0 for non-zero scoring)
const TEST_ICP_SCORE = 80;

// ── Test company specs ─────────────────────────────────────────────────────────
//
// Three companies chosen to produce clearly distinct expected scores (icp_score=80):
//
//   Company A — funding_series_a (funding_round):
//     strength=90, daysAgo=10, TTL=90d, icp_relevance=1.00
//     freshness = floor((80/90)×100) = 88
//     contribution = (90×88×1.00)/100 = 79.20
//     finalScore = min(100, round(79.20×1.0×0.80)) = round(63.36) = 63
//
//   Company B — executive_hire_vp_sales (executive_hire):
//     strength=75, daysAgo=5, TTL=30d, icp_relevance=0.90
//     freshness = floor((25/30)×100) = 83
//     contribution = (75×83×0.90)/100 = 56.03
//     finalScore = min(100, round(56.03×1.0×0.80)) = round(44.82) = 45
//
//   Company C — test_signal_stale (test type, icp_relevance=0.00):
//     score = 0 always (excluded by isExpired() guard; also icp_relevance=0.00)
//     Used to prove the expiry lifecycle and the two-guard exclusion in real data.
//
// Expected ranking: A (63) > B (45) > C (0)

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 12 Step 8 — Account Intelligence Full Lifecycle Integration Test");
  console.log("=".repeat(70));
  note("run_suffix",  RUN_SUFFIX);
  note("fixed_now",   FIXED_NOW.toISOString());
  note("later_now",   LATER_NOW.toISOString());

  const db = getSupabaseAdmin();
  const provider = new FakeSignalProvider();
  const nowStr = FIXED_NOW.toISOString();

  // ── Section 1: Pre-flight ─────────────────────────────────────────────────
  section("Pre-flight checks");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);

  if (!hasSupabase) {
    console.error("\nAbort: required environment variables missing.");
    process.exit(1);
  }

  const { data: clientRow, error: clientErr } = await db
    .from("clients")
    .select("id, name")
    .eq("id", TEST_CLIENT_ID)
    .maybeSingle();

  if (clientErr || !clientRow) {
    console.error(`\nAbort: test client ${TEST_CLIENT_ID} not found.`);
    console.error("Run the Stage 10.5 integration test first to create it.");
    process.exit(1);
  }
  check("Stage 10.5 test client exists in clients table", true);
  note("client_name", (clientRow as { name: string }).name);

  // ── Section 2: Company setup ──────────────────────────────────────────────
  section("Company setup (find-or-create by domain, icp_score kept current)");

  const companyAId = await findOrCreateCompany({
    name:     "Stage12-AccountIntel-A",
    domain:   "stage12-account-intel-a.test.internal",
    icpScore: TEST_ICP_SCORE,
  });
  const companyBId = await findOrCreateCompany({
    name:     "Stage12-AccountIntel-B",
    domain:   "stage12-account-intel-b.test.internal",
    icpScore: TEST_ICP_SCORE,
  });
  const companyCId = await findOrCreateCompany({
    name:     "Stage12-AccountIntel-C",
    domain:   "stage12-account-intel-c.test.internal",
    icpScore: TEST_ICP_SCORE,
  });

  check("Company A resolved", !!companyAId);
  check("Company B resolved", !!companyBId);
  check("Company C resolved", !!companyCId);
  note("company_a_id", companyAId);
  note("company_b_id", companyBId);
  note("company_c_id", companyCId);

  // ── Section 3: Clean previous run + insert fresh signals ──────────────────
  section("Clean previous run's data + insert 1 deterministic signal per company");

  // Delete account_intelligence rows from prior runs for these 3 companies.
  // This prevents score drift from accumulated signals and keeps the test
  // deterministic. Only the 3 Step 8 companies are touched; nothing else changes.
  await db
    .from("account_intelligence")
    .delete()
    .eq("client_id", TEST_CLIENT_ID)
    .in("company_id", [companyAId, companyBId, companyCId]);

  // Delete signals from prior runs (client-scoped). deleteSignal exists for
  // test-cleanup use per the doc comment in src/db/signals.ts.
  await db
    .from("signals")
    .delete()
    .eq("client_id", TEST_CLIENT_ID)
    .in("company_id", [companyAId, companyBId, companyCId]);

  // Insert exactly 1 signal per company with a fresh RUN_SUFFIX dedup key.
  const signalAId = await insertOneSignal(provider, companyAId, "funding_series_a",        nowStr);
  const signalBId = await insertOneSignal(provider, companyBId, "executive_hire_vp_sales",  nowStr);
  const signalCId = await insertOneSignal(provider, companyCId, "test_signal_stale",        nowStr);

  check("Company A signal inserted (funding_round, 1 signal)",     !!signalAId);
  check("Company B signal inserted (executive_hire, 1 signal)",    !!signalBId);
  check("Company C signal inserted (test stale, already past TTL)", !!signalCId);
  note("signal_a_id", signalAId);
  note("signal_b_id", signalBId);
  note("signal_c_id", signalCId);

  // ── Section 4: Initial rescore ────────────────────────────────────────────
  section("Initial rescore — rescoreCompany() for all 3 at FIXED_NOW");

  const rowA = await rescoreCompany(TEST_CLIENT_ID, companyAId, FIXED_NOW);
  const rowB = await rescoreCompany(TEST_CLIENT_ID, companyBId, FIXED_NOW);
  const rowC = await rescoreCompany(TEST_CLIENT_ID, companyCId, FIXED_NOW);

  note("company_a_score", rowA.opportunityScore);
  note("company_b_score", rowB.opportunityScore);
  note("company_c_score", rowC.opportunityScore);

  check(
    "Company A score > 0 (funding_round, icp_score=80)",
    rowA.opportunityScore > 0,
    `score=${rowA.opportunityScore}`,
  );
  check(
    "Company B score > 0 (executive_hire, icp_score=80)",
    rowB.opportunityScore > 0,
    `score=${rowB.opportunityScore}`,
  );
  check(
    "Company C score = 0 (test signal excluded by isExpired() guard, icp_relevance=0.00)",
    rowC.opportunityScore === 0,
    `score=${rowC.opportunityScore}`,
  );
  check(
    "Company A score > Company B score (funding_round beats executive_hire)",
    rowA.opportunityScore > rowB.opportunityScore,
    `A=${rowA.opportunityScore}, B=${rowB.opportunityScore}`,
  );
  check(
    "Company C excludedSignalCount = 1 (two-guard exclusion: isExpired caught stale active signal)",
    rowC.scoreInputs?.excludedSignalCount === 1,
    `excludedSignalCount=${rowC.scoreInputs?.excludedSignalCount}`,
  );

  // ── Section 5: Ranking order ──────────────────────────────────────────────
  section("getRankedAccounts() — ranking order");

  const ranked = await getRankedAccounts(TEST_CLIENT_ID, { limit: 200 });

  // Filter to the 3 Step 8 companies; other rows from Step 6 may also be present.
  const step8Ids = new Set([companyAId, companyBId, companyCId]);
  const step8Entries = ranked.filter((e) => step8Ids.has(e.companyId));

  note("total_ranked_entries",  ranked.length);
  note("step8_entries_found",   step8Entries.length);

  check("getRankedAccounts() returns at least 3 entries", ranked.length >= 3);
  check(
    "All 3 Step 8 companies present in ranked output",
    step8Entries.length === 3,
    `found ${step8Entries.length}/3`,
  );

  let entryA: RankedAccountEntry | undefined = ranked.find((e) => e.companyId === companyAId);
  let entryB: RankedAccountEntry | undefined = ranked.find((e) => e.companyId === companyBId);
  let entryC: RankedAccountEntry | undefined = ranked.find((e) => e.companyId === companyCId);

  // Positional ranking in the full list
  const posA = ranked.findIndex((e) => e.companyId === companyAId);
  const posB = ranked.findIndex((e) => e.companyId === companyBId);
  const posC = ranked.findIndex((e) => e.companyId === companyCId);

  check(
    "Company A ranked before Company B (score A > score B)",
    posA >= 0 && posB >= 0 && posA < posB,
    `posA=${posA}, posB=${posB}`,
  );
  check(
    "Company B ranked before Company C (score B > 0 = score C)",
    posB >= 0 && posC >= 0 && posB < posC,
    `posB=${posB}, posC=${posC}`,
  );

  // Verify the full list is in non-increasing score order (primary sort correct)
  const allOrdered = ranked.every((e, i) =>
    i === 0 || ranked[i - 1].opportunityScore >= e.opportunityScore,
  );
  check("Full ranked list is in non-increasing score order", allOrdered);

  // Ranked scores match what rescoreCompany returned
  check(
    "Entry A score in ranked output matches rescoreCompany result",
    entryA?.opportunityScore === rowA.opportunityScore,
    `ranked=${entryA?.opportunityScore}, rescore=${rowA.opportunityScore}`,
  );
  check(
    "Entry C score in ranked output = 0",
    entryC?.opportunityScore === 0,
    `score=${entryC?.opportunityScore}`,
  );

  // ── Section 6: Company identity ────────────────────────────────────────────
  section("Company identity — companyName, companyDomain in each ranked entry");

  check(
    "Entry A companyName = 'Stage12-AccountIntel-A' (company identity joined)",
    entryA?.companyName === "Stage12-AccountIntel-A",
    `got "${entryA?.companyName}"`,
  );
  check(
    "Entry A companyDomain = 'stage12-account-intel-a.test.internal'",
    entryA?.companyDomain === "stage12-account-intel-a.test.internal",
    `got "${entryA?.companyDomain}"`,
  );
  check(
    "Entry B companyName = 'Stage12-AccountIntel-B'",
    entryB?.companyName === "Stage12-AccountIntel-B",
    `got "${entryB?.companyName}"`,
  );
  check(
    "Entry A companyName is not the fallback [company:<uuid>]",
    !entryA?.companyName.startsWith("[company:"),
  );

  // ── Section 7: score_inputs preserved + signal UUID traceability ──────────
  section("score_inputs preserved in ranked entry + signalId traceability");

  check(
    "Entry A scoreInputs is non-null (JSONB round-tripped through account_intelligence)",
    entryA?.scoreInputs !== null && entryA?.scoreInputs !== undefined,
  );
  check(
    "Entry A scoreInputs.hypothesis = INITIAL_HYPOTHESIS_NOT_VALIDATED",
    entryA?.scoreInputs?.hypothesis === "INITIAL_HYPOTHESIS_NOT_VALIDATED",
  );
  check(
    "Entry A signalCount = 1 (promoted from score_inputs; 1 active signal)",
    entryA?.signalCount === 1,
    `signalCount=${entryA?.signalCount}`,
  );
  check(
    "Entry A icpScore = 80 (promoted from score_inputs)",
    entryA?.icpScore === TEST_ICP_SCORE,
    `icpScore=${entryA?.icpScore}`,
  );
  check(
    "Entry A opportunityScoreUpdatedAt is a non-empty ISO string (stale score visible)",
    typeof entryA?.opportunityScoreUpdatedAt === "string" &&
      entryA.opportunityScoreUpdatedAt.length > 0,
  );

  // Traceability: signalIds in score_inputs.signals[] must resolve to signals table rows
  const signalIdsA = entryA?.scoreInputs?.signals.map((s) => s.signalId) ?? [];
  if (signalIdsA.length > 0) {
    const { count: resolvedCount, error: resolveErr } = await db
      .from("signals")
      .select("id", { count: "exact", head: true })
      .in("id", signalIdsA);
    check(
      "All signalIds in score_inputs.signals[] resolve to rows in signals table",
      !resolveErr && resolvedCount === signalIdsA.length,
      resolveErr ? resolveErr.message : `resolved ${resolvedCount}/${signalIdsA.length}`,
    );
  }

  // ── Section 8: Score accuracy ──────────────────────────────────────────────
  section("Score accuracy — ranked score == computeOpportunityScore() (independent derivation)");

  // Re-derive Company A's expected score from scratch using live DB signals
  const dbSignalsA = await getSignalsByCompany(companyAId, TEST_CLIENT_ID, { status: "active" });
  const dbIcpA = await getCompanyIcpScore(companyAId);
  const { inputs: inputsA, excludedCount: excludedA } = buildScoreInputs(dbSignalsA, FIXED_NOW);
  const expectedA = computeOpportunityScore(inputsA, dbIcpA, FIXED_NOW, excludedA);

  note("independent_expected_score_a", expectedA.finalScore);
  note("independent_signal_count_a",   inputsA.length);
  note("independent_excluded_count_a", excludedA);

  check(
    "Ranked score for Company A == computeOpportunityScore() (independent derivation matches)",
    entryA?.opportunityScore === expectedA.finalScore,
    `ranked=${entryA?.opportunityScore}, expected=${expectedA.finalScore}`,
  );
  check(
    "score_inputs.finalScore matches the opportunity_score column",
    entryA?.scoreInputs?.finalScore === entryA?.opportunityScore,
    `inputs.finalScore=${entryA?.scoreInputs?.finalScore}, column=${entryA?.opportunityScore}`,
  );
  check(
    "score_inputs.signalCount matches active DB signals count",
    entryA?.scoreInputs?.signalCount === inputsA.length,
    `inputs.signalCount=${entryA?.scoreInputs?.signalCount}, db=${inputsA.length}`,
  );

  // ── Section 9: Client isolation ────────────────────────────────────────────
  section("Client isolation — getRankedAccounts() under fake clientId returns empty");

  const rankedFake = await getRankedAccounts(FAKE_CLIENT_ID, { limit: 200 });
  check(
    "getRankedAccounts(FAKE_CLIENT_ID) returns empty array",
    rankedFake.length === 0,
    `got ${rankedFake.length} entries`,
  );

  const { count: fakeRowCount, error: fakeErr } = await db
    .from("account_intelligence")
    .select("id", { count: "exact", head: true })
    .eq("client_id", FAKE_CLIENT_ID);
  check(
    "No account_intelligence rows exist in DB for FAKE_CLIENT_ID",
    !fakeErr && fakeRowCount === 0,
    fakeErr ? fakeErr.message : `count=${fakeRowCount}`,
  );

  // ── Section 10: Idempotency ────────────────────────────────────────────────
  section("Idempotency — second rescoreCompany → same score, same id, no duplicate rows");

  const rowA2 = await rescoreCompany(TEST_CLIENT_ID, companyAId, FIXED_NOW);

  check(
    "Second rescore: opportunity_score unchanged",
    rowA2.opportunityScore === rowA.opportunityScore,
    `first=${rowA.opportunityScore}, second=${rowA2.opportunityScore}`,
  );
  check(
    "Second rescore: row id unchanged (ON CONFLICT upsert, no duplicate created)",
    rowA2.id === rowA.id,
    `first=${rowA.id}, second=${rowA2.id}`,
  );

  const { count: rowCountA, error: rowCountErr } = await db
    .from("account_intelligence")
    .select("id", { count: "exact", head: true })
    .eq("client_id", TEST_CLIENT_ID)
    .eq("company_id", companyAId);
  check(
    "Exactly 1 account_intelligence row for (client, company_A) after 2 rescores",
    !rowCountErr && rowCountA === 1,
    rowCountErr ? rowCountErr.message : `count=${rowCountA}`,
  );

  // ── Section 11: opportunityScoreUpdatedAt changes on rescore ─────────────
  section("opportunityScoreUpdatedAt — changes when rescored at later now");

  const updatedAtBefore = rowA2.opportunityScoreUpdatedAt;
  const rowALater = await rescoreCompany(TEST_CLIENT_ID, companyAId, LATER_NOW);
  const updatedAtAfter = rowALater.opportunityScoreUpdatedAt;

  note("updated_at_before", updatedAtBefore);
  note("updated_at_after",  updatedAtAfter);
  note("later_now_iso",     LATER_NOW.toISOString());

  check(
    "opportunityScoreUpdatedAt changed after rescore with LATER_NOW",
    updatedAtAfter !== updatedAtBefore,
    `before=${updatedAtBefore}, after=${updatedAtAfter}`,
  );
  check(
    "opportunityScoreUpdatedAt equals LATER_NOW (normalized: +00:00 == Z)",
    normalizeTs(updatedAtAfter) === LATER_NOW.toISOString(),
    `got=${updatedAtAfter}, expected=${LATER_NOW.toISOString()}`,
  );

  // Verify getRankedAccounts() reflects the updated timestamp
  const rankedAfterLater = await getRankedAccounts(TEST_CLIENT_ID, { limit: 200 });
  const entryAAfterLater = rankedAfterLater.find((e) => e.companyId === companyAId);
  check(
    "getRankedAccounts() reflects updated opportunityScoreUpdatedAt after LATER_NOW rescore",
    normalizeTs(entryAAfterLater?.opportunityScoreUpdatedAt ?? "") === LATER_NOW.toISOString(),
    `ranked=${entryAAfterLater?.opportunityScoreUpdatedAt}`,
  );

  // ── Section 12: Expiry lifecycle → ranked readout updated ─────────────────
  section("Expiry lifecycle — stale signal expires → rescoreAffectedCompanies → ranked updated");

  // Company C's signal (test_signal_stale, daysAgo=9, TTL=7d) is already past TTL.
  // expireStaleSignals will mark it status="expired" if still active.
  // On re-run (same test run): the signal was just inserted fresh, so it should always expire.
  const rowCBeforeExpiry = await getAccountIntelligence(TEST_CLIENT_ID, companyCId);
  note("company_c_updated_at_before_expiry", rowCBeforeExpiry?.opportunityScoreUpdatedAt);

  const expireResult = await expireStaleSignals(TEST_CLIENT_ID);
  note("expire_count",                   expireResult.count);
  note("expire_affected_company_ids",    expireResult.affectedCompanyIds);

  const companyCWasAffected = expireResult.affectedCompanyIds.includes(companyCId);
  note("company_c_was_affected_by_expiry", companyCWasAffected);

  check(
    "Company C IS in affectedCompanyIds (stale signal active → expired by expireStaleSignals)",
    companyCWasAffected,
    !companyCWasAffected ? "company C not found in affectedCompanyIds" : undefined,
  );
  check(
    "Company A NOT in affectedCompanyIds (funding_round signal is still fresh)",
    !expireResult.affectedCompanyIds.includes(companyAId),
  );
  check(
    "Company B NOT in affectedCompanyIds (executive_hire signal is still fresh)",
    !expireResult.affectedCompanyIds.includes(companyBId),
  );

  // Rescore affected companies at a distinct timestamp to prove updated_at changes
  const EXPIRY_NOW = new Date(LATER_NOW.getTime() + 60_000);
  const rescoreResult = await rescoreAffectedCompanies(
    TEST_CLIENT_ID,
    expireResult.affectedCompanyIds,
    EXPIRY_NOW,
  );
  note("rescore_scored", rescoreResult.scored);
  note("rescore_failed", rescoreResult.failed);

  check(
    "rescoreAffectedCompanies completed with no failures",
    rescoreResult.failed.length === 0,
    rescoreResult.failed.map((f) => `${f.companyId}: ${f.error}`).join("; "),
  );

  if (companyCWasAffected) {
    const rowCAfterExpiry = await getAccountIntelligence(TEST_CLIENT_ID, companyCId);
    check(
      "Company C score still 0 after expiry (no active signals remain)",
      rowCAfterExpiry?.opportunityScore === 0,
      `score=${rowCAfterExpiry?.opportunityScore}`,
    );
    check(
      "Company C opportunityScoreUpdatedAt updated to EXPIRY_NOW (normalized)",
      normalizeTs(rowCAfterExpiry?.opportunityScoreUpdatedAt ?? "") === EXPIRY_NOW.toISOString(),
      `got=${rowCAfterExpiry?.opportunityScoreUpdatedAt}, expected=${EXPIRY_NOW.toISOString()}`,
    );

    // Verify the ranked readout reflects the updated state
    const rankedAfterExpiry = await getRankedAccounts(TEST_CLIENT_ID, { limit: 200 });
    const entryCAfterExpiry = rankedAfterExpiry.find((e) => e.companyId === companyCId);
    check(
      "getRankedAccounts() after expiry: Company C score still 0",
      entryCAfterExpiry?.opportunityScore === 0,
    );
    check(
      "getRankedAccounts() after expiry: Company C opportunityScoreUpdatedAt = EXPIRY_NOW (normalized)",
      normalizeTs(entryCAfterExpiry?.opportunityScoreUpdatedAt ?? "") === EXPIRY_NOW.toISOString(),
      `ranked=${entryCAfterExpiry?.opportunityScoreUpdatedAt}`,
    );
  }

  // ── Section 13: Targeted rescore — Company A untouched ───────────────────
  section("Targeted rescore — Company A not rescored during Company C expiry cycle");

  const rowAFinal = await getAccountIntelligence(TEST_CLIENT_ID, companyAId);

  check(
    "Company A NOT in expiry affectedCompanyIds (targeted: only stale-signal companies)",
    !expireResult.affectedCompanyIds.includes(companyAId),
  );
  check(
    "Company A opportunityScoreUpdatedAt unchanged by Company C expiry cycle (normalized)",
    normalizeTs(rowAFinal?.opportunityScoreUpdatedAt ?? "") === LATER_NOW.toISOString(),
    `expected=${LATER_NOW.toISOString()}, got=${rowAFinal?.opportunityScoreUpdatedAt}`,
  );

  // Final ranked call: verify Company A still present with correct score
  const rankedFinal = await getRankedAccounts(TEST_CLIENT_ID, { limit: 200 });
  const entryAFinal = rankedFinal.find((e) => e.companyId === companyAId);
  check(
    "Company A appears in final getRankedAccounts() call with correct score",
    entryAFinal?.opportunityScore === rowALater.opportunityScore,
    `ranked=${entryAFinal?.opportunityScore}, expected=${rowALater.opportunityScore}`,
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("Stage 12 Step 8 integration test complete");
  console.log(`  Checks passed: ${passed}`);
  console.log(`  Checks failed: ${failed}`);
  console.log("\n  Test data left for inspection:");
  console.log(`    account_intelligence: client_id = ${TEST_CLIENT_ID}`);
  console.log(`      companies: ${companyAId} (A), ${companyBId} (B), ${companyCId} (C)`);
  console.log(`    signals: same companies under same client_id`);
  console.log(`    company rows: 3 test companies with .test.internal domains`);
  console.log("=".repeat(70));

  if (failed > 0) {
    process.exit(1);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

interface CompanySpec {
  name: string;
  domain: string;
  icpScore: number;
}

async function findOrCreateCompany(spec: CompanySpec): Promise<string> {
  const db = getSupabaseAdmin();

  const { data: existing, error: findErr } = await db
    .from("companies")
    .select("id")
    .eq("domain", spec.domain)
    .maybeSingle();

  if (findErr) throw new Error(`findOrCreateCompany lookup failed: ${findErr.message}`);

  if (existing) {
    const id = (existing as { id: string }).id;
    console.log(`  ~ existing: ${spec.name} (${spec.domain}) → ${id}`);
    // Always keep icp_score current for determinism across runs
    await db.from("companies").update({ icp_score: spec.icpScore }).eq("id", id);
    return id;
  }

  const { data, error } = await db
    .from("companies")
    .insert({
      name:        spec.name,
      domain:      spec.domain,
      website_url: null,
      status:      "review",
      source:      "stage12-account-intel-test",
      icp_score:   spec.icpScore,
    })
    .select("id")
    .single();

  if (error) throw new Error(`findOrCreateCompany insert failed: ${error.message}`);
  const id = (data as { id: string }).id;
  console.log(`  + created: ${spec.name} (${spec.domain}) → ${id}`);
  return id;
}

async function insertOneSignal(
  provider: FakeSignalProvider,
  companyId: string,
  scenario: string,
  detectedAt: string,
): Promise<string> {
  const batch = await provider.fetchEvents([companyId], TEST_CLIENT_ID, {
    scenarios:     [scenario],
    asOf:          FIXED_NOW,
    eventIdSuffix: RUN_SUFFIX,
  });
  const normalized = normalizeBatch(batch.events, detectedAt)
    .filter((o) => o.ok)
    .map((o) => (o as { ok: true; signal: NormalizedSignal }).signal);

  if (normalized.length === 0) {
    throw new Error(`insertOneSignal: normalization failed for scenario "${scenario}"`);
  }

  const { row } = await upsertSignal(normalized[0]);
  return row.id;
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
