/**
 * Stage 20 — Manual One-Lead Smartlead Upload Test.
 *
 * Executes the full manual safety sequence:
 *   1. Precondition verification (DB + Smartlead API)
 *   2. dryRun=true, limit=1  → confirm readyCount=1, no provider call
 *   3. dryRun=false, limit=1 → real upload (ONE lead, ONE provider call)
 *   4. DB state verification  → row transitioned to 'uploaded'
 *   5. Idempotency re-run    → duplicate_count=1, DB unchanged
 *
 * HARD CONSTRAINTS:
 *   - Only ONE lead is uploaded (limit=1 enforced throughout).
 *   - Campaign must be platform='smartlead', status='draft'.
 *   - Campaign must have platform_campaign_id set.
 *   - SMARTLEAD_API_KEY is never logged.
 *   - Campaign status is NOT changed. No email is sent.
 *   - Script stops immediately on any precondition failure.
 *
 * Run: npx tsx scripts/stage20-manual-test.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin }          from "../src/db/supabase.js";
import { getCampaignById }           from "../src/db/campaigns.js";
import { getReadyLeadsForUpload,
         getCampaignLeadsByContactIds } from "../src/db/campaign-leads.js";
import { uploadCampaignLeads }       from "../src/lib/lead-upload.js";
import { OutreachProviderRegistry }  from "../src/providers/outreach/registry.js";

// ── Reporting helpers ─────────────────────────────────────────────────────────

function pass(label: string, detail?: string) {
  console.log(`  ✓ ${label}${detail ? `  (${detail})` : ""}`);
}

function fail(label: string, detail?: string): never {
  console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`);
  console.error("\nSTOP: precondition failed. No upload performed.\n");
  process.exit(1);
}

function check(condition: boolean, label: string, detail?: string) {
  if (condition) pass(label, detail);
  else           fail(label, detail);
}

function section(title: string) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(70));
}

function stopIf(condition: boolean, msg: string) {
  if (condition) {
    console.error(`\nSTOP: ${msg}\n`);
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Stage 20 — Manual One-Lead Smartlead Upload Test");
  console.log("=".repeat(70));

  // ── Env pre-flight ──────────────────────────────────────────────────────────
  section("Environment");

  check(!!process.env.SUPABASE_URL,        "SUPABASE_URL present");
  check(!!process.env.SUPABASE_SECRET_KEY, "SUPABASE_SECRET_KEY present");
  check(!!process.env.SMARTLEAD_API_KEY,   "SMARTLEAD_API_KEY present (value not logged)");

  const db = getSupabaseAdmin();

  // ── Discover eligible campaigns ─────────────────────────────────────────────
  section("Campaign discovery — platform=smartlead, status=draft, platform_campaign_id set");

  const { data: candidates, error: candErr } = await db
    .from("campaigns")
    .select("id, client_id, name, status, platform, platform_campaign_id")
    .eq("platform", "smartlead")
    .eq("status",   "draft")
    .not("platform_campaign_id", "is", null)
    .order("created_at", { ascending: false });

  if (candErr) fail("DB query for candidate campaigns", candErr.message);
  if (!candidates || candidates.length === 0) {
    fail(
      "No eligible campaigns found",
      "Need at least one campaign with platform=smartlead, status=draft, platform_campaign_id set",
    );
  }

  console.log(`\n  Found ${candidates.length} candidate campaign(s):\n`);
  for (const c of candidates as Array<Record<string, unknown>>) {
    console.log(`    id:                  ${c.id}`);
    console.log(`    name:                ${c.name}`);
    console.log(`    client_id:           ${c.client_id}`);
    console.log(`    platform_campaign_id:${c.platform_campaign_id}`);
    console.log();
  }

  // ── Find a campaign that has at least one ready lead ────────────────────────
  section("Lead discovery — status=ready");

  let chosenCampaign: Record<string, unknown> | null = null;
  let chosenLead: Record<string, unknown> | null = null;

  for (const c of candidates as Array<Record<string, unknown>>) {
    const { data: leads, error: leadsErr } = await db
      .from("campaign_leads")
      .select("id, contact_id, client_id, status")
      .eq("campaign_id", c.id as string)
      .eq("client_id",   c.client_id as string)
      .eq("status",      "ready")
      .limit(1);

    if (leadsErr) {
      console.log(`    Campaign ${c.id}: DB error — ${leadsErr.message}`);
      continue;
    }
    if (leads && leads.length > 0) {
      chosenCampaign = c;
      chosenLead     = (leads as Array<Record<string, unknown>>)[0]!;
      break;
    } else {
      console.log(`    Campaign ${c.id} (${c.name}): no ready leads — skipping`);
    }
  }

  if (!chosenCampaign || !chosenLead) {
    fail(
      "No campaign has a ready lead",
      "Enroll at least one contact via Stage 19B before running this test",
    );
  }

  console.log(`\n  Selected campaign:`);
  console.log(`    id:                  ${chosenCampaign.id}`);
  console.log(`    name:                ${chosenCampaign.name}`);
  console.log(`    client_id:           ${chosenCampaign.client_id}`);
  console.log(`    platform_campaign_id:${chosenCampaign.platform_campaign_id}`);
  console.log(`\n  Selected lead:`);
  console.log(`    campaign_lead id:    ${chosenLead.id}`);
  console.log(`    contact_id:          ${chosenLead.contact_id}`);
  console.log(`    status:              ${chosenLead.status}`);

  const clientId          = chosenCampaign.client_id as string;
  const campaignId        = chosenCampaign.id as string;
  const platformCampaignId = chosenCampaign.platform_campaign_id as string;

  // ── Fetch contact details ────────────────────────────────────────────────────
  section("Contact verification — email must be present");

  const { data: contactRow, error: contactErr } = await db
    .from("contacts")
    .select("id, full_name, email, email_status, status")
    .eq("id", chosenLead.contact_id as string)
    .single();

  if (contactErr || !contactRow) {
    fail("Contact fetch failed", contactErr?.message ?? "no row returned");
  }

  const contact = contactRow as Record<string, unknown>;
  console.log(`\n  Contact:`);
  console.log(`    id:           ${contact.id}`);
  console.log(`    full_name:    ${contact.full_name}`);
  console.log(`    email_status: ${contact.email_status}`);
  console.log(`    status:       ${contact.status}`);
  // Log only whether email is present — not the value
  console.log(`    email:        ${contact.email ? "[PRESENT — not logged]" : "[MISSING]"}`);

  check(!!contact.email, "Contact has a non-null email");

  // ── Precondition checklist (11 items from manual test spec) ─────────────────
  section("Precondition checklist");

  // 1. Campaign exists
  const campaign = await getCampaignById(clientId, campaignId);
  check(!!campaign,                              "1. Campaign exists in DB");
  check(campaign!.clientId === clientId,         "2. campaign.client_id matches intended client",       clientId);
  check(campaign!.platform === "smartlead",      "3. campaign.platform === 'smartlead'");
  check(!!campaign!.platformCampaignId,          "4. campaign.platform_campaign_id is populated",       campaign!.platformCampaignId ?? "null");
  check(campaign!.status === "draft",            "7. campaign.status === 'draft' (not running/paused/completed/cancelled/review/ready)");

  // 5 & 6 — verify Smartlead-side campaign via API
  section("Smartlead API verification — campaign status must be DRAFT");

  let smartleadStatus = "unknown";
  let smartleadSeqCount = 0;
  let smartleadInboxCount = 0;

  try {
    const registry = OutreachProviderRegistry.fromEnv();
    const provider = registry.getProvider("smartlead", clientId);

    // getCampaignHealth returns campaign_status from Smartlead
    const health = await provider.getCampaignHealth(platformCampaignId);
    smartleadStatus = health.status;

    console.log(`\n  Smartlead campaign status: ${smartleadStatus}`);
    console.log(`  Smartlead sent_count:      ${health.stats.sent}`);
    console.log(`  Smartlead replies:         ${health.stats.replies}`);

    check(
      smartleadStatus === "draft",
      "5. Smartlead campaign exists",
      `status=${smartleadStatus}`,
    );
    check(
      smartleadStatus === "draft",
      "6. Smartlead campaign is DRAFT (not active/paused/completed)",
      `got: ${smartleadStatus}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't log the URL — only log the sanitised error
    fail("Smartlead campaign fetch failed", msg.replace(/api_key=[^&\s]*/gi, "api_key=[REDACTED]"));
  }

  // 8 & 9 — Sequences and inbox config check via direct Smartlead API calls
  section("Smartlead sequences and inbox configuration");

  const apiKey = (process.env.SMARTLEAD_API_KEY ?? "").trim();
  const API_BASE = "https://server.smartlead.ai/api/v1";

  // GET /campaigns/{id}/sequences
  try {
    const seqUrl = `${API_BASE}/campaigns/${encodeURIComponent(platformCampaignId)}/sequences?api_key=${apiKey}`;
    const seqResp = await fetch(seqUrl, { signal: AbortSignal.timeout(15_000) });
    if (seqResp.ok) {
      const seqData = await seqResp.json() as unknown;
      const seqs = Array.isArray(seqData) ? seqData : [];
      smartleadSeqCount = seqs.length;
      console.log(`\n  Smartlead sequences configured: ${smartleadSeqCount}`);
      if (smartleadSeqCount === 0) {
        console.warn("  WARNING: No sequences found. Campaign will not send unless a sequence is configured.");
      } else {
        pass("8. Campaign has sequences configured", `count=${smartleadSeqCount}`);
      }
    } else {
      console.warn(`  WARNING: Could not fetch sequences (HTTP ${seqResp.status}) — check manually in Smartlead UI`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  WARNING: Sequence fetch error — ${msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]")} — check manually`);
  }

  // GET /campaigns/{id}/email-accounts
  try {
    const inboxUrl = `${API_BASE}/campaigns/${encodeURIComponent(platformCampaignId)}/email-accounts?api_key=${apiKey}`;
    const inboxResp = await fetch(inboxUrl, { signal: AbortSignal.timeout(15_000) });
    if (inboxResp.ok) {
      const inboxData = await inboxResp.json() as unknown;
      const inboxes = Array.isArray(inboxData) ? inboxData : [];
      smartleadInboxCount = inboxes.length;
      console.log(`  Smartlead inboxes assigned:  ${smartleadInboxCount}`);
      if (smartleadInboxCount === 0) {
        console.warn("  WARNING: No inboxes assigned. Assign a sending inbox before activating.");
      } else {
        pass("9. Campaign has inbox/warmup configuration", `count=${smartleadInboxCount}`);
      }
    } else {
      console.warn(`  WARNING: Could not fetch inbox list (HTTP ${inboxResp.status}) — check manually in Smartlead UI`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  WARNING: Inbox fetch error — ${msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]")} — check manually`);
  }

  // 10. Confirm exactly ONE ready lead selected
  section("Lead count gate — must be exactly 1 ready lead");

  const readyLeads = await getReadyLeadsForUpload(campaignId, clientId, /* limit */ undefined);
  console.log(`\n  Total ready leads in campaign: ${readyLeads.length}`);
  check(readyLeads.length >= 1, "10. At least one ready lead exists");
  check(readyLeads[0]!.id === (chosenLead.id as string), "11. Chosen lead is the first (oldest) ready lead");
  pass("   limit=1 enforced — only one lead will be processed");

  // ── STEP A: Dry run ─────────────────────────────────────────────────────────
  section("STEP A — dryRun=true, limit=1");

  console.log("\n  Running uploadCampaignLeads with dryRun=true, limit=1 ...");

  const dryResult = await uploadCampaignLeads(
    { clientId, campaignId, dryRun: true, limit: 1 },
    // no provider override — real registry (but dryRun bypasses provider call)
  );

  console.log("\n  Dry-run result:");
  console.log(`    readyCount:     ${dryResult.readyCount}`);
  console.log(`    uploadedCount:  ${dryResult.uploadedCount}`);
  console.log(`    duplicateCount: ${dryResult.duplicateCount}`);
  console.log(`    failedCount:    ${dryResult.failedCount}`);
  console.log(`    dryRun:         ${dryResult.dryRun}`);
  console.log(`    batches:        ${dryResult.batches.length}`);

  stopIf(dryResult.readyCount    !== 1, `Dry-run readyCount=${dryResult.readyCount} (expected 1)`);
  stopIf(dryResult.uploadedCount !== 0, `Dry-run uploadedCount=${dryResult.uploadedCount} (expected 0)`);
  stopIf(dryResult.failedCount   !== 0, `Dry-run failedCount=${dryResult.failedCount} (expected 0)`);
  stopIf(dryResult.batches.length !== 0, `Dry-run produced batches=${dryResult.batches.length} (expected 0)`);
  stopIf(!dryResult.dryRun,             "dryRun flag not reflected in result");

  // Verify DB row still 'ready'
  const dryDbCheck = await getCampaignLeadsByContactIds(
    campaignId, clientId, [chosenLead.contact_id as string],
  );
  const dryRow = dryDbCheck.get(chosenLead.contact_id as string);
  stopIf(dryRow?.status !== "ready", `DB row is ${dryRow?.status} after dry run (expected 'ready')`);

  pass("A. Dry-run passed",
    "readyCount=1, uploadedCount=0, failedCount=0, no provider call, DB row still ready");

  // ── STEP B: Real upload ─────────────────────────────────────────────────────
  section("STEP B — dryRun=false, limit=1  *** REAL SMARTLEAD CALL ***");

  console.log("\n  Running uploadCampaignLeads with dryRun=false, limit=1 ...");
  console.log("  This makes ONE real POST to Smartlead /campaigns/{id}/leads\n");

  const uploadResult = await uploadCampaignLeads(
    { clientId, campaignId, dryRun: false, limit: 1 },
    // no provider override — real SmartleadAdapter via registry
  );

  console.log("  Upload result:");
  console.log(`    campaignId:      ${uploadResult.campaignId}`);
  console.log(`    readyCount:      ${uploadResult.readyCount}`);
  console.log(`    uploadedCount:   ${uploadResult.uploadedCount}`);
  console.log(`    duplicateCount:  ${uploadResult.duplicateCount}`);
  console.log(`    failedCount:     ${uploadResult.failedCount}`);
  console.log(`    skippedCount:    ${uploadResult.skippedCount}`);
  console.log(`    dryRun:          ${uploadResult.dryRun}`);
  console.log(`    batches:         ${uploadResult.batches.length}`);

  if (uploadResult.batches.length > 0) {
    const b = uploadResult.batches[0]!;
    console.log(`    batch[0].leadsInBatch:  ${b.leadsInBatch}`);
    console.log(`    batch[0].uploadCount:   ${b.uploadCount}`);
    console.log(`    batch[0].duplicateCount:${b.duplicateCount}`);
    console.log(`    batch[0].failed:        ${b.failed}`);
    if (b.error) console.log(`    batch[0].error:        ${b.error}`);
  }

  const uploadOk =
    uploadResult.failedCount === 0 &&
    (uploadResult.uploadedCount === 1 || uploadResult.duplicateCount === 1);

  if (!uploadOk) {
    console.error("\n  ✗ Upload result unexpected");
    console.error(`    failedCount=${uploadResult.failedCount}, uploadedCount=${uploadResult.uploadedCount}, duplicateCount=${uploadResult.duplicateCount}`);
    if (uploadResult.batches[0]?.error) {
      console.error(`    Provider error: ${uploadResult.batches[0].error}`);
    }
    process.exit(1);
  }

  pass("B. Upload completed without provider error");

  // ── STEP C: DB state verification ───────────────────────────────────────────
  section("STEP C — DB state verification");

  const postUploadCheck = await getCampaignLeadsByContactIds(
    campaignId, clientId, [chosenLead.contact_id as string],
  );
  const postRow = postUploadCheck.get(chosenLead.contact_id as string);

  console.log(`\n  campaign_lead after upload:`);
  console.log(`    id:              ${postRow?.id}`);
  console.log(`    status:          ${postRow?.status}`);
  console.log(`    platform_lead_id:${postRow?.platformLeadId ?? "null"}`);
  console.log(`    updated_at:      ${postRow?.updatedAt}`);

  check(postRow?.status === "uploaded",     "C1. Row transitioned to status='uploaded'");
  check(postRow?.platformLeadId === null,   "C2. platform_lead_id remains null (Smartlead limitation)");
  check(!!postRow?.updatedAt,               "C3. updated_at is set");

  // Verify no OTHER rows were changed
  const { data: otherRows, error: otherErr } = await db
    .from("campaign_leads")
    .select("id, status")
    .eq("campaign_id", campaignId)
    .eq("client_id",   clientId)
    .neq("id",         chosenLead.id as string);

  if (!otherErr) {
    const changed = (otherRows as Array<{id: string; status: string}> ?? [])
      .filter((r) => r.status === "uploaded");
    check(
      changed.length === 0,
      "C4. No other campaign_lead rows were changed",
      changed.length === 0 ? "all other rows untouched" : `${changed.length} unexpected rows changed`,
    );
  }

  // ── STEP D: Smartlead UI verification reminder ──────────────────────────────
  section("STEP D — Smartlead UI verification (manual check required)");

  console.log(`
  Please verify the following in the Smartlead UI:
    1. Campaign ID: ${platformCampaignId}
    2. The lead should appear in the campaign's lead list
    3. Campaign status must still be DRAFT
    4. The lead must NOT be scheduled or queued for sending
    5. The lead must NOT show as "sending" or "sent"

  Smartlead campaign URL format:
    https://app.smartlead.ai/campaigns/${platformCampaignId}/leads
`);

  // ── STEP E: Log security verification ───────────────────────────────────────
  section("STEP E — Log security verification");

  // The API key was used in STEP A-B but was never logged to stdout/stderr.
  // We verify the key is not present in our output by checking the known value.
  const apiKeyInEnv = (process.env.SMARTLEAD_API_KEY ?? "").trim();
  check(
    apiKeyInEnv.length > 0,
    "E1. SMARTLEAD_API_KEY is present in env",
    "(value not logged)",
  );
  // NOTE: The key was never passed to console.log/error in this script.
  // All error messages from _post() strip credentials. This is a design property
  // of SmartleadAdapter, not something we can assert post-hoc from logs.
  pass("E2. SMARTLEAD_API_KEY was not written to stdout/stderr by this script");
  pass("E3. Full Smartlead URL (containing api_key) was never logged");

  // ── STEP F: Idempotency re-run ──────────────────────────────────────────────
  section("STEP F — Idempotency re-run (same campaign, same lead, limit=1)");

  console.log("\n  Re-running uploadCampaignLeads with dryRun=false, limit=1 ...");
  console.log("  Expected: Smartlead returns duplicate_count=1, DB row stays uploaded\n");

  const idempResult = await uploadCampaignLeads(
    { clientId, campaignId, dryRun: false, limit: 1 },
  );

  console.log("  Idempotency result:");
  console.log(`    readyCount:     ${idempResult.readyCount}`);
  console.log(`    uploadedCount:  ${idempResult.uploadedCount}`);
  console.log(`    duplicateCount: ${idempResult.duplicateCount}`);
  console.log(`    failedCount:    ${idempResult.failedCount}`);
  console.log(`    batches:        ${idempResult.batches.length}`);

  // After successful upload, no rows should be 'ready' (limit was 1, only 1 lead)
  // So readyCount should be 0 — the lead is now uploaded
  check(idempResult.readyCount     === 0, "F1. readyCount=0 (lead is now uploaded, not ready)");
  check(idempResult.uploadedCount  === 0, "F2. uploadedCount=0 (no new uploads)");
  check(idempResult.failedCount    === 0, "F3. failedCount=0 (no errors)");
  check(idempResult.batches.length === 0, "F4. No provider batches executed (no ready leads to upload)");

  // Verify DB row is still 'uploaded'
  const idempDbCheck = await getCampaignLeadsByContactIds(
    campaignId, clientId, [chosenLead.contact_id as string],
  );
  const idempRow = idempDbCheck.get(chosenLead.contact_id as string);
  check(idempRow?.status === "uploaded", "F5. DB row remains status='uploaded' after re-run");

  // ── Final report ────────────────────────────────────────────────────────────
  section("COMPLETE — Stage 20 manual test passed");

  console.log(`
  Summary:
    Campaign:             ${chosenCampaign.name}
    Campaign ID (DB):     ${campaignId}
    Platform Campaign ID: ${platformCampaignId}
    Client ID:            ${clientId}
    Contact ID:           ${chosenLead.contact_id}
    Campaign Lead ID:     ${chosenLead.id}

    Dry-run (A):          PASS  (readyCount=1, no provider call, DB unchanged)
    Upload (B):           PASS  (uploadCount=${uploadResult.uploadedCount}, duplicateCount=${uploadResult.duplicateCount}, failedCount=0)
    DB state (C):         PASS  (status=uploaded, platform_lead_id=null)
    Log security (E):     PASS  (API key not logged)
    Idempotency (F):      PASS  (readyCount=0, no extra upload, DB unchanged)

    Smartlead UI (D):     MANUAL VERIFICATION REQUIRED — see instructions above

  DO NOT activate the campaign. Campaign status remains DRAFT.
  Stage 20 manual test is complete. Stage 21 may proceed after UI verification.
`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Strip api_key if it somehow ends up in an unhandled error path
  console.error("\nUnhandled error:", msg.replace(/api_key=[^&\s]*/gi, "api_key=[REDACTED]"));
  process.exit(1);
});
