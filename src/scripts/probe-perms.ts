/** Diagnostic: what can the secret key actually do? Read vs write, exact codes. */
import { getSupabaseAdmin } from "../db/supabase";

const db = getSupabaseAdmin();

for (const t of ["jobs", "companies", "lists"]) {
  const { data, error, status } = await db.from(t).select("id").limit(1);
  console.log(
    `SELECT ${t} -> ${error ? `ERR http=${status} code=${error.code}: ${error.message}` : `ok (${data?.length ?? 0} rows)`}`,
  );
}

const ins = await db
  .from("jobs")
  .insert({
    job_type: "connectivity_test",
    status: "pending",
    total_items: 0,
    processed_items: 0,
    successful_items: 0,
    failed_items: 0,
  })
  .select()
  .single();
console.log(
  `INSERT jobs -> ${ins.error ? `ERR code=${ins.error.code}: ${ins.error.message} | hint=${ins.error.hint ?? "-"} | details=${ins.error.details ?? "-"}` : "ok id=" + (ins.data as { id: string }).id}`,
);

// If the insert somehow succeeded, clean it up.
if (!ins.error && ins.data) {
  await db.from("jobs").delete().eq("id", (ins.data as { id: string }).id);
  console.log("cleaned up inserted probe row");
}
