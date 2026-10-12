/**
 * Unit tests for Stage 15 contact suppression — pure, no DB, no network.
 *
 * Tests three pure exports from src/db/contact-suppression.ts:
 *
 *   isActiveSuppression           — single-record active check
 *   isContactSuppressedFromRecords — any-record active check
 *   VALID_SUPPRESSION_REASONS     — matches DB CHECK constraint
 *
 * All tests are deterministic and require zero environment variables.
 *
 * Key suppression semantics:
 *   expires_at IS NULL   → permanent  (always active)
 *   expires_at > now     → timed-active (blocks until then)
 *   expires_at <= now    → historical ONLY (does NOT block eligibility)
 *
 * Coverage:
 *   isActiveSuppression
 *     — permanent (expiresAt null) → true
 *     — timed-active (expiresAt > now) → true
 *     — far future → true
 *     — expired (expiresAt < now) → false
 *     — boundary: expiresAt exactly equals now → false (not strictly greater)
 *     — now parameter override: same record active with old now, expired with new now
 *
 *   isContactSuppressedFromRecords
 *     — empty array → false
 *     — single permanent record → true
 *     — single expired record → false
 *     — single active-timed record → true
 *     — all expired records → false
 *     — mixed expired + permanent → true
 *     — mixed expired + active-timed → true
 *     — now parameter override: active shifts to expired when now advances
 *
 *   VALID_SUPPRESSION_REASONS
 *     — contains all five DB CHECK constraint values
 *     — contains exactly five values (no extras)
 *     — all values are strings
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isActiveSuppression,
  isContactSuppressedFromRecords,
  VALID_SUPPRESSION_REASONS,
  type ContactSuppressionRow,
  type SuppressionReason,
} from "../db/contact-suppression";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE: ContactSuppressionRow = {
  id:               "00000000-0000-0000-0000-000000000001",
  clientId:         "00000000-0000-0000-0000-0000000000c1",
  contactId:        "00000000-0000-0000-0000-0000000000e1",
  reason:           "manual",
  suppressedBy:     null,
  sourceCampaignId: null,
  expiresAt:        null,
  notes:            null,
  createdAt:        "2026-09-01T00:00:00Z",
  updatedAt:        "2026-09-01T00:00:00Z",
};

/** Reference wall-clock for all tests that need a fixed now. */
const NOW = new Date("2026-09-04T12:00:00Z");

/** 1 hour before NOW */
const PAST  = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
/** 1 hour after NOW */
const FUTURE = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();

function row(expiresAt: string | null): Pick<ContactSuppressionRow, "expiresAt"> {
  return { expiresAt };
}

// ── isActiveSuppression ───────────────────────────────────────────────────────

test("isActiveSuppression: permanent (expiresAt null) is always active", () => {
  assert.equal(isActiveSuppression(row(null), NOW), true);
});

test("isActiveSuppression: timed-active (expiresAt 1h in future) is active", () => {
  assert.equal(isActiveSuppression(row(FUTURE), NOW), true);
});

test("isActiveSuppression: far future is active", () => {
  const farFuture = new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(isActiveSuppression(row(farFuture), NOW), true);
});

test("isActiveSuppression: expired (expiresAt 1h in past) is NOT active", () => {
  assert.equal(isActiveSuppression(row(PAST), NOW), false);
});

test("isActiveSuppression: boundary — expiresAt exactly equals now is NOT active", () => {
  // expires_at <= now is historical; the condition is strictly greater-than
  assert.equal(isActiveSuppression(row(NOW.toISOString()), NOW), false);
});

test("isActiveSuppression: now parameter override — same record is active with past now, expired with future now", () => {
  const expiresAt = NOW.toISOString(); // expires exactly at NOW

  const beforeNow = new Date(NOW.getTime() - 1);  // 1ms before expiry → still active
  const afterNow  = new Date(NOW.getTime() + 1);  // 1ms after expiry → expired

  assert.equal(isActiveSuppression(row(expiresAt), beforeNow), true,  "should be active 1ms before expiry");
  assert.equal(isActiveSuppression(row(expiresAt), afterNow),  false, "should be expired 1ms after expiry");
});

test("isActiveSuppression: accepts a full ContactSuppressionRow (not just Pick)", () => {
  const permanent = { ...BASE, expiresAt: null };
  const expired   = { ...BASE, expiresAt: PAST };
  assert.equal(isActiveSuppression(permanent, NOW), true);
  assert.equal(isActiveSuppression(expired,   NOW), false);
});

// ── isContactSuppressedFromRecords ────────────────────────────────────────────

test("isContactSuppressedFromRecords: empty array → false", () => {
  assert.equal(isContactSuppressedFromRecords([], NOW), false);
});

test("isContactSuppressedFromRecords: single permanent record → true", () => {
  assert.equal(isContactSuppressedFromRecords([row(null)], NOW), true);
});

test("isContactSuppressedFromRecords: single expired record → false", () => {
  assert.equal(isContactSuppressedFromRecords([row(PAST)], NOW), false);
});

test("isContactSuppressedFromRecords: single active-timed record → true", () => {
  assert.equal(isContactSuppressedFromRecords([row(FUTURE)], NOW), true);
});

test("isContactSuppressedFromRecords: all expired → false", () => {
  const records = [row(PAST), row(PAST), row(PAST)];
  assert.equal(isContactSuppressedFromRecords(records, NOW), false);
});

test("isContactSuppressedFromRecords: mixed expired + permanent → true", () => {
  const records = [row(PAST), row(PAST), row(null)];
  assert.equal(isContactSuppressedFromRecords(records, NOW), true);
});

test("isContactSuppressedFromRecords: mixed expired + active-timed → true", () => {
  const records = [row(PAST), row(PAST), row(FUTURE)];
  assert.equal(isContactSuppressedFromRecords(records, NOW), true);
});

test("isContactSuppressedFromRecords: now parameter override shifts active → expired", () => {
  const expiresAt = NOW.toISOString();
  const records   = [row(expiresAt)];

  const beforeNow = new Date(NOW.getTime() - 1);
  const afterNow  = new Date(NOW.getTime() + 1);

  assert.equal(isContactSuppressedFromRecords(records, beforeNow), true,  "active 1ms before expiry");
  assert.equal(isContactSuppressedFromRecords(records, afterNow),  false, "expired 1ms after expiry");
});

// ── VALID_SUPPRESSION_REASONS ─────────────────────────────────────────────────

test("VALID_SUPPRESSION_REASONS: contains all five DB CHECK constraint values", () => {
  const expected: SuppressionReason[] = [
    "unsubscribed",
    "negative_reply",
    "hard_bounce",
    "do_not_contact",
    "manual",
  ];
  for (const reason of expected) {
    assert.ok(
      VALID_SUPPRESSION_REASONS.includes(reason),
      `expected VALID_SUPPRESSION_REASONS to include '${reason}'`,
    );
  }
});

test("VALID_SUPPRESSION_REASONS: contains exactly five values (no extras)", () => {
  assert.equal(
    VALID_SUPPRESSION_REASONS.length,
    5,
    `expected 5 reasons, got ${VALID_SUPPRESSION_REASONS.length}: ${VALID_SUPPRESSION_REASONS.join(", ")}`,
  );
});

test("VALID_SUPPRESSION_REASONS: all values are non-empty strings", () => {
  for (const reason of VALID_SUPPRESSION_REASONS) {
    assert.equal(typeof reason, "string");
    assert.ok(reason.length > 0, `reason '${reason}' should be non-empty`);
  }
});
