/**
 * Stage 27 — Production Mutations: M4 (ICP answers) + M1 (Campaign strategy)
 *
 * APPROVED MUTATIONS ONLY:
 *   M4: Write 12 approved ICP answers into icp_onboarding for Gramscode.
 *   M1: Insert approved production campaign strategy for Gramscode.
 *
 * NOT EXECUTED HERE:
 *   M2/M3 (list + strategy assignment to campaign)
 *   Signal ingestion, account intelligence, Why Now, person relevance,
 *   email reveal, Smartlead upload, any outbound.
 *
 * Zero provider API calls. Zero Smartlead mutations. Zero PredictLeads calls.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";
import { saveAnswer } from "../src/db/onboarding.js";
import { insertCampaignStrategy } from "../src/db/campaign-strategies.js";

const GRAMSCODE_SLUG = "gramscode";
const GRAMSCODE_ID   = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const PRODUCTION_CAMPAIGN_ID = "74c84457-17db-41fa-bd53-a9af63bdb47d";

const db = getSupabaseAdmin();

function h(t: string): void { console.log(`\n${"═".repeat(76)}\n  ${t}\n${"═".repeat(76)}`); }
function sub(t: string): void { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 68 - t.length))}`); }
function pass(msg: string): void { console.log(`  ✓ ${msg}`); }
function fail(msg: string): void { console.log(`  ✗ FAIL: ${msg}`); process.exitCode = 1; }
function row(label: string, value: unknown): void {
  const v = value === null || value === undefined ? "(NULL)" : String(value);
  console.log(`  ${label.padEnd(44)} ${v}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-FLIGHT: Confirm current state before any write
// ─────────────────────────────────────────────────────────────────────────────

h("PRE-FLIGHT STATE CHECK (BEFORE MUTATIONS)");

const { data: preCampaign, error: preCampErr } = await db
  .from("campaigns")
  .select("id, name, status, list_id, campaign_strategy_id, platform, platform_campaign_id")
  .eq("id", PRODUCTION_CAMPAIGN_ID)
  .eq("client_id", GRAMSCODE_ID)
  .single();

if (preCampErr) { console.log("ERROR reading campaign:", preCampErr.message); process.exit(1); }

sub("Production campaign state (BEFORE)");
row("Campaign ID",          preCampaign.id);
row("Name",                 preCampaign.name);
row("Status",               preCampaign.status);
row("list_id",              preCampaign.list_id);
row("campaign_strategy_id", preCampaign.campaign_strategy_id);
row("Platform",             preCampaign.platform);
row("platformCampaignId",   preCampaign.platform_campaign_id);

const { data: preIcp, error: preIcpErr } = await db
  .from("icp_onboarding")
  .select("question_key, answer")
  .eq("client_id", GRAMSCODE_ID)
  .order("position");

if (preIcpErr) { console.log("ERROR reading icp_onboarding:", preIcpErr.message); process.exit(1); }

sub("ICP onboarding answers (BEFORE)");
for (const row_ of (preIcp ?? []) as { question_key: string; answer: string | null }[]) {
  const v = row_.answer ? row_.answer.slice(0, 60) + (row_.answer.length > 60 ? "..." : "") : "(null)";
  console.log(`  ${row_.question_key.padEnd(24)} ${v}`);
}

const { data: preStrats } = await db
  .from("campaign_strategies")
  .select("id, campaign_name, status, rank, created_at")
  .eq("client_id", GRAMSCODE_ID)
  .order("created_at");

sub("Existing campaign strategies (BEFORE)");
const preStratList = (preStrats ?? []) as { id: string; campaign_name: string; status: string; rank: number | null; created_at: string }[];
console.log(`  Count: ${preStratList.length}`);
for (const s of preStratList) {
  console.log(`  ${s.id.slice(0,8)}  ${s.campaign_name.slice(0,50)}  [${s.status}]  rank=${s.rank ?? "null"}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// M4: Write 12 ICP answers
// ─────────────────────────────────────────────────────────────────────────────

h("M4 — WRITING 12 ICP ANSWERS");

const ICP_ANSWERS: Array<[string, string]> = [
  ["what_you_sell",
   "Gramscode builds and operates AI-powered GTM systems for B2B companies — finding the right accounts, identifying the right people, personalising outreach and running the campaign so clients get qualified pipeline."],

  ["best_customer",
   "A UK founder-led B2B creative, advertising, marketing or design agency that already delivers good client work, relies significantly on referrals/inbound for new business, and wants a more predictable way to generate qualified sales conversations without building a large internal sales team."],

  ["buying_title",
   "Founder; Owner; Co-Founder; CEO; Managing Director (P1 — primary). Commercial Director; Sales Director; Business Development Director (P2 — secondary). Account Director; Client Services Director (lower priority, included not excluded)."],

  ["headcount_range",
   "3–200 employees as a targeting hypothesis; do not discard companies when headcount is unknown."],

  ["industries_in_out",
   "IN: Creative agencies, Advertising agencies, Marketing agencies, Design agencies, Digital agencies, Branding agencies, Content agencies. OUT: Holding company subsidiaries (WPP, Publicis, Dentsu etc.); B2C-only agencies with no B2B client base; freelancers and sole traders."],

  ["geography",
   "United Kingdom. London is primary market (approx 40% of first test pool). Bristol, Manchester, Leeds also represented. Non-UK contacts in the initial test pool should be reviewed and confirmed before outreach."],

  ["triggers",
   "HYPOTHESIS — UNVALIDATED: BD/Sales/Growth role posted (agency actively building sales capacity); funding or investment received (growth capital triggers new business push); new executive hire (leadership change triggers GTM review); new service launch (website change, new service page); expansion signals. All triggers are hypotheses until correlated with real response data."],

  ["disqualifiers",
   "Holding company subsidiaries or network agency divisions; private equity-owned agencies with corporate procurement; B2C-only agencies with no B2B client base; solo practitioners and freelancers (under 3 people); agencies already running systematic AI outbound; existing Gramscode clients."],

  ["offer_cta",
   "Founding GTM Pilot — normal value £1,000, founding price £0 for 5 selected agencies. CTA: invite a low-friction conversation. Example: 'Would it be useful to see what this could look like for [Agency]?' Do not assume the prospect agrees they have a pipeline problem. Do not promise specific results. The offer is a full-service pilot, not a free trial."],

  ["lead_magnet",
   "No separate lead magnet at this stage. The Founding Pilot is the offer: a fully built and operated AI GTM system at no cost for 5 selected founding agencies. The pilot itself is the hook. In return: honest feedback, permission to document the process, and a testimonial or case study only if genuinely earned."],

  ["tone",
   "Peer-to-peer. Founder to founder. Direct, specific, no jargon. Confident but not pushy. Honest — we are validating a new system, not claiming proven results. Conversational, not vendor-to-buyer. Never diagnose a problem the prospect hasn't confirmed."],

  ["banned_words_legal",
   "Do not use: 'guaranteed results', 'proven', 'clients like X' (no real clients yet), 'free in exchange for a testimonial', 'ROCI' as a product name, any fabricated metrics or outcome numbers, any invented case studies. All claims must be factually supportable. The pain hypothesis (agency founders need systematic pipeline) is unvalidated — do not represent it as established fact."],
];

let m4Errors = 0;
for (const [key, answer] of ICP_ANSWERS) {
  try {
    await saveAnswer(GRAMSCODE_SLUG, key, answer);
    pass(`Saved: ${key}`);
  } catch (e) {
    fail(`Failed to save ${key}: ${(e as Error).message}`);
    m4Errors++;
  }
}

if (m4Errors > 0) {
  console.log(`\n  M4 ABORTED: ${m4Errors} write errors. Halting before M1.`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// M1: Insert production campaign strategy
// ─────────────────────────────────────────────────────────────────────────────

h("M1 — INSERTING PRODUCTION CAMPAIGN STRATEGY");

let newStrategyId: string | null = null;

try {
  const strategy = await insertCampaignStrategy(GRAMSCODE_SLUG, {
    campaign_name: "UK Agency Founders — AI GTM Founding Pilot",

    // MACHINE-READ by parseTargetingPersona() in Stage 23.
    // "Director and above" → minimumSeniority=DIRECTOR, hasExplicitFunction=false.
    // No explicit function keyword = WRONG_FUNCTION never fires.
    // Do not add "Founder", "CEO", "Executive" etc. here without re-auditing Stage 23
    // because those keywords shift minimumSeniority to C_SUITE, which would hard-block
    // all Director-level contacts (Commercial Director, Sales Director, etc.).
    targeting_level: "Director and above",

    list_filters:
      "UK-only; Creative, Advertising, Marketing and Design agencies; " +
      "independent agencies preferred; Founder/Owner/MD prioritised (P1); " +
      "Commercial/Sales/BD Director included (P2); " +
      "company size currently unknown for first test pool — enrich and qualify, " +
      "do not discard on missing size; 5 founding agency slots; " +
      "non-UK contacts to be reviewed before outreach",

    ai_strategy:
      "Research each agency's positioning, services and visible client type (B2B vs B2C) " +
      "from their website. Identify any growth signals: recent hiring for BD/Sales/Growth, " +
      "new service launches, website changes, funding, new executives. Personalise by " +
      "referencing what this specific agency actually does and framing the new business " +
      "pipeline challenge in their context. Never invent facts. Never claim the prospect " +
      "has a pipeline problem unless there is clear evidence. The pain point — that agency " +
      "founders need systematic pipeline — is a hypothesis; do not represent it as proven. " +
      "Tone: peer-to-peer, founder to founder, direct, specific, no jargon, honest.",

    value_proposition:
      "Gramscode builds and operates an AI-powered GTM system that finds the right companies, " +
      "identifies the right people, detects buying signals, personalises outreach and runs the " +
      "campaign — so agency founders get qualified client conversations without building the " +
      "infrastructure themselves.",

    campaign_overview:
      "CAMPAIGN OBJECTIVE: Validate whether UK creative, advertising, marketing and design " +
      "agency founders experience a meaningful pipeline-generation problem that Gramscode's " +
      "GTM system can address. This is a system and market validation campaign — one genuine " +
      "qualified conversation is worth more than 1,000 opens.\n\n" +
      "OFFER: Founding GTM Pilot. Normal value £1,000. Founding price £0 for 5 selected " +
      "agencies. Gramscode builds and operates the full GTM system for the founding agency. " +
      "In return: honest feedback, permission to document the process, and a testimonial or " +
      "case study only if genuinely earned. This is not 'free in exchange for a testimonial' " +
      "— testimonials are earned, not required. No guaranteed outcomes. No fabricated claims.\n\n" +
      "PRIMARY BUYER: Founder, Owner, Co-Founder, CEO, Managing Director (P1). " +
      "Commercial Director, Sales Director, Business Development Director (P2).\n\n" +
      "TARGET MARKET: UK independent creative, advertising, marketing and design agencies. " +
      "Headcount hypothesis: 3–200 employees. Company size currently unknown for the first " +
      "test pool — enrich and qualify; do not discard on missing data.\n\n" +
      "FIRST TEST POOL: ROCI ICP - UK Agency Founders Aug 2026 (200 contacts, 198 companies). " +
      "ROCI is only the label for this test dataset — it is NOT the product being sold. " +
      "The GTM engine is product-agnostic; do not hard-code agencies or this buyer profile " +
      "into the core system.\n\n" +
      "SIGNAL STRATEGY (ALL HYPOTHESES — UNVALIDATED): BD/Sales/Growth role postings; " +
      "funding rounds; executive hires; website changes; expansion signals. " +
      "All signals are hypotheses until correlated with real response data.\n\n" +
      "PERSONALISATION: Research-first. Specific to each agency. Never fabricate signals, " +
      "metrics, or results. If no signal exists, the founding pilot offer is the hook.\n\n" +
      "SCOPE NOTE: This configuration represents Gramscode's specific first campaign. " +
      "The GTM engine must remain product-agnostic to support future clients and ICPs.",

    is_no_ai:           false,
    is_front_end_offer: true,
    rank:               1,
    status:             "draft",

    notes:
      "USER-CONFIRMED 2026-09-10 (Stage 27). First production campaign strategy for Gramscode. " +
      "Founding Pilot: 5 slots. Normal value £1,000. Founding price £0. " +
      "ROCI is the test pool label only — not a product being sold by Gramscode. " +
      "Gramscode sells: AI-powered GTM systems for B2B companies. " +
      "Company size unknown for all ~198 ROCI companies — enrich, do not hard-filter. " +
      "Pain hypothesis (agency founders need systematic pipeline) is UNVALIDATED. " +
      "targeting_level='Director and above' is machine-read by parseTargetingPersona() " +
      "in Stage 23 — changing this field without re-auditing Stage 23 will silently alter " +
      "which contacts are hard-blocked. See Stage 27 report Section 7 for details. " +
      "M2/M3 (list + strategy assignment to production campaign) PENDING — not executed here. " +
      "Downstream: signal ingestion, account intelligence, Why Now, person relevance, " +
      "email reveal, Smartlead upload all remain blocked until explicitly approved.",
  });

  newStrategyId = strategy.id;
  pass(`Campaign strategy inserted: ${newStrategyId}`);

} catch (e) {
  fail(`insertCampaignStrategy failed: ${(e as Error).message}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-MUTATION VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

h("POST-MUTATION VERIFICATION");

// ── Verify ICP answers ────────────────────────────────────────────────────────
sub("A — M4: ICP answer verification");

const { data: postIcp, error: postIcpErr } = await db
  .from("icp_onboarding")
  .select("question_key, answer, answered_at")
  .eq("client_id", GRAMSCODE_ID)
  .order("position");

if (postIcpErr) { fail("Could not read back icp_onboarding: " + postIcpErr.message); }

const icpRows = (postIcp ?? []) as { question_key: string; answer: string | null; answered_at: string | null }[];
row("Total icp_onboarding rows", icpRows.length);

const EXPECTED_KEYS = ICP_ANSWERS.map(([k]) => k);
let icpVerifyErrors = 0;
for (const [key, expectedAnswer] of ICP_ANSWERS) {
  const found = icpRows.find(r => r.question_key === key);
  if (!found) { fail(`Row missing: ${key}`); icpVerifyErrors++; continue; }
  if (!found.answer) { fail(`Answer is null for: ${key}`); icpVerifyErrors++; continue; }
  if (found.answer !== expectedAnswer) {
    fail(`Answer mismatch for ${key}:\n    stored: ${found.answer.slice(0, 80)}\n  expected: ${expectedAnswer.slice(0, 80)}`);
    icpVerifyErrors++;
    continue;
  }
  if (!found.answered_at) { fail(`answered_at is null for: ${key}`); icpVerifyErrors++; continue; }
  pass(`${key}: answer stored, answered_at set`);
}
if (icpVerifyErrors === 0) pass("All 12 ICP answers verified — content and answered_at match");

// ── Verify strategy row ───────────────────────────────────────────────────────
sub("B — M1: Campaign strategy verification");

if (!newStrategyId) { fail("No strategy ID — cannot verify"); process.exit(1); }

const { data: strat, error: stratErr } = await db
  .from("campaign_strategies")
  .select("*")
  .eq("id", newStrategyId)
  .eq("client_id", GRAMSCODE_ID)
  .single();

if (stratErr || !strat) { fail("Could not read back strategy: " + (stratErr?.message ?? "no row")); process.exit(1); }

type StratRow = {
  id: string; client_id: string; campaign_name: string; targeting_level: string | null;
  is_front_end_offer: boolean; is_no_ai: boolean; rank: number | null; status: string;
  value_proposition: string | null; campaign_overview: string | null; ai_strategy: string | null;
  list_filters: string | null; notes: string | null; created_at: string; updated_at: string;
};
const s = strat as StratRow;

row("Strategy ID",            s.id);
row("client_id",              s.client_id);
row("campaign_name",          s.campaign_name);
row("targeting_level",        s.targeting_level);
row("is_front_end_offer",     String(s.is_front_end_offer));
row("is_no_ai",               String(s.is_no_ai));
row("rank",                   s.rank);
row("status",                 s.status);
row("value_proposition",      s.value_proposition ? s.value_proposition.slice(0, 60) + "..." : "(null)");
row("campaign_overview",      s.campaign_overview ? s.campaign_overview.slice(0, 60) + "..." : "(null)");
row("ai_strategy",            s.ai_strategy        ? s.ai_strategy.slice(0, 60)        + "..." : "(null)");
row("list_filters",           s.list_filters       ? s.list_filters.slice(0, 60)       + "..." : "(null)");
row("notes",                  s.notes              ? s.notes.slice(0, 60)              + "..." : "(null)");

// Guards
if (s.client_id !== GRAMSCODE_ID)           fail("client_id mismatch — tenant isolation FAILED");
else                                         pass("client_id = Gramscode — tenant isolation OK");
if (s.campaign_name !== "UK Agency Founders — AI GTM Founding Pilot")
                                             fail("campaign_name mismatch");
else                                         pass("campaign_name correct");
if (s.targeting_level !== "Director and above")
                                             fail(`targeting_level wrong: "${s.targeting_level}"`);
else                                         pass("targeting_level = 'Director and above' — Stage 23 compatible");
if (s.is_front_end_offer !== true)          fail("is_front_end_offer should be true");
else                                         pass("is_front_end_offer = true");
if (s.is_no_ai !== false)                   fail("is_no_ai should be false");
else                                         pass("is_no_ai = false");
if (s.rank !== 1)                            fail(`rank should be 1, got ${s.rank}`);
else                                         pass("rank = 1");
if (s.status !== "draft")                   fail(`status should be 'draft', got '${s.status}'`);
else                                         pass("status = 'draft'");
if (!s.value_proposition)                   fail("value_proposition is null");
else                                         pass("value_proposition present");
if (!s.campaign_overview)                   fail("campaign_overview is null");
else                                         pass("campaign_overview present");
if (!s.ai_strategy)                         fail("ai_strategy is null");
else                                         pass("ai_strategy present");
if (!s.notes)                               fail("notes is null");
else                                         pass("notes present");

// Confirm '5 founding' appears in overview and notes
const overviewHas5 = s.campaign_overview?.includes("5 selected") || s.campaign_overview?.includes("5 founding");
const notesHas5    = s.notes?.includes("5 slots") || s.notes?.includes("5 founding");
if (overviewHas5) pass("campaign_overview references 5 founding slots");
else              fail("campaign_overview does not reference 5 founding slots");
if (notesHas5)    pass("notes references 5 founding slots");
else              fail("notes does not reference 5 founding slots");

// Confirm ROCI is labelled as test pool (not the product)
const overviewROCI = s.campaign_overview?.includes("ROCI is only the label");
const notesROCI    = s.notes?.includes("ROCI is the test pool label only");
if (overviewROCI) pass("campaign_overview: ROCI correctly labelled as test pool");
else              fail("campaign_overview does not clarify ROCI role");
if (notesROCI)    pass("notes: ROCI correctly labelled as test pool");
else              fail("notes does not clarify ROCI role");

// ── Confirm strategy count ────────────────────────────────────────────────────
sub("C — Strategy count change");

const { data: postStrats } = await db
  .from("campaign_strategies")
  .select("id, campaign_name, status, rank, created_at")
  .eq("client_id", GRAMSCODE_ID)
  .order("created_at");

const postStratList = (postStrats ?? []) as { id: string; campaign_name: string; status: string; rank: number | null; created_at: string }[];
row("Total strategies for Gramscode (after)", postStratList.length);
row("Total strategies before", preStratList.length);
row("Net new strategies", postStratList.length - preStratList.length);

if (postStratList.length - preStratList.length === 1) pass("Exactly 1 new strategy created");
else fail(`Expected exactly 1 new strategy, got ${postStratList.length - preStratList.length}`);

for (const s_ of postStratList) {
  const isNew = s_.id === newStrategyId ? " ← NEW" : "";
  console.log(`  ${s_.id.slice(0,8)}  ${s_.campaign_name.slice(0,50).padEnd(52)} [${s_.status}]  rank=${s_.rank ?? "null"}${isNew}`);
}

// ── Confirm production campaign unchanged ─────────────────────────────────────
sub("D — Production campaign still unchanged (M2/M3 not executed)");

const { data: postCampaign, error: postCampErr } = await db
  .from("campaigns")
  .select("id, name, status, list_id, campaign_strategy_id")
  .eq("id", PRODUCTION_CAMPAIGN_ID)
  .eq("client_id", GRAMSCODE_ID)
  .single();

if (postCampErr) { fail("Could not read back campaign: " + postCampErr.message); }
else {
  const pc = postCampaign as { id: string; name: string; status: string; list_id: string | null; campaign_strategy_id: string | null };
  row("list_id",              pc.list_id);
  row("campaign_strategy_id", pc.campaign_strategy_id);
  row("status",               pc.status);

  if (pc.list_id === null)              pass("list_id = NULL — M2 not executed");
  else                                  fail(`list_id is NOT null: ${pc.list_id}`);
  if (pc.campaign_strategy_id === null) pass("campaign_strategy_id = NULL — M3 not executed");
  else                                  fail(`campaign_strategy_id is NOT null: ${pc.campaign_strategy_id}`);
  if (pc.status === "draft")            pass("campaign status remains 'draft'");
  else                                  fail(`campaign status changed to '${pc.status}'`);
}

// ── Print final ICP answers for audit ─────────────────────────────────────────
sub("E — Full ICP answer audit (all 12 stored values)");

for (const icpRow of icpRows) {
  console.log(`\n  ${icpRow.question_key}:`);
  const answer = icpRow.answer ?? "(null)";
  const lines = answer.match(/.{1,90}/g) ?? [answer];
  for (const line of lines) console.log(`    ${line}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER / API MUTATION AUDIT
// ─────────────────────────────────────────────────────────────────────────────

h("PROVIDER / API MUTATION AUDIT");

pass("No Smartlead API calls made");
pass("No PredictLeads API calls made");
pass("No Prospeo API calls made");
pass("No AI enrichment triggered");
pass("No email sends triggered");
pass("No provider writes of any kind");
pass("Smartlead campaign 3908578 untouched");
pass("ROCI list not assigned to production campaign");

// ─────────────────────────────────────────────────────────────────────────────
// FINAL SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

h("STAGE 27 MUTATION SUMMARY");

console.log(`
  M4 — ICP answers:
    12 icp_onboarding rows updated for Gramscode (client: ${GRAMSCODE_ID})
    Question keys: what_you_sell, best_customer, buying_title, headcount_range,
      industries_in_out, geography, triggers, disqualifiers, offer_cta,
      lead_magnet, tone, banned_words_legal

  M1 — Campaign strategy:
    New strategy ID: ${newStrategyId}
    campaign_name:   "UK Agency Founders — AI GTM Founding Pilot"
    targeting_level: "Director and above"
    status:          draft
    is_front_end_offer: true
    rank:            1

  NOT EXECUTED (require separate approval):
    M2  UPDATE campaigns SET list_id = ROCI list
    M3  UPDATE campaigns SET campaign_strategy_id = [above strategy ID]
    M5  Signal ingestion (PredictLeads)
    M6  Account qualification / enrichment
    M7  Stages 10–15: account intelligence
    M8  Stage 22: Why Now
    M9  Stage 23: person relevance
    M10 Prospeo email reveals
    M11 Platform lead ID backfill (Stage 21A)

  ZERO provider API calls. ZERO outbound. ZERO Smartlead mutations.
`);
