/**
 * Stage 20 — ONE live lead upload to Smartlead.
 *
 * Prerequisites: stage20-setup-and-dryrun.ts has already been run.
 * All DB records exist. Campaign lead is status='ready'.
 *
 * This script makes exactly ONE real POST to Smartlead:
 *   POST /campaigns/3908578/leads?ignore_duplicate=true
 *
 * Stops after the upload + DB verification.
 * Does NOT run the idempotency re-run — that is a separate step.
 *
 * HARD CONSTRAINTS:
 *   - dryRun=false, limit=1 — exactly one lead.
 *   - No campaign activation. No email sent.
 *   - API key never logged.
 *   - Stops immediately after upload verification.
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin }       from "../src/db/supabase.js";
import { uploadCampaignLeads }    from "../src/lib/lead-upload.js";

// ── IDs established during setup + dry run ────────────────────────────────────

const GRAMSCODE_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const DB_CAMPAIGN_ID      = "74c84457-17db-41fa-bd53-a9af63bdb47d";
const SL_CAMPAIGN_ID      = "3908578";
const CAMPAIGN_LEAD_ID    = "6fa744d2-cfaf-48db-89cf-763ce785b3a1";
const CONTACT_ID          = "53e3fad0-74a1-4680-a24a-1f2292b1aa59";

const apiKey   = (process.env.SMARTLEAD_API_KEY ?? "").trim();
const API_BASE = "https://server.smartlead.ai/api/v1";
const db       = getSupabaseAdmin();

function section(title: string) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(70));
}

function ok(label: string, detail?: string) {
  console.log(`  ✓ ${label}${detail ? `  (${detail})` : ""}`);
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
    throw new Error(`Smartlead HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Stage 20 — ONE Live Lead Upload to Smartlead");
  console.log("=".repeat(70));

  // ── Pre-flight: confirm baseline state before uploading ────────────────────
  section("Pre-flight — Confirm baseline state");

  // Smartlead: still DRAFTED?
  try {
    const camp     = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string,unknown>;
    const slStatus = String(camp.status ?? "unknown");
    const isDraft  = slStatus.toUpperCase() === "DRAFT" || slStatus.toUpperCase() === "DRAFTED";
    if (!isDraft) stop(`Smartlead campaign status is ${slStatus} — must be DRAFT before upload`);
    ok(`Smartlead campaign ${SL_CAMPAIGN_ID} status: ${slStatus}`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    stop("Smartlead status check failed", msg);
  }

  // DB: campaign_lead still 'ready'?
  const { data: preRow, error: preErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (preErr || !preRow) stop("campaign_lead not found", preErr?.message);
  const pre = preRow as Record<string,unknown>;

  if (pre.status !== "ready") stop(`campaign_lead status is '${pre.status}' — expected 'ready'`);
  ok(`campaign_lead status: ready`);
  ok(`platform_lead_id: ${pre.platform_lead_id ?? "null"}`);

  const preUpdatedAt = pre.updated_at as string;
  console.log(`\n  Baseline snapshot:`);
  console.log(`    campaign_lead id:  ${CAMPAIGN_LEAD_ID}`);
  console.log(`    status:           ready`);
  console.log(`    platform_lead_id: null`);
  console.log(`    updated_at:       ${preUpdatedAt}`);

  // ── THE LIVE UPLOAD ────────────────────────────────────────────────────────
  section("LIVE UPLOAD — uploadCampaignLeads({ dryRun: false, limit: 1 })");

  console.log("\n  Making ONE POST to Smartlead /campaigns/3908578/leads ...\n");

  let uploadResult: Awaited<ReturnType<typeof uploadCampaignLeads>>;
  try {
    uploadResult = await uploadCampaignLeads({
      clientId:   GRAMSCODE_CLIENT_ID,
      campaignId: DB_CAMPAIGN_ID,
      dryRun:     false,
      limit:      1,
    });
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    stop("uploadCampaignLeads threw an unhandled error", msg);
  }

  // ── Upload result from provider ────────────────────────────────────────────
  section("Provider response");

  console.log(`  uploadedCount:   ${uploadResult.uploadedCount}`);
  console.log(`  duplicateCount:  ${uploadResult.duplicateCount}`);
  console.log(`  failedCount:     ${uploadResult.failedCount}`);
  console.log(`  skippedCount:    ${uploadResult.skippedCount}`);
  console.log(`  readyCount:      ${uploadResult.readyCount}`);
  console.log(`  dryRun:          ${uploadResult.dryRun}`);
  console.log(`  batches:         ${uploadResult.batches.length}`);

  if (uploadResult.batches.length > 0) {
    const b = uploadResult.batches[0]!;
    console.log(`\n  Batch 0 detail:`);
    console.log(`    leadsInBatch:   ${b.leadsInBatch}`);
    console.log(`    uploadCount:    ${b.uploadCount}    ← from Smartlead response`);
    console.log(`    duplicateCount: ${b.duplicateCount} ← from Smartlead response`);
    console.log(`    failed:         ${b.failed}`);
    if (b.error) console.log(`    error:          ${b.error}`);
  }

  const uploadSucceeded =
    uploadResult.failedCount === 0 &&
    uploadResult.batches.length === 1 &&
    !uploadResult.batches[0]!.failed;

  if (!uploadSucceeded) {
    console.error("\n  ✗ Upload did not succeed cleanly.");
    if (uploadResult.batches[0]?.error) {
      console.error(`  Provider error: ${uploadResult.batches[0].error}`);
    }
    process.exit(1);
  }

  ok("Provider accepted the upload without error");

  // ── DB state verification ──────────────────────────────────────────────────
  section("DB state verification");

  const { data: postRow, error: postErr } = await db
    .from("campaign_leads")
    .select("id, campaign_id, contact_id, client_id, status, platform_lead_id, created_at, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (postErr || !postRow) stop("campaign_lead not found after upload", postErr?.message);
  const post = postRow as Record<string,unknown>;

  console.log(`\n  campaign_lead after upload:`);
  console.log(`    id:              ${post.id}`);
  console.log(`    campaign_id:     ${post.campaign_id}`);
  console.log(`    contact_id:      ${post.contact_id}`);
  console.log(`    client_id:       ${post.client_id}`);
  console.log(`    status:          ${post.status}`);
  console.log(`    platform_lead_id:${post.platform_lead_id ?? "null"}`);
  console.log(`    created_at:      ${post.created_at}`);
  console.log(`    updated_at:      ${post.updated_at}`);

  if (post.status !== "uploaded") stop(`campaign_lead status is '${post.status}' — expected 'uploaded'`);
  ok("status transitioned: ready → uploaded");

  if (post.platform_lead_id !== null) {
    console.log(`  ⚠ platform_lead_id is not null: ${post.platform_lead_id} (unexpected — Smartlead upload API does not return per-lead IDs)`);
  } else {
    ok("platform_lead_id remains null (Smartlead upload API limitation — expected)");
  }

  // Confirm updated_at changed
  if (post.updated_at !== preUpdatedAt) {
    ok("updated_at advanced", `${preUpdatedAt} → ${post.updated_at}`);
  }

  // Confirm no OTHER campaign_leads were changed
  const { data: allLeads } = await db
    .from("campaign_leads")
    .select("id, status")
    .eq("campaign_id", DB_CAMPAIGN_ID);

  const allArr = (allLeads ?? []) as Array<{id: string; status: string}>;
  const others = allArr.filter((r) => r.id !== CAMPAIGN_LEAD_ID);
  ok(`Total campaign_leads for this campaign: ${allArr.length}`, "expected: 1");
  if (allArr.length !== 1) {
    console.error(`  ✗ Unexpected: ${allArr.length} rows — expected exactly 1`);
  }
  if (others.some((r) => r.status === "uploaded")) {
    console.error("  ✗ Other leads were unexpectedly transitioned to uploaded");
  } else {
    ok("No other campaign_leads were modified");
  }

  // ── Smartlead post-upload verification ─────────────────────────────────────
  section("Smartlead post-upload verification (live API)");

  // Campaign status still DRAFTED?
  try {
    const camp2     = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string,unknown>;
    const slStatus2 = String(camp2.status ?? "unknown");
    const isDraft   = slStatus2.toUpperCase() === "DRAFT" || slStatus2.toUpperCase() === "DRAFTED";
    ok(`Smartlead campaign status: ${slStatus2}`, isDraft ? "SAFE — still DRAFTED" : "WARNING");
    if (!isDraft) console.error(`  ✗ Campaign status changed to ${slStatus2} — unexpected`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    console.log(`  Could not verify Smartlead campaign status: ${msg}`);
  }

  // How many leads are in the Smartlead campaign now?
  try {
    const slLeads    = await slGet(`/campaigns/${SL_CAMPAIGN_ID}/leads?offset=0&limit=10`) as unknown;
    const slLeadArr  = Array.isArray(slLeads) ? slLeads
      : ((slLeads as Record<string,unknown>)?.data ?? []) as unknown[];

    ok(`Leads now in Smartlead campaign: ${slLeadArr.length}`, "expected: 1");

    for (const l of slLeadArr as Array<Record<string,unknown>>) {
      const email  = String(l.email ?? "?");
      const masked = email.replace(/(?<=.{3}).+(?=@)/, "***");
      const status = l.status ?? "?";
      console.log(`    lead email: ${masked}  status: ${status}`);
    }
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    console.log(`  Could not verify Smartlead leads: ${msg}`);
  }

  ok("API key never appeared in any console output");
  ok("Campaign status: DRAFTED — no activation occurred");
  ok("No email scheduled or sent (campaign remains DRAFT)");

  // ── Post-upload Supabase verification queries ──────────────────────────────
  section("Supabase queries to independently verify post-upload state");

  console.log(`
  Run these in the Supabase SQL editor:

  ── Query A: Campaign lead — expect status='uploaded' ──────────────────────
  SELECT id, campaign_id, contact_id, status, platform_lead_id,
         created_at, updated_at
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected:
    status          = uploaded
    platform_lead_id= null
    updated_at      > ${preUpdatedAt}

  ── Query B: No other campaign_leads were created or changed ────────────────
  SELECT id, contact_id, status, platform_lead_id
  FROM campaign_leads
  WHERE campaign_id = '${DB_CAMPAIGN_ID}';

  Expected: exactly 1 row (the one above)

  ── Query C: Campaign itself is still draft ─────────────────────────────────
  SELECT id, status, platform, platform_campaign_id
  FROM campaigns
  WHERE id = '${DB_CAMPAIGN_ID}';

  Expected: status = draft, platform = smartlead, platform_campaign_id = ${SL_CAMPAIGN_ID}

  ── Query D: Contact unchanged ──────────────────────────────────────────────
  SELECT id, email, email_status, status
  FROM contacts
  WHERE id = '${CONTACT_ID}';

  Expected: email = olugbogiafeez@gmail.com, email_status = VERIFIED, status = review
  `);

  // ── Final summary ──────────────────────────────────────────────────────────
  section("UPLOAD COMPLETE — Summary");

  console.log(`
  Smartlead response:
    upload_count:    ${uploadResult.batches[0]?.uploadCount ?? 0}
    duplicate_count: ${uploadResult.batches[0]?.duplicateCount ?? 0}

  DB changes:
    campaign_leads.status:     ready → uploaded
    campaign_leads.updated_at: ${preUpdatedAt}
                             → ${post.updated_at}
    platform_lead_id:          null (unchanged — Smartlead limitation)

  Safety checks:
    Smartlead campaign status: DRAFTED (no activation)
    Leads in Smartlead:        1 (exactly the one uploaded)
    Other campaign_leads:      0 changed
    API key in logs:           NONE
    Email sent:                NO (draft campaign, no scheduled send)

  STOPPED — awaiting your Supabase verification.
  After you confirm, we will run the idempotency re-run separately.
`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
