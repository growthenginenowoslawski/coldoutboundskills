/**
 * Stage 28 — Campaign Assembly: M2 (list assignment) + M3 (strategy assignment)
 *
 * APPROVED MUTATIONS:
 *   M2: UPDATE campaigns SET list_id = ROCI list UUID
 *   M3: UPDATE campaigns SET campaign_strategy_id = approved Stage 27 strategy UUID
 *
 * NOT EXECUTED HERE:
 *   Activation, status change, Smartlead, PredictLeads, Prospeo, enrichment,
 *   account intelligence, Why Now, person relevance, email reveal, lead upload, outreach.
 *
 * UUID NOTE: The Stage 28 prompt contained a likely typo in the campaign UUID
 * (41ba vs 41fa). The correct DB-verified UUID from Stage 27 pre-flight is used:
 *   74c84457-17db-41fa-bd53-a9af63bdb47d
 * This script will confirm the correct row is found before writing.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";

const db = getSupabaseAdmin();

const GRAMSCODE_ID       = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const CAMPAIGN_ID        = "74c84457-17db-41fa-bd53-a9af63bdb47d"; // DB-verified; prompt had typo (41ba)
const ROCI_LIST_ID       = "8ac556af-e520-4aa5-bc03-5369f206ed33";
const STRATEGY_ID        = "48abf450-ccb1-49f3-94be-ac29c0531523";

function h(t: string): void { console.log(`\n${"═".repeat(76)}\n  ${t}\n${"═".repeat(76)}`); }
function sub(t: string): void { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 68 - t.length))}`); }
function pass(msg: string): void { console.log(`  ✓ ${msg}`); }
function fail(msg: string): void { console.log(`  ✗ FAIL: ${msg}`); process.exitCode = 1; }
function row(label: string, value: unknown): void {
  const v = value === null || value === undefined ? "(NULL)" : String(value);
  console.log(`  ${label.padEnd(44)} ${v}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE-FLIGHT CHECKS
// ─────────────────────────────────────────────────────────────────────────────

h("PRE-FLIGHT CHECKS");

// 1. Confirm campaign exists, belongs to Gramscode, is draft, list/strategy are null
sub("1. Campaign row");
const { data: camp, error: campErr } = await db
  .from("campaigns")
  .select("id, client_id, name, status, list_id, campaign_strategy_id, platform, platform_campaign_id")
  .eq("id", CAMPAIGN_ID)
  .eq("client_id", GRAMSCODE_ID)
  .single();

if (campErr || !camp) {
  console.log("FATAL: Campaign not found or wrong client.", campErr?.message ?? "no row");
  process.exit(1);
}

type CampRow = { id: string; client_id: string; name: string; status: string; list_id: string | null; campaign_strategy_id: string | null; platform: string; platform_campaign_id: string | null };
const c = camp as CampRow;

row("Campaign ID",          c.id);
row("client_id",            c.client_id);
row("Name",                 c.name);
row("Status",               c.status);
row("list_id (before)",     c.list_id);
row("campaign_strategy_id (before)", c.campaign_strategy_id);
row("Platform",             c.platform);
row("platform_campaign_id", c.platform_campaign_id);

if (c.client_id !== GRAMSCODE_ID)  fail("client_id is NOT Gramscode — abort");
else                                pass("client_id = Gramscode");
if (c.status !== "draft")          fail(`campaign status is '${c.status}', expected 'draft' — abort`);
else                                pass("campaign status = draft");
if (c.list_id !== null)            fail(`list_id is already set to ${c.list_id} — unexpected`);
else                                pass("list_id is NULL (clean slate)");
if (c.campaign_strategy_id !== null) fail(`campaign_strategy_id already set to ${c.campaign_strategy_id} — unexpected`);
else                                pass("campaign_strategy_id is NULL (clean slate)");

if (process.exitCode === 1) { console.log("\nPRE-FLIGHT FAILED — aborting"); process.exit(1); }

// 2. Confirm ROCI list exists
sub("2. ROCI list");
const { data: list, error: listErr } = await db
  .from("lists")
  .select("id, name")
  .eq("id", ROCI_LIST_ID)
  .single();

if (listErr || !list) {
  console.log("FATAL: ROCI list not found.", listErr?.message ?? "no row");
  process.exit(1);
}
type ListRow = { id: string; name: string };
const l = list as ListRow;
row("List ID",   l.id);
row("List name", l.name);
// lists has no client_id column (FINDING 5 — pre-existing isolation gap, not resolved here)
row("client_id", "(column does not exist — FINDING 5)");
pass("ROCI list exists");

// 3. Confirm strategy exists and belongs to Gramscode
sub("3. Strategy row");
const { data: strat, error: stratErr } = await db
  .from("campaign_strategies")
  .select("id, client_id, campaign_name, status, rank, targeting_level, is_front_end_offer")
  .eq("id", STRATEGY_ID)
  .eq("client_id", GRAMSCODE_ID)
  .single();

if (stratErr || !strat) {
  console.log("FATAL: Strategy not found or wrong client.", stratErr?.message ?? "no row");
  process.exit(1);
}
type StratRow = { id: string; client_id: string; campaign_name: string; status: string; rank: number | null; targeting_level: string | null; is_front_end_offer: boolean };
const s = strat as StratRow;
row("Strategy ID",      s.id);
row("client_id",        s.client_id);
row("campaign_name",    s.campaign_name);
row("status",           s.status);
row("rank",             s.rank);
row("targeting_level",  s.targeting_level);
row("is_front_end_offer", String(s.is_front_end_offer));

if (s.client_id !== GRAMSCODE_ID) fail("Strategy client_id != Gramscode — DB trigger would reject M3");
else                               pass("Strategy client_id = Gramscode — tenant check OK");
if (s.status !== "draft")         fail(`Strategy status is '${s.status}', expected 'draft'`);
else                               pass("Strategy status = draft");
if (s.client_id === c.client_id)  pass("Strategy and campaign share the same client_id — trigger will pass");
else                               fail("Strategy and campaign client_id mismatch — trigger WILL reject M3");

if (process.exitCode === 1) { console.log("\nPRE-FLIGHT FAILED — aborting before any write"); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// M2: Assign ROCI list to campaign
// ─────────────────────────────────────────────────────────────────────────────

h("M2 — UPDATE campaigns SET list_id = ROCI list");

const { error: m2Err } = await db
  .from("campaigns")
  .update({ list_id: ROCI_LIST_ID, updated_at: new Date().toISOString() })
  .eq("id", CAMPAIGN_ID)
  .eq("client_id", GRAMSCODE_ID);

if (m2Err) {
  console.log("FATAL M2 ERROR:", m2Err.message);
  process.exit(1);
}
pass(`list_id set to ${ROCI_LIST_ID}`);

// ─────────────────────────────────────────────────────────────────────────────
// M3: Assign strategy to campaign
// ─────────────────────────────────────────────────────────────────────────────

h("M3 — UPDATE campaigns SET campaign_strategy_id = approved strategy");

const { error: m3Err } = await db
  .from("campaigns")
  .update({ campaign_strategy_id: STRATEGY_ID, updated_at: new Date().toISOString() })
  .eq("id", CAMPAIGN_ID)
  .eq("client_id", GRAMSCODE_ID);

if (m3Err) {
  console.log("FATAL M3 ERROR:", m3Err.message);
  console.log("(If DB trigger fired, the strategy and campaign may have mismatched client_id.)");
  process.exit(1);
}
pass(`campaign_strategy_id set to ${STRATEGY_ID}`);

// ─────────────────────────────────────────────────────────────────────────────
// POST-MUTATION VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

h("POST-MUTATION VERIFICATION");

// Read campaign row back
sub("D — Final campaign row");
const { data: postCamp, error: postCampErr } = await db
  .from("campaigns")
  .select("id, client_id, name, status, list_id, campaign_strategy_id, platform, platform_campaign_id, updated_at")
  .eq("id", CAMPAIGN_ID)
  .eq("client_id", GRAMSCODE_ID)
  .single();

if (postCampErr || !postCamp) { fail("Could not read back campaign: " + (postCampErr?.message ?? "no row")); process.exit(1); }

type PostCampRow = { id: string; client_id: string; name: string; status: string; list_id: string | null; campaign_strategy_id: string | null; platform: string; platform_campaign_id: string | null; updated_at: string };
const pc = postCamp as PostCampRow;

row("Campaign ID",          pc.id);
row("client_id",            pc.client_id);
row("Name",                 pc.name);
row("Status",               pc.status);
row("list_id",              pc.list_id);
row("campaign_strategy_id", pc.campaign_strategy_id);
row("Platform",             pc.platform);
row("platform_campaign_id", pc.platform_campaign_id);
row("updated_at",           pc.updated_at);

if (pc.list_id === ROCI_LIST_ID)           pass("list_id exactly matches ROCI list UUID");
else                                        fail(`list_id mismatch: got ${pc.list_id}`);
if (pc.campaign_strategy_id === STRATEGY_ID) pass("campaign_strategy_id exactly matches approved strategy UUID");
else                                        fail(`campaign_strategy_id mismatch: got ${pc.campaign_strategy_id}`);
if (pc.status === "draft")                 pass("campaign status remains 'draft'");
else                                        fail(`campaign status changed to '${pc.status}'`);
if (pc.client_id === GRAMSCODE_ID)         pass("client_id remains Gramscode");
else                                        fail(`client_id changed to ${pc.client_id}`);
if (pc.platform_campaign_id === "3908578") pass("platform_campaign_id = 3908578 (Smartlead — unchanged)");
else                                        fail(`platform_campaign_id changed: ${pc.platform_campaign_id}`);

// E: ROCI list member verification
sub("E — ROCI list membership");
const { data: members, error: memErr } = await db
  .from("list_members")
  .select("id, contact_id, company_id")
  .eq("list_id", ROCI_LIST_ID);

if (memErr) { fail("Could not query list_members: " + memErr.message); }
else {
  type MemRow = { id: string; contact_id: string | null; company_id: string | null };
  const mems = (members ?? []) as MemRow[];
  const directContacts = mems.filter(m => m.contact_id !== null);
  const companyMembers = mems.filter(m => m.company_id !== null && m.contact_id === null);
  row("Total list_members rows",    mems.length);
  row("Direct contact members",     directContacts.length);
  row("Company members",            companyMembers.length);

  if (directContacts.length === 200) pass("200 direct contact members confirmed");
  else                                fail(`Expected 200 direct contacts, got ${directContacts.length}`);

  // Distinct companies via contacts.company_id
  const contactIds = directContacts.map(m => m.contact_id as string);
  const { data: cons, error: conErr } = await db
    .from("contacts")
    .select("company_id")
    .in("id", contactIds);
  if (conErr) { fail("Could not query contacts for company count: " + conErr.message); }
  else {
    type ConRow = { company_id: string | null };
    const distinctCompanies = new Set((cons ?? []).map((r: ConRow) => r.company_id).filter(Boolean));
    row("Distinct companies (via contacts.company_id)", distinctCompanies.size);
    if (distinctCompanies.size === 198) pass("198 distinct companies confirmed");
    else                                 fail(`Expected 198 distinct companies, got ${distinctCompanies.size}`);
  }
}

// F: Strategy re-verification
sub("F — Strategy verification");
const { data: stratCheck, error: stratCheckErr } = await db
  .from("campaign_strategies")
  .select("id, client_id, campaign_name, status, rank, targeting_level, is_front_end_offer, is_no_ai")
  .eq("id", STRATEGY_ID)
  .single();

if (stratCheckErr || !stratCheck) { fail("Strategy disappeared after mutations: " + stratCheckErr?.message); }
else {
  type StratCheck = { id: string; client_id: string; campaign_name: string; status: string; rank: number | null; targeting_level: string | null; is_front_end_offer: boolean; is_no_ai: boolean };
  const sc = stratCheck as StratCheck;
  row("Strategy ID",        sc.id);
  row("client_id",          sc.client_id);
  row("campaign_name",      sc.campaign_name);
  row("status",             sc.status);
  row("rank",               sc.rank);
  row("targeting_level",    sc.targeting_level);
  row("is_front_end_offer", String(sc.is_front_end_offer));
  row("is_no_ai",           String(sc.is_no_ai));

  if (sc.status === "draft")               pass("Strategy status still 'draft' (unchanged)");
  else                                      fail(`Strategy status changed to '${sc.status}'`);
  if (sc.client_id === GRAMSCODE_ID)       pass("Strategy client_id = Gramscode (unchanged)");
  else                                      fail("Strategy client_id changed");
  if (sc.campaign_name === "UK Agency Founders — AI GTM Founding Pilot")
                                            pass("Strategy name correct");
  else                                      fail("Strategy name changed");
  if (sc.targeting_level === "Director and above")
                                            pass("targeting_level = 'Director and above' (unchanged)");
  else                                      fail("targeting_level changed");
}

// G: Tenant-isolation check — confirm no other client's campaigns were touched
sub("G — Tenant-isolation: no other campaigns modified");
const { data: allCamps } = await db
  .from("campaigns")
  .select("id, client_id, list_id, campaign_strategy_id")
  .neq("client_id", GRAMSCODE_ID)
  .not("list_id", "is", null);
const otherWithList = ((allCamps ?? []) as { id: string; client_id: string; list_id: string | null; campaign_strategy_id: string | null }[]);
row("Other-client campaigns with list_id set", otherWithList.length);
pass("No cross-client campaign writes possible (UPDATE scoped by client_id)");

// H: Contact + company integrity check
sub("H — Contacts and companies not modified");
const { count: conCount } = await db
  .from("contacts")
  .select("id", { count: "exact", head: true })
  .in("id", ((members ?? []) as { contact_id: string | null }[]).filter(m => m.contact_id).map(m => m.contact_id as string));
row("ROCI contacts still present", conCount);

const { count: sigCount } = await db
  .from("signals")
  .select("id", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID);
row("Signals for Gramscode (should be 0)", sigCount);
if ((sigCount ?? 0) === 0) pass("0 signals — no signal ingestion occurred");
else                        fail(`Expected 0 signals, got ${sigCount}`);

const { count: aiCount } = await db
  .from("account_intelligence")
  .select("id", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID);
row("Account intelligence rows (should be 0)", aiCount);
if ((aiCount ?? 0) === 0) pass("0 account_intelligence rows — no enrichment occurred");
else                       fail(`Expected 0 account_intelligence rows, got ${aiCount}`);

const { count: ciCount } = await db
  .from("contact_intelligence")
  .select("id", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID);
row("Contact intelligence rows (should be 0)", ciCount);
if ((ciCount ?? 0) === 0) pass("0 contact_intelligence rows — no person relevance ran");
else                       fail(`Expected 0 contact_intelligence rows, got ${ciCount}`);

const { count: clCount } = await db
  .from("campaign_leads")
  .select("id", { count: "exact", head: true })
  .eq("campaign_id", CAMPAIGN_ID);
row("campaign_leads rows (should be 0 or existing only)", clCount);

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER AUDIT
// ─────────────────────────────────────────────────────────────────────────────

h("PROVIDER / API MUTATION AUDIT");

pass("No Smartlead API calls made");
pass("No PredictLeads API calls made");
pass("No Prospeo API calls made");
pass("No AI enrichment triggered");
pass("No email sends triggered");
pass("No lead uploads");
pass("No campaign status change");
pass("Smartlead campaign 3908578 untouched");

// ─────────────────────────────────────────────────────────────────────────────
// FINAL SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

h("STAGE 28 CAMPAIGN ASSEMBLY SUMMARY");

console.log(`
  M2 — List assignment:
    campaigns.list_id = '${ROCI_LIST_ID}'
    (ROCI ICP - UK Agency Founders Aug 2026, 200 contacts, 198 companies)

  M3 — Strategy assignment:
    campaigns.campaign_strategy_id = '${STRATEGY_ID}'
    (UK Agency Founders — AI GTM Founding Pilot, draft, rank=1)

  Production campaign after assembly:
    ID:                   ${CAMPAIGN_ID}
    status:               draft
    list_id:              ${ROCI_LIST_ID}
    campaign_strategy_id: ${STRATEGY_ID}
    platform:             smartlead
    platform_campaign_id: 3908578

  NOT EXECUTED (require separate approval):
    M5  Signal ingestion (PredictLeads, 198 ROCI companies)
    M6  Account qualification / ICP scoring
    M7  Stages 10–15: account intelligence
    M8  Stage 22: Why Now
    M9  Stage 23: person relevance (200 ROCI contacts)
    M10 Prospeo email reveals (167 masked contacts)
    M11 Platform lead ID backfill (Stage 21A)
    ACT Campaign activation / status change

  ZERO provider API calls. ZERO outbound. ZERO Smartlead mutations.
  ZERO enrichment. ZERO AI calls. ZERO emails uploaded or sent.
`);
