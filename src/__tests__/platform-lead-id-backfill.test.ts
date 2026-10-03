/**
 * Unit tests for Stage 21A platform_lead_id backfill.
 *
 * All tests are pure — no network, no Supabase, no real data.
 * Tests cover:
 *   - validateBackfillPreconditions: all precondition gates
 *   - normalizeEmail: case/whitespace normalization
 *   - buildBackfillResult: result shape and timing
 *
 * Run: node --import tsx --test "src/__tests__/platform-lead-id-backfill.test.ts"
 * Full regression: npm test
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  validateBackfillPreconditions,
  normalizeEmail,
  buildBackfillResult,
} from "../lib/platform-lead-id-backfill.js";
import type { CampaignRow } from "../db/campaigns.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_A = "client-aaa";
const CLIENT_B = "client-bbb";
const NOW      = new Date("2026-09-05T10:00:00Z");

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id:                 "campaign-ccc",
    clientId:           CLIENT_A,
    name:               "Test Campaign",
    description:        null,
    platform:           "smartlead",
    platformCampaignId: "sl-99999",
    campaignStrategyId: null,
    listId:             null,
    status:             "draft",
    dailySendLimit:     null,
    startDate:          null,
    endDate:            null,
    createdAt:          NOW.toISOString(),
    updatedAt:          NOW.toISOString(),
    ...overrides,
  };
}

// ── validateBackfillPreconditions ─────────────────────────────────────────────

describe("validateBackfillPreconditions", () => {
  test("null campaign → CAMPAIGN_NOT_FOUND", () => {
    const r = validateBackfillPreconditions(null, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_FOUND");
  });

  test("wrong clientId → CAMPAIGN_CLIENT_MISMATCH", () => {
    const r = validateBackfillPreconditions(makeCampaign(), CLIENT_B);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "CAMPAIGN_CLIENT_MISMATCH");
      assert.ok(r.detail.includes(CLIENT_A));
    }
  });

  test("platform !== 'smartlead' → CAMPAIGN_PLATFORM_UNSUPPORTED", () => {
    const r = validateBackfillPreconditions(
      makeCampaign({ platform: "plusvibe" as CampaignRow["platform"] }),
      CLIENT_A,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_PLATFORM_UNSUPPORTED");
  });

  test("null platformCampaignId → CAMPAIGN_MISSING_PLATFORM_ID", () => {
    const r = validateBackfillPreconditions(
      makeCampaign({ platformCampaignId: null }),
      CLIENT_A,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_MISSING_PLATFORM_ID");
  });

  test("valid draft campaign → ok", () => {
    const r = validateBackfillPreconditions(makeCampaign({ status: "draft" }), CLIENT_A);
    assert.equal(r.ok, true);
  });

  test("campaign with status='running' is accepted — no status restriction for backfill", () => {
    // Unlike Stage 20 upload (draft-only), backfill works on any campaign status
    const r = validateBackfillPreconditions(
      makeCampaign({ status: "running" as CampaignRow["status"] }),
      CLIENT_A,
    );
    assert.equal(r.ok, true);
  });

  test("detail message is non-empty for every failure case", () => {
    const cases = [
      validateBackfillPreconditions(null, CLIENT_A),
      validateBackfillPreconditions(makeCampaign(), CLIENT_B),
      validateBackfillPreconditions(makeCampaign({ platform: "plusvibe" as CampaignRow["platform"] }), CLIENT_A),
      validateBackfillPreconditions(makeCampaign({ platformCampaignId: null }), CLIENT_A),
    ];
    for (const r of cases) {
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.detail.length > 0, `detail should be non-empty for reason=${r.reason}`);
    }
  });
});

// ── normalizeEmail ────────────────────────────────────────────────────────────

describe("normalizeEmail", () => {
  test("already lowercase → unchanged", () => {
    assert.equal(normalizeEmail("alice@example.com"), "alice@example.com");
  });

  test("uppercase → lowercased", () => {
    assert.equal(normalizeEmail("ALICE@EXAMPLE.COM"), "alice@example.com");
  });

  test("mixed case → lowercased", () => {
    assert.equal(normalizeEmail("Alice@Example.Com"), "alice@example.com");
  });

  test("leading whitespace trimmed", () => {
    assert.equal(normalizeEmail("  alice@example.com"), "alice@example.com");
  });

  test("trailing whitespace trimmed", () => {
    assert.equal(normalizeEmail("alice@example.com  "), "alice@example.com");
  });

  test("both whitespace and casing normalized", () => {
    assert.equal(normalizeEmail("  ALICE@Example.COM  "), "alice@example.com");
  });

  test("empty string → empty string", () => {
    assert.equal(normalizeEmail(""), "");
  });
});

// ── buildBackfillResult ───────────────────────────────────────────────────────

describe("buildBackfillResult", () => {
  test("result contains all required fields", () => {
    const r = buildBackfillResult({
      campaignId: "c-1", clientId: "cl-1", startedAt: NOW,
      slLeadsDiscovered: 5, dbRowsProcessed: 3,
      rowsUpdated: 2, rowsSkipped: 1, rowsUnmatched: 0, slLeadsUnmatched: 2,
    });
    assert.equal(r.campaignId,         "c-1");
    assert.equal(r.clientId,           "cl-1");
    assert.equal(r.slLeadsDiscovered,  5);
    assert.equal(r.dbRowsProcessed,    3);
    assert.equal(r.rowsUpdated,        2);
    assert.equal(r.rowsSkipped,        1);
    assert.equal(r.rowsUnmatched,      0);
    assert.equal(r.slLeadsUnmatched,   2);
  });

  test("startedAt is the input Date as ISO string", () => {
    const r = buildBackfillResult({
      campaignId: "c-1", clientId: "cl-1", startedAt: NOW,
      slLeadsDiscovered: 0, dbRowsProcessed: 0,
      rowsUpdated: 0, rowsSkipped: 0, rowsUnmatched: 0, slLeadsUnmatched: 0,
    });
    assert.equal(r.startedAt, NOW.toISOString());
  });

  test("completedAt is after startedAt", () => {
    const r = buildBackfillResult({
      campaignId: "c-1", clientId: "cl-1", startedAt: NOW,
      slLeadsDiscovered: 0, dbRowsProcessed: 0,
      rowsUpdated: 0, rowsSkipped: 0, rowsUnmatched: 0, slLeadsUnmatched: 0,
    });
    assert.ok(
      new Date(r.completedAt) >= new Date(r.startedAt),
      "completedAt must be >= startedAt",
    );
  });

  test("elapsedMs is non-negative", () => {
    const r = buildBackfillResult({
      campaignId: "c-1", clientId: "cl-1", startedAt: NOW,
      slLeadsDiscovered: 0, dbRowsProcessed: 0,
      rowsUpdated: 0, rowsSkipped: 0, rowsUnmatched: 0, slLeadsUnmatched: 0,
    });
    assert.ok(r.elapsedMs >= 0);
  });

  test("all-zero result is valid (no uploaded rows)", () => {
    const r = buildBackfillResult({
      campaignId: "c-1", clientId: "cl-1", startedAt: NOW,
      slLeadsDiscovered: 0, dbRowsProcessed: 0,
      rowsUpdated: 0, rowsSkipped: 0, rowsUnmatched: 0, slLeadsUnmatched: 0,
    });
    assert.equal(r.rowsUpdated + r.rowsSkipped + r.rowsUnmatched, 0);
  });
});
