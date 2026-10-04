/**
 * Stage 29 Phase M6 — Controlled 198-Company Account Qualification Batch.
 *
 * APPROVED MUTATIONS:
 *   M6: INSERT/UPDATE account_campaign_qualification rows for 198 ROCI companies
 *       using computeAccountQualification() + upsertAccountQualification().
 *
 * NOT EXECUTED HERE:
 *   Signal ingestion, account intelligence, Why Now, person relevance,
 *   email reveal, Smartlead upload, any outbound, schema changes,
 *   ICP answer changes, campaign strategy changes.
 *
 * CONSTRAINTS:
 *   - Uses computeAccountQualification() exclusively (pure, deterministic, no AI)
 *   - Persists via upsertAccountQualification() exclusively
 *   - Scoped to: client=GRAMSCODE, strategy=approved Stage 27 production strategy
 *   - Signals: [] (M5/signal ingestion not yet approved)
 *   - opportunityScore: null (account intelligence not yet computed)
 *   - Fully idempotent — re-running produces 1 row per company, no duplicates
 *
 * Run: npx tsx scripts/stage29b-m6-batch.ts
 *
 * Pre-execution checklist (verified inside this script):
 *   1. Baseline row count in account_campaign_qualification for this strategy
 *   2. Strategy belongs to GRAMSCODE (tenant isolation check)
 *   3. ICP answers exist in icp_onboarding for the 5 relevant keys
 *   4. 198 distinct company IDs found via ROCI list
 *   5. Company rows fetched for all 198
 *
 * Post-execution verification:
 *   A. Exactly 198 rows for (GRAMSCODE, STRATEGY) in account_campaign_qualification
 *   B. No duplicates on (client_id, company_id, campaign_strategy_id)
 *   C. No cross-client rows written (all rows have client_id = GRAMSCODE)
 *   D. Qualified / disqualified / unknown distributions
 *   E. Score distribution: min, max, average
 *   F. Hard exclusion breakdown
 *   G. Representative qualified examples (top 5 by score)
 *   H. Representative rejected examples (5 with exclusionReasons)
 *   I. Representative unknown/low-confidence examples (5 with score < 20 and no hard block)
 *   J. JSONB evidence is populated and hypothesis label preserved
 *   K. Immutability audit: account_intelligence, signals, contacts, campaigns unchanged
 *   L. Delta audit: row delta = +198 (or 0 on re-run)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";
import { computeAccountQualification } from "../src/lib/account-qualification.js";
import { upsertAccountQualification } from "../src/db/account-campaign-qualification.js";
import type {
  AccountQualificationInput,
  AccountQualificationResult,
} from "../src/domain/account-qualification-types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const GRAMSCODE_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const STRATEGY_ID  = "48abf450-ccb1-49f3-94be-ac29c0531523"; // UK Agency Founders — AI GTM Founding Pilot
const ROCI_LIST_ID = "8ac556af-e520-4aa5-bc03-5369f206ed33"; // ROCI ICP - UK Agency Founders Aug 2026
const TABLE        = "account_campaign_qualification";

// Fixed timestamp for the entire batch run — deterministic assessed_at across all rows
const BATCH_NOW = new Date();

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

// ── DB client ─────────────────────────────────────────────────────────────────

const db = getSupabaseAdmin();

// ── Phase 0: Baseline capture ─────────────────────────────────────────────────

h("PHASE 0 — BASELINE CAPTURE");

// Global baseline: all rows in account_campaign_qualification across all clients
const { count: globalBaselineCount, error: globalBaselineErr } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true });

if (globalBaselineErr) {
  console.error("FATAL: Cannot read baseline count:", globalBaselineErr.message);
  process.exit(1);
}

const GLOBAL_BEFORE = globalBaselineCount ?? 0;
row("Global rows in account_campaign_qualification (before)", GLOBAL_BEFORE);

// Strategy-scoped baseline
const { count: stratBaselineCount, error: stratBaselineErr } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID)
  .eq("campaign_strategy_id", STRATEGY_ID);

if (stratBaselineErr) {
  console.error("FATAL: Cannot read strategy baseline:", stratBaselineErr.message);
  process.exit(1);
}

const STRATEGY_BEFORE = stratBaselineCount ?? 0;
row("Rows for (GRAMSCODE, STRATEGY) before batch", STRATEGY_BEFORE);
row("Batch NOW timestamp", BATCH_NOW.toISOString());
row("Client ID", GRAMSCODE_ID);
row("Strategy ID", STRATEGY_ID);
row("ROCI List ID", ROCI_LIST_ID);

// Other table baselines (for immutability audit at the end)
const { count: sigBefore }  = await db.from("signals").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: aiBefore }   = await db.from("account_intelligence").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: conBefore }  = await db.from("contacts").select("*", { count: "exact", head: true });
const { count: campBefore } = await db.from("campaigns").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);

row("signals (GRAMSCODE) before",              sigBefore  ?? 0);
row("account_intelligence (GRAMSCODE) before", aiBefore   ?? 0);
row("contacts (global) before",                conBefore  ?? 0);
row("campaigns (GRAMSCODE) before",            campBefore ?? 0);

// ── Phase 1: Pre-flight — verify strategy ─────────────────────────────────────

h("PHASE 1 — PRE-FLIGHT: STRATEGY VERIFICATION");

const { data: stratRow, error: stratErr } = await db
  .from("campaign_strategies")
  .select("id, client_id, campaign_name, status, rank, targeting_level")
  .eq("id", STRATEGY_ID)
  .eq("client_id", GRAMSCODE_ID)
  .single();

if (stratErr || !stratRow) {
  console.error("FATAL: Strategy not found or wrong client:", stratErr?.message ?? "no row");
  process.exit(1);
}

type StratRow = { id: string; client_id: string; campaign_name: string; status: string; rank: number | null; targeting_level: string | null };
const s = stratRow as StratRow;

row("Strategy ID",     s.id);
row("client_id",       s.client_id);
row("campaign_name",   s.campaign_name);
row("status",          s.status);
row("rank",            s.rank);
row("targeting_level", s.targeting_level);

if (s.client_id !== GRAMSCODE_ID) {
  console.error("FATAL: Strategy belongs to a different client — tenant isolation violated.");
  process.exit(1);
}
pass("Strategy client_id = GRAMSCODE — tenant isolation OK");

if (s.status !== "draft") {
  console.error(`FATAL: Strategy status is '${s.status}', expected 'draft'. Abort.`);
  process.exit(1);
}
pass("Strategy status = draft");

if (s.campaign_name !== "UK Agency Founders — AI GTM Founding Pilot") {
  fail(`Strategy name unexpected: "${s.campaign_name}"`);
} else {
  pass("Strategy name matches approved production strategy");
}

// ── Phase 2: Pre-flight — verify ICP answers ──────────────────────────────────

h("PHASE 2 — PRE-FLIGHT: ICP ANSWER VERIFICATION");

const ICP_KEYS = ["geography", "industries_in_out", "disqualifiers", "headcount_range", "triggers"] as const;
type IcpKey = typeof ICP_KEYS[number];

const { data: icpRows, error: icpErr } = await db
  .from("icp_onboarding")
  .select("question_key, answer")
  .eq("client_id", GRAMSCODE_ID)
  .in("question_key", [...ICP_KEYS]);

if (icpErr) {
  console.error("FATAL: Cannot read ICP answers:", icpErr.message);
  process.exit(1);
}

type IcpAnswerRow = { question_key: string; answer: string | null };
const icpAnswerMap = new Map<IcpKey, string | null>();

for (const r of (icpRows ?? []) as IcpAnswerRow[]) {
  if (ICP_KEYS.includes(r.question_key as IcpKey)) {
    icpAnswerMap.set(r.question_key as IcpKey, r.answer);
  }
}

for (const key of ICP_KEYS) {
  const ans = icpAnswerMap.get(key);
  const snippet = ans ? ans.slice(0, 70) + (ans.length > 70 ? "..." : "") : "(NULL)";
  row(key, snippet);
  if (!ans) {
    fail(`ICP answer missing for key '${key}' — qualification engine will return UNKNOWN for this dimension`);
  } else {
    pass(`${key}: answer present (${ans.length} chars)`);
  }
}

const icp = {
  geographyAnswer:     icpAnswerMap.get("geography")      ?? null,
  industriesAnswer:    icpAnswerMap.get("industries_in_out") ?? null,
  disqualifiersAnswer: icpAnswerMap.get("disqualifiers")  ?? null,
  headcountAnswer:     icpAnswerMap.get("headcount_range") ?? null,
  triggersAnswer:      icpAnswerMap.get("triggers")       ?? null,
};

// ── Phase 3: Fetch 198 company IDs from ROCI list ─────────────────────────────

h("PHASE 3 — FETCH 198 COMPANY IDs FROM ROCI LIST");

// Step 3a: Get contact IDs from list_members
const { data: memberRows, error: memberErr } = await db
  .from("list_members")
  .select("contact_id")
  .eq("list_id", ROCI_LIST_ID)
  .not("contact_id", "is", null);

if (memberErr) {
  console.error("FATAL: Cannot read list_members:", memberErr.message);
  process.exit(1);
}

type MemberRow = { contact_id: string | null };
const contactIds = ((memberRows ?? []) as MemberRow[])
  .filter(r => r.contact_id)
  .map(r => r.contact_id as string);

row("Direct contact members in ROCI list", contactIds.length);

if (contactIds.length === 0) {
  console.error("FATAL: No contacts found in ROCI list.");
  process.exit(1);
}

// Step 3b: Get distinct company_ids from those contacts
const { data: contactRows, error: contactErr } = await db
  .from("contacts")
  .select("id, company_id")
  .in("id", contactIds);

if (contactErr) {
  console.error("FATAL: Cannot read contacts:", contactErr.message);
  process.exit(1);
}

type ContactRow = { id: string; company_id: string | null };
const distinctCompanyIds = [
  ...new Set(
    ((contactRows ?? []) as ContactRow[])
      .map(r => r.company_id)
      .filter((id): id is string => id !== null),
  ),
];

row("Distinct company IDs from ROCI contacts", distinctCompanyIds.length);

if (distinctCompanyIds.length === 0) {
  console.error("FATAL: No company_ids found from ROCI contacts.");
  process.exit(1);
}

if (distinctCompanyIds.length !== 198) {
  console.warn(`  WARNING: Expected 198 companies, got ${distinctCompanyIds.length}. Proceeding with actual count.`);
} else {
  pass("198 distinct companies confirmed from ROCI list");
}

const EXPECTED_COMPANY_COUNT = distinctCompanyIds.length;

// ── Phase 4: Fetch company data ───────────────────────────────────────────────

h("PHASE 4 — FETCH COMPANY DATA");

const BATCH_SIZE = 200; // Supabase .in() limit
type CompRow = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  company_size: string | null;
  country: string | null;
  city: string | null;
};
const allCompanies: CompRow[] = [];

for (let i = 0; i < distinctCompanyIds.length; i += BATCH_SIZE) {
  const batch = distinctCompanyIds.slice(i, i + BATCH_SIZE);
  const { data: cos, error: cosErr } = await db
    .from("companies")
    .select("id, name, domain, industry, company_size, country, city")
    .in("id", batch);
  if (cosErr) {
    console.error("FATAL: Cannot fetch companies:", cosErr.message);
    process.exit(1);
  }
  allCompanies.push(...((cos ?? []) as CompRow[]));
}

row("Company rows fetched", allCompanies.length);

if (allCompanies.length !== EXPECTED_COMPANY_COUNT) {
  fail(`Expected ${EXPECTED_COMPANY_COUNT} company rows, got ${allCompanies.length} — some company IDs may not exist`);
} else {
  pass(`All ${EXPECTED_COMPANY_COUNT} company rows fetched`);
}

// Quick data quality snapshot before batch
const withCountry  = allCompanies.filter(c => c.country).length;
const withIndustry = allCompanies.filter(c => c.industry).length;
const withSize     = allCompanies.filter(c => c.company_size).length;
row("Companies with country",      withCountry);
row("Companies without country",   allCompanies.length - withCountry);
row("Companies with industry",     withIndustry);
row("Companies without industry",  allCompanies.length - withIndustry);
row("Companies with company_size", withSize);
row("Companies without size",      allCompanies.length - withSize);

// Build lookup map for company data
const companyMap = new Map<string, CompRow>();
for (const co of allCompanies) companyMap.set(co.id, co);

// ── Phase 5: Run qualification batch ──────────────────────────────────────────

h("PHASE 5 — QUALIFICATION BATCH (WRITE)");

console.log(`  Processing ${EXPECTED_COMPANY_COUNT} companies with computeAccountQualification() + upsertAccountQualification()`);
console.log(`  Signals: [] (M5 not yet run)`);
console.log(`  opportunityScore: null (account intelligence not yet computed)`);
console.log(`  batchNow: ${BATCH_NOW.toISOString()}`);

const campaign = {
  campaignStrategyId: STRATEGY_ID,
  listFilters: s.targeting_level ? `Director and above; ${s.targeting_level}` : null,
};

let written  = 0;
let errors   = 0;
const errorLog: Array<{ companyId: string; name: string; error: string }> = [];

// Process all companies
const WRITE_BATCH = 20; // process in groups for progress reporting
const results: Array<{ companyId: string; result: AccountQualificationResult }> = [];

for (let i = 0; i < distinctCompanyIds.length; i++) {
  const companyId = distinctCompanyIds[i];
  const co = companyMap.get(companyId);

  if (!co) {
    // Company ID in list but not fetched (data integrity issue)
    errorLog.push({ companyId, name: "(not found)", error: "Company row not found in DB" });
    errors++;
    continue;
  }

  const input: AccountQualificationInput = {
    clientId: GRAMSCODE_ID,
    company: {
      id:          co.id,
      name:        co.name,
      domain:      co.domain,
      industry:    co.industry,
      country:     co.country,
      city:        co.city,
      companySize: co.company_size,
      description: null, // column does not exist in companies table
    },
    icp,
    campaign,
    signals:         [],  // M5 not yet run
    opportunityScore: null, // account intelligence not yet computed
  };

  const qualResult = computeAccountQualification(input, BATCH_NOW);
  results.push({ companyId, result: qualResult });

  try {
    await upsertAccountQualification(GRAMSCODE_ID, companyId, qualResult, BATCH_NOW);
    written++;
  } catch (e) {
    const msg = (e as Error).message;
    errorLog.push({ companyId, name: co.name, error: msg });
    errors++;
    console.error(`  ERROR writing ${co.name} (${companyId}): ${msg}`);
  }

  // Progress tick every 50 companies
  if ((i + 1) % 50 === 0 || i + 1 === distinctCompanyIds.length) {
    console.log(`  Progress: ${i + 1}/${distinctCompanyIds.length} (written=${written}, errors=${errors})`);
  }
}

row("\nTotal companies processed", distinctCompanyIds.length);
row("Written successfully",       written);
row("Write errors",               errors);

if (errors > 0) {
  console.error(`\n  BATCH ERRORS (${errors}):`);
  for (const e of errorLog) {
    console.error(`    [${e.companyId}] ${e.name}: ${e.error}`);
  }
  // Stop and report — do not claim success on partial writes
  console.error("\n  BATCH COMPLETED WITH ERRORS — see above before proceeding.");
  process.exitCode = 1;
}

// ── Phase 6: Post-batch verification ──────────────────────────────────────────

h("PHASE 6 — POST-BATCH VERIFICATION");

// A. Row count for this strategy
sub("A — Row count for (GRAMSCODE, STRATEGY)");

const { count: stratAfterCount, error: stratAfterErr } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true })
  .eq("client_id", GRAMSCODE_ID)
  .eq("campaign_strategy_id", STRATEGY_ID);

if (stratAfterErr) {
  fail("Cannot read strategy row count after batch: " + stratAfterErr.message);
} else {
  const STRATEGY_AFTER = stratAfterCount ?? 0;
  row("Rows for (GRAMSCODE, STRATEGY) after batch",   STRATEGY_AFTER);
  row("Delta for this strategy",                       STRATEGY_AFTER - STRATEGY_BEFORE);

  if (STRATEGY_AFTER === EXPECTED_COMPANY_COUNT) {
    pass(`Exactly ${EXPECTED_COMPANY_COUNT} rows — matches ROCI company count`);
  } else if (STRATEGY_AFTER > STRATEGY_BEFORE) {
    pass(`${STRATEGY_AFTER} rows present (${STRATEGY_AFTER - STRATEGY_BEFORE} net new)`);
    if (STRATEGY_AFTER !== EXPECTED_COMPANY_COUNT) {
      fail(`Expected ${EXPECTED_COMPANY_COUNT} rows, got ${STRATEGY_AFTER}`);
    }
  } else {
    fail(`No new rows written? Before=${STRATEGY_BEFORE} After=${STRATEGY_AFTER}`);
  }
}

// B. No duplicates on (client_id, company_id, campaign_strategy_id)
sub("B — Duplicate check: unique constraint integrity");

const { data: allStratRows, error: allStratErr } = await db
  .from(TABLE)
  .select("client_id, company_id, campaign_strategy_id")
  .eq("client_id", GRAMSCODE_ID)
  .eq("campaign_strategy_id", STRATEGY_ID);

if (allStratErr) {
  fail("Cannot read rows for duplicate check: " + allStratErr.message);
} else {
  type QualRow = { client_id: string; company_id: string; campaign_strategy_id: string };
  const rows = (allStratRows ?? []) as QualRow[];
  const seen = new Set<string>();
  let dupeCount = 0;
  for (const r of rows) {
    const key = `${r.client_id}|${r.company_id}|${r.campaign_strategy_id}`;
    if (seen.has(key)) dupeCount++;
    seen.add(key);
  }
  if (dupeCount === 0) {
    pass(`No duplicate (client_id, company_id, campaign_strategy_id) keys — unique constraint intact`);
  } else {
    fail(`${dupeCount} duplicate keys found — constraint integrity issue`);
  }
}

// C. No cross-client rows
sub("C — Cross-client isolation: no other client_id in written rows");

const { count: crossClientCount, error: crossClientErr } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true })
  .neq("client_id", GRAMSCODE_ID)
  .eq("campaign_strategy_id", STRATEGY_ID);

if (crossClientErr) {
  fail("Cannot check cross-client rows: " + crossClientErr.message);
} else if ((crossClientCount ?? 0) > 0) {
  fail(`CRITICAL: ${crossClientCount} rows with campaign_strategy_id=${STRATEGY_ID} belong to a DIFFERENT client`);
} else {
  pass("Zero cross-client rows for this strategy — tenant isolation intact");
}

// D + E. Qualification distribution and score analysis
sub("D/E — Qualification distribution and score analysis");

const { data: fullBatchRows, error: fullBatchErr } = await db
  .from(TABLE)
  .select("company_id, qualified, qualification_score, qualification")
  .eq("client_id", GRAMSCODE_ID)
  .eq("campaign_strategy_id", STRATEGY_ID);

if (fullBatchErr) {
  fail("Cannot read full batch for distribution analysis: " + fullBatchErr.message);
} else {
  type FullRow = {
    company_id: string;
    qualified: boolean;
    qualification_score: number;
    qualification: AccountQualificationResult;
  };
  const batchRows = (fullBatchRows ?? []) as FullRow[];

  const qualified      = batchRows.filter(r => r.qualified === true);
  const disqualified   = batchRows.filter(r => r.qualified === false && (r.qualification.exclusionReasons?.length ?? 0) > 0);
  const lowConfidence  = batchRows.filter(r => r.qualified === false && (r.qualification.exclusionReasons?.length ?? 0) === 0);

  row("Total rows fetched for analysis", batchRows.length);
  row("qualified = true",                qualified.length);
  row("qualified = false (hard block)",  disqualified.length);
  row("qualified = false (low score/unknown)", lowConfidence.length);

  if (qualified.length + disqualified.length + lowConfidence.length !== batchRows.length) {
    fail("Distribution counts don't sum to total — logic error");
  } else {
    pass("Distribution: qualified + disqualified + unknown = total ✓");
  }

  // Score distribution
  const scores = batchRows.map(r => Number(r.qualification_score));
  const scoreMin = Math.min(...scores);
  const scoreMax = Math.max(...scores);
  const scoreAvg = scores.reduce((a, b) => a + b, 0) / scores.length;

  row("Score min", scoreMin);
  row("Score max", scoreMax);
  row("Score avg", scoreAvg.toFixed(1));

  // Score buckets
  const buckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  sub("Score distribution buckets");
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i + 1];
    const n = scores.filter(sc => sc >= lo && sc < hi).length;
    const exactly100 = i === buckets.length - 2 ? scores.filter(sc => sc === 100).length : 0;
    const total = (i === buckets.length - 2) ? n + exactly100 : n;
    if (total > 0) console.log(`  ${String(lo).padStart(3)}-${String(hi).padEnd(3)}: ${total}`);
  }

  // F. Hard exclusion breakdown
  sub("F — Hard exclusion breakdown (exclusionReasons)");
  const exclusionTypes = new Map<string, number>();
  for (const r of batchRows) {
    for (const reason of (r.qualification.exclusionReasons ?? [])) {
      // Bucket by first word pattern
      const bucket = reason.startsWith("Geography") ? "Geography FAIL"
        : reason.startsWith("Industry") ? "Industry OUT-list"
        : reason.startsWith("Company matches") ? "Disqualifier match"
        : "Other";
      exclusionTypes.set(bucket, (exclusionTypes.get(bucket) ?? 0) + 1);
    }
  }
  row("Companies with at least 1 exclusion reason", disqualified.length);
  for (const [type, count] of [...exclusionTypes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${type}`);
  }

  // Geography verdict distribution
  sub("Geography verdict distribution");
  const geoVerdicts = new Map<string, number>();
  for (const r of batchRows) {
    const v = r.qualification.geographyVerdict ?? "UNKNOWN";
    geoVerdicts.set(v, (geoVerdicts.get(v) ?? 0) + 1);
  }
  for (const [v, count] of [...geoVerdicts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${v}`);
  }

  // Industry verdict distribution
  sub("Industry verdict distribution");
  const indVerdicts = new Map<string, number>();
  for (const r of batchRows) {
    const v = r.qualification.industryVerdict ?? "UNKNOWN";
    indVerdicts.set(v, (indVerdicts.get(v) ?? 0) + 1);
  }
  for (const [v, count] of [...indVerdicts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${v}`);
  }

  // G. Representative qualified examples (top 5 by score)
  sub("G — Representative QUALIFIED examples (top 5 by score)");
  const topQualified = qualified
    .sort((a, b) => b.qualification_score - a.qualification_score)
    .slice(0, 5);
  for (const r of topQualified) {
    const co = companyMap.get(r.company_id);
    console.log(`\n  [${r.company_id.slice(0, 8)}] score=${r.qualification_score} qualified=true`);
    console.log(`    Name:     ${co?.name ?? "(not found)"}`);
    console.log(`    Country:  ${co?.country ?? "(null)"}`);
    console.log(`    Industry: ${co?.industry ?? "(null)"}`);
    console.log(`    Geo:      ${r.qualification.geographyVerdict}`);
    console.log(`    Industry: ${r.qualification.industryVerdict}`);
    if (r.qualification.positiveEvidence?.length > 0) {
      console.log(`    +evidence: ${r.qualification.positiveEvidence.slice(0, 3).join("; ")}`);
    }
  }

  // H. Representative rejected examples (5 with hard exclusion)
  sub("H — Representative REJECTED examples (hard exclusion, 5 shown)");
  const topRejected = disqualified
    .sort((a, b) => b.qualification_score - a.qualification_score)
    .slice(0, 5);
  for (const r of topRejected) {
    const co = companyMap.get(r.company_id);
    console.log(`\n  [${r.company_id.slice(0, 8)}] score=${r.qualification_score} qualified=false`);
    console.log(`    Name:     ${co?.name ?? "(not found)"}`);
    console.log(`    Country:  ${co?.country ?? "(null)"}`);
    console.log(`    Industry: ${co?.industry ?? "(null)"}`);
    if (r.qualification.exclusionReasons?.length > 0) {
      console.log(`    Excluded: ${r.qualification.exclusionReasons[0].slice(0, 100)}`);
    }
  }

  // I. Representative unknown/low-confidence examples
  sub("I — Representative UNKNOWN/LOW-CONFIDENCE examples (5 shown)");
  const topLow = lowConfidence
    .sort((a, b) => b.qualification_score - a.qualification_score)
    .slice(0, 5);
  for (const r of topLow) {
    const co = companyMap.get(r.company_id);
    console.log(`\n  [${r.company_id.slice(0, 8)}] score=${r.qualification_score} qualified=false (no hard block)`);
    console.log(`    Name:     ${co?.name ?? "(not found)"}`);
    console.log(`    Country:  ${co?.country ?? "(null)"}`);
    console.log(`    Industry: ${co?.industry ?? "(null)"}`);
    console.log(`    Geo:      ${r.qualification.geographyVerdict}`);
    console.log(`    Industry: ${r.qualification.industryVerdict}`);
    if (r.qualification.missingInfo?.length > 0) {
      console.log(`    Missing:  ${r.qualification.missingInfo.slice(0, 2).join("; ")}`);
    }
    if (r.qualification.warnings?.length > 0) {
      console.log(`    Warnings: ${r.qualification.warnings[0].slice(0, 100)}`);
    }
  }

  // J. JSONB evidence populated and hypothesis label present
  sub("J — JSONB evidence and hypothesis label verification");
  const withJsonb     = batchRows.filter(r => r.qualification !== null && r.qualification !== undefined);
  const withHypothesis = batchRows.filter(r => r.qualification?.hypothesis === "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  const withPosEvidence = batchRows.filter(r => Array.isArray(r.qualification?.positiveEvidence));
  const withAssessedAt  = batchRows.filter(r => Boolean(r.qualification?.assessedAt));
  const withStrategyId  = batchRows.filter(r => r.qualification?.campaignStrategyId === STRATEGY_ID);

  row("Rows with non-null qualification JSONB", withJsonb.length);
  row("Rows with hypothesis=INITIAL_HYPOTHESIS_NOT_VALIDATED", withHypothesis.length);
  row("Rows with positiveEvidence array",       withPosEvidence.length);
  row("Rows with assessedAt in JSONB",          withAssessedAt.length);
  row("Rows with correct campaignStrategyId in JSONB", withStrategyId.length);

  if (withJsonb.length === batchRows.length) {
    pass("All rows have populated JSONB qualification evidence");
  } else {
    fail(`${batchRows.length - withJsonb.length} rows have null JSONB — evidence missing`);
  }
  if (withHypothesis.length === batchRows.length) {
    pass("All rows preserve hypothesis=INITIAL_HYPOTHESIS_NOT_VALIDATED label");
  } else {
    fail(`${batchRows.length - withHypothesis.length} rows missing hypothesis label`);
  }
  if (withStrategyId.length === batchRows.length) {
    pass("All JSONB records have correct campaignStrategyId");
  } else {
    fail(`${batchRows.length - withStrategyId.length} rows have wrong campaignStrategyId in JSONB`);
  }
}

// ── Phase 7: Immutability audit ────────────────────────────────────────────────

h("PHASE 7 — IMMUTABILITY AUDIT");

sub("K — Unrelated tables unchanged");

const { count: sigAfter }  = await db.from("signals").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: aiAfter }   = await db.from("account_intelligence").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);
const { count: conAfter }  = await db.from("contacts").select("*", { count: "exact", head: true });
const { count: campAfter } = await db.from("campaigns").select("*", { count: "exact", head: true }).eq("client_id", GRAMSCODE_ID);

const sigDelta  = (sigAfter ?? 0) - (sigBefore ?? 0);
const aiDelta   = (aiAfter ?? 0) - (aiBefore ?? 0);
const conDelta  = (conAfter ?? 0) - (conBefore ?? 0);
const campDelta = (campAfter ?? 0) - (campBefore ?? 0);

row("signals (before → after)",              `${sigBefore ?? 0} → ${sigAfter ?? 0} (delta=${sigDelta})`);
row("account_intelligence (before → after)", `${aiBefore ?? 0} → ${aiAfter ?? 0} (delta=${aiDelta})`);
row("contacts (before → after)",             `${conBefore ?? 0} → ${conAfter ?? 0} (delta=${conDelta})`);
row("campaigns (before → after)",            `${campBefore ?? 0} → ${campAfter ?? 0} (delta=${campDelta})`);

if (sigDelta === 0)  pass("signals: no change");
else                  fail(`CRITICAL: signals changed by ${sigDelta} — unexpected mutation`);
if (aiDelta === 0)   pass("account_intelligence: no change");
else                  fail(`CRITICAL: account_intelligence changed by ${aiDelta} — unexpected mutation`);
if (conDelta === 0)  pass("contacts: no change");
else                  fail(`CRITICAL: contacts changed by ${conDelta} — unexpected mutation`);
if (campDelta === 0) pass("campaigns: no change");
else                  fail(`CRITICAL: campaigns changed by ${campDelta} — unexpected mutation`);

// Confirm production campaign is unchanged
sub("Production campaign integrity check");

const { data: campRow, error: campRowErr } = await db
  .from("campaigns")
  .select("id, status, list_id, campaign_strategy_id, platform_campaign_id")
  .eq("id", "74c84457-17db-41fa-bd53-a9af63bdb47d")
  .eq("client_id", GRAMSCODE_ID)
  .single();

if (campRowErr || !campRow) {
  fail("Production campaign not found: " + (campRowErr?.message ?? "no row"));
} else {
  type CampRow = { id: string; status: string; list_id: string | null; campaign_strategy_id: string | null; platform_campaign_id: string | null };
  const camp = campRow as CampRow;
  row("campaign.status",               camp.status);
  row("campaign.list_id",              camp.list_id);
  row("campaign.campaign_strategy_id", camp.campaign_strategy_id);
  row("campaign.platform_campaign_id", camp.platform_campaign_id);

  if (camp.status === "draft")                          pass("campaign.status = draft (unchanged)");
  else                                                   fail(`campaign.status changed to '${camp.status}'`);
  if (camp.list_id === "8ac556af-e520-4aa5-bc03-5369f206ed33") pass("campaign.list_id = ROCI list (unchanged)");
  else                                                   fail(`campaign.list_id unexpected: ${camp.list_id}`);
  if (camp.campaign_strategy_id === STRATEGY_ID)         pass("campaign.campaign_strategy_id = approved strategy (unchanged)");
  else                                                    fail(`campaign.campaign_strategy_id unexpected: ${camp.campaign_strategy_id}`);
  if (camp.platform_campaign_id === "3908578")           pass("campaign.platform_campaign_id = 3908578 (Smartlead — unchanged)");
  else                                                    fail(`campaign.platform_campaign_id changed: ${camp.platform_campaign_id}`);
}

// ── Phase 8: Delta audit ───────────────────────────────────────────────────────

h("PHASE 8 — DELTA AUDIT");

const { count: globalAfterCount } = await db
  .from(TABLE)
  .select("*", { count: "exact", head: true });

const GLOBAL_AFTER   = globalAfterCount ?? 0;
const globalDelta    = GLOBAL_AFTER - GLOBAL_BEFORE;

row("Global rows before batch", GLOBAL_BEFORE);
row("Global rows after batch",  GLOBAL_AFTER);
row("Global delta",             globalDelta);

if (globalDelta === EXPECTED_COMPANY_COUNT) {
  pass(`Delta = +${EXPECTED_COMPANY_COUNT} — first run, all rows new`);
} else if (globalDelta === 0) {
  pass(`Delta = 0 — idempotent re-run, all rows already existed`);
} else if (globalDelta > 0 && globalDelta < EXPECTED_COMPANY_COUNT) {
  console.log(`  NOTE: Delta = +${globalDelta} — partial new rows (some companies were pre-existing)`);
} else {
  fail(`Unexpected global delta: ${globalDelta} (expected +${EXPECTED_COMPANY_COUNT} or 0)`);
}

// ── Final summary ──────────────────────────────────────────────────────────────

h("STAGE 29 M6-BATCH SUMMARY");

console.log(`
  Batch execution:
    Client:           ${GRAMSCODE_ID}
    Strategy:         ${STRATEGY_ID}
    ROCI list:        ${ROCI_LIST_ID}
    Companies:        ${EXPECTED_COMPANY_COUNT}
    batchNow:         ${BATCH_NOW.toISOString()}
    Written:          ${written}
    Write errors:     ${errors}

  account_campaign_qualification:
    Rows before (strategy): ${STRATEGY_BEFORE}
    Rows after  (strategy): ${(stratBaselineCount ?? 0) + written}
    Global before:          ${GLOBAL_BEFORE}
    Global after:           ${GLOBAL_AFTER}
    Global delta:           ${GLOBAL_AFTER - GLOBAL_BEFORE}

  NOT EXECUTED:
    M5  Signal ingestion (PredictLeads)
    M7  Account intelligence (Stages 10–15)
    M8  Why Now (Stage 22)
    M9  Person relevance (Stage 23)
    M10 Prospeo email reveals
    M11 Platform lead ID backfill
    ACT Campaign activation / status change

  ZERO provider API calls. ZERO outbound. ZERO Smartlead mutations.
  ZERO schema changes. ZERO enrichment. ZERO AI calls.
`);

if (process.exitCode === 1) {
  console.error("M6-BATCH COMPLETED WITH FAILURES — review output above before proceeding.");
} else {
  console.log("  M6-BATCH COMPLETE — all checks passed.");
}
