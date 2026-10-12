#!/usr/bin/env tsx
/**
 * Show contacts for a named list.
 *
 * Usage:
 *   npx tsx src/scripts/show-contacts.ts                   <- list all lists
 *   npx tsx src/scripts/show-contacts.ts "ROCI ICP"        <- contacts in any list matching that name
 */

import { readFileSync } from "fs";
import { resolve, join } from "path";
import { getSupabaseAdmin } from "../db/supabase.js";

const envPath = resolve(join(import.meta.dirname ?? process.cwd(), "../../.."), ".env");
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
} catch {}

async function listAll() {
  const { data, error } = await getSupabaseAdmin()
    .from("lists")
    .select("id,name,environment,status,created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  console.log("\nAll lists in Supabase:\n");
  for (const l of (data as any[])) {
    console.log(`  ${l.name}`);
    console.log(`  ID: ${l.id}  |  ${l.environment}  |  ${l.status}  |  ${l.created_at?.slice(0, 10)}`);
    console.log();
  }
  console.log(`Usage: npx tsx src/scripts/show-contacts.ts "<part of list name>"`);
}

async function showContacts(search: string) {
  const db = getSupabaseAdmin();

  // Find matching list
  const { data: lists } = await db
    .from("lists")
    .select("id,name")
    .ilike("name", `%${search}%`)
    .order("created_at", { ascending: false });

  if (!lists || lists.length === 0) {
    console.error(`No list found matching "${search}". Run without args to see all lists.`);
    process.exit(1);
  }

  const list = (lists as any[])[0];
  console.log(`\nList: ${list.name}`);
  console.log(`ID  : ${list.id}\n`);

  // Get contacts linked to this list
  const { data: contacts, error } = await db
    .from("contacts")
    .select(`
      full_name, job_title, email, email_status, linkedin_url, status, source,
      company:companies(name, domain, industry, company_size, city, country)
    `)
    .eq("list_id", list.id)
    .order("created_at");

  // Fallback: query via contact_id in list_members
  if (error || !contacts || contacts.length === 0) {
    const { data: members } = await db
      .from("list_members")
      .select("contact_id")
      .eq("list_id", list.id)
      .not("contact_id", "is", null);

    if (!members || members.length === 0) {
      console.log("No contacts found for this list.");
      return;
    }

    const contactIds = (members as any[]).map(m => m.contact_id);
    const { data: rows, error: err2 } = await db
      .from("contacts")
      .select(`
        full_name, job_title, email, email_status, linkedin_url, status,
        company:companies(name, domain, industry, company_size, city, country)
      `)
      .in("id", contactIds)
      .order("full_name");

    if (err2) throw err2;
    printContacts(rows as any[], list.name);
    return;
  }

  printContacts(contacts as any[], list.name);
}

function printContacts(rows: any[], listName: string) {
  console.log(`${rows.length} contacts in "${listName}"\n`);
  console.log(
    "No.".padEnd(5) +
    "Name".padEnd(28) +
    "Title".padEnd(35) +
    "Company".padEnd(30) +
    "Email".padEnd(35) +
    "Location"
  );
  console.log("-".repeat(160));

  rows.forEach((r, i) => {
    const co = r.company || {};
    const email = r.email ? (r.email_status ? `${r.email} [${r.email_status}]` : r.email) : "(no email)";
    const loc = [co.city, co.country].filter(Boolean).join(", ");
    console.log(
      String(i + 1).padEnd(5) +
      (r.full_name || "").slice(0, 27).padEnd(28) +
      (r.job_title || "").slice(0, 34).padEnd(35) +
      (co.name || "").slice(0, 29).padEnd(30) +
      email.slice(0, 34).padEnd(35) +
      loc
    );
  });

  console.log(`\nTotal: ${rows.length} contacts`);
}

const search = process.argv.slice(2).join(" ");
if (search) {
  showContacts(search).catch(e => { console.error(e); process.exit(1); });
} else {
  listAll().catch(e => { console.error(e); process.exit(1); });
}
