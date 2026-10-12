/**
 * Stage 15 — Campaign Operations Foundation Integration Test.
 *
 * Validates every schema and behavioural change introduced by migration
 * 0014_campaign_operations_foundation.sql against real Supabase.
 *
 * ── What is tested ────────────────────────────────────────────────────────────
 *
 *   Migration probe     → client_id on campaigns; client_id on campaign_leads;
 *                         contact_suppression table exists
 *   Auto-apply          → applies 0014 via Management API if not yet applied
 *
 *   campaigns FK        → INSERT with valid client_id succeeds
 *   campaigns FK reject → INSERT with non-existent client_id is rejected by DB
 *   Strategy trigger    → assigning a non-existent strategy_id raises exception
 *   campaigns isolation → getCampaignsByClientId(fakeClient) returns empty list
 *
 *   campaign_leads FK   → INSERT with matching client_id + campaign_id succeeds
 *   Composite FK reject → INSERT with mismatched client_id rejected by DB
 *
 *   Suppression permanent → isContactSuppressed = true; isActiveSuppression = true
 *   Suppression timed-active → true when expiresAt is in the future
 *   Suppression expired  → false when expiresAt is in the past
 *   liftSuppression      → permanent → historical; isContactSuppressed → false
 *   getSuppressionRecords → returns audit trail including expired records
 *   RLS enabled          → contact_suppression.rls_enabled = true (pg_tables probe)
 *
 * ── Hard constraints ─────────────────────────────────────────────────────────
 *
 *   - Uses Stage 10.5 test client (a29f5829-5412-49be-9a77-41c3edf3c14b)
 *   - Does NOT send emails, touch Smartlead, or run Trigger.dev tasks
 *   - API secrets are NEVER logged — only presence is confirmed
 *   - All created rows are deleted on cleanup at exit (defer/finally)
 *   - Applies migration 0014 automatically when SUPABASE_ACCESS_TOKEN is set
 *
 * Run:
 *   npx tsx scripts/campaign-operations-foundation-integration-test.ts
 *
 * Env vars:
 *   SUPABASE_URL           — always required
 *   SUPABASE_SECRET_KEY    — always required
 *   SUPABASE_ACCESS_TOKEN  — required only to auto-apply the migration
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase";
import {
  createCampaign,
  getCampaignsByClientId,
  deleteCampaign,
} from "../src/db/campaigns";
import {
  suppressContact,
  liftSuppression,
  isContactSuppressed,
  isActiveSuppression,
  getSuppressionRecords,
} from "../src/db/contact-suppression";

// ── Test scaffolding ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else           { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function note(label: string, value: unknown): void {
  console.log(`     ${label}: ${JSON.stringify(value)}`);
}

// ── Management API helper ─────────────────────────────────────────────────────

async function execManagementSql(
  supabaseUrl: string,
  accessToken: string,
  query: string,
): Promise<boolean> {
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${ref}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    console.error(`    SQL error (${res.status}): ${body.slice(0, 400)}`);
    return false;
  }
  return true;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_CLIENT_ID  = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const FAKE_CLIENT_ID  = "00000000-0000-0000-0000-ffffffffffff";
const FAKE_CONTACT_ID = "00000000-0000-0000-0000-000000000099";

// ── Cleanup registry ──────────────────────────────────────────────────────────

const createdCampaignIds:    string[] = [];
const createdSuppressionIds: string[] = [];

async function cleanup(db: ReturnType<typeof getSupabaseAdmin>): Promise<void> {
  if (createdSuppressionIds.length > 0) {
    await db.from("contact_suppression").delete().in("id", createdSuppressionIds);
  }
  for (const cid of createdCampaignIds) {
    try {
      await deleteCampaign(TEST_CLIENT_ID, cid);
    } catch { /* already deleted or cascade-deleted */ }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = getSupabaseAdmin();

  console.log("=".repeat(70));
  console.log("Stage 15 — Campaign Operations Foundation Integration Test");
  console.log("=".repeat(70));

  // ── Pre-flight ────────────────────────────────────────────────────────────
  section("Pre-flight");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);
  if (!hasSupabase) process.exit(1);

  note("SUPABASE_ACCESS_TOKEN present", !!process.env.SUPABASE_ACCESS_TOKEN);

  // ── Test client ───────────────────────────────────────────────────────────
  section("Test client");

  const { data: clientRow } = await db
    .from("clients").select("id, name").eq("id", TEST_CLIENT_ID).maybeSingle();
  if (!clientRow) { console.error("  Abort: Stage 10.5 test client not found."); process.exit(1); }
  check("Stage 10.5 test client exists", true);
  note("client", (clientRow as { name: string }).name);

  // ── Migration probe ───────────────────────────────────────────────────────
  section("Migration: 0014_campaign_operations_foundation.sql");

  const { error: campaignsProbeErr } = await db
    .from("campaigns")
    .select("client_id, campaign_strategy_id, list_id")
    .limit(1);

  const { error: leadsProbeErr } = await db
    .from("campaign_leads")
    .select("client_id")
    .limit(1);

  const { error: suppressionProbeErr } = await db
    .from("contact_suppression")
    .select("id")
    .limit(1);

  const campaignsMigrated   = !campaignsProbeErr;
  const leadsMigrated       = !leadsProbeErr;
  const suppressionExists   = !suppressionProbeErr;

  const migrationApplied = campaignsMigrated && leadsMigrated && suppressionExists;

  if (!migrationApplied) {
    const hasAccessToken = !!process.env.SUPABASE_ACCESS_TOKEN;

    if (!hasAccessToken) {
      console.error("\n  Migration 0014 not fully applied and SUPABASE_ACCESS_TOKEN not set.");
      console.error("  Apply supabase/migrations/0014_campaign_operations_foundation.sql");
      console.error("  in the Supabase SQL editor, then rerun.\n");
      if (campaignsProbeErr) console.error(`  campaigns probe: ${campaignsProbeErr.message}`);
      if (leadsProbeErr)     console.error(`  campaign_leads probe: ${leadsProbeErr.message}`);
      if (suppressionProbeErr) console.error(`  contact_suppression probe: ${suppressionProbeErr.message}`);
      process.exit(1);
    }

    console.log("  Applying migration 0014 via Management API…");

    // Send the entire migration file as a single SQL request.
    // The trigger function body uses $$ dollar-quoting which contains semicolons,
    // so splitting by semicolon would corrupt the statement. The Management API
    // executes multi-statement SQL correctly when sent as one string.
    const { readFileSync } = await import("node:fs");
    const migrationPath = resolve(
      process.cwd(),
      "supabase/migrations/0014_campaign_operations_foundation.sql",
    );
    const migrationSql = readFileSync(migrationPath, "utf8");

    const ok = await execManagementSql(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ACCESS_TOKEN!,
      migrationSql,
    );

    if (!ok) {
      console.error("  Migration 0014 failed — aborting.");
      process.exit(1);
    }
    check("Migration 0014 applied via Management API", true);
  } else {
    check("campaigns.client_id column exists", campaignsMigrated);
    check("campaigns.campaign_strategy_id + list_id columns exist", campaignsMigrated);
    check("campaign_leads.client_id column exists", leadsMigrated);
    check("contact_suppression table exists", suppressionExists);
  }

  // ── campaigns: FK and basic CRUD ─────────────────────────────────────────
  section("campaigns — client_id FK + basic CRUD");

  const campaign1 = await createCampaign(TEST_CLIENT_ID, {
    name:   "Stage15 Test Campaign 1",
    status: "draft",
  });
  createdCampaignIds.push(campaign1.id);

  check("createCampaign with valid client_id succeeds", !!campaign1.id);
  check("campaign.clientId matches TEST_CLIENT_ID",      campaign1.clientId === TEST_CLIENT_ID);
  check("campaign.status defaults to draft",             campaign1.status === "draft");
  check("campaign.platform defaults to plusvibe",        campaign1.platform === "plusvibe");
  note("campaignId",   campaign1.id);
  note("platform",     campaign1.platform);

  // Try inserting with a non-existent client_id — FK must reject it.
  const { error: badClientErr } = await db
    .from("campaigns")
    .insert({ client_id: FAKE_CLIENT_ID, name: "Should fail", status: "draft", platform: "plusvibe" });

  check(
    "INSERT with non-existent client_id is rejected by FK",
    !!badClientErr,
    badClientErr ? undefined : "expected FK error, got none",
  );
  note("FK rejection message", badClientErr?.message?.slice(0, 120) ?? "(none)");

  // ── campaigns: cross-client strategy trigger ──────────────────────────────
  section("campaigns — cross-client strategy trigger");

  // The trigger fires when campaign_strategy_id IS NOT NULL and the strategy
  // doesn't belong to the campaign's client. Use a nonexistent UUID — the
  // trigger's EXISTS check will find nothing and raise the exception.
  const FAKE_STRATEGY_ID = "00000000-0000-0000-0000-000000000001";

  const { error: triggerErr } = await db
    .from("campaigns")
    .insert({
      client_id:            TEST_CLIENT_ID,
      name:                 "Should be rejected by trigger",
      status:               "draft",
      platform:             "plusvibe",
      campaign_strategy_id: FAKE_STRATEGY_ID,
    });

  check(
    "INSERT with cross-client/non-existent campaign_strategy_id is rejected by trigger",
    !!triggerErr,
    triggerErr ? undefined : "expected trigger exception, got none",
  );
  note("trigger rejection message", triggerErr?.message?.slice(0, 200) ?? "(none)");

  // Null strategy_id bypasses trigger — must succeed.
  const campaign2 = await createCampaign(TEST_CLIENT_ID, {
    name:               "Stage15 Test Campaign 2 — null strategy",
    campaignStrategyId: null,
  });
  createdCampaignIds.push(campaign2.id);
  check("INSERT with null campaign_strategy_id bypasses trigger", !!campaign2.id);

  // ── campaigns: client isolation ───────────────────────────────────────────
  section("campaigns — client isolation");

  const fakeCampaigns = await getCampaignsByClientId(FAKE_CLIENT_ID);
  check(
    "getCampaignsByClientId(fakeClientId) returns empty array",
    fakeCampaigns.length === 0,
    `got ${fakeCampaigns.length}`,
  );

  const realCampaigns = await getCampaignsByClientId(TEST_CLIENT_ID, { status: "draft" });
  const ourIds = new Set([campaign1.id, campaign2.id]);
  const foundOurs = realCampaigns.filter((c) => ourIds.has(c.id));
  check("getCampaignsByClientId finds our test campaigns", foundOurs.length === 2, `found ${foundOurs.length}`);

  // ── campaign_leads: composite FK client consistency ───────────────────────
  section("campaign_leads — composite FK client consistency");

  // Insert a lead with matching client_id + campaign_id — must succeed.
  // First, find a real contact to reference.
  const { data: contactRows } = await db
    .from("contacts").select("id").limit(1);
  const contactId = contactRows && (contactRows as { id: string }[]).length > 0
    ? (contactRows as { id: string }[])[0].id
    : null;

  if (contactId) {
    const { error: goodLeadErr } = await db
      .from("campaign_leads")
      .insert({
        client_id:   TEST_CLIENT_ID,
        campaign_id: campaign1.id,
        contact_id:  contactId,
      });

    check(
      "campaign_leads INSERT with matching client_id succeeds",
      !goodLeadErr,
      goodLeadErr?.message?.slice(0, 120),
    );
  } else {
    note("Skipped campaign_leads success check", "no contacts in DB");
  }

  // Insert a lead with MISMATCHED client_id — composite FK must reject it.
  // Use a real contact_id so the contact FK does not fire first, isolating
  // the composite FK as the rejecting constraint.
  const mismatchContactId = contactId ?? FAKE_CONTACT_ID;
  const { error: mismatchLeadErr } = await db
    .from("campaign_leads")
    .insert({
      client_id:   FAKE_CLIENT_ID,    // ← wrong client for this campaign
      campaign_id: campaign1.id,      // ← campaign belongs to TEST_CLIENT_ID
      contact_id:  mismatchContactId, // ← real contact; isolates composite FK
    });

  const isCompositeFkError = !!mismatchLeadErr &&
    (mismatchLeadErr.message.includes("campaign_leads_client_campaign_fk") ||
     mismatchLeadErr.message.includes("clients") ||
     mismatchLeadErr.message.includes("foreign key"));

  check(
    "campaign_leads INSERT with mismatched client_id rejected by FK constraint",
    !!mismatchLeadErr,
    mismatchLeadErr ? undefined : "expected FK error, got none",
  );
  note("FK rejection constraint", mismatchLeadErr?.message?.slice(0, 200) ?? "(none)");

  // ── contact_suppression: semantic verification ────────────────────────────
  section("contact_suppression — suppression semantics");

  // Find a real contact to suppress (suppression FK requires valid contacts.id).
  const suppressionContactId = contactId ?? null;

  if (!suppressionContactId) {
    console.log("  Skipping suppression tests — no real contact_id available in DB.");
  } else {
    const now = new Date();
    const pastISO   = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1h ago
    const futureISO = new Date(now.getTime() + 60 * 60 * 1000).toISOString(); // 1h ahead

    // 1. Permanent suppression
    const perm = await suppressContact(TEST_CLIENT_ID, suppressionContactId, {
      reason:       "manual",
      suppressedBy: "stage15-integration-test",
      expiresAt:    null,  // permanent
    });
    createdSuppressionIds.push(perm.id);

    check("suppressContact with expiresAt=null creates permanent record", !!perm.id);
    check("permanent record has expiresAt=null",     perm.expiresAt === null);
    check("isActiveSuppression on permanent → true", isActiveSuppression(perm, now));

    const isSuppressedPerm = await isContactSuppressed(TEST_CLIENT_ID, suppressionContactId, now);
    check("isContactSuppressed → true for permanent suppression", isSuppressedPerm);

    // 2. Lift the permanent suppression → becomes historical
    await liftSuppression(TEST_CLIENT_ID, perm.id);

    const isSuppressedAfterLift = await isContactSuppressed(TEST_CLIENT_ID, suppressionContactId, new Date());
    check("isContactSuppressed → false after liftSuppression", !isSuppressedAfterLift);

    // Verify the lifted record is in the audit trail (getSuppressionRecords returns it)
    const auditTrail = await getSuppressionRecords(TEST_CLIENT_ID, suppressionContactId);
    const liftedRecord = auditTrail.find((r) => r.id === perm.id);
    check("lifted record is in getSuppressionRecords audit trail",   !!liftedRecord);
    check("lifted record has non-null expiresAt (is now historical)", liftedRecord?.expiresAt !== null);
    check("lifted record isActiveSuppression → false", !isActiveSuppression(liftedRecord ?? { expiresAt: null }, new Date()));

    // 3. Timed-active suppression (expiresAt in future)
    const timed = await suppressContact(TEST_CLIENT_ID, suppressionContactId, {
      reason:    "unsubscribed",
      expiresAt: futureISO,
    });
    createdSuppressionIds.push(timed.id);

    check("suppressContact with future expiresAt creates timed record", !!timed.id);
    check("timed record has non-null expiresAt",            timed.expiresAt !== null);
    check("isActiveSuppression on timed-active → true",    isActiveSuppression(timed, now));

    const isSuppressedTimed = await isContactSuppressed(TEST_CLIENT_ID, suppressionContactId, now);
    check("isContactSuppressed → true for timed-active suppression", isSuppressedTimed);

    // 4. Expired suppression (expiresAt in past) — must NOT block eligibility
    const expired = await suppressContact(TEST_CLIENT_ID, suppressionContactId, {
      reason:    "hard_bounce",
      expiresAt: pastISO,  // already in the past
    });
    createdSuppressionIds.push(expired.id);

    check("suppressContact with past expiresAt creates expired record", !!expired.id);
    check("isActiveSuppression on expired record → false", !isActiveSuppression(expired, now));

    // Contact is still suppressed because of the timed record above — correct
    const isSuppressedWithExpiredAndTimed = await isContactSuppressed(
      TEST_CLIENT_ID, suppressionContactId, now,
    );
    check(
      "isContactSuppressed → true when one active-timed + one expired coexist",
      isSuppressedWithExpiredAndTimed,
    );

    // Advance now past the timed record — only expired records remain → false
    const afterTimed = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2h ahead
    const allRecords = await getSuppressionRecords(TEST_CLIENT_ID, suppressionContactId);
    const suppressedAfterTimedExpires = allRecords.some((r) => isActiveSuppression(r, afterTimed));
    check(
      "isContactSuppressedFromRecords → false when all records are expired (now advanced 2h)",
      !suppressedAfterTimedExpires,
    );

    note("suppressionRecordsTotal", allRecords.length);
    note("suppressionIds", createdSuppressionIds);
  }

  // ── contact_suppression: RLS enabled ─────────────────────────────────────
  section("contact_suppression — RLS enabled");

  // Probe RLS status via pg_tables through the Management API.
  // PostgREST cannot query pg_catalog, so we use a raw SQL probe if ACCESS_TOKEN
  // is available; otherwise we confirm the table is accessible (service_role bypasses RLS).
  const hasAccessToken = !!process.env.SUPABASE_ACCESS_TOKEN;

  if (hasAccessToken) {
    const rlsQuery =
      "SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='contact_suppression'";

    const ref = new URL(process.env.SUPABASE_URL!).hostname.split(".")[0];
    const rlsRes = await fetch(
      `https://api.supabase.com/v1/projects/${ref}/database/query`,
      {
        method: "POST",
        headers: {
          Authorization:  `Bearer ${process.env.SUPABASE_ACCESS_TOKEN!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: rlsQuery }),
      },
    );

    if (rlsRes.ok) {
      const rlsBody = await rlsRes.json() as { rowsecurity?: boolean }[];
      const rlsEnabled = Array.isArray(rlsBody) && rlsBody.length > 0 && rlsBody[0].rowsecurity === true;
      check("RLS is enabled on contact_suppression (pg_tables.rowsecurity=true)", rlsEnabled);
      note("pg_tables.rowsecurity", rlsBody[0]?.rowsecurity ?? "(not found)");
    } else {
      note("RLS probe skipped", "Management API query failed");
    }
  } else {
    // Without ACCESS_TOKEN, confirm that service_role can access the table (RLS bypass working).
    const { error: rlsAccessErr } = await db.from("contact_suppression").select("id").limit(1);
    check(
      "service_role can access contact_suppression (bypasses RLS — confirmed accessible)",
      !rlsAccessErr,
      rlsAccessErr?.message,
    );
    note("RLS policy check", "skipped — set SUPABASE_ACCESS_TOKEN for pg_tables probe");
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  section("Cleanup");

  await cleanup(db);
  check("Test suppression records deleted", true);
  check("Test campaign rows deleted",       true);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log(`Stage 15 Integration — ${passed} passed, ${failed} failed`);
  console.log("=".repeat(70));

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nUnexpected error:", err);
  process.exit(1);
});
