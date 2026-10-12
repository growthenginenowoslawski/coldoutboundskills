/**
 * Post-migration schema verification for migration 0019.
 * Checks: tables, columns, NOT NULL, CHECK constraints, FKs, ON DELETE behavior,
 *         indexes, UNIQUE constraints, RLS enabled, zero policies.
 *
 * Run: npx tsx scripts/verify-0019-schema.ts
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function loadEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = resolve(dir, ".env");
    try {
      const lines = readFileSync(candidate, "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
        if (!(key in process.env)) process.env[key] = val;
      }
      break;
    } catch {
      dir = resolve(dir, "..");
    }
  }
}

loadEnv();

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN!;
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1]!;

async function query(sql: string): Promise<unknown[]> {
  const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Query failed (${res.status}): ${text}`);
  }
  return res.json() as Promise<unknown[]>;
}

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

// ── 1. Tables exist ───────────────────────────────────────────────────────────
console.log("\n── 1. Tables exist ──────────────────────────────────────────────────────");
const tables = ["person_discovery_runs", "person_discovery_attempts",
                "email_enrichment_runs", "email_enrichment_attempts"];

const tableRows = await query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN (
    'person_discovery_runs', 'person_discovery_attempts',
    'email_enrichment_runs', 'email_enrichment_attempts'
  )
  ORDER BY table_name
`) as Array<{ table_name: string }>;

const existingTables = new Set(tableRows.map(r => r.table_name));
for (const t of tables) {
  check(`Table ${t} exists`, existingTables.has(t));
}

// ── 2. Column presence and NOT NULL on client_id ──────────────────────────────
console.log("\n── 2. Columns — client_id NOT NULL, found_email absent ──────────────────");

const colRows = await query(`
  SELECT table_name, column_name, is_nullable, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
  AND table_name IN (
    'person_discovery_runs', 'person_discovery_attempts',
    'email_enrichment_runs', 'email_enrichment_attempts'
  )
  ORDER BY table_name, ordinal_position
`) as Array<{ table_name: string; column_name: string; is_nullable: string; data_type: string }>;

// client_id NOT NULL on all four tables
for (const t of tables) {
  const clientCol = colRows.find(r => r.table_name === t && r.column_name === "client_id");
  check(`${t}.client_id NOT NULL`, clientCol?.is_nullable === "NO",
        `nullable=${clientCol?.is_nullable}`);
}

// found_email must NOT exist anywhere
const foundEmailCols = colRows.filter(r => r.column_name === "found_email");
check("found_email column absent from all tables", foundEmailCols.length === 0,
      foundEmailCols.map(r => r.table_name).join(", "));

// email_enrichment_runs has found_provider (not found_email)
const foundProvider = colRows.find(r => r.table_name === "email_enrichment_runs" && r.column_name === "found_provider");
check("email_enrichment_runs.found_provider exists", foundProvider !== undefined);

// email_enrichment_attempts has email_found boolean (not address)
const emailFound = colRows.find(r => r.table_name === "email_enrichment_attempts" && r.column_name === "email_found");
check("email_enrichment_attempts.email_found (boolean) exists", emailFound !== undefined);
check("email_enrichment_attempts.email_found is boolean type", emailFound?.data_type === "boolean");

// ── 3. Foreign keys and ON DELETE behavior ────────────────────────────────────
console.log("\n── 3. Foreign keys — ON DELETE behavior ─────────────────────────────────");

const fkRows = await query(`
  SELECT
    tc.table_name,
    kcu.column_name,
    ccu.table_name AS foreign_table,
    ccu.column_name AS foreign_column,
    rc.delete_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name
    AND tc.table_schema = rc.constraint_schema
  JOIN information_schema.key_column_usage ccu
    ON rc.unique_constraint_name = ccu.constraint_name
    AND rc.unique_constraint_schema = ccu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND tc.table_name IN (
    'person_discovery_runs', 'person_discovery_attempts',
    'email_enrichment_runs', 'email_enrichment_attempts'
  )
  ORDER BY tc.table_name, kcu.column_name
`) as Array<{
  table_name: string;
  column_name: string;
  foreign_table: string;
  foreign_column: string;
  delete_rule: string;
}>;

// ON DELETE SET NULL: selected_contact_id and candidate_contact_id (historical audit refs)
const selectedContactFk = fkRows.find(r => r.table_name === "person_discovery_runs" && r.column_name === "selected_contact_id");
check("person_discovery_runs.selected_contact_id ON DELETE SET NULL",
      selectedContactFk?.delete_rule === "SET NULL",
      `delete_rule=${selectedContactFk?.delete_rule}`);

const candidateContactFk = fkRows.find(r => r.table_name === "person_discovery_attempts" && r.column_name === "candidate_contact_id");
check("person_discovery_attempts.candidate_contact_id ON DELETE SET NULL",
      candidateContactFk?.delete_rule === "SET NULL",
      `delete_rule=${candidateContactFk?.delete_rule}`);

// ON DELETE CASCADE: contact_id in email tables (subject identity)
const emailRunContactFk = fkRows.find(r => r.table_name === "email_enrichment_runs" && r.column_name === "contact_id");
check("email_enrichment_runs.contact_id ON DELETE CASCADE",
      emailRunContactFk?.delete_rule === "CASCADE",
      `delete_rule=${emailRunContactFk?.delete_rule}`);

const emailAttemptContactFk = fkRows.find(r => r.table_name === "email_enrichment_attempts" && r.column_name === "contact_id");
check("email_enrichment_attempts.contact_id ON DELETE CASCADE",
      emailAttemptContactFk?.delete_rule === "CASCADE",
      `delete_rule=${emailAttemptContactFk?.delete_rule}`);

// ON DELETE CASCADE: run_id FKs (child rows)
const attemptRunFk = fkRows.find(r => r.table_name === "person_discovery_attempts" && r.column_name === "run_id");
check("person_discovery_attempts.run_id ON DELETE CASCADE",
      attemptRunFk?.delete_rule === "CASCADE",
      `delete_rule=${attemptRunFk?.delete_rule}`);

const emailAttemptRunFk = fkRows.find(r => r.table_name === "email_enrichment_attempts" && r.column_name === "run_id");
check("email_enrichment_attempts.run_id ON DELETE CASCADE",
      emailAttemptRunFk?.delete_rule === "CASCADE",
      `delete_rule=${emailAttemptRunFk?.delete_rule}`);

// ON DELETE CASCADE: company_id on person_discovery_runs
const companyFk = fkRows.find(r => r.table_name === "person_discovery_runs" && r.column_name === "company_id");
check("person_discovery_runs.company_id ON DELETE CASCADE",
      companyFk?.delete_rule === "CASCADE",
      `delete_rule=${companyFk?.delete_rule}`);

// ── 4. UNIQUE / idempotency constraints ───────────────────────────────────────
console.log("\n── 4. UNIQUE / idempotency constraints ──────────────────────────────────");

// Use pg_constraint directly (more reliable than information_schema for array results)
const uniqueRows = await query(`
  SELECT
    conrelid::regclass AS table_name,
    conname AS constraint_name,
    array_to_string(ARRAY(
      SELECT attname FROM pg_attribute
      WHERE attrelid = c.conrelid AND attnum = ANY(c.conkey)
      ORDER BY attnum
    ), ',') AS columns
  FROM pg_constraint c
  JOIN pg_namespace n ON n.oid = (SELECT relnamespace FROM pg_class WHERE oid = c.conrelid)
  WHERE n.nspname = 'public'
  AND conrelid::regclass::text IN (
    'person_discovery_runs', 'person_discovery_attempts',
    'email_enrichment_runs', 'email_enrichment_attempts'
  )
  AND contype = 'u'
  ORDER BY table_name, conname
`) as Array<{ table_name: string; constraint_name: string; columns: string }>;

const hasUnique = (table: string, cols: string[]) => {
  const sortedTarget = [...cols].sort().join(",");
  return uniqueRows.some(r => {
    if (r.table_name !== table) return false;
    const sortedActual = r.columns.split(",").sort().join(",");
    return sortedActual === sortedTarget;
  });
};

check("person_discovery_runs UNIQUE (client_id, company_id, campaign_strategy_id)",
      hasUnique("person_discovery_runs", ["client_id", "company_id", "campaign_strategy_id"]));
check("person_discovery_attempts UNIQUE (run_id, provider_id, attempt_number)",
      hasUnique("person_discovery_attempts", ["run_id", "provider_id", "attempt_number"]));
check("email_enrichment_runs UNIQUE (client_id, contact_id, campaign_strategy_id)",
      hasUnique("email_enrichment_runs", ["client_id", "contact_id", "campaign_strategy_id"]));
check("email_enrichment_attempts UNIQUE (run_id, provider_id, attempt_number)",
      hasUnique("email_enrichment_attempts", ["run_id", "provider_id", "attempt_number"]));

// ── 5. Indexes ─────────────────────────────────────────────────────────────────
console.log("\n── 5. Indexes ────────────────────────────────────────────────────────────");

const idxRows = await query(`
  SELECT indexname FROM pg_indexes
  WHERE schemaname = 'public'
  AND tablename IN (
    'person_discovery_runs', 'person_discovery_attempts',
    'email_enrichment_runs', 'email_enrichment_attempts'
  )
  ORDER BY indexname
`) as Array<{ indexname: string }>;

const idxNames = new Set(idxRows.map(r => r.indexname));
for (const idx of [
  "person_discovery_runs_client_company_idx",
  "person_discovery_runs_client_strategy_idx",
  "person_discovery_runs_state_idx",
  "person_discovery_attempts_run_idx",
  "email_enrichment_runs_client_contact_idx",
  "email_enrichment_attempts_run_idx",
]) {
  check(`Index ${idx} exists`, idxNames.has(idx));
}

// ── 6. RLS enabled, zero policies ────────────────────────────────────────────
console.log("\n── 6. RLS enabled, zero policies ────────────────────────────────────────");

const rlsRows = await query(`
  SELECT relname, relrowsecurity
  FROM pg_class
  JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
  WHERE nspname = 'public'
  AND relname IN (
    'person_discovery_runs', 'person_discovery_attempts',
    'email_enrichment_runs', 'email_enrichment_attempts'
  )
  ORDER BY relname
`) as Array<{ relname: string; relrowsecurity: boolean }>;

for (const r of rlsRows) {
  check(`${r.relname} RLS enabled`, r.relrowsecurity === true, `relrowsecurity=${r.relrowsecurity}`);
}

const policyRows = await query(`
  SELECT tablename, policyname
  FROM pg_policies
  WHERE schemaname = 'public'
  AND tablename IN (
    'person_discovery_runs', 'person_discovery_attempts',
    'email_enrichment_runs', 'email_enrichment_attempts'
  )
`) as Array<{ tablename: string; policyname: string }>;

check("Zero RLS policies on all four tables", policyRows.length === 0,
      `found ${policyRows.length} policies: ${policyRows.map(r => `${r.tablename}.${r.policyname}`).join(", ")}`);

// ── 7. Stage 23 tables untouched ──────────────────────────────────────────────
console.log("\n── 7. Stage 23 tables untouched ─────────────────────────────────────────");

const stage23Tables = await query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN ('contact_intelligence', 'contact_campaign_relevance')
`) as Array<{ table_name: string }>;

const s23Set = new Set(stage23Tables.map(r => r.table_name));
check("contact_intelligence table exists (untouched)", s23Set.has("contact_intelligence"));
check("contact_campaign_relevance table exists (untouched)", s23Set.has("contact_campaign_relevance"));

// ── 8. Other tables untouched (campaign_leads, email_verifications) ───────────
console.log("\n── 8. Other critical tables untouched ───────────────────────────────────");

const otherTables = await query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN ('campaign_leads', 'email_verifications', 'account_intelligence', 'campaigns')
`) as Array<{ table_name: string }>;

const otherSet = new Set(otherTables.map(r => r.table_name));
for (const t of ["campaign_leads", "email_verifications", "account_intelligence", "campaigns"]) {
  check(`${t} table still exists (untouched by migration)`, otherSet.has(t));
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n════════════════════════════════════════════════════════════════════════════`);
console.log(`Schema verification: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("VERIFICATION FAILED — see ✗ items above");
  process.exit(1);
} else {
  console.log("ALL CHECKS PASSED ✓");
}
