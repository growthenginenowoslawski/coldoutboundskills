/**
 * Applies migration 0020_campaign_readiness.sql to Supabase production
 * via the Management API, then runs full schema + security verification.
 *
 * Run: npx tsx scripts/apply-0020-migration.ts
 *
 * Requires SUPABASE_ACCESS_TOKEN + SUPABASE_URL in .env.
 * Uses: POST https://api.supabase.com/v1/projects/{ref}/database/query
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Env loader ────────────────────────────────────────────────────────────────
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

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!ACCESS_TOKEN) { console.error("SUPABASE_ACCESS_TOKEN not set"); process.exit(1); }

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const projectRef  = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
if (!projectRef) { console.error("Cannot derive project ref from SUPABASE_URL:", supabaseUrl); process.exit(1); }

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function query(sql: string): Promise<unknown[]> {
  const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Management API error ${res.status}: ${body.slice(0, 400)}`);
  return JSON.parse(body) as unknown[];
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ── Read migration file ────────────────────────────────────────────────────────
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
  "0020_campaign_readiness.sql",
);

const sql = readFileSync(migrationPath, "utf8");
const sha256 = createHash("sha256").update(sql).digest("hex");

// The SHA-256 of the reviewed migration (computed before apply, verified here)
const REVIEWED_SHA256 = "eea97d3ddad907059c535e200e74729a4d6e63ad0df8abce8e32652b6fe98ce6";

section("Pre-flight: migration file integrity");
console.log(`  File:   ${migrationPath}`);
console.log(`  Size:   ${sql.length} bytes`);
console.log(`  SHA256: ${sha256}`);
check(
  "Migration file matches reviewed hash",
  sha256 === REVIEWED_SHA256,
  sha256 !== REVIEWED_SHA256 ? `got ${sha256}, expected ${REVIEWED_SHA256}` : undefined,
);

if (sha256 !== REVIEWED_SHA256) {
  console.error("\nABORTED: migration file has been modified since review. Do not apply.");
  process.exit(1);
}

// ── Apply ─────────────────────────────────────────────────────────────────────
section("Applying migration 0020");
console.log(`  Project ref: ${projectRef}`);
console.log(`  POST https://api.supabase.com/v1/projects/${projectRef}/database/query`);

const applyUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
const applyRes = await fetch(applyUrl, {
  method: "POST",
  headers: { "Authorization": `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const applyBody = await applyRes.text();

console.log(`\n  HTTP status: ${applyRes.status} ${applyRes.statusText}`);
console.log(`  Response: ${applyBody.slice(0, 300)}`);

check("Migration applied (HTTP 2xx)", applyRes.ok);
if (!applyRes.ok) {
  console.error("\nMigration FAILED — aborting verification.");
  process.exit(1);
}

// ── Schema verification ────────────────────────────────────────────────────────

section("Table existence");

const tables = await query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('campaign_readiness_assessments', 'campaign_readiness_approvals')
  ORDER BY table_name;
`) as Array<{ table_name: string }>;

const tableNames = tables.map(r => r.table_name);
check("campaign_readiness_assessments exists", tableNames.includes("campaign_readiness_assessments"));
check("campaign_readiness_approvals exists", tableNames.includes("campaign_readiness_approvals"));

// ── Column verification ────────────────────────────────────────────────────────
section("Column presence");

const cols = await query(`
  SELECT table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('campaign_readiness_assessments', 'campaign_readiness_approvals')
  ORDER BY table_name, ordinal_position;
`) as Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>;

const byTable: Record<string, Set<string>> = {};
for (const c of cols) {
  (byTable[c.table_name] ??= new Set()).add(c.column_name);
}

const asmCols = byTable["campaign_readiness_assessments"] ?? new Set();
const aprCols = byTable["campaign_readiness_approvals"]   ?? new Set();

// assessments
for (const col of [
  "id", "client_id", "campaign_id", "campaign_strategy_id", "verdict",
  "campaign_status_at_evaluation", "platform_campaign_id_at_evaluation",
  "hard_block_codes", "warning_codes", "eligible_contact_ids",
  "qualified_count", "eligible_count", "blocked_count", "enrolled_count",
  "uploaded_count", "backfilled_count", "smtp_healthy_inbox_count",
  "contact_results", "evaluated_at", "created_at",
]) {
  check(`assessments.${col}`, asmCols.has(col));
}

// assessments must NOT have updated_at (immutable)
check("assessments has NO updated_at (immutable)", !asmCols.has("updated_at"));

// approvals
for (const col of [
  "id", "assessment_id", "client_id", "approved_by", "approved_at",
  "acknowledged_warning_codes", "notes", "is_stale", "stale_reason",
  "stale_set_at", "created_at",
]) {
  check(`approvals.${col}`, aprCols.has(col));
}

// approvals must NOT have campaign_id (removed in rev 2)
check("approvals has NO campaign_id (removed per design)", !aprCols.has("campaign_id"));

// ── Constraint verification ────────────────────────────────────────────────────
section("Constraints");

const constraints = await query(`
  SELECT
    tc.table_name,
    tc.constraint_name,
    tc.constraint_type,
    kcu.column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema    = kcu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name IN ('campaign_readiness_assessments', 'campaign_readiness_approvals')
  ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name, kcu.ordinal_position;
`) as Array<{ table_name: string; constraint_name: string; constraint_type: string; column_name: string }>;

const constraintNames = new Set(constraints.map(c => c.constraint_name));

// Unique constraints
check(
  "assessments UNIQUE(client_id, campaign_id, evaluated_at)",
  constraintNames.has("campaign_readiness_assessments_client_campaign_evaluated_at_key"),
);
check(
  "approvals UNIQUE(assessment_id)",
  constraintNames.has("campaign_readiness_approvals_assessment_id_key"),
);

// FK constraints — composite and simple
const fkRows = constraints.filter(c => c.constraint_type === "FOREIGN KEY");
const fkNames = new Set(fkRows.map(r => r.constraint_name));

check(
  "assessments composite FK (client_id, campaign_id) → campaigns",
  fkNames.has("campaign_readiness_assessments_client_campaign_fk"),
);

// Check the composite FK actually references campaign_id
const compositeFkCols = fkRows
  .filter(r => r.constraint_name === "campaign_readiness_assessments_client_campaign_fk")
  .map(r => r.column_name);
check(
  "Composite FK covers client_id and campaign_id",
  compositeFkCols.includes("client_id") && compositeFkCols.includes("campaign_id"),
);

// assessment_id → campaign_readiness_assessments (ON DELETE RESTRICT)
const approvalFKs = fkRows.filter(r => r.table_name === "campaign_readiness_approvals");
const approvalFKCols = new Set(approvalFKs.map(r => r.column_name));
check("approvals.assessment_id FK exists", approvalFKCols.has("assessment_id"));
check("approvals.client_id FK exists",     approvalFKCols.has("client_id"));

// ── CHECK constraint on verdict ───────────────────────────────────────────────
section("CHECK constraint on verdict");

const checkConstraints = await query(`
  SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE conrelid = 'public.campaign_readiness_assessments'::regclass
    AND contype = 'c';
`) as Array<{ conname: string; definition: string }>;

const verdictCheck = checkConstraints.find(c => c.definition.includes("OUTREACH_READY"));
check("verdict CHECK constraint exists on assessments", Boolean(verdictCheck));
if (verdictCheck) {
  check(
    "verdict CHECK includes all three values",
    verdictCheck.definition.includes("OUTREACH_READY_WITH_WARNINGS") &&
    verdictCheck.definition.includes("HARD_BLOCKED"),
  );
}

// ── FK ON DELETE behaviour ────────────────────────────────────────────────────
section("FK ON DELETE behaviour");

const fkDetails = await query(`
  SELECT
    tc.table_name,
    tc.constraint_name,
    rc.delete_rule
  FROM information_schema.table_constraints tc
  JOIN information_schema.referential_constraints rc
    ON tc.constraint_name = rc.constraint_name
   AND tc.table_schema    = rc.constraint_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name IN ('campaign_readiness_assessments', 'campaign_readiness_approvals')
  ORDER BY tc.table_name, tc.constraint_name;
`) as Array<{ table_name: string; constraint_name: string; delete_rule: string }>;

for (const row of fkDetails) {
  const name = row.constraint_name;
  const rule = row.delete_rule;
  if (name.includes("client_campaign_fk")) {
    check("assessments composite FK ON DELETE CASCADE", rule === "CASCADE");
  } else if (name.includes("campaign_strategy")) {
    check("assessments.campaign_strategy_id FK ON DELETE SET NULL", rule === "SET NULL");
  } else if (row.table_name === "campaign_readiness_assessments") {
    // client_id FK
    if (name.includes("client")) check("assessments.client_id FK ON DELETE CASCADE", rule === "CASCADE");
  } else if (row.table_name === "campaign_readiness_approvals") {
    if (name.includes("assessment")) {
      check("approvals.assessment_id FK ON DELETE RESTRICT", rule === "RESTRICT");
    } else if (name.includes("client")) {
      check("approvals.client_id FK ON DELETE CASCADE", rule === "CASCADE");
    }
  }
}

// ── RLS ───────────────────────────────────────────────────────────────────────
section("Row Level Security");

const rlsRows = await query(`
  SELECT tablename, rowsecurity
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN ('campaign_readiness_assessments', 'campaign_readiness_approvals');
`) as Array<{ tablename: string; rowsecurity: boolean }>;

for (const row of rlsRows) {
  check(`RLS enabled on ${row.tablename}`, row.rowsecurity === true);
}

const policies = await query(`
  SELECT tablename, policyname
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('campaign_readiness_assessments', 'campaign_readiness_approvals');
`) as Array<{ tablename: string; policyname: string }>;

check("Zero RLS policies on both tables (service_role only)", policies.length === 0,
  policies.length > 0 ? `unexpected policies: ${policies.map(p => `${p.tablename}.${p.policyname}`).join(", ")}` : undefined,
);

// ── Indexes ───────────────────────────────────────────────────────────────────
section("Indexes");

const indexes = await query(`
  SELECT indexname, tablename
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename IN ('campaign_readiness_assessments', 'campaign_readiness_approvals')
  ORDER BY tablename, indexname;
`) as Array<{ indexname: string; tablename: string }>;

const idxNames = new Set(indexes.map(i => i.indexname));

check(
  "assessments: client_campaign_idx exists",
  idxNames.has("campaign_readiness_assessments_client_campaign_idx"),
);
check(
  "approvals: client_active_idx exists",
  idxNames.has("campaign_readiness_approvals_client_active_idx"),
);
check(
  "assessments: unique evaluated_at idx exists",
  idxNames.has("campaign_readiness_assessments_client_campaign_evaluated_at_key"),
);
check(
  "approvals: unique assessment_id idx exists",
  idxNames.has("campaign_readiness_approvals_assessment_id_key"),
);

// ── Unexpected grants ─────────────────────────────────────────────────────────
section("Unexpected grants");

const grants = await query(`
  SELECT grantee, table_name, privilege_type
  FROM information_schema.role_table_grants
  WHERE table_schema = 'public'
    AND table_name IN ('campaign_readiness_assessments', 'campaign_readiness_approvals')
    AND grantee NOT IN ('postgres', 'service_role', 'supabase_admin', 'authenticated',
                        'anon', 'PUBLIC', 'supabase_auth_admin', 'dashboard_user',
                        'authenticator', 'pgsodium_keyholder', 'pgtle_admin');
`) as Array<{ grantee: string; table_name: string; privilege_type: string }>;

check(
  "No unexpected grantees on new tables",
  grants.length === 0,
  grants.length > 0 ? `unexpected: ${grants.map(g => `${g.grantee}/${g.table_name}/${g.privilege_type}`).join(", ")}` : undefined,
);

// ── stale_set_at column type ──────────────────────────────────────────────────
section("stale_set_at column details");

const staleCol = cols.find(c =>
  c.table_name === "campaign_readiness_approvals" && c.column_name === "stale_set_at",
);
check("approvals.stale_set_at is timestamptz", staleCol?.data_type === "timestamp with time zone");
check("approvals.stale_set_at is nullable",    staleCol?.is_nullable === "YES");

// ── campaign_strategy_id FK ───────────────────────────────────────────────────
section("campaign_strategy_id FK");

const stratFkRows = await query(`
  SELECT tc.constraint_name, ccu.table_name AS referenced_table
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
   AND tc.table_schema    = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
  WHERE tc.table_schema = 'public'
    AND tc.table_name   = 'campaign_readiness_assessments'
    AND kcu.column_name = 'campaign_strategy_id'
    AND tc.constraint_type = 'FOREIGN KEY';
`) as Array<{ constraint_name: string; referenced_table: string }>;

check(
  "assessments.campaign_strategy_id FK → campaign_strategies",
  stratFkRows.some(r => r.referenced_table === "campaign_strategies"),
);

// ── Final summary ─────────────────────────────────────────────────────────────
section("Summary");
console.log(`\n  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  console.error("\nVERIFICATION FAILED — review items above.");
  process.exit(1);
} else {
  console.log("\nAll verification checks passed. Migration 0020 is live.");
}
