/**
 * Stage 30 — Quick Signal Audit (READ-ONLY)
 * Determines which companies hold the 1000+ Gramscode signals.
 * Run: npx tsx scripts/stage30-signal-audit.ts
 */
import { existsSync } from "node:fs";
import { resolve }    from "node:path";
if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}
import { getSupabaseAdmin } from "../src/db/supabase.js";

const db = getSupabaseAdmin();
const GRAMSCODE_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";

// Exact count of all Gramscode signals (head=true bypasses 1000-row cap)
const { count: totalSig } = await db
  .from("signals")
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID);
console.log("Total Gramscode signals (exact count):", totalSig);

// Fetch all signal rows (select only company_id — lightweight)
// Use range pagination if > 1000
let allRows: Array<{ company_id: string }> = [];
const PAGE = 1000;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await db
    .from("signals")
    .select("company_id")
    .eq("client_id", GRAMSCODE_ID)
    .range(from, from + PAGE - 1);
  if (error) { console.error("Error:", error.message); break; }
  allRows = allRows.concat((data ?? []) as Array<{ company_id: string }>);
  if ((data ?? []).length < PAGE) break;
}

// Aggregate by company_id
const cMap = new Map<string, number>();
for (const r of allRows) {
  cMap.set(r.company_id, (cMap.get(r.company_id) ?? 0) + 1);
}
console.log("Distinct company_ids with signals:", cMap.size);

// Fetch names
const companyIds = [...cMap.keys()];
const { data: nameRows } = await db
  .from("companies")
  .select("id, name, domain")
  .in("id", companyIds);

type NameRow = { id: string; name: string; domain: string | null };
const nameMap = new Map<string, NameRow>();
for (const r of (nameRows ?? []) as NameRow[]) nameMap.set(r.id, r);

console.log("\nCompanies with Gramscode signals:");
for (const [cid, cnt] of [...cMap.entries()].sort((a, b) => b[1] - a[1])) {
  const n = nameMap.get(cid);
  console.log(`  ${(n?.name ?? cid.slice(0, 8)).padEnd(40)} ${n?.domain ?? "(no domain)"}  — ${cnt} signals`);
}
