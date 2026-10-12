/**
 * Pre-migration schema check for Stage 23.
 * Run: npx tsx scripts/check-stage23-prereqs.ts
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
    throw new Error(`SQL error (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json() as Promise<unknown[]>;
}

console.log("=".repeat(70));
console.log("Stage 23 Pre-Migration Schema Check");
console.log("=".repeat(70));

// 1. campaign_strategies constraints
console.log("\n── campaign_strategies constraints ──────────────────────────────────");
const csConstraints = await sql(
  `SELECT conname, contype, pg_get_constraintdef(oid) as def
   FROM pg_constraint
   WHERE conrelid = 'public.campaign_strategies'::regclass
   ORDER BY contype, conname`,
);
console.log(JSON.stringify(csConstraints, null, 2));

const hasClientIdUniqueOnCampaignStrategies = (csConstraints as Array<{ conname: string; contype: string }>)
  .some((c) => c.contype === "u" && /client_id/.test(c.conname));
console.log(`Has UNIQUE(client_id, id) on campaign_strategies: ${hasClientIdUniqueOnCampaignStrategies}`);

// 2. Check if Stage 23 tables already exist
console.log("\n── Stage 23 table existence ────────────────────────────────────────");
const existingTables = await sql(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public'
     AND table_name IN ('contact_intelligence', 'contact_campaign_relevance')
   ORDER BY table_name`,
);
console.log(JSON.stringify(existingTables, null, 2));

// 3. Check data violations: any existing contact_intelligence rows would need review
// (Should be 0 since the table doesn't exist yet)

// 4. campaign_strategies — check columns that exist (we reference targeting_level, value_proposition, updated_at)
console.log("\n── campaign_strategies columns ─────────────────────────────────────");
const csColumns = await sql(
  `SELECT column_name, data_type, is_nullable
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'campaign_strategies'
   ORDER BY ordinal_position`,
);
console.log(JSON.stringify(csColumns, null, 2));

// 5. contacts columns (confirm no updated_at — documented limitation)
console.log("\n── contacts columns (confirming no updated_at) ─────────────────────");
const contactsCols = await sql(
  `SELECT column_name, data_type
   FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'contacts'
   ORDER BY ordinal_position`,
);
console.log(JSON.stringify(contactsCols, null, 2));

// 6. Check all current tables (to confirm migration numbering)
console.log("\n── Current public tables ────────────────────────────────────────────");
const allTables = await sql(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public'
   ORDER BY table_name`,
);
console.log(JSON.stringify(allTables, null, 2));

console.log("\n" + "=".repeat(70));
console.log("Schema check complete.");
