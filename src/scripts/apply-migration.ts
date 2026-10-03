/**
 * Runs a .sql migration against Supabase via the Management API (which CAN run
 * DDL, unlike the PostgREST project keys). Requires SUPABASE_ACCESS_TOKEN
 * (a Personal Access Token, sbp_…) in .env.
 *
 * Run: npx tsx src/scripts/apply-migration.ts supabase/migrations/0002_icp_onboarding.sql
 */
import { readFileSync } from "node:fs";
import { ENV_KEYS, requireEnv } from "../config/env";

const file = process.argv[2];
if (!file) {
  console.error("usage: apply-migration.ts <path-to-.sql>");
  process.exit(1);
}

const url = requireEnv(ENV_KEYS.supabaseUrl);
const token = requireEnv(ENV_KEYS.supabaseAccessToken);
// Project ref is the subdomain of the Supabase URL: https://<ref>.supabase.co
const ref = new URL(url).hostname.split(".")[0];
const sql = readFileSync(file, "utf8");

console.log(`Applying ${file} to project ${ref} via Management API…`);

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: sql }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`❌ ${res.status} ${res.statusText}`);
  console.error(text.slice(0, 1000));
  process.exit(1);
}
console.log("✅ migration applied");
if (text.trim()) console.log(text.slice(0, 1000));
