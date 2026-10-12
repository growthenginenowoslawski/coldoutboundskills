/**
 * Stage 25A — DB Persistence Integration Test
 *
 * Verifies that the campaign_readiness_assessments and campaign_readiness_approvals
 * tables (applied in migration 0020) work correctly end-to-end via the DB layer.
 *
 * Uses SYNTHETIC rows only. No campaigns modified. No emails sent. No outbound.
 * All synthetic rows are deleted in the cleanup step.
 *
 * Run: npx tsx scripts/stage25a-integration-test.ts
 *
 * ── What is tested ────────────────────────────────────────────────────────────
 *
 * PA01: insertCampaignReadinessAssessment — row created, all columns round-trip
 * PA02: getLatestAssessmentForCampaign    — returns the most recent row
 * PA03: getAssessmentById                 — scoped to client_id
 * PA04: No updated_at on assessment (immutable table)
 * PA05: UNIQUE(client_id, campaign_id, evaluated_at) — duplicate insert → null
 * PA06: canApproveAssessment              — HARD_BLOCKED → false
 * PA07: canApproveAssessment              — OUTREACH_READY → true
 * PA08: insertCampaignReadinessApproval   — row created, all columns round-trip
 * PA09: getApprovalForAssessment          — returns approval by assessment_id
 * PA10: insertCampaignReadinessApproval   — throws for HARD_BLOCKED assessment
 * PA11: markApprovalStale                 — is_stale=true, stale_set_at set
 * PA12: approvals table has no campaign_id column (schema verified at app layer)
 * PA13: eligible_contact_ids is uuid[] — no '@' characters
 * PA14: contact_results JSONB — no email addresses stored
 * PA15: Cleanup — all synthetic rows removed
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin } from "../src/db/supabase.js";
import {
  insertCampaignReadinessAssessment,
  getLatestAssessmentForCampaign,
  getAssessmentById,
  insertCampaignReadinessApproval,
  getApprovalForAssessment,
  markApprovalStale,
  canApproveAssessment,
} from "../src/db/campaign-readiness.js";
import type { CampaignReadinessAssessment } from "../src/domain/campaign-readiness-types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const GRAMSCODE = "a29f5829-5412-49be-9a77-41c3edf3c14b";

// ── Harness ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    const msg = `  ✗ FAIL: ${label}${detail ? " — " + detail : ""}`;
    console.error(msg);
    failed++;
    failures.push(msg);
  }
}

function section(name: string): void {
  console.log(`\n${"─".repeat(70)}\n  ${name}\n${"─".repeat(70)}`);
}

// ── Find a real campaign ───────────────────────────────────────────────────────

section("Pre-flight: find a real campaign");

const db = getSupabaseAdmin();
const campRow = await db.from("campaigns")
  .select("id, status, list_id, platform_campaign_id")
  .eq("client_id", GRAMSCODE)
  .limit(1)
  .maybeSingle();

if (campRow.error) {
  console.error("Cannot fetch campaigns:", campRow.error.message);
  process.exit(1);
}
if (!campRow.data) {
  console.error("No campaigns found for GRAMSCODE. Cannot run integration test.");
  process.exit(1);
}

const CAMPAIGN_ID     = (campRow.data as Record<string, string>).id;
const CAMPAIGN_STATUS = (campRow.data as Record<string, string>).status ?? "draft";
console.log(`  Using campaign_id: ${CAMPAIGN_ID}`);
console.log(`  Campaign status:   ${CAMPAIGN_STATUS}`);

// Synthetic evaluation timestamp — deterministic, far from now to avoid collisions
const EVALUATED_AT = new Date("2099-01-01T00:00:00.000Z");
const CONTACT_UUID = "00000000-0000-4000-8000-000000000001";

// ── Build synthetic assessment ─────────────────────────────────────────────────

const syntheticAssessment: CampaignReadinessAssessment = {
  clientId:                         GRAMSCODE,
  campaignId:                       CAMPAIGN_ID,
  campaignStrategyId:               null,
  campaignStatusAtEvaluation:       CAMPAIGN_STATUS,
  platformCampaignIdAtEvaluation:   null,
  verdict:                          "OUTREACH_READY",
  hardBlocks:                       [],
  warnings:                         [],
  qualifiedCount:                   1,
  contactSummary: {
    eligibleCount:  1,
    blockedCount:   0,
    enrolledCount:  0,
    uploadedCount:  0,
    backfilledCount: 0,
  },
  smtpHealthyInboxCount:            3,
  eligibleContactIds:               [CONTACT_UUID],
  contactResults: [
    {
      contactId:         CONTACT_UUID,
      companyId:         "00000000-0000-4000-8000-000000000002",
      verdict:           "CONTACT_ELIGIBLE",
      blockCode:         null,
      blockDetail:       null,
      eligibilityReason: "ELIGIBLE",
      warningCodes:      [],
      isEnrolled:        false,
      isUploaded:        false,
      platformLeadId:    null,
    },
  ],
  evaluatedAt: EVALUATED_AT,
};

// Track IDs for cleanup
let assessmentId: string | null = null;
let blockedAssessmentId: string | null = null;
let approvalId: string | null = null;

// ── PA01: Insert assessment ────────────────────────────────────────────────────

section("PA01 – insertCampaignReadinessAssessment");

const row = await insertCampaignReadinessAssessment(syntheticAssessment);
check("PA01: row returned (not null)", row !== null);
if (row) {
  assessmentId = row.id;
  check("PA01: id is a UUID",       Boolean(row.id?.match(/^[0-9a-f-]{36}$/)));
  check("PA01: client_id matches",  row.clientId   === GRAMSCODE);
  check("PA01: campaign_id matches",row.campaignId === CAMPAIGN_ID);
  check("PA01: verdict matches",    row.verdict    === "OUTREACH_READY");
  check("PA01: qualified_count=1",  row.qualifiedCount === 1);
  check("PA01: eligible_contact_ids contains UUID", row.eligibleContactIds.includes(CONTACT_UUID));
  check("PA01: smtp_healthy_inbox_count=3", row.smtpHealthyInboxCount === 3);
  check("PA01: evaluated_at round-trips", new Date(row.evaluatedAt).getTime() === EVALUATED_AT.getTime());
}

// ── PA02: getLatestAssessmentForCampaign ──────────────────────────────────────

section("PA02 – getLatestAssessmentForCampaign");

const latest = await getLatestAssessmentForCampaign(GRAMSCODE, CAMPAIGN_ID);
check("PA02: row found",            latest !== null);
check("PA02: id matches PA01 row",  latest?.id === assessmentId);

// ── PA03: getAssessmentById ────────────────────────────────────────────────────

section("PA03 – getAssessmentById");

if (assessmentId) {
  const byId = await getAssessmentById(GRAMSCODE, assessmentId);
  check("PA03: row found by id",                byId !== null);
  check("PA03: verdict matches",                byId?.verdict === "OUTREACH_READY");

  const wrongClient = await getAssessmentById("00000000-0000-0000-0000-000000000000", assessmentId);
  check("PA03: wrong client_id returns null",   wrongClient === null);
}

// ── PA04: No updated_at (immutable) ───────────────────────────────────────────

section("PA04 – immutability check");

if (assessmentId) {
  const raw = await db.from("campaign_readiness_assessments")
    .select("*")
    .eq("id", assessmentId)
    .single();
  const hasUpdatedAt = "updated_at" in (raw.data as Record<string, unknown> ?? {});
  check("PA04: no updated_at column in returned row", !hasUpdatedAt);
}

// ── PA05: UNIQUE constraint — duplicate insert returns null ───────────────────

section("PA05 – UNIQUE(client_id, campaign_id, evaluated_at)");

const duplicate = await insertCampaignReadinessAssessment(syntheticAssessment);
check("PA05: duplicate insert returns null (idempotent)", duplicate === null);

// ── PA06/PA07: canApproveAssessment ───────────────────────────────────────────

section("PA06/PA07 – canApproveAssessment guard");

check("PA06: HARD_BLOCKED → canApprove=false", !canApproveAssessment({ verdict: "HARD_BLOCKED" }));
check("PA07: OUTREACH_READY → canApprove=true",  canApproveAssessment({ verdict: "OUTREACH_READY" }));

// ── PA08: insertCampaignReadinessApproval ─────────────────────────────────────

section("PA08 – insertCampaignReadinessApproval");

if (assessmentId) {
  const approval = await insertCampaignReadinessApproval({
    assessmentId,
    clientId:                 GRAMSCODE,
    approvedBy:               "integration-test",
    approvedAt:               new Date("2099-01-01T01:00:00.000Z"),
    acknowledgedWarningCodes: [],
    notes:                    "Synthetic test approval — will be deleted",
  });
  check("PA08: approval row created", approval !== null);
  if (approval) {
    approvalId = approval.id;
    check("PA08: assessment_id matches",  approval.assessmentId === assessmentId);
    check("PA08: client_id matches",      approval.clientId     === GRAMSCODE);
    check("PA08: approved_by matches",    approval.approvedBy   === "integration-test");
    check("PA08: is_stale=false",         approval.isStale      === false);
    check("PA08: stale_set_at is null",   approval.staleSetAt   === null);
    // campaign_id must NOT be present in the row type (removed in rev 2)
    check("PA08: campaignId absent from row type", !("campaignId" in approval));
  }
}

// ── PA09: getApprovalForAssessment ─────────────────────────────────────────────

section("PA09 – getApprovalForAssessment");

if (assessmentId) {
  const fetched = await getApprovalForAssessment(assessmentId);
  check("PA09: row found by assessment_id", fetched !== null);
  check("PA09: id matches PA08 row",        fetched?.id === approvalId);
}

// ── PA10: Throws for HARD_BLOCKED ─────────────────────────────────────────────

section("PA10 – approval rejected for HARD_BLOCKED assessment");

// Insert a HARD_BLOCKED synthetic assessment at a different evaluated_at
const blockedAssessment: CampaignReadinessAssessment = {
  ...syntheticAssessment,
  verdict:     "HARD_BLOCKED",
  hardBlocks:  [{ code: "XB-07", detail: "All contacts blocked" }],
  warnings:    [],
  qualifiedCount: 0,
  eligibleContactIds: [],
  evaluatedAt: new Date("2099-06-01T00:00:00.000Z"),
};

const blockedRow = await insertCampaignReadinessAssessment(blockedAssessment);
check("PA10: HARD_BLOCKED assessment inserted", blockedRow !== null);
if (blockedRow) {
  blockedAssessmentId = blockedRow.id;

  let threw = false;
  try {
    await insertCampaignReadinessApproval({
      assessmentId:             blockedAssessmentId,
      clientId:                 GRAMSCODE,
      approvedBy:               "integration-test",
      approvedAt:               new Date(),
      acknowledgedWarningCodes: [],
    });
  } catch (e) {
    threw = true;
    const msg = (e as Error).message;
    check("PA10: error message references HARD_BLOCKED", msg.includes("HARD_BLOCKED"));
  }
  check("PA10: approval throws for HARD_BLOCKED", threw);
}

// ── PA11: markApprovalStale ────────────────────────────────────────────────────

section("PA11 – markApprovalStale");

if (approvalId && assessmentId) {
  await markApprovalStale(approvalId, "integration-test: simulated state change");

  const staled = await getApprovalForAssessment(assessmentId);
  check("PA11: is_stale=true after markApprovalStale",   staled?.isStale      === true);
  check("PA11: stale_reason set",                         Boolean(staled?.staleReason));
  check("PA11: stale_set_at is a timestamp string",       typeof staled?.staleSetAt === "string" && staled.staleSetAt.length > 0);
}

// ── PA12: campaign_id absent from approval row type ───────────────────────────

section("PA12 – approval row has no campaignId");

if (approvalId && assessmentId) {
  const row12 = await getApprovalForAssessment(assessmentId);
  check("PA12: campaignId not present on approval row", row12 !== null && !("campaignId" in (row12 as object)));
}

// ── PA13: eligible_contact_ids contains only UUIDs ────────────────────────────

section("PA13 – eligible_contact_ids PII check");

if (assessmentId) {
  const row13 = await getAssessmentById(GRAMSCODE, assessmentId);
  check("PA13: eligible_contact_ids is array", Array.isArray(row13?.eligibleContactIds));
  const hasPii = (row13?.eligibleContactIds ?? []).some((id: string) => id.includes("@"));
  check("PA13: no email addresses in eligible_contact_ids", !hasPii);
}

// ── PA14: contact_results has no email addresses ──────────────────────────────

section("PA14 – contact_results PII check");

if (assessmentId) {
  const row14 = await getAssessmentById(GRAMSCODE, assessmentId);
  const json = JSON.stringify(row14?.contactResults ?? []);
  check("PA14: contact_results JSON contains no '@' (no emails)", !json.includes("@"));
}

// ── PA15: Cleanup ─────────────────────────────────────────────────────────────

section("PA15 – Cleanup");

// Delete approval first (RESTRICT on assessment)
if (approvalId) {
  const { error } = await db.from("campaign_readiness_approvals").delete().eq("id", approvalId);
  check("PA15: approval deleted", !error, error?.message);
}

// Delete assessments
const assessmentIds = [assessmentId, blockedAssessmentId].filter(Boolean) as string[];
for (const id of assessmentIds) {
  const { error } = await db.from("campaign_readiness_assessments").delete().eq("id", id);
  check(`PA15: assessment ${id.slice(0, 8)}… deleted`, !error, error?.message);
}

// Verify both tables are back to their pre-test state for this campaign at these timestamps
const leftover = await db.from("campaign_readiness_assessments")
  .select("id")
  .eq("client_id", GRAMSCODE)
  .eq("campaign_id", CAMPAIGN_ID)
  .gte("evaluated_at", "2099-01-01T00:00:00.000Z");
check("PA15: no synthetic assessments remain", (leftover.data ?? []).length === 0);

// ── Final ──────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(70)}`);
console.log(`  Stage 25A integration — passed: ${passed}  failed: ${failed}`);
if (failures.length) {
  console.log("\n  Failures:");
  failures.forEach(f => console.log(f));
}
console.log(`${"═".repeat(70)}\n`);

if (failed > 0) process.exit(1);
