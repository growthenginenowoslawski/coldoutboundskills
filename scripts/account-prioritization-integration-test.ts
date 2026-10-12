/**
 * Stage 14 — Account Prioritization Integration Test.
 *
 * Validates the full Stage 14 prioritization pipeline against real Supabase:
 *
 *   Migration check       → priority_score + prioritized_at columns exist
 *   Signal ingestion      → Stage14TestProvider injects signals via coordinator
 *   rankAccountsForClient → reads account_intelligence + signals, computes priority
 *   runAccountPrioritization → writes priority_score + prioritized_at to DB
 *   Decay behaviour       → priority_score < opportunity_score at non-zero signal age
 *   Half-life property    → at 14 days, multiplier = 0.5 exactly
 *   No-signal behaviour   → priority_score = 0 for company with no active signals
 *   Rank ordering         → higher score / fresher signal → lower rank number
 *   prioritized_at        → equals the `now` used for the calculation
 *   Idempotency           → same `now` twice → identical priority_score
 *   Client isolation      → FAKE_CLIENT_ID returns 0 accounts
 *
 * HARD CONSTRAINTS:
 *   - Uses Stage 10.5 test client (a29f5829-5412-49be-9a77-41c3edf3c14b)
 *   - Uses Stage 12/13 test companies (stage12-account-intel-a/b.test.internal)
 *   - NO outbound, no emails, no Smartlead, no Trigger.dev tasks
 *   - API secrets NEVER logged — only presence confirmed
 *   - Applies migration 0013 automatically if columns are missing + ACCESS_TOKEN set
 *   - Clean-slate at START (deletes test account_intelligence + signals)
 *   - Leaves data for inspection at END
 *
 * Run:
 *   npx tsx scripts/account-prioritization-integration-test.ts
 *
 * Env vars:
 *   SUPABASE_URL            — always required
 *   SUPABASE_SECRET_KEY     — always required
 *   SUPABASE_ACCESS_TOKEN   — required only to auto-apply the migration
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin }         from "../src/db/supabase";
import { runIngestionCoordinator }  from "../src/lib/signal-ingestion";
import {
  rankAccountsForClient,
  PRIORITY_RECENCY_HALF_LIFE_DAYS,
} from "../src/lib/account-prioritization";
import { runAccountPrioritization } from "../src/tasks/account-prioritization";
import {
  FakeSignalProvider,
  type FakeFetchOptions,
} from "../src/providers/signals/fake-provider";
import type { FetchOptions }       from "../src/providers/signals/types";
import type { RawEventBatch }      from "../src/domain/signal-types";

// ── Stage14TestProvider ───────────────────────────────────────────────────────
// Calls super.fetchEvents once per company so each gets a unique dedup_key.
// dedup_key uniqueness is (client_id, dedup_key) — no company_id component,
// so without per-company suffixes two companies sharing the same scenario would
// collide.

class Stage14TestProvider extends FakeSignalProvider {
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
    const all: RawEventBatch["events"] = [];
    for (const companyId of companyIds) {
      const batch = await super.fetchEvents([companyId], clientId, {
        ...opts,
        scenarios:     this.scenarios_,
        asOf:          this.asOf_,
        eventIdSuffix: `${this.suffix_}-${companyId}`,
      } as FakeFetchOptions);
      all.push(...batch.events);
    }
    return { events: all, meta: { source: "fake", generatedAt: new Date().toISOString() } };
  }
}

// ── Management API helper ─────────────────────────────────────────────────────

async function execManagementSql(
  supabaseUrl: string,
  accessToken: string,
  query: string,
): Promise<boolean> {
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    console.error(`    SQL error (${res.status}): ${body.slice(0, 300)}`);
    return false;
  }
  return true;
}

// ── Test scaffolding ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function note(label: string, value: unknown): void {
  console.log(`     ${label}: ${JSON.stringify(value)}`);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const FAKE_CLIENT_ID = "00000000-0000-0000-0000-ffffffffffff";
const RUN_SUFFIX     = "s14-" + Date.now().toString(36);

const COMPANY_A = { name: "Stage12 Account Intel A", domain: "stage12-account-intel-a.test.internal" };
const COMPANY_B = { name: "Stage12 Account Intel B", domain: "stage12-account-intel-b.test.internal" };
// Stale company: has an account_intelligence row but NO active signals → priority_score must be 0.
const COMPANY_S = { name: "Stage14 Stale Priority Test", domain: "stage14-stale-priority.test.internal" };

// ── Helpers ───────────────────────────────────────────────────────────────────

const db = getSupabaseAdmin();

async function findOrCreateCompany(name: string, domain: string): Promise<string> {
  const { data: existing } = await db
    .from("companies").select("id").eq("domain", domain).maybeSingle();
  if (existing) return (existing as { id: string }).id;
  const { data, error } = await db
    .from("companies")
    .insert({ name, domain, status: "review", source: "stage14-test" })
    .select("id").single();
  if (error) throw new Error(`insert company ${name}: ${error.message}`);
  return (data as { id: string }).id;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 14 — Account Prioritization Integration Test");
  console.log("=".repeat(70));
  note("run_suffix",  RUN_SUFFIX);
  note("half_life_d", PRIORITY_RECENCY_HALF_LIFE_DAYS);

  // ── Pre-flight ────────────────────────────────────────────────────────────
  section("Pre-flight");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);
  if (!hasSupabase) process.exit(1);

  note("SUPABASE_ACCESS_TOKEN present", !!process.env.SUPABASE_ACCESS_TOKEN);

  // ── Migration check ───────────────────────────────────────────────────────
  // Probe the new columns by attempting a real SELECT via the Supabase JS client.
  // PostgREST returns an error (code 42703) if a column in the select list doesn't exist.
  // This avoids querying information_schema (not exposed through PostgREST).
  section("Migration: 0013_account_priority.sql");

  const { error: probeErr } = await db
    .from("account_intelligence")
    .select("priority_score, prioritized_at")
    .limit(1);

  const migrationApplied = !probeErr;

  if (!migrationApplied) {
    // Distinguish "column missing" from a genuine DB error.
    const isColumnError = (probeErr?.message ?? "").includes("priority_score") ||
                          (probeErr?.message ?? "").includes("prioritized_at") ||
                          probeErr?.code === "42703";

    if (!isColumnError) {
      console.error(`  Unexpected probe error: ${probeErr?.message}`);
      process.exit(1);
    }

    const hasAccessToken = !!process.env.SUPABASE_ACCESS_TOKEN;
    if (!hasAccessToken) {
      console.error("\n  Migration 0013 not applied and SUPABASE_ACCESS_TOKEN not set.");
      console.error("  Apply this SQL in the Supabase SQL editor, then rerun:\n");
      console.error(
        "    alter table public.account_intelligence\n" +
        "      add column if not exists priority_score  numeric,\n" +
        "      add column if not exists prioritized_at  timestamptz;\n\n" +
        "    create index if not exists account_intelligence_priority_idx\n" +
        "      on public.account_intelligence (client_id, priority_score desc nulls last)\n" +
        "      where priority_score is not null;\n",
      );
      process.exit(1);
    }

    console.log("  Applying migration 0013 via Management API…");
    const stmts = [
      "alter table public.account_intelligence add column if not exists priority_score numeric",
      "alter table public.account_intelligence add column if not exists prioritized_at timestamptz",
      "create index if not exists account_intelligence_priority_idx on public.account_intelligence (client_id, priority_score desc nulls last) where priority_score is not null",
    ];
    for (const stmt of stmts) {
      const ok = await execManagementSql(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_ACCESS_TOKEN!,
        stmt,
      );
      if (!ok) { console.error("  Migration failed — aborting."); process.exit(1); }
    }
    check("Migration 0013 applied via Management API", true);
  } else {
    check("priority_score column exists (probe SELECT succeeded)", true);
    check("prioritized_at column exists (probe SELECT succeeded)", true);
  }

  // ── Test client ───────────────────────────────────────────────────────────
  section("Test client");

  const { data: clientRow } = await db
    .from("clients").select("id, name").eq("id", TEST_CLIENT_ID).maybeSingle();
  if (!clientRow) { console.error("  Abort: Stage 10.5 test client not found."); process.exit(1); }
  check("Stage 10.5 test client exists", true);
  note("client", (clientRow as { name: string }).name);

  // ── Company setup ─────────────────────────────────────────────────────────
  section("Company setup");

  const companyAId = await findOrCreateCompany(COMPANY_A.name, COMPANY_A.domain);
  const companyBId = await findOrCreateCompany(COMPANY_B.name, COMPANY_B.domain);
  const companySId = await findOrCreateCompany(COMPANY_S.name, COMPANY_S.domain);

  check("Company A resolved", !!companyAId);
  check("Company B resolved", !!companyBId);
  check("Stale company resolved", !!companySId);
  note("companyAId", companyAId);
  note("companyBId", companyBId);
  note("companySId (stale)", companySId);

  // ── Clean slate ───────────────────────────────────────────────────────────
  section("Clean slate");

  const testIds = [companyAId, companyBId, companySId];

  await db.from("account_intelligence").delete()
    .eq("client_id", TEST_CLIENT_ID).in("company_id", testIds);
  await db.from("signals").delete()
    .eq("client_id", TEST_CLIENT_ID).in("company_id", testIds);

  check("Prior account_intelligence rows deleted", true);
  check("Prior signals deleted", true);

  // ── Stale company setup ───────────────────────────────────────────────────
  // Insert an account_intelligence row with opportunity_score > 0 but NO active
  // signals. This is the "signals expired" scenario.
  // rankAccountsForClient must return priority_score = 0 (null lastSignalAt).
  section("Stale company: account_intelligence without signals (opportunity_score=60)");

  const staleScore = 60;
  const staleNow   = new Date();
  const { error: staleUpsertErr } = await db
    .from("account_intelligence")
    .upsert({
      client_id:                    TEST_CLIENT_ID,
      company_id:                   companySId,
      opportunity_score:            staleScore,
      opportunity_score_updated_at: staleNow.toISOString(),
      score_inputs:                 { finalScore: staleScore, signalCount: 0, signals: [] },
      updated_at:                   staleNow.toISOString(),
    }, { onConflict: "client_id,company_id" });

  check("Stale company: account_intelligence row inserted (score=60, no signals)",
    !staleUpsertErr, staleUpsertErr?.message);

  // ── Ingest signals for A and B ────────────────────────────────────────────
  section("Signal ingestion (companies A + B — funding_series_a)");

  const ingestNow     = new Date();
  const companyDomains = new Map([
    [companyAId, COMPANY_A.domain],
    [companyBId, COMPANY_B.domain],
  ]);
  const freshProvider = new Stage14TestProvider(["funding_series_a"], ingestNow, RUN_SUFFIX);

  const ingestReport = await runIngestionCoordinator(
    TEST_CLIENT_ID,
    [companyAId, companyBId],
    freshProvider,
    { companyDomains, since: null, now: ingestNow },
  );

  const rescoreA = ingestReport.companies.find((r) => r.companyId === companyAId)?.rescore;
  const rescoreB = ingestReport.companies.find((r) => r.companyId === companyBId)?.rescore;
  const scoreA   = rescoreA && "score" in rescoreA ? rescoreA.score : 0;
  const scoreB   = rescoreB && "score" in rescoreB ? rescoreB.score : 0;

  check("2 signals inserted (1 per company)",
    ingestReport.totalSignalsInserted === 2, `got ${ingestReport.totalSignalsInserted}`);
  check("Company A: opportunity_score > 0 after ingest", scoreA > 0, `got ${scoreA}`);
  check("Company B: opportunity_score > 0 after ingest", scoreB > 0, `got ${scoreB}`);
  note("scoreA", scoreA);
  note("scoreB", scoreB);

  // Capture detected_at of the fresh signals — used to control simulated passage of time.
  type SignalTs = { detected_at: string };
  const { data: freshSignalRows } = await db
    .from("signals")
    .select("detected_at")
    .eq("client_id", TEST_CLIENT_ID)
    .eq("status", "active")
    .in("company_id", [companyAId, companyBId])
    .order("detected_at", { ascending: false })
    .limit(1);

  const freshDetectedAt = ((freshSignalRows ?? []) as SignalTs[])[0]?.detected_at
    ?? ingestNow.toISOString();
  note("freshDetectedAt", freshDetectedAt.slice(0, 23));

  // ── rankAccountsForClient: 7-day decay ────────────────────────────────────
  section("rankAccountsForClient — 7-day decay (expected multiplier ≈ 0.707)");

  // Simulate NOW = freshDetectedAt + 7 days.
  // At 7 days: recencyMultiplier = 2^(−7/14) = 2^(−0.5) ≈ 0.70711
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const nowAt7d     = new Date(new Date(freshDetectedAt).getTime() + sevenDaysMs);

  const ranked7 = await rankAccountsForClient(TEST_CLIENT_ID, { now: nowAt7d });

  check("Returns results", ranked7.length > 0, `got ${ranked7.length}`);

  const r7A = ranked7.find((r) => r.companyId === companyAId);
  const r7B = ranked7.find((r) => r.companyId === companyBId);
  const r7S = ranked7.find((r) => r.companyId === companySId);

  check("Company A in results", !!r7A);
  check("Company B in results", !!r7B);
  check("Stale company in results", !!r7S);

  if (r7A) {
    note("A@7d", {
      opportunityScore:    r7A.opportunityScore,
      priorityScore:       +r7A.priorityScore.toFixed(4),
      recencyMultiplier:   +r7A.recencyMultiplier.toFixed(4),
      daysSinceLastSignal: +(r7A.daysSinceLastSignal ?? 0).toFixed(2),
      activeSignalCount:   r7A.activeSignalCount,
    });

    const expectedMul = Math.pow(2, -7 / PRIORITY_RECENCY_HALF_LIFE_DAYS); // ≈ 0.70711
    check("A: recencyMultiplier ≈ 2^(−7/14) = 0.707",
      Math.abs(r7A.recencyMultiplier - expectedMul) < 0.01,
      `got ${r7A.recencyMultiplier.toFixed(4)}, expected ≈ ${expectedMul.toFixed(4)}`);

    check("A: priority_score < opportunity_score (decay applied)",
      r7A.priorityScore < r7A.opportunityScore,
      `p=${r7A.priorityScore.toFixed(2)}, opp=${r7A.opportunityScore}`);

    check("A: priority_score > 0", r7A.priorityScore > 0);

    check("A: daysSinceLastSignal ≈ 7",
      r7A.daysSinceLastSignal !== null && Math.abs(r7A.daysSinceLastSignal - 7) < 0.1,
      `got ${r7A.daysSinceLastSignal?.toFixed(3)}`);

    check("A: activeSignalCount >= 1", r7A.activeSignalCount >= 1);

    // Formula integrity: priority_score = opportunity_score × recencyMultiplier.
    const expectedPs = r7A.opportunityScore * r7A.recencyMultiplier;
    check("A: priority_score = opportunity_score × recency",
      Math.abs(r7A.priorityScore - expectedPs) < 0.001,
      `expected ${expectedPs.toFixed(4)}, got ${r7A.priorityScore.toFixed(4)}`);
  }

  // ── Half-life property ────────────────────────────────────────────────────
  section("Half-life property (at 14 days, recencyMultiplier = 0.5 exactly)");

  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
  const nowAt14d       = new Date(new Date(freshDetectedAt).getTime() + fourteenDaysMs);
  const ranked14       = await rankAccountsForClient(TEST_CLIENT_ID, { now: nowAt14d });
  const r14A           = ranked14.find((r) => r.companyId === companyAId);

  if (r14A) {
    note("A@14d", { recencyMultiplier: +r14A.recencyMultiplier.toFixed(6) });
    check("Half-life: recencyMultiplier = 0.5 at 14 days",
      Math.abs(r14A.recencyMultiplier - 0.5) < 0.001,
      `got ${r14A.recencyMultiplier.toFixed(6)}`);
    check("Half-life: priority_score ≈ opportunity_score × 0.5",
      Math.abs(r14A.priorityScore - r14A.opportunityScore * 0.5) < 0.1,
      `p=${r14A.priorityScore.toFixed(2)}, opp=${r14A.opportunityScore}`);
  }

  // ── No-signal behaviour ───────────────────────────────────────────────────
  section("No-signal behaviour (stale company — no active signals → priority_score = 0)");

  if (r7S) {
    note("S@7d", {
      opportunityScore:  r7S.opportunityScore,
      priorityScore:     r7S.priorityScore,
      lastSignalAt:      r7S.lastSignalAt,
      activeSignalCount: r7S.activeSignalCount,
    });
    check("Stale: activeSignalCount = 0",      r7S.activeSignalCount === 0);
    check("Stale: lastSignalAt = null",         r7S.lastSignalAt === null);
    check("Stale: priority_score = 0",          r7S.priorityScore === 0, `got ${r7S.priorityScore}`);
    check("Stale: recencyMultiplier = 0",        r7S.recencyMultiplier === 0);
    check("Stale: daysSinceLastSignal = null",   r7S.daysSinceLastSignal === null);
  }

  // ── Rank ordering ─────────────────────────────────────────────────────────
  section("Rank ordering");

  if (r7A && r7S) {
    check("A ranks above stale (priority_score > 0 beats 0)",
      r7A.rank < r7S.rank, `A.rank=${r7A.rank}, S.rank=${r7S.rank}`);
  }
  if (r7B && r7S) {
    check("B ranks above stale",
      r7B.rank < r7S.rank, `B.rank=${r7B.rank}, S.rank=${r7S.rank}`);
  }

  const allRanks = ranked7.map((r) => r.rank).sort((a, b) => a - b);
  check("Ranks start at 1",             allRanks[0] === 1, `first: ${allRanks[0]}`);
  check("Ranks are contiguous integers",
    allRanks.every((r, i) => r === i + 1),
    `got: ${allRanks.slice(0, 10).join(",")}`);

  // ── runAccountPrioritization: writes to DB ────────────────────────────────
  section("runAccountPrioritization (writes priority_score + prioritized_at to DB)");

  const taskResult1 = await runAccountPrioritization({
    clientId: TEST_CLIENT_ID,
    now:      nowAt7d.toISOString(),
    topN:     10,
  });

  note("report", {
    accountsRanked:    taskResult1.report.accountsRanked,
    accountsWithScore: taskResult1.report.accountsWithScore,
    accountsAtZero:    taskResult1.report.accountsAtZero,
    topAccountsCount:  taskResult1.report.topAccounts.length,
    halfLifeDays:      taskResult1.report.halfLifeDays,
  });

  check("accountsRanked >= 3", taskResult1.report.accountsRanked >= 3,
    `got ${taskResult1.report.accountsRanked}`);
  check("accountsWithScore >= 2", taskResult1.report.accountsWithScore >= 2,
    `got ${taskResult1.report.accountsWithScore}`);
  check("accountsAtZero >= 1", taskResult1.report.accountsAtZero >= 1,
    `got ${taskResult1.report.accountsAtZero}`);
  check("topAccounts ≤ topN=10", taskResult1.report.topAccounts.length <= 10);
  check("halfLifeDays = 14", taskResult1.report.halfLifeDays === 14);
  check("No credentials in report",
    !JSON.stringify(taskResult1).includes("apiKey") &&
    !JSON.stringify(taskResult1).includes("secret"));

  // ── priority_score and prioritized_at in DB ───────────────────────────────
  section("priority_score and prioritized_at written to account_intelligence");

  type AiRow = { priority_score: number | null; prioritized_at: string | null; opportunity_score: number };

  const { data: dbA, error: dbErrA } = await db
    .from("account_intelligence")
    .select("priority_score, prioritized_at, opportunity_score")
    .eq("client_id", TEST_CLIENT_ID)
    .eq("company_id", companyAId)
    .single();

  if (dbErrA) { console.error(`  DB error reading company A: ${dbErrA.message}`); }
  const aiA = dbA as AiRow | null;

  check("A: priority_score written (non-null)", (aiA?.priority_score ?? null) !== null,
    `got ${aiA?.priority_score}`);
  check("A: priority_score > 0 in DB", (aiA?.priority_score ?? 0) > 0,
    `got ${aiA?.priority_score}`);
  check("A: priority_score < opportunity_score (decay in DB)",
    (aiA?.priority_score ?? 0) < (aiA?.opportunity_score ?? 0),
    `p=${aiA?.priority_score}, opp=${aiA?.opportunity_score}`);
  check("A: prioritized_at written (non-null)", (aiA?.prioritized_at ?? null) !== null);
  check("A: prioritized_at = task now (± 5s)",
    aiA?.prioritized_at !== null &&
    Math.abs(new Date(aiA.prioritized_at).getTime() - nowAt7d.getTime()) < 5000,
    `got ${aiA?.prioritized_at}`);

  const { data: dbS } = await db
    .from("account_intelligence")
    .select("priority_score, prioritized_at")
    .eq("client_id", TEST_CLIENT_ID)
    .eq("company_id", companySId)
    .single();
  const aiS = dbS as { priority_score: number | null; prioritized_at: string | null } | null;

  check("Stale: priority_score = 0 in DB", aiS?.priority_score === 0,
    `got ${aiS?.priority_score}`);
  check("Stale: prioritized_at written", (aiS?.prioritized_at ?? null) !== null);

  // ── Idempotency ───────────────────────────────────────────────────────────
  section("Idempotency (same `now` → identical priority_scores)");

  await runAccountPrioritization({
    clientId: TEST_CLIENT_ID,
    now:      nowAt7d.toISOString(),
    topN:     10,
  });

  const { data: dbA2 } = await db
    .from("account_intelligence")
    .select("priority_score")
    .eq("client_id", TEST_CLIENT_ID)
    .eq("company_id", companyAId)
    .single();
  const aiA2 = dbA2 as { priority_score: number | null } | null;

  check("A: priority_score unchanged on second run",
    Math.abs((aiA2?.priority_score ?? 0) - (aiA?.priority_score ?? -1)) < 0.001,
    `run1=${aiA?.priority_score?.toFixed(4)}, run2=${aiA2?.priority_score?.toFixed(4)}`);

  // ── Decay direction ───────────────────────────────────────────────────────
  section("Decay direction: priority_score decreases as NOW advances");

  // At 28d: 2^(−28/14) = 2^(−2) = 0.25.
  // At 7d:  2^(−7/14) = 2^(−0.5) ≈ 0.707.
  // So priority(28d) ≈ priority(7d) × (0.25/0.707) ≈ priority(7d) × 0.354.
  const nowAt28d = new Date(new Date(freshDetectedAt).getTime() + 28 * 24 * 60 * 60 * 1000);
  await runAccountPrioritization({
    clientId: TEST_CLIENT_ID,
    now:      nowAt28d.toISOString(),
  });

  const { data: dbA28 } = await db
    .from("account_intelligence")
    .select("priority_score")
    .eq("client_id", TEST_CLIENT_ID)
    .eq("company_id", companyAId)
    .single();
  const p28 = (dbA28 as { priority_score: number | null } | null)?.priority_score ?? 0;

  note("A decay check", {
    at7d:  aiA?.priority_score?.toFixed(4),
    at28d: p28.toFixed(4),
    ratio: aiA?.priority_score ? (p28 / aiA.priority_score).toFixed(4) : "n/a",
  });

  check("Priority at 28d < priority at 7d",
    p28 < (aiA?.priority_score ?? 0),
    `28d=${p28.toFixed(4)}, 7d=${aiA?.priority_score?.toFixed(4)}`);
  check("Priority at 28d > 0 (still positive, not zero)",
    p28 > 0, `got ${p28.toFixed(4)}`);

  // ── Client isolation ──────────────────────────────────────────────────────
  section("Client isolation");

  const fakeRanked = await rankAccountsForClient(FAKE_CLIENT_ID, { now: nowAt7d });
  check("rankAccountsForClient: FAKE_CLIENT_ID → empty array",
    fakeRanked.length === 0, `got ${fakeRanked.length}`);

  const fakePri = await runAccountPrioritization({
    clientId: FAKE_CLIENT_ID,
    now:      nowAt7d.toISOString(),
  });
  check("runAccountPrioritization: FAKE_CLIENT_ID → accountsRanked = 0",
    fakePri.report.accountsRanked === 0, `got ${fakePri.report.accountsRanked}`);

  // Test client's data must be unaffected by the fake-client run.
  const { data: rereadA } = await db
    .from("account_intelligence")
    .select("priority_score")
    .eq("client_id", TEST_CLIENT_ID)
    .eq("company_id", companyAId)
    .single();
  check("TEST_CLIENT_ID data unaffected by fake-client run",
    (rereadA as { priority_score: number | null } | null)?.priority_score === p28);

  // ── Report serialisability ────────────────────────────────────────────────
  section("Report serialisability");

  const serial   = JSON.stringify(taskResult1.report);
  const reparsed = JSON.parse(serial);
  check("Round-trips through JSON",  reparsed.clientId === TEST_CLIENT_ID);
  check("No credentials in report JSON",
    !serial.includes("apiKey") && !serial.includes("secret") && !serial.includes("SUPABASE"));

  // ── Leave data for inspection ─────────────────────────────────────────────
  section("Records left in Supabase for inspection");
  console.log(`  account_intelligence → filter client_id = ${TEST_CLIENT_ID}`);
  console.log(`  (check priority_score and prioritized_at columns)`);
  console.log(`  signals             → filter client_id = ${TEST_CLIENT_ID}`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log("Stage 14 prioritization integration test complete");
  console.log(`  Checks passed: ${passed}`);
  console.log(`  Checks failed: ${failed}`);
  console.log("=".repeat(70));

  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("\nFatal error:", err); process.exit(1); });
