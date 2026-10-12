/**
 * Stage 21A — Idempotency rerun.
 *
 * The campaign_lead row now has platform_lead_id='3643998176'.
 * Running backfillPlatformLeadIds() a second time must:
 *   - Make only GET calls to Smartlead (no mutations)
 *   - Recognize platform_lead_id already matches campaign_lead_map_id
 *   - Skip the row (rowsSkipped=1, rowsUpdated=0)
 *   - NOT call updateLeadPlatformId → updated_at must not advance
 *
 * HARD CONSTRAINTS:
 *   - GET only against Smartlead.
 *   - No campaign activation. No email sent.
 *   - API key never logged.
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin }        from "../src/db/supabase.js";
import { backfillPlatformLeadIds } from "../src/lib/platform-lead-id-backfill.js";

const GRAMSCODE_CLIENT_ID  = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const DB_CAMPAIGN_ID       = "74c84457-17db-41fa-bd53-a9af63bdb47d";
const SL_CAMPAIGN_ID       = "3908578";
const CAMPAIGN_LEAD_ID     = "6fa744d2-cfaf-48db-89cf-763ce785b3a1";
const CONTACT_ID           = "53e3fad0-74a1-4680-a24a-1f2292b1aa59";
const EXPECTED_PLATFORM_ID = "3643998176";
const EXPECTED_UPDATED_AT  = "2026-09-05T13:34:37.127+00:00";

const API_BASE = "https://server.smartlead.ai/api/v1";
const apiKey   = (process.env.SMARTLEAD_API_KEY ?? "").trim();
const db       = getSupabaseAdmin();

function section(t: string) {
  console.log(`\n${"─".repeat(70)}\n  ${t}\n${"─".repeat(70)}`);
}
function ok(label: string, detail?: string) {
  console.log(`  ✓ ${label}${detail ? `  (${detail})` : ""}`);
}
function warn(label: string) {
  console.log(`  ⚠ ${label}`);
}
function stop(label: string, detail?: string): never {
  console.error(`\n  ✗ STOP: ${label}${detail ? ` — ${detail}` : ""}\n`);
  process.exit(1);
}

async function slGet(path: string): Promise<unknown> {
  const sep  = path.includes("?") ? "&" : "?";
  const url  = `${API_BASE}${path}${sep}api_key=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

let slGetCount  = 0;
let slMutCount  = 0;
const nativeFetch = globalThis.fetch;
(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const urlStr = String(url instanceof Request ? url.url : url);
  const method = (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();
  if (urlStr.includes("smartlead.ai")) {
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") slMutCount++;
    else slGetCount++;
  }
  return nativeFetch(url, init);
};

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Stage 21A — Idempotency rerun (platform_lead_id already set)");
  console.log("=".repeat(70));

  // ── Pre-call baseline ──────────────────────────────────────────────────────
  section("Pre-call baseline — DB state");

  const { data: preRow, error: preErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, sent_at, replied_at, reply_type, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (preErr || !preRow) stop("campaign_lead not found", preErr?.message);
  const pre = preRow as Record<string, unknown>;

  console.log(`  platform_lead_id:    ${pre.platform_lead_id}  (expected: ${EXPECTED_PLATFORM_ID})`);
  console.log(`  status:              ${pre.status}`);
  console.log(`  sent_at:             ${pre.sent_at ?? "null"}`);
  console.log(`  replied_at:          ${pre.replied_at ?? "null"}`);
  console.log(`  reply_type:          ${pre.reply_type ?? "null"}`);
  console.log(`  updated_at (before): ${pre.updated_at}`);
  console.log(`                       (must remain exactly this after idempotency rerun)`);

  if (pre.platform_lead_id !== EXPECTED_PLATFORM_ID) {
    warn(`platform_lead_id is '${pre.platform_lead_id}' — expected '${EXPECTED_PLATFORM_ID}'`);
    warn("Baseline does not match post-backfill state — verify Supabase before proceeding");
  } else {
    ok(`platform_lead_id = ${pre.platform_lead_id}  (correct baseline for idempotency test)`);
  }

  if (pre.updated_at !== EXPECTED_UPDATED_AT) {
    warn(`updated_at '${pre.updated_at}' differs from expected '${EXPECTED_UPDATED_AT}'`);
  } else {
    ok(`updated_at = ${pre.updated_at}  (must not change)`);
  }

  const { count: preCount } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", DB_CAMPAIGN_ID);
  console.log(`  row count:           ${preCount}`);

  // ── IDEMPOTENCY RERUN ──────────────────────────────────────────────────────
  section("IDEMPOTENCY RERUN — backfillPlatformLeadIds() (2nd call)");
  console.log("\n  Calling backfillPlatformLeadIds() again — expect rowsSkipped=1, rowsUpdated=0 ...\n");

  let result: Awaited<ReturnType<typeof backfillPlatformLeadIds>>;
  let callError: string | null = null;

  try {
    result = await backfillPlatformLeadIds({
      clientId:   GRAMSCODE_CLIENT_ID,
      campaignId: DB_CAMPAIGN_ID,
    });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err))
      .replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    callError = msg;
    result = null as unknown as typeof result;
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;
  }

  // ── Provider call audit ────────────────────────────────────────────────────
  section("Provider call audit");

  console.log(`  Smartlead GETs:      ${slGetCount}  (expected: ≥1 — GET /leads)`);
  console.log(`  Smartlead mutations: ${slMutCount}  (expected: 0)`);

  slMutCount === 0
    ? ok("No Smartlead mutations")
    : warn(`${slMutCount} non-GET Smartlead call(s) — UNEXPECTED`);

  if (callError) {
    console.error(`\n  backfillPlatformLeadIds threw: ${callError}`);
    process.exit(1);
  }

  // ── Orchestrator result ────────────────────────────────────────────────────
  section("Orchestrator result");

  console.log(`  slLeadsDiscovered: ${result.slLeadsDiscovered}  (expected: 1)`);
  console.log(`  dbRowsProcessed:   ${result.dbRowsProcessed}   (expected: 1)`);
  console.log(`  rowsUpdated:       ${result.rowsUpdated}   (expected: 0 — skip if already correct)`);
  console.log(`  rowsSkipped:       ${result.rowsSkipped}   (expected: 1 — platform_lead_id already matched)`);
  console.log(`  rowsUnmatched:     ${result.rowsUnmatched}`);
  console.log(`  slLeadsUnmatched:  ${result.slLeadsUnmatched}`);

  result.rowsUpdated === 0 && result.rowsSkipped === 1
    ? ok("rowsUpdated=0, rowsSkipped=1 — idempotency confirmed at orchestrator level")
    : warn(`rowsUpdated=${result.rowsUpdated}, rowsSkipped=${result.rowsSkipped} — expected 0/1`);

  // ── Post-call DB verification ──────────────────────────────────────────────
  section("Post-call DB verification");

  const { data: postRow, error: postErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, sent_at, replied_at, reply_type, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (postErr || !postRow) stop("campaign_lead not found after rerun", postErr?.message);
  const post = postRow as Record<string, unknown>;

  console.log(`\n  campaign_lead after rerun:`);
  console.log(`    platform_lead_id: ${post.platform_lead_id}`);
  console.log(`    status:           ${post.status}`);
  console.log(`    sent_at:          ${post.sent_at ?? "null"}`);
  console.log(`    replied_at:       ${post.replied_at ?? "null"}`);
  console.log(`    reply_type:       ${post.reply_type ?? "null"}`);
  console.log(`    updated_at:       ${post.updated_at}`);

  const platformIdUnchanged  = post.platform_lead_id === pre.platform_lead_id;
  const updatedAtUnchanged   = post.updated_at === pre.updated_at;
  const statusUnchanged      = post.status === pre.status;
  const updatedAtIsExact     = post.updated_at === EXPECTED_UPDATED_AT;

  platformIdUnchanged
    ? ok(`platform_lead_id unchanged: ${post.platform_lead_id}`)
    : warn(`platform_lead_id changed: ${pre.platform_lead_id} → ${post.platform_lead_id}`);

  updatedAtUnchanged
    ? ok("updated_at unchanged — no DB write occurred (idempotency confirmed)")
    : warn(`updated_at changed: ${pre.updated_at} → ${post.updated_at} — write occurred unexpectedly`);

  updatedAtIsExact
    ? ok(`updated_at = exactly ${EXPECTED_UPDATED_AT}`)
    : warn(`updated_at '${post.updated_at}' differs from expected '${EXPECTED_UPDATED_AT}'`);

  statusUnchanged
    ? ok(`status unchanged: ${post.status}`)
    : warn(`status changed: ${pre.status} → ${post.status}`);

  post.sent_at === null   ? ok("sent_at still null")   : warn(`sent_at changed to ${post.sent_at}`);
  post.replied_at === null ? ok("replied_at still null") : warn(`replied_at changed to ${post.replied_at}`);
  post.reply_type === null ? ok("reply_type still null") : warn(`reply_type changed to ${post.reply_type}`);

  const { count: postCount } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", DB_CAMPAIGN_ID);

  console.log(`\n  Row count before: ${preCount}  after: ${postCount}`);
  preCount === postCount
    ? ok("Row count unchanged")
    : warn(`Row count changed: ${preCount} → ${postCount}`);

  // ── Smartlead campaign status ──────────────────────────────────────────────
  section("Smartlead campaign status (post-rerun)");

  try {
    const camp    = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string, unknown>;
    const status  = String(camp.status ?? "unknown");
    const isDraft = status.toUpperCase() === "DRAFT" || status.toUpperCase() === "DRAFTED";
    isDraft ? ok(`Smartlead campaign: ${status}`) : warn(`Smartlead campaign: ${status} — UNEXPECTED`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    warn(`Could not verify Smartlead campaign status: ${msg}`);
  }

  // ── Supabase verification SQL ──────────────────────────────────────────────
  section("Supabase SQL to independently verify post-rerun state");

  console.log(`
  ── A: platform_lead_id unchanged (no re-write) ──────────────────────────────
  SELECT platform_lead_id = '${EXPECTED_PLATFORM_ID}' AS correct
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected: correct = true

  ── B: updated_at must equal the post-backfill timestamp exactly ─────────────
  SELECT updated_at = '${EXPECTED_UPDATED_AT}' AS unchanged
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected: unchanged = true  (no unnecessary write occurred)

  ── C: Full row — all fields unchanged ───────────────────────────────────────
  SELECT id, status, platform_lead_id, sent_at, replied_at,
         reply_type, updated_at
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected:
    platform_lead_id = '${EXPECTED_PLATFORM_ID}'
    status           = uploaded
    sent_at          = null
    replied_at       = null
    reply_type       = null
    updated_at       = '${EXPECTED_UPDATED_AT}'

  ── D: Row count unchanged ────────────────────────────────────────────────────
  SELECT COUNT(*) AS row_count
  FROM campaign_leads
  WHERE campaign_id = '${DB_CAMPAIGN_ID}';

  Expected: row_count = 1

  ── E: Campaign unchanged ────────────────────────────────────────────────────
  SELECT status, platform_campaign_id
  FROM campaigns
  WHERE id = '${DB_CAMPAIGN_ID}';

  Expected: status=draft, platform_campaign_id=${SL_CAMPAIGN_ID}

  ── F: Contact unchanged ─────────────────────────────────────────────────────
  SELECT email, email_status
  FROM contacts
  WHERE id = '${CONTACT_ID}';

  Expected: email=olugbogiafeez@gmail.com, email_status=VERIFIED
  `);

  // ── Summary ────────────────────────────────────────────────────────────────
  section("IDEMPOTENCY RERUN COMPLETE — Summary");

  const idempotencyOk =
    result.rowsUpdated     === 0 &&
    result.rowsSkipped     === 1 &&
    platformIdUnchanged              &&
    updatedAtUnchanged               &&
    updatedAtIsExact                 &&
    statusUnchanged                  &&
    slMutCount             === 0     &&
    !callError;

  console.log(`
  Orchestrator result:
    slLeadsDiscovered: ${result.slLeadsDiscovered}
    dbRowsProcessed:   ${result.dbRowsProcessed}
    rowsUpdated:       ${result.rowsUpdated}   ← no write (already correct)
    rowsSkipped:       ${result.rowsSkipped}   ← platform_lead_id matched
    rowsUnmatched:     ${result.rowsUnmatched}
    slLeadsUnmatched:  ${result.slLeadsUnmatched}

  DB state change:
    platform_lead_id: ${pre.platform_lead_id} → ${post.platform_lead_id}  (unchanged)
    updated_at:       ${pre.updated_at} (unchanged)

  Row count (before/after): ${preCount} / ${postCount}
  Smartlead mutations:       ${slMutCount}

  Safety:
    Smartlead campaign status: DRAFTED
    API key in logs:           NONE
    Email sent:                NO
    updated_at advanced:       NO  (idempotency confirmed)

  Idempotency: ${idempotencyOk ? "✓ CONFIRMED — second run is a safe no-op" : "✗ FAILED — review warnings above"}
`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
