/**
 * Shows clients and their ICP onboarding Q&A.
 * Run: npx tsx src/scripts/show-onboarding.ts [slug]
 */
import { getSupabaseAdmin } from "../db/supabase";

const slug = process.argv[2];
const db = getSupabaseAdmin();

let q = db.from("clients").select("id,name,website,slug").order("created_at");
if (slug) q = q.eq("slug", slug);
const { data: clients, error } = await q;
if (error) throw new Error(error.message);

for (const c of clients ?? []) {
  console.log(`\n▸ ${c.name}  (${c.website ?? "no site"})  [${c.slug}]`);
  const { data: rows, error: rErr } = await db
    .from("icp_onboarding")
    .select("position,question_key,question,answer")
    .eq("client_id", c.id)
    .order("position");
  if (rErr) throw new Error(rErr.message);
  for (const r of rows ?? []) {
    console.log(`  ${String(r.position).padStart(2)}. [${r.question_key}] ${r.answer ? "✓" : "·"}`);
    console.log(`      Q: ${r.question}`);
    if (r.answer) console.log(`      A: ${r.answer}`);
  }
  console.log(`  (${rows?.length ?? 0} questions)`);
}
