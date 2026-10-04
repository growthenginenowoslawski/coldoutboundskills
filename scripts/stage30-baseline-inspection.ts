/**
 * Stage 30 — Baseline Inspection (READ-ONLY).
 *
 * Establishes the pre-rescore baseline for the 198 ROCI-qualified companies:
 *
 *   1. Global signal counts by client
 *   2. Signal counts for the 198 ROCI companies (Gramscode, STRATEGY_ID)
 *   3. Signal type distribution for those companies
 *   4. Signal status breakdown (active / expired / pending)
 *   5. Signal freshness distribution (freshness_score buckets)
 *   6. Signal source / provider provenance
 *   7. Existing account_intelligence rows for the 198 companies
 *      (opportunity_score distribution, is_ready counts)
 *   8. Coverage map — which of the 198 have ≥1 signal vs. zero signals
 *   9. Top-10 companies by signal count
 *  10. Qualification distribution recap (from account_campaign_qualification)
 *
 * ZERO mutations — this script is safe to run at any time.
 *
 * Run: npx tsx scripts/stage30-baseline-inspection.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const GRAMSCODE_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const STRATEGY_ID  = "48abf450-ccb1-49f3-94be-ac29c0531523";
const ROCI_LIST_ID = "8ac556af-e520-4aa5-bc03-5369f206ed33";

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

const db = getSupabaseAdmin();

// ── Phase 1: Fetch 198 ROCI company IDs ───────────────────────────────────────
// list_members stores contact_id → resolve to company_id via contacts table.

h("PHASE 1 — FETCH 198 ROCI COMPANY IDs");

const { data: memberRows, error: memberErr } = await db
  .from("list_members")
  .select("contact_id")
  .eq("list_id", ROCI_LIST_ID)
  .not("contact_id", "is", null);

if (memberErr) {
  console.error("FATAL: Cannot fetch list_members:", memberErr.message);
  process.exit(1);
}

type MemberRow = { contact_id: string | null };
const contactIds = ((memberRows ?? []) as MemberRow[])
  .filter(r => r.contact_id)
  .map(r => r.contact_id as string);

row("ROCI list members (contact_id rows)", contactIds.length);

if (contactIds.length === 0) {
  console.error("FATAL: No contacts found in ROCI list. Cannot continue.");
  process.exit(1);
}

const { data: contactRows, error: contactErr } = await db
  .from("contacts")
  .select("id, company_id")
  .in("id", contactIds);

if (contactErr) {
  console.error("FATAL: Cannot fetch contacts:", contactErr.message);
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

row("Distinct ROCI company IDs", rociCompanyIds.length);

if (rociCompanyIds.length === 0) {
  console.error("FATAL: No company_ids found from ROCI contacts. Cannot continue.");
  process.exit(1);
}

// ── Phase 2: Global signal counts ────────────────────────────────────────────

h("PHASE 2 — GLOBAL SIGNAL COUNTS BY CLIENT");

const { data: clientSignalCounts, error: clientSigErr } = await db
  .from("signals")
  .select("client_id");

if (clientSigErr) {
  console.error("WARN: Cannot fetch global signal counts:", clientSigErr.message);
} else {
  const byCLient = new Map<string, number>();
  for (const r of (clientSignalCounts ?? []) as Array<{ client_id: string }>) {
    byCLient.set(r.client_id, (byCLient.get(r.client_id) ?? 0) + 1);
  }
  for (const [clientId, count] of [...byCLient.entries()].sort((a, b) => b[1] - a[1])) {
    const marker = clientId === GRAMSCODE_ID ? "  ← GRAMSCODE" : "";
    row(`client ${clientId.slice(0, 8)}…`, `${count}${marker}`);
  }
  row("Total signals (all clients)", (clientSignalCounts ?? []).length);
}

// ── Phase 3: Signals for the 198 ROCI companies ───────────────────────────────

h("PHASE 3 — SIGNALS FOR THE 198 ROCI COMPANIES (Gramscode-scoped)");

// Supabase .in() caps at 1000 values — 198 is well within that.
const { data: rociSignals, error: rociSigErr } = await db
  .from("signals")
  .select("id, company_id, signal_type, status, signal_source, signal_strength, occurred_at, expires_at, created_at")
  .eq("client_id", GRAMSCODE_ID)
  .in("company_id", rociCompanyIds);

if (rociSigErr) {
  console.error("FATAL: Cannot fetch ROCI signals:", rociSigErr.message);
  process.exit(1);
}

type SignalRow = {
  id: string;
  company_id: string;
  signal_type: string;
  status: string;
  signal_source: string | null;
  signal_strength: number | null;
  occurred_at: string;
  expires_at: string | null;
  created_at: string;
};

const signals = (rociSignals ?? []) as SignalRow[];
row("Signals for 198 ROCI companies (GRAMSCODE)", signals.length);

// ── Phase 4: Signal type distribution ────────────────────────────────────────

h("PHASE 4 — SIGNAL TYPE DISTRIBUTION");

const byType = new Map<string, number>();
for (const s of signals) {
  byType.set(s.signal_type, (byType.get(s.signal_type) ?? 0) + 1);
}
if (byType.size === 0) {
  console.log("  (no signals found for ROCI companies)");
} else {
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    row(type, count);
  }
}

// ── Phase 5: Signal status breakdown ─────────────────────────────────────────

h("PHASE 5 — SIGNAL STATUS BREAKDOWN");

const byStatus = new Map<string, number>();
for (const s of signals) {
  byStatus.set(s.status ?? "null", (byStatus.get(s.status ?? "null") ?? 0) + 1);
}
if (byStatus.size === 0) {
  console.log("  (no signals)");
} else {
  for (const [status, count] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
    row(status, count);
  }
}

// ── Phase 6: Signal freshness distribution ────────────────────────────────────
// freshness_score is not stored — derive from expires_at vs wall-clock.

h("PHASE 6 — SIGNAL FRESHNESS (derived from expires_at)");

const now = new Date();
const expiredByDate    = signals.filter(s => s.expires_at && new Date(s.expires_at) < now).length;
const activeByDate     = signals.filter(s => s.expires_at && new Date(s.expires_at) >= now).length;
const noExpiresAt      = signals.filter(s => !s.expires_at).length;

row("Active (expires_at in future)",   activeByDate);
row("Expired (expires_at in past)",    expiredByDate);
row("No expires_at set",               noExpiresAt);

// Approximate freshness by age buckets (days since occurred_at)
const ageGroups = { "0-7d": 0, "8-14d": 0, "15-30d": 0, "31-90d": 0, "90+d": 0 };
for (const s of signals) {
  const ageDays = (now.getTime() - new Date(s.occurred_at).getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays <= 7)       ageGroups["0-7d"]++;
  else if (ageDays <= 14) ageGroups["8-14d"]++;
  else if (ageDays <= 30) ageGroups["15-30d"]++;
  else if (ageDays <= 90) ageGroups["31-90d"]++;
  else                    ageGroups["90+d"]++;
}
sub("Age since occurred_at");
for (const [bucket, count] of Object.entries(ageGroups)) {
  row(`  ${bucket}`, count);
}

// ── Phase 7: Signal source / provider provenance ──────────────────────────────

h("PHASE 7 — SIGNAL SOURCE / PROVIDER PROVENANCE");

const bySource = new Map<string, number>();
for (const s of signals) {
  bySource.set(s.signal_source ?? "(null)", (bySource.get(s.signal_source ?? "(null)") ?? 0) + 1);
}
if (bySource.size === 0) {
  console.log("  (no signals)");
} else {
  for (const [source, count] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    row(source, count);
  }
}

// ── Phase 8: Account intelligence for 198 companies ──────────────────────────

h("PHASE 8 — EXISTING ACCOUNT INTELLIGENCE (GRAMSCODE, 198 ROCI)");

const { data: aiRows, error: aiErr } = await db
  .from("account_intelligence")
  .select("company_id, opportunity_score, priority_score, is_ready, updated_at")
  .eq("client_id", GRAMSCODE_ID)
  .in("company_id", rociCompanyIds);

if (aiErr) {
  console.error("WARN: Cannot fetch account_intelligence:", aiErr.message);
} else {
  type AiRow = {
    company_id: string;
    opportunity_score: number | null;
    priority_score: number | null;
    is_ready: boolean | null;
    updated_at: string;
  };
  const ai = (aiRows ?? []) as AiRow[];
  row("account_intelligence rows for 198 ROCI (GRAMSCODE)", ai.length);

  const withScore    = ai.filter(r => r.opportunity_score !== null);
  const isReadyCount = ai.filter(r => r.is_ready === true).length;

  row("  rows with opportunity_score set", withScore.length);
  row("  rows with is_ready = true",       isReadyCount);

  if (withScore.length > 0) {
    const scores = withScore.map(r => r.opportunity_score as number);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    row("  opportunity_score min", min);
    row("  opportunity_score max", max);
    row("  opportunity_score avg", avg);

    sub("Score distribution buckets");
    const sb = { "81-100": 0, "61-80": 0, "41-60": 0, "21-40": 0, "1-20": 0, "0": 0 };
    for (const sc of scores) {
      if (sc >= 81)      sb["81-100"]++;
      else if (sc >= 61) sb["61-80"]++;
      else if (sc >= 41) sb["41-60"]++;
      else if (sc >= 21) sb["21-40"]++;
      else if (sc >= 1)  sb["1-20"]++;
      else               sb["0"]++;
    }
    for (const [bucket, count] of Object.entries(sb)) {
      row(`opportunity_score ${bucket}`, count);
    }
  }
}

// ── Phase 9: Coverage map — companies with vs. without signals ────────────────

h("PHASE 9 — SIGNAL COVERAGE MAP (198 ROCI companies)");

const companiesWithSignals = new Set<string>();
for (const s of signals) {
  companiesWithSignals.add(s.company_id);
}

const withSignals    = rociCompanyIds.filter(id => companiesWithSignals.has(id));
const withoutSignals = rociCompanyIds.filter(id => !companiesWithSignals.has(id));

row("Companies with ≥1 signal",  withSignals.length);
row("Companies with 0 signals",  withoutSignals.length);
row("Signal coverage %",         `${Math.round((withSignals.length / rociCompanyIds.length) * 100)}%`);

// ── Phase 10: Top-10 companies by signal count ────────────────────────────────

h("PHASE 10 — TOP-10 ROCI COMPANIES BY SIGNAL COUNT");

const sigCountByCompany = new Map<string, number>();
for (const s of signals) {
  sigCountByCompany.set(s.company_id, (sigCountByCompany.get(s.company_id) ?? 0) + 1);
}

const topTen = [...sigCountByCompany.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10);

if (topTen.length === 0) {
  console.log("  (no signals for any ROCI company)");
} else {
  // Fetch company names for display
  const topIds = topTen.map(([id]) => id);
  const { data: nameRows } = await db
    .from("companies")
    .select("id, name, domain")
    .in("id", topIds);

  type NameRow = { id: string; name: string; domain: string | null };
  const nameMap = new Map<string, NameRow>();
  for (const r of (nameRows ?? []) as NameRow[]) nameMap.set(r.id, r);

  let rank = 1;
  for (const [companyId, count] of topTen) {
    const n = nameMap.get(companyId);
    const label = n ? `${n.name} (${n.domain ?? companyId.slice(0, 8)})` : companyId.slice(0, 8);
    const types = [...new Set(signals.filter(s => s.company_id === companyId).map(s => s.signal_type))].join(", ");
    console.log(`  #${rank++} ${label}`);
    console.log(`       signals: ${count} | types: ${types}`);
  }
}

// ── Phase 11: Qualification distribution recap ────────────────────────────────

h("PHASE 11 — QUALIFICATION DISTRIBUTION RECAP (from account_campaign_qualification)");

const { data: qualRows, error: qualErr } = await db
  .from("account_campaign_qualification")
  .select("company_id, qualified, qualification_score")
  .eq("client_id", GRAMSCODE_ID)
  .eq("campaign_strategy_id", STRATEGY_ID);

if (qualErr) {
  console.error("WARN: Cannot fetch qualification rows:", qualErr.message);
} else {
  type QualRow = { company_id: string; qualified: boolean; qualification_score: number };
  const qual = (qualRows ?? []) as QualRow[];
  const qYes = qual.filter(r => r.qualified).length;
  const qNo  = qual.filter(r => !r.qualified).length;

  row("Total qualification rows",  qual.length);
  row("Qualified (qualified=true)", qYes);
  row("Rejected (qualified=false)", qNo);

  // Of those qualified, how many have signals?
  const qualifiedIds  = qual.filter(r => r.qualified).map(r => r.company_id);
  const qualWithSig   = qualifiedIds.filter(id => companiesWithSignals.has(id)).length;
  const qualWithoutSig = qualifiedIds.filter(id => !companiesWithSignals.has(id)).length;

  row("Qualified companies WITH signals",    qualWithSig);
  row("Qualified companies WITHOUT signals", qualWithoutSig);
}

// ── Phase 12: Representative signal records ────────────────────────────────────

h("PHASE 12 — REPRESENTATIVE SIGNAL RECORDS (first 5)");

if (signals.length === 0) {
  console.log("  (no signals for ROCI companies — Stage 30 will not fabricate any)");
} else {
  for (const s of signals.slice(0, 5)) {
    console.log(`  signal_id      : ${s.id}`);
    console.log(`  company_id     : ${s.company_id}`);
    console.log(`  type           : ${s.signal_type}`);
    console.log(`  status         : ${s.status}`);
    console.log(`  signal_source  : ${s.signal_source ?? "(null)"}`);
    console.log(`  signal_strength: ${s.signal_strength ?? "(null)"}`);
    console.log(`  occurred_at    : ${s.occurred_at}`);
    console.log(`  expires_at     : ${s.expires_at ?? "(null)"}`);
    console.log("");
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

h("BASELINE SUMMARY");
row("ROCI companies inspected",           rociCompanyIds.length);
row("With ≥1 signal",                    withSignals.length);
row("With 0 signals (no fabrication)",   withoutSignals.length);
row("Total signals for ROCI companies",  signals.length);
row("account_intelligence rows (before)", (aiRows ?? []).length);
console.log("\n  Baseline captured. No mutations made. Stage 30 rescore pending.");
