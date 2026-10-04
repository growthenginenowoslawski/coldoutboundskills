/**
 * Applies migration 0019 to Supabase production via the Management API.
 * Run: npx tsx scripts/apply-0019-migration.ts
 *
 * Requires SUPABASE_ACCESS_TOKEN in .env (or process.env).
 * Uses the Management API endpoint:
 *   POST https://api.supabase.com/v1/projects/{ref}/database/query
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Load env ──────────────────────────────────────────────────────────────────
// Walk up from __dirname to find the .env at the repo root.
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
if (!ACCESS_TOKEN) {
  console.error("SUPABASE_ACCESS_TOKEN not set");
  process.exit(1);
}

// Extract project ref from SUPABASE_URL
const supabaseUrl = process.env.SUPABASE_URL ?? "";
const projectRef = supabaseUrl.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];
if (!projectRef) {
  console.error("Could not determine project ref from SUPABASE_URL:", supabaseUrl);
  process.exit(1);
}

console.log(`Project ref: ${projectRef}`);

// ── Read migration SQL ────────────────────────────────────────────────────────
const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
  "0019_person_discovery.sql",
);

const sql = readFileSync(migrationPath, "utf8");
console.log(`Migration SQL: ${sql.length} bytes from ${migrationPath}`);

// ── Apply via Management API ──────────────────────────────────────────────────
const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
console.log(`\nApplying migration via: POST ${url}`);

const response = await fetch(url, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: sql }),
});

const body = await response.text();

console.log(`\nHTTP status: ${response.status} ${response.statusText}`);
console.log("Response body:");
console.log(body);

if (!response.ok) {
  console.error("\nMigration FAILED.");
  process.exit(1);
}

console.log("\nMigration applied successfully.");
