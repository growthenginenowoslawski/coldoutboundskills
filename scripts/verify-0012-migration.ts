/**
 * Verifies that migration 0012_account_intelligence.sql was applied correctly.
 *
 * Checks (against live Supabase via Management API):
 *   1.  Table public.account_intelligence exists
 *   2.  All 8 columns present
 *   3.  Correct types and nullability
 *   4.  CHECK constraint on opportunity_score (0–100)
 *   5.  Named unique constraint account_intelligence_client_company_key
 *   6.  Both FKs (client_id, company_id) with ON DELETE CASCADE
 *   7.  Three intended indexes
 *   8.  RLS enabled
 *   9.  No RLS policies defined
 *   10. Migrations 0001–0011 tables still present
 *
 * Run: npx tsx scripts/verify-0012-migration.ts
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN ?? "";

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error("Missing SUPABASE_URL or SUPABASE_ACCESS_TOKEN");
  process.exit(1);
}

const ref = new URL(SUPABASE_URL).hostname.split(".")[0];

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
}

async function sql(query: string): Promise<unknown[] | null> {
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
  const text = await res.text();
  if (!res.ok) {
    console.error(`  SQL error (${res.status}): ${text.slice(0, 300)}`);
    return null;
  }
  try {
    return JSON.parse(text) as unknown[];
  } catch {
    return null;
  }
}

console.log("=".repeat(70));
console.log("Stage 12 — Migration 0012 Verification");
console.log("=".repeat(70));

// ── 1. Table existence ────────────────────────────────────────────────────────

section("1. Table existence");
const tables = await sql(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'account_intelligence';
`);
check(
  "public.account_intelligence exists",
  Array.isArray(tables) && tables.length === 1,
);

// ── 2 & 3. Columns ────────────────────────────────────────────────────────────

section("2–3. Columns — names, types, nullability, defaults");

const cols = await sql(`
  SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'account_intelligence'
  ORDER BY ordinal_position;
`);

type ColRow = { column_name: string; data_type: string; is_nullable: string; column_default: string | null };

const expectedCols: Record<string, { type: string; nullable: "YES" | "NO"; hasDefault?: boolean }> = {
  id:                           { type: "uuid",                    nullable: "NO",  hasDefault: true  },
  client_id:                    { type: "uuid",                    nullable: "NO",  hasDefault: false },
  company_id:                   { type: "uuid",                    nullable: "NO",  hasDefault: false },
  opportunity_score:            { type: "integer",                 nullable: "NO",  hasDefault: false },
  opportunity_score_updated_at: { type: "timestamp with time zone", nullable: "NO",  hasDefault: false },
  score_inputs:                 { type: "jsonb",                   nullable: "YES", hasDefault: false },
  created_at:                   { type: "timestamp with time zone", nullable: "NO",  hasDefault: true  },
  updated_at:                   { type: "timestamp with time zone", nullable: "NO",  hasDefault: true  },
};

if (Array.isArray(cols)) {
  check("8 columns present", cols.length === 8, `found ${cols.length}`);
  for (const [name, exp] of Object.entries(expectedCols)) {
    const actual = (cols as ColRow[]).find((c) => c.column_name === name);
    if (!actual) {
      check(`column '${name}' exists`, false, "MISSING");
      continue;
    }
    const typeOk = actual.data_type === exp.type;
    const nullOk = actual.is_nullable === exp.nullable;
    check(
      `${name}: ${exp.type}, nullable=${exp.nullable}`,
      typeOk && nullOk,
      !typeOk ? `got type=${actual.data_type}` : `got nullable=${actual.is_nullable}`,
    );
    if (exp.hasDefault !== undefined) {
      check(
        `${name} has default: ${exp.hasDefault}`,
        exp.hasDefault ? actual.column_default !== null : true,
      );
    }
  }
} else {
  check("column query succeeded", false);
}

// ── 4. CHECK constraint ───────────────────────────────────────────────────────

section("4. CHECK constraint on opportunity_score (0–100)");
const checkConstraints = await sql(`
  SELECT cc.constraint_name, cc.check_clause
  FROM information_schema.table_constraints tc
  JOIN information_schema.check_constraints cc
    ON tc.constraint_name = cc.constraint_name
  WHERE tc.table_schema   = 'public'
    AND tc.table_name     = 'account_intelligence'
    AND tc.constraint_type = 'CHECK'
    AND cc.check_clause NOT LIKE '%NOT NULL%';
`);

type CheckRow = { constraint_name: string; check_clause: string };

if (Array.isArray(checkConstraints) && checkConstraints.length > 0) {
  for (const c of checkConstraints as CheckRow[]) {
    const clause = c.check_clause.toLowerCase();
    const has0    = clause.includes("0");
    const has100  = clause.includes("100");
    const hasBetween = clause.includes("between") || (clause.includes(">=") && clause.includes("<="));
    check(
      `CHECK "${c.constraint_name}": covers 0–100 range`,
      has0 && has100,
      c.check_clause,
    );
    console.log(`     clause: ${c.check_clause}`);
  }
} else {
  check("CHECK constraint found", false, "none detected");
}

// ── 5. Named unique constraint ────────────────────────────────────────────────

section("5. Named unique constraint");
const uniqueConstraints = await sql(`
  SELECT tc.constraint_name, kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.table_schema   = 'public'
    AND tc.table_name     = 'account_intelligence'
    AND tc.constraint_type = 'UNIQUE'
  ORDER BY tc.constraint_name, kcu.ordinal_position;
`);

type UniqueRow = { constraint_name: string; column_name: string };

if (Array.isArray(uniqueConstraints) && uniqueConstraints.length > 0) {
  const grouped: Record<string, string[]> = {};
  for (const r of uniqueConstraints as UniqueRow[]) {
    grouped[r.constraint_name] = grouped[r.constraint_name] ?? [];
    grouped[r.constraint_name].push(r.column_name);
  }
  for (const [name, columns] of Object.entries(grouped)) {
    const isCorrectName = name === "account_intelligence_client_company_key";
    const hasClientId   = columns.includes("client_id");
    const hasCompanyId  = columns.includes("company_id");
    check(
      `UNIQUE constraint named "account_intelligence_client_company_key"`,
      isCorrectName,
      isCorrectName ? undefined : `found "${name}"`,
    );
    check(
      `UNIQUE covers (client_id, company_id)`,
      hasClientId && hasCompanyId,
      `columns: ${columns.join(", ")}`,
    );
  }
} else {
  check("UNIQUE constraint found", false, "none detected");
}

// ── 6. Foreign keys + ON DELETE CASCADE ──────────────────────────────────────

section("6. Foreign keys + ON DELETE CASCADE");
const fks = await sql(`
  SELECT
    kcu.column_name,
    ccu.table_name  AS foreign_table,
    ccu.column_name AS foreign_column,
    rc.delete_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name
  JOIN information_schema.constraint_column_usage ccu
    ON rc.unique_constraint_name = ccu.constraint_name AND rc.constraint_schema = ccu.constraint_schema
  WHERE tc.table_schema   = 'public'
    AND tc.table_name     = 'account_intelligence'
    AND tc.constraint_type = 'FOREIGN KEY'
  ORDER BY kcu.column_name;
`);

type FkRow = { column_name: string; foreign_table: string; foreign_column: string; delete_rule: string };

const expectedFks: Array<{ col: string; toTable: string; toCol: string }> = [
  { col: "client_id",  toTable: "clients",   toCol: "id" },
  { col: "company_id", toTable: "companies", toCol: "id" },
];

if (Array.isArray(fks)) {
  check("2 foreign keys present", fks.length === 2, `found ${fks.length}`);
  for (const exp of expectedFks) {
    const actual = (fks as FkRow[]).find((f) => f.column_name === exp.col);
    if (!actual) {
      check(`FK ${exp.col} → ${exp.toTable}(${exp.toCol})`, false, "MISSING");
      continue;
    }
    check(
      `FK ${exp.col} → ${exp.toTable}(${exp.toCol}) ON DELETE CASCADE`,
      actual.foreign_table === exp.toTable &&
      actual.foreign_column === exp.toCol &&
      actual.delete_rule === "CASCADE",
      `to=${actual.foreign_table}.${actual.foreign_column}, delete_rule=${actual.delete_rule}`,
    );
  }
} else {
  check("FK query succeeded", false);
}

// ── 7. Indexes ────────────────────────────────────────────────────────────────

section("7. Indexes");
const indexes = await sql(`
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'account_intelligence'
  ORDER BY indexname;
`);

type IdxRow = { indexname: string; indexdef: string };

const requiredIndexes = [
  "account_intelligence_client_score_idx",
  "account_intelligence_client_company_idx",
  "account_intelligence_staleness_idx",
];

if (Array.isArray(indexes)) {
  console.log(`  All indexes on account_intelligence:`);
  for (const i of indexes as IdxRow[]) {
    console.log(`    ${i.indexname}`);
    console.log(`      ${i.indexdef}`);
  }
  for (const name of requiredIndexes) {
    const found = (indexes as IdxRow[]).some((i) => i.indexname === name);
    check(`index "${name}" present`, found);
  }
  // Verify the client_score_idx includes DESC ordering
  const scoreIdx = (indexes as IdxRow[]).find(
    (i) => i.indexname === "account_intelligence_client_score_idx",
  );
  if (scoreIdx) {
    check(
      "client_score_idx has DESC ordering on opportunity_score",
      scoreIdx.indexdef.toLowerCase().includes("desc"),
      scoreIdx.indexdef,
    );
  }
} else {
  check("index query succeeded", false);
}

// ── 8. RLS enabled ────────────────────────────────────────────────────────────

section("8. RLS status");
const rlsRows = await sql(`
  SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
  WHERE relname = 'account_intelligence'
    AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
`);

type RlsRow = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean };

if (Array.isArray(rlsRows) && rlsRows.length > 0) {
  const r = rlsRows[0] as RlsRow;
  check("RLS enabled (relrowsecurity = true)", r.relrowsecurity === true);
  console.log(`     force_row_security: ${r.relforcerowsecurity}`);
} else {
  check("table found in pg_class", false);
}

// ── 9. No RLS policies ────────────────────────────────────────────────────────

section("9. No RLS policies (blocked pending auth/tenant-mapping design)");
const policies = await sql(`
  SELECT policyname, cmd, roles::text
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'account_intelligence';
`);

type PolicyRow = { policyname: string; cmd: string; roles: string };

if (Array.isArray(policies)) {
  check(
    "No RLS policies defined",
    policies.length === 0,
    policies.length > 0
      ? `Found: ${(policies as PolicyRow[]).map((p) => p.policyname).join(", ")}`
      : undefined,
  );
} else {
  check("policy query succeeded", false);
}

// ── 10. Migrations 0001–0011 tables unmodified ────────────────────────────────

section("10. Migrations 0001–0011 — key tables still present");
const priorTables = await sql(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN (
      'clients', 'icp_onboarding', 'lead_magnets', 'campaign_strategies',
      'campaign_plans', 'email_sequences', 'email_sequence_steps',
      'list_quality_scores', 'campaign_reviews', 'signals',
      'enrichment_runs', 'jobs', 'companies', 'contacts', 'lists',
      'list_members', 'campaigns', 'campaign_leads', 'email_verifications'
    )
  ORDER BY table_name;
`);

type TableRow = { table_name: string };

const expected19 = [
  "campaign_leads","campaign_plans","campaign_reviews","campaign_strategies",
  "campaigns","clients","companies","contacts","email_sequences",
  "email_sequence_steps","email_verifications","enrichment_runs","icp_onboarding",
  "jobs","lead_magnets","list_members","list_quality_scores","lists","signals",
];

if (Array.isArray(priorTables)) {
  const found = new Set((priorTables as TableRow[]).map((t) => t.table_name));
  const missing = expected19.filter((n) => !found.has(n));
  check(
    `All 19 prior tables present (found ${found.size})`,
    missing.length === 0,
    missing.length > 0 ? `MISSING: ${missing.join(", ")}` : undefined,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(70));
console.log(`Migration 0012 verification complete`);
console.log(`  Checks passed: ${passed}`);
console.log(`  Checks failed: ${failed}`);
console.log("=".repeat(70));

if (failed > 0) process.exit(1);
