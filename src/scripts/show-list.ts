/**
 * Reads back a list + its companies from Supabase to verify what was stored.
 * Run: npx tsx src/scripts/show-list.ts <listId>
 */
import { getSupabaseAdmin } from "../db/supabase";

const listId = process.argv[2];
if (!listId) {
  console.error("usage: tsx src/scripts/show-list.ts <listId>");
  process.exit(1);
}

const db = getSupabaseAdmin();

const { data: list, error: listErr } = await db
  .from("lists")
  .select("id,name,environment,status,description,created_at")
  .eq("id", listId)
  .single();
if (listErr) throw new Error(listErr.message);

const { data: members, error: memErr } = await db
  .from("list_members")
  .select("company_id, companies(name, domain, status, city, region, country, source)")
  .eq("list_id", listId);
if (memErr) throw new Error(memErr.message);

console.log(`LIST: ${list.name}`);
console.log(`  id=${list.id}  env=${list.environment}  status=${list.status}`);
console.log(`  ${list.description ?? ""}\n`);
console.log(`MEMBERS (${members?.length ?? 0}):`);
for (const m of members ?? []) {
  const c = (m as { companies: Record<string, string> }).companies;
  console.log(`  - ${c.name} | ${c.domain ?? "(no domain)"} | ${[c.city, c.region, c.country].filter(Boolean).join(", ")} | status=${c.status}`);
}
