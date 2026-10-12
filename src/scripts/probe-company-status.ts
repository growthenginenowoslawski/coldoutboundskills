/**
 * Discovers which values companies.status accepts (there's a CHECK constraint
 * we can't read via the API). Inserts a throwaway row per candidate and deletes
 * it immediately. No Apify spend, no schema change.
 */
import { getSupabaseAdmin } from "../db/supabase";

const db = getSupabaseAdmin();
const candidates = [
  "new",
  "active",
  "sourced",
  "enriched",
  "qualified",
  "disqualified",
  "rejected",
  "contacted",
  "pending",
  "review",
  "in_review",
  "approved",
  "lead",
  "prospect",
  "researching",
  "draft",
  "uncontacted",
  "to_enrich",
  "raw",
];

const accepted: string[] = [];
for (const status of candidates) {
  const { data, error } = await db
    .from("companies")
    .insert({ name: "__status_probe__", status })
    .select("id")
    .single();
  if (error) {
    console.log(`  ${status}: rejected`);
  } else {
    accepted.push(status);
    console.log(`  ${status}: ACCEPTED`);
    await db.from("companies").delete().eq("id", (data as { id: string }).id);
  }
}
console.log(`\nAccepted companies.status values: ${accepted.join(", ") || "(none)"}`);
