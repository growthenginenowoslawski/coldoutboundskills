/**
 * campaign_leads schema inspection — Stage 19B pre-work.
 *
 * READ-ONLY. No writes, no schema changes, no data modifications.
 *
 * Approach:
 *   A) PostgREST OpenAPI spec (GET /rest/v1/) → full table definition incl. columns, types
 *   B) Column existence probing (select specific columns, observe errors)
 *   C) Uniqueness probing (attempt select on candidate unique key columns)
 *   D) Data distribution (row count, status values)
 *   E) RLS test (try select with anon key — if it returns data, RLS is off or permissive)
 *
 * Run:
 *   npx tsx scripts/inspect-campaign-leads-schema.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function header(title: string) {
  console.log("\n" + "═".repeat(70));
  console.log(`  ${title}`);
  console.log("═".repeat(70));
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function ok(label: string, value: unknown = "") {
  console.log(`  ✓ ${label}${value !== "" ? ": " + value : ""}`);
}
function info(label: string, value: unknown = "") {
  console.log(`    ${label}${value !== "" ? ": " + JSON.stringify(value) : ""}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  header("campaign_leads — Live Schema Inspection (Read-Only)");

  const url    = process.env.SUPABASE_URL ?? "";
  const secret = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!url || !secret) {
    console.error("Abort: SUPABASE_URL + SUPABASE_SECRET_KEY required.");
    process.exit(1);
  }
  console.log(`  SUPABASE_URL: ${url.replace(/^(https:\/\/[^.]+).*$/, "$1…")}`);

  const db = getSupabaseAdmin();

  // ── A. OpenAPI spec from PostgREST ────────────────────────────────────────
  section("A. PostgREST OpenAPI spec — table definition");

  let campaignLeadsDefinition: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: {
        "apikey":        secret,
        "Authorization": `Bearer ${secret}`,
      },
    });
    if (!res.ok) {
      console.error(`  OpenAPI request failed: HTTP ${res.status}`);
    } else {
      const spec = await res.json() as Record<string, unknown>;
      // OpenAPI 2.0: definitions.<TableName>
      const definitions = spec.definitions as Record<string, unknown> | undefined;
      if (definitions?.["campaign_leads"]) {
        campaignLeadsDefinition = definitions["campaign_leads"] as Record<string, unknown>;
        ok("campaign_leads definition found in OpenAPI spec");

        const props = (campaignLeadsDefinition.properties ?? {}) as Record<string, Record<string, unknown>>;
        const required = (campaignLeadsDefinition.required ?? []) as string[];

        console.log(`\n  Columns (${Object.keys(props).length} total):`);
        console.log(`  ${"Column".padEnd(30)}  ${"Type".padEnd(20)}  ${"Format".padEnd(15)}  Required`);
        console.log(`  ${"─".repeat(30)}  ${"─".repeat(20)}  ${"─".repeat(15)}  ─────────`);
        for (const [col, def] of Object.entries(props)) {
          const type    = String(def.type   ?? def["$ref"] ?? "").padEnd(20);
          const format  = String(def.format ?? "").padEnd(15);
          const isReq   = required.includes(col) ? "NOT NULL" : "nullable";
          const dflt    = def.default !== undefined ? `  default=${JSON.stringify(def.default)}` : "";
          const desc    = def.description ? `  — ${String(def.description).slice(0, 60)}` : "";
          console.log(`  ${col.padEnd(30)}  ${type}  ${format}  ${isReq}${dflt}${desc}`);
        }

        if (required.length > 0) {
          console.log(`\n  NOT NULL columns: ${required.join(", ")}`);
        }
      } else {
        console.log("  campaign_leads not found in OpenAPI spec definitions.");
        if (definitions) {
          console.log("  Available table definitions:", Object.keys(definitions).sort().join(", "));
        }
      }
    }
  } catch (err) {
    console.error("  OpenAPI fetch failed:", err);
  }

  // ── B. Column existence probing ───────────────────────────────────────────
  section("B. Column existence probing (read-only select per column)");

  // Columns we want to confirm: known-from-migration + inferred-from-docs
  const candidateColumns = [
    "id", "campaign_id", "contact_id", "client_id", "company_id",
    "status", "steps_sent", "last_sent_at", "reply_received_at",
    "reply_classification", "created_at", "updated_at",
    "platform_lead_id", "sequence_number", "enrolled_at",
  ];

  const confirmedColumns: string[] = [];
  const missingColumns:   string[] = [];

  for (const col of candidateColumns) {
    const { error } = await db
      .from("campaign_leads")
      .select(col)
      .limit(0);

    if (!error) {
      confirmedColumns.push(col);
    } else if (error.message.includes("column") || error.message.includes("does not exist")) {
      missingColumns.push(col);
    } else {
      // Other error (RLS? permission?) — log separately
      console.log(`    [${col}] unexpected error: ${error.message}`);
    }
  }

  ok(`Confirmed columns (${confirmedColumns.length})`, confirmedColumns.join(", "));
  if (missingColumns.length > 0) {
    info(`Not present (${missingColumns.length})`, missingColumns.join(", "));
  }

  // ── C. Data distribution ──────────────────────────────────────────────────
  section("C. Row count and data distribution");

  const { count: totalCount, error: countErr } = await db
    .from("campaign_leads")
    .select("*", { count: "exact", head: true });

  if (countErr) {
    console.error("  Row count failed:", countErr.message);
  } else {
    ok("Total rows", totalCount ?? 0);
  }

  if ((totalCount ?? 0) > 0) {
    // Status distribution
    const { data: statusRows, error: statusErr } = await db
      .from("campaign_leads")
      .select("status");

    if (!statusErr && statusRows) {
      const dist: Record<string, number> = {};
      for (const r of statusRows as { status: string | null }[]) {
        const k = r.status ?? "(null)";
        dist[k] = (dist[k] ?? 0) + 1;
      }
      console.log("  Status distribution:");
      for (const [s, n] of Object.entries(dist).sort()) {
        console.log(`    ${s.padEnd(25)} ${n}`);
      }
    }

    // Sample row — shows real column names present in DB
    const { data: sample } = await db.from("campaign_leads").select("*").limit(1).maybeSingle();
    if (sample) {
      console.log("\n  Live row columns confirmed:", Object.keys(sample as Record<string, unknown>).join(", "));
    }
  } else {
    ok("Table is empty — no rows to probe status distribution");
  }

  // ── D. Uniqueness verification: does (campaign_id, contact_id) guarantee uniqueness? ─
  section("D. Duplicate enrollment protection");

  // From `isContactEnrolledInCampaign`: the code does a SELECT then app-level check.
  // We need to confirm whether the DB has a UNIQUE constraint to prevent races.
  // Since we can't query pg_indexes, we test indirectly from the OpenAPI spec description
  // and from known migration facts.

  if (campaignLeadsDefinition) {
    const props = (campaignLeadsDefinition.properties ?? {}) as Record<string, Record<string, unknown>>;
    // OpenAPI spec marks unique columns in a few ways — check if there's a hint
    const campaignIdProp = props["campaign_id"] ?? {};
    const contactIdProp  = props["contact_id"]  ?? {};
    info("campaign_id OpenAPI def", campaignIdProp);
    info("contact_id OpenAPI def",  contactIdProp);
  }

  // Known fact from migration 0014 comments: "Checks the campaign_leads table for
  // UNIQUE(campaign_id, contact_id)." — from campaigns.ts isContactEnrolledInCampaign docstring
  // But the migration itself doesn't add this constraint explicitly.
  // We check via the OpenAPI spec description field.

  // Try to insert a duplicate and observe the error (READ THE ERROR ONLY — no committed write)
  // We cannot do this safely without knowing a valid campaign_id and contact_id pair.
  // Instead, note this as requiring SQL editor verification.
  console.log("\n  NOTE: Cannot verify UNIQUE(campaign_id, contact_id) via read-only API.");
  console.log("  Evidence from code comments suggests it exists, but live DB confirmation");
  console.log("  requires the Supabase SQL editor or management API.");
  console.log("  Migration 0014 does NOT explicitly create this constraint.");
  console.log("  The original table was created via Dashboard — unknown if constraint was added.");

  // ── E. RLS test ───────────────────────────────────────────────────────────
  section("E. RLS presence test");

  // Test: does a HEAD request with only the ANON key return data?
  // If RLS is enabled with no permissive policies, anon reads should return 0 rows.
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!anonKey) {
    console.log("  SUPABASE_ANON_KEY not set — skipping anon RLS test.");
    console.log("  (Service role bypasses RLS regardless. Anon key needed to test policies.)");
  } else {
    try {
      const rlsRes = await fetch(`${url}/rest/v1/campaign_leads?select=id&limit=1`, {
        method:  "HEAD",
        headers: {
          "apikey":        anonKey,
          "Authorization": `Bearer ${anonKey}`,
        },
      });
      const contentRange = rlsRes.headers.get("content-range");
      if (rlsRes.status === 200) {
        console.log(`  Anon key can access campaign_leads (HTTP 200). Content-Range: ${contentRange}`);
        console.log("  → RLS is either disabled or has a permissive SELECT policy for anon.");
      } else if (rlsRes.status === 401 || rlsRes.status === 403) {
        ok("Anon key blocked (RLS is active with no permissive policy for anon)", `HTTP ${rlsRes.status}`);
      } else {
        console.log(`  Unexpected HTTP ${rlsRes.status} for anon RLS test.`);
      }
    } catch (err) {
      console.error("  Anon RLS test failed:", err);
    }
  }

  // Service role always bypasses RLS — confirm our reads work
  const { error: srErr } = await db.from("campaign_leads").select("id").limit(1);
  if (!srErr) {
    ok("Service role can read campaign_leads (bypasses RLS)");
  } else {
    console.error("  Service role read failed:", srErr.message);
  }

  // ── F. Known facts summary (from migration files) ─────────────────────────
  section("F. Known facts from migration 0014 (confirmed source)");

  console.log(`
  From migration 0014_campaign_operations_foundation.sql:

  campaign_leads had these BEFORE migration 0014 (Dashboard-created, unknown exact schema):
    — campaign_id (uuid, FK → campaigns.id)         [referenced in migration as existing]
    — contact_id  (uuid, FK → contacts.id)           [inferred from isContactEnrolledInCampaign]

  campaign_leads changes IN migration 0014:
    — ADD COLUMN client_id uuid NOT NULL → clients(id) ON DELETE CASCADE
    — ADD CONSTRAINT campaign_leads_client_campaign_fk
          FK (client_id, campaign_id) → campaigns(client_id, id) ON DELETE CASCADE
    — CREATE INDEX campaign_leads_client_status_idx  ON (client_id, status)
    — CREATE INDEX campaign_leads_client_campaign_idx ON (client_id, campaign_id)

  campaign_leads changes BEFORE migration 0014 (Dashboard-created, not in any migration):
    — Original table structure UNKNOWN — not in any migration file
    — isContactEnrolledInCampaign docstring mentions UNIQUE(campaign_id, contact_id)
      but this constraint is NOT in migration 0014
    — Status CHECK constraint: NOT in migration 0014 — possibly in original Dashboard table

  Conclusion: The original table definition (columns, constraints, status CHECK,
  unique constraint on campaign_id+contact_id) exists in the live DB but is not
  captured in any migration file in this repo. Needs SQL editor verification.
  `);

  // ── Summary ────────────────────────────────────────────────────────────────
  header("Inspection complete");
  console.log("  This script made NO writes to the database.");
  console.log("  All queries are read-only.\n");
}

main().catch((err) => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
});
