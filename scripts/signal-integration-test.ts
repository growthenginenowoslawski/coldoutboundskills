/**
 * Signal Engine — Supabase integration test.
 *
 * Proves the full pipeline using fake data and a real Supabase connection:
 *
 *   FAKE EVENT → NORMALIZED SIGNAL → COMPANY → CLIENT
 *   → DEDUPLICATION → FRESHNESS → SIGNAL SCORE → STORED IN SUPABASE
 *
 * CONSTRAINTS:
 *   - Makes NO external API calls
 *   - Scrapes NOTHING
 *   - Sends NOTHING externally
 *   - Does NOT modify existing production company records
 *   - Inserts a clearly labelled test company (SIGNAL_INTEGRATION_TEST_ prefix)
 *   - Leaves test records in Supabase for manual inspection (do NOT clean up)
 *
 * Run:
 *   npx tsx scripts/signal-integration-test.ts
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env before any Supabase imports
if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase";
import { upsertSignal, getSignalsByCompany } from "../src/db/signals";
import { FakeSignalProvider } from "../src/providers/signals/fake-provider";
import { normalizeEvent } from "../src/providers/signals/normalizer";
import { computeFreshnessScore, isExpired } from "../src/lib/signal-freshness";
import { computeActionabilityScore } from "../src/lib/signal-strength";

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  console.log(`\n── ${title} ──`);
}

// ── Setup: find a real client ─────────────────────────────────────────────────

async function findFirstClient(): Promise<{ id: string; name: string } | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("clients")
    .select("id, name")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not query clients: ${error.message}`);
  return data as { id: string; name: string } | null;
}

// ── Setup: insert a labeled test company ──────────────────────────────────────

async function insertTestCompany(name: string): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("companies")
    .insert({
      name,
      domain: null,
      website_url: null,
      industry: "SaaS",
      company_size: "51-200",
      country: "US",
      city: "San Francisco",
      region: "CA",
      status: "review",
      source: "signal-integration-test",
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertTestCompany failed: ${error.message}`);
  return (data as { id: string }).id;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const runId = Date.now();
  const testLabel = `SIGNAL_INTEGRATION_TEST_${runId}`;
  console.log(`\nSignal Engine — Supabase Integration Test`);
  console.log(`Run ID: ${runId}`);
  console.log(`Label: ${testLabel}`);

  // ── 1. Find a real client ─────────────────────────────────────────────────

  section("1. Finding real client");
  const client = await findFirstClient();
  if (!client) {
    console.error("No clients found in Supabase. Cannot run integration test.");
    process.exit(1);
  }
  console.log(`  Client: ${client.name} (${client.id})`);

  // ── 2. Insert test company ────────────────────────────────────────────────

  section("2. Inserting labeled test company");
  const companyId = await insertTestCompany(testLabel);
  console.log(`  Company ID: ${companyId}`);
  console.log(`  Company name: ${testLabel}`);
  check("Company inserted", !!companyId);

  // ── 3. Generate fake event ────────────────────────────────────────────────

  section("3. Generating fake event via FakeSignalProvider");
  const provider = new FakeSignalProvider();
  const asOf = new Date();
  const batch = await provider.fetchEvents([companyId], client.id, {
    scenarios: ["executive_hire_vp_sales"],
    asOf,
  });
  const rawEvent = batch.events[0];
  check("Provider returned one event", batch.events.length === 1);
  check("Event has correct companyId", rawEvent.companyId === companyId);
  check("Event has correct clientId", rawEvent.clientId === client.id);
  check("Event signal type is executive_hire", rawEvent.rawEvent.signalType === "executive_hire");
  check("Event has providerEventId (tier-1 dedup)", !!rawEvent.rawEvent.providerEventId);
  check(
    "Event evidence contains expected fields",
    rawEvent.rawEvent.evidence["role"] === "VP Sales",
  );
  console.log(`  Signal type: ${rawEvent.rawEvent.signalType}`);
  console.log(`  Provider event ID: ${rawEvent.rawEvent.providerEventId}`);
  console.log(`  Occurred at: ${rawEvent.rawEvent.occurredAt}`);

  // ── 4. Normalize the event ────────────────────────────────────────────────

  section("4. Normalizing raw event → NormalizedSignal");
  const detectedAt = new Date().toISOString();
  const signal = normalizeEvent(rawEvent, detectedAt);
  check("signalType is executive_hire", signal.signalType === "executive_hire");
  check("signalSource is test", signal.signalSource === "test");
  check("clientId matches", signal.clientId === client.id);
  check("companyId matches", signal.companyId === companyId);
  check("status is active", signal.status === "active");
  check("signalStrength is 75", signal.signalStrength === 75);
  check("confidence is 0.800 (provider-id tier)", signal.confidence === 0.800);
  check("dedupKey is non-null", signal.dedupKey !== null);
  check("expiresAt is 30 days after occurredAt", (() => {
    const diff = new Date(signal.expiresAt).getTime() - new Date(signal.occurredAt).getTime();
    return diff === 30 * 24 * 60 * 60 * 1000;
  })());
  console.log(`  signalStrength: ${signal.signalStrength}`);
  console.log(`  confidence: ${signal.confidence}`);
  console.log(`  dedupKey: ${signal.dedupKey}`);
  console.log(`  expiresAt: ${signal.expiresAt}`);

  // ── 5. Freshness check before storage ─────────────────────────────────────

  section("5. Freshness calculation");
  const freshnessScore = computeFreshnessScore(signal.occurredAt, signal.expiresAt, asOf);
  const isStale = isExpired(signal.expiresAt, asOf);
  const actionability = computeActionabilityScore(signal.signalStrength, freshnessScore);
  check("Signal is not expired", !isStale);
  check("Freshness score is > 0", freshnessScore > 0);
  check("Freshness score is <= 100", freshnessScore <= 100);
  check("Actionability score is > 0", actionability > 0);
  console.log(`  Freshness score: ${freshnessScore}/100`);
  console.log(`  Actionability score: ${actionability}/100`);

  // ── 6. Store signal in Supabase ───────────────────────────────────────────

  section("6. Storing signal in Supabase (first insert)");
  const { row: storedRow, created: wasCreated } = await upsertSignal(signal);
  check("Row was created (not a duplicate)", wasCreated === true);
  check("Stored row has a UUID id", /^[0-9a-f-]{36}$/.test(storedRow.id));
  check("Stored signal_type matches", storedRow.signalType === "executive_hire");
  check("Stored client_id matches", storedRow.clientId === client.id);
  check("Stored company_id matches", storedRow.companyId === companyId);
  check("Stored signal_strength matches", storedRow.signalStrength === 75);
  check("Stored confidence matches", storedRow.confidence === 0.800);
  check("Stored dedupKey matches", storedRow.dedupKey === signal.dedupKey);
  check("Stored status is active", storedRow.status === "active");
  check("Stored signalTitle is set", storedRow.signalTitle.length > 0);
  check("Stored occurredAt is an ISO string", !isNaN(new Date(storedRow.occurredAt).getTime()));
  check("Stored expiresAt is an ISO string", !isNaN(new Date(storedRow.expiresAt).getTime()));
  console.log(`  Signal ID: ${storedRow.id}`);
  console.log(`  Created at: ${storedRow.createdAt}`);

  // ── 7. Idempotency: same event again should return existing row ────────────

  section("7. Idempotency — inserting same event again");
  const { row: dupeRow, created: dupeCreated } = await upsertSignal(signal);
  check("Second insert did NOT create a new row", dupeCreated === false);
  check("Returned same row ID", dupeRow.id === storedRow.id);
  check("Returned same dedupKey", dupeRow.dedupKey === storedRow.dedupKey);
  console.log(`  Idempotency confirmed: same ID returned (${dupeRow.id})`);

  // ── 8. Second distinct signal for the same company ─────────────────────────

  section("8. Second distinct signal for same company (different type)");
  const batch2 = await provider.fetchEvents([companyId], client.id, {
    scenarios: ["funding_series_a"],
    asOf,
  });
  const signal2 = normalizeEvent(batch2.events[0], detectedAt);
  const { row: row2, created: created2 } = await upsertSignal(signal2);
  check("Second signal was created", created2 === true);
  check("Second signal has different ID", row2.id !== storedRow.id);
  check("Second signal has different dedupKey", row2.dedupKey !== storedRow.dedupKey);
  check("Second signal type is funding_round", row2.signalType === "funding_round");
  check("Second signal strength is 90", row2.signalStrength === 90);
  console.log(`  Second signal ID: ${row2.id}`);
  console.log(`  Second signal type: ${row2.signalType}`);

  // ── 9. Verify multiple signals for one company ────────────────────────────

  section("9. Querying signals by company");
  const companySignals = await getSignalsByCompany(companyId, client.id);
  check("Query returns 2 signals for test company", companySignals.length === 2);
  check(
    "Both signals belong to test company",
    companySignals.every((s) => s.companyId === companyId),
  );
  check(
    "Both signals belong to correct client",
    companySignals.every((s) => s.clientId === client.id),
  );
  check(
    "Signals include both types",
    companySignals.some((s) => s.signalType === "executive_hire") &&
      companySignals.some((s) => s.signalType === "funding_round"),
  );
  console.log(`  Signals found: ${companySignals.map((s) => s.signalType).join(", ")}`);

  // ── 10. Tenant isolation: different client cannot see these signals ─────────

  section("10. Tenant isolation");
  // We use a fake UUID for a non-existent second client — should return 0 signals
  const fakeClientId = "00000000-dead-beef-0000-000000000000";
  const isolatedQuery = await getSupabaseAdmin()
    .from("signals")
    .select("id")
    .eq("company_id", companyId)
    .eq("client_id", fakeClientId);
  check(
    "Different client_id returns 0 signals for same company",
    (isolatedQuery.data ?? []).length === 0,
  );
  check("No DB error on isolated query", !isolatedQuery.error);

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n── Test Records in Supabase ──");
  console.log(`  Company: ${testLabel}`);
  console.log(`  Company ID: ${companyId}`);
  console.log(`  Client: ${client.name} (${client.id})`);
  console.log(`  Signal 1 ID: ${storedRow.id} (${storedRow.signalType})`);
  console.log(`  Signal 2 ID: ${row2.id} (${row2.signalType})`);
  console.log(`  Dedup key 1: ${storedRow.dedupKey}`);
  console.log(`  Dedup key 2: ${row2.dedupKey}`);
  console.log(`  NOTE: Records left in Supabase for inspection. Do not clean up.`);

  console.log(`\n── Results ──`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${passed} checks passed.`);
  }
}

run().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
