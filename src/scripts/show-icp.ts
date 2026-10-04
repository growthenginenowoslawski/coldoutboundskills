#!/usr/bin/env tsx
/**
 * Display ICP onboarding answers for any client.
 *
 * Usage:
 *   npx tsx src/scripts/show-icp.ts gramscode
 *   npx tsx src/scripts/show-icp.ts roci
 *   npx tsx src/scripts/show-icp.ts          <- lists all clients
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

async function listClients() {
  const { data, error } = await getSupabaseAdmin()
    .from("clients")
    .select("name,slug,website")
    .order("created_at");
  if (error) throw error;
  console.log("\nAll clients in Supabase:\n");
  for (const c of (data as any[])) {
    console.log(`  ${c.slug.padEnd(20)} ${c.name.padEnd(25)} ${c.website ?? ""}`);
  }
  console.log(`\nUsage: npx tsx src/scripts/show-icp.ts <slug>`);
}

async function showClient(slug: string) {
  const db = getSupabaseAdmin();

  const { data: client } = await db
    .from("clients")
    .select("id,name,website,slug")
    .eq("slug", slug)
    .maybeSingle();

  if (!client) {
    console.error(`No client found with slug "${slug}". Run without args to list all clients.`);
    process.exit(1);
  }

  const c = client as any;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`CLIENT: ${c.name}`);
  console.log(`Slug  : ${c.slug}`);
  console.log(`Web   : ${c.website ?? "(not set)"}`);
  console.log(`ID    : ${c.id}`);
  console.log(`${"=".repeat(60)}\n`);

  const { data: rows, error } = await db
    .from("icp_onboarding")
    .select("position,question_key,question,answer,answered_at")
    .eq("client_id", c.id)
    .order("position");

  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.log("No ICP onboarding answers found for this client.");
    return;
  }

  const answered = (rows as any[]).filter(r => r.answer);
  console.log(`ICP Onboarding: ${answered.length}/${rows.length} questions answered\n`);

  for (const r of rows as any[]) {
    const status = r.answer ? "OK" : "--";
    console.log(`[${status}] Q${r.position}: ${r.question}`);
    if (r.answer) {
      const wrapped = r.answer.match(/.{1,90}(\s|$)/g) ?? [r.answer];
      for (const line of wrapped) {
        console.log(`      ${line.trimEnd()}`);
      }
    } else {
      console.log(`      (not yet answered)`);
    }
    console.log();
  }
}

const slug = process.argv[2];
if (slug) {
  showClient(slug.toLowerCase()).catch(e => { console.error(e); process.exit(1); });
} else {
  listClients().catch(e => { console.error(e); process.exit(1); });
}
