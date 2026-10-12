import { existsSync } from "node:fs";
import { resolve } from "node:path";
if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}
import { getSupabaseAdmin } from "../src/db/supabase.js";
const db = getSupabaseAdmin();
const GRAMSCODE = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const ROCI_LIST = "8ac556af-e520-4aa5-bc03-5369f206ed33";

// Sample contact IDs from ROCI list
const { data: m } = await db.from("list_members").select("contact_id").eq("list_id", ROCI_LIST).limit(3);
console.log("sample member rows:", JSON.stringify(m));

// contact_intelligence columns
const { data: ci, error: cie } = await db.from("contact_intelligence").select("*").eq("client_id", GRAMSCODE).limit(1);
console.log("contact_intelligence cols:", ci ? Object.keys((ci as Record<string,unknown>[])[0] ?? {}).join(", ") : cie?.message);

// lead_magnets columns
const { data: lm, error: lme } = await db.from("lead_magnets").select("*").eq("client_id", GRAMSCODE).limit(1);
console.log("lead_magnets:", lm ? ((lm as unknown[]).length === 0 ? "no rows (0 lead magnets)" : Object.keys((lm as Record<string,unknown>[])[0]).join(", ")) : lme?.message);

// contacts via direct contact IDs from ROCI list
const { data: allM } = await db.from("list_members").select("contact_id").eq("list_id", ROCI_LIST);
const contactIds = ((allM ?? []) as { contact_id: string | null }[]).filter(r => r.contact_id).map(r => r.contact_id as string);
console.log("total direct contact IDs:", contactIds.length);

// sample contacts
if (contactIds.length > 0) {
  const { data: cons, error: cone } = await db.from("contacts").select("id, job_title, email_status, email, company_id, status").in("id", contactIds.slice(0, 5));
  console.log("sample contacts:", JSON.stringify(cons ?? cone?.message));
}
