/**
 * Stage 30A — Pre-flight check (READ-ONLY).
 *
 * Verifies credentials, domain coverage, and API request volume before
 * any external call is made. Reports everything needed for the user to
 * give explicit approval for Stage 30A ingestion.
 *
 * Run: npx tsx scripts/stage30a-preflight-check.ts
 */
import { existsSync } from "node:fs";
import { resolve }    from "node:path";
if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";
import { PredictLeadsSignalProvider } from "../src/providers/signals/predictleads-provider.js";
import { optionalEnv, ENV_KEYS } from "../src/config/env.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const GRAMSCODE_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const STRATEGY_ID  = "48abf450-ccb1-49f3-94be-ac29c0531523";
const ROCI_LIST_ID = "8ac556af-e520-4aa5-bc03-5369f206ed33";

// PredictLeads pagination constants (mirrors predictleads-provider.ts)
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MODULES_PER_COMPANY = 2; // job_openings + financing_events

function h(t: string): void {
  console.log(`\n${"═".repeat(76)}\n  ${t}\n${"═".repeat(76)}`);
}
function row(label: string, value: unknown): void {
  const v = value === null || value === undefined ? "(NULL)" : String(value);
  console.log(`  ${label.padEnd(44)} ${v}`);
}
function ok(msg: string): void { console.log(`  ✓ ${msg}`); }
function warn(msg: string): void { console.log(`  ⚠ ${msg}`); }
function fatal(msg: string): void { console.error(`  ✗ FATAL: ${msg}`); process.exitCode = 1; }

const db = getSupabaseAdmin();

// ── Phase 1: Credential check ─────────────────────────────────────────────────

h("PHASE 1 — PREDICTLEADS CREDENTIAL CHECK");

const apiKey   = optionalEnv(ENV_KEYS.predictleadsApiKey);
const apiToken = optionalEnv(ENV_KEYS.predictleadsApiToken);

row("PREDICTLEADS_API_KEY set",   apiKey   ? "YES (value redacted)" : "NO");
row("PREDICTLEADS_API_TOKEN set", apiToken ? "YES (value redacted)" : "NO");

const provider = new PredictLeadsSignalProvider();
const isConfigured = provider.isConfigured();

row("provider.isConfigured()",    isConfigured);

if (!isConfigured) {
  fatal("PredictLeads credentials not configured — cannot proceed to ingestion.");
  fatal("Set PREDICTLEADS_API_KEY and PREDICTLEADS_API_TOKEN in .env");
  process.exit(1);
} else {
  ok("PredictLeads credentials present");
}

// ── Phase 2: Fetch 198 ROCI company IDs (same path as baseline inspection) ───

h("PHASE 2 — FETCH 198 ROCI COMPANY IDs");

const { data: memberRows, error: memberErr } = await db
  .from("list_members")
  .select("contact_id")
  .eq("list_id", ROCI_LIST_ID)
  .not("contact_id", "is", null);

if (memberErr) {
  fatal(`Cannot fetch list_members: ${memberErr.message}`);
  process.exit(1);
}

type MemberRow = { contact_id: string | null };
const contactIds = ((memberRows ?? []) as MemberRow[])
  .filter(r => r.contact_id)
  .map(r => r.contact_id as string);

const { data: contactRows, error: contactErr } = await db
  .from("contacts")
  .select("id, company_id")
  .in("id", contactIds);

if (contactErr) {
  fatal(`Cannot fetch contacts: ${contactErr.message}`);
  process.exit(1);
}

type ContactRow = { id: string; company_id: string | null };
const rociCompanyIds = [
  ...new Set(
    ((contactRows ?? []) as ContactRow[])
      .map(r => r.company_id)
      .filter((id): id is string => id !== null),
  ),
];

row("ROCI contact rows",        contactIds.length);
row("Distinct ROCI company IDs", rociCompanyIds.length);

// ── Phase 3: Domain coverage ───────────────────────────────────────────────────

h("PHASE 3 — DOMAIN COVERAGE FOR 198 ROCI COMPANIES");

// Fetch in batches (Supabase .in() cap is 1000, 198 is fine)
const { data: companyRows, error: compErr } = await db
  .from("companies")
  .select("id, name, domain")
  .in("id", rociCompanyIds);

if (compErr) {
  fatal(`Cannot fetch company domains: ${compErr.message}`);
  process.exit(1);
}

type CompRow = { id: string; name: string; domain: string | null };
const companies = (companyRows ?? []) as CompRow[];

const companyDomains = new Map<string, string>();
const noDomain: string[] = [];

for (const c of companies) {
  if (c.domain && c.domain.trim()) {
    companyDomains.set(c.id, c.domain.trim());
  } else {
    noDomain.push(`${c.name} (id: ${c.id.slice(0, 8)})`);
  }
}

row("Companies with domain",     companyDomains.size);
row("Companies without domain",  noDomain.length);
row("Domain coverage %",         `${Math.round((companyDomains.size / rociCompanyIds.length) * 100)}%`);

if (noDomain.length > 0) {
  warn(`${noDomain.length} companies have no domain — PredictLeads will skip them:`);
  for (const n of noDomain.slice(0, 10)) console.log(`    ${n}`);
  if (noDomain.length > 10) console.log(`    … and ${noDomain.length - 10} more`);
}

// ── Phase 4: API request volume estimate ──────────────────────────────────────

h("PHASE 4 — API REQUEST VOLUME ESTIMATE");

const companiesWithDomain  = companyDomains.size;
const minRequests          = companiesWithDomain * MODULES_PER_COMPANY;          // 1 page each
const maxRequests          = companiesWithDomain * MODULES_PER_COMPANY * MAX_PAGES; // 10 pages each
const expectedRequests     = companiesWithDomain * MODULES_PER_COMPANY;          // realistic: most return 1 page

row("Companies that will be queried",         companiesWithDomain);
row("Modules per company",                    MODULES_PER_COMPANY);
row("  job_openings",                         "yes");
row("  financing_events",                     "yes");
row("Minimum API requests (1 page each)",     minRequests);
row("Maximum API requests (10 pages each)",   maxRequests);
row("Expected API requests (realistic)",      expectedRequests);
row("Page size (records per request)",        PAGE_SIZE);
row("Timeout per request",                    "15 seconds");
row("Rate limit handling",                    "429 → read Retry-After → sleep → 1 retry");
row("Max retry wait",                         "120 seconds");

// ── Phase 5: Signal types that will be ingested ────────────────────────────────

h("PHASE 5 — SIGNAL TYPES THAT WILL BE INGESTED");

console.log("  Module: job_openings → signal_type: job_posting (TTL=14d)");
console.log("  Module: financing_events → signal_type: funding_round (TTL=90d)");
console.log("");
console.log("  Types NOT ingested in Stage 30A:");
console.log("    news_events, technology_detections (deferred per provider design)");
console.log("    executive_hire, expansion, website_change, etc. (no PredictLeads module yet)");

// ── Phase 6: Deduplication behavior ───────────────────────────────────────────

h("PHASE 6 — DEDUPLICATION BEHAVIOR");

console.log("  Tier 1 dedup: PredictLeads record UUID as providerEventId");
console.log("    → dedup_key = sha256('predictleads:' + providerEventId)");
console.log("    → ON CONFLICT (dedup_key) DO NOTHING — no duplicate insert");
console.log("  Tier 2 dedup: content fingerprint (signal_type + occurred_at + title)");
console.log("  Tier 3: no dedup key (accept re-insert — rare)");
console.log("");
console.log("  Running twice is safe: same events → same dedup keys → 0 new rows");

// ── Phase 7: Tenant isolation ─────────────────────────────────────────────────

h("PHASE 7 — TENANT ISOLATION");

row("client_id hardcoded",           GRAMSCODE_ID);
row("Thread through",                "fetchEvents → normalizer → upsertSignal");
row("DB write: client_id column",    "signals.client_id = GRAMSCODE_ID on every row");
row("Cross-client write possible?",  "NO — clientId flows through every step");
row("account_intelligence mutations","WILL occur for companies receiving new signals");
row("  (rescoreCompany is called)",  "inside runIngestionCoordinator for each new signal");

// ── Phase 8: What Stage 30A will NOT do ──────────────────────────────────────

h("PHASE 8 — WHAT STAGE 30A WILL NOT DO");

console.log("  ✗ Rescore companies (rescoreCompany IS called inside coordinator)");
console.log("    NOTE: runIngestionCoordinator() automatically calls rescoreCompany()");
console.log("    for any company that receives a new signal. This creates");
console.log("    account_intelligence rows — it is part of the canonical ingestion.");
console.log("    If you want signal ingestion WITHOUT automatic rescoring, we need a");
console.log("    modified coordinator that skips the rescore step.");
console.log("");
console.log("  ✗ Modify ICP answers");
console.log("  ✗ Modify campaign strategy");
console.log("  ✗ Discover contacts");
console.log("  ✗ Enrich contacts");
console.log("  ✗ Call Smartlead");
console.log("  ✗ Send outreach");
console.log("  ✗ Modify schema");

// ── Phase 9: Exact pre-ingestion counts ───────────────────────────────────────

h("PHASE 9 — EXACT PRE-INGESTION COUNTS");

const { count: totalSig } = await db
  .from("signals")
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID);

const { count: rociSig } = await db
  .from("signals")
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID)
  .in("company_id", rociCompanyIds);

const { count: aiCount } = await db
  .from("account_intelligence")
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID)
  .in("company_id", rociCompanyIds);

const { count: totalAi } = await db
  .from("account_intelligence")
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID);

// Which ROCI companies already have a signal
const { data: existingRociSigRows } = await db
  .from("signals")
  .select("company_id")
  .eq("client_id", GRAMSCODE_ID)
  .in("company_id", rociCompanyIds);

const withSignal = new Set(((existingRociSigRows ?? []) as Array<{ company_id: string }>).map(r => r.company_id)).size;

row("Total Gramscode signals (all companies)", totalSig ?? 0);
row("ROCI companies with ≥1 signal (before)", withSignal);
row("Signals for 198 ROCI companies (before)", rociSig ?? 0);
row("account_intelligence rows for ROCI (before)", aiCount ?? 0);
row("account_intelligence rows total Gramscode",    totalAi ?? 0);

// ── Summary ────────────────────────────────────────────────────────────────────

h("STAGE 30A PRE-FLIGHT SUMMARY");

row("PredictLeads credentials",      isConfigured ? "PRESENT" : "MISSING ✗");
row("Companies to query",            companiesWithDomain);
row("Companies skipped (no domain)", noDomain.length);
row("Expected API requests",         expectedRequests);
row("Max possible API requests",     maxRequests);
row("Signals pre-ingestion (ROCI)",  rociSig ?? 0);
row("account_intelligence (ROCI)",   aiCount ?? 0);
row("");

console.log("");
console.log("  IMPORTANT: runIngestionCoordinator() automatically rescores companies");
console.log("  that receive new signals. This means account_intelligence rows WILL be");
console.log("  created as a side-effect of signal ingestion. If this is not acceptable,");
console.log("  a modified ingestion path (fetch+upsert only, no rescore) is needed.");
console.log("");
console.log("  Awaiting explicit approval before making any external API calls.");
