/**
 * Stage 26 — ICP and Campaign Strategy Data Collection
 *
 * READ-ONLY. Zero writes. No emails. No outbound. No DB mutations.
 *
 * Collects all evidence needed to produce a reviewable ICP and
 * campaign strategy specification for Gramscode.
 *
 * Run: npx tsx scripts/stage26-icp-data-collection.ts
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";

const GRAMSCODE   = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const ROCI_LIST   = "8ac556af-e520-4aa5-bc03-5369f206ed33";

const db = getSupabaseAdmin();

function h(t: string): void {
  console.log(`\n${"═".repeat(76)}\n  ${t}\n${"═".repeat(76)}`);
}
function sub(t: string): void {
  console.log(`\n── ${t} ${"─".repeat(Math.max(0, 68 - t.length))}`);
}
function row(label: string, value: unknown): void {
  const v = value === null || value === undefined ? "(NULL)" : String(value);
  console.log(`  ${label.padEnd(44)} ${v}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// A — CLIENTS
// ─────────────────────────────────────────────────────────────────────────────

h("A — CLIENT");

const { data: client, error: clientErr } = await db
  .from("clients")
  .select("id, name, slug, website, created_at")
  .eq("id", GRAMSCODE)
  .maybeSingle();

if (clientErr || !client) {
  console.log("  ERROR fetching client:", clientErr?.message ?? "not found");
  process.exit(1);
}

const c = client as { id: string; name: string; slug: string; website: string | null; created_at: string };
row("id",         c.id);
row("name",       c.name);
row("slug",       c.slug);
row("website",    c.website);
row("created_at", c.created_at);

// ─────────────────────────────────────────────────────────────────────────────
// B — ICP ONBOARDING (all 12 questions)
// ─────────────────────────────────────────────────────────────────────────────

h("B — ICP ONBOARDING (12 questions)");

const { data: icpRows, error: icpErr } = await db
  .from("icp_onboarding")
  .select("position, question_key, question, answer, answered_at")
  .eq("client_id", GRAMSCODE)
  .order("position");

if (icpErr) {
  console.log("  ERROR fetching ICP:", icpErr.message);
} else {
  type IcpRow = { position: number; question_key: string; question: string; answer: string | null; answered_at: string | null };
  const rows = (icpRows ?? []) as IcpRow[];
  let answered = 0;
  console.log("");
  for (const r of rows) {
    const status = r.answer ? "ANSWERED" : "NULL    ";
    if (r.answer) answered++;
    console.log(`  [${String(r.position).padStart(2)}] ${status}  ${r.question_key.padEnd(24)}  ${r.answer ?? "(no answer)"}`);
  }
  console.log(`\n  Total questions: ${rows.length}   Answered: ${answered}   Unanswered: ${rows.length - answered}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// C — CAMPAIGN PLANS
// ─────────────────────────────────────────────────────────────────────────────

h("C — CAMPAIGN PLANS");

const { data: plans, error: planErr } = await db
  .from("campaign_plans")
  .select("*")
  .eq("client_id", GRAMSCODE)
  .order("generated_at", { ascending: false });

if (planErr) {
  console.log("  ERROR fetching plans:", planErr.message);
} else if (!plans || (plans as unknown[]).length === 0) {
  console.log("  No campaign_plans rows found for Gramscode");
} else {
  type PlanRow = { id: string; business_summary: string | null; icp_summary: string | null; offer_summary: string | null; top_campaign_names: string[] | null; next_steps: string | null; status: string; generated_at: string };
  for (const p of (plans as PlanRow[])) {
    row("id",                   p.id);
    row("status",               p.status);
    row("generated_at",         p.generated_at);
    row("business_summary",     p.business_summary);
    row("icp_summary",          p.icp_summary);
    row("offer_summary",        p.offer_summary);
    row("top_campaign_names",   p.top_campaign_names ? JSON.stringify(p.top_campaign_names) : null);
    row("next_steps",           p.next_steps);
    console.log("");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D — LEAD MAGNETS
// ─────────────────────────────────────────────────────────────────────────────

h("D — LEAD MAGNETS");

const { data: magnets, error: magErr } = await db
  .from("lead_magnets")
  .select("id, name, archetype, description, status, rank, created_at")
  .eq("client_id", GRAMSCODE)
  .order("rank", { nullsFirst: false });

if (magErr) {
  console.log("  ERROR:", magErr.message);
} else if (!magnets || (magnets as unknown[]).length === 0) {
  console.log("  No lead_magnets rows found for Gramscode");
} else {
  type MagRow = { id: string; name: string | null; archetype: string | null; description: string | null; status: string; rank: number | null; created_at: string };
  for (const m of (magnets as MagRow[])) {
    console.log(`  [rank=${m.rank ?? "null"} status=${m.status}]`);
    row("  name",       m.name);
    row("  archetype",  m.archetype);
    row("  description", m.description?.substring(0, 120));
    console.log("");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// E — CAMPAIGN STRATEGIES
// ─────────────────────────────────────────────────────────────────────────────

h("E — CAMPAIGN STRATEGIES");

const { data: strategies, error: strErr } = await db
  .from("campaign_strategies")
  .select("id, campaign_name, targeting_level, list_filters, ai_strategy, value_proposition, campaign_overview, is_no_ai, is_front_end_offer, rank, status, notes, created_at")
  .eq("client_id", GRAMSCODE)
  .order("rank", { nullsFirst: false })
  .order("created_at");

if (strErr) {
  console.log("  ERROR:", strErr.message);
} else if (!strategies || (strategies as unknown[]).length === 0) {
  console.log("  No campaign_strategies rows found for Gramscode");
} else {
  type StrRow = { id: string; campaign_name: string; targeting_level: string | null; list_filters: string | null; ai_strategy: string | null; value_proposition: string | null; campaign_overview: string | null; is_no_ai: boolean; is_front_end_offer: boolean; rank: number | null; status: string; notes: string | null; created_at: string };
  console.log(`  Total strategies: ${(strategies as unknown[]).length}`);
  for (const s of (strategies as StrRow[])) {
    console.log(`\n  ── [rank=${s.rank ?? "null"} status=${s.status} level=${s.targeting_level ?? "null"}]`);
    row("  id",               s.id);
    row("  campaign_name",    s.campaign_name);
    row("  value_proposition",s.value_proposition?.substring(0, 100));
    row("  campaign_overview",s.campaign_overview?.substring(0, 120));
    row("  list_filters",     s.list_filters);
    row("  ai_strategy",      s.ai_strategy?.substring(0, 100));
    row("  is_no_ai",         s.is_no_ai);
    row("  is_front_end_offer", s.is_front_end_offer);
    row("  notes",            s.notes);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F — CAMPAIGNS
// ─────────────────────────────────────────────────────────────────────────────

h("F — CAMPAIGNS");

const { data: campaigns, error: campErr } = await db
  .from("campaigns")
  .select("id, name, description, platform, platform_campaign_id, campaign_strategy_id, list_id, status, daily_send_limit, start_date, end_date, created_at")
  .eq("client_id", GRAMSCODE)
  .order("created_at", { ascending: false });

if (campErr) {
  console.log("  ERROR:", campErr.message);
} else if (!campaigns || (campaigns as unknown[]).length === 0) {
  console.log("  No campaigns found for Gramscode");
} else {
  type CampRow = { id: string; name: string; description: string | null; platform: string; platform_campaign_id: string | null; campaign_strategy_id: string | null; list_id: string | null; status: string; daily_send_limit: number | null; start_date: string | null; end_date: string | null; created_at: string };
  for (const camp of (campaigns as CampRow[])) {
    row("id",                   camp.id);
    row("name",                 camp.name);
    row("description",          camp.description);
    row("platform",             camp.platform);
    row("platform_campaign_id", camp.platform_campaign_id);
    row("campaign_strategy_id", camp.campaign_strategy_id);
    row("list_id",              camp.list_id);
    row("status",               camp.status);
    row("daily_send_limit",     camp.daily_send_limit);
    row("start_date",           camp.start_date);
    row("created_at",           camp.created_at);
    console.log("");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G — ROCI LIST DETAILS
// ─────────────────────────────────────────────────────────────────────────────

h("G — ROCI LIST DETAILS");

const { data: listRow, error: listErr } = await db
  .from("lists")
  .select("*")
  .eq("id", ROCI_LIST)
  .maybeSingle();

if (listErr || !listRow) {
  console.log("  ERROR fetching list:", listErr?.message ?? "not found");
} else {
  type LRow = Record<string, unknown>;
  const l = listRow as LRow;
  for (const [k, v] of Object.entries(l)) {
    row(k, v);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// H — ROCI LIST MEMBERS
// ─────────────────────────────────────────────────────────────────────────────

h("H — ROCI LIST MEMBERS");

const { data: members, error: memErr } = await db
  .from("list_members")
  .select("company_id, contact_id")
  .eq("list_id", ROCI_LIST);

if (memErr) {
  console.log("  ERROR:", memErr.message);
  process.exit(1);
}

type MemberRow = { company_id: string | null; contact_id: string | null };
const memberRows = (members ?? []) as MemberRow[];
const companyIds = [...new Set(memberRows.filter(r => r.company_id).map(r => r.company_id as string))];
const directContactIds = [...new Set(memberRows.filter(r => r.contact_id).map(r => r.contact_id as string))];

row("Total list_members rows",   memberRows.length);
row("Unique company members",    companyIds.length);
row("Direct contact members",    directContactIds.length);

// ─────────────────────────────────────────────────────────────────────────────
// I — COMPANY DISTRIBUTION (from ROCI list)
// ─────────────────────────────────────────────────────────────────────────────

h("I — COMPANY DISTRIBUTION");

if (companyIds.length === 0) {
  console.log("  No company members in ROCI list");
} else {
  // Fetch in batches of 400 to avoid URL length limits
  const BATCH = 400;
  type CompRow = { id: string; name: string; domain: string | null; industry: string | null; company_size: string | null; country: string | null; city: string | null; icp_score: number | null; status: string };
  const allCompanies: CompRow[] = [];

  for (let i = 0; i < companyIds.length; i += BATCH) {
    const batch = companyIds.slice(i, i + BATCH);
    const { data: cos, error: cosErr } = await db
      .from("companies")
      .select("id, name, domain, industry, company_size, country, city, icp_score, status")
      .in("id", batch);
    if (cosErr) { console.log("  ERROR fetching companies:", cosErr.message); break; }
    allCompanies.push(...((cos ?? []) as CompRow[]));
  }

  row("Companies fetched",  allCompanies.length);

  // Industry distribution
  sub("Industry distribution");
  const byIndustry = new Map<string, number>();
  for (const co of allCompanies) {
    const k = co.industry ?? "(null)";
    byIndustry.set(k, (byIndustry.get(k) ?? 0) + 1);
  }
  const sortedIndustries = [...byIndustry.entries()].sort((a, b) => b[1] - a[1]);
  for (const [industry, count] of sortedIndustries.slice(0, 20)) {
    console.log(`  ${String(count).padStart(5)}  ${industry}`);
  }
  if (sortedIndustries.length > 20) console.log(`  ... (${sortedIndustries.length - 20} more)`);

  // Company size distribution
  sub("Company size distribution");
  const bySize = new Map<string, number>();
  for (const co of allCompanies) {
    const k = co.company_size ?? "(null)";
    bySize.set(k, (bySize.get(k) ?? 0) + 1);
  }
  const sortedSizes = [...bySize.entries()].sort((a, b) => b[1] - a[1]);
  for (const [size, count] of sortedSizes.slice(0, 20)) {
    console.log(`  ${String(count).padStart(5)}  ${size}`);
  }

  // Country distribution
  sub("Country distribution");
  const byCountry = new Map<string, number>();
  for (const co of allCompanies) {
    const k = co.country ?? "(null)";
    byCountry.set(k, (byCountry.get(k) ?? 0) + 1);
  }
  const sortedCountries = [...byCountry.entries()].sort((a, b) => b[1] - a[1]);
  for (const [country, count] of sortedCountries.slice(0, 15)) {
    console.log(`  ${String(count).padStart(5)}  ${country}`);
  }
  if (sortedCountries.length > 15) console.log(`  ... (${sortedCountries.length - 15} more)`);

  // ICP score distribution
  sub("ICP score distribution");
  const withScore = allCompanies.filter(co => co.icp_score !== null);
  const noScore   = allCompanies.filter(co => co.icp_score === null);
  row("Companies with icp_score",    withScore.length);
  row("Companies without icp_score", noScore.length);
  if (withScore.length > 0) {
    const scores = withScore.map(co => co.icp_score as number);
    const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    row("icp_score avg", avg);
    row("icp_score min", min);
    row("icp_score max", max);
  }

  // Status distribution
  sub("Company status distribution");
  const byStatus = new Map<string, number>();
  for (const co of allCompanies) {
    byStatus.set(co.status, (byStatus.get(co.status) ?? 0) + 1);
  }
  for (const [st, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${st}`);
  }

  // Sample company names
  sub("Sample company names (first 20)");
  for (const co of allCompanies.slice(0, 20)) {
    console.log(`  ${co.name.padEnd(50)} ${co.domain ?? "(no domain)"}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// J — CONTACT DISTRIBUTION (via company_id from ROCI list)
// ─────────────────────────────────────────────────────────────────────────────

h("J — CONTACT DISTRIBUTION");

if (companyIds.length === 0) {
  console.log("  No company members — skipping contact query");
} else {
  const BATCH = 400;
  type ConRow = { id: string; job_title: string | null; email_status: string | null; email: string | null; status: string; company_id: string };
  const allContacts: ConRow[] = [];

  for (let i = 0; i < companyIds.length; i += BATCH) {
    const batch = companyIds.slice(i, i + BATCH);
    const { data: cons, error: conErr } = await db
      .from("contacts")
      .select("id, job_title, email_status, status, company_id, email")
      .in("company_id", batch);
    if (conErr) { console.log("  ERROR fetching contacts:", conErr.message); break; }
    allContacts.push(...((cons ?? []) as ConRow[]));
  }

  row("Total contacts via ROCI companies", allContacts.length);
  row("Contacts with email",               allContacts.filter(c => c.email).length);
  row("Contacts VERIFIED email_status",    allContacts.filter(c => c.email_status === "VERIFIED").length);
  row("Contacts null email",               allContacts.filter(c => !c.email).length);

  // Job title distribution
  sub("Job title distribution (top 30)");
  const byTitle = new Map<string, number>();
  for (const c of allContacts) {
    const k = c.job_title ?? "(null)";
    byTitle.set(k, (byTitle.get(k) ?? 0) + 1);
  }
  const sortedTitles = [...byTitle.entries()].sort((a, b) => b[1] - a[1]);
  for (const [title, count] of sortedTitles.slice(0, 30)) {
    console.log(`  ${String(count).padStart(5)}  ${title}`);
  }
  if (sortedTitles.length > 30) console.log(`  ... (${sortedTitles.length - 30} more unique titles)`);

  // Function inference (title keyword analysis)
  sub("Inferred function keywords");
  const functionKeywords: Record<string, RegExp> = {
    "SALES":       /\b(sales|account|revenue|business dev|bdr|sdr|ae |account exec)\b/i,
    "MARKETING":   /\b(marketing|demand|growth|brand|content|seo|cmo)\b/i,
    "ENGINEERING": /\b(engineer|developer|architect|devops|cto|tech lead|software)\b/i,
    "OPERATIONS":  /\b(operations|ops|coo|chief of staff|director of ops)\b/i,
    "FINANCE":     /\b(finance|cfo|financial|accounting|controller)\b/i,
    "HR":          /\b(hr|people|talent|recruit|human resources)\b/i,
    "FOUNDER":     /\b(founder|ceo|co-founder|owner|president|managing director|md)\b/i,
    "PRODUCT":     /\b(product|cpo|head of product)\b/i,
    "CUSTOMER":    /\b(customer|success|support|client)\b/i,
  };
  const funcCount: Record<string, number> = {};
  for (const c of allContacts) {
    const title = c.job_title ?? "";
    for (const [func, re] of Object.entries(functionKeywords)) {
      if (re.test(title)) {
        funcCount[func] = (funcCount[func] ?? 0) + 1;
        break;
      }
    }
  }
  const sortedFuncs = Object.entries(funcCount).sort((a, b) => b[1] - a[1]);
  for (const [func, count] of sortedFuncs) {
    const pct = ((count / allContacts.length) * 100).toFixed(1);
    console.log(`  ${String(count).padStart(5)}  ${func.padEnd(20)} (${pct}%)`);
  }

  // Seniority inference
  sub("Inferred seniority keywords");
  const seniorityKeywords: Record<string, RegExp> = {
    "C_SUITE":  /\b(ceo|cto|cfo|coo|cmo|cpo|ciso|c-suite|chief)\b/i,
    "FOUNDER":  /\b(founder|co-founder|owner|president|managing partner|managing director|md\b)/i,
    "VP":       /\b(vp|vice president|v\.p\.)\b/i,
    "DIRECTOR": /\b(director|head of|head,)\b/i,
    "MANAGER":  /\b(manager|lead |senior manager|account manager)\b/i,
    "SENIOR_IC":/\b(senior |principal |staff |sr\.)\b/i,
    "IC":       /\b(specialist|analyst|coordinator|representative|engineer|developer|associate)\b/i,
  };
  const senCount: Record<string, number> = {};
  for (const c of allContacts) {
    const title = c.job_title ?? "";
    let matched = false;
    for (const [sen, re] of Object.entries(seniorityKeywords)) {
      if (re.test(title)) {
        senCount[sen] = (senCount[sen] ?? 0) + 1;
        matched = true;
        break;
      }
    }
    if (!matched) senCount["OTHER/UNKNOWN"] = (senCount["OTHER/UNKNOWN"] ?? 0) + 1;
  }
  for (const [sen, count] of Object.entries(senCount).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / allContacts.length) * 100).toFixed(1);
    console.log(`  ${String(count).padStart(5)}  ${sen.padEnd(20)} (${pct}%)`);
  }

  // email_status distribution
  sub("Email status distribution");
  const byEmailStatus = new Map<string, number>();
  for (const c of allContacts) {
    const k = c.email_status ?? "(null)";
    byEmailStatus.set(k, (byEmailStatus.get(k) ?? 0) + 1);
  }
  for (const [st, count] of [...byEmailStatus.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / allContacts.length) * 100).toFixed(1);
    console.log(`  ${String(count).padStart(5)}  ${st.padEnd(20)} (${pct}%)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// K — ACCOUNT INTELLIGENCE (for ROCI companies)
// ─────────────────────────────────────────────────────────────────────────────

h("K — ACCOUNT INTELLIGENCE");

if (companyIds.length > 0) {
  const BATCH = 400;
  type AiRow = { company_id: string; is_ready: boolean; opportunity_score: number | null; priority_score: number | null };
  const allAi: AiRow[] = [];

  for (let i = 0; i < companyIds.length; i += BATCH) {
    const batch = companyIds.slice(i, i + BATCH);
    const { data: aiRows, error: aiErr } = await db
      .from("account_intelligence")
      .select("company_id, is_ready, opportunity_score, priority_score")
      .eq("client_id", GRAMSCODE)
      .in("company_id", batch);
    if (aiErr) { console.log("  ERROR:", aiErr.message); break; }
    allAi.push(...((aiRows ?? []) as AiRow[]));
  }

  row("ROCI companies with account_intelligence", allAi.length);
  row("ROCI companies WITHOUT account_intelligence", companyIds.length - allAi.length);
  row("is_ready = true",  allAi.filter(a => a.is_ready).length);
  row("is_ready = false", allAi.filter(a => !a.is_ready).length);

  if (allAi.length > 0) {
    const scores = allAi.filter(a => a.opportunity_score !== null).map(a => a.opportunity_score as number);
    if (scores.length > 0) {
      row("opportunity_score avg", (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1));
      row("opportunity_score min", Math.min(...scores));
      row("opportunity_score max", Math.max(...scores));
    }
  }
} else {
  console.log("  No ROCI companies — skipping");
}

// ─────────────────────────────────────────────────────────────────────────────
// L — SIGNALS (for ROCI companies)
// ─────────────────────────────────────────────────────────────────────────────

h("L — SIGNALS");

const { data: signalCount, error: sigErr } = await db
  .from("signals")
  .select("signal_type, company_id", { count: "exact" })
  .eq("client_id", GRAMSCODE)
  .limit(0);

if (sigErr) {
  console.log("  ERROR:", sigErr.message);
} else {
  row("Total signals for Gramscode", (signalCount as unknown as { count: number }).count ?? "query error");
}

// Signal types breakdown
const { data: sigTypeRows, error: sigTypeErr } = await db
  .from("signals")
  .select("signal_type")
  .eq("client_id", GRAMSCODE);

if (!sigTypeErr && sigTypeRows) {
  type SigRow = { signal_type: string };
  const bySigType = new Map<string, number>();
  for (const s of (sigTypeRows as SigRow[])) {
    bySigType.set(s.signal_type, (bySigType.get(s.signal_type) ?? 0) + 1);
  }
  if (bySigType.size > 0) {
    sub("Signal type distribution");
    for (const [t, count] of [...bySigType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${t}`);
    }
  } else {
    console.log("  No signals yet for Gramscode");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// M — CONTACT INTELLIGENCE (contact_campaign_relevance in ROCI)
// ─────────────────────────────────────────────────────────────────────────────

h("M — CONTACT INTELLIGENCE / CAMPAIGN RELEVANCE");

const { data: ciRows, error: ciErr } = await db
  .from("contact_intelligence")
  .select("contact_id, is_person_qualified, is_contact_ready, is_person_relevant")
  .eq("client_id", GRAMSCODE)
  .limit(200);

if (ciErr) {
  console.log("  ERROR:", ciErr.message);
} else {
  type CiRow = { contact_id: string; is_person_qualified: boolean; is_contact_ready: boolean; is_person_relevant: boolean };
  const ci = (ciRows ?? []) as CiRow[];
  row("contact_intelligence rows for Gramscode", ci.length);
  if (ci.length > 0) {
    row("  is_contact_ready = true",    ci.filter(r => r.is_contact_ready).length);
    row("  is_person_relevant = true",  ci.filter(r => r.is_person_relevant).length);
    row("  is_person_qualified = true", ci.filter(r => r.is_person_qualified).length);
  }
}

const { data: ccrRows, error: ccrErr } = await db
  .from("contact_campaign_relevance")
  .select("contact_id, relevance_score, relevance_reason")
  .eq("client_id", GRAMSCODE)
  .limit(200);

if (ccrErr) {
  console.log("  ERROR (ccr):", ccrErr.message);
} else {
  row("contact_campaign_relevance rows for Gramscode", (ccrRows ?? []).length);
}

// ─────────────────────────────────────────────────────────────────────────────
// DONE
// ─────────────────────────────────────────────────────────────────────────────

h("DATA COLLECTION COMPLETE");
console.log("  All reads successful. Zero writes performed.\n");
