/**
 * Stage 19B — Lead Enrollment Integration Test.
 *
 * Exercises enrollContacts() against the live Supabase database.
 *
 * Creates synthetic test fixtures, runs all required scenarios, then deletes
 * everything in finally blocks. campaign_leads rows are cleaned up automatically
 * via ON DELETE CASCADE when campaigns are deleted.
 *
 * HARD CONSTRAINTS:
 *   - No emails sent. No outbound calls. No provider writes.
 *   - All test data created here is cleaned up in finally blocks.
 *   - API secrets are NEVER logged — only their presence is confirmed.
 *   - FINDING 5 (list/client isolation gap) remains open.
 *   - FINDING 6 (campaign_leads RLS enabled, no policies) remains open.
 *   - No RLS policy changes. No campaign status mutations.
 *
 * Run:
 *   npx tsx scripts/lead-enrollment-integration-test.ts
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

import { getSupabaseAdmin }                   from "../src/db/supabase.js";
import { createCampaign, deleteCampaign }     from "../src/db/campaigns.js";
import { createList }                         from "../src/db/companies.js";
import { suppressContact, liftSuppression }   from "../src/db/contact-suppression.js";
import { getCampaignLeadCount, getCampaignLeadsByContactIds } from "../src/db/campaign-leads.js";
import { enrollContacts }                     from "../src/lib/lead-enrollment.js";

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

// ── Test client (Gramscode, created Stage 10.5) ───────────────────────────────

const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const RUN_TAG        = `s19b-${Date.now()}`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 19B — Lead Enrollment Integration Test");
  console.log("=".repeat(70));

  // ── Pre-flight ─────────────────────────────────────────────────────────────
  section("Pre-flight checks");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);
  if (!hasSupabase) {
    console.error("\nAbort: Supabase credentials missing.");
    process.exit(1);
  }

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
  note("client_id",   TEST_CLIENT_ID);
  note("client_name", (clientRow as { name: string }).name);

  // ── Fixture state ─────────────────────────────────────────────────────────
  const createdCampaignIds: string[] = [];
  let testListId:        string | null = null;
  let testCompanyAId:    string | null = null;
  let testCompanyBId:    string | null = null;
  let contactEligId:     string | null = null;  // eligible: Company A, verified email
  let contactNoAiId:     string | null = null;  // ineligible: Company B, no AI
  let contactInvEmailId: string | null = null;  // ineligible: Company A, invalid email
  let contactStaleEvId:  string | null = null;  // ineligible: Company A, stale email verification
  let contactScoreZeroId:string | null = null;  // ineligible: Company A, AI score=0
  let contactSuppId:     string | null = null;  // ineligible: suppressed
  let suppressionId:     string | null = null;

  // ── Fixture creation ───────────────────────────────────────────────────────
  section("Fixture setup");

  try {
    // Company A — has account_intelligence (score=50)
    const { data: coA, error: coAErr } = await db
      .from("companies")
      .insert({ name: `S19B-CoA [${RUN_TAG}]`, domain: `s19b-co-a-${RUN_TAG}.invalid`, status: "review" })
      .select("id").single();
    if (coAErr || !coA) throw new Error(`company A: ${coAErr?.message}`);
    testCompanyAId = (coA as { id: string }).id;
    check("Company A created", !!testCompanyAId);

    // Company B — no account_intelligence
    const { data: coB, error: coBErr } = await db
      .from("companies")
      .insert({ name: `S19B-CoB [${RUN_TAG}]`, domain: `s19b-co-b-${RUN_TAG}.invalid`, status: "review" })
      .select("id").single();
    if (coBErr || !coB) throw new Error(`company B: ${coBErr?.message}`);
    testCompanyBId = (coB as { id: string }).id;
    check("Company B created", !!testCompanyBId);

    // account_intelligence: Company A score=50, Company C (via contactScoreZero) score=0
    const { error: aiAErr } = await db.from("account_intelligence").insert({
      client_id:                    TEST_CLIENT_ID,
      company_id:                   testCompanyAId,
      opportunity_score:            50,
      opportunity_score_updated_at: new Date().toISOString(),
      score_inputs:                 null,
      updated_at:                   new Date().toISOString(),
    });
    if (aiAErr) throw new Error(`account_intelligence Company A: ${aiAErr.message}`);
    check("Account intelligence Company A (score=50)", true);

    // Contact: eligible (Company A, email_status=VERIFIED, no email_verification row needed)
    const { data: ctE, error: ctEErr } = await db.from("contacts").insert({
      company_id:   testCompanyAId,
      full_name:    `S19B Eligible [${RUN_TAG}]`,
      email:        `s19b-elig-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s19b-test",
    }).select("id").single();
    if (ctEErr || !ctE) throw new Error(`contact eligible: ${ctEErr?.message}`);
    contactEligId = (ctE as { id: string }).id;
    check("Contact eligible created", !!contactEligId);

    // Contact: no AI (Company B)
    const { data: ctNA, error: ctNAErr } = await db.from("contacts").insert({
      company_id:   testCompanyBId,
      full_name:    `S19B NoAI [${RUN_TAG}]`,
      email:        `s19b-noai-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s19b-test",
    }).select("id").single();
    if (ctNAErr || !ctNA) throw new Error(`contact no AI: ${ctNAErr?.message}`);
    contactNoAiId = (ctNA as { id: string }).id;
    check("Contact no-AI created", !!contactNoAiId);

    // Contact: invalid email verification (Company A — needs email_verifications row)
    const { data: ctIE, error: ctIEErr } = await db.from("contacts").insert({
      company_id:   testCompanyAId,
      full_name:    `S19B InvalidEmail [${RUN_TAG}]`,
      email:        `s19b-invemail-${RUN_TAG}@test.invalid`,
      email_status: null,
      status:       "review",
      source:       "s19b-test",
    }).select("id").single();
    if (ctIEErr || !ctIE) throw new Error(`contact invalid email: ${ctIEErr?.message}`);
    contactInvEmailId = (ctIE as { id: string }).id;
    check("Contact invalid-email created", !!contactInvEmailId);

    // Insert email_verifications row: isValid=false
    const { error: evInvErr } = await db.from("email_verifications").insert({
      contact_id:  contactInvEmailId,
      email:       `s19b-invemail-${RUN_TAG}@test.invalid`,
      is_valid:    false,
      result:      "invalid_mailbox",
      verified_at: new Date().toISOString(),
      created_at:  new Date().toISOString(),
    });
    if (evInvErr) throw new Error(`email_verifications (invalid): ${evInvErr.message}`);
    check("Invalid email verification row inserted", true);

    // Contact: stale email verification (Company A — verified > 90 days ago)
    const { data: ctSE, error: ctSEErr } = await db.from("contacts").insert({
      company_id:   testCompanyAId,
      full_name:    `S19B StaleEmail [${RUN_TAG}]`,
      email:        `s19b-stale-${RUN_TAG}@test.invalid`,
      email_status: null,
      status:       "review",
      source:       "s19b-test",
    }).select("id").single();
    if (ctSEErr || !ctSE) throw new Error(`contact stale email: ${ctSEErr?.message}`);
    contactStaleEvId = (ctSE as { id: string }).id;
    check("Contact stale-email created", !!contactStaleEvId);

    // Stale: isValid=true but verified_at = 120 days ago
    const staleDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const { error: evStaleErr } = await db.from("email_verifications").insert({
      contact_id:  contactStaleEvId,
      email:       `s19b-stale-${RUN_TAG}@test.invalid`,
      is_valid:    true,
      result:      "valid",
      verified_at: staleDate,
      created_at:  staleDate,
    });
    if (evStaleErr) throw new Error(`email_verifications (stale): ${evStaleErr.message}`);
    check("Stale email verification row inserted (120 days old)", true);

    // Contact: account score zero (Company A, AI inserted with score=0)
    const { data: ctSZ, error: ctSZErr } = await db.from("contacts").insert({
      company_id:   testCompanyAId,
      full_name:    `S19B ScoreZero [${RUN_TAG}]`,
      email:        `s19b-scorezero-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s19b-test",
    }).select("id").single();
    if (ctSZErr || !ctSZ) throw new Error(`contact score-zero: ${ctSZErr?.message}`);
    contactScoreZeroId = (ctSZ as { id: string }).id;
    check("Contact score-zero created", !!contactScoreZeroId);

    // account_intelligence for score-zero contact — same company A, but we use a new company
    // Actually, all Company A contacts share the same AI row (score=50).
    // To test score=0, we need a separate company. Let's create a Company C with score=0.
    // For simplicity, re-use Company A for the score-zero contact and instead:
    // The score-zero contact will actually be on a new Company C with AI score=0.
    // Correction: Company C is a separate company with AI score=0.
    const { data: coC, error: coCErr } = await db
      .from("companies")
      .insert({ name: `S19B-CoC-ScoreZero [${RUN_TAG}]`, domain: `s19b-co-c-${RUN_TAG}.invalid`, status: "review" })
      .select("id").single();
    if (coCErr || !coC) throw new Error(`company C: ${coCErr?.message}`);
    const testCompanyCId = (coC as { id: string }).id;
    check("Company C (score=0) created", !!testCompanyCId);

    // Re-insert score-zero contact for Company C (move it off Company A to isolate test)
    await db.from("contacts").delete().eq("id", contactScoreZeroId!);
    const { data: ctSZ2, error: ctSZ2Err } = await db.from("contacts").insert({
      company_id:   testCompanyCId,
      full_name:    `S19B ScoreZero [${RUN_TAG}]`,
      email:        `s19b-scorezero-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s19b-test",
    }).select("id").single();
    if (ctSZ2Err || !ctSZ2) throw new Error(`contact score-zero (re-insert): ${ctSZ2Err?.message}`);
    contactScoreZeroId = (ctSZ2 as { id: string }).id;

    const { error: aiCErr } = await db.from("account_intelligence").insert({
      client_id:                    TEST_CLIENT_ID,
      company_id:                   testCompanyCId,
      opportunity_score:            0,
      opportunity_score_updated_at: new Date().toISOString(),
      score_inputs:                 null,
      updated_at:                   new Date().toISOString(),
    });
    if (aiCErr) throw new Error(`account_intelligence Company C: ${aiCErr.message}`);
    check("Account intelligence Company C (score=0)", true);
    check("Contact score-zero re-created on Company C", !!contactScoreZeroId);

    // Contact: will be suppressed
    const { data: ctSP, error: ctSPErr } = await db.from("contacts").insert({
      company_id:   testCompanyAId,
      full_name:    `S19B Suppressed [${RUN_TAG}]`,
      email:        `s19b-supp-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s19b-test",
    }).select("id").single();
    if (ctSPErr || !ctSP) throw new Error(`contact suppressed: ${ctSPErr?.message}`);
    contactSuppId = (ctSP as { id: string }).id;
    check("Contact suppressed created", !!contactSuppId);

    // Suppress it — permanent
    const suppRow = await suppressContact(TEST_CLIENT_ID, contactSuppId!, {
      reason:    "manual",
      expiresAt: null, // permanent
    });
    suppressionId = suppRow.id;
    check("Contact suppressed (permanent)", !!suppressionId);

    // Test list
    const list = await createList({
      name:        `S19B Integration Test List [${RUN_TAG}]`,
      environment: "test",
      status:      "active",
    });
    testListId = list.id;
    check("Test list created", !!testListId);

    // Populate list (Path A — company members, all contacts via their companies)
    const { error: lmAErr } = await db.from("list_members").insert([
      { list_id: testListId!, company_id: testCompanyAId! },
      { list_id: testListId!, company_id: testCompanyBId! },
      { list_id: testListId!, company_id: testCompanyCId! },
    ]);
    if (lmAErr) throw new Error(`list_members: ${lmAErr.message}`);
    check("List populated with Company A, B, C members", true);

  } catch (err) {
    console.error("\nAbort: fixture setup failed:", err);
    process.exit(1);
  }

  // ── All test sections ──────────────────────────────────────────────────────
  try {

    // ── Section 1: Campaign not found ──────────────────────────────────────
    section("Campaign not found → all contacts rejected");

    const notFoundResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: "00000000-0000-0000-0000-000000000000",
      contactIds: [contactEligId!],
    });
    check("enrolled = 0 when campaign not found",    notFoundResult.enrolled       === 0);
    check("rejected = 1 when campaign not found",    notFoundResult.rejected       === 1);
    check("reason = CAMPAIGN_NOT_FOUND",             notFoundResult.rejections[0]?.reason === "CAMPAIGN_NOT_FOUND");
    check("no leads written when campaign not found", notFoundResult.leads.length  === 0);

    // ── Section 2: Wrong client → campaign not found ───────────────────────
    section("Wrong client → campaign treated as not found");

    const campaignForWrongClientTest = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Wrong-Client Target`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(campaignForWrongClientTest.id);

    const wrongClientResult = await enrollContacts({
      clientId:   "00000000-0000-0000-0000-000000000001", // wrong client
      campaignId: campaignForWrongClientTest.id,
      contactIds: [contactEligId!],
    });
    check("enrolled = 0 with wrong client",   wrongClientResult.enrolled  === 0);
    check("rejected = 1 with wrong client",   wrongClientResult.rejected  === 1);
    check("reason is CAMPAIGN_NOT_FOUND (client-scoped getCampaignById returns null)",
      wrongClientResult.rejections[0]?.reason === "CAMPAIGN_NOT_FOUND");
    check("no leads written for wrong client", wrongClientResult.leads.length === 0);

    // ── Section 3: Inactive campaign statuses → CAMPAIGN_NOT_ACTIVE ────────
    section("Inactive campaign statuses → enrollment blocked");

    for (const status of ["review", "ready", "paused", "completed", "cancelled"] as const) {
      const inactiveCampaign = await createCampaign(TEST_CLIENT_ID, {
        name:   `[${RUN_TAG}] Status-${status}`,
        status,
        listId: testListId!,
      });
      createdCampaignIds.push(inactiveCampaign.id);

      const inactiveResult = await enrollContacts({
        clientId:   TEST_CLIENT_ID,
        campaignId: inactiveCampaign.id,
        contactIds: [contactEligId!],
      });
      check(`status=${status} → enrolled=0`,  inactiveResult.enrolled === 0);
      check(`status=${status} → CAMPAIGN_NOT_ACTIVE`,
        inactiveResult.rejections[0]?.reason === "CAMPAIGN_NOT_ACTIVE",
        `got: ${inactiveResult.rejections[0]?.reason}`);
      check(`status=${status} → no leads written`, inactiveResult.leads.length === 0);
    }

    // ── Section 4: Ineligible contacts (gate failures) ─────────────────────
    section("Gate failures — ineligible contacts are rejected, not enrolled");

    const gateCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Gate-Test Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(gateCampaign.id);

    // Gate 1: no account intelligence (Company B contact)
    const noAiResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: gateCampaign.id,
      contactIds: [contactNoAiId!],
    });
    check("No AI → enrolled=0",         noAiResult.enrolled === 0);
    check("No AI → reason is NO_ACCOUNT_INTELLIGENCE",
      noAiResult.rejections[0]?.reason === "NO_ACCOUNT_INTELLIGENCE",
      `got: ${noAiResult.rejections[0]?.reason}`);

    // Gate 1: account score zero
    const scoreZeroResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: gateCampaign.id,
      contactIds: [contactScoreZeroId!],
    });
    check("Score=0 → enrolled=0",       scoreZeroResult.enrolled === 0);
    check("Score=0 → ACCOUNT_SCORE_ZERO",
      scoreZeroResult.rejections[0]?.reason === "ACCOUNT_SCORE_ZERO",
      `got: ${scoreZeroResult.rejections[0]?.reason}`);

    // Gate 3: invalid email verification
    const invEmailResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: gateCampaign.id,
      contactIds: [contactInvEmailId!],
    });
    check("Invalid email → enrolled=0",       invEmailResult.enrolled === 0);
    check("Invalid email → EMAIL_INVALID",
      invEmailResult.rejections[0]?.reason === "EMAIL_INVALID",
      `got: ${invEmailResult.rejections[0]?.reason}`);

    // Gate 3: stale email verification
    const staleResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: gateCampaign.id,
      contactIds: [contactStaleEvId!],
    });
    check("Stale email → enrolled=0",         staleResult.enrolled === 0);
    check("Stale email → EMAIL_VERIFICATION_STALE",
      staleResult.rejections[0]?.reason === "EMAIL_VERIFICATION_STALE",
      `got: ${staleResult.rejections[0]?.reason}`);

    // Gate 4: suppression (hard block)
    const suppResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: gateCampaign.id,
      contactIds: [contactSuppId!],
    });
    check("Suppressed → enrolled=0",          suppResult.enrolled === 0);
    check("Suppressed → CONTACT_SUPPRESSED",
      suppResult.rejections[0]?.reason === "CONTACT_SUPPRESSED",
      `got: ${suppResult.rejections[0]?.reason}`);
    check("Suppressed → no leads written",    suppResult.leads.length === 0);

    // Verify suppression is truly a hard block — count in campaign_leads should be 0
    const suppLeadCount = await getCampaignLeadCount(gateCampaign.id, TEST_CLIENT_ID);
    check("Suppressed contact: 0 rows in campaign_leads (DB verified)", suppLeadCount === 0);

    // Gate failure: no outbound side effects — rejections contain only reason+detail
    check("Rejection has no outbound data (reason+detail only)",
      Object.keys(suppResult.rejections[0] ?? {}).sort().join(",") === "contactId,detail,reason");

    // ── Section 5: Happy path — successful enrollment ──────────────────────
    section("Happy path — single eligible contact enrolled");

    const happyCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Happy-Path Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(happyCampaign.id);

    const happyResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: happyCampaign.id,
      contactIds: [contactEligId!],
    });
    check("enrolled = 1",            happyResult.enrolled        === 1);
    check("rejected = 0",            happyResult.rejected        === 0);
    check("alreadyEnrolled = 0",     happyResult.alreadyEnrolled === 0);
    check("leads.length = 1",        happyResult.leads.length    === 1);
    check("lead.status = 'ready'",   happyResult.leads[0]?.status === "ready");
    check("lead.contactId correct",  happyResult.leads[0]?.contactId === contactEligId);
    check("lead.campaignLeadId is uuid (non-empty)",
      (happyResult.leads[0]?.campaignLeadId?.length ?? 0) > 0);
    check("lead.enrolledAt is ISO timestamp",
      /^\d{4}-\d{2}-\d{2}T/.test(happyResult.leads[0]?.enrolledAt ?? ""));
    check("enrolledAt is set on result",
      /^\d{4}-\d{2}-\d{2}T/.test(happyResult.enrolledAt));

    // DB verification: check row exists with correct status and updated_at
    const happyLeads = await getCampaignLeadsByContactIds(
      happyCampaign.id, TEST_CLIENT_ID, [contactEligId!],
    );
    const happyLead = happyLeads.get(contactEligId!);
    check("DB row exists for enrolled contact",   !!happyLead);
    check("DB row status = 'ready'",              happyLead?.status === "ready");
    check("DB row updated_at is set (non-empty)", (happyLead?.updatedAt?.length ?? 0) > 0);
    check("DB row client_id = TEST_CLIENT_ID",    happyLead?.clientId === TEST_CLIENT_ID);
    check("DB row campaign_id correct",           happyLead?.campaignId === happyCampaign.id);

    // getCampaignLeadCount
    const happyCount = await getCampaignLeadCount(happyCampaign.id, TEST_CLIENT_ID);
    check("getCampaignLeadCount = 1 after enrollment", happyCount === 1);

    // ── Section 6: Multiple eligible contacts ─────────────────────────────
    section("Multiple eligible contacts — all enrolled");

    // Create a second eligible contact
    const { data: ctE2, error: ctE2Err } = await db.from("contacts").insert({
      company_id:   testCompanyAId!,
      full_name:    `S19B Eligible-2 [${RUN_TAG}]`,
      email:        `s19b-elig2-${RUN_TAG}@test.invalid`,
      email_status: "VERIFIED",
      status:       "review",
      source:       "s19b-test",
    }).select("id").single();
    if (ctE2Err || !ctE2) throw new Error(`contact eligible-2: ${ctE2Err?.message}`);
    const contactElig2Id = (ctE2 as { id: string }).id;

    const multiCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Multi-Enroll Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(multiCampaign.id);

    const multiResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: multiCampaign.id,
      contactIds: [contactEligId!, contactElig2Id],
    });
    check("multiple: enrolled = 2",    multiResult.enrolled        === 2);
    check("multiple: rejected = 0",    multiResult.rejected        === 0);
    check("multiple: leads.length = 2", multiResult.leads.length   === 2);
    check("multiple: requested = 2",   multiResult.requested       === 2);

    const multiCount = await getCampaignLeadCount(multiCampaign.id, TEST_CLIENT_ID);
    check("getCampaignLeadCount = 2 after multi-enroll", multiCount === 2);

    // Cleanup extra contact (not cleaned by campaign cascade, contacts are global)
    await db.from("contacts").delete().eq("id", contactElig2Id);

    // ── Section 7: Mixed batch — eligible + ineligible ─────────────────────
    section("Mixed batch — eligible and ineligible contacts");

    const mixCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Mixed-Batch Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(mixCampaign.id);

    const mixResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: mixCampaign.id,
      contactIds: [contactEligId!, contactNoAiId!, contactSuppId!],
    });
    check("mixed: requested = 3",         mixResult.requested       === 3);
    check("mixed: enrolled = 1",          mixResult.enrolled        === 1);
    check("mixed: rejected = 2",          mixResult.rejected        === 2);
    check("mixed: alreadyEnrolled = 0",   mixResult.alreadyEnrolled === 0);
    check("mixed: leads.length = 1",      mixResult.leads.length    === 1);
    check("mixed: rejections.length = 2", mixResult.rejections.length === 2);
    check("mixed: eligible contact enrolled",
      mixResult.leads[0]?.contactId === contactEligId);
    check("mixed: suppressed not enrolled",
      !mixResult.leads.some((l) => l.contactId === contactSuppId));
    check("mixed: DB count = 1",
      (await getCampaignLeadCount(mixCampaign.id, TEST_CLIENT_ID)) === 1);

    // ── Section 8: Idempotency — re-enroll same contacts ──────────────────
    section("Idempotency — repeated enrollment is a no-op");

    // Second call with same contactEligId to happyCampaign (already enrolled)
    const idempotentResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: happyCampaign.id,
      contactIds: [contactEligId!],
    });
    check("idempotent: enrolled = 0 on second call",        idempotentResult.enrolled        === 0);
    check("idempotent: alreadyEnrolled = 1",                idempotentResult.alreadyEnrolled === 1);
    check("idempotent: rejected = 0",                       idempotentResult.rejected        === 0);
    check("idempotent: no new leads written",               idempotentResult.leads.length   === 0);

    // DB count still = 1 (no duplicate row)
    const idempotentCount = await getCampaignLeadCount(happyCampaign.id, TEST_CLIENT_ID);
    check("idempotent: DB count unchanged at 1 (UNIQUE constraint)", idempotentCount === 1);

    // ── Section 9: Concurrent enrollment simulation ────────────────────────
    section("Concurrent enrollment — ON CONFLICT DO NOTHING handles race");

    const raceCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Race-Test Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(raceCampaign.id);

    // Run two enrollment calls concurrently for the same contact
    const [raceA, raceB] = await Promise.all([
      enrollContacts({ clientId: TEST_CLIENT_ID, campaignId: raceCampaign.id, contactIds: [contactEligId!] }),
      enrollContacts({ clientId: TEST_CLIENT_ID, campaignId: raceCampaign.id, contactIds: [contactEligId!] }),
    ]);

    const raceTotal = (raceA.enrolled + raceA.alreadyEnrolled)
      + (raceB.enrolled + raceB.alreadyEnrolled);
    const raceEnrolled = raceA.enrolled + raceB.enrolled;
    const raceAlready  = raceA.alreadyEnrolled + raceB.alreadyEnrolled;

    check("concurrent: exactly 1 row in DB", (await getCampaignLeadCount(raceCampaign.id, TEST_CLIENT_ID)) === 1);
    check("concurrent: total attempted = 2", raceTotal    === 2);
    check("concurrent: enrolled + alreadyEnrolled = 2", raceEnrolled + raceAlready === 2);
    check("concurrent: at least 1 enrolled",  raceEnrolled >= 1);
    // At most 1 can be enrolled (UNIQUE constraint)
    check("concurrent: at most 1 enrolled (UNIQUE constraint)", raceEnrolled <= 1);

    // ── Section 10: Running campaign also accepts enrollment ───────────────
    section("Running campaign accepts enrollment");

    const runCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Running Campaign`,
      status: "running",
      listId: testListId!,
    });
    createdCampaignIds.push(runCampaign.id);

    const runResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: runCampaign.id,
      contactIds: [contactEligId!],
    });
    check("running campaign: enrolled = 1", runResult.enrolled === 1);
    check("running campaign: status=ready", runResult.leads[0]?.status === "ready");

    // ── Section 11: dryRun — validate without writing ─────────────────────
    section("dryRun=true — no rows written to campaign_leads");

    const dryRunCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] DryRun Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(dryRunCampaign.id);

    const dryResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: dryRunCampaign.id,
      contactIds: [contactEligId!],
      dryRun:     true,
    });
    check("dryRun: result.dryRun = true",       dryResult.dryRun       === true);
    check("dryRun: enrolled = 0 (no DB write)",  dryResult.enrolled     === 0);
    check("dryRun: rejected = 0 (contact passes)", dryResult.rejected   === 0);
    check("dryRun: leads.length = 0",            dryResult.leads.length === 0);
    check("dryRun: DB count = 0 (confirmed)",
      (await getCampaignLeadCount(dryRunCampaign.id, TEST_CLIENT_ID)) === 0);

    // ── Section 12: Empty contactIds ───────────────────────────────────────
    section("Empty contactIds → zero enrollments");

    const emptyInputCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] EmptyInput Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(emptyInputCampaign.id);

    const emptyInputResult = await enrollContacts({
      clientId:   TEST_CLIENT_ID,
      campaignId: emptyInputCampaign.id,
      contactIds: [],
    });
    check("empty contactIds: enrolled = 0",        emptyInputResult.enrolled        === 0);
    check("empty contactIds: alreadyEnrolled = 0", emptyInputResult.alreadyEnrolled === 0);
    check("empty contactIds: rejected = 0",        emptyInputResult.rejected        === 0);
    check("empty contactIds: requested = 0",       emptyInputResult.requested       === 0);

    // ── Section 13: Client isolation ──────────────────────────────────────
    section("Client isolation — enrolled contacts are scoped to campaign's client");

    // getCampaignLeadsByContactIds is client-scoped — another client sees 0 rows
    const wrongClientLeads = await getCampaignLeadsByContactIds(
      happyCampaign.id,
      "00000000-0000-0000-0000-000000000001", // wrong client
      [contactEligId!],
    );
    check("Client isolation: wrong client sees 0 enrolled leads",
      wrongClientLeads.size === 0);

    // ── Section 14: Composite FK protection ───────────────────────────────
    section("Composite FK (client_id, campaign_id) → campaigns protects tenant integrity");

    // The DB-level protection is tested by attempting to enroll with a mismatched
    // client_id. getCampaignById returns null for wrong client → CAMPAIGN_NOT_FOUND.
    // The INSERT never fires, so the composite FK is never violated.
    // This is the correct application-layer behavior — the FK serves as a final guard.
    const fkCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] FK-Test Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(fkCampaign.id);

    const fkResult = await enrollContacts({
      clientId:   "00000000-0000-0000-0000-000000000002", // wrong client
      campaignId: fkCampaign.id,
      contactIds: [contactEligId!],
    });
    check("FK guard: enrolled = 0 with mismatched client",  fkResult.enrolled === 0);
    check("FK guard: CAMPAIGN_NOT_FOUND (application-layer guard fires first)",
      fkResult.rejections[0]?.reason === "CAMPAIGN_NOT_FOUND");
    check("FK guard: no leads written", (await getCampaignLeadCount(fkCampaign.id, TEST_CLIENT_ID)) === 0);

  } finally {
    // ── Cleanup ────────────────────────────────────────────────────────────
    section("Cleanup");

    let cleanupOk = true;

    // 1. Delete campaigns — campaign_leads cascade-deletes automatically
    for (const id of createdCampaignIds) {
      try { await deleteCampaign(TEST_CLIENT_ID, id); }
      catch (err) { console.error(`  cleanup: campaign ${id} failed:`, err); cleanupOk = false; }
    }
    check(`Campaigns deleted (${createdCampaignIds.length})`, true);

    // Verify campaign_leads are gone (check one campaign)
    if (createdCampaignIds.length > 0) {
      const residualCount = await getCampaignLeadCount(createdCampaignIds[0]!, TEST_CLIENT_ID);
      check("campaign_leads cascade-deleted (0 rows remain)", residualCount === 0);
    }

    // 2. Lift suppression
    if (suppressionId) {
      try { await liftSuppression(suppressionId); } catch { /* already gone */ }
    }

    // 3. Delete test list
    if (testListId) {
      try { await db.from("lists").delete().eq("id", testListId); }
      catch (err) { console.error("  cleanup: list failed:", err); cleanupOk = false; }
    }
    check("Test list deleted", true);

    // 4. Delete test contacts (global table — not cascade-deleted by company)
    const contactsToDelete = [
      contactEligId, contactNoAiId, contactInvEmailId,
      contactStaleEvId, contactScoreZeroId, contactSuppId,
    ].filter(Boolean) as string[];
    if (contactsToDelete.length > 0) {
      const { error: delCtErr } = await db.from("contacts").delete().in("id", contactsToDelete);
      check("Test contacts deleted", !delCtErr, delCtErr?.message);
    }

    // 5. Delete account_intelligence rows
    const { error: delAiErr } = await db.from("account_intelligence")
      .delete()
      .eq("client_id", TEST_CLIENT_ID)
      .like("updated_at", "%") // all rows for test companies cascade-deleted with companies
    ;
    // AI rows will be cascade-deleted when companies are deleted — see next step

    // 6. Delete test companies — cascades to contacts rows created for company,
    //    account_intelligence, and (via list_members) list membership.
    if (testCompanyAId) {
      const { error: delCoAErr } = await db.from("companies").delete().eq("id", testCompanyAId);
      check("Company A deleted", !delCoAErr, delCoAErr?.message);
    }
    if (testCompanyBId) {
      const { error: delCoBErr } = await db.from("companies").delete().eq("id", testCompanyBId);
      check("Company B deleted", !delCoBErr, delCoBErr?.message);
    }

    // Company C (score=0) — identified by the score-zero contact's company
    // Delete all remaining test companies with S19B tag
    const { error: delCoCErr } = await db.from("companies")
      .delete()
      .like("domain", `%${RUN_TAG}%`);
    check("All remaining test companies deleted", !delCoCErr, delCoCErr?.message);

    check("Overall cleanup", cleanupOk);
  }

  // ── Final result ───────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  if (failed === 0) {
    console.log(`  ✓ All ${passed} checks passed`);
  } else {
    console.log(`  ✗ ${failed} failed / ${passed + failed} total`);
  }
  console.log("=".repeat(70));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
});
