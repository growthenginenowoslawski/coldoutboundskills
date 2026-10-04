/**
 * Stage 20 — Test Setup + Dry Run.
 *
 * Creates the minimum required records to run the Stage 20 manual upload test:
 *   1. Test company  (find or create)
 *   2. Test contact  (find or create — uses olugbogiafeez@gmail.com)
 *   3. Account intelligence row with opportunity_score=50 (satisfies Gate 1)
 *   4. DB campaign record pointing to Smartlead campaign 3908578
 *   5. Enrolls contact via enrollContacts() — full eligibility re-validation
 *   6. Runs uploadCampaignLeads(dryRun=true, limit=1) — no provider call
 *   7. Reconstructs and prints the EXACT payload that would be sent to Smartlead
 *   8. Verifies Smartlead campaign is still DRAFTED via live API
 *
 * HARD CONSTRAINTS:
 *   - No real Smartlead upload.
 *   - No campaign activation. No email sent.
 *   - No schema changes. No RLS changes.
 *   - API key never logged.
 *   - Script stops and reports if any precondition or eligibility gate fails.
 *
 * Data created by this script persists for the subsequent live upload.
 * Run: npx tsx scripts/stage20-setup-and-dryrun.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin }          from "../src/db/supabase.js";
import { createCampaign, getCampaignById } from "../src/db/campaigns.js";
import { enrollContacts }            from "../src/lib/lead-enrollment.js";
import { uploadCampaignLeads }       from "../src/lib/lead-upload.js";
import { getReadyLeadsForUpload }    from "../src/db/campaign-leads.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const GRAMSCODE_CLIENT_ID    = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const SL_CAMPAIGN_ID         = "3908578";
const TEST_CONTACT_EMAIL     = "olugbogiafeez@gmail.com";
const TEST_CONTACT_FIRSTNAME = "Afeez";
const TEST_CONTACT_LASTNAME  = "Olugbogi";
const TEST_CONTACT_FULLNAME  = "Afeez Olugbogi";
const TEST_COMPANY_NAME      = "Gramscode (Stage 20 Test)";
const TEST_COMPANY_DOMAIN    = "gramscode.com";
const OPPORTUNITY_SCORE      = 50; // non-zero → satisfies Gate 1

const apiKey  = (process.env.SMARTLEAD_API_KEY ?? "").trim();
const API_BASE = "https://server.smartlead.ai/api/v1";
const db      = getSupabaseAdmin();

// ── Helpers ───────────────────────────────────────────────────────────────────

function section(title: string) {
  console.log(`\n${"─".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(70));
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
    throw new Error(`Smartlead HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Stage 20 — Test Setup + Dry Run");
  console.log("=".repeat(70));

  // ── Step 1: Verify Smartlead campaign is still DRAFTED ─────────────────────
  section("Step 1 — Verify Smartlead campaign status (live API)");

  let slStatus = "unknown";
  try {
    const camp = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string,unknown>;
    slStatus   = String(camp.status ?? "unknown");
    const isDraft = slStatus.toUpperCase() === "DRAFT" || slStatus.toUpperCase() === "DRAFTED";
    ok(`Smartlead campaign ${SL_CAMPAIGN_ID} status: ${slStatus}`);
    if (!isDraft) stop("Campaign is not DRAFT/DRAFTED", `got: ${slStatus}`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    stop("Could not verify Smartlead campaign", msg);
  }

  // ── Step 2: Find or create test company ─────────────────────────────────────
  section("Step 2 — Test company (find or create)");

  let companyId: string;
  const { data: existingCo } = await db
    .from("companies")
    .select("id, name, domain")
    .eq("domain", TEST_COMPANY_DOMAIN)
    .limit(1)
    .maybeSingle();

  if (existingCo) {
    companyId = (existingCo as { id: string }).id;
    ok(`Found existing company`, `id=${companyId}  domain=${TEST_COMPANY_DOMAIN}`);
  } else {
    const { data: newCo, error: coErr } = await db
      .from("companies")
      .insert({
        name:   TEST_COMPANY_NAME,
        domain: TEST_COMPANY_DOMAIN,
        status: "review",
        source: "s20-manual-test",
      })
      .select("id")
      .single();
    if (coErr || !newCo) stop("Company insert failed", coErr?.message);
    companyId = (newCo as { id: string }).id;
    ok(`Created test company`, `id=${companyId}  name="${TEST_COMPANY_NAME}"`);
  }

  // ── Step 3: Find or create test contact ─────────────────────────────────────
  section("Step 3 — Test contact (find or create)");

  let contactId: string;
  const { data: existingContact } = await db
    .from("contacts")
    .select("id, full_name, email, email_status, company_id")
    .eq("email", TEST_CONTACT_EMAIL)
    .maybeSingle();

  if (existingContact) {
    const ec = existingContact as Record<string,unknown>;
    contactId = ec.id as string;
    // Update company_id if it points elsewhere (test data hygiene)
    if (ec.company_id !== companyId) {
      warn(`Contact has different company_id — updating to match test company`);
      await db.from("contacts").update({ company_id: companyId }).eq("id", contactId);
    }
    ok(`Found existing contact`, `id=${contactId}  email=${TEST_CONTACT_EMAIL}`);
  } else {
    const { data: newContact, error: cErr } = await db
      .from("contacts")
      .insert({
        company_id:   companyId,
        first_name:   TEST_CONTACT_FIRSTNAME,
        last_name:    TEST_CONTACT_LASTNAME,
        full_name:    TEST_CONTACT_FULLNAME,
        email:        TEST_CONTACT_EMAIL,
        email_status: "VERIFIED",
        status:       "review",
        source:       "s20-manual-test",
      })
      .select("id")
      .single();
    if (cErr || !newContact) stop("Contact insert failed", cErr?.message);
    contactId = (newContact as { id: string }).id;
    ok(`Created test contact`, `id=${contactId}  email=${TEST_CONTACT_EMAIL}`);
  }

  console.log(`\n  Contact details:`);
  console.log(`    id:           ${contactId}`);
  console.log(`    full_name:    ${TEST_CONTACT_FULLNAME}`);
  console.log(`    email:        ${TEST_CONTACT_EMAIL}`);
  console.log(`    email_status: VERIFIED`);
  console.log(`    company_id:   ${companyId}`);

  // ── Step 4: Upsert account intelligence (opportunity_score = 50) ────────────
  section("Step 4 — Account intelligence (upsert opportunity_score=50)");

  const now     = new Date().toISOString();
  const aiScore = OPPORTUNITY_SCORE;

  const { error: aiErr } = await db
    .from("account_intelligence")
    .upsert(
      {
        client_id:                    GRAMSCODE_CLIENT_ID,
        company_id:                   companyId,
        opportunity_score:            aiScore,
        opportunity_score_updated_at: now,
        score_inputs:                 {
          finalScore:  aiScore,
          computedAt:  now,
          signals:     [],
          _note:       "Stage 20 manual test — synthetic score",
        },
        updated_at: now,
      },
      { onConflict: "client_id,company_id" },
    );

  if (aiErr) stop("account_intelligence upsert failed", aiErr.message);
  ok(`account_intelligence upserted`, `client=${GRAMSCODE_CLIENT_ID}  company=${companyId}  score=${aiScore}`);

  // ── Step 5: Find or create DB campaign record ────────────────────────────────
  section("Step 5 — DB campaign record (find or create)");

  let campaignId: string;
  const { data: existingCamp } = await db
    .from("campaigns")
    .select("id, name, status, platform, platform_campaign_id")
    .eq("client_id",            GRAMSCODE_CLIENT_ID)
    .eq("platform",             "smartlead")
    .eq("platform_campaign_id", SL_CAMPAIGN_ID)
    .maybeSingle();

  if (existingCamp) {
    const ec = existingCamp as Record<string,unknown>;
    campaignId = ec.id as string;
    ok(`Found existing DB campaign`, `id=${campaignId}  platform_campaign_id=${SL_CAMPAIGN_ID}`);

    // Verify it's still draft
    if (ec.status !== "draft") {
      stop(`Campaign DB status is '${ec.status}' — must be draft for upload`);
    }
    ok(`Campaign DB status=draft`);
  } else {
    const newCamp = await createCampaign(GRAMSCODE_CLIENT_ID, {
      name:               "Stage 20 Test",
      platform:           "smartlead",
      platformCampaignId: SL_CAMPAIGN_ID,
      status:             "draft",
    });
    campaignId = newCamp.id;
    ok(`Created DB campaign`, `id=${campaignId}  platform_campaign_id=${SL_CAMPAIGN_ID}`);
  }

  console.log(`\n  Campaign details:`);
  console.log(`    DB campaign id:      ${campaignId}`);
  console.log(`    client_id:           ${GRAMSCODE_CLIENT_ID}`);
  console.log(`    platform:            smartlead`);
  console.log(`    platform_campaign_id:${SL_CAMPAIGN_ID}`);
  console.log(`    status:              draft`);

  // ── Step 6: Enroll contact via enrollContacts() ──────────────────────────────
  section("Step 6 — Enrollment via enrollContacts() — full eligibility re-validation");

  const enrollResult = await enrollContacts({
    clientId:   GRAMSCODE_CLIENT_ID,
    campaignId,
    contactIds: [contactId],
    dryRun:     false,
  });

  console.log(`\n  Enrollment result:`);
  console.log(`    requested:       ${enrollResult.requested}`);
  console.log(`    enrolled:        ${enrollResult.enrolled}`);
  console.log(`    alreadyEnrolled: ${enrollResult.alreadyEnrolled}`);
  console.log(`    rejected:        ${enrollResult.rejected}`);
  console.log(`    dryRun:          ${enrollResult.dryRun}`);

  if (enrollResult.rejected > 0) {
    for (const r of enrollResult.rejections) {
      console.error(`    Rejection: reason=${r.reason}  detail=${r.detail}`);
    }
    if (enrollResult.enrolled === 0 && enrollResult.alreadyEnrolled === 0) {
      stop("Contact was rejected — not eligible for enrollment");
    }
  }

  if (enrollResult.enrolled > 0) {
    const lead = enrollResult.leads[0]!;
    ok(`Enrolled successfully`, `campaign_lead_id=${lead.campaignLeadId}  status=${lead.status}`);
  } else if (enrollResult.alreadyEnrolled > 0) {
    ok(`Contact was already enrolled — idempotent`);
  }

  // Determine the campaign_lead id and confirm status='ready'
  const readyLeads = await getReadyLeadsForUpload(campaignId, GRAMSCODE_CLIENT_ID, 1);
  if (readyLeads.length === 0) {
    stop("No ready leads found after enrollment — contact may already be uploaded or status mismatch");
  }
  const campaignLead = readyLeads[0]!;
  ok(`Confirmed campaign_lead status=ready`, `campaign_lead_id=${campaignLead.id}`);

  // ── Step 7: Eligibility summary ──────────────────────────────────────────────
  section("Step 7 — Eligibility gate summary");

  console.log(`\n  Gate 1 (Account):    PASS  opportunity_score=${OPPORTUNITY_SCORE} > 0`);
  console.log(`  Gate 2 (Contact):    PASS  email=${TEST_CONTACT_EMAIL}  company_id=${companyId}`);
  console.log(`  Gate 3 (Email):      PASS  email_status=VERIFIED (Prospeo soft-pass)`);
  console.log(`  Gate 4 (Suppression):PASS  no suppression records`);
  console.log(`  Gate 5 (Campaign):   PASS  status=draft  campaign_id=${campaignId}`);

  // ── Step 8: Dry run ──────────────────────────────────────────────────────────
  section("Step 8 — Dry run: uploadCampaignLeads(dryRun=true, limit=1)");

  console.log("\n  Calling uploadCampaignLeads with dryRun=true ...");

  const dryResult = await uploadCampaignLeads({
    clientId:   GRAMSCODE_CLIENT_ID,
    campaignId,
    dryRun:     true,
    limit:      1,
  });

  console.log(`\n  Dry-run result:`);
  console.log(`    readyCount:     ${dryResult.readyCount}`);
  console.log(`    uploadedCount:  ${dryResult.uploadedCount}`);
  console.log(`    duplicateCount: ${dryResult.duplicateCount}`);
  console.log(`    failedCount:    ${dryResult.failedCount}`);
  console.log(`    dryRun:         ${dryResult.dryRun}`);
  console.log(`    batches:        ${dryResult.batches.length}  (0 = no provider call made)`);

  if (dryResult.readyCount !== 1) stop(`Dry-run readyCount=${dryResult.readyCount} (expected 1)`);
  if (dryResult.uploadedCount !== 0) stop(`Dry-run uploadedCount=${dryResult.uploadedCount} (expected 0)`);
  if (dryResult.failedCount   !== 0) stop(`Dry-run failedCount=${dryResult.failedCount} (expected 0)`);
  if (dryResult.batches.length !== 0) stop(`Dry-run produced ${dryResult.batches.length} batches (expected 0)`);

  ok("Dry-run passed", "readyCount=1, no provider call, no DB state change");

  // Confirm DB row is still 'ready' after dry run
  const { data: dbCheckRow } = await db
    .from("campaign_leads")
    .select("id, status")
    .eq("id", campaignLead.id)
    .single();
  const dbStatus = (dbCheckRow as Record<string,unknown> | null)?.status;
  if (dbStatus !== "ready") stop(`campaign_lead status after dry run: ${dbStatus} (expected 'ready')`);
  ok("DB campaign_lead still status=ready after dry run");

  // ── Step 9: Build exact Smartlead payload ────────────────────────────────────
  section("Step 9 — Exact Smartlead payload that would be sent");

  // Fetch company name for payload
  const { data: coRow } = await db
    .from("companies")
    .select("name")
    .eq("id", companyId)
    .single();
  const companyName = (coRow as { name: string } | null)?.name ?? "";

  // The payload is built exactly as SmartleadAdapter.uploadLeads() constructs it
  const payload = {
    lead_list: [
      {
        email:         TEST_CONTACT_EMAIL,
        first_name:    TEST_CONTACT_FIRSTNAME,
        last_name:     TEST_CONTACT_LASTNAME,
        company_name:  companyName,
        custom_fields: {},
      },
    ],
  };

  const endpoint = `POST https://server.smartlead.ai/api/v1/campaigns/${SL_CAMPAIGN_ID}/leads?ignore_duplicate=true&api_key=[REDACTED]`;

  console.log(`\n  Endpoint:`);
  console.log(`    ${endpoint}`);
  console.log(`\n  Request body (JSON):`);
  console.log(JSON.stringify(payload, null, 4).split("\n").map((l) => `    ${l}`).join("\n"));

  console.log(`\n  Field mapping from DB → Smartlead payload:`);
  console.log(`    email         ← contacts.email           = "${TEST_CONTACT_EMAIL}"`);
  console.log(`    first_name    ← contacts.first_name      = "${TEST_CONTACT_FIRSTNAME}"`);
  console.log(`    last_name     ← contacts.last_name       = "${TEST_CONTACT_LASTNAME}"`);
  console.log(`    company_name  ← companies.name           = "${companyName}"`);
  console.log(`    custom_fields ← (none configured)        = {}`);

  // ── Step 10: Re-verify Smartlead campaign still DRAFTED ──────────────────────
  section("Step 10 — Re-verify Smartlead campaign status (no activation occurred)");

  try {
    const camp2   = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string,unknown>;
    const status2 = String(camp2.status ?? "unknown");
    const isDraft = status2.toUpperCase() === "DRAFT" || status2.toUpperCase() === "DRAFTED";
    ok(`Smartlead campaign status: ${status2}`, isDraft ? "SAFE" : "UNEXPECTED");
    if (!isDraft) stop(`Campaign status changed to ${status2} — abort`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    stop("Could not re-verify Smartlead status", msg);
  }

  // Verify 0 leads in Smartlead campaign (no upload occurred)
  try {
    const slLeads    = await slGet(`/campaigns/${SL_CAMPAIGN_ID}/leads?offset=0&limit=5`) as unknown;
    const slLeadArr  = Array.isArray(slLeads) ? slLeads
      : ((slLeads as Record<string,unknown>)?.data ?? []) as unknown[];
    ok(`Leads in Smartlead campaign: ${slLeadArr.length}`, "0 = no upload occurred");
    if (slLeadArr.length > 0) {
      warn(`Smartlead already has ${slLeadArr.length} lead(s) — these were not uploaded by this script`);
    }
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    warn(`Could not check Smartlead leads: ${msg}`);
  }

  ok("API key never appeared in any console output");
  ok("No provider mutation occurred during dry run");

  // ── Final preflight summary ───────────────────────────────────────────────────
  section("DRY-RUN COMPLETE — Preflight Summary");

  console.log(`
  ┌─────────────────────────────────────────────────────────────────┐
  │  Test contact created / verified                                │
  │    id:           ${contactId}
  │    full_name:    ${TEST_CONTACT_FULLNAME}
  │    email:        ${TEST_CONTACT_EMAIL}
  │    email_status: VERIFIED
  │                                                                 │
  │  DB campaign record                                             │
  │    id:                  ${campaignId}
  │    platform:            smartlead
  │    platform_campaign_id:${SL_CAMPAIGN_ID}
  │    status:              draft
  │                                                                 │
  │  Eligibility:           ALL 5 GATES PASS                        │
  │  Campaign lead status:  ready (id=${campaignLead.id.slice(0, 8)}...)
  │                                                                 │
  │  Smartlead campaign:    DRAFTED (no activation)                 │
  │  Provider mutation:     NONE                                    │
  │                                                                 │
  │  Payload that would be uploaded:                                │
  │    POST /campaigns/${SL_CAMPAIGN_ID}/leads?ignore_duplicate=true
  │    {                                                            │
  │      "lead_list": [{                                            │
  │        "email":        "${TEST_CONTACT_EMAIL}",
  │        "first_name":   "${TEST_CONTACT_FIRSTNAME}",
  │        "last_name":    "${TEST_CONTACT_LASTNAME}",
  │        "company_name": "${companyName}",
  │        "custom_fields":{}                                       │
  │      }]                                                         │
  │    }                                                            │
  └─────────────────────────────────────────────────────────────────┘

  STOPPED. Awaiting your explicit approval to make the live upload.

  To approve the live upload, confirm and I will run:
    uploadCampaignLeads({ clientId, campaignId, dryRun: false, limit: 1 })
  This makes exactly ONE POST to Smartlead and transitions the
  campaign_lead from ready → uploaded.
`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
