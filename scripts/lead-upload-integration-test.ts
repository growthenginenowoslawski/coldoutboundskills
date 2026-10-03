/**
 * Stage 20 — Lead Upload Integration Test.
 *
 * Tests the uploadCampaignLeads() orchestrator against the live Supabase
 * database with ALL Smartlead HTTP calls mocked. No real outbound calls
 * are made. No emails are sent. No real Smartlead campaign is touched.
 *
 * HARD CONSTRAINTS:
 *   - No real Smartlead API calls. Provider is always a mock.
 *   - No emails sent. No campaign status mutations.
 *   - SMARTLEAD_API_KEY is never logged, even if set in environment.
 *   - All test data is cleaned up in finally blocks.
 *   - FINDING 5 and FINDING 6 remain open — no RLS or schema changes.
 *
 * Run:
 *   npx tsx scripts/lead-upload-integration-test.ts
 *
 * Env vars required:
 *   SUPABASE_URL        — always required
 *   SUPABASE_SECRET_KEY — always required
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin }                              from "../src/db/supabase.js";
import { createCampaign, deleteCampaign }               from "../src/db/campaigns.js";
import { getCampaignLeadsByContactIds }                  from "../src/db/campaign-leads.js";
import { uploadCampaignLeads }                           from "../src/lib/lead-upload.js";
import type { LeadUploadProvider, UploadResult }         from "../src/lib/lead-upload.js";
import type { UploadLeadInput, UploadLeadsResult }        from "../src/providers/outreach/types.js";

// ── Reporting helpers ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function note(label: string, value: unknown): void {
  console.log(`     ${label}: ${JSON.stringify(value)}`);
}

// ── Mock provider factory ─────────────────────────────────────────────────────

interface ProviderCallRecord {
  platformCampaignId: string;
  leadsCount: number;
  firstEmail: string;
}

function makeMockProvider(
  response: UploadLeadsResult | Error,
): { provider: LeadUploadProvider; calls: ProviderCallRecord[] } {
  const calls: ProviderCallRecord[] = [];
  const provider: LeadUploadProvider = {
    async uploadLeads(platformCampaignId: string, leads: UploadLeadInput[]): Promise<UploadLeadsResult> {
      calls.push({
        platformCampaignId,
        leadsCount: leads.length,
        firstEmail: leads[0]?.email ?? "",
      });
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { provider, calls };
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const ALT_CLIENT_ID  = "00000000-0000-0000-0000-000000000001"; // non-existent client
const RUN_TAG        = `s20-${Date.now()}`;
const SL_CAMPAIGN_ID = `test-sl-${RUN_TAG}`; // fake Smartlead campaign ID

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 20 — Lead Upload Integration Test");
  console.log("=".repeat(70));

  section("Pre-flight checks");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);
  if (!hasSupabase) {
    console.error("\nAbort: Supabase credentials missing.");
    process.exit(1);
  }

  // Confirm SMARTLEAD_API_KEY is NOT logged (we only confirm its presence or absence)
  const hasSmartleadKey = !!process.env.SMARTLEAD_API_KEY;
  note("SMARTLEAD_API_KEY present (not logged)", hasSmartleadKey);

  const db = getSupabaseAdmin();

  const { data: clientRow, error: clientErr } = await db
    .from("clients")
    .select("id, name")
    .eq("id", TEST_CLIENT_ID)
    .maybeSingle();

  if (clientErr || !clientRow) {
    console.error(`\nAbort: test client ${TEST_CLIENT_ID} not found.`);
    process.exit(1);
  }
  check("Test client (Gramscode) exists", true);

  // ── Fixture state ─────────────────────────────────────────────────────────
  const createdCampaignIds: string[] = [];
  let testCompanyId:  string | null = null;
  let testContactIds: string[]      = [];

  try {
    // Create one company for all upload tests
    const { data: co, error: coErr } = await db
      .from("companies")
      .insert({
        name:   `S20-Upload-Co [${RUN_TAG}]`,
        domain: `s20-upload-${RUN_TAG}.invalid`,
        status: "review",
      })
      .select("id").single();
    if (coErr || !co) throw new Error(`company: ${coErr?.message}`);
    testCompanyId = (co as { id: string }).id;
    check("Test company created", !!testCompanyId);

    // ── Section 1: Precondition gate failures ─────────────────────────────
    section("Precondition gates — no provider call, no DB write");

    // Create a baseline valid campaign for mutation-based gate tests
    const baseCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] Base (for gate tests)`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(baseCampaign.id);

    // Gate: missing platformCampaignId
    const noPlatformIdCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:     `[${RUN_TAG}] No-PlatformId`,
      status:   "draft",
      platform: "smartlead",
      // platformCampaignId omitted → null
    });
    createdCampaignIds.push(noPlatformIdCampaign.id);

    const { provider: noPidMock } = makeMockProvider({ uploadCount: 0, duplicateCount: 0 });
    let noPidThrew = false;
    let noPidReason = "";
    try {
      await uploadCampaignLeads(
        { clientId: TEST_CLIENT_ID, campaignId: noPlatformIdCampaign.id },
        { provider: noPidMock },
      );
    } catch (err) {
      noPidThrew = true;
      noPidReason = err instanceof Error ? err.message : String(err);
    }
    check("missing platformCampaignId → throws",         noPidThrew);
    check("reason: CAMPAIGN_MISSING_PLATFORM_ID",
      noPidReason.includes("CAMPAIGN_MISSING_PLATFORM_ID"));

    // Gate: platform=plusvibe
    const plusvibeCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] PlusVibe`,
      status:             "draft",
      platform:           "plusvibe",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(plusvibeCampaign.id);

    const { provider: pvMock } = makeMockProvider({ uploadCount: 0, duplicateCount: 0 });
    let pvThrew = false;
    let pvReason = "";
    try {
      await uploadCampaignLeads(
        { clientId: TEST_CLIENT_ID, campaignId: plusvibeCampaign.id },
        { provider: pvMock },
      );
    } catch (err) {
      pvThrew = true;
      pvReason = err instanceof Error ? err.message : String(err);
    }
    check("platform=plusvibe → throws",                  pvThrew);
    check("reason: CAMPAIGN_PLATFORM_UNSUPPORTED",
      pvReason.includes("CAMPAIGN_PLATFORM_UNSUPPORTED"));

    // Gate: status=running
    for (const status of ["running", "paused", "completed", "cancelled"] as const) {
      const statusCampaign = await createCampaign(TEST_CLIENT_ID, {
        name:               `[${RUN_TAG}] Status-${status}`,
        status,
        platform:           "smartlead",
        platformCampaignId: SL_CAMPAIGN_ID,
      });
      createdCampaignIds.push(statusCampaign.id);

      const { provider: statusMock } = makeMockProvider({ uploadCount: 0, duplicateCount: 0 });
      let statusThrew = false;
      let statusReason = "";
      try {
        await uploadCampaignLeads(
          { clientId: TEST_CLIENT_ID, campaignId: statusCampaign.id },
          { provider: statusMock },
        );
      } catch (err) {
        statusThrew = true;
        statusReason = err instanceof Error ? err.message : String(err);
      }
      check(`status=${status} → throws`,            statusThrew);
      check(`status=${status} → CAMPAIGN_NOT_DRAFT`,
        statusReason.includes("CAMPAIGN_NOT_DRAFT"),
        `got: ${statusReason.slice(0, 100)}`);
    }

    // Gate: campaign not found (wrong clientId)
    const { provider: notFoundMock } = makeMockProvider({ uploadCount: 0, duplicateCount: 0 });
    let notFoundThrew = false;
    let notFoundReason = "";
    try {
      await uploadCampaignLeads(
        { clientId: ALT_CLIENT_ID, campaignId: baseCampaign.id },
        { provider: notFoundMock },
      );
    } catch (err) {
      notFoundThrew = true;
      notFoundReason = err instanceof Error ? err.message : String(err);
    }
    check("wrong clientId → throws (CAMPAIGN_NOT_FOUND)", notFoundThrew);
    check("reason: CAMPAIGN_NOT_FOUND",
      notFoundReason.includes("CAMPAIGN_NOT_FOUND"));

    // ── Section 2: Empty lead set ─────────────────────────────────────────
    section("Empty lead set — no provider call, no DB write");

    const { provider: emptyMock, calls: emptyCalls } = makeMockProvider(
      { uploadCount: 0, duplicateCount: 0 },
    );
    const emptyResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: baseCampaign.id },
      { provider: emptyMock },
    );
    check("empty: uploadedCount = 0",     emptyResult.uploadedCount  === 0);
    check("empty: readyCount = 0",        emptyResult.readyCount     === 0);
    check("empty: no provider calls",     emptyCalls.length          === 0);
    check("empty: dryRun = false",        emptyResult.dryRun         === false);

    // ── Section 3: dryRun ────────────────────────────────────────────────
    section("dryRun=true — no provider call and no DB state transition");

    // Create a contact and enroll it so there IS a ready lead
    const { data: ctDry, error: ctDryErr } = await db.from("contacts").insert({
      company_id:   testCompanyId,
      full_name:    `S20 DryRun [${RUN_TAG}]`,
      email:        `s20-dryrun-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s20-test",
    }).select("id").single();
    if (ctDryErr || !ctDry) throw new Error(`dryRun contact: ${ctDryErr?.message}`);
    const dryContactId = (ctDry as { id: string }).id;
    testContactIds.push(dryContactId);

    const dryCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] DryRun Campaign`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(dryCampaign.id);

    // Insert campaign_lead directly (bypasses enrollment, tests upload path)
    const now = new Date().toISOString();
    const { error: dryInsertErr } = await db.from("campaign_leads").insert({
      campaign_id: dryCampaign.id,
      contact_id:  dryContactId,
      client_id:   TEST_CLIENT_ID,
      status:      "ready",
      created_at:  now,
      updated_at:  now,
    });
    if (dryInsertErr) throw new Error(`dryRun campaign_lead: ${dryInsertErr.message}`);

    const { provider: dryMock, calls: dryCalls } = makeMockProvider(
      { uploadCount: 1, duplicateCount: 0 },
    );
    const dryResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: dryCampaign.id, dryRun: true },
      { provider: dryMock },
    );
    check("dryRun: readyCount = 1",        dryResult.readyCount   === 1);
    check("dryRun: uploadedCount = 0",     dryResult.uploadedCount === 0);
    check("dryRun: no provider calls",     dryCalls.length         === 0);
    check("dryRun: dryRun flag = true",    dryResult.dryRun        === true);

    // Verify DB row is still 'ready'
    const dryLeads = await getCampaignLeadsByContactIds(dryCampaign.id, TEST_CLIENT_ID, [dryContactId]);
    check("dryRun: DB row still status=ready", dryLeads.get(dryContactId)?.status === "ready");

    // ── Section 4: Happy path — 10 leads uploaded ─────────────────────────
    section("Happy path — 10 leads uploaded, status → 'uploaded'");

    const N_HAPPY = 10;
    const happyContactIds: string[] = [];

    const happyContactRows = Array.from({ length: N_HAPPY }, (_, i) => ({
      company_id:   testCompanyId,
      full_name:    `S20 Happy-${i} [${RUN_TAG}]`,
      email:        `s20-happy-${i}-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s20-test",
    }));
    const { data: happyCtRows, error: happyCtErr } = await db
      .from("contacts").insert(happyContactRows).select("id");
    if (happyCtErr || !happyCtRows) throw new Error(`happy contacts: ${happyCtErr?.message}`);
    for (const r of (happyCtRows as { id: string }[])) {
      happyContactIds.push(r.id);
      testContactIds.push(r.id);
    }

    const happyCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] Happy Campaign`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(happyCampaign.id);

    const nowHappy = new Date().toISOString();
    const { error: happyInsertErr } = await db.from("campaign_leads").insert(
      happyContactIds.map((cid) => ({
        campaign_id: happyCampaign.id,
        contact_id:  cid,
        client_id:   TEST_CLIENT_ID,
        status:      "ready",
        created_at:  nowHappy,
        updated_at:  nowHappy,
      })),
    );
    if (happyInsertErr) throw new Error(`happy campaign_leads: ${happyInsertErr.message}`);

    const { provider: happyMock, calls: happyCalls } = makeMockProvider(
      { uploadCount: N_HAPPY, duplicateCount: 0 },
    );
    const happyResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: happyCampaign.id },
      { provider: happyMock },
    );
    check("happy: readyCount = 10",        happyResult.readyCount    === N_HAPPY);
    check("happy: uploadedCount = 10",     happyResult.uploadedCount === N_HAPPY);
    check("happy: duplicateCount = 0",     happyResult.duplicateCount === 0);
    check("happy: failedCount = 0",        happyResult.failedCount   === 0);
    check("happy: 1 provider call",        happyCalls.length         === 1);
    check("happy: correct platformCampaignId passed to provider",
      happyCalls[0]?.platformCampaignId === SL_CAMPAIGN_ID);
    check("happy: 10 leads in provider call",
      happyCalls[0]?.leadsCount === N_HAPPY);
    check("happy: 1 batch in result",      happyResult.batches.length === 1);
    check("happy: batch not failed",       happyResult.batches[0]?.failed === false);

    // DB verification: all 10 rows should be 'uploaded'
    const happyLeads = await getCampaignLeadsByContactIds(
      happyCampaign.id, TEST_CLIENT_ID, happyContactIds,
    );
    const allUploaded = happyContactIds.every(
      (cid) => happyLeads.get(cid)?.status === "uploaded",
    );
    check("happy: all 10 DB rows status='uploaded'", allUploaded);
    check("happy: platform_lead_id is null (confirmed limitation)",
      happyContactIds.every((cid) => happyLeads.get(cid)?.platformLeadId === null),
    );

    // ── Section 5: Batching — 101 leads → 2 provider calls ────────────────
    section("Batching — 101 leads → 2 provider calls (100 + 1)");

    const N_BATCH = 101;
    const batchContactIds: string[] = [];

    const batchContactRows = Array.from({ length: N_BATCH }, (_, i) => ({
      company_id:   testCompanyId,
      full_name:    `S20 Batch-${i} [${RUN_TAG}]`,
      email:        `s20-batch-${i}-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s20-test",
    }));
    const { data: batchCtRows, error: batchCtErr } = await db
      .from("contacts").insert(batchContactRows).select("id");
    if (batchCtErr || !batchCtRows) throw new Error(`batch contacts: ${batchCtErr?.message}`);
    for (const r of (batchCtRows as { id: string }[])) {
      batchContactIds.push(r.id);
      testContactIds.push(r.id);
    }

    const batchCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] Batch-101 Campaign`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(batchCampaign.id);

    const nowBatch = new Date().toISOString();
    // Insert in two DB calls to stay within Supabase row limits
    const { error: batchInsert1Err } = await db.from("campaign_leads").insert(
      batchContactIds.slice(0, 60).map((cid) => ({
        campaign_id: batchCampaign.id,
        contact_id:  cid,
        client_id:   TEST_CLIENT_ID,
        status:      "ready",
        created_at:  nowBatch,
        updated_at:  nowBatch,
      })),
    );
    if (batchInsert1Err) throw new Error(`batch campaign_leads (1): ${batchInsert1Err.message}`);
    const { error: batchInsert2Err } = await db.from("campaign_leads").insert(
      batchContactIds.slice(60).map((cid) => ({
        campaign_id: batchCampaign.id,
        contact_id:  cid,
        client_id:   TEST_CLIENT_ID,
        status:      "ready",
        created_at:  nowBatch,
        updated_at:  nowBatch,
      })),
    );
    if (batchInsert2Err) throw new Error(`batch campaign_leads (2): ${batchInsert2Err.message}`);

    let batchCallCount = 0;
    const batchMock: LeadUploadProvider = {
      async uploadLeads(_cid: string, leads: UploadLeadInput[]): Promise<UploadLeadsResult> {
        batchCallCount++;
        return { uploadCount: leads.length, duplicateCount: 0 };
      },
    };
    const batchResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: batchCampaign.id },
      { provider: batchMock },
    );
    check("batching: readyCount = 101",         batchResult.readyCount    === N_BATCH);
    check("batching: uploadedCount = 101",      batchResult.uploadedCount === N_BATCH);
    check("batching: 2 provider calls",         batchCallCount            === 2);
    check("batching: 2 batches in result",      batchResult.batches.length === 2);
    check("batching: batch[0] has 100 leads",
      batchResult.batches[0]?.leadsInBatch === 100);
    check("batching: batch[1] has 1 lead",
      batchResult.batches[1]?.leadsInBatch === 1);

    // ── Section 6: Duplicate response ─────────────────────────────────────
    section("Duplicate response — upload_count=0, duplicate_count=N → rows still 'uploaded'");

    const dupCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] Duplicate Campaign`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(dupCampaign.id);

    const { data: ctDup, error: ctDupErr } = await db.from("contacts").insert({
      company_id:   testCompanyId,
      full_name:    `S20 Dup [${RUN_TAG}]`,
      email:        `s20-dup-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s20-test",
    }).select("id").single();
    if (ctDupErr || !ctDup) throw new Error(`dup contact: ${ctDupErr?.message}`);
    const dupContactId = (ctDup as { id: string }).id;
    testContactIds.push(dupContactId);

    const nowDup = new Date().toISOString();
    const { error: dupInsertErr } = await db.from("campaign_leads").insert({
      campaign_id: dupCampaign.id,
      contact_id:  dupContactId,
      client_id:   TEST_CLIENT_ID,
      status:      "ready",
      created_at:  nowDup,
      updated_at:  nowDup,
    });
    if (dupInsertErr) throw new Error(`dup campaign_lead: ${dupInsertErr.message}`);

    const { provider: dupMock } = makeMockProvider({ uploadCount: 0, duplicateCount: 1 });
    const dupResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: dupCampaign.id },
      { provider: dupMock },
    );
    check("duplicate: uploadedCount = 0",    dupResult.uploadedCount  === 0);
    check("duplicate: duplicateCount = 1",   dupResult.duplicateCount === 1);
    check("duplicate: failedCount = 0",      dupResult.failedCount    === 0);

    // DB: row should be 'uploaded' (Smartlead accepted it — duplicate is success)
    const dupLeads = await getCampaignLeadsByContactIds(
      dupCampaign.id, TEST_CLIENT_ID, [dupContactId],
    );
    check("duplicate: DB row status='uploaded'",
      dupLeads.get(dupContactId)?.status === "uploaded");

    // ── Section 7: Provider 5xx — leads remain 'ready' ────────────────────
    section("Provider 5xx — leads remain 'ready', failedCount reflects batch size");

    const failCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] Fail Campaign`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(failCampaign.id);

    const { data: ctFail, error: ctFailErr } = await db.from("contacts").insert({
      company_id:   testCompanyId,
      full_name:    `S20 Fail [${RUN_TAG}]`,
      email:        `s20-fail-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s20-test",
    }).select("id").single();
    if (ctFailErr || !ctFail) throw new Error(`fail contact: ${ctFailErr?.message}`);
    const failContactId = (ctFail as { id: string }).id;
    testContactIds.push(failContactId);

    const nowFail = new Date().toISOString();
    const { error: failInsertErr } = await db.from("campaign_leads").insert({
      campaign_id: failCampaign.id,
      contact_id:  failContactId,
      client_id:   TEST_CLIENT_ID,
      status:      "ready",
      created_at:  nowFail,
      updated_at:  nowFail,
    });
    if (failInsertErr) throw new Error(`fail campaign_lead: ${failInsertErr.message}`);

    const providerError = new Error("smartlead: server error 500");
    const { provider: failMock } = makeMockProvider(providerError);
    const failResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: failCampaign.id },
      { provider: failMock },
    );
    check("provider 5xx: uploadedCount = 0",     failResult.uploadedCount === 0);
    check("provider 5xx: failedCount = 1",       failResult.failedCount   === 1);
    check("provider 5xx: batch.failed = true",   failResult.batches[0]?.failed === true);
    check("provider 5xx: batch.error is set",    !!failResult.batches[0]?.error);
    check("provider 5xx: error doesn't contain API key",
      !failResult.batches[0]?.error?.includes(process.env.SMARTLEAD_API_KEY ?? "__no_key__"));

    // DB: row should still be 'ready'
    const failLeads = await getCampaignLeadsByContactIds(
      failCampaign.id, TEST_CLIENT_ID, [failContactId],
    );
    check("provider 5xx: DB row still status='ready'",
      failLeads.get(failContactId)?.status === "ready");

    // ── Section 8: Already-uploaded leads not re-selected ─────────────────
    section("Already-uploaded leads — not selected by getReadyLeadsForUpload");

    const alreadyUpCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] Already-Uploaded Campaign`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(alreadyUpCampaign.id);

    const { data: ctAlready, error: ctAlreadyErr } = await db.from("contacts").insert({
      company_id:   testCompanyId,
      full_name:    `S20 AlreadyUp [${RUN_TAG}]`,
      email:        `s20-already-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s20-test",
    }).select("id").single();
    if (ctAlreadyErr || !ctAlready) throw new Error(`alreadyUp contact: ${ctAlreadyErr?.message}`);
    const alreadyContactId = (ctAlready as { id: string }).id;
    testContactIds.push(alreadyContactId);

    // Insert with status='uploaded' directly — simulates a previously uploaded lead
    const nowAlready = new Date().toISOString();
    const { error: alreadyInsertErr } = await db.from("campaign_leads").insert({
      campaign_id: alreadyUpCampaign.id,
      contact_id:  alreadyContactId,
      client_id:   TEST_CLIENT_ID,
      status:      "uploaded",
      created_at:  nowAlready,
      updated_at:  nowAlready,
    });
    if (alreadyInsertErr) throw new Error(`alreadyUp campaign_lead: ${alreadyInsertErr.message}`);

    const { provider: alreadyMock, calls: alreadyCalls } = makeMockProvider(
      { uploadCount: 1, duplicateCount: 0 },
    );
    const alreadyResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: alreadyUpCampaign.id },
      { provider: alreadyMock },
    );
    check("already-uploaded: readyCount = 0",     alreadyResult.readyCount    === 0);
    check("already-uploaded: uploadedCount = 0",  alreadyResult.uploadedCount === 0);
    check("already-uploaded: no provider calls",  alreadyCalls.length         === 0);

    // ── Section 9: Client isolation ────────────────────────────────────────
    section("Client isolation — upload for correct client only");

    // ALT_CLIENT_ID is a non-existent client; getCampaignById scoped to it returns null
    const { provider: isoMock } = makeMockProvider({ uploadCount: 0, duplicateCount: 0 });
    let isoThrew = false;
    try {
      await uploadCampaignLeads(
        { clientId: ALT_CLIENT_ID, campaignId: baseCampaign.id },
        { provider: isoMock },
      );
    } catch {
      isoThrew = true;
    }
    check("client isolation: wrong clientId → throws", isoThrew);

    // ── Section 10: API key security ───────────────────────────────────────
    section("API key security — key value never appears in error messages");

    // Confirm: when the mock provider throws, the error that bubbles up does not
    // contain SMARTLEAD_API_KEY (even if it were somehow embedded). This verifies
    // that uploadCampaignLeads does not forward request URLs or env vars in errors.
    const keyValue = process.env.SMARTLEAD_API_KEY ?? "sk-fake-key-for-security-test";

    // Create a campaign so preconditions pass
    const secCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] Security-Test Campaign`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(secCampaign.id);

    // Insert a ready lead
    const { data: ctSec, error: ctSecErr } = await db.from("contacts").insert({
      company_id:   testCompanyId,
      full_name:    `S20 Sec [${RUN_TAG}]`,
      email:        `s20-sec-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s20-test",
    }).select("id").single();
    if (ctSecErr || !ctSec) throw new Error(`sec contact: ${ctSecErr?.message}`);
    const secContactId = (ctSec as { id: string }).id;
    testContactIds.push(secContactId);

    const nowSec = new Date().toISOString();
    const { error: secInsertErr } = await db.from("campaign_leads").insert({
      campaign_id: secCampaign.id,
      contact_id:  secContactId,
      client_id:   TEST_CLIENT_ID,
      status:      "ready",
      created_at:  nowSec,
      updated_at:  nowSec,
    });
    if (secInsertErr) throw new Error(`sec campaign_lead: ${secInsertErr.message}`);

    const secError = new Error(`Provider failure — key=REDACTED some other info`);
    const { provider: secMock } = makeMockProvider(secError);
    let secErrorMsg = "";
    const secResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: secCampaign.id },
      { provider: secMock },
    );
    // The error message is captured in the batch outcome, not re-thrown
    secErrorMsg = secResult.batches[0]?.error ?? "";
    check("API key: not present in captured batch error",
      !secErrorMsg.includes(keyValue),
      secErrorMsg.slice(0, 80));
    check("API key: error message does not contain 'api_key=' pattern",
      !secErrorMsg.toLowerCase().includes("api_key="),
      secErrorMsg.slice(0, 80));

    // ── Section 11: limit parameter ────────────────────────────────────────
    section("limit parameter — caps how many leads are processed");

    const limitCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:               `[${RUN_TAG}] Limit Campaign`,
      status:             "draft",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
    });
    createdCampaignIds.push(limitCampaign.id);

    const limitContactIds: string[] = [];
    const limitCtRows = Array.from({ length: 5 }, (_, i) => ({
      company_id:   testCompanyId,
      full_name:    `S20 Limit-${i} [${RUN_TAG}]`,
      email:        `s20-limit-${i}-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s20-test",
    }));
    const { data: limitCtData, error: limitCtErr } = await db
      .from("contacts").insert(limitCtRows).select("id");
    if (limitCtErr || !limitCtData) throw new Error(`limit contacts: ${limitCtErr?.message}`);
    for (const r of (limitCtData as { id: string }[])) {
      limitContactIds.push(r.id);
      testContactIds.push(r.id);
    }

    const nowLimit = new Date().toISOString();
    const { error: limitInsertErr } = await db.from("campaign_leads").insert(
      limitContactIds.map((cid) => ({
        campaign_id: limitCampaign.id,
        contact_id:  cid,
        client_id:   TEST_CLIENT_ID,
        status:      "ready",
        created_at:  nowLimit,
        updated_at:  nowLimit,
      })),
    );
    if (limitInsertErr) throw new Error(`limit campaign_leads: ${limitInsertErr.message}`);

    const { provider: limitMock, calls: limitCalls } = makeMockProvider(
      { uploadCount: 2, duplicateCount: 0 },
    );
    const limitResult = await uploadCampaignLeads(
      { clientId: TEST_CLIENT_ID, campaignId: limitCampaign.id, limit: 2 },
      { provider: limitMock },
    );
    check("limit: readyCount = 2 (capped)",    limitResult.readyCount    === 2);
    check("limit: uploadedCount = 2",          limitResult.uploadedCount === 2);
    check("limit: 1 provider call",            limitCalls.length         === 1);
    check("limit: provider received 2 leads",  limitCalls[0]?.leadsCount === 2);

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log(`PASSED: ${passed}  FAILED: ${failed}`);
    console.log("=".repeat(70));

  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────
    section("Cleanup");
    const db2 = getSupabaseAdmin();

    for (const campaignId of createdCampaignIds) {
      try {
        await deleteCampaign(TEST_CLIENT_ID, campaignId);
      } catch (err) {
        console.error(`  warn: cleanup campaign ${campaignId}: ${err}`);
      }
    }
    console.log(`  ✓ ${createdCampaignIds.length} campaigns deleted (campaign_leads cascade)`);

    if (testContactIds.length > 0) {
      const { error: ctCleanErr } = await db2
        .from("contacts")
        .delete()
        .in("id", testContactIds);
      if (ctCleanErr) console.error(`  warn: contact cleanup: ${ctCleanErr.message}`);
      else console.log(`  ✓ ${testContactIds.length} contacts deleted`);
    }

    if (testCompanyId) {
      const { error: coCleanErr } = await db2
        .from("companies")
        .delete()
        .eq("id", testCompanyId);
      if (coCleanErr) console.error(`  warn: company cleanup: ${coCleanErr.message}`);
      else console.log(`  ✓ Test company deleted`);
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
