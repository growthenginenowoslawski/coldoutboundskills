/**
 * Unit tests for Stage 19B lead enrollment.
 *
 * All tests are pure — no network, no Supabase, no real data.
 * Tests cover validateEnrollmentPreconditions and buildEnrollmentResult.
 *
 * Gate-specific eligibility logic (suppressed, unverified, etc.) is already
 * covered exhaustively in Stage 17 tests (contact-eligibility.test.ts).
 * These tests focus on Stage 19B's own logic: campaign precondition guards,
 * result aggregation, count invariants, and enrollment outcome classification.
 *
 * Run: node --import tsx --test "src/__tests__/lead-enrollment.test.ts"
 * Full regression: node --import tsx --test "src/**\/*.test.ts"
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  validateEnrollmentPreconditions,
  buildEnrollmentResult,
} from "../lib/lead-enrollment.js";
import type { EnrollmentRejection } from "../lib/lead-enrollment.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_A   = "client-aaa";
const CLIENT_B   = "client-bbb";
const CAMPAIGN   = "campaign-ccc";

const NOW = new Date("2026-09-04T12:00:00Z");

const CAMPAIGN_DRAFT    = { clientId: CLIENT_A, status: "draft"     } as const;
const CAMPAIGN_RUNNING  = { clientId: CLIENT_A, status: "running"   } as const;
const CAMPAIGN_REVIEW   = { clientId: CLIENT_A, status: "review"    } as const;
const CAMPAIGN_READY    = { clientId: CLIENT_A, status: "ready"     } as const;
const CAMPAIGN_PAUSED   = { clientId: CLIENT_A, status: "paused"    } as const;
const CAMPAIGN_COMPLETED= { clientId: CLIENT_A, status: "completed" } as const;
const CAMPAIGN_CANCELLED= { clientId: CLIENT_A, status: "cancelled" } as const;
const CAMPAIGN_WRONG_CLIENT = { clientId: CLIENT_B, status: "draft" } as const;

// ── validateEnrollmentPreconditions ───────────────────────────────────────────

describe("validateEnrollmentPreconditions", () => {
  test("null campaign → CAMPAIGN_NOT_FOUND", () => {
    const r = validateEnrollmentPreconditions(null, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "CAMPAIGN_NOT_FOUND");
      assert.ok(r.detail.length > 0);
    }
  });

  test("wrong client → CAMPAIGN_CLIENT_MISMATCH", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_WRONG_CLIENT, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "CAMPAIGN_CLIENT_MISMATCH");
      assert.ok(r.detail.includes(CLIENT_B));
    }
  });

  test("status=review → CAMPAIGN_NOT_ACTIVE", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_REVIEW, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("status=ready → CAMPAIGN_NOT_ACTIVE", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_READY, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("status=paused → CAMPAIGN_NOT_ACTIVE", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_PAUSED, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("status=completed → CAMPAIGN_NOT_ACTIVE", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_COMPLETED, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("status=cancelled → CAMPAIGN_NOT_ACTIVE", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_CANCELLED, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("status=draft, correct client → ok", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_DRAFT, CLIENT_A);
    assert.equal(r.ok, true);
  });

  test("status=running, correct client → ok", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_RUNNING, CLIENT_A);
    assert.equal(r.ok, true);
  });

  test("CAMPAIGN_NOT_ACTIVE detail mentions the invalid status", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_PAUSED, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.detail.includes("paused"));
  });

  test("CAMPAIGN_NOT_ACTIVE detail mentions draft or running as valid", () => {
    const r = validateEnrollmentPreconditions(CAMPAIGN_COMPLETED, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.detail.toLowerCase().includes("draft") || r.detail.toLowerCase().includes("running"));
  });
});

// ── buildEnrollmentResult ─────────────────────────────────────────────────────

describe("buildEnrollmentResult", () => {
  function makeRejection(contactId: string, reason: string = "CONTACT_SUPPRESSED"): EnrollmentRejection {
    return { contactId, reason: reason as EnrollmentRejection["reason"], detail: `blocked: ${reason}` };
  }

  function makeInserted(contactId: string): { id: string; contactId: string; createdAt: string } {
    return { id: `lead-${contactId}`, contactId, createdAt: NOW.toISOString() };
  }

  test("empty input → all zeros", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   [],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.requested,       0);
    assert.equal(r.enrolled,        0);
    assert.equal(r.alreadyEnrolled, 0);
    assert.equal(r.rejected,        0);
    assert.equal(r.leads.length,    0);
    assert.equal(r.rejections.length, 0);
  });

  test("successful enrollment — single contact", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     ["c1"],
      insertedRows: [makeInserted("c1")],
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.requested,       1);
    assert.equal(r.enrolled,        1);
    assert.equal(r.alreadyEnrolled, 0);
    assert.equal(r.rejected,        0);
    assert.equal(r.leads.length,    1);
    assert.equal(r.leads[0].contactId,      "c1");
    assert.equal(r.leads[0].campaignLeadId, "lead-c1");
    assert.equal(r.leads[0].status,         "ready");
    assert.equal(r.leads[0].enrolledAt,     NOW.toISOString());
  });

  test("multiple eligible contacts — all enrolled", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1", "c2", "c3"],
      toEnroll:     ["c1", "c2", "c3"],
      insertedRows: [makeInserted("c1"), makeInserted("c2"), makeInserted("c3")],
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.requested, 3);
    assert.equal(r.enrolled,  3);
    assert.equal(r.alreadyEnrolled, 0);
    assert.equal(r.rejected,  0);
    assert.equal(r.leads.length, 3);
  });

  test("ineligible contact — appears in rejections, not leads", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "NO_ACCOUNT_INTELLIGENCE")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.requested,  1);
    assert.equal(r.enrolled,   0);
    assert.equal(r.rejected,   1);
    assert.equal(r.leads.length, 0);
    assert.equal(r.rejections[0].reason, "NO_ACCOUNT_INTELLIGENCE");
  });

  test("suppressed contact → CONTACT_SUPPRESSED in rejections", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "CONTACT_SUPPRESSED")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejections[0].reason, "CONTACT_SUPPRESSED");
    assert.equal(r.enrolled, 0);
  });

  test("email invalid → EMAIL_INVALID in rejections", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "EMAIL_INVALID")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejections[0].reason, "EMAIL_INVALID");
  });

  test("email stale → EMAIL_VERIFICATION_STALE in rejections", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "EMAIL_VERIFICATION_STALE")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejections[0].reason, "EMAIL_VERIFICATION_STALE");
  });

  test("unverified email → EMAIL_NOT_VERIFIED in rejections", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "EMAIL_NOT_VERIFIED")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejections[0].reason, "EMAIL_NOT_VERIFIED");
  });

  test("missing account intelligence → NO_ACCOUNT_INTELLIGENCE in rejections", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "NO_ACCOUNT_INTELLIGENCE")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejections[0].reason, "NO_ACCOUNT_INTELLIGENCE");
  });

  test("account score zero → ACCOUNT_SCORE_ZERO in rejections", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "ACCOUNT_SCORE_ZERO")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejections[0].reason, "ACCOUNT_SCORE_ZERO");
  });

  test("company/contact mismatch → CONTACT_COMPANY_MISMATCH in rejections", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "CONTACT_COMPANY_MISMATCH")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejections[0].reason, "CONTACT_COMPANY_MISMATCH");
  });

  test("already enrolled — toEnroll submitted but not in insertedRows → alreadyEnrolled count", () => {
    // c1 was already enrolled → ON CONFLICT skipped it → not in insertedRows
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     ["c1"],   // submitted to DB
      insertedRows: [],       // not returned (already enrolled)
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.requested,        1);
    assert.equal(r.enrolled,         0);
    assert.equal(r.alreadyEnrolled,  1);
    assert.equal(r.rejected,         0);
  });

  test("duplicate concurrent enrollment — exactly one row inserted, one skipped", () => {
    // Simulates: two concurrent calls, first inserts, second gets ON CONFLICT
    // In reality both calls run the same code; the DB resolves the race.
    // This test verifies the result classification for the "losing" call.
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     ["c1"],
      insertedRows: [], // ON CONFLICT DO NOTHING — losing call sees 0 rows returned
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.enrolled,         0);
    assert.equal(r.alreadyEnrolled,  1);
  });

  test("correct initial ready status on enrolled leads", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     ["c1"],
      insertedRows: [makeInserted("c1")],
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.leads[0].status, "ready");
  });

  test("enrolledAt is the DB createdAt timestamp from the inserted row", () => {
    const createdAt = "2026-09-04T13:00:00.000Z";
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     ["c1"],
      insertedRows: [{ id: "lead-c1", contactId: "c1", createdAt }],
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.leads[0].enrolledAt, createdAt);
  });

  test("mixed batch — some enrolled, some rejected", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1", "c2", "c3"],
      toEnroll:     ["c1"],
      insertedRows: [makeInserted("c1")],
      rejections:   [makeRejection("c2", "CONTACT_SUPPRESSED"), makeRejection("c3", "NO_ACCOUNT_INTELLIGENCE")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.requested, 3);
    assert.equal(r.enrolled,  1);
    assert.equal(r.rejected,  2);
    assert.equal(r.alreadyEnrolled, 0);
    assert.equal(r.leads.length,       1);
    assert.equal(r.rejections.length,  2);
  });

  test("idempotent repeated enrollment — second call: alreadyEnrolled = N, enrolled = 0", () => {
    // Simulates second call with same contacts after first call enrolled them all
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1", "c2"],
      toEnroll:     ["c1", "c2"], // both pass re-validation
      insertedRows: [],           // both hit ON CONFLICT
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.enrolled,         0);
    assert.equal(r.alreadyEnrolled,  2);
    assert.equal(r.rejected,         0);
    assert.equal(r.leads.length,     0);
  });

  test("client isolation — clientId and campaignId are preserved in result", () => {
    const r = buildEnrollmentResult({
      campaignId:   "campaign-xyz",
      clientId:     "client-xyz",
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.campaignId, "campaign-xyz");
    assert.equal(r.clientId,   "client-xyz");
  });

  test("dryRun=true is preserved in result", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     ["c1"],
      insertedRows: [], // dryRun skips DB, so no rows
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       true,
    });
    assert.equal(r.dryRun, true);
    assert.equal(r.enrolled, 0);
  });

  test("enrolledAt ISO timestamp is set from the input date", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   [],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.enrolledAt, NOW.toISOString());
  });

  test("requested = contactIds.length invariant", () => {
    const contactIds = ["c1", "c2", "c3", "c4", "c5"];
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds,
      toEnroll:     ["c1", "c2"],
      insertedRows: [makeInserted("c1")],
      rejections:   [makeRejection("c3"), makeRejection("c4"), makeRejection("c5")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.requested, 5);
    assert.equal(r.enrolled,  1);
    assert.equal(r.alreadyEnrolled, 1); // c2 submitted but not inserted
    assert.equal(r.rejected, 3);
    // enrolled + alreadyEnrolled + rejected == requested
    assert.equal(r.enrolled + r.alreadyEnrolled + r.rejected, r.requested);
  });

  test("campaignLeadId comes from the DB-returned id", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     ["c1"],
      insertedRows: [{ id: "db-uuid-abc", contactId: "c1", createdAt: NOW.toISOString() }],
      rejections:   [],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.leads[0].campaignLeadId, "db-uuid-abc");
  });

  // ── No side-effects for rejected contacts ────────────────────────────────────

  test("no campaign/provider/outbound data for rejected contacts — rejections contain only reason+detail", () => {
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds:   ["c1"],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [makeRejection("c1", "CONTACT_SUPPRESSED")],
      enrolledAt:   NOW,
      dryRun:       false,
    });
    const rejection = r.rejections[0];
    // Only contactId, reason, detail — no campaign_leads row, no email send trigger
    assert.equal(Object.keys(rejection).sort().join(","), "contactId,detail,reason");
    assert.equal(r.leads.length, 0); // no lead row created
  });
});

// ── Preconditions propagate into full rejection list ──────────────────────────

describe("campaign precondition failure produces rejections for all contacts", () => {
  test("null campaign → all contactIds appear in rejections", () => {
    const contactIds = ["c1", "c2", "c3"];
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds,
      toEnroll:     [],
      insertedRows: [],
      rejections:   contactIds.map((id) =>
        ({ contactId: id, reason: "CAMPAIGN_NOT_FOUND" as const, detail: "Campaign not found." }),
      ),
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejected, 3);
    assert.equal(r.enrolled, 0);
    assert.equal(r.rejections.every((rej) => rej.reason === "CAMPAIGN_NOT_FOUND"), true);
  });

  test("inactive campaign → CAMPAIGN_NOT_ACTIVE for all contacts", () => {
    const contactIds = ["c1", "c2"];
    const r = buildEnrollmentResult({
      campaignId:   CAMPAIGN,
      clientId:     CLIENT_A,
      contactIds,
      toEnroll:     [],
      insertedRows: [],
      rejections:   contactIds.map((id) =>
        ({ contactId: id, reason: "CAMPAIGN_NOT_ACTIVE" as const, detail: "Campaign status 'paused' does not accept new enrollments." }),
      ),
      enrolledAt:   NOW,
      dryRun:       false,
    });
    assert.equal(r.rejected, 2);
    assert.ok(r.rejections.every((rej) => rej.reason === "CAMPAIGN_NOT_ACTIVE"));
  });
});
