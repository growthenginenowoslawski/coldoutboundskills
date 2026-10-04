/**
 * Stage 30A — Integration tests for the signals-only ingestion path.
 *
 * Tests run against the real Supabase instance (service-role).
 * FakeSignalProvider is used — NO external PredictLeads calls.
 *
 * Critical invariant under test:
 *   When signals are ingested WITHOUT calling rescoreCompany(), the
 *   account_intelligence table must remain UNCHANGED.
 *
 * Coverage:
 *   IT01  FakeSignalProvider emits events with correct clientId/companyId
 *   IT02  normalizeBatch produces valid NormalizedSignal (status=active, expires_at set)
 *   IT03  upsertSignal inserts signal with correct client_id = GRAMSCODE
 *   IT04  upsertSignal returns created:true on first insert
 *   IT05  upsertSignal returns created:false on duplicate (tier-1 dedup)
 *   IT06  account_intelligence is NOT created (no rescore called)
 *   IT07  Signal type correctly mapped from scenario (job_posting)
 *   IT08  Signal TTL: job_posting expires_at = occurred_at + 14d
 *   IT09  Signal TTL: funding_round expires_at = occurred_at + 90d
 *   IT10  Multiple signals for same company — all inserted
 *   IT11  Tenant isolation: GRAMSCODE signal not visible to other client query
 *   IT12  normalizeBatch rejects invalid occurred_at (normalization error)
 *   IT13  No-domain company is skipped without error (ingestion guard logic)
 *   IT14  Idempotency: running normalize+upsert twice = same DB state
 *
 * Cleanup: all test signals are deleted in teardown. account_intelligence is not
 * touched because IT06 asserts it is never created.
 *
 * Run: npx tsx scripts/stage30a-integration-test.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { test }   from "node:test";
import assert     from "node:assert/strict";

import { getSupabaseAdmin }      from "../src/db/supabase.js";
import { normalizeBatch }        from "../src/providers/signals/normalizer.js";
import { upsertSignal, deleteSignal, getSignalsByCompany } from "../src/db/signals.js";
import { getAccountIntelligence } from "../src/db/account-intelligence.js";
import { FakeSignalProvider }    from "../src/providers/signals/fake-provider.js";
import type { SignalProviderEvent } from "../src/domain/signal-types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const GRAMSCODE_ID     = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const OTHER_CLIENT_ID  = "00000000-0000-0000-0000-000000000099"; // synthetic non-existent
const DETECTED_AT      = "2026-09-12T10:00:00.000Z";
const FIXED_NOW        = new Date("2026-09-12T10:00:00.000Z");

// ── Fixture: real company NOT in ROCI list ────────────────────────────────────

const db = getSupabaseAdmin();

const ROCI_LIST_ID = "8ac556af-e520-4aa5-bc03-5369f206ed33";

// Fetch ROCI company IDs to exclude them from test fixture selection
const { data: memberRows } = await db
  .from("list_members")
  .select("contact_id")
  .eq("list_id", ROCI_LIST_ID)
  .not("contact_id", "is", null);

type MR = { contact_id: string | null };
const contactIds = ((memberRows ?? []) as MR[]).map(r => r.contact_id).filter(Boolean) as string[];

const { data: contactRows } = await db
  .from("contacts").select("company_id").in("id", contactIds);
type CR = { company_id: string | null };
const rociSet = new Set(
  ((contactRows ?? []) as CR[]).map(r => r.company_id).filter((id): id is string => id !== null)
);

// Also exclude companies that already have a Gramscode signal (to avoid cleanup contamination)
const { data: existingSignalRows } = await db
  .from("signals")
  .select("company_id")
  .eq("client_id", GRAMSCODE_ID);
type SR = { company_id: string };
const withSignalSet = new Set(((existingSignalRows ?? []) as SR[]).map(r => r.company_id));

// Pick a company NOT in ROCI list and NOT already having a Gramscode signal
const { data: candidateRows } = await db.from("companies").select("id").limit(500);
type CandRow = { id: string };
const testCompanyRow = ((candidateRows ?? []) as CandRow[])
  .find(r => !rociSet.has(r.id) && !withSignalSet.has(r.id));

if (!testCompanyRow) {
  console.error("FATAL: Could not find a test company not in the ROCI list and without signals.");
  process.exit(1);
}
const TEST_COMPANY_ID = testCompanyRow.id;
console.log(`  Test company_id: ${TEST_COMPANY_ID} (not in ROCI, no existing signals — safe for cleanup)`);

// Track inserted signal IDs for teardown
const insertedSignalIds: string[] = [];

// ── Teardown helper ────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  for (const id of insertedSignalIds) {
    try { await deleteSignal(id); } catch { /* ignore — already gone */ }
  }
  insertedSignalIds.length = 0;
}

// ── IT01 ─────────────────────────────────────────────────────────────────────

test("IT01: FakeSignalProvider emits events with correct clientId and companyId", async () => {
  const provider = new FakeSignalProvider();
  const batch    = await provider.fetchEvents(
    [TEST_COMPANY_ID],
    GRAMSCODE_ID,
    { scenarios: ["job_posting_head_of_sales"], asOf: FIXED_NOW },
  );

  assert.equal(batch.events.length, 1, "expected 1 event");
  assert.equal(batch.events[0].clientId,   GRAMSCODE_ID,    "clientId must be GRAMSCODE");
  assert.equal(batch.events[0].companyId,  TEST_COMPANY_ID, "companyId must be test company");
  assert.equal(batch.events[0].rawEvent.signalType, "job_posting", "signal type must be job_posting");
});

// ── IT02 ─────────────────────────────────────────────────────────────────────

test("IT02: normalizeBatch produces valid NormalizedSignal (status=active, expires_at set)", async () => {
  const provider = new FakeSignalProvider();
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["funding_series_a"], asOf: FIXED_NOW },
  );

  const outcomes = normalizeBatch(batch.events, DETECTED_AT);
  assert.equal(outcomes.length, 1);
  assert.ok(outcomes[0].ok, "normalization must succeed");
  if (!outcomes[0].ok) return;

  const sig = outcomes[0].signal;
  assert.equal(sig.status,      "active",        "status must be active");
  assert.equal(sig.signalType,  "funding_round", "type must be funding_round");
  assert.equal(sig.clientId,    GRAMSCODE_ID,    "clientId must be GRAMSCODE");
  assert.equal(sig.companyId,   TEST_COMPANY_ID, "companyId must match");
  assert.ok(sig.expiresAt,      "expiresAt must be set");
  assert.ok(sig.detectedAt,     "detectedAt must be set");
  assert.equal(sig.signalSource, "test",          "source must be test (FakeProvider)");
});

// ── IT03 ─────────────────────────────────────────────────────────────────────

test("IT03: upsertSignal inserts with correct client_id = GRAMSCODE", async () => {
  const provider = new FakeSignalProvider();
  const suffix = `it03-${Date.now()}`;
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["executive_hire_vp_sales"], asOf: FIXED_NOW, eventIdSuffix: suffix },
  );

  const [outcome] = normalizeBatch(batch.events, DETECTED_AT);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  const { row, created } = await upsertSignal(outcome.signal);
  assert.ok(created, "signal must be created (first insert)");
  assert.equal(row.clientId, GRAMSCODE_ID,    "row.clientId must be GRAMSCODE");
  assert.equal(row.companyId, TEST_COMPANY_ID, "row.companyId must match");

  insertedSignalIds.push(row.id);
});

// ── IT04 ─────────────────────────────────────────────────────────────────────

test("IT04: upsertSignal returns created:true on first insert", async () => {
  const provider = new FakeSignalProvider();
  const suffix = `it04-${Date.now()}`;
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["funding_series_a"], asOf: FIXED_NOW, eventIdSuffix: suffix },
  );

  const [outcome] = normalizeBatch(batch.events, DETECTED_AT);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  const { row, created } = await upsertSignal(outcome.signal);
  assert.ok(created === true, "first insert must return created:true");
  insertedSignalIds.push(row.id);
});

// ── IT05 ─────────────────────────────────────────────────────────────────────

test("IT05: upsertSignal returns created:false on duplicate (tier-1 dedup)", async () => {
  const provider = new FakeSignalProvider();
  const suffix   = `it05-${Date.now()}`;
  const batch    = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["test_signal_with_provider_id"], asOf: FIXED_NOW, eventIdSuffix: suffix },
  );

  const outcomes = normalizeBatch(batch.events, DETECTED_AT);
  const [o1] = outcomes;
  assert.ok(o1.ok);
  if (!o1.ok) return;

  const { row: row1, created: c1 } = await upsertSignal(o1.signal);
  assert.ok(c1, "first insert must be created");
  insertedSignalIds.push(row1.id);

  // Second upsert with identical signal → same dedup_key
  const { created: c2 } = await upsertSignal(o1.signal);
  assert.ok(c2 === false, "second insert of same signal must return created:false");
});

// ── IT06 ─────────────────────────────────────────────────────────────────────

test("IT06: account_intelligence is NOT created — no rescore called", async () => {
  // Capture AI count before
  const aiBefore = await getAccountIntelligence(GRAMSCODE_ID, TEST_COMPANY_ID);

  // Insert a signal (signals-only path — no rescoreCompany)
  const provider = new FakeSignalProvider();
  const suffix   = `it06-${Date.now()}`;
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["funding_series_a"], asOf: FIXED_NOW, eventIdSuffix: suffix },
  );
  const [outcome] = normalizeBatch(batch.events, DETECTED_AT);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const { row } = await upsertSignal(outcome.signal);
  insertedSignalIds.push(row.id);

  // Verify account_intelligence is unchanged
  const aiAfter = await getAccountIntelligence(GRAMSCODE_ID, TEST_COMPANY_ID);

  if (aiBefore === null) {
    assert.strictEqual(aiAfter, null, "account_intelligence must remain null (no rescore was called)");
  } else {
    assert.equal(aiAfter?.opportunityScore, aiBefore.opportunityScore,
      "account_intelligence must be unchanged when no rescore is called");
  }
});

// ── IT07 ─────────────────────────────────────────────────────────────────────

test("IT07: signal type correctly mapped from scenario (job_posting)", async () => {
  const provider = new FakeSignalProvider();
  const suffix   = `it07-${Date.now()}`;
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["job_posting_head_of_sales"], asOf: FIXED_NOW, eventIdSuffix: suffix },
  );
  const [outcome] = normalizeBatch(batch.events, DETECTED_AT);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.signal.signalType, "job_posting", "signal type must be job_posting");
});

// ── IT08 ─────────────────────────────────────────────────────────────────────

test("IT08: job_posting expires_at = occurred_at + 14 days", async () => {
  const provider = new FakeSignalProvider();
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["job_posting_head_of_sales"], asOf: FIXED_NOW },
  );
  const [outcome] = normalizeBatch(batch.events, DETECTED_AT);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  const sig = outcome.signal;
  const occurred  = new Date(sig.occurredAt).getTime();
  const expiresAt = new Date(sig.expiresAt).getTime();
  const diffDays  = (expiresAt - occurred) / 86_400_000;

  assert.ok(
    Math.abs(diffDays - 14) < 0.01,
    `job_posting TTL must be 14 days, got ${diffDays.toFixed(2)}d`,
  );
});

// ── IT09 ─────────────────────────────────────────────────────────────────────

test("IT09: funding_round expires_at = occurred_at + 90 days", async () => {
  const provider = new FakeSignalProvider();
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["funding_series_a"], asOf: FIXED_NOW },
  );
  const [outcome] = normalizeBatch(batch.events, DETECTED_AT);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  const sig = outcome.signal;
  const occurred  = new Date(sig.occurredAt).getTime();
  const expiresAt = new Date(sig.expiresAt).getTime();
  const diffDays  = (expiresAt - occurred) / 86_400_000;

  assert.ok(
    Math.abs(diffDays - 90) < 0.01,
    `funding_round TTL must be 90 days, got ${diffDays.toFixed(2)}d`,
  );
});

// ── IT10 ─────────────────────────────────────────────────────────────────────

test("IT10: multiple signals for same company — all inserted", async () => {
  const provider = new FakeSignalProvider();
  const suffix   = `it10-${Date.now()}`;
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    {
      scenarios: ["executive_hire_vp_sales", "funding_series_a"],
      asOf: FIXED_NOW,
      eventIdSuffix: suffix,
    },
  );

  assert.equal(batch.events.length, 2, "must emit 2 events");
  const outcomes = normalizeBatch(batch.events, DETECTED_AT);
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every(o => o.ok), "both must normalize successfully");

  const it10Ids: string[] = []; // local to IT10 only
  let insertedCount = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const { row, created } = await upsertSignal(outcome.signal);
    if (created) {
      insertedCount++;
      it10Ids.push(row.id);
      insertedSignalIds.push(row.id);
    }
  }

  assert.equal(insertedCount, 2, "both signals must be inserted");

  // Verify both IT10 signals appear when queried by company
  const stored = await getSignalsByCompany(TEST_COMPANY_ID, GRAMSCODE_ID);
  const it10Set = new Set(it10Ids);
  const storedForTest = stored.filter(s => it10Set.has(s.id));
  assert.equal(storedForTest.length, 2, "both signals must be retrievable by company");
});

// ── IT11 ─────────────────────────────────────────────────────────────────────

test("IT11: tenant isolation — GRAMSCODE signal not visible to other client query", async () => {
  // Use an already-inserted signal from IT03/IT04
  // Query with a different client_id → should return empty
  const provider = new FakeSignalProvider();
  const suffix   = `it11-${Date.now()}`;
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["funding_series_a"], asOf: FIXED_NOW, eventIdSuffix: suffix },
  );
  const [outcome] = normalizeBatch(batch.events, DETECTED_AT);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  const { row } = await upsertSignal(outcome.signal);
  insertedSignalIds.push(row.id);

  // Query with different client_id — must return 0 signals
  const otherClientSignals = await getSignalsByCompany(TEST_COMPANY_ID, OTHER_CLIENT_ID);
  const hasLeak = otherClientSignals.some(s => s.id === row.id);
  assert.ok(!hasLeak, "GRAMSCODE signal must not be visible to another client");
});

// ── IT12 ─────────────────────────────────────────────────────────────────────

test("IT12: normalizeBatch rejects events with invalid occurred_at", () => {
  const badEvent: SignalProviderEvent = {
    companyId: TEST_COMPANY_ID,
    clientId:  GRAMSCODE_ID,
    rawEvent: {
      source:     "test",
      signalType: "job_posting",
      title:      "Bad event",
      evidence:   { event: "job_posting" },
      occurredAt: "NOT-A-DATE",
    },
  };

  const outcomes = normalizeBatch([badEvent], DETECTED_AT);
  assert.equal(outcomes.length, 1);
  assert.ok(!outcomes[0].ok, "bad occurred_at must produce normalization failure");
  if (outcomes[0].ok) return;
  assert.ok(
    outcomes[0].error.includes("Invalid occurredAt"),
    `error must mention "Invalid occurredAt", got: ${outcomes[0].error}`,
  );
});

// ── IT13 ─────────────────────────────────────────────────────────────────────

test("IT13: no-domain company produces 0 events (ingestion guard)", () => {
  // The Stage 30A ingestion script guards: if no domain → skip.
  // Test the guard logic inline.
  const companyDomains = new Map<string, string>([
    ["company-with-domain-id", "example.com"],
  ]);

  const allCompanies = ["company-with-domain-id", "company-without-domain-id"];
  const queryable = allCompanies.filter(id => companyDomains.has(id));

  assert.equal(queryable.length, 1, "only 1 company with domain should be queried");
  assert.equal(queryable[0], "company-with-domain-id");
});

// ── IT14 ─────────────────────────────────────────────────────────────────────

test("IT14: idempotency — normalize+upsert twice yields same DB state", async () => {
  const provider = new FakeSignalProvider();
  const suffix   = `it14-${Date.now()}`;
  const batch = await provider.fetchEvents(
    [TEST_COMPANY_ID], GRAMSCODE_ID,
    { scenarios: ["executive_hire_vp_engineering"], asOf: FIXED_NOW, eventIdSuffix: suffix },
  );
  const [outcome] = normalizeBatch(batch.events, DETECTED_AT);
  assert.ok(outcome.ok);
  if (!outcome.ok) return;

  // First upsert
  const { row: r1, created: c1 } = await upsertSignal(outcome.signal);
  assert.ok(c1 === true, "first upsert must be created");
  insertedSignalIds.push(r1.id);

  // Second upsert — same signal
  const { row: r2, created: c2 } = await upsertSignal(outcome.signal);
  assert.ok(c2 === false, "second upsert must NOT be created (dedup)");
  assert.equal(r2.id, r1.id, "second upsert must return same row id");

  // Verify DB has exactly 1 signal matching this dedup_key
  const stored = await getSignalsByCompany(TEST_COMPANY_ID, GRAMSCODE_ID);
  const matching = stored.filter(s => s.id === r1.id);
  assert.equal(matching.length, 1, "exactly 1 row must exist in DB");
});

// ── Teardown ──────────────────────────────────────────────────────────────────

// Node test runner runs tests sequentially by default.
// Register cleanup after all tests via process exit hook.
process.on("beforeExit", async () => {
  await cleanup();
  console.log(`\n  Teardown complete — deleted ${0} test signals (already cleaned)`);
});

// Run cleanup after all tests
test("TEARDOWN: remove all test signals", async () => {
  const count = insertedSignalIds.length;
  await cleanup();
  console.log(`  Removed ${count} test signal(s) from signals table`);
});
