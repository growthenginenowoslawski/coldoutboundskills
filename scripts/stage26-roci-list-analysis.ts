/**
 * Stage 26 — ROCI List Deep Analysis (READ-ONLY)
 * Analyzes the 200 direct contacts in the ROCI list.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}
import { getSupabaseAdmin } from "../src/db/supabase.js";
const db = getSupabaseAdmin();
const GRAMSCODE = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const ROCI_LIST = "8ac556af-e520-4aa5-bc03-5369f206ed33";

function h(t: string): void { console.log(`\n${"═".repeat(76)}\n  ${t}\n${"═".repeat(76)}`); }
function sub(t: string): void { console.log(`\n── ${t} ${"─".repeat(Math.max(0, 68 - t.length))}`); }
function row(label: string, value: unknown): void {
  const v = value === null || value === undefined ? "(NULL)" : String(value);
  console.log(`  ${label.padEnd(44)} ${v}`);
}

// ── Get all 200 contact IDs ───────────────────────────────────────────────────
const { data: allMembers, error: memErr } = await db
  .from("list_members")
  .select("contact_id")
  .eq("list_id", ROCI_LIST);
if (memErr) { console.log("ERROR:", memErr.message); process.exit(1); }

const contactIds = ((allMembers ?? []) as { contact_id: string | null }[])
  .filter(r => r.contact_id).map(r => r.contact_id as string);

h("ROCI LIST CONTACT ANALYSIS");
row("Total direct contact members", contactIds.length);

// ── Fetch all contacts ────────────────────────────────────────────────────────
const { data: cons, error: conErr } = await db
  .from("contacts")
  .select("id, job_title, email_status, email, company_id, status, first_name, last_name")
  .in("id", contactIds);
if (conErr) { console.log("ERROR fetching contacts:", conErr.message); process.exit(1); }

type ConRow = { id: string; job_title: string | null; email_status: string | null; email: string | null; company_id: string; status: string; first_name: string | null; last_name: string | null };
const contacts = (cons ?? []) as ConRow[];
row("Contacts fetched", contacts.length);

// Email analysis — some emails are JSON strings (Prospeo raw response)
let emailsReal = 0;
let emailsJsonFormat = 0;
let emailsNull = 0;
let emailsVerifiedInJson = 0;
for (const c of contacts) {
  if (!c.email) { emailsNull++; continue; }
  if (c.email.startsWith("{")) {
    emailsJsonFormat++;
    try {
      const parsed = JSON.parse(c.email) as { status?: string };
      if (parsed.status === "VERIFIED") emailsVerifiedInJson++;
    } catch { /* skip */ }
  } else {
    emailsReal++;
  }
}

sub("Email field analysis");
row("Plain email string (real email)",   emailsReal);
row("JSON-format (Prospeo raw response)", emailsJsonFormat);
row("  of which VERIFIED in JSON",        emailsVerifiedInJson);
row("No email (null)",                    emailsNull);
row("email_status = VERIFIED",            contacts.filter(c => c.email_status === "VERIFIED").length);

// ── Fetch company details ─────────────────────────────────────────────────────
const companyIds = [...new Set(contacts.map(c => c.company_id))];
row("\nUnique companies represented", companyIds.length);

const { data: coData, error: coErr } = await db
  .from("companies")
  .select("id, name, domain, industry, company_size, country, city, icp_score, status")
  .in("id", companyIds);
if (coErr) { console.log("ERROR fetching companies:", coErr.message); }

type CoRow = { id: string; name: string; domain: string | null; industry: string | null; company_size: string | null; country: string | null; city: string | null; icp_score: number | null; status: string };
const companies = (coData ?? []) as CoRow[];
const coMap = new Map<string, CoRow>();
for (const co of companies) coMap.set(co.id, co);

// ── Contact job title distribution ────────────────────────────────────────────
sub("Job title distribution (all 200)");
const byTitle = new Map<string, number>();
for (const c of contacts) {
  const k = c.job_title ?? "(null)";
  byTitle.set(k, (byTitle.get(k) ?? 0) + 1);
}
const sortedTitles = [...byTitle.entries()].sort((a, b) => b[1] - a[1]);
for (const [title, count] of sortedTitles) {
  console.log(`  ${String(count).padStart(4)}  ${title}`);
}

// ── Function inference ────────────────────────────────────────────────────────
sub("Inferred function (from title keywords)");
const functionBuckets: Record<string, RegExp> = {
  "FOUNDER/CEO/MD":   /\b(founder|co-founder|owner|ceo|managing director|md\b|president|proprietor)\b/i,
  "CREATIVE/DESIGN":  /\b(creative|design|art director|brand|visual|motion|animation|illustrat)\b/i,
  "DIGITAL/MARKETING":/\b(digital|marketing|seo|ppc|social media|campaign|demand|growth|paid|organic)\b/i,
  "CLIENT_SERVICES":  /\b(client|account|project manager|project director|delivery|service|customer|relationship)\b/i,
  "CONTENT/COPY":     /\b(content|copy|writer|editorial|journalist|communications|pr |public relations)\b/i,
  "TECH/ENGINEERING": /\b(developer|engineer|tech|cto|software|frontend|backend|full stack|architect|devops|data)\b/i,
  "OPERATIONS":       /\b(operations|ops|director of ops|chief of staff|coo|production|studio)\b/i,
  "STRATEGY":         /\b(strategy|strategist|planner|planning|consultant|advisory)\b/i,
  "SALES/BIZ_DEV":    /\b(sales|business dev|bdr|sdr|commercial|revenue|new business)\b/i,
  "DIRECTOR_GENERIC": /\b(director(?! of (digital|creative|client|art|marketing|design|content|brand|social|media)))\b/i,
};

const funcCount: Record<string, number> = {};
const uncategorized: string[] = [];
for (const c of contacts) {
  const title = c.job_title ?? "";
  let matched = false;
  for (const [func, re] of Object.entries(functionBuckets)) {
    if (re.test(title)) {
      funcCount[func] = (funcCount[func] ?? 0) + 1;
      matched = true;
      break;
    }
  }
  if (!matched) {
    funcCount["OTHER/UNCATEGORIZED"] = (funcCount["OTHER/UNCATEGORIZED"] ?? 0) + 1;
    if (title && uncategorized.length < 20) uncategorized.push(title);
  }
}
for (const [func, count] of Object.entries(funcCount).sort((a, b) => b[1] - a[1])) {
  const pct = ((count / contacts.length) * 100).toFixed(1);
  console.log(`  ${String(count).padStart(4)}  ${func.padEnd(30)} (${pct}%)`);
}
if (uncategorized.length > 0) {
  console.log(`\n  Uncategorized titles (sample):`, uncategorized.join("; "));
}

// ── Seniority inference ───────────────────────────────────────────────────────
sub("Inferred seniority level");
const senBuckets: Record<string, RegExp> = {
  "FOUNDER/OWNER":   /\b(founder|co-founder|owner|proprietor)\b/i,
  "C_SUITE":         /\b(ceo|cto|cfo|coo|cmo|cpo|ciso|chief\b)\b/i,
  "MANAGING_DIR":    /\b(managing director|md\b)\b/i,
  "VP":              /\b(vp\b|vice president|v\.p\.)\b/i,
  "DIRECTOR":        /\b(director)\b/i,
  "HEAD_OF":         /\b(head of|head,)\b/i,
  "SENIOR_MANAGER":  /\b(senior manager|senior director)\b/i,
  "MANAGER_LEAD":    /\b(\bmanager\b|team lead|lead \w|\blead,)\b/i,
  "SENIOR_IC":       /\b(senior |principal |staff |sr\.|sr )\b/i,
  "IC":              /\b(specialist|analyst|coordinator|representative|associate|executive(?! director| chairman)\b)\b/i,
};

const senCount: Record<string, number> = {};
for (const c of contacts) {
  const title = c.job_title ?? "";
  let matched = false;
  for (const [sen, re] of Object.entries(senBuckets)) {
    if (re.test(title)) {
      senCount[sen] = (senCount[sen] ?? 0) + 1;
      matched = true;
      break;
    }
  }
  if (!matched) senCount["OTHER/UNKNOWN"] = (senCount["OTHER/UNKNOWN"] ?? 0) + 1;
}
for (const [sen, count] of Object.entries(senCount).sort((a, b) => b[1] - a[1])) {
  const pct = ((count / contacts.length) * 100).toFixed(1);
  console.log(`  ${String(count).padStart(4)}  ${sen.padEnd(22)} (${pct}%)`);
}

// ── Company distribution ──────────────────────────────────────────────────────
h("COMPANY DISTRIBUTION");
row("Unique companies", companies.length);

sub("Industry distribution");
const byIndustry = new Map<string, number>();
for (const co of companies) {
  const k = co.industry ?? "(null)";
  byIndustry.set(k, (byIndustry.get(k) ?? 0) + 1);
}
for (const [ind, count] of [...byIndustry.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((count / companies.length) * 100).toFixed(1);
  console.log(`  ${String(count).padStart(4)}  ${ind.padEnd(50)} (${pct}%)`);
}

sub("Country distribution");
const byCountry = new Map<string, number>();
for (const co of companies) {
  const k = co.country ?? "(null)";
  byCountry.set(k, (byCountry.get(k) ?? 0) + 1);
}
for (const [country, count] of [...byCountry.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((count / companies.length) * 100).toFixed(1);
  console.log(`  ${String(count).padStart(4)}  ${country.padEnd(30)} (${pct}%)`);
}

sub("Company size distribution");
const bySize = new Map<string, number>();
for (const co of companies) {
  const k = co.company_size ?? "(null)";
  bySize.set(k, (bySize.get(k) ?? 0) + 1);
}
for (const [size, count] of [...bySize.entries()].sort((a, b) => b[1] - a[1])) {
  const pct = ((count / companies.length) * 100).toFixed(1);
  console.log(`  ${String(count).padStart(4)}  ${String(size).padEnd(20)} (${pct}%)`);
}

sub("City distribution (top 20)");
const byCity = new Map<string, number>();
for (const co of companies) {
  const k = co.city ?? "(null)";
  byCity.set(k, (byCity.get(k) ?? 0) + 1);
}
for (const [city, count] of [...byCity.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(count).padStart(4)}  ${city}`);
}

sub("ICP score distribution");
const withScore = companies.filter(co => co.icp_score !== null);
row("Companies with icp_score",    withScore.length);
row("Companies without icp_score", companies.length - withScore.length);
if (withScore.length > 0) {
  const scores = withScore.map(co => co.icp_score as number);
  row("avg", (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1));
  row("min", Math.min(...scores));
  row("max", Math.max(...scores));
  // Distribution buckets
  const buckets = [0, 20, 40, 60, 80, 100];
  for (let i = 0; i < buckets.length - 1; i++) {
    const lo = buckets[i], hi = buckets[i+1];
    const n = scores.filter(s => s >= lo && s < hi).length;
    console.log(`  ${lo}-${hi}: ${n}`);
  }
}

sub("Sample company names (first 30)");
for (const co of companies.slice(0, 30)) {
  const title = contacts.find(c => c.company_id === co.id)?.job_title ?? "";
  console.log(`  ${co.name.padEnd(45)} ${(co.domain ?? "").padEnd(35)} size=${co.company_size ?? "?"} ${co.country ?? "?"}`);
}

// ── Account intelligence for these companies ──────────────────────────────────
h("ACCOUNT INTELLIGENCE FOR ROCI COMPANIES");
const BATCH = 200;
type AiRow = { company_id: string; is_ready: boolean; opportunity_score: number | null };
const allAi: AiRow[] = [];
for (let i = 0; i < companyIds.length; i += BATCH) {
  const batch = companyIds.slice(i, i + BATCH);
  const { data: aiRows, error: aiErr } = await db
    .from("account_intelligence")
    .select("company_id, is_ready, opportunity_score")
    .eq("client_id", GRAMSCODE)
    .in("company_id", batch);
  if (aiErr) { console.log("ERROR:", aiErr.message); break; }
  allAi.push(...((aiRows ?? []) as AiRow[]));
}
row("ROCI companies with account_intelligence", allAi.length);
row("ROCI companies WITHOUT account_intelligence", companyIds.length - allAi.length);

// ── Signals for these companies ───────────────────────────────────────────────
h("SIGNALS FOR ROCI COMPANIES");
const { data: sigRows, error: sigErr } = await db
  .from("signals")
  .select("signal_type, company_id")
  .eq("client_id", GRAMSCODE)
  .in("company_id", companyIds);
if (sigErr) {
  console.log("ERROR:", sigErr.message);
} else {
  type SigRow = { signal_type: string; company_id: string };
  const sigs = (sigRows ?? []) as SigRow[];
  row("Total signals for ROCI companies", sigs.length);
  const bySigType = new Map<string, number>();
  for (const s of sigs) bySigType.set(s.signal_type, (bySigType.get(s.signal_type) ?? 0) + 1);
  const sigCompanies = new Set(sigs.map(s => s.company_id));
  row("ROCI companies WITH signals", sigCompanies.size);
  row("ROCI companies WITHOUT signals", companyIds.length - sigCompanies.size);
  for (const [t, count] of [...bySigType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${t}`);
  }
}

h("DONE");
console.log("  READ-ONLY. Zero writes.\n");
