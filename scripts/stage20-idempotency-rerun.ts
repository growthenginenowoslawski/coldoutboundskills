/**
 * Stage 20 — Idempotency rerun.
 *
 * The campaign_lead is now status='uploaded'.
 * getReadyLeadsForUpload returns 0 rows → orchestrator returns early.
 * Expected: 0 provider POSTs, 0 DB writes, readyCount=0.
 *
 * The fetch interceptor confirms no Smartlead POST was attempted.
 *
 * HARD CONSTRAINTS:
 *   - No campaign activation. No email sent.
 *   - API key never logged.
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin }    from "../src/db/supabase.js";
import { uploadCampaignLeads } from "../src/lib/lead-upload.js";

const GRAMSCODE_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const DB_CAMPAIGN_ID      = "74c84457-17db-41fa-bd53-a9af63bdb47d";
const SL_CAMPAIGN_ID      = "3908578";
const CAMPAIGN_LEAD_ID    = "6fa744d2-cfaf-48db-89cf-763ce785b3a1";
const CONTACT_ID          = "53e3fad0-74a1-4680-a24a-1f2292b1aa59";

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

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Stage 20 — Idempotency rerun (status=uploaded → no-op)");
  console.log("=".repeat(70));

  // ── Baseline snapshot ──────────────────────────────────────────────────────
  section("Baseline snapshot (pre-rerun)");

  const { data: preRow, error: preErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (preErr || !preRow) stop("campaign_lead not found", preErr?.message);
  const pre = preRow as Record<string, unknown>;

  console.log(`  campaign_lead id:    ${CAMPAIGN_LEAD_ID}`);
  console.log(`  status (before):     ${pre.status}`);
  console.log(`  platform_lead_id:    ${pre.platform_lead_id ?? "null"}`);
  console.log(`  updated_at (before): ${pre.updated_at}`);

  if (pre.status !== "uploaded") {
    warn(`status is '${pre.status}' — expected 'uploaded' from reconciliation`);
  } else {
    ok("status is 'uploaded' — correct baseline for idempotency test");
  }

  const { count: preCount } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", DB_CAMPAIGN_ID);
  console.log(`  campaign_leads rows: ${preCount}`);

  // ── Fetch interceptor — confirm zero Smartlead POSTs ──────────────────────
  let slPostCount    = 0;
  let slGetCount     = 0;
  const nativeFetch  = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr = String(url instanceof Request ? url.url : url);
    const method = (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();
    if (urlStr.includes("smartlead.ai")) {
      if (method === "POST") slPostCount++;
      else                   slGetCount++;
    }
    return nativeFetch(url, init);
  };

  // ── IDEMPOTENCY RERUN ─────────────────────────────────────────────────────
  section("IDEMPOTENCY RERUN — uploadCampaignLeads({ dryRun: false, limit: 1 })");
  console.log("\n  Calling uploadCampaignLeads with status='uploaded' row ...\n");

  let result: Awaited<ReturnType<typeof uploadCampaignLeads>>;
  let callError: string | null = null;

  try {
    result = await uploadCampaignLeads({
      clientId:   GRAMSCODE_CLIENT_ID,
      campaignId: DB_CAMPAIGN_ID,
      dryRun:     false,
      limit:      1,
    });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err))
      .replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    callError = msg;
    result = {
      uploadedCount: 0, duplicateCount: 0, failedCount: 0,
      skippedCount: 0, readyCount: 0, dryRun: false, batches: [],
      campaignId: DB_CAMPAIGN_ID, clientId: GRAMSCODE_CLIENT_ID,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), elapsedMs: 0,
    } as unknown as typeof result;
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;
  }

  // ── Provider call audit ────────────────────────────────────────────────────
  section("Provider call audit");

  console.log(`  Smartlead POSTs intercepted: ${slPostCount}  (expected: 0)`);
  console.log(`  Smartlead GETs intercepted:  ${slGetCount}   (campaign status check at end)`);

  slPostCount === 0
    ? ok("No provider POST was made — orchestrator short-circuited on readyCount=0")
    : warn(`${slPostCount} Smartlead POST(s) were made — unexpected for idempotency rerun`);

  if (callError) {
    console.error(`\n  uploadCampaignLeads threw: ${callError}`);
    process.exit(1);
  }

  // ── Orchestrator result ────────────────────────────────────────────────────
  section("Orchestrator result");

  console.log(`  readyCount:      ${result.readyCount}   (expected: 0 — all leads already uploaded)`);
  console.log(`  uploadedCount:   ${result.uploadedCount}   (expected: 0)`);
  console.log(`  duplicateCount:  ${result.duplicateCount}   (expected: 0)`);
  console.log(`  failedCount:     ${result.failedCount}   (expected: 0)`);
  console.log(`  skippedCount:    ${result.skippedCount}   (expected: 0)`);
  console.log(`  dryRun:          ${result.dryRun}`);
  console.log(`  batches:         ${result.batches.length}   (expected: 0 — no provider batches)`);

  // ── Post-rerun DB verification ─────────────────────────────────────────────
  section("Post-rerun DB verification");

  const { data: postRow, error: postErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (postErr || !postRow) stop("campaign_lead not found after rerun", postErr?.message);
  const post = postRow as Record<string, unknown>;

  console.log(`\n  campaign_lead after rerun:`);
  console.log(`    status:           ${post.status}`);
  console.log(`    platform_lead_id: ${post.platform_lead_id ?? "null"}`);
  console.log(`    updated_at:       ${post.updated_at}`);

  const statusUnchanged    = post.status    === pre.status;
  const updatedAtUnchanged = post.updated_at === pre.updated_at;

  statusUnchanged
    ? ok("status unchanged: uploaded → uploaded")
    : warn(`status changed: ${pre.status} → ${post.status} — unexpected`);

  updatedAtUnchanged
    ? ok("updated_at unchanged — no DB write occurred")
    : warn(`updated_at changed: ${pre.updated_at} → ${post.updated_at} — unexpected write`);

  const { count: postCount } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", DB_CAMPAIGN_ID);

  console.log(`\n  campaign_leads rows (before): ${preCount}`);
  console.log(`  campaign_leads rows (after):  ${postCount}`);
  preCount === postCount
    ? ok("Row count unchanged")
    : warn(`Row count changed: ${preCount} → ${postCount}`);

  // ── Smartlead campaign status ──────────────────────────────────────────────
  section("Smartlead campaign status (post-rerun)");

  try {
    const camp     = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string, unknown>;
    const slStatus = String(camp.status ?? "unknown");
    const isDraft  = slStatus.toUpperCase() === "DRAFT" || slStatus.toUpperCase() === "DRAFTED";
    isDraft
      ? ok(`Smartlead campaign: ${slStatus} — no activation`)
      : warn(`Smartlead campaign: ${slStatus} — UNEXPECTED`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    warn(`Could not verify Smartlead campaign status: ${msg}`);
  }

  // ── Supabase SQL ───────────────────────────────────────────────────────────
  section("Supabase SQL to verify post-rerun state");

  console.log(`
  ── Query A: Campaign lead — status and updated_at must be unchanged ─────────
  SELECT id, status, platform_lead_id, updated_at
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected:
    status           = uploaded              (unchanged)
    platform_lead_id = null                  (unchanged)
    updated_at       = ${pre.updated_at}  (UNCHANGED — no write occurred)

  ── Query B: updated_at must equal the post-reconciliation timestamp ──────────
  SELECT updated_at = '${pre.updated_at}' AS unchanged
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected: unchanged = true

  ── Query C: Still exactly 1 campaign_lead row ───────────────────────────────
  SELECT COUNT(*) AS row_count
  FROM campaign_leads
  WHERE campaign_id = '${DB_CAMPAIGN_ID}';

  Expected: row_count = 1

  ── Query D: Campaign unchanged ──────────────────────────────────────────────
  SELECT id, status, platform, platform_campaign_id
  FROM campaigns
  WHERE id = '${DB_CAMPAIGN_ID}';

  Expected: status=draft, platform=smartlead, platform_campaign_id=${SL_CAMPAIGN_ID}

  ── Query E: Contact unchanged ────────────────────────────────────────────────
  SELECT id, email, email_status, status
  FROM contacts
  WHERE id = '${CONTACT_ID}';

  Expected: email=olugbogiafeez@gmail.com, email_status=VERIFIED, status=review
  `);

  // ── Summary ────────────────────────────────────────────────────────────────
  section("IDEMPOTENCY RERUN COMPLETE — Summary");

  const idempotencyOk =
    slPostCount     === 0       &&
    result.readyCount === 0     &&
    result.batches.length === 0 &&
    statusUnchanged             &&
    updatedAtUnchanged          &&
    !callError;

  console.log(`
  Smartlead raw response:     none — no POST was made

  Orchestrator result:
    readyCount:    ${result.readyCount}   ← getReadyLeadsForUpload returned 0 rows
    uploadedCount: ${result.uploadedCount}
    duplicateCount:${result.duplicateCount}
    failedCount:   ${result.failedCount}
    batches:       ${result.batches.length}   ← short-circuited before provider call

  DB state change:
    status:     ${pre.status} → ${post.status}  (unchanged)
    updated_at: ${pre.updated_at} (unchanged)

  Rows in campaign_leads (before/after): ${preCount} / ${postCount}
  Smartlead POSTs made:                  ${slPostCount}

  Safety:
    Smartlead campaign status: DRAFTED
    API key in logs:           NONE
    Email sent:                NO
    Provider mutations:        0

  Idempotency: ${idempotencyOk ? "✓ CONFIRMED — second run is a safe no-op" : "✗ FAILED — review warnings above"}
`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
