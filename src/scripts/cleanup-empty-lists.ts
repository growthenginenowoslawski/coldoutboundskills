/**
 * Deletes the given lists ONLY if they have zero members (safety guard).
 * Run: npx tsx src/scripts/cleanup-empty-lists.ts <listId> [<listId> ...]
 */
import { getSupabaseAdmin } from "../db/supabase";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: cleanup-empty-lists.ts <listId> [...]");
  process.exit(1);
}

const db = getSupabaseAdmin();
for (const id of ids) {
  const { count, error: cErr } = await db
    .from("list_members")
    .select("*", { count: "exact", head: true })
    .eq("list_id", id);
  if (cErr) {
    console.log(`ERR ${id}: ${cErr.message}`);
    continue;
  }
  if ((count ?? 0) > 0) {
    console.log(`SKIP ${id} — has ${count} member(s), not deleting`);
    continue;
  }
  const { error } = await db.from("lists").delete().eq("id", id);
  console.log(error ? `ERR ${id}: ${error.message}` : `deleted empty list ${id}`);
}
