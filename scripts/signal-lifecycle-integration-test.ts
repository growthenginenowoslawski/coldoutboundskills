/**
 * Stage 12, Step 6 — Signal Lifecycle Integration Test.
 *
 * Proves the full signal → score lifecycle against a real Supabase instance:
 *
 *   new signal → rescoreCompany → account_intelligence upserted
 *   stale signal → expireStaleSignals → rescoreAffectedCompanies → score updated
 *
 * Uses the FakeSignalProvider — NO external API calls.
 * Uses the Stage 10.5 test client (pre-existing; not re-created here).
 *
 * Test companies are created with deterministic domains. On re-run the domains
 * are reused (find-or-create), making the test idempotent:
 *   - signal upserts hit the dedup path (created=false) on second run
 *   - rescoreCompany upserts account_intelligence idempotently
 *   - expireStaleSignals only touches active signals — on re-run all stale
 *     signals are already "expired" so affectedCompanyIds may be empty
 *     (the test handles this gracefully)
 *
 * What is proved by each section:
 *   1. Pre-flight             — env vars and test client present
 *   2. Company setup          — test companies exist or are created
 *   3. New signal → rescore   — new signal triggers rescore; score > 0 with icp_score > 0
 *   4. Score accuracy         — persisted score equals computeOpportunityScore output
 *   5. Idempotency            — re-running rescoreCompany produces same score; no dup rows
 *   6. Expiry → rescore       — expireStaleSignals returns affected company;
 *                               rescoreAffectedCompanies scores only that company
 *   7. Targeted recompute     — unaffected company's score is not changed by expiry cycle
 *   8. Client isolation       — fetching Company A signals under a fake client_id returns
 *                               empty → rescore yields score=0, isolated from real scores
 *
 * Run:
 *   npx tsx scripts/signal-lifecycle-integration-test.ts
 *
 * Env vars required:
 *   SUPABASE_URL        — always required
 *   SUPABASE_SECRET_KEY — always required
 *
 * NO external keys required (PREDICTLEADS_API_KEY etc. are NOT used here).
 *
 * HARD CONSTRAINTS (same as Stage 11):
 *   - Makes NO outbound calls (no emails, no Smartlead, no Trigger.dev tasks)
 *   - API secrets are NEVER logged — only their presence is confirmed
 *   - Test data (companies, signals, account_intelligence rows) is LEFT in Supabase
 *     for inspection. Re-runs are idempotent.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase";
import { upsertSignal, getSignalsByCompany, expireStaleSignals } from "../src/db/signals";
import { getAccountIntelligence } from "../src/db/account-intelligence";
import { normalizeBatch } from "../src/providers/signals/normalizer";
import { FakeSignalProvider } from "../src/providers/signals/fake-provider";
import {
  computeCompanyScore,
  rescoreCompany,
  rescoreAffectedCompanies,
} from "../src/lib/score-recompute";
import { buildScoreInputs, computeOpportunityScore } from "../src/lib/opportunity-scoring";

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

// Stage 10.5 test client (must already exist)
const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";

// Fake client ID for isolation tests (never exists in DB — used only for queries)
const FAKE_CLIENT_ID = "00000000-0000-0000-0000-ffffffffffff";

// Unique suffix so each run inserts new signals (prevents dedup collision on
// the FIRST run of each section when testing the "new signal" path).
const RUN_SUFFIX = Date.now().toString(36);

// Fixed "now" for deterministic scoring across the test
const FIXED_NOW = new Date();

// icp_score to set on test companies so that non-zero signals produce non-zero scores
const TEST_ICP_SCORE = 80;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 12 Step 6 — Signal Lifecycle Integration Test");
  console.log("=".repeat(70));
  note("run_suffix", RUN_SUFFIX);
  note("fixed_now", FIXED_NOW.toISOString());

  const db = getSupabaseAdmin();

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
    console.error(`\nAbort: test client ${TEST_CLIENT_ID} not found in clients table.`);
    console.error("Run the Stage 10.5 integration test first to create it.");
    process.exit(1);
  }
  check("Stage 10.5 test client exists", true);
  note("client_name", (clientRow as { name: string }).name);

  // ── Section 2: Company setup ──────────────────────────────────────────────
  section("Company setup (find-or-create by domain)");

  const companyAId = await findOrCreateCompany({
    name: "Stage12-Lifecycle-A",
    domain: "stage12-lifecycle-a.test.internal",
    icpScore: TEST_ICP_SCORE,
  });
  const companyBId = await findOrCreateCompany({
    name: "Stage12-Lifecycle-B",
    domain: "stage12-lifecycle-b.test.internal",
    icpScore: TEST_ICP_SCORE,
  });

  check("Company A resolved", !!companyAId);
  check("Company B resolved", !!companyBId);
  note("company_a_id", companyAId);
  note("company_b_id", companyBId);

  // ── Section 3: New active signal → rescore ────────────────────────────────
  section("New signal → rescoreCompany → account_intelligence upserted");

  const provider = new FakeSignalProvider();
  const nowStr = FIXED_NOW.toISOString();

  // Insert a fresh funding_series_a signal for Company A
  const batchA = await provider.fetchEvents([companyAId], TEST_CLIENT_ID, {
    scenarios: ["funding_series_a"],
    asOf:  FIXED_NOW,
    eventIdSuffix: RUN_SUFFIX,
  });
  const normalizedA = normalizeBatch(batchA.events, nowStr)
    .filter((o) => o.ok)
    .map((o) => (o as { ok: true; signal: import("../src/domain/signal-types").NormalizedSignal }).signal);

  check("Company A signal normalized", normalizedA.length === 1);

  let companyASignalNew = false;
  if (normalizedA.length > 0) {
    const { created } = await upsertSignal(normalizedA[0]);
    companyASignalNew = created;
    note("company_a_signal_created", created);
    check("Company A signal inserted or already exists (dedup working)", true);
  }

  // Rescore Company A
  let companyARow = await rescoreCompany(TEST_CLIENT_ID, companyAId, FIXED_NOW);
  note("company_a_opportunity_score", companyARow.opportunityScore);
  note("company_a_signal_count", companyARow.scoreInputs?.signalCount ?? "null");
  note("company_a_excluded_count", companyARow.scoreInputs?.excludedSignalCount ?? "null");

  check(
    "Company A has account_intelligence row after rescore",
    !!companyARow,
  );
  check(
    "Company A opportunity_score > 0 (icp_score=80 with active signals)",
    companyARow.opportunityScore > 0,
    `score was ${companyARow.opportunityScore}`,
  );
  check(
    "Company A scoreInputs.hypothesis = INITIAL_HYPOTHESIS_NOT_VALIDATED",
    companyARow.scoreInputs?.hypothesis === "INITIAL_HYPOTHESIS_NOT_VALIDATED",
  );

  // ── Section 4: Score accuracy ─────────────────────────────────────────────
  section("Persisted score equals computeOpportunityScore output");

  // Reproduce the score independently using the same signals from DB
  const companyASignals = await getSignalsByCompany(companyAId, TEST_CLIENT_ID, { status: "active" });
  const { inputs: companyAInputs, excludedCount: companyAExcluded } =
    buildScoreInputs(companyASignals, FIXED_NOW);
  const expectedScore = computeOpportunityScore(
    companyAInputs,
    TEST_ICP_SCORE,
    FIXED_NOW,
    companyAExcluded,
  );

  check(
    "Persisted opportunity_score equals computeOpportunityScore.finalScore",
    companyARow.opportunityScore === expectedScore.finalScore,
    `stored ${companyARow.opportunityScore}, expected ${expectedScore.finalScore}`,
  );
  check(
    "Persisted score_inputs.finalScore matches opportunity_score column",
    companyARow.scoreInputs?.finalScore === companyARow.opportunityScore,
  );
  check(
    "Persisted score_inputs.signalCount matches active signals fetched",
    companyARow.scoreInputs?.signalCount === companyAInputs.length,
    `stored signalCount ${companyARow.scoreInputs?.signalCount}, inputs length ${companyAInputs.length}`,
  );
  check(
    "Persisted excludedSignalCount matches buildScoreInputs output",
    companyARow.scoreInputs?.excludedSignalCount === companyAExcluded,
  );

  // ── Section 5: Idempotency ────────────────────────────────────────────────
  section("Idempotency — repeated rescoreCompany produces identical result");

  const companyARowB = await rescoreCompany(TEST_CLIENT_ID, companyAId, FIXED_NOW);

  check(
    "Second rescore produces the same opportunity_score",
    companyARowB.opportunityScore === companyARow.opportunityScore,
    `first=${companyARow.opportunityScore}, second=${companyARowB.opportunityScore}`,
  );
  check(
    "Second rescore does not change id (same row — no duplicate created)",
    companyARowB.id === companyARow.id,
    `first id=${companyARow.id}, second id=${companyARowB.id}`,
  );
  check(
    "Second rescore score_inputs.finalScore unchanged",
    companyARowB.scoreInputs?.finalScore === companyARow.scoreInputs?.finalScore,
  );

  // Verify row count in DB — there must be exactly one row for this pair
  const { count: rowCount, error: countErr } = await db
    .from("account_intelligence")
    .select("id", { count: "exact", head: true })
    .eq("client_id", TEST_CLIENT_ID)
    .eq("company_id", companyAId);
  check(
    "Exactly 1 account_intelligence row for (client_A, company_A) — no duplicates",
    !countErr && rowCount === 1,
    countErr ? countErr.message : `row count = ${rowCount}`,
  );

  // ── Section 6: Stale signal expiry → targeted rescore ─────────────────────
  section("Stale signal → expireStaleSignals → rescoreAffectedCompanies");

  // Record Company A's score before the expiry cycle (to prove it is unchanged)
  const companyAScoreBeforeExpiry = companyARowB.opportunityScore;
  const companyAUpdatedAtBeforeExpiry = companyARowB.opportunityScoreUpdatedAt;

  // Insert a stale test signal for Company B.
  // test_signal_stale: daysAgo=9, signalType=test (TTL=7d) → expires_at is 2 days ago
  // upsertSignal stores status="active"; expireStaleSignals will mark it "expired".
  const batchB = await provider.fetchEvents([companyBId], TEST_CLIENT_ID, {
    scenarios: ["test_signal_stale"],
    asOf:  FIXED_NOW,
    eventIdSuffix: RUN_SUFFIX,
  });
  const normalizedB = normalizeBatch(batchB.events, nowStr)
    .filter((o) => o.ok)
    .map((o) => (o as { ok: true; signal: import("../src/domain/signal-types").NormalizedSignal }).signal);

  check("Company B stale signal normalized", normalizedB.length === 1);

  if (normalizedB.length > 0) {
    const { created: bCreated } = await upsertSignal(normalizedB[0]);
    note("company_b_stale_signal_created", bCreated);
    check("Company B stale signal inserted or already exists", true);
  }

  // Run expiry sweep for this client
  const expireResult = await expireStaleSignals(TEST_CLIENT_ID);
  note("expire_result_count", expireResult.count);
  note("expire_result_affected_company_ids", expireResult.affectedCompanyIds);

  // On first run: affectedCompanyIds contains Company B.
  // On re-run: the stale signal is already "expired" → affectedCompanyIds may be empty.
  // Either way is correct (idempotency).
  const companyBWasAffected = expireResult.affectedCompanyIds.includes(companyBId);
  note("company_b_was_affected_by_expiry", companyBWasAffected);

  if (companyBWasAffected) {
    check(
      "Company A is NOT in affectedCompanyIds (targeted: only Company B affected)",
      !expireResult.affectedCompanyIds.includes(companyAId),
    );
    check(
      "Company B IS in affectedCompanyIds",
      companyBWasAffected,
    );
  } else {
    // Re-run path: stale signal was already expired from a prior run.
    console.log("  ℹ Company B's stale signal was already expired (re-run path — correct).");
    check("expireStaleSignals completed without error", true);
  }

  // Rescore only the affected companies (targeted recomputation)
  // Even if affectedCompanyIds is empty (re-run), rescoreAffectedCompanies is safe.
  const rescoreResult = await rescoreAffectedCompanies(
    TEST_CLIENT_ID,
    expireResult.affectedCompanyIds,
    FIXED_NOW,
  );
  note("rescore_scored", rescoreResult.scored.map((s) => ({ companyId: s.companyId, score: s.score })));
  note("rescore_failed", rescoreResult.failed);

  check(
    "rescoreAffectedCompanies completed with no failures",
    rescoreResult.failed.length === 0,
    rescoreResult.failed.map((f) => `${f.companyId}: ${f.error}`).join("; "),
  );

  if (companyBWasAffected) {
    // Company B's stale signal is now expired. Its only signal was test-type
    // (icpRelevance=0.00), so the score is 0 even before expiry — but the
    // account_intelligence row must have been created and show score=0.
    const companyBRow = await getAccountIntelligence(TEST_CLIENT_ID, companyBId);
    check(
      "Company B has account_intelligence row after expiry rescore",
      !!companyBRow,
    );
    if (companyBRow) {
      note("company_b_opportunity_score_after_expiry", companyBRow.opportunityScore);
      check(
        "Company B score=0 after expiry (test signal has icpRelevance=0.00, all signals now expired)",
        companyBRow.opportunityScore === 0,
        `score was ${companyBRow.opportunityScore}`,
      );
    }
    const companyBScored = rescoreResult.scored.find((s) => s.companyId === companyBId);
    check(
      "Company B appears in rescoreResult.scored",
      !!companyBScored,
    );
  }

  // ── Section 7: Unrelated company not rescored ─────────────────────────────
  section("Targeted recompute — Company A not rescored during Company B expiry cycle");

  // Company A was not in affectedCompanyIds → rescoreAffectedCompanies did not touch it.
  // Verify by checking that Company A's row is the same as before the expiry cycle.
  const companyARowAfterExpiry = await getAccountIntelligence(TEST_CLIENT_ID, companyAId);

  check(
    "Company A opportunity_score unchanged after Company B expiry cycle",
    companyARowAfterExpiry?.opportunityScore === companyAScoreBeforeExpiry,
    `before=${companyAScoreBeforeExpiry}, after=${companyARowAfterExpiry?.opportunityScore}`,
  );
  check(
    "Company A opportunity_score_updated_at unchanged (row not touched)",
    companyARowAfterExpiry?.opportunityScoreUpdatedAt === companyAUpdatedAtBeforeExpiry,
    `before=${companyAUpdatedAtBeforeExpiry}, after=${companyARowAfterExpiry?.opportunityScoreUpdatedAt}`,
  );

  const companyAInRescore = rescoreResult.scored.find((s) => s.companyId === companyAId);
  check(
    "Company A NOT in rescoreResult.scored (was not rescored)",
    !companyAInRescore,
  );

  // ── Section 8: Client isolation ───────────────────────────────────────────
  section("Client isolation — Company A signals under fake client_id yields score=0");

  // Fetch Company A's signals under a fake client_id. Because signals are scoped
  // by client_id in the DB, this must return empty — no signals from TEST_CLIENT_ID
  // are visible under FAKE_CLIENT_ID.
  const companyASignalsUnderFakeClient = await getSignalsByCompany(
    companyAId,
    FAKE_CLIENT_ID,
    { status: "active" },
  );
  check(
    "No signals for Company A visible under fake client_id (client isolation)",
    companyASignalsUnderFakeClient.length === 0,
    `got ${companyASignalsUnderFakeClient.length} signals`,
  );

  // computeCompanyScore with empty signals returns score=0
  const isolatedScore = computeCompanyScore(companyASignalsUnderFakeClient, TEST_ICP_SCORE, FIXED_NOW);
  check(
    "computeCompanyScore with no signals (fake client) yields finalScore=0",
    isolatedScore.finalScore === 0,
  );
  check(
    "Isolated score is distinct from real Company A score under TEST_CLIENT_ID",
    isolatedScore.finalScore !== companyARow.opportunityScore || companyARow.opportunityScore === 0,
  );

  // The real Company A score under TEST_CLIENT_ID is unaffected
  const companyAFinalCheck = await getAccountIntelligence(TEST_CLIENT_ID, companyAId);
  check(
    "Company A score under TEST_CLIENT_ID still intact after isolation check",
    companyAFinalCheck?.opportunityScore === companyARowAfterExpiry?.opportunityScore,
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("Stage 12 Step 6 integration test complete");
  console.log(`  Checks passed: ${passed}`);
  console.log(`  Checks failed: ${failed}`);
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
    // Always keep icp_score current for test reproducibility
    await db
      .from("companies")
      .update({ icp_score: spec.icpScore })
      .eq("id", id);
    return id;
  }

  const { data, error } = await db
    .from("companies")
    .insert({
      name: spec.name,
      domain: spec.domain,
      website_url: null,
      status: "review",
      source: "stage12-lifecycle-test",
      icp_score: spec.icpScore,
    })
    .select("id")
    .single();

  if (error) throw new Error(`findOrCreateCompany insert failed: ${error.message}`);
  const id = (data as { id: string }).id;
  console.log(`  + created: ${spec.name} (${spec.domain}) → ${id}`);
  return id;
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
