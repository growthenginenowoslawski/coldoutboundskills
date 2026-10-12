/** Enumerate TEST-environment lists with member counts. */
import { getSupabaseAdmin } from "../db/supabase";

const db = getSupabaseAdmin();
const { data: lists, error } = await db
  .from("lists")
  .select("id,name,description,created_at")
  .eq("environment", "test")
  .order("created_at");
if (error) throw new Error(error.message);

for (const l of lists ?? []) {
  const { count } = await db
    .from("list_members")
    .select("*", { count: "exact", head: true })
    .eq("list_id", l.id);
  console.log(`${l.id} | members=${count ?? 0} | ${l.name}`);
}
