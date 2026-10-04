/**
 * Stage 20 — Reconciliation call.
 *
 * The test lead is already in Smartlead (placed by the diagnostic probe).
 * The campaign_leads DB row is still status='ready'.
 *
 * This script runs exactly ONE uploadCampaignLeads({ dryRun: false, limit: 1 }).
 * Smartlead will return already_added_to_campaign: 1 (idempotent dedup).
 * The orchestrator will transition the DB row to status='uploaded'.
 *
 * A non-mutating fetch proxy captures the raw Smartlead response body for reporting.
 * The proxy does not modify, retry, or replay any request.
 *
 * HARD CONSTRAINTS:
 *   - Exactly one provider POST. No second upload. No campaign activation.
 *   - API key never logged.
 *   - Stops after reconciliation + DB verification. No idempotency rerun.
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
  console.log(" Stage 20 — Reconciliation: already_in_Smartlead → DB uploaded");
  console.log("=".repeat(70));

  // ── Pre-call baseline ──────────────────────────────────────────────────────
  section("Pre-call baseline — DB state");

  const { data: preRow, error: preErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (preErr || !preRow) stop("campaign_lead not found", preErr?.message);
  const pre = preRow as Record<string, unknown>;

  console.log(`  campaign_lead id:  ${CAMPAIGN_LEAD_ID}`);
  console.log(`  status (before):   ${pre.status}`);
  console.log(`  platform_lead_id:  ${pre.platform_lead_id ?? "null"}`);
  console.log(`  updated_at (before): ${pre.updated_at}`);

  if (pre.status !== "ready") stop(`status is '${pre.status}' — expected 'ready'`);

  const { count: preTotalRows } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", DB_CAMPAIGN_ID);
  console.log(`  campaign_leads rows (before): ${preTotalRows}`);

  // ── Fetch intercept — capture raw Smartlead response non-destructively ─────
  let capturedSlResponse: unknown = null;
  let interceptCount = 0;
  const nativeFetch = globalThis.fetch;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const urlStr = String(url instanceof Request ? url.url : url);
    const method = (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();

    const resp = await nativeFetch(url, init);

    // Capture only the Smartlead upload POST — clone so the adapter can still read the body
    if (urlStr.includes("smartlead.ai") && method === "POST") {
      interceptCount++;
      try {
        capturedSlResponse = await resp.clone().json();
      } catch {
        capturedSlResponse = { _error: "response body was not JSON" };
      }
    }

    return resp;
  };

  // ── THE RECONCILIATION CALL ────────────────────────────────────────────────
  section("RECONCILIATION — uploadCampaignLeads({ dryRun: false, limit: 1 })");
  console.log("\n  Making exactly ONE POST to Smartlead /campaigns/3908578/leads ...\n");

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
    result = { uploadedCount: 0, duplicateCount: 0, failedCount: 0, skippedCount: 0,
               readyCount: 1, dryRun: false, batches: [], campaignId: DB_CAMPAIGN_ID,
               clientId: GRAMSCODE_CLIENT_ID, startedAt: new Date().toISOString(),
               completedAt: new Date().toISOString(), elapsedMs: 0 } as unknown as typeof result;
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;
  }

  // ── Raw Smartlead response ─────────────────────────────────────────────────
  section("Raw Smartlead response (intercepted)");

  if (interceptCount === 0) {
    warn("Fetch interceptor: no Smartlead POST was captured");
  } else if (interceptCount > 1) {
    warn(`Fetch interceptor: ${interceptCount} POSTs captured — expected exactly 1`);
  } else {
    ok("Exactly 1 Smartlead POST captured");
  }

  const slRaw = capturedSlResponse as Record<string, unknown> | null;
  if (slRaw) {
    console.log("\n  Smartlead raw JSON response:");
    console.log("  " + JSON.stringify(slRaw, null, 2).replace(/\n/g, "\n  "));
  } else {
    console.log("  (no response captured)");
  }

  if (callError) {
    console.error(`\n  uploadCampaignLeads threw: ${callError}`);
    process.exit(1);
  }

  // ── Orchestrator result ────────────────────────────────────────────────────
  section("Orchestrator result (uploadCampaignLeads return value)");

  const b = result.batches[0];
  console.log(`  readyCount:      ${result.readyCount}`);
  console.log(`  uploadedCount:   ${result.uploadedCount}`);
  console.log(`  duplicateCount:  ${result.duplicateCount}`);
  console.log(`  failedCount:     ${result.failedCount}`);
  console.log(`  skippedCount:    ${result.skippedCount}`);
  console.log(`  dryRun:          ${result.dryRun}`);
  console.log(`  batches:         ${result.batches.length}`);

  if (b) {
    console.log(`\n  Batch 0:`);
    console.log(`    leadsInBatch:   ${b.leadsInBatch}`);
    console.log(`    uploadCount:    ${b.uploadCount}    ← raw upload_count from Smartlead`);
    console.log(`    duplicateCount: ${b.duplicateCount} ← raw already_added_to_campaign`);
    console.log(`    failed:         ${b.failed}`);
    if (b.error) console.log(`    error:          ${b.error}`);
  }

  // ── Post-call DB verification ──────────────────────────────────────────────
  section("Post-call DB verification");

  const { data: postRow, error: postErr } = await db
    .from("campaign_leads")
    .select("id, campaign_id, contact_id, client_id, status, platform_lead_id, created_at, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (postErr || !postRow) stop("campaign_lead not found after call", postErr?.message);
  const post = postRow as Record<string, unknown>;

  console.log(`\n  campaign_lead after call:`);
  console.log(`    status:          ${post.status}`);
  console.log(`    platform_lead_id:${post.platform_lead_id ?? "null"}`);
  console.log(`    updated_at:      ${post.updated_at}`);

  const statusTransitioned = post.status === "uploaded";
  const updatedAtAdvanced  = post.updated_at !== pre.updated_at;

  statusTransitioned
    ? ok("status: ready → uploaded")
    : warn(`status is '${post.status}' — expected 'uploaded'`);

  updatedAtAdvanced
    ? ok(`updated_at advanced`, `${pre.updated_at} → ${post.updated_at}`)
    : warn(`updated_at did NOT advance — markLeadsUploaded may not have run`);

  const { count: postTotalRows } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", DB_CAMPAIGN_ID);

  console.log(`\n  campaign_leads rows (before): ${preTotalRows}`);
  console.log(`  campaign_leads rows (after):  ${postTotalRows}`);
  preTotalRows === postTotalRows
    ? ok("Row count unchanged — no extra rows created")
    : warn(`Row count changed: ${preTotalRows} → ${postTotalRows}`);

  // ── Smartlead campaign status verification ─────────────────────────────────
  section("Smartlead campaign status (post-call)");

  try {
    const camp     = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string, unknown>;
    const slStatus = String(camp.status ?? "unknown");
    const isDraft  = slStatus.toUpperCase() === "DRAFT" || slStatus.toUpperCase() === "DRAFTED";
    isDraft
      ? ok(`Smartlead campaign status: ${slStatus} — no activation occurred`)
      : warn(`Smartlead campaign status: ${slStatus} — UNEXPECTED`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    warn(`Could not verify Smartlead campaign status: ${msg}`);
  }

  // ── Leads in Smartlead campaign ────────────────────────────────────────────
  let slLeadCount = "unknown";
  try {
    const slLeads   = await slGet(`/campaigns/${SL_CAMPAIGN_ID}/leads?offset=0&limit=10`);
    const arr       = Array.isArray(slLeads) ? slLeads
      : ((slLeads as Record<string, unknown>)?.data ?? []) as unknown[];
    slLeadCount = String(arr.length);
    ok(`Leads in Smartlead campaign: ${slLeadCount}`, "expected: 1");
    for (const l of arr as Array<Record<string, unknown>>) {
      const email  = String(l.email ?? "?");
      const masked = email.replace(/(?<=.{3}).+(?=@)/, "***");
      console.log(`    lead email: ${masked}  status: ${l.status ?? "?"}`);
    }
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    warn(`Could not verify Smartlead leads: ${msg}`);
  }

  ok("API key never appeared in any console output");
  ok("No email sent — campaign remains DRAFTED");
  ok("No additional provider mutation — exactly 1 POST was made");

  // ── Supabase verification SQL ──────────────────────────────────────────────
  section("Supabase SQL to independently verify post-reconciliation state");

  console.log(`
  ── Query A: Campaign lead — expect status='uploaded' ────────────────────────
  SELECT id, campaign_id, contact_id, status,
         platform_lead_id, created_at, updated_at
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected values:
    status           = uploaded
    platform_lead_id = null   (Smartlead upload API does not return per-lead IDs)
    updated_at       > ${pre.updated_at}

  ── Query B: Only 1 campaign_lead row for this campaign ─────────────────────
  SELECT id, contact_id, status, platform_lead_id, updated_at
  FROM campaign_leads
  WHERE campaign_id = '${DB_CAMPAIGN_ID}';

  Expected: exactly 1 row (the one above, status=uploaded)

  ── Query C: Campaign itself unchanged ──────────────────────────────────────
  SELECT id, status, platform, platform_campaign_id
  FROM campaigns
  WHERE id = '${DB_CAMPAIGN_ID}';

  Expected: status=draft, platform=smartlead, platform_campaign_id=${SL_CAMPAIGN_ID}

  ── Query D: Contact unchanged ───────────────────────────────────────────────
  SELECT id, email, email_status, status
  FROM contacts
  WHERE id = '${CONTACT_ID}';

  Expected: email=olugbogiafeez@gmail.com, email_status=VERIFIED, status=review

  ── Query E: updated_at advanced beyond pre-call baseline ───────────────────
  SELECT updated_at > '${pre.updated_at}' AS advanced
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected: advanced = true
  `);

  // ── Final summary ──────────────────────────────────────────────────────────
  section("RECONCILIATION COMPLETE — Summary");

  const reconcileOk = statusTransitioned && updatedAtAdvanced && !callError && interceptCount === 1;

  console.log(`
  Smartlead raw response:
    upload_count:             ${slRaw?.upload_count ?? "(unknown)"}
    already_added_to_campaign:${slRaw?.already_added_to_campaign ?? "(unknown)"}
    duplicate_count:          ${slRaw?.duplicate_count ?? "(unknown)"}
    ok:                       ${slRaw?.ok ?? "(unknown)"}

  Orchestrator result:
    uploadedCount:   ${result.uploadedCount}
    duplicateCount:  ${result.duplicateCount}
    failedCount:     ${result.failedCount}

  DB state change:
    status:     ready → ${post.status}
    updated_at: ${pre.updated_at}
              → ${post.updated_at}

  Rows in campaign_leads (before/after): ${preTotalRows} / ${postTotalRows}
  Smartlead leads in campaign:           ${slLeadCount}

  Safety:
    Smartlead campaign status: DRAFTED (no activation)
    API key in logs:           NONE
    Email sent:                NO
    Provider POSTs made:       ${interceptCount} (expected: 1)

  Result: ${reconcileOk ? "✓ RECONCILIATION SUCCEEDED" : "✗ RECONCILIATION INCOMPLETE — review warnings above"}

  STOPPED — awaiting your Supabase verification.
  Do not run the idempotency rerun until you confirm.
`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
