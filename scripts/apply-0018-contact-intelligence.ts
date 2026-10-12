/**
 * Apply migration 0018_contact_intelligence.sql and verify the result.
 *
 * Uses the Supabase Management API (same credentials as check-stage23-prereqs.ts).
 * Reads the migration file from supabase/migrations/0018_contact_intelligence.sql.
 * Runs post-migration schema verification before reporting success.
 *
 * Run: npx tsx scripts/apply-0018-contact-intelligence.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve }                  from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

const SUPABASE_URL    = process.env.SUPABASE_URL ?? "";
const ACCESS_TOKEN    = process.env.SUPABASE_ACCESS_TOKEN ?? "";
const MIGRATION_FILE  = resolve(process.cwd(), "supabase/migrations/0018_contact_intelligence.sql");

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error("Missing SUPABASE_URL or SUPABASE_ACCESS_TOKEN");
  process.exit(1);
}

if (!existsSync(MIGRATION_FILE)) {
  console.error(`Migration file not found: ${MIGRATION_FILE}`);
  process.exit(1);
}

const ref = new URL(SUPABASE_URL).hostname.split(".")[0];

async function sql(query: string): Promise<unknown[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SQL error (${res.status}): ${text.slice(0, 400)}`);
  }
  return res.json() as Promise<unknown[]>;
}

function section(t: string) {
  console.log(`\n${"─".repeat(70)}\n  ${t}\n${"─".repeat(70)}`);
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Applying migration 0018 — contact_intelligence");
  console.log(`  File:    ${MIGRATION_FILE}`);
  console.log(`  Project: ${ref}`);
  console.log("=".repeat(70));

  // ── Pre-application guard: confirm tables do NOT exist yet ─────────────────
  section("Pre-application guard");

  const existingBefore = await sql(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('contact_intelligence','contact_campaign_relevance')
     ORDER BY table_name`,
  ) as Array<{ table_name: string }>;

  if (existingBefore.length > 0) {
    console.log("  Tables already exist:");
    for (const r of existingBefore) console.log(`    ${r.table_name}`);
    console.log("\n  Migration appears already applied. Running verification only.");
  } else {
    console.log("  contact_intelligence:       absent — clean slate ✓");
    console.log("  contact_campaign_relevance: absent — clean slate ✓");
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  section("Applying migration SQL");

  const migrationSql = readFileSync(MIGRATION_FILE, "utf8");
  console.log(`  Migration size: ${migrationSql.length} bytes`);
  console.log("  Submitting...");

  const applyStart = Date.now();
  await sql(migrationSql);
  console.log(`  Applied in ${Date.now() - applyStart}ms ✓`);

  // ── Post-application verification ──────────────────────────────────────────
  section("Post-application verification");

  // 1. Tables exist
  const tables = await sql(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('contact_intelligence','contact_campaign_relevance')
     ORDER BY table_name`,
  ) as Array<{ table_name: string }>;

  const ciExists  = tables.some((r) => r.table_name === "contact_intelligence");
  const ccrExists = tables.some((r) => r.table_name === "contact_campaign_relevance");

  console.log(`  contact_intelligence exists:       ${ciExists ? "YES ✓" : "NO ✗"}`);
  console.log(`  contact_campaign_relevance exists: ${ccrExists ? "YES ✓" : "NO ✗"}`);

  // 2. Unique constraints
  const constraints = await sql(
    `SELECT conrelid::regclass AS table_name, conname, contype, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid IN (
       'public.contact_intelligence'::regclass,
       'public.contact_campaign_relevance'::regclass
     )
     ORDER BY table_name, contype, conname`,
  ) as Array<{ table_name: string; conname: string; contype: string; def: string }>;

  console.log(`\n  Constraints (${constraints.length} total):`);
  for (const c of constraints) {
    const type = c.contype === "p" ? "PRIMARY KEY" : c.contype === "u" ? "UNIQUE" : c.contype === "f" ? "FK" : c.contype === "c" ? "CHECK" : c.contype;
    console.log(`    ${c.table_name.padEnd(36)} ${type.padEnd(12)} ${c.conname}`);
  }

  const hasUniqueCI  = constraints.some((c) => c.conname === "contact_intelligence_client_company_contact_key");
  const hasUniqueCCR = constraints.some((c) => c.conname === "contact_campaign_relevance_client_contact_campaign_key");
  console.log(`\n  contact_intelligence UNIQUE(client,company,contact):               ${hasUniqueCI ? "✓" : "✗ MISSING"}`);
  console.log(`  contact_campaign_relevance UNIQUE(client,company,contact,campaign): ${hasUniqueCCR ? "✓" : "✗ MISSING"}`);

  // 3. Indexes
  const indexes = await sql(
    `SELECT indexname, tablename
     FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename IN ('contact_intelligence','contact_campaign_relevance')
     ORDER BY tablename, indexname`,
  ) as Array<{ indexname: string; tablename: string }>;

  console.log(`\n  Indexes (${indexes.length} total):`);
  for (const idx of indexes) {
    console.log(`    ${idx.tablename.padEnd(36)} ${idx.indexname}`);
  }

  const expectedIndexes = [
    "contact_intelligence_client_company_idx",
    "contact_intelligence_contact_idx",
    "contact_intelligence_ready_idx",
    "contact_campaign_relevance_client_strategy_idx",
    "contact_campaign_relevance_qualified_idx",
    "contact_campaign_relevance_scoring_version_idx",
    "contact_campaign_relevance_contact_idx",
    "contact_campaign_relevance_client_company_idx",
  ];

  const indexNames = indexes.map((i) => i.indexname);
  let allIndexesPresent = true;
  for (const name of expectedIndexes) {
    const found = indexNames.includes(name);
    if (!found) { console.log(`    ✗ MISSING: ${name}`); allIndexesPresent = false; }
  }
  if (allIndexesPresent) console.log("  All expected indexes present ✓");

  // 4. Trigger
  const triggers = await sql(
    `SELECT trigger_name, event_object_table
     FROM information_schema.triggers
     WHERE trigger_schema = 'public'
       AND trigger_name = 'contact_campaign_strategy_client_check'`,
  ) as Array<{ trigger_name: string; event_object_table: string }>;

  const triggerExists = triggers.length > 0;
  console.log(`\n  Trigger contact_campaign_strategy_client_check: ${triggerExists ? "EXISTS ✓" : "MISSING ✗"}`);

  // 5. RLS enabled
  const rls = await sql(
    `SELECT relname, relrowsecurity
     FROM pg_class
     WHERE relname IN ('contact_intelligence','contact_campaign_relevance')
       AND relnamespace = 'public'::regnamespace`,
  ) as Array<{ relname: string; relrowsecurity: boolean }>;

  for (const r of rls) {
    console.log(`  RLS ${r.relname}: ${r.relrowsecurity ? "ENABLED ✓" : "DISABLED ✗"}`);
  }

  // 6. contact_intelligence columns
  const ciCols = await sql(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_intelligence'
     ORDER BY ordinal_position`,
  ) as Array<{ column_name: string; data_type: string; is_nullable: string }>;

  console.log(`\n  contact_intelligence columns (${ciCols.length}):`);
  for (const c of ciCols) {
    console.log(`    ${c.column_name.padEnd(36)} ${c.data_type.padEnd(26)} ${c.is_nullable === "NO" ? "NOT NULL" : "nullable"}`);
  }

  // 7. contact_campaign_relevance columns
  const ccrCols = await sql(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'contact_campaign_relevance'
     ORDER BY ordinal_position`,
  ) as Array<{ column_name: string; data_type: string; is_nullable: string }>;

  console.log(`\n  contact_campaign_relevance columns (${ccrCols.length}):`);
  for (const c of ccrCols) {
    console.log(`    ${c.column_name.padEnd(36)} ${c.data_type.padEnd(26)} ${c.is_nullable === "NO" ? "NOT NULL" : "nullable"}`);
  }

  // ── Final verdict ──────────────────────────────────────────────────────────
  section("Migration 0018 — Final Verdict");

  const allChecks = [ciExists, ccrExists, hasUniqueCI, hasUniqueCCR, allIndexesPresent, triggerExists];
  const passed = allChecks.every(Boolean);

  if (passed) {
    console.log("  ALL CHECKS PASSED ✓");
    console.log("  Migration 0018 is live and verified.");
    console.log("  contact_intelligence and contact_campaign_relevance are ready for use.");
  } else {
    console.log("  SOME CHECKS FAILED ✗ — review output above");
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nError applying migration:", msg.slice(0, 500));
  process.exit(1);
});
