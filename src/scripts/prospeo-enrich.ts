#!/usr/bin/env tsx
/**
 * Enrich contacts with real email addresses via Prospeo enrich-person endpoint.
 * Costs 1 enrich credit per contact. Reads LinkedIn URLs from Supabase,
 * fetches real emails, writes them back.
 *
 * Usage:
 *   npx tsx src/scripts/prospeo-enrich.ts --list="ROCI" --limit=50
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

const API_KEY = process.env.PROSPEO_API_KEY;
if (!API_KEY) { console.error("Missing env: PROSPEO_API_KEY"); process.exit(1); }

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string, def: string) => {
    const a = args.find(a => a.startsWith(`${flag}=`));
    return a ? a.split("=").slice(1).join("=") : def;
  };
  return {
    listSearch: get("--list", "ROCI"),
    limit: Number(get("--limit", "50")),
  };
}

async function enrichPerson(linkedinUrl: string): Promise<{ email: string; status: string } | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch("https://api.prospeo.io/enrich-person", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-KEY": API_KEY! },
      body: JSON.stringify({ data: { linkedin_url: linkedinUrl } }),
    });
    const data = await resp.json() as any;
    if (data.error) {
      if (data.error_code === "NO_MATCH") return null;
      if (data.error_code === "RATE_LIMIT") {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return null;
    }
    const email = data.person?.email;
    if (email?.revealed && email?.email) {
      return { email: email.email, status: email.status };
    }
    return null;
  }
  return null;
}

async function main() {
  const args = parseArgs();
  const db = getSupabaseAdmin();

  // Find the list
  const { data: lists } = await db
    .from("lists")
    .select("id,name")
    .ilike("name", `%${args.listSearch}%`)
    .order("created_at", { ascending: false });

  if (!lists || lists.length === 0) {
    console.error(`No list found matching "${args.listSearch}"`);
    process.exit(1);
  }
  const list = (lists as any[])[0];
  console.log(`\nList: ${list.name}`);

  // Get contact IDs from list_members
  const { data: members } = await db
    .from("list_members")
    .select("contact_id")
    .eq("list_id", list.id)
    .not("contact_id", "is", null);

  const contactIds = (members as any[]).map(m => m.contact_id);

  // Get contacts with LinkedIn URLs where email is unrevealed (stored as JSON) or null
  const { data: contacts } = await db
    .from("contacts")
    .select("id,full_name,linkedin_url,email")
    .in("id", contactIds)
    .not("linkedin_url", "is", null)
    .or('email.is.null,email.like.%"revealed":false%')
    .order("full_name")
    .limit(args.limit);

  if (!contacts || contacts.length === 0) {
    console.log("No contacts need enrichment (all have emails or no LinkedIn URLs).");
    return;
  }

  console.log(`Enriching ${contacts.length} contacts (limit: ${args.limit})...\n`);

  let enriched = 0, noMatch = 0, errors = 0;
  const creditsUsed: number[] = [];

  for (let i = 0; i < (contacts as any[]).length; i++) {
    const c = (contacts as any[])[i];
    process.stdout.write(`  [${i + 1}/${contacts.length}] ${(c.full_name || "").padEnd(30)}`);

    const result = await enrichPerson(c.linkedin_url);

    if (result) {
      const { error } = await db
        .from("contacts")
        .update({
          email: result.email,
          email_status: result.status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", c.id);

      if (error) {
        process.stdout.write(`ERROR saving: ${error.message}\n`);
        errors++;
      } else {
        process.stdout.write(`-> ${result.email}\n`);
        enriched++;
        creditsUsed.push(i + 1);
      }
    } else {
      process.stdout.write(`no match\n`);
      noMatch++;
    }

    // Respect rate limit: 1 req/sec
    if (i < (contacts as any[]).length - 1) {
      await new Promise(r => setTimeout(r, 1100));
    }
  }

  console.log(`\n${"=".repeat(55)}`);
  console.log(`Done.`);
  console.log(`  Emails revealed : ${enriched}`);
  console.log(`  No match        : ${noMatch}`);
  console.log(`  Errors          : ${errors}`);
  console.log(`  Credits used    : ${enriched} (no charge for no-match)`);
}

main().catch(e => { console.error(e); process.exit(1); });
