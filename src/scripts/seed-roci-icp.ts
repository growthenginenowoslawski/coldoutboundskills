#!/usr/bin/env tsx
/**
 * Seeds ROCI Agency's ICP onboarding into Supabase.
 * Creates the client row + all 12 icp_onboarding rows in one run.
 * Safe to re-run — upserts on (client_id, question_key).
 */

import { readFileSync } from "fs";
import { resolve, join } from "path";
import { getSupabaseAdmin } from "../db/supabase.js";

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

const ICP = [
  {
    position: 1,
    question_key: "q1_what_do_you_sell",
    question: "What do you sell?",
    answer:
      "Done-for-you outbound lead generation and pipeline development for agencies and brands. ROCI handles the entire new business outreach process — data sourcing from a 400M+ GDPR-compliant contact database, personalised email/SMS/social/direct mail campaigns, deliverability tech (~90% inbox placement rate), campaign management, and follow-up — so agency clients receive warm leads without doing BD themselves. Founded 2020, London-based.",
  },
  {
    position: 2,
    question_key: "q2_best_customer",
    question: "Who is your best customer?",
    answer:
      "Small-to-mid UK creative and marketing agencies (5–50 staff) that are referral-dependent with unpredictable pipelines. Typically founder-led agencies where the owner is doing business development alongside delivery, wants to scale but cannot afford a full-time BD team, and is losing time to networking events with low ROI. They know outbound works but do not know how to run it consistently.",
  },
  {
    position: 3,
    question_key: "q3_buying_title",
    question: "What job title buys this?",
    answer:
      "Founder, Co-Founder, Owner, CEO, Managing Director (MD), Head of New Business, Business Development Director. In owner-operator studios, the Creative Director often holds the BD remit and is the decision-maker. Primary target: Founder + MD at agencies where no separate BD function exists.",
  },
  {
    position: 4,
    question_key: "q4_headcount",
    question: "Target headcount range?",
    answer:
      "5–50 employees. Sweet spot is 10–30: large enough to have delivery capacity and budget, too small to have a dedicated BD team. Under 5 = usually a sole trader with no budget. Over 50 = likely has in-house BD or a preferred partner. ROCI themselves reference 'over 10,000 agencies in the UK' as their total addressable market.",
  },
  {
    position: 5,
    question_key: "q5_industries",
    question: "Which industries are IN / OUT?",
    answer:
      "IN: Creative agencies, digital marketing agencies, branding agencies, advertising agencies, PR agencies, web design and development agencies, video and content production companies, integrated agencies, social media agencies, SEO and performance marketing agencies. OUT: B2C businesses, e-commerce brands, SaaS and tech companies, management consultancies (non-agency), enterprises with 200+ staff, freelancers and sole traders (under 5 staff).",
  },
  {
    position: 6,
    question_key: "q6_geography",
    question: "Geography?",
    answer:
      "United Kingdom (primary). London has the highest density of target agencies but strong secondary markets in Manchester, Leeds, Birmingham, Bristol, Edinburgh, and Glasgow. English-speaking stretch markets: Ireland, Australia, Canada. Exclude non-English-speaking markets. All outreach must be GDPR-compliant as prospects are UK-based.",
  },
  {
    position: 7,
    question_key: "q7_buying_triggers",
    question: "Any buying triggers to personalise on?",
    answer:
      "1. Recently lost a major retainer client — pipeline suddenly dropped. 2. Just hired new staff — need revenue to cover headcount. 3. Referrals have dried up in the past quarter. 4. Founder attending networking events with no pipeline ROI. 5. Transitioning from project-based to retainer model. 6. New hire in a BD or growth role (signal: LinkedIn job post for 'Head of New Business'). 7. Recent rebrand or repositioning — trying to reach new types of clients.",
  },
  {
    position: 8,
    question_key: "q8_exclusions",
    question: "Any domains/companies to exclude?",
    answer:
      "roci.co.uk (own domain). Exclude direct competitors who also offer outbound lead generation as a service to agencies — they know the product and are unlikely buyers. Exclude agencies with 200+ staff (have in-house BD). Exclude any current or former ROCI clients. Exclude one-person freelancers (no budget). Exclude B2C-only agencies (retail, FMCG-focused — not the right service fit).",
  },
  {
    position: 9,
    question_key: "q9_offer_cta",
    question: "What's your offer / CTA?",
    answer:
      "Primary CTA: Book a discovery call to discuss pipeline goals (consultation-first, no pricing on site). Recommended front-end offer to lower the first-ask barrier: a free 'Agency Pipeline Audit' — ROCI reviews the prospect's current new business setup, identifies 3 gaps, and delivers a 1-page report within 24 hours. Demonstrates competence, creates reciprocity, requires no commitment. Secondary option: offer a sample 3-step outreach sequence personalised to their agency niche.",
  },
  {
    position: 10,
    question_key: "q10_lead_magnet",
    question: "What's your lead magnet?",
    answer:
      "Not currently stated on the ROCI website. Recommended: (1) Free Agency New Business Audit — review their current outbound or lack thereof, identify 3 specific gaps, deliver a 1-page PDF within 24 hours. Costs ~30 minutes of ROCI time, demonstrates capability, low barrier. (2) Alternative: a benchmarking report showing average reply rates, pipeline velocity, and win rates for agencies their size and vertical — data-led and shareable. Chosen magnet should be selected before copy is written.",
  },
  {
    position: 11,
    question_key: "q11_tone",
    question: "What tone — casual or formal?",
    answer:
      "Conversational and professional — not corporate, not salesy. ROCI's own brand language emphasises 'warm and natural first impression,' 'treating people with decency,' and making outreach that stands out in a crowded inbox. Copy should feel peer-to-peer: one agency professional talking directly to another. Short sentences, plain English, no jargon. Think: smart and direct, never pushy.",
  },
  {
    position: 12,
    question_key: "q12_legal_constraints",
    question: "Any legal/banned word constraints?",
    answer:
      "UK GDPR compliance required on all outreach — reference to GDPR-compliant data sourcing is a positive signal for UK prospects and should be included where natural. Avoid: 'guaranteed results,' 'unlimited leads,' '100% inbox placement' (overstatement of outcomes). Avoid aggressive or high-pressure language — contradicts brand positioning. Avoid calling it 'cold email' — use 'outreach' or 'direct outreach.' Avoid classic spam trigger words: 'free money,' 'click here,' 'act now,' 'limited time offer,' 'no obligation.'",
  },
];

async function main() {
  const db = getSupabaseAdmin();

  // 1. Find or create client
  console.log("Looking up ROCI client...");
  let { data: existing } = await db.from("clients").select("id,name").eq("slug", "roci").maybeSingle();

  let clientId: string;
  if (existing) {
    clientId = (existing as { id: string }).id;
    console.log(`✓ Client already exists: ${clientId}`);
  } else {
    const { data, error } = await db
      .from("clients")
      .insert({ name: "ROCI Agency", website: "https://www.roci.co.uk", slug: "roci" })
      .select("id")
      .single();
    if (error) throw new Error(`Create client failed: ${error.message}`);
    clientId = (data as { id: string }).id;
    console.log(`✓ Created client: ${clientId}`);
  }

  // 2. Upsert all 12 ICP answers
  console.log("\nSeeding ICP onboarding answers...\n");
  for (const q of ICP) {
    const { error } = await db.from("icp_onboarding").upsert(
      {
        client_id: clientId,
        position: q.position,
        question_key: q.question_key,
        question: q.question,
        answer: q.answer,
        answered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,question_key" },
    );
    if (error) throw new Error(`Upsert Q${q.position} failed: ${error.message}`);
    console.log(`  Q${q.position} ✓  ${q.question}`);
  }

  console.log(`\n${"=".repeat(55)}`);
  console.log(`ROCI ICP onboarding complete.`);
  console.log(`Client ID : ${clientId}`);
  console.log(`Slug      : roci`);
  console.log(`Questions : ${ICP.length} / 12`);
  console.log(`\nView in Supabase → Table Editor → icp_onboarding`);
  console.log(`Filter by: client_id = ${clientId}`);
}

main().catch(e => { console.error(e); process.exit(1); });
