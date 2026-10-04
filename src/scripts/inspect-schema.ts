/**
 * Inspects the LIVE Supabase schema WITHOUT a DB password, using PostgREST's
 * OpenAPI document (GET {url}/rest/v1/). Read-only. Prints each exposed table
 * and its columns so we can align migrations to what already exists.
 *
 * Run: npx tsx src/scripts/inspect-schema.ts
 */
import { requireEnv, ENV_KEYS } from "../config/env";

const url = requireEnv(ENV_KEYS.supabaseUrl).replace(/\/$/, "");
const key = requireEnv(ENV_KEYS.supabaseSecretKey);

const res = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});

if (!res.ok) {
  console.error(`Schema fetch failed: ${res.status} ${res.statusText}`);
  console.error((await res.text()).slice(0, 500));
  process.exit(1);
}

const doc = (await res.json()) as {
  definitions?: Record<
    string,
    { properties?: Record<string, { type?: string; format?: string; description?: string }>; required?: string[] }
  >;
};

const tables = doc.definitions ?? {};
const names = Object.keys(tables).sort();
console.log(`Connected. ${names.length} table(s) exposed via PostgREST:\n`);

for (const table of names) {
  const def = tables[table];
  const cols = Object.entries(def.properties ?? {});
  const required = new Set(def.required ?? []);
  console.log(`▸ ${table} (${cols.length} cols)`);
  for (const [col, meta] of cols) {
    const pk = meta.description?.includes("Primary Key") ? " [PK]" : "";
    const fk = meta.description?.match(/Foreign Key.*?\`([^\`]+)\`/)?.[1];
    const flags = [required.has(col) ? "required" : "", pk, fk ? `→ ${fk}` : ""]
      .filter(Boolean)
      .join(" ");
    console.log(`    ${col}: ${meta.format ?? meta.type ?? "?"}${flags ? "  (" + flags + ")" : ""}`);
  }
  console.log("");
}
