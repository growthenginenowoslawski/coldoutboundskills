/**
 * campaign_leads live schema inspection via Supabase Management API.
 * READ-ONLY. No writes. No schema changes.
 *
 * Run:  npx tsx scripts/inspect-campaign-leads-live.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

const PROJECT_REF = "wkdaojaxvbjpkamrsejs";
const token = process.env.SUPABASE_ACCESS_TOKEN ?? "";
if (!token) { console.error("SUPABASE_ACCESS_TOKEN missing"); process.exit(1); }

async function sql(query: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<Record<string, unknown>[]>;
}

function printRows(rows: Record<string, unknown>[]) {
  if (!rows || rows.length === 0) { console.log("  (no rows)"); return; }
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)),
  );
  const sep  = widths.map((w) => "─".repeat(w)).join("─┼─");
  const line = (row: Record<string, unknown>) =>
    keys.map((k, i) => String(row[k] ?? "").padEnd(widths[i])).join(" │ ");
  console.log("  " + line(Object.fromEntries(keys.map((k) => [k, k]))));
  console.log("  " + sep);
  for (const row of rows) console.log("  " + line(row));
}

function section(t: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${t}`);
  console.log("═".repeat(70));
}

async function main() {
  console.log("\ncampaign_leads — Live Schema Inspection via Management API (Read-Only)");
  console.log("=".repeat(70));

  // 1. Columns
  section("1. Columns");
  const cols = await sql(`
    SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'campaign_leads'
    ORDER BY ordinal_position
  `);
  printRows(cols);

  // 2. All constraints
  section("2. All constraints (PK / UNIQUE / FK / CHECK)");
  const constraints = await sql(`
    SELECT
      tc.constraint_name,
      tc.constraint_type,
      string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns,
      rc.update_rule,
      rc.delete_rule,
      ccu.table_name AS ref_table,
      string_agg(ccu.column_name, ', ') AS ref_columns
    FROM information_schema.table_constraints tc
    LEFT JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema    = tc.table_schema
     AND kcu.table_name      = tc.table_name
    LEFT JOIN information_schema.referential_constraints rc
      ON rc.constraint_name   = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = rc.unique_constraint_name
     AND ccu.table_schema    = rc.unique_constraint_schema
    WHERE tc.table_schema = 'public' AND tc.table_name = 'campaign_leads'
    GROUP BY tc.constraint_name, tc.constraint_type,
             rc.update_rule, rc.delete_rule, ccu.table_name
    ORDER BY tc.constraint_type, tc.constraint_name
  `);
  printRows(constraints);

  // 3. CHECK constraint clauses
  section("3. CHECK constraint clauses");
  const checks = await sql(`
    SELECT cc.constraint_name, cc.check_clause
    FROM information_schema.check_constraints cc
    JOIN information_schema.table_constraints tc
      ON tc.constraint_name = cc.constraint_name
     AND tc.constraint_schema = cc.constraint_schema
    WHERE tc.table_schema = 'public' AND tc.table_name = 'campaign_leads'
  `);
  printRows(checks);

  // 4. pg_constraint (includes UNIQUE and composite FK detail)
  section("4. pg_constraint (all constraint definitions)");
  const pgConstraints = await sql(`
    SELECT
      conname   AS constraint_name,
      contype   AS type_char,
      CASE contype
        WHEN 'p' THEN 'PRIMARY KEY'
        WHEN 'u' THEN 'UNIQUE'
        WHEN 'f' THEN 'FOREIGN KEY'
        WHEN 'c' THEN 'CHECK'
        ELSE contype::text
      END AS type,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.campaign_leads'::regclass
    ORDER BY contype, conname
  `);
  printRows(pgConstraints);

  // 5. Indexes
  section("5. Indexes");
  const indexes = await sql(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'campaign_leads'
    ORDER BY indexname
  `);
  for (const idx of indexes) {
    console.log(`  [${idx.indexname}]`);
    console.log(`    ${idx.indexdef}`);
  }

  // 6. RLS status
  section("6. RLS status");
  const rls = await sql(`
    SELECT
      relname            AS table_name,
      relrowsecurity     AS rls_enabled,
      relforcerowsecurity AS force_rls
    FROM pg_class
    WHERE relname = 'campaign_leads'
      AND relnamespace = 'public'::regnamespace
  `);
  printRows(rls);

  // 7. RLS policies
  section("7. RLS policies");
  const policies = await sql(`
    SELECT policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'campaign_leads'
    ORDER BY policyname
  `);
  if (!policies || policies.length === 0) {
    console.log("  No policies defined.");
  } else {
    for (const p of policies) {
      console.log(`  [${p.policyname}]`);
      console.log(`    permissive=${p.permissive}  roles=${JSON.stringify(p.roles)}  cmd=${p.cmd}`);
      if (p.qual)       console.log(`    USING:      ${p.qual}`);
      if (p.with_check) console.log(`    WITH CHECK: ${p.with_check}`);
    }
  }

  // 8. Triggers
  section("8. Triggers");
  const triggers = await sql(`
    SELECT trigger_name, event_manipulation, action_timing, action_statement
    FROM information_schema.triggers
    WHERE event_object_schema = 'public'
      AND event_object_table  = 'campaign_leads'
    ORDER BY trigger_name
  `);
  printRows(triggers);

  // 9. Row count + status distribution
  section("9. Row count and status distribution");
  const rowCount = await sql(`SELECT COUNT(*) AS total FROM public.campaign_leads`);
  console.log(`  Total rows: ${rowCount[0]?.total ?? 0}`);

  const statusDist = await sql(`
    SELECT COALESCE(status, '(null)') AS status, COUNT(*) AS count
    FROM public.campaign_leads
    GROUP BY status
    ORDER BY count DESC
  `);
  if (!statusDist || statusDist.length === 0) {
    console.log("  Status distribution: table is empty");
  } else {
    printRows(statusDist);
  }

  // 10. FK detail: what cascades happen when campaign or contact is deleted?
  section("10. FK cascade behaviour");
  const fkDetail = await sql(`
    SELECT
      kcu.column_name,
      ccu.table_name AS references_table,
      ccu.column_name AS references_column,
      rc.update_rule,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema    = tc.table_schema
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name   = tc.constraint_name
     AND rc.constraint_schema = tc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = rc.unique_constraint_name
     AND ccu.table_schema    = rc.unique_constraint_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name   = 'campaign_leads'
      AND tc.constraint_type = 'FOREIGN KEY'
    ORDER BY kcu.column_name
  `);
  printRows(fkDetail);

  console.log("\n" + "=".repeat(70));
  console.log("  Inspection complete. No writes made.");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("\nError:", err);
  process.exit(1);
});
