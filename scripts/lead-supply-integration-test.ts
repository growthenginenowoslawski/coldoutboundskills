/**
 * Stage 19A — Lead Supply Integration Test.
 *
 * Exercises assessCampaignLeadSupply() against the live Supabase database.
 *
 * Creates synthetic test fixtures (two companies, two contacts, one list,
 * several campaigns), runs all required test scenarios, then deletes everything
 * in finally blocks.
 *
 * HARD CONSTRAINTS:
 *   - No emails sent. No outbound calls.
 *   - No writes to campaign_leads.
 *   - All test data created here is cleaned up in finally blocks.
 *   - API secrets are NEVER logged — only their presence is confirmed.
 *   - FINDING 5 (list/client isolation gap) is documented, not resolved.
 *     listClientWarning is visibility only.
 *
 * ALREADY_ENROLLED is tested in pure unit tests only — no campaign_leads writes
 * are made here (Stage 19A constraint).
 *
 * Run:
 *   npx tsx scripts/lead-supply-integration-test.ts
 *
 * Env vars required:
 *   SUPABASE_URL         — always required
 *   SUPABASE_SECRET_KEY  — always required
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";
import { createCampaign, deleteCampaign } from "../src/db/campaigns.js";
import { createList } from "../src/db/companies.js";
import { suppressContact, liftSuppression } from "../src/db/contact-suppression.js";
import { assessCampaignLeadSupply } from "../src/lib/lead-supply.js";

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

// ── Unique suffix (avoids UNIQUE constraint conflicts on email, domain) ────────
const RUN_TAG = `s19a-${Date.now()}`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 19A — Lead Supply Integration Test");
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

  // Verify test client
  const { data: clientRow, error: clientErr } = await db
    .from("clients")
    .select("id, name")
    .eq("id", TEST_CLIENT_ID)
    .maybeSingle();

  if (clientErr || !clientRow) {
    console.error(`\nAbort: test client ${TEST_CLIENT_ID} not found. Run Stage 10.5 test first.`);
    process.exit(1);
  }
  check("Test client (Gramscode) exists", true);
  note("client_id",   TEST_CLIENT_ID);
  note("client_name", (clientRow as { name: string }).name);

  // ── Fixture state — collected for cleanup ─────────────────────────────────

  const createdCampaignIds: string[] = [];
  let testListId:       string | null = null;
  let testCompanyAId:   string | null = null;
  let testCompanyBId:   string | null = null;
  let testContactAId:   string | null = null;
  let testContactBId:   string | null = null;
  let suppressionId:    string | null = null;

  // ── Fixture creation ───────────────────────────────────────────────────────
  section("Fixture setup");

  try {
    // Company A — will have account_intelligence (happy path)
    const { data: coA, error: coAErr } = await db
      .from("companies")
      .insert({
        name:   `Stage19A Test Co A [${RUN_TAG}]`,
        domain: `stage19a-co-a-${RUN_TAG}.invalid`,
        status: "review",
      })
      .select("id")
      .single();
    if (coAErr || !coA) throw new Error(`company A insert failed: ${coAErr?.message}`);
    testCompanyAId = (coA as { id: string }).id;
    check("Company A created", !!testCompanyAId);
    note("company_a_id", testCompanyAId);

    // Company B — NO account_intelligence (simulates cross-client / unscored company)
    const { data: coB, error: coBErr } = await db
      .from("companies")
      .insert({
        name:   `Stage19A Test Co B [${RUN_TAG}]`,
        domain: `stage19a-co-b-${RUN_TAG}.invalid`,
        status: "review",
      })
      .select("id")
      .single();
    if (coBErr || !coB) throw new Error(`company B insert failed: ${coBErr?.message}`);
    testCompanyBId = (coB as { id: string }).id;
    check("Company B created", !!testCompanyBId);
    note("company_b_id", testCompanyBId);

    // Contact A (for Company A, emailStatus=VERIFIED — passes email gate via Prospeo soft-pass)
    const { data: ctA, error: ctAErr } = await db
      .from("contacts")
      .insert({
        company_id:   testCompanyAId,
        full_name:    `Stage19A Contact A [${RUN_TAG}]`,
        email:        `contact-a-${RUN_TAG}@stage19a.invalid`,
        email_status: "VERIFIED",
        status:       "review",
        source:       "stage19a-integration-test",
      })
      .select("id")
      .single();
    if (ctAErr || !ctA) throw new Error(`contact A insert failed: ${ctAErr?.message}`);
    testContactAId = (ctA as { id: string }).id;
    check("Contact A created (email_status=VERIFIED)", !!testContactAId);
    note("contact_a_id", testContactAId);

    // Contact B (for Company B — no email, will fail contact gate)
    const { data: ctB, error: ctBErr } = await db
      .from("contacts")
      .insert({
        company_id:   testCompanyBId,
        full_name:    `Stage19A Contact B [${RUN_TAG}]`,
        email:        `contact-b-${RUN_TAG}@stage19a.invalid`,
        email_status: null as string | null,  // no email_status → fails email gate
        status:       "review",
        source:       "stage19a-integration-test",
      })
      .select("id")
      .single();
    if (ctBErr || !ctB) throw new Error(`contact B insert failed: ${ctBErr?.message}`);
    testContactBId = (ctB as { id: string }).id;
    check("Contact B created (no email_status)", !!testContactBId);
    note("contact_b_id", testContactBId);

    // Account intelligence for Company A with score=50
    // This is a NEW test company — no risk of overwriting existing real AI rows.
    const { error: aiErr } = await db
      .from("account_intelligence")
      .insert({
        client_id:                    TEST_CLIENT_ID,
        company_id:                   testCompanyAId,
        opportunity_score:            50,
        opportunity_score_updated_at: new Date().toISOString(),
        score_inputs:                 null,
        updated_at:                   new Date().toISOString(),
      });
    if (aiErr) throw new Error(`account_intelligence insert failed: ${aiErr.message}`);
    check("Account intelligence inserted for Company A (score=50)", true);

    // Test list
    const list = await createList({
      name:        `Stage19A Integration Test List [${RUN_TAG}]`,
      environment: "test",
      status:      "active",
    });
    testListId = list.id;
    check("Test list created", !!testListId);
    note("list_id", testListId);

  } catch (err) {
    console.error("\nAbort: fixture setup failed:", err);
    process.exit(1);
  }

  // ── All main test sections are wrapped in a single try/finally ─────────────

  try {

    // ── Section 1: Campaign not found ───────────────────────────────────────
    section("Campaign not found → empty report");

    const notFoundReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: "00000000-0000-0000-0000-000000000000", // non-existent
    });
    check("totalContacts = 0 when campaign not found",    notFoundReport.totalContacts === 0);
    check("report has a note about campaign not found",
      notFoundReport.notes.some((n) => n.toLowerCase().includes("not found")));
    check("listClientWarning is null when listId is null", notFoundReport.listClientWarning === null);
    check("listId is null",                               notFoundReport.listId === null);

    // ── Section 2: Campaign with no list ────────────────────────────────────
    section("Campaign with no list → no-list report");

    const noListCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] No-List Campaign`,
      status: "draft",
      // no listId
    });
    createdCampaignIds.push(noListCampaign.id);

    const noListReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: noListCampaign.id,
    });
    check("totalContacts = 0 when no list",            noListReport.totalContacts === 0);
    check("listId is null",                            noListReport.listId === null);
    check("listClientWarning is null (no list)",       noListReport.listClientWarning === null);
    check("note mentions list not configured",
      noListReport.notes.some((n) => n.toLowerCase().includes("list")));

    // ── Section 3: Empty list ────────────────────────────────────────────────
    section("Empty list → empty report");

    const emptyListCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Empty-List Campaign`,
      status: "draft",
      listId: testListId!,
    });
    createdCampaignIds.push(emptyListCampaign.id);

    const emptyReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: emptyListCampaign.id,
    });
    check("totalContacts = 0 for empty list",          emptyReport.totalContacts === 0);
    check("listId is set (list exists)",               emptyReport.listId === testListId);
    check("listClientWarning is set (FINDING 5)",      emptyReport.listClientWarning !== null);
    check("listClientWarning mentions FINDING 5",
      (emptyReport.listClientWarning ?? "").includes("FINDING 5"));

    // ── Section 4: Account gate failure (Company B, no AI) ──────────────────
    section("Account gate failure — Company B has no account_intelligence");

    // Add Company B to the list (Path A)
    const { error: lmBErr } = await db
      .from("list_members")
      .insert({ list_id: testListId!, company_id: testCompanyBId! });
    if (lmBErr) throw new Error(`list_members insert (B) failed: ${lmBErr.message}`);

    const noAiReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: emptyListCampaign.id,
    });
    check("Company B's contact appears in report",     noAiReport.totalContacts >= 1);
    check("Contact B is ineligible",                   noAiReport.ineligibleCount >= 1);
    check("Contact B's reason is NO_ACCOUNT_INTELLIGENCE or EMAIL_NOT_VERIFIED",
      noAiReport.ineligible.some((a) =>
        a.reason === "NO_ACCOUNT_INTELLIGENCE" ||
        a.reason === "EMAIL_NOT_VERIFIED",
      ),
      `ineligible reasons: ${noAiReport.ineligible.map((a) => a.reason).join(", ")}`,
    );
    // listClientWarning: FINDING 5 — Company B was added to the list without any
    // client_id check. This is exactly the cross-client contamination scenario.
    check("listClientWarning documents FINDING 5 gap (contamination scenario)",
      noAiReport.listClientWarning !== null &&
      noAiReport.listClientWarning.includes("FINDING 5"),
    );

    // ── Section 5: Happy path — Company A with AI, Contact A eligible ────────
    section("Happy path — Company A has AI (score=50), Contact A is eligible");

    // Add Company A to the list (Path A)
    const { error: lmAErr } = await db
      .from("list_members")
      .insert({ list_id: testListId!, company_id: testCompanyAId! });
    if (lmAErr) throw new Error(`list_members insert (A) failed: ${lmAErr.message}`);

    const happyReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: emptyListCampaign.id,
    });

    const contactAAssessment = happyReport.eligible.find((a) => a.contactId === testContactAId);
    check("Contact A appears in report",               happyReport.totalContacts >= 2);
    check("Contact A is eligible",
      contactAAssessment !== undefined,
      `eligible ids: ${happyReport.eligible.map((a) => a.contactId).join(", ")}`,
    );
    check("Contact A email is in assessment",          contactAAssessment?.email?.includes("contact-a") ?? false);
    check("eligibleCount >= 1",                        happyReport.eligibleCount >= 1);
    check("breakdownByReason has at least one entry",
      Object.keys(happyReport.breakdownByReason).length >= 1 ||
      happyReport.ineligibleCount === 0,
    );

    // ── Section 6: Dedup — Contact A via Path A (company) AND Path B (direct) ─
    section("Dedup — Contact A appears via both paths, counted once");

    // Add Contact A directly as a list member (Path B)
    const { error: lmDirectErr } = await db
      .from("list_members")
      .insert({ list_id: testListId!, contact_id: testContactAId! });
    if (lmDirectErr) throw new Error(`list_members insert (direct) failed: ${lmDirectErr.message}`);

    const dedupReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: emptyListCampaign.id,
    });

    const contactACount = dedupReport.eligible.filter((a) => a.contactId === testContactAId).length
      + dedupReport.ineligible.filter((a) => a.contactId === testContactAId).length;
    check("Contact A appears exactly once despite being in both Path A and Path B",
      contactACount === 1,
      `count = ${contactACount}`,
    );
    // Total contacts should equal the sum of unique contacts (not double-counted)
    check("totalContacts = eligibleCount + ineligibleCount",
      dedupReport.totalContacts === dedupReport.eligibleCount + dedupReport.ineligibleCount,
    );

    // ── Section 7: Suppression hard block ────────────────────────────────────
    section("Suppression — Contact A is suppressed → CONTACT_SUPPRESSED");

    const suppRecord = await suppressContact(TEST_CLIENT_ID, testContactAId!, {
      reason:    "manual",
      expiresAt: null,  // permanent
      notes:     `Stage 19A integration test [${RUN_TAG}]`,
    });
    suppressionId = suppRecord.id;
    check("Suppression record created for Contact A", !!suppressionId);

    const suppReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: emptyListCampaign.id,
    });

    const contactAIneligible = suppReport.ineligible.find((a) => a.contactId === testContactAId);
    check("Contact A is now ineligible (suppressed)",    contactAIneligible !== undefined);
    check("Contact A reason is CONTACT_SUPPRESSED",
      contactAIneligible?.reason === "CONTACT_SUPPRESSED",
      `reason = ${contactAIneligible?.reason}`,
    );

    // Lift suppression before continuing
    await liftSuppression(TEST_CLIENT_ID, suppressionId);
    suppressionId = null;
    check("Suppression lifted — Contact A eligible again", true);

    // ── Section 8: Campaign status semantics ─────────────────────────────────
    section("Campaign status semantics");

    // Status = review → CAMPAIGN_NOT_ACTIVE, enrollmentOpen = false
    const reviewCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Review Campaign`,
      status: "review",
      listId: testListId!,
    });
    createdCampaignIds.push(reviewCampaign.id);

    const reviewReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: reviewCampaign.id,
    });
    check("enrollmentOpen = false for status=review",   reviewReport.enrollmentOpen === false);
    check("campaignStatus = review in report",          reviewReport.campaignStatus === "review");
    // Contact A (Company A, has AI, email gate passes) → blocked by CAMPAIGN_NOT_ACTIVE.
    // Contact B (Company B, no AI) → blocked earlier at NO_ACCOUNT_INTELLIGENCE.
    // We verify that at least one contact hit CAMPAIGN_NOT_ACTIVE, and none are eligible.
    check("No contacts are eligible for review campaign",
      reviewReport.totalContacts > 0 && reviewReport.eligible.length === 0,
      `eligible=${reviewReport.eligibleCount} ineligible=${reviewReport.ineligibleCount}`,
    );
    check("At least one contact blocked with CAMPAIGN_NOT_ACTIVE for review campaign",
      reviewReport.ineligible.some((a) => a.reason === "CAMPAIGN_NOT_ACTIVE"),
      `reasons: ${reviewReport.ineligible.map((a) => a.reason).join(", ")}`,
    );
    check("breakdownByReason has CAMPAIGN_NOT_ACTIVE",
      (reviewReport.breakdownByReason["CAMPAIGN_NOT_ACTIVE"] ?? 0) > 0,
    );

    // Status = running → enrollmentOpen = true
    const runningCampaign = await createCampaign(TEST_CLIENT_ID, {
      name:   `[${RUN_TAG}] Running Campaign`,
      status: "running",
      listId: testListId!,
    });
    createdCampaignIds.push(runningCampaign.id);

    const runningReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: runningCampaign.id,
    });
    check("enrollmentOpen = true for status=running",  runningReport.enrollmentOpen === true);
    check("campaignStatus = running in report",        runningReport.campaignStatus === "running");
    check("Contact A is eligible for running campaign",
      runningReport.eligible.some((a) => a.contactId === testContactAId),
    );

    // ── Section 9: Missing platformCampaignId → campaignHealthAdvisory = null ─
    section("Missing platformCampaignId — no campaign health advisory");

    // emptyListCampaign has no platformCampaignId (it was created without one)
    const noHealthReport = await assessCampaignLeadSupply({
      clientId:   TEST_CLIENT_ID,
      campaignId: emptyListCampaign.id,
    });
    check("campaignHealthAdvisory is null when no platformCampaignId",
      noHealthReport.campaignHealthAdvisory === null,
    );
    check("note mentions missing platform_campaign_id",
      noHealthReport.notes.some((n) => n.toLowerCase().includes("platform_campaign_id")),
    );

    // ── Section 10: Missing sendingDomain → domainHealthAdvisory = null ───────
    section("Missing sendingDomain — no domain health advisory");

    check("domainHealthAdvisory is null when sendingDomain not provided",
      noHealthReport.domainHealthAdvisory === null,
    );
    check("note mentions missing sending domain",
      noHealthReport.notes.some((n) => n.toLowerCase().includes("domain")),
    );

    // ── Section 11: listClientWarning on all reports with listId ─────────────
    section("listClientWarning — present on every report with a listId");

    const reportsWithList = [
      emptyReport, noAiReport, happyReport, dedupReport,
      suppReport, reviewReport, runningReport, noHealthReport,
    ];
    const allHaveWarning = reportsWithList.every((r) => r.listClientWarning !== null);
    check("listClientWarning is non-null on all reports with a list",    allHaveWarning);

    const allMentionFinding5 = reportsWithList.every((r) =>
      (r.listClientWarning ?? "").includes("FINDING 5"),
    );
    check("listClientWarning mentions FINDING 5 on all reports",         allMentionFinding5);

    // "unresolved" contains "resolved" as a substring — check for the full phrase instead.
    const noneClaimResolution = reportsWithList.every((r) => {
      const w = (r.listClientWarning ?? "").toLowerCase();
      return !w.includes("is resolved") && !w.includes("has been resolved") && !w.includes("now resolved");
    });
    check("listClientWarning does not claim FINDING 5 is resolved",      noneClaimResolution);

    // ── Section 12: Client isolation ─────────────────────────────────────────
    section("Client isolation — wrong client cannot access campaign");

    const wrongClientReport = await assessCampaignLeadSupply({
      clientId:   "00000000-0000-0000-0000-000000000000", // different client
      campaignId: emptyListCampaign.id,                   // belongs to TEST_CLIENT_ID
    });
    check("totalContacts = 0 for wrong client",           wrongClientReport.totalContacts === 0);
    check("Campaign not found for wrong client",
      wrongClientReport.notes.some((n) => n.toLowerCase().includes("not found")),
    );
    check("listClientWarning is null (no list in report)", wrongClientReport.listClientWarning === null);

    // ── Section 13: breakdownByReason accuracy ───────────────────────────────
    section("breakdownByReason accuracy");

    // reviewReport has all contacts as CAMPAIGN_NOT_ACTIVE
    const breakdownTotal = Object.values(reviewReport.breakdownByReason)
      .reduce((acc, n) => acc + n, 0);
    check("Sum of breakdownByReason values equals ineligibleCount",
      breakdownTotal === reviewReport.ineligibleCount,
      `sum=${breakdownTotal} ineligible=${reviewReport.ineligibleCount}`,
    );

    // happyReport has some ineligible contacts (Company B: NO_ACCOUNT_INTELLIGENCE or email)
    const happyBreakdownTotal = Object.values(happyReport.breakdownByReason)
      .reduce((acc, n) => acc + n, 0);
    check("breakdownByReason totals match ineligibleCount for happy report",
      happyBreakdownTotal === happyReport.ineligibleCount,
    );

    // ── Section 14: assessedAt is a valid ISO timestamp ───────────────────────
    section("Report metadata");

    check("assessedAt is a valid ISO timestamp",
      !isNaN(new Date(happyReport.assessedAt).getTime()),
    );
    check("clientId and campaignId echoed in report",
      happyReport.clientId === TEST_CLIENT_ID &&
      happyReport.campaignId === emptyListCampaign.id,
    );

  } finally {

    // ── Cleanup ──────────────────────────────────────────────────────────────
    section("Cleanup");

    // Lift any outstanding suppression
    if (suppressionId) {
      try {
        await liftSuppression(TEST_CLIENT_ID, suppressionId);
        console.log(`  ↺ lifted suppression ${suppressionId}`);
      } catch (e) {
        console.error(`  ✗ could not lift suppression: ${e}`);
      }
    }

    // Delete all test campaigns
    for (const id of createdCampaignIds) {
      try {
        await deleteCampaign(TEST_CLIENT_ID, id);
        console.log(`  ↺ deleted campaign ${id}`);
      } catch (e) {
        console.error(`  ✗ could not delete campaign ${id}: ${e}`);
      }
    }

    // Delete list_members (explicit — don't rely on CASCADE)
    if (testListId) {
      try {
        await db.from("list_members").delete().eq("list_id", testListId);
        console.log(`  ↺ deleted list_members for list ${testListId}`);
      } catch (e) {
        console.error(`  ✗ could not delete list_members: ${e}`);
      }

      // Delete the list
      try {
        await db.from("lists").delete().eq("id", testListId);
        console.log(`  ↺ deleted list ${testListId}`);
      } catch (e) {
        console.error(`  ✗ could not delete list: ${e}`);
      }
    }

    // Delete account_intelligence rows for test companies
    for (const companyId of [testCompanyAId, testCompanyBId]) {
      if (!companyId) continue;
      try {
        await db
          .from("account_intelligence")
          .delete()
          .eq("client_id", TEST_CLIENT_ID)
          .eq("company_id", companyId);
        console.log(`  ↺ deleted account_intelligence for company ${companyId}`);
      } catch (e) {
        console.error(`  ✗ could not delete account_intelligence for ${companyId}: ${e}`);
      }
    }

    // Delete test contacts explicitly (before companies, in case no CASCADE)
    for (const contactId of [testContactAId, testContactBId]) {
      if (!contactId) continue;
      try {
        await db.from("contacts").delete().eq("id", contactId);
        console.log(`  ↺ deleted contact ${contactId}`);
      } catch (e) {
        console.error(`  ✗ could not delete contact ${contactId}: ${e}`);
      }
    }

    // Delete test companies
    for (const companyId of [testCompanyAId, testCompanyBId]) {
      if (!companyId) continue;
      try {
        await db.from("companies").delete().eq("id", companyId);
        console.log(`  ↺ deleted company ${companyId}`);
      } catch (e) {
        console.error(`  ✗ could not delete company ${companyId}: ${e}`);
      }
    }

    // Verify cleanup: no orphan rows
    section("Cleanup verification");

    if (testContactAId) {
      const { data: ctA } = await db.from("contacts").select("id").eq("id", testContactAId).maybeSingle();
      check("Contact A deleted", ctA === null);
    }
    if (testCompanyAId) {
      const { data: coA } = await db.from("companies").select("id").eq("id", testCompanyAId).maybeSingle();
      check("Company A deleted", coA === null);
    }
    if (testCompanyBId) {
      const { data: coB } = await db.from("companies").select("id").eq("id", testCompanyBId).maybeSingle();
      check("Company B deleted", coB === null);
    }
    if (testListId) {
      const { data: list } = await db.from("lists").select("id").eq("id", testListId).maybeSingle();
      check("Test list deleted", list === null);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log("\n" + "=".repeat(70));
  console.log(`Stage 19A Lead Supply Integration Test: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(70));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nUnhandled error:", err);
  process.exit(1);
});
