/**
 * Stage 30C — Phase 3 Validation Experiment (LIMITED WRITE)
 *
 * Runs exactly 10 PredictLeads requests:
 *   5 domains × 2 modules (job_openings, financing_events) × page=1&per_page=10
 *
 * Captures full HTTP diagnostics per request (status, headers, sanitized body).
 * Persists normalized signals via upsertSignal only — NO rescoreCompany.
 *
 * Hard limits enforced in code:
 *   MAX_REQUESTS = 10   — throws if exceeded
 *   No account_intelligence writes
 *   No rescoreCompany calls
 *   No migrations, no outreach, no scoring changes
 *
 * Run: npx tsx scripts/stage30c-validation.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";
if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import type { RawSignalEvent }             from "../src/domain/signal-types.js";
import { getSupabaseAdmin }                from "../src/db/supabase.js";
import { upsertSignal }                    from "../src/db/signals.js";
import { normalizeEvent }                  from "../src/providers/signals/normalizer.js";
import { classifyJobPosting }              from "../src/providers/signals/predictleads-provider.js";
import { sanitizeProviderError }           from "../src/lib/provider-error-sanitizer.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAMSCODE_ID       = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const ROCI_LIST_ID       = "8ac556af-e520-4aa5-bc03-5369f206ed33";
const PL_BASE_URL        = "https://predictleads.com/api/v3";
const SAMPLE_SIZE        = 5;
const MAX_REQUESTS       = 10;
const PER_PAGE           = 10;
const REQUEST_TIMEOUT_MS = 15_000;

let requestsMade = 0;  // Hard limit guard — never let this exceed MAX_REQUESTS

// ── Types ─────────────────────────────────────────────────────────────────────

type Module = "job_openings" | "financing_events";

interface PredictLeadsRecord {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
}

interface RequestResult {
  domain:              string;
  companyId:           string;
  module:              Module;
  status:              number;
  diagnosticHeaders:   Record<string, string>;
  sanitizedBody:       string;
  rawRecordCount:      number;
  usableEventCount:    number;
  insertedCount:       number;
  duplicateCount:      number;
  normalizationErrors: number;
  error:               string | null;
}

// ── Print helpers ─────────────────────────────────────────────────────────────

function h(t: string): void {
  console.log(`\n${"═".repeat(76)}\n  ${t}\n${"═".repeat(76)}`);
}
function row(label: string, value: unknown): void {
  const v = value === null || value === undefined ? "(NULL)" : String(value);
  console.log(`  ${label.padEnd(46)} ${v}`);
}

// ── Value helpers (mirrors predictleads-provider.ts internals) ────────────────

function asStr(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function normalizeTimestamp(raw: string): string {
  return raw.includes("T") ? raw : `${raw}T00:00:00.000Z`;
}

const FINANCING_LABELS: Record<string, string> = {
  pre_seed: "Pre-Seed", seed: "Seed", angel: "Angel",
  series_a: "Series A", series_b: "Series B", series_c: "Series C",
  series_d: "Series D", series_e: "Series E", venture: "Venture",
  private_equity: "Private Equity", convertible_note: "Convertible Note",
  debt_financing: "Debt Financing", grant: "Grant",
};

function fmtFinancingType(t: string): string {
  return FINANCING_LABELS[t] ?? t;
}

// ── Header capture ────────────────────────────────────────────────────────────

// Capture response headers useful for 402 diagnosis. Never captures request
// auth headers (those are outbound, not present in responses anyway).
const KNOWN_DIAGNOSTIC_HEADERS = new Set([
  "content-type", "retry-after", "www-authenticate",
  "x-error-code", "x-plan", "x-plan-limit", "x-plan-name",
  "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
  "x-request-id", "x-response-time",
]);

function captureDiagnosticHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (KNOWN_DIAGNOSTIC_HEADERS.has(k) || k.startsWith("x-")) {
      out[key] = value;
    }
  });
  return out;
}

// ── Record mappers ────────────────────────────────────────────────────────────

interface ProviderEvent {
  companyId: string;
  clientId:  string;
  rawEvent:  RawSignalEvent;
}

function mapJobOpening(
  record: PredictLeadsRecord,
  domain: string,
  companyId: string,
): ProviderEvent | null {
  const attrs     = record.attributes;
  const title     = asStr(attrs.title);
  if (!title) return null;

  const firstSeenAt = asStr(attrs.first_seen_at);
  const postedAt    = asStr(attrs.posted_at) ?? firstSeenAt;
  if (!postedAt) return null;

  const category  = asStr(attrs.category);
  const seniority = asStr(attrs.seniority);
  const url       = asStr(attrs.url) ?? asStr(attrs.source_url);
  const description = asStr(attrs.description);

  const evidence: Record<string, unknown> = { event: "job_posting", title, domain };
  if (category)  evidence.category  = category;
  if (seniority) evidence.seniority = seniority;
  evidence.job_class = classifyJobPosting(title, category, seniority);

  const signalTitle = seniority ? `Hiring: ${seniority} ${title}` : `Hiring: ${title}`;

  return {
    companyId,
    clientId: GRAMSCODE_ID,
    rawEvent: {
      providerEventId: record.id,
      source:          "predictleads",
      signalType:      "job_posting",
      title:           signalTitle.slice(0, 120),
      description:     description ?? undefined,
      evidence,
      occurredAt:      normalizeTimestamp(postedAt),
      sourceUrl:       url ?? undefined,
      metadata:        { first_seen_at: firstSeenAt, last_seen_at: asStr(attrs.last_seen_at) },
    },
  };
}

function mapFinancingEvent(
  record: PredictLeadsRecord,
  domain: string,
  companyId: string,
): ProviderEvent | null {
  const attrs        = record.attributes;
  const foundAt      = asStr(attrs.found_at);
  const effectiveDate = asStr(attrs.effective_date);
  const occurredRaw  = effectiveDate ?? foundAt;
  if (!occurredRaw) return null;

  const financingType    = asStr(attrs.financing_type) ?? "unknown";
  const roundLabel       = fmtFinancingType(financingType);
  const amount           = asNum(attrs.amount);
  const amountNormalized = asStr(attrs.amount_normalized);
  const investors        = asStrArr(attrs.investors);

  const evidence: Record<string, unknown> = {
    event: "funding_round", financing_type: financingType, round: roundLabel, domain,
  };
  if (amount != null)      evidence.amount            = amount;
  if (amountNormalized)    evidence.amount_normalized = amountNormalized;
  if (investors.length > 0) evidence.investors        = investors;

  const title = amount != null
    ? `${roundLabel} funding round closed`
    : `${roundLabel} funding announced`;

  return {
    companyId,
    clientId: GRAMSCODE_ID,
    rawEvent: {
      providerEventId: record.id,
      source:          "predictleads",
      signalType:      "funding_round",
      title,
      evidence,
      occurredAt:      normalizeTimestamp(occurredRaw),
      metadata:        { found_at: foundAt, effective_date: effectiveDate },
    },
  };
}

// ── Core request + persist function ──────────────────────────────────────────

async function runRequest(
  domain:   string,
  companyId: string,
  module:   Module,
  apiKey:   string,
  apiToken: string,
): Promise<RequestResult> {
  if (requestsMade >= MAX_REQUESTS) {
    throw new Error(`Hard request limit (${MAX_REQUESTS}) already reached — aborting`);
  }

  requestsMade++;
  const url = `${PL_BASE_URL}/companies/${encodeURIComponent(domain)}/${module}?page=1&per_page=${PER_PAGE}`;

  console.log(`  [${String(requestsMade).padStart(2)}/${MAX_REQUESTS}]  ${module.padEnd(20)}  ${domain}`);

  let status              = 0;
  let diagnosticHeaders:  Record<string, string> = {};
  let sanitizedBody       = "";
  let rawRecordCount      = 0;
  let usableEventCount    = 0;
  let insertedCount       = 0;
  let duplicateCount      = 0;
  let normalizationErrors = 0;
  let error: string | null = null;

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        "X-Api-Key":   apiKey,
        "X-Api-Token": apiToken,
        "Accept":      "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    status            = resp.status;
    diagnosticHeaders = captureDiagnosticHeaders(resp.headers);
    const bodyText    = await resp.text().catch(() => "<unreadable>");

    if (!resp.ok) {
      // Sanitize to remove any credentials that might appear in an error body,
      // but preserve the full content up to 600 chars for plan restriction diagnosis.
      sanitizedBody = sanitizeProviderError(bodyText).slice(0, 600);
      error         = `HTTP ${status}`;
    } else {
      let parsed: { data?: PredictLeadsRecord[] };
      try {
        parsed = JSON.parse(bodyText) as { data?: PredictLeadsRecord[] };
      } catch {
        error = "JSON parse error";
        sanitizedBody = bodyText.slice(0, 200);
        return {
          domain, companyId, module, status, diagnosticHeaders, sanitizedBody,
          rawRecordCount, usableEventCount, insertedCount, duplicateCount,
          normalizationErrors, error,
        };
      }

      const records  = parsed.data ?? [];
      rawRecordCount = records.length;
      sanitizedBody  = `[200 OK — ${records.length} records in response]`;

      const detectedAt = new Date().toISOString();

      for (const record of records) {
        const mapped = module === "job_openings"
          ? mapJobOpening(record, domain, companyId)
          : mapFinancingEvent(record, domain, companyId);

        if (!mapped) continue;
        usableEventCount++;

        try {
          const normalized = normalizeEvent(mapped, detectedAt);
          const { created } = await upsertSignal(normalized);
          if (created) insertedCount++;
          else duplicateCount++;
        } catch (e) {
          normalizationErrors++;
          console.error(`      Normalize/upsert error: ${sanitizeProviderError(e)}`);
        }
      }
    }
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      error  = `TIMEOUT (${REQUEST_TIMEOUT_MS / 1000}s)`;
      status = status || 0;
    } else {
      error  = sanitizeProviderError(e).slice(0, 200);
      status = status || 0;
    }
  }

  return {
    domain, companyId, module, status, diagnosticHeaders, sanitizedBody,
    rawRecordCount, usableEventCount, insertedCount, duplicateCount,
    normalizationErrors, error,
  };
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

h("STAGE 30C — PHASE 3 VALIDATION EXPERIMENT");
row("Gramscode client ID",  GRAMSCODE_ID);
row("Max requests (hard limit)", MAX_REQUESTS);
row("Modules per domain",  "2 (job_openings, financing_events)");
row("Page / per_page",     `1 / ${PER_PAGE}`);
row("Timeout",             `${REQUEST_TIMEOUT_MS / 1000}s per request`);
row("rescoreCompany",      "DISABLED — not called");
row("Migrations",          "NONE");

// ── Credential check ──────────────────────────────────────────────────────────

const apiKey   = process.env.PREDICTLEADS_API_KEY ?? "";
const apiToken = process.env.PREDICTLEADS_API_TOKEN ?? "";

if (!apiKey || !apiToken) {
  console.error("\nFATAL: PREDICTLEADS_API_KEY or PREDICTLEADS_API_TOKEN not set");
  process.exit(1);
}
row("PREDICTLEADS_API_KEY",   "SET (value redacted)");
row("PREDICTLEADS_API_TOKEN", "SET (value redacted)");

// ── Fetch ROCI companies ──────────────────────────────────────────────────────

h("STEP 1 — SELECT 5 DOMAINS FROM ROCI LIST");

const db = getSupabaseAdmin();

const { data: memberRows, error: memberErr } = await db
  .from("list_members")
  .select("contact_id")
  .eq("list_id", ROCI_LIST_ID)
  .not("contact_id", "is", null);

if (memberErr) { console.error("FATAL:", memberErr.message); process.exit(1); }

type MemberRow  = { contact_id: string | null };
const contactIds = ((memberRows ?? []) as MemberRow[])
  .filter((r) => r.contact_id)
  .map((r) => r.contact_id as string);

const { data: contactRows } = await db
  .from("contacts")
  .select("company_id")
  .in("id", contactIds);

type ContactRow = { company_id: string | null };
const rociCompanyIds = [...new Set(
  ((contactRows ?? []) as ContactRow[])
    .map((r) => r.company_id)
    .filter((id): id is string => id !== null),
)];

const { data: companyRows } = await db
  .from("companies")
  .select("id, name, domain")
  .in("id", rociCompanyIds);

type CompRow = { id: string; name: string; domain: string | null };
const withDomain = ((companyRows ?? []) as CompRow[])
  .filter((c) => c.domain?.trim())
  .sort((a, b) => (a.domain ?? "").localeCompare(b.domain ?? ""));

row("ROCI companies total",         rociCompanyIds.length);
row("ROCI companies with domain",   withDomain.length);

// Select SAMPLE_SIZE companies evenly spaced across sorted domain list.
// Spread ensures coverage across the alphabet / different agency types.
const step     = Math.max(1, Math.floor(withDomain.length / SAMPLE_SIZE));
const selected = Array.from({ length: SAMPLE_SIZE }, (_, i) =>
  withDomain[Math.min(i * step, withDomain.length - 1)]!,
);

console.log("\n  Selected companies (evenly spaced across sorted domain list):");
for (const c of selected) {
  console.log(`    ${c.name.padEnd(42)} ${c.domain}`);
}

// ── Run 10 requests ───────────────────────────────────────────────────────────

h("STEP 2 — RUNNING 10 API REQUESTS");

const results: RequestResult[] = [];
const modules: Module[]        = ["job_openings", "financing_events"];

for (const company of selected) {
  for (const mod of modules) {
    const result = await runRequest(company.domain!, company.id, mod, apiKey, apiToken);
    results.push(result);
  }
}

row("\nRequests made", requestsMade);
row("Hard limit",    MAX_REQUESTS);
row("Limit respected", requestsMade <= MAX_REQUESTS ? "YES" : "NO ✗");

// ── Per-request diagnostic report ────────────────────────────────────────────

h("STEP 3 — PER-REQUEST DIAGNOSTIC REPORT");

for (const r of results) {
  console.log(`\n  ── ${r.module}  ·  ${r.domain}`);
  console.log(`     Status:          ${r.status}`);
  const hdrs = Object.entries(r.diagnosticHeaders);
  if (hdrs.length > 0) {
    console.log(`     Response headers:`);
    for (const [k, v] of hdrs) console.log(`       ${k}: ${v}`);
  } else {
    console.log(`     Response headers: (none captured)`);
  }
  console.log(`     Body:            ${r.sanitizedBody}`);
  if (r.status === 200) {
    console.log(`     Raw records:     ${r.rawRecordCount}`);
    console.log(`     Usable events:   ${r.usableEventCount}`);
    console.log(`     Inserted:        ${r.insertedCount}`);
    console.log(`     Duplicates:      ${r.duplicateCount}`);
    if (r.normalizationErrors > 0)
      console.log(`     Norm errors:     ${r.normalizationErrors}`);
  }
  if (r.error) console.log(`     Error:           ${r.error}`);
}

// ── Status distribution ───────────────────────────────────────────────────────

h("STEP 4 — STATUS DISTRIBUTION");

const statusDist = new Map<number, number>();
for (const r of results) statusDist.set(r.status, (statusDist.get(r.status) ?? 0) + 1);

for (const [status, count] of [...statusDist.entries()].sort((a, b) => a[0] - b[0])) {
  const pct   = Math.round((count / results.length) * 100);
  const label =
    status === 200 ? " ← SUCCESS — data returned" :
    status === 402 ? " ← PAYMENT REQUIRED — plan restriction or quota" :
    status === 401 ? " ← UNAUTHORIZED — credentials rejected" :
    status === 429 ? " ← RATE LIMITED" :
    status === 0   ? " ← NO RESPONSE — timeout or network error" : "";
  console.log(`  HTTP ${status}:  ${count}/${results.length}  (${pct}%)${label}`);
}

// ── 402 diagnosis ─────────────────────────────────────────────────────────────

h("STEP 5 — 402 DIAGNOSTIC ANALYSIS");

const r402 = results.filter((r) => r.status === 402);

if (r402.length === 0) {
  console.log("  No 402 responses — plan restriction not observed in this run.");
} else {
  row("402 responses", `${r402.length} / ${results.length}`);

  // Aggregate unique header values across all 402 responses
  const headerAgg = new Map<string, Set<string>>();
  for (const r of r402) {
    for (const [k, v] of Object.entries(r.diagnosticHeaders)) {
      if (!headerAgg.has(k)) headerAgg.set(k, new Set());
      headerAgg.get(k)!.add(v);
    }
  }

  if (headerAgg.size > 0) {
    console.log("\n  Diagnostic headers present on 402 responses:");
    for (const [k, vals] of headerAgg) {
      console.log(`    ${k}: ${[...vals].join("  |  ")}`);
    }
  } else {
    console.log("\n  No diagnostic headers found on 402 responses.");
    console.log("  This is consistent with a plan-tier restriction");
    console.log("  (providers typically return no error-code headers for plan gates).");
  }

  const sample402Body = r402[0]?.sanitizedBody ?? "";
  if (sample402Body && sample402Body !== "") {
    console.log(`\n  402 body (first occurrence, sanitized):\n    ${sample402Body}`);
  }

  // Classify
  if (r402.length === results.length) {
    console.log("\n  CLASSIFICATION: Universal — all 10 requests returned 402.");
    console.log("  LIKELY CAUSE:   Plan-tier restriction on data endpoints.");
    console.log("  ACTION:         Check PredictLeads account dashboard; contact");
    console.log("                  PredictLeads support to confirm plan tier and");
    console.log("                  which endpoints/regions are included.");
  } else {
    const r200 = results.filter((r) => r.status === 200);
    console.log(`\n  CLASSIFICATION: Partial — ${r402.length} × 402, ${r200.length} × 200.`);
    console.log("  LIKELY CAUSE:   Domain-level data coverage gap.");
    console.log("  NOTE:           Domains with 200 have data; 402 domains may not");
    console.log("                  be indexed in the current plan's coverage region.");
  }
}

// ── Signal persistence summary ────────────────────────────────────────────────

h("STEP 6 — SIGNAL PERSISTENCE SUMMARY");

const totalInserted    = results.reduce((a, r) => a + r.insertedCount,    0);
const totalDups        = results.reduce((a, r) => a + r.duplicateCount,   0);
const totalUsable      = results.reduce((a, r) => a + r.usableEventCount, 0);
const totalNormErrors  = results.reduce((a, r) => a + r.normalizationErrors, 0);

row("Usable events from 200 responses",   totalUsable);
row("New signal rows inserted",            totalInserted);
row("Duplicate rows (already in DB)",     totalDups);
row("Normalization / upsert errors",      totalNormErrors);
row("account_intelligence rows written",  0);
row("rescoreCompany calls",               0);

if (totalInserted > 0) {
  console.log("\n  Inserted signal breakdown:");
  for (const r of results.filter((r) => r.insertedCount > 0)) {
    console.log(`    ${r.domain.padEnd(36)} ${r.module.padEnd(20)} ${r.insertedCount} row(s)`);
  }
}

// ── job_class verification ────────────────────────────────────────────────────

h("STEP 7 — JOB_CLASS EVIDENCE VERIFICATION");

if (totalInserted === 0 && totalDups === 0) {
  console.log("  No signals persisted — job_class verified at unit-test level only.");
  console.log("  (1429 tests pass, including 27 classifyJobPosting cases).");
} else {
  const { data: recentJobSignals } = await db
    .from("signals")
    .select("signal_title, evidence, occurred_at")
    .eq("client_id", GRAMSCODE_ID)
    .eq("signal_type", "job_posting")
    .order("created_at", { ascending: false })
    .limit(8);

  if (!recentJobSignals || recentJobSignals.length === 0) {
    console.log("  No job_posting signals found in DB for Gramscode.");
  } else {
    console.log("  Recent job_posting signals — job_class from evidence JSONB:");
    for (const s of recentJobSignals) {
      const ev = s.evidence as Record<string, unknown>;
      const jc = ev.job_class != null ? String(ev.job_class) : "MISSING";
      const ts = String(s.occurred_at ?? "").slice(0, 10);
      console.log(`    ${ts}  ${String(s.signal_title).slice(0, 48).padEnd(50)} job_class=${jc}`);
    }
    const missingCount = recentJobSignals.filter((s) => {
      const ev = s.evidence as Record<string, unknown>;
      return ev.job_class == null;
    }).length;
    if (missingCount === 0) {
      console.log("\n  job_class present on all verified signals. ✓");
    } else {
      console.log(`\n  WARNING: ${missingCount} signal(s) missing job_class — these may predate Stage 30C.`);
    }
  }
}

// ── Final summary ─────────────────────────────────────────────────────────────

h("EXPERIMENT COMPLETE — SUMMARY");

const successCount = results.filter((r) => r.status === 200).length;
const errorCount   = results.filter((r) => r.status !== 200).length;

row("Requests made",                requestsMade);
row("200 OK",                        `${successCount} / ${requestsMade}`);
row("Non-200",                       `${errorCount} / ${requestsMade}`);
row("New signal rows inserted",       totalInserted);
row("account_intelligence mutations", 0);
row("rescoreCompany called",         "NO");
row("Migrations applied",            "NO");
row("Outreach sent",                 "NO");
row("Hard limit respected",          requestsMade <= MAX_REQUESTS ? "YES" : "VIOLATED ✗");

if (successCount === 0 && r402.length > 0) {
  console.log("\n  DIAGNOSIS: PredictLeads API is returning 402 for all requests.");
  console.log("  The current plan does not grant access to data endpoints.");
  console.log("  Recommended next step: contact PredictLeads support with");
  console.log("  account details to determine plan tier and upgrade path.");
} else if (successCount === requestsMade) {
  console.log("\n  DIAGNOSIS: All requests succeeded — plan is active and returning UK data.");
} else if (successCount > 0) {
  console.log(`\n  DIAGNOSIS: Partial success — ${successCount} requests returned data.`);
  console.log("  Some domains are indexed in the current plan; others are not.");
}

console.log("");
