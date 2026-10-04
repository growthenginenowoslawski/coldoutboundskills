/**
 * Stage 11 — PredictLeads Signal Ingestion Integration Test.
 *
 * Proves the real PredictLeads provider end-to-end:
 *
 *   PREDICTLEADS API → RawSignalEvent → normalizeBatch → 3-tier dedup
 *   → signal_strength → freshness/expiry → upsertSignal → signals table
 *
 * HARD CONSTRAINTS:
 *   - Uses the test client from Stage 10.5 (existing; not re-created)
 *   - Finds or creates 4 test companies by domain (no duplicates)
 *   - Makes NO outbound calls (no emails, no Smartlead, no Trigger.dev tasks)
 *   - Leaves ALL test signal records in Supabase for manual inspection
 *   - Reports the Supabase row ID for each inserted signal
 *   - API keys are NEVER logged — only their presence is confirmed
 *
 * Run:
 *   npx tsx scripts/signal-ingestion-integration-test.ts
 *
 * Env vars required:
 *   SUPABASE_URL              — always required
 *   SUPABASE_SECRET_KEY       — always required
 *   PREDICTLEADS_API_KEY      — Stage 11 required
 *   PREDICTLEADS_API_TOKEN    — Stage 11 required
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env before any imports that touch env
if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase";
import { upsertSignal, getSignalsByCompany } from "../src/db/signals";
import { findExistingCompanyId } from "../src/db/companies";
import { normalizeBatch } from "../src/providers/signals/normalizer";
import { computeFreshnessScore, isExpired } from "../src/lib/signal-freshness";
import {
  PredictLeadsSignalProvider,
} from "../src/providers/signals/predictleads-provider";
import type { CompanyRecord } from "../src/domain/types";

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

// ── Stage 10.5 test client (existing — do not re-create) ─────────────────────

const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";

// ── Test companies — real domains PredictLeads should have data for ───────────

const TEST_COMPANIES: CompanyRecord[] = [
  { name: "Stripe",     domain: "stripe.com",    website: "https://stripe.com",    source: "stage11-test", fetchedAt: new Date().toISOString() },
  { name: "OpenAI",     domain: "openai.com",    website: "https://openai.com",    source: "stage11-test", fetchedAt: new Date().toISOString() },
  { name: "Notion",     domain: "notion.so",     website: "https://notion.so",     source: "stage11-test", fetchedAt: new Date().toISOString() },
  { name: "Anthropic",  domain: "anthropic.com", website: "https://anthropic.com", source: "stage11-test", fetchedAt: new Date().toISOString() },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 11 — PredictLeads Signal Ingestion Integration Test");
  console.log("=".repeat(70));

  // ── Pre-flight: credentials ───────────────────────────────────────────────
  section("Pre-flight checks");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);

  const hasKey = !!process.env.PREDICTLEADS_API_KEY;
  const hasToken = !!process.env.PREDICTLEADS_API_TOKEN;
  check("PREDICTLEADS_API_KEY present (value not logged)", hasKey);
  check("PREDICTLEADS_API_TOKEN present (value not logged)", hasToken);

  const provider = new PredictLeadsSignalProvider();
  check("PredictLeadsSignalProvider.isConfigured()", provider.isConfigured());

  if (!hasSupabase || !hasKey || !hasToken) {
    console.error("\nAbort: required environment variables missing.");
    process.exit(1);
  }

  // ── Verify test client exists ─────────────────────────────────────────────
  section("Test client verification");

  const db = getSupabaseAdmin();
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
  check("Test client exists", true);
  note("client_id", TEST_CLIENT_ID);
  note("client_name", (clientRow as { name: string }).name);

  // ── Find or create test companies ─────────────────────────────────────────
  section("Company setup (find-or-create by domain)");

  const companyDomains = new Map<string, string>(); // companyId → domain
  const companyNames = new Map<string, string>();   // companyId → name

  for (const rec of TEST_COMPANIES) {
    let companyId = await findExistingCompanyId(rec);

    if (!companyId) {
      const { data, error } = await db
        .from("companies")
        .insert({
          name: rec.name,
          domain: rec.domain,
          website_url: rec.website,
          status: "review",
          source: rec.source,
        })
        .select("id")
        .single();
      if (error) throw new Error(`insert company ${rec.name} failed: ${error.message}`);
      companyId = (data as { id: string }).id;
      console.log(`  + created: ${rec.name} (${rec.domain}) → ${companyId}`);
    } else {
      console.log(`  ~ existing: ${rec.name} (${rec.domain}) → ${companyId}`);
    }

    companyDomains.set(companyId, rec.domain!);
    companyNames.set(companyId, rec.name);
  }

  check("All 4 test companies resolved", companyDomains.size === 4);

  // ── Fetch signals from PredictLeads ───────────────────────────────────────
  section("PredictLeads API call");

  const companyIds = Array.from(companyDomains.keys());
  note("companies", Array.from(companyDomains.entries()).map(([id, d]) => ({ id, domain: d })));

  console.log("\n  Calling PredictLeads API (this may take 10–30 s)…");
  const fetchStart = Date.now();

  const batch = await provider.fetchEvents(companyIds, TEST_CLIENT_ID, { companyDomains });

  const fetchMs = Date.now() - fetchStart;
  note("fetch_duration_ms", fetchMs);
  note("raw_events_returned", batch.events.length);
  note("batch_meta", batch.meta);

  check("API call completed without throwing", true);
  check("batch has events array", Array.isArray(batch.events));

  const perCompanyErrors = (batch.meta as { perCompanyErrors?: Record<string, string> })
    .perCompanyErrors ?? {};
  const errorCount = Object.keys(perCompanyErrors).length;
  if (errorCount > 0) {
    console.log(`  ⚠ ${errorCount} company/ies had API errors:`);
    for (const [id, msg] of Object.entries(perCompanyErrors)) {
      console.log(`    ${companyNames.get(id) ?? id}: ${msg}`);
    }
  }

  // ── Normalize ─────────────────────────────────────────────────────────────
  section("Normalization");

  const detectedAt = new Date().toISOString();
  const outcomes = normalizeBatch(batch.events, detectedAt);
  const normalizedSignals = outcomes.filter((o) => o.ok).map((o) => (o as { ok: true; signal: import("../src/domain/signal-types").NormalizedSignal }).signal);
  const normErrors = outcomes.filter((o) => !o.ok);

  note("events_normalized", normalizedSignals.length);
  note("normalization_errors", normErrors.length);
  for (const e of normErrors) {
    console.log(`    norm_error: ${(e as { error?: string }).error}`);
  }

  check("normalizeBatch returned outcomes", outcomes.length === batch.events.length);

  // ── Upsert signals ────────────────────────────────────────────────────────
  section("Dedup + upsert (signals table)");

  let newCount = 0;
  let dupCount = 0;
  let upsertErrors = 0;
  const insertedRows: { id: string; company: string; signalType: string; dedupKey: string | null; occurredAt: string }[] = [];

  for (const signal of normalizedSignals) {
    try {
      const { row, created } = await upsertSignal(signal);
      if (created) {
        newCount++;
        insertedRows.push({
          id: row.id,
          company: companyNames.get(signal.companyId) ?? signal.companyId,
          signalType: row.signalType,
          dedupKey: row.dedupKey,
          occurredAt: row.occurredAt,
        });
      } else {
        dupCount++;
      }
    } catch (err) {
      upsertErrors++;
      console.error(`    upsert error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  note("new_signals_inserted", newCount);
  note("duplicate_signals_skipped", dupCount);
  note("upsert_errors", upsertErrors);

  check("upsert loop completed", upsertErrors === 0);

  // ── Report inserted signals ───────────────────────────────────────────────
  if (insertedRows.length > 0) {
    section(`Inserted signals (${insertedRows.length} new rows in Supabase)`);
    for (const r of insertedRows) {
      console.log(`\n  ─ ${r.company} / ${r.signalType}`);
      note("  supabase_id", r.id);
      note("  occurred_at", r.occurredAt);
      note("  dedup_key", r.dedupKey);
    }
  } else {
    section("No new signals (all already in DB — dedup working correctly)");
    note("new_count", newCount);
    note("dup_count", dupCount);
    note("total_fetched", batch.events.length);
    note("note", "This is expected on re-runs. Dedup keys prevent duplicates.");
  }

  // ── Freshness spot-check ──────────────────────────────────────────────────
  section("Freshness/expiry verification");

  if (normalizedSignals.length > 0) {
    const sample = normalizedSignals[0];
    const freshness = computeFreshnessScore(sample.occurredAt, sample.expiresAt);
    const expired = isExpired(sample.expiresAt);
    note("sample_signal_type", sample.signalType);
    note("sample_occurred_at", sample.occurredAt);
    note("sample_expires_at", sample.expiresAt);
    note("sample_freshness_score", freshness);
    note("sample_is_expired", expired);
    check("freshness score in 0–100 range", freshness >= 0 && freshness <= 100);
    check("sample signal is not expired", !expired);
  } else {
    console.log("  (no signals to spot-check)");
  }

  // ── Verify tenant isolation ───────────────────────────────────────────────
  section("Tenant isolation verification");

  // Every returned event must carry the correct clientId
  const wrongClientEvents = batch.events.filter((e) => e.clientId !== TEST_CLIENT_ID);
  check("all batch events carry correct clientId", wrongClientEvents.length === 0,
    wrongClientEvents.length > 0 ? `${wrongClientEvents.length} events had wrong clientId` : undefined);

  // Verify tenant isolation in DB using two bounded queries:
  //   1. Sample check — verify a small number of known IDs all have client_id = TEST_CLIENT_ID.
  //   2. Contamination check — verify no signals for our companies exist under a DIFFERENT client_id.
  // Avoids a single .in(3202 UUIDs) call which would exceed PostgREST URL limits.
  if (insertedRows.length > 0) {
    const SAMPLE_SIZE = 10;
    const sampleIds = insertedRows.slice(0, SAMPLE_SIZE).map((r) => r.id);

    // 1. Sample check: a bounded .in() with ≤10 IDs.
    const { data: sampleRows, error: sampleErr } = await db
      .from("signals")
      .select("id, client_id")
      .in("id", sampleIds);
    if (sampleErr) {
      check("tenant isolation sample query succeeded", false, sampleErr.message);
    } else {
      const wrongSample = (sampleRows as Array<{ id: string; client_id: string }>)
        .filter((r) => r.client_id !== TEST_CLIENT_ID);
      check(
        `sample of ${SAMPLE_SIZE} inserted rows all have correct client_id`,
        wrongSample.length === 0,
        wrongSample.length > 0 ? `${wrongSample.length} rows had wrong client_id` : undefined,
      );
    }

  }

  // 2. Contamination check: count signals for our 4 test companies under ANY OTHER client.
  //    Runs on every execution (including re-runs) to prove isolation is maintained in DB.
  {
    const testCompanyIds = Array.from(companyDomains.keys());
    const { count: contaminatedCount, error: contamErr } = await db
      .from("signals")
      .select("id", { count: "exact", head: true })
      .in("company_id", testCompanyIds)
      .neq("client_id", TEST_CLIENT_ID);
    if (contamErr) {
      check("tenant isolation contamination query succeeded", false, contamErr.message);
    } else {
      check(
        "no signals for test companies exist under a different client_id",
        (contaminatedCount ?? 0) === 0,
        contaminatedCount != null && contaminatedCount > 0
          ? `${contaminatedCount} contaminated rows found`
          : undefined,
      );
    }
  }

  // ── Signals left for inspection ───────────────────────────────────────────
  section("Records left for inspection");
  console.log("  Signals table rows with this client_id are NOT deleted.");
  console.log("  Inspect in Supabase Table Editor → signals → client_id = " + TEST_CLIENT_ID);
  console.log("  Companies table rows for the 4 test domains remain as-is.");

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log(`Stage 11 integration test complete`);
  console.log(`  Checks passed: ${passed}`);
  console.log(`  Checks failed: ${failed}`);
  console.log(`  Raw events fetched:      ${batch.events.length}`);
  console.log(`  Normalized successfully: ${normalizedSignals.length}`);
  console.log(`  New signals inserted:    ${newCount}`);
  console.log(`  Duplicates skipped:      ${dupCount}`);
  console.log(`  Upsert errors:           ${upsertErrors}`);
  console.log("=".repeat(70));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
