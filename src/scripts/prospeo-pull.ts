#!/usr/bin/env tsx
/**
 * Pull contacts from Prospeo and store them (+ their companies) in Supabase.
 *
 * Usage:
 *   npx tsx src/scripts/prospeo-pull.ts --pages=8 --list-name="ROCI ICP - UK Agency Founders Aug 2026"
 *
 * Each Prospeo page = 25 contacts = 1 credit. 8 pages = 200 contacts = 8 credits.
 */

import { readFileSync } from "fs";
import { resolve, join } from "path";
import { getSupabaseAdmin } from "../db/supabase.js";
import { findExistingCompanyId, toCompanyRow } from "../db/companies.js";

// Load .env from repo root
const envPath = resolve(join(import.meta.dirname ?? process.cwd(), "../../.."), ".env");
try {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const PROSPEO_API_KEY = process.env.PROSPEO_API_KEY;
if (!PROSPEO_API_KEY) { console.error("Missing env: PROSPEO_API_KEY"); process.exit(1); }

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const a = args.find(a => a.startsWith(`${flag}=`));
    return a ? a.split("=").slice(1).join("=") : def;
  };
  return {
    pages: Number(get("--pages", "8")),
    listName: get("--list-name", `Prospeo Pull ${new Date().toISOString().slice(0, 10)}`),
  };
}

const FILTERS = {
  person_location_search: { include: ["United Kingdom #GB"] },
  person_job_title: {
    include: ["Founder", "Co-Founder", "Owner", "CEO", "Managing Director", "MD",
      "Head of New Business", "Business Development Director", "Director"],
    match_only_exact_job_titles: false,
  },
  company_headcount_custom: { min: 5, max: 50 },
  company_industry: { include: ["Advertising Services", "Marketing Services", "Design Services"] },
  person_contact_details: { email: ["VERIFIED"] },
};

async function fetchPage(page: number): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch("https://api.prospeo.io/search-person", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KEY": PROSPEO_API_KEY! },
      body: JSON.stringify({ page, filters: FILTERS }),
    });
    if (resp.status === 429) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const data = await resp.json();
    if (data.error) throw new Error(`Prospeo error page ${page}: ${JSON.stringify(data)}`);
    return data;
  }
  throw new Error(`Failed page ${page} after retries`);
}

async function upsertCompany(company: any): Promise<string> {
  const domain = company.domain?.toLowerCase().replace(/^www\./, "") || null;
  const rec = {
    name: company.name || "Unknown",
    domain: domain ?? undefined,
    website: domain ? `https://${domain}` : undefined,
    industry: company.industry ?? undefined,
    employeeCount: company.headcount ?? undefined,
    city: company.location?.city ?? undefined,
    region: company.location?.state ?? undefined,
    country: company.location?.country ?? undefined,
    source: "prospeo",
    fetchedAt: new Date().toISOString(),
  };

  const existing = await findExistingCompanyId(rec);
  if (existing) return existing;

  const { data, error } = await getSupabaseAdmin()
    .from("companies")
    .insert(toCompanyRow(rec, "review"))
    .select("id")
    .single();
  if (error) throw new Error(`Insert company "${rec.name}" failed: ${error.message}`);
  return (data as { id: string }).id;
}

async function upsertContact(person: any, companyId: string): Promise<"inserted" | "existing"> {
  const db = getSupabaseAdmin();

  // Check by linkedin_url first, then by email
  if (person.linkedin_url) {
    const { data } = await db.from("contacts").select("id").eq("linkedin_url", person.linkedin_url).maybeSingle();
    if (data) return "existing";
  }
  if (person.email) {
    const { data } = await db.from("contacts").select("id").eq("email", person.email).maybeSingle();
    if (data) return "existing";
  }

  const nameParts = (person.full_name || "").split(" ");
  const { error } = await db.from("contacts").insert({
    company_id: companyId,
    first_name: person.first_name || nameParts[0] || null,
    last_name: person.last_name || nameParts.slice(1).join(" ") || null,
    full_name: person.full_name || null,
    job_title: person.current_job_title || null,
    linkedin_url: person.linkedin_url || null,
    email: person.email || null,
    email_status: person.email_status || null,
    status: "review",
    source: "prospeo",
  });
  if (error) throw new Error(`Insert contact "${person.full_name}" failed: ${error.message}`);
  return "inserted";
}

async function createList(name: string): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("lists")
    .insert({ name, environment: "production", status: "active" })
    .select("id")
    .single();
  if (error) throw new Error(`createList failed: ${error.message}`);
  return (data as { id: string }).id;
}

async function linkContactToList(listId: string, contactId: string) {
  const { error } = await getSupabaseAdmin()
    .from("list_members")
    .insert({ list_id: listId, contact_id: contactId });
  if (error && !error.message.includes("duplicate")) {
    throw new Error(`list_members insert failed: ${error.message}`);
  }
}

async function main() {
  const args = parseArgs();
  console.log(`\nProspeo Pull — ${args.pages} pages (${args.pages * 25} contacts max)`);
  console.log(`List: "${args.listName}"\n`);

  const listId = await createList(args.listName);
  console.log(`Created list: ${listId}`);

  let inserted = 0, existing = 0, errors = 0;

  for (let page = 1; page <= args.pages; page++) {
    console.log(`\nPage ${page}/${args.pages}...`);
    const data = await fetchPage(page);
    const results = data.results || [];

    if (page === 1) {
      console.log(`Universe: ${data.pagination?.total_count?.toLocaleString()} contacts total`);
    }

    for (const r of results) {
      const person = r.person || {};
      const company = r.company || {};
      try {
        const companyId = await upsertCompany(company);
        const result = await upsertContact(person, companyId);

        if (result === "inserted") {
          // link to list — need contact id
          const { data: contactRow } = await getSupabaseAdmin()
            .from("contacts")
            .select("id")
            .eq("company_id", companyId)
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          if (contactRow) {
            await linkContactToList(listId, (contactRow as { id: string }).id);
          }
          inserted++;
          console.log(`  ✓ ${person.full_name} | ${person.current_job_title} | ${company.name}`);
        } else {
          existing++;
          console.log(`  ~ ${person.full_name} (already in Supabase)`);
        }
      } catch (err) {
        errors++;
        console.error(`  ✗ ${person.full_name}: ${String(err).slice(0, 80)}`);
      }
    }

    if (results.length < 25) {
      console.log("\nReached end of results.");
      break;
    }

    if (page < args.pages) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Done. Inserted: ${inserted} | Already existed: ${existing} | Errors: ${errors}`);
  console.log(`List ID: ${listId}`);
  console.log(`Credits used: ${args.pages}`);
}

main().catch(e => { console.error(e); process.exit(1); });
