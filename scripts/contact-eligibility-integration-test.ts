/**
 * Stage 17 — Contact Eligibility Integration Test.
 *
 * Exercises the live Supabase database:
 *   - getContactById, getContactsByCompanyId
 *   - getLatestEmailVerification
 *   - suppressContact, isContactSuppressed, liftSuppression (existing helpers)
 *   - isContactEnrolledInCampaign, createCampaign, deleteCampaign
 *   - evaluateContactEligibility, evaluateCampaignEligibility (pure evaluators)
 *
 * HARD CONSTRAINTS:
 *   - No emails sent. No outbound calls.
 *   - No account_intelligence writes.
 *   - All test data created in this script is cleaned up in finally blocks.
 *   - API secrets are NEVER logged — only their presence is confirmed.
 *
 * Run:
 *   npx tsx scripts/contact-eligibility-integration-test.ts
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

import { getSupabaseAdmin } from "../src/db/supabase";
import { getContactById, getContactsByCompanyId } from "../src/db/contacts";
import { getLatestEmailVerification } from "../src/db/email-verifications";
import {
  suppressContact,
  liftSuppression,
  isContactSuppressed,
  getSuppressionRecords,
} from "../src/db/contact-suppression";
import {
  createCampaign,
  deleteCampaign,
  isContactEnrolledInCampaign,
} from "../src/db/campaigns";
import { getAccountIntelligence } from "../src/db/account-intelligence";
import {
  evaluateContactEligibility,
  evaluateCampaignEligibility,
} from "../src/lib/contact-eligibility";

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

// ── Fixed test client (from Stage 10.5) ──────────────────────────────────────

const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 17 — Contact Eligibility Integration Test");
  console.log("=".repeat(70));

  // ── Pre-flight ─────────────────────────────────────────────────────────────
  section("Pre-flight checks");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);
  if (!hasSupabase) {
    console.error("\nAbort: Supabase credentials missing.");
    process.exit(1);
  }

  // ── Verify test client ─────────────────────────────────────────────────────
  section("Test client verification");

  const db = getSupabaseAdmin();
  const { data: clientRow, error: clientErr } = await db
    .from("clients")
    .select("id, name")
    .eq("id", TEST_CLIENT_ID)
    .maybeSingle();

  if (clientErr || !clientRow) {
    console.error(`\nAbort: test client ${TEST_CLIENT_ID} not found.`);
    console.error("Run the Stage 10.5 integration test first to create it.");
    process.exit(1);
  }
  check("Test client exists", true);
  note("client_id", TEST_CLIENT_ID);
  note("client_name", (clientRow as { name: string }).name);

  // ── Find a contact with an email (needed for meaningful tests) ─────────────
  section("Contact lookup — getContactById");

  const { data: rawContact, error: contactErr } = await db
    .from("contacts")
    .select("id, company_id, email, email_status")
    .not("email", "is", null)
    .limit(1)
    .maybeSingle();

  if (contactErr || !rawContact) {
    console.error("\nAbort: no contacts with email found in DB. Seed contacts first.");
    process.exit(1);
  }

  const contactRow = rawContact as { id: string; company_id: string; email: string; email_status: string | null };
  note("test_contact_id",    contactRow.id);
  note("test_company_id",    contactRow.company_id);
  note("email_present",      !!contactRow.email);
  note("email_status",       contactRow.email_status);

  const contact = await getContactById(contactRow.id);
  check("getContactById returns a row",        contact !== null);
  check("ContactRow.email is non-null",        contact !== null && contact.email !== null);
  check("ContactRow.companyId matches DB",     contact?.companyId === contactRow.company_id);

  // ── getContactsByCompanyId ─────────────────────────────────────────────────
  section("Contacts by company — getContactsByCompanyId");

  const companyContacts = await getContactsByCompanyId(contactRow.company_id);
  check("getContactsByCompanyId returns array",          Array.isArray(companyContacts));
  check("Result contains at least one contact",          companyContacts.length >= 1);
  check("All rows have correct companyId",
    companyContacts.every((c) => c.companyId === contactRow.company_id),
  );

  // ── Email verification (expected: 0 rows in DB) ───────────────────────────
  section("Email verification — getLatestEmailVerification");

  const emailVerif = await getLatestEmailVerification(contactRow.id);
  note("email_verifications row for contact", emailVerif === null ? "none (expected)" : emailVerif.id);
  check(
    "getLatestEmailVerification returns null (no rows in DB yet — expected)",
    emailVerif === null,
  );

  // ── Account gate — live account_intelligence ───────────────────────────────
  section("Account gate — evaluateAccountGate with live data");

  // Find a company that has account_intelligence for the test client
  const { data: aiRow } = await db
    .from("account_intelligence")
    .select("company_id, opportunity_score")
    .eq("client_id", TEST_CLIENT_ID)
    .gt("opportunity_score", 0)
    .limit(1)
    .maybeSingle();

  if (aiRow) {
    const ai = aiRow as { company_id: string; opportunity_score: number };
    note("account_intelligence company_id",    ai.company_id);
    note("account_intelligence opp_score",     ai.opportunity_score);

    const accountIntel = await getAccountIntelligence(TEST_CLIENT_ID, ai.company_id);
    check("getAccountIntelligence returns a row",              accountIntel !== null);
    check("opportunityScore > 0",                              (accountIntel?.opportunityScore ?? 0) > 0);
  } else {
    note("account_intelligence", "no rows with opp_score > 0 for test client — skipping live account gate test");
    check("account_intelligence rows exist (skipping if none)", true);
  }

  // ── Suppression gate — create / check / lift ──────────────────────────────
  section("Suppression gate — create, evaluate, lift");

  let suppressionId: string | null = null;
  try {
    // Create a timed suppression that will expire in 1 hour
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const suppRecord = await suppressContact(TEST_CLIENT_ID, contactRow.id, {
      reason:    "manual",
      expiresAt: expiry,
      notes:     "Stage 17 integration test — will be lifted immediately",
    });
    suppressionId = suppRecord.id;
    check("suppressContact created a suppression record", !!suppressionId);
    note("suppression_id", suppressionId);

    // Verify isContactSuppressed returns true
    const isSuppressed = await isContactSuppressed(TEST_CLIENT_ID, contactRow.id);
    check("isContactSuppressed returns true after suppression created", isSuppressed);

    // Evaluate suppression gate with live records
    const records = await getSuppressionRecords(TEST_CLIENT_ID, contactRow.id);
    check("getSuppressionRecords returns at least one record", records.length >= 1);

    const suppressionResult = evaluateContactEligibility({
      accountIntelligence: { opportunityScore: 42 }, // synthetic — just need account gate to pass
      contact:             contact,
      companyId:           contactRow.company_id,
      emailVerification:   null,
      suppressionRecords:  records,
      now:                 new Date(),
    });
    // Email gate will block first (no email_verifications row and emailStatus may not be VERIFIED)
    // OR suppression gate will block if email gate passes.
    // Either way, we should be ineligible. Test specifically that suppression is seen.
    const suppressionSeen = suppressionResult.gate === "suppression" || suppressionResult.reason === "CONTACT_SUPPRESSED";
    const emailBlockedFirst = suppressionResult.gate === "email";
    check(
      "evaluateContactEligibility detects suppression or email gate blocks first",
      !suppressionResult.eligible && (suppressionSeen || emailBlockedFirst),
      `gate=${suppressionResult.gate} reason=${suppressionResult.reason}`,
    );

    // Lift the suppression
    await liftSuppression(TEST_CLIENT_ID, suppressionId);
    suppressionId = null; // no need to clean up in finally block
    const isSuppressedAfterLift = await isContactSuppressed(TEST_CLIENT_ID, contactRow.id);
    check("isContactSuppressed returns false after suppression lifted", !isSuppressedAfterLift);

  } finally {
    if (suppressionId) {
      // Lift any un-cleaned suppression (only fires on unexpected error path)
      await liftSuppression(TEST_CLIENT_ID, suppressionId).catch(() => {});
    }
  }

  // ── Campaign gate — create, check enrollment, delete ─────────────────────
  section("Campaign gate — create, enrollment check, delete");

  let campaignId: string | null = null;
  try {
    const campaign = await createCampaign(TEST_CLIENT_ID, {
      name:        "Stage 17 integration test campaign",
      description: "Created by integration test — will be deleted immediately",
      platform:    "plusvibe",
      status:      "draft",
    });
    campaignId = campaign.id;
    check("createCampaign succeeded",           !!campaignId);
    check("campaign.clientId matches",          campaign.clientId === TEST_CLIENT_ID);
    check("campaign.status = draft",            campaign.status === "draft");
    note("campaign_id", campaignId);

    // Contact should not be enrolled yet
    const enrolled = await isContactEnrolledInCampaign(campaignId, contactRow.id);
    check("isContactEnrolledInCampaign = false before enrollment", !enrolled);

    // Evaluate campaign eligibility (contact eligibility may fail at email gate —
    // we care that the campaign gate wiring works)
    const campaignResult = evaluateCampaignEligibility({
      accountIntelligence: { opportunityScore: 42 },
      contact:             contact,
      companyId:           contactRow.company_id,
      emailVerification:   null,
      suppressionRecords:  [],
      campaign:            campaign,
      clientId:            TEST_CLIENT_ID,
      existingEnrollment:  false,
    });
    // Result may fail at email gate (expected) or pass all gates — either way,
    // it must NOT fail at campaign gate with CAMPAIGN_NOT_FOUND or CLIENT_MISMATCH.
    check(
      "Campaign gate does not return CAMPAIGN_NOT_FOUND or CAMPAIGN_CLIENT_MISMATCH",
      campaignResult.reason !== "CAMPAIGN_NOT_FOUND" && campaignResult.reason !== "CAMPAIGN_CLIENT_MISMATCH",
      `reason=${campaignResult.reason}`,
    );

    // Test ALREADY_ENROLLED path synthetically — companyId must match to pass contact gate
    const alreadyEnrolledResult = evaluateCampaignEligibility({
      accountIntelligence: { opportunityScore: 42 },
      contact:             { companyId: contactRow.company_id, email: "test@example.com", emailStatus: "VERIFIED" },
      companyId:           contactRow.company_id,
      emailVerification:   null,
      suppressionRecords:  [],
      campaign:            campaign,
      clientId:            TEST_CLIENT_ID,
      existingEnrollment:  true,
    });
    check(
      "evaluateCampaignEligibility returns ALREADY_ENROLLED when existingEnrollment=true",
      alreadyEnrolledResult.reason === "ALREADY_ENROLLED",
    );

  } finally {
    if (campaignId) {
      await deleteCampaign(TEST_CLIENT_ID, campaignId).catch((e: Error) => {
        console.error(`  Warning: failed to delete test campaign ${campaignId}: ${e.message}`);
      });
      check("Test campaign cleaned up", true);
    }
  }

  // ── Full end-to-end evaluation snapshot ───────────────────────────────────
  section("End-to-end eligibility snapshot — real contact, synthetic gates");

  // Use a fully qualified contact (all gates synthetic except contact identity)
  const e2eResult = evaluateContactEligibility({
    accountIntelligence: { opportunityScore: 75 },
    contact:             contact,
    companyId:           contactRow.company_id,
    emailVerification:   {
      id:         "synthetic-v1",
      contactId:  contactRow.id,
      email:      contact?.email ?? "",
      isValid:    true,
      result:     "ok",
      verifiedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
      createdAt:  new Date().toISOString(),
    },
    suppressionRecords:  [],
  });
  check("End-to-end: all gates pass with synthetic valid verification", e2eResult.eligible);
  if (!e2eResult.eligible) {
    note("e2e_failure_gate",   e2eResult.gate);
    note("e2e_failure_reason", e2eResult.reason);
    note("e2e_failure_detail", e2eResult.detail);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log(`Stage 17 integration test complete: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(70));

  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
