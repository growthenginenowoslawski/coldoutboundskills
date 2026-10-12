/**
 * Stage 30A — Signals-Only Ingestion (APPROVED — Option B).
 *
 * APPROVED MUTATIONS:
 *   INSERT into `signals` for the 198 ROCI companies via PredictLeads
 *   (job_openings + financing_events, page 1 only per company per module).
 *
 * EXPLICITLY EXCLUDED — these functions are intentionally NOT imported:
 *   rescoreCompany(), account_intelligence mutations
 *   ICP / campaign strategy modifications
 *   Contact discovery / enrichment / Smartlead / outreach
 *   Schema changes
 *
 * API BUDGET: 396 requests maximum.
 *   198 companies × 2 modules × 1 page each = exactly 396.
 *   Hard stop triggered before any request that would exceed 396.
 *
 * Why direct HTTP (not PredictLeadsSignalProvider):
 *   The provider's fetchModule() paginates up to MAX_PAGES=10 internally.
 *   Direct calls guarantee exactly page=1 per module, keeping us within budget.
 *
 * Provider error sanitization: sanitizeProviderError() is applied to every
 * caught exception before it is logged or stored, preventing credential leaks.
 *
 * Run: npx tsx scripts/stage30a-ingestion.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

// ── Approved imports ONLY ─────────────────────────────────────────────────────
// rescoreCompany is intentionally NOT imported.

import { getSupabaseAdmin }         from "../src/db/supabase.js";
import { normalizeBatch }           from "../src/providers/signals/normalizer.js";
import { upsertSignal }             from "../src/db/signals.js";
import { sanitizeProviderError }    from "../src/lib/provider-error-sanitizer.js";
import { optionalEnv, ENV_KEYS }    from "../src/config/env.js";
import type { RawSignalEvent, SignalProviderEvent } from "../src/domain/signal-types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const GRAMSCODE_ID    = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const STRATEGY_ID     = "48abf450-ccb1-49f3-94be-ac29c0531523";
const ROCI_LIST_ID    = "8ac556af-e520-4aa5-bc03-5369f206ed33";
const PL_BASE_URL     = "https://predictleads.com/api/v3";
const PAGE            = 1;
const PER_PAGE        = 100;
const REQUEST_TIMEOUT = 15_000; // ms
const MAX_RETRY_WAIT  = 120_000; // ms
const REQUEST_BUDGET  = 396;    // 198 companies × 2 modules × 1 page

// Only these two modules are approved. No others.
const APPROVED_MODULES = ["job_openings", "financing_events"] as const;
type Module = typeof APPROVED_MODULES[number];

// ── Helpers ────────────────────────────────────────────────────────────────────

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
function pass(msg: string): void { console.log(`  ✓ ${msg}`); }
function fail(msg: string): void { console.error(`  ✗ FAIL: ${msg}`); process.exitCode = 1; }
function warn(msg: string): void { console.log(`  ⚠ WARN: ${msg}`); }

// ── PredictLeads response types ────────────────────────────────────────────────

interface PLRecord {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}
interface PLResponse {
  data?: PLRecord[];
  meta?: { count?: number };
}

// ── Value extractors (mirrors predictleads-provider.ts private helpers) ────────

function asStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}
function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = parseFloat(v); if (Number.isFinite(n)) return n; }
  return null;
}
function asStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}
function normalizeTs(raw: string): string {
  return raw.includes("T") ? raw : `${raw}T00:00:00.000Z`;
}

const FINANCING_LABELS: Record<string, string> = {
  pre_seed: "Pre-Seed", seed: "Seed", angel: "Angel",
  series_a: "Series A", series_a_plus: "Series A+", series_b: "Series B",
  series_b1: "Series B1", series_c: "Series C", series_d: "Series D",
  series_e: "Series E", series_f: "Series F", series_g: "Series G",
  series_h: "Series H", series_i: "Series I", series_j: "Series J",
  venture: "Venture", private_equity: "Private Equity",
  convertible_note: "Convertible Note", debt_financing: "Debt Financing",
  grant: "Grant", corporate_round: "Corporate Round",
  secondary_market: "Secondary Market",
  post_ipo_equity: "Post-IPO Equity", post_ipo_debt: "Post-IPO Debt",
};

// ── Mappers ────────────────────────────────────────────────────────────────────

function mapJobOpening(record: PLRecord, domain: string): RawSignalEvent | null {
  const a     = record.attributes;
  const title = asStr(a.title);
  if (!title) return null;

  const firstSeenAt = asStr(a.first_seen_at);
  const postedAt    = asStr(a.posted_at) ?? firstSeenAt;
  if (!postedAt) return null;

  const category  = asStr(a.category);
  const seniority = asStr(a.seniority);
  const url       = asStr(a.url) ?? asStr(a.source_url);
  const desc      = asStr(a.description);

  const evidence: Record<string, unknown> = { event: "job_posting", title, domain };
  if (category) evidence.category = category;
  if (seniority) evidence.seniority = seniority;

  const sigTitle = seniority ? `Hiring: ${seniority} ${title}` : `Hiring: ${title}`;

  return {
    providerEventId: record.id,
    source:          "predictleads",
    signalType:      "job_posting",
    title:           sigTitle.slice(0, 120),
    description:     desc ?? undefined,
    evidence,
    occurredAt:      normalizeTs(postedAt),
    sourceUrl:       url ?? undefined,
    metadata: {
      first_seen_at: firstSeenAt,
      last_seen_at:  asStr(a.last_seen_at),
    },
  };
}

function mapFinancingEvent(record: PLRecord, domain: string): RawSignalEvent | null {
  const a        = record.attributes;
  const foundAt  = asStr(a.found_at);
  const effDate  = asStr(a.effective_date);
  const occurred = effDate ?? foundAt;
  if (!occurred) return null;

  const financingType   = asStr(a.financing_type) ?? "unknown";
  const roundLabel      = FINANCING_LABELS[financingType] ?? financingType;
  const amount          = asNum(a.amount);
  const amountNorm      = asStr(a.amount_normalized);
  const investors       = asStrArr(a.investors);

  const evidence: Record<string, unknown> = {
    event: "funding_round", financing_type: financingType, round: roundLabel, domain,
  };
  if (amount != null) evidence.amount = amount;
  if (amountNorm) evidence.amount_normalized = amountNorm;
  if (investors.length > 0) evidence.investors = investors;

  const title = amount != null
    ? `${roundLabel} funding round closed`
    : `${roundLabel} funding announced`;

  return {
    providerEventId: record.id,
    source:          "predictleads",
    signalType:      "funding_round",
    title,
    evidence,
    occurredAt:      normalizeTs(occurred),
    metadata: { found_at: foundAt, effective_date: effDate },
  };
}

// ── HTTP fetch with 429 retry ──────────────────────────────────────────────────

async function plFetch(
  url: string,
  apiKey: string,
  apiToken: string,
): Promise<PLResponse> {
  const headers = {
    "X-Api-Key":   apiKey,
    "X-Api-Token": apiToken,
    "Accept":      "application/json",
  };

  const resp = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });

  if (resp.status === 429) {
    const retryAfter = resp.headers.get("Retry-After");
    const waitMs = Math.min(
      Math.max(retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000, 1_000),
      MAX_RETRY_WAIT,
    );
    warn(`429 from PredictLeads — waiting ${waitMs}ms before retry`);
    await new Promise(r => setTimeout(r, waitMs));

    const retry = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });
    if (!retry.ok) {
      throw new Error(`PredictLeads API error ${retry.status} (after retry)`);
    }
    return (await retry.json()) as PLResponse;
  }

  if (!resp.ok) {
    throw new Error(`PredictLeads API error ${resp.status}`);
  }
  return (await resp.json()) as PLResponse;
}

// ── DB client ─────────────────────────────────────────────────────────────────

const db = getSupabaseAdmin();

// ── Phase 0: Pre-flight confirmation ──────────────────────────────────────────

h("PHASE 0 — PRE-FLIGHT CONFIRMATION");

// Confirm credentials
const apiKey   = optionalEnv(ENV_KEYS.predictleadsApiKey);
const apiToken = optionalEnv(ENV_KEYS.predictleadsApiToken);
if (!apiKey || !apiToken) {
  console.error("FATAL: PredictLeads credentials missing — aborting.");
  process.exit(1);
}
pass("PredictLeads credentials present (values redacted)");

// Guard: confirm rescoreCompany is NOT called (hard-coded evidence)
row("rescoreCompany imported?",          "NO — intentionally excluded");
row("account_intelligence mutations?",   "NO — signals table only");
row("Modules approved",                  APPROVED_MODULES.join(", "));
row("Page limit per module per company", `${PAGE} (hard-coded)`);
row("Per-page limit",                    PER_PAGE);
row("Request budget",                    REQUEST_BUDGET);

// Confirm pre-ingestion baseline is still as expected from preflight
const { count: preCheckSig } = await db
  .from("signals")
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID);

const { count: preCheckAi } = await db
  .from("account_intelligence")
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID);

row("Gramscode signals (pre-ingestion)",            preCheckSig  ?? 0);
row("Gramscode account_intelligence (pre-ingestion)", preCheckAi ?? 0);

// ── Phase 1: Fetch 198 ROCI company IDs and domains ───────────────────────────

h("PHASE 1 — FETCH 198 ROCI COMPANY IDs AND DOMAINS");

const { data: memberRows, error: memberErr } = await db
  .from("list_members")
  .select("contact_id")
  .eq("list_id", ROCI_LIST_ID)
  .not("contact_id", "is", null);

if (memberErr) { console.error("FATAL:", memberErr.message); process.exit(1); }

type MemberRow = { contact_id: string | null };
const contactIds = ((memberRows ?? []) as MemberRow[])
  .filter(r => r.contact_id).map(r => r.contact_id as string);

const { data: contactRows, error: contactErr } = await db
  .from("contacts").select("id, company_id").in("id", contactIds);
if (contactErr) { console.error("FATAL:", contactErr.message); process.exit(1); }

type ContactRow = { id: string; company_id: string | null };
const rociCompanyIds = [
  ...new Set(
    ((contactRows ?? []) as ContactRow[]).map(r => r.company_id).filter((id): id is string => id !== null),
  ),
];
row("Distinct ROCI company IDs", rociCompanyIds.length);

if (rociCompanyIds.length !== 198) {
  fail(`Expected 198 ROCI companies, got ${rociCompanyIds.length}`);
}

// Fetch domains
const { data: compRows, error: compErr } = await db
  .from("companies").select("id, name, domain").in("id", rociCompanyIds);
if (compErr) { console.error("FATAL:", compErr.message); process.exit(1); }

type CompRow = { id: string; name: string; domain: string | null };
const companyMeta = new Map<string, CompRow>();
const companyDomains = new Map<string, string>();
const noDomain: string[] = [];

for (const c of (compRows ?? []) as CompRow[]) {
  companyMeta.set(c.id, c);
  if (c.domain?.trim()) {
    companyDomains.set(c.id, c.domain.trim());
  } else {
    noDomain.push(c.name);
  }
}

row("Companies with domain (will be queried)", companyDomains.size);
row("Companies without domain (skipped)",      noDomain.length);

if (noDomain.length > 0) {
  warn(`Skipping ${noDomain.length} companies without domain: ${noDomain.slice(0, 3).join(", ")}`);
}

const totalExpectedRequests = companyDomains.size * APPROVED_MODULES.length;
row("Exact API requests this run", totalExpectedRequests);

if (totalExpectedRequests > REQUEST_BUDGET) {
  console.error(`FATAL: ${totalExpectedRequests} requests would exceed budget of ${REQUEST_BUDGET}. Aborting.`);
  process.exit(1);
}
pass(`Request count ${totalExpectedRequests} ≤ budget ${REQUEST_BUDGET}`);

// ── Phase 2: Capture immutability baselines ────────────────────────────────────

h("PHASE 2 — IMMUTABILITY BASELINES");

const BEFORE_SIG    = preCheckSig  ?? 0;
const BEFORE_AI     = preCheckAi   ?? 0;

const { count: beforeCamp }     = await db.from("campaigns").select("*",         { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: beforeStrat }    = await db.from("campaign_strategies").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: beforeIcp }      = await db.from("icp_onboarding").select("*",    { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: beforeContacts } = await db.from("contacts").select("*",          { count: "exact", head: true });
const { count: beforeQual }     = await db.from("account_campaign_qualification").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID).eq("campaign_strategy_id", STRATEGY_ID);

row("signals (GRAMSCODE, before)",                    BEFORE_SIG);
row("account_intelligence (GRAMSCODE, before)",       BEFORE_AI);
row("campaigns (GRAMSCODE, before)",                  beforeCamp  ?? 0);
row("campaign_strategies (GRAMSCODE, before)",        beforeStrat ?? 0);
row("icp_onboarding (GRAMSCODE, before)",             beforeIcp   ?? 0);
row("contacts (global, before)",                      beforeContacts ?? 0);
row("account_campaign_qualification (ROCI, before)",  beforeQual  ?? 0);

// ── Phase 3: Signals-only ingestion ───────────────────────────────────────────

h("PHASE 3 — SIGNALS-ONLY INGESTION");
console.log("  NOTE: rescoreCompany() is NOT called in this loop.");
console.log("  account_intelligence will NOT be modified.");
console.log("");

const DETECTED_AT = new Date().toISOString();
let requestCount = 0;

// Per-company tracking
const companyResults: Array<{
  companyId: string;
  domain: string;
  requestsMade: number;
  eventsFetched: number;
  signalsInserted: number;
  signalsDuplicated: number;
  normalizationErrors: number;
  upsertErrors: number;
  providerError: string | null;
}> = [];

// Signal type breakdown
const insertedByType = new Map<string, number>();
const insertedByStatus = new Map<string, number>();

// Idempotency tracking for post-run
let totalInserted  = 0;
let totalDuplicated = 0;
let totalNormErrors = 0;
let totalUpsertErrors = 0;
let companiesWithNewSignals = 0;
const providerErrors: Record<string, string> = {};

for (const companyId of rociCompanyIds) {
  const domain = companyDomains.get(companyId);
  if (!domain) {
    // No domain — skip silently (counted above)
    continue;
  }

  const meta = companyMeta.get(companyId);
  const result = {
    companyId,
    domain,
    requestsMade:       0,
    eventsFetched:      0,
    signalsInserted:    0,
    signalsDuplicated:  0,
    normalizationErrors: 0,
    upsertErrors:       0,
    providerError:      null as string | null,
  };

  try {
    const events: SignalProviderEvent[] = [];

    for (const module of APPROVED_MODULES) {
      // Hard stop guard — checked BEFORE each request
      if (requestCount >= REQUEST_BUDGET) {
        console.error(`\nHARD STOP: Request budget of ${REQUEST_BUDGET} reached. Halting batch.`);
        console.error(`  Companies processed so far: ${companyResults.length}`);
        process.exitCode = 1;
        break;
      }

      const url = `${PL_BASE_URL}/companies/${encodeURIComponent(domain)}/${module}?page=${PAGE}&per_page=${PER_PAGE}`;
      requestCount++;
      result.requestsMade++;

      let records: PLRecord[] = [];
      try {
        const body = await plFetch(url, apiKey, apiToken);
        records = body.data ?? [];
      } catch (fetchErr) {
        const sanitized = sanitizeProviderError(fetchErr);
        warn(`  ${domain} [${module}] fetch error: ${sanitized}`);
        providerErrors[`${companyId}:${module}`] = sanitized;
        continue;
      }

      // Map records to RawSignalEvent
      for (const record of records) {
        let rawEvent: RawSignalEvent | null = null;
        if (module === "job_openings") {
          rawEvent = mapJobOpening(record, domain);
        } else if (module === "financing_events") {
          rawEvent = mapFinancingEvent(record, domain);
        }
        if (rawEvent) {
          events.push({ companyId, clientId: GRAMSCODE_ID, rawEvent });
        }
      }
    }

    result.eventsFetched = events.length;

    // Normalize
    const outcomes = normalizeBatch(events, DETECTED_AT);

    // Upsert (no rescore)
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        result.normalizationErrors++;
        totalNormErrors++;
        warn(`  Normalization error for ${domain}: ${outcome.error}`);
        continue;
      }

      try {
        const { created } = await upsertSignal(outcome.signal);
        if (created) {
          result.signalsInserted++;
          totalInserted++;
          const st = outcome.signal.signalType;
          insertedByType.set(st, (insertedByType.get(st) ?? 0) + 1);
        } else {
          result.signalsDuplicated++;
          totalDuplicated++;
        }
      } catch (upsertErr) {
        const sanitized = sanitizeProviderError(upsertErr);
        result.upsertErrors++;
        totalUpsertErrors++;
        warn(`  Upsert error for ${domain}: ${sanitized}`);
      }
    }

    if (result.signalsInserted > 0) companiesWithNewSignals++;

  } catch (companyErr) {
    const sanitized = sanitizeProviderError(companyErr);
    result.providerError = sanitized;
    providerErrors[companyId] = sanitized;
    warn(`  Company-level error for ${domain}: ${sanitized}`);
  }

  companyResults.push(result);
}

// ── Phase 4: Post-ingestion counts ────────────────────────────────────────────

h("PHASE 4 — POST-INGESTION COUNTS");

const { count: afterSig } = await db
  .from("signals").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);

const { count: afterAi } = await db
  .from("account_intelligence").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);

const { count: afterCamp }     = await db.from("campaigns").select("*",           { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: afterStrat }    = await db.from("campaign_strategies").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: afterIcp }      = await db.from("icp_onboarding").select("*",      { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: afterContacts } = await db.from("contacts").select("*",            { count: "exact", head: true });
const { count: afterQual }     = await db.from("account_campaign_qualification").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID).eq("campaign_strategy_id", STRATEGY_ID);

const AFTER_SIG = afterSig ?? 0;
const AFTER_AI  = afterAi  ?? 0;
const sigDelta  = AFTER_SIG - BEFORE_SIG;
const aiDelta   = AFTER_AI  - BEFORE_AI;

row("signals BEFORE",              BEFORE_SIG);
row("signals AFTER",               AFTER_SIG);
row("signals DELTA",               sigDelta >= 0 ? `+${sigDelta}` : String(sigDelta));
row("account_intelligence BEFORE", BEFORE_AI);
row("account_intelligence AFTER",  AFTER_AI);
row("account_intelligence DELTA",  aiDelta  >= 0 ? `+${aiDelta}`  : String(aiDelta));

// ── Phase 5: Immutability audit ────────────────────────────────────────────────

h("PHASE 5 — IMMUTABILITY AUDIT");

const campOk  = (afterCamp     ?? 0) === (beforeCamp     ?? 0);
const stratOk = (afterStrat    ?? 0) === (beforeStrat    ?? 0);
const icpOk   = (afterIcp      ?? 0) === (beforeIcp      ?? 0);
const conOk   = (afterContacts ?? 0) === (beforeContacts ?? 0);
const qualOk  = (afterQual     ?? 0) === (beforeQual     ?? 0);
const aiOk    = aiDelta === 0;

if (campOk)  { pass("campaigns unchanged"); } else { fail(`campaigns changed: ${beforeCamp} → ${afterCamp}`); }
if (stratOk) { pass("campaign_strategies unchanged"); } else { fail(`campaign_strategies changed`); }
if (icpOk)   { pass("icp_onboarding unchanged"); } else { fail(`icp_onboarding changed`); }
if (conOk)   { pass("contacts unchanged"); } else { fail(`contacts changed: ${beforeContacts} → ${afterContacts}`); }
if (qualOk)  { pass("account_campaign_qualification unchanged"); } else { fail(`account_campaign_qualification changed`); }
if (aiOk)    { pass("account_intelligence UNCHANGED — no rescore occurred"); }
else         { fail(`account_intelligence changed by ${aiDelta} — rescore may have fired`); }

// ── Phase 6: Signal detail report ─────────────────────────────────────────────

h("PHASE 6 — INGESTION RESULTS");

row("Total API requests made",          requestCount);
row("Request budget",                   REQUEST_BUDGET);
row("Budget remaining",                 REQUEST_BUDGET - requestCount);
row("");
row("Companies queried",                companyResults.length);
row("Companies with new signals",       companiesWithNewSignals);
row("Companies with 0 new signals",     companyResults.length - companiesWithNewSignals);
row("Companies with provider errors",   Object.keys(providerErrors).length);
row("");
row("Total events fetched from API",    companyResults.reduce((s, r) => s + r.eventsFetched, 0));
row("New signals persisted",            totalInserted);
row("Duplicate signals (dedup hit)",    totalDuplicated);
row("Normalization errors",             totalNormErrors);
row("Upsert errors",                    totalUpsertErrors);

sub("Signal type distribution (inserted)");
if (insertedByType.size === 0) {
  console.log("  (no new signals inserted)");
} else {
  for (const [type, count] of [...insertedByType.entries()].sort((a, b) => b[1] - a[1])) {
    row(`  ${type}`, count);
  }
}

// ── Phase 7: Freshness / TTL distribution of newly inserted signals ────────────

h("PHASE 7 — FRESHNESS DISTRIBUTION OF NEWLY INSERTED SIGNALS");

if (sigDelta > 0) {
  // Fetch the newly inserted signals for ROCI companies
  const { data: newSigRows } = await db
    .from("signals")
    .select("signal_type, occurred_at, expires_at, status")
    .eq("client_id", GRAMSCODE_ID)
    .in("company_id", rociCompanyIds)
    .order("occurred_at", { ascending: false });

  type NSRow = { signal_type: string; occurred_at: string; expires_at: string | null; status: string };
  const newSigs = (newSigRows ?? []) as NSRow[];
  const now = new Date();

  const ageGroups = { "0-7d": 0, "8-14d": 0, "15-30d": 0, "31-90d": 0, "90+d": 0 };
  const activeCount  = newSigs.filter(s => s.status === "active").length;
  const expiredCount = newSigs.filter(s => s.status === "expired").length;

  for (const s of newSigs) {
    const ageDays = (now.getTime() - new Date(s.occurred_at).getTime()) / 86_400_000;
    if      (ageDays <=  7) ageGroups["0-7d"]++;
    else if (ageDays <= 14) ageGroups["8-14d"]++;
    else if (ageDays <= 30) ageGroups["15-30d"]++;
    else if (ageDays <= 90) ageGroups["31-90d"]++;
    else                    ageGroups["90+d"]++;
  }

  row("Total signals for ROCI (after ingestion)", newSigs.length);
  row("  status=active",                          activeCount);
  row("  status=expired",                         expiredCount);

  sub("Age since occurred_at");
  for (const [bucket, count] of Object.entries(ageGroups)) {
    row(`  ${bucket}`, count);
  }
} else {
  console.log("  (no new signals were inserted — no freshness data to report)");
}

// ── Phase 8: Top companies by signal count ─────────────────────────────────────

h("PHASE 8 — TOP ROCI COMPANIES BY NEW SIGNALS");

const topByInserted = companyResults
  .filter(r => r.signalsInserted > 0)
  .sort((a, b) => b.signalsInserted - a.signalsInserted)
  .slice(0, 10);

if (topByInserted.length === 0) {
  console.log("  (no new signals for any ROCI company)");
} else {
  for (const r of topByInserted) {
    const m = companyMeta.get(r.companyId);
    console.log(`  ${(m?.name ?? r.domain).padEnd(40)} ${r.domain.padEnd(35)} inserted: ${r.signalsInserted}, dup: ${r.signalsDuplicated}`);
  }
}

// ── Phase 9: Provider errors ───────────────────────────────────────────────────

h("PHASE 9 — PROVIDER ERRORS (sanitized)");

if (Object.keys(providerErrors).length === 0) {
  pass("No provider errors");
} else {
  for (const [key, msg] of Object.entries(providerErrors)) {
    console.log(`  ${key}: ${msg}`);
  }
}

// ── Phase 10: Idempotency result ───────────────────────────────────────────────

h("PHASE 10 — IDEMPOTENCY");

if (totalInserted > 0) {
  console.log("  Idempotency note: all inserted signals have a dedup_key from PredictLeads");
  console.log("  record UUID (tier-1) or content fingerprint (tier-2).");
  console.log("  Re-running this script will find the same signals and report them as");
  console.log("  duplicates (created: false), leaving the DB state unchanged.");
  console.log("  A safe re-run is possible within the same 396-request budget.");
} else {
  console.log("  No new signals inserted — re-run would produce identical results.");
}

// ── Final summary ──────────────────────────────────────────────────────────────

h("STAGE 30A FINAL SUMMARY");

row("API requests made",              requestCount);
row("Budget remaining",               REQUEST_BUDGET - requestCount);
row("Companies queried",              companyResults.length);
row("Companies with new signals",     companiesWithNewSignals);
row("New signals persisted (delta)",  `+${totalInserted}`);
row("Duplicates rejected",            totalDuplicated);
row("Provider errors",                Object.keys(providerErrors).length);
row("");
row("signals BEFORE → AFTER",        `${BEFORE_SIG} → ${AFTER_SIG} (delta: +${sigDelta})`);
row("account_intelligence BEFORE → AFTER", `${BEFORE_AI} → ${AFTER_AI} (delta: ${aiDelta})`);
row("");

if (aiOk) {
  pass("account_intelligence UNCHANGED — Stage 30B (rescore) not yet approved");
} else {
  fail("account_intelligence was unexpectedly modified");
}

if (process.exitCode === 1) {
  console.log("\n  Stage 30A completed with failures. See FAIL entries above.");
} else {
  console.log("\n  Stage 30A complete. Awaiting Stage 30B approval before rescore.");
}
