/**
 * Unit tests for Stage 20 lead upload.
 *
 * All tests are pure — no network, no Supabase, no real data.
 * Tests cover:
 *   - validateUploadPreconditions: all precondition gates
 *   - toBatchesOf: batching edge cases (0, 1, 100, 101, 200, 201 items)
 *   - buildUploadResult: aggregation correctness for all outcome combinations
 *
 * Run: node --import tsx --test "src/__tests__/lead-upload.test.ts"
 * Full regression: npm test
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  validateUploadPreconditions,
  toBatchesOf,
  buildUploadResult,
} from "../lib/lead-upload.js";
import type { BatchUploadOutcome } from "../lib/lead-upload.js";
import type { CampaignRow } from "../db/campaigns.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_A = "client-aaa";
const CLIENT_B = "client-bbb";
const NOW = new Date("2026-09-05T10:00:00Z");

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

function makeBatch(overrides: Partial<BatchUploadOutcome> = {}): BatchUploadOutcome {
  return {
    batchIndex:    0,
    leadsInBatch:  10,
    uploadCount:   10,
    duplicateCount: 0,
    failed:        false,
    ...overrides,
  };
}

// ── validateUploadPreconditions ───────────────────────────────────────────────

describe("validateUploadPreconditions", () => {
  test("null campaign → CAMPAIGN_NOT_FOUND", () => {
    const r = validateUploadPreconditions(null, CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "CAMPAIGN_NOT_FOUND");
      assert.ok(r.detail.length > 0);
    }
  });

  test("wrong clientId → CAMPAIGN_CLIENT_MISMATCH", () => {
    const r = validateUploadPreconditions(makeCampaign(), CLIENT_B);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "CAMPAIGN_CLIENT_MISMATCH");
      assert.ok(r.detail.includes(CLIENT_A));
    }
  });

  test("platform=plusvibe → CAMPAIGN_PLATFORM_UNSUPPORTED", () => {
    const r = validateUploadPreconditions(makeCampaign({ platform: "plusvibe" }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "CAMPAIGN_PLATFORM_UNSUPPORTED");
      assert.ok(r.detail.includes("plusvibe"));
    }
  });

  test("platform=instantly → CAMPAIGN_PLATFORM_UNSUPPORTED", () => {
    const r = validateUploadPreconditions(makeCampaign({ platform: "instantly" }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_PLATFORM_UNSUPPORTED");
  });

  test("platformCampaignId=null → CAMPAIGN_MISSING_PLATFORM_ID", () => {
    const r = validateUploadPreconditions(makeCampaign({ platformCampaignId: null }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_MISSING_PLATFORM_ID");
  });

  test("status=running → CAMPAIGN_NOT_DRAFT", () => {
    const r = validateUploadPreconditions(makeCampaign({ status: "running" }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "CAMPAIGN_NOT_DRAFT");
      assert.ok(r.detail.includes("running"));
    }
  });

  test("status=paused → CAMPAIGN_NOT_DRAFT", () => {
    const r = validateUploadPreconditions(makeCampaign({ status: "paused" }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_DRAFT");
  });

  test("status=completed → CAMPAIGN_NOT_DRAFT", () => {
    const r = validateUploadPreconditions(makeCampaign({ status: "completed" }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_DRAFT");
  });

  test("status=cancelled → CAMPAIGN_NOT_DRAFT", () => {
    const r = validateUploadPreconditions(makeCampaign({ status: "cancelled" }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_DRAFT");
  });

  test("status=review → CAMPAIGN_NOT_DRAFT", () => {
    const r = validateUploadPreconditions(makeCampaign({ status: "review" }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_DRAFT");
  });

  test("status=ready → CAMPAIGN_NOT_DRAFT", () => {
    const r = validateUploadPreconditions(makeCampaign({ status: "ready" }), CLIENT_A);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_DRAFT");
  });

  test("valid campaign → ok=true", () => {
    const r = validateUploadPreconditions(makeCampaign(), CLIENT_A);
    assert.equal(r.ok, true);
  });

  test("validation order: null checked before client mismatch", () => {
    // null campaign should always return NOT_FOUND regardless of clientId
    const r = validateUploadPreconditions(null, CLIENT_B);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_NOT_FOUND");
  });

  test("validation order: client mismatch checked before platform", () => {
    const r = validateUploadPreconditions(
      makeCampaign({ platform: "plusvibe" }),
      CLIENT_B,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_CLIENT_MISMATCH");
  });

  test("validation order: platform checked before platformCampaignId", () => {
    const r = validateUploadPreconditions(
      makeCampaign({ platform: "plusvibe", platformCampaignId: null }),
      CLIENT_A,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_PLATFORM_UNSUPPORTED");
  });

  test("validation order: platformCampaignId checked before status", () => {
    const r = validateUploadPreconditions(
      makeCampaign({ platformCampaignId: null, status: "running" }),
      CLIENT_A,
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "CAMPAIGN_MISSING_PLATFORM_ID");
  });
});

// ── toBatchesOf ───────────────────────────────────────────────────────────────

describe("toBatchesOf", () => {
  test("0 items → []", () => {
    assert.deepEqual(toBatchesOf([], 100), []);
  });

  test("1 item → [[item]]", () => {
    assert.deepEqual(toBatchesOf([1], 100), [[1]]);
  });

  test("100 items → 1 batch of 100", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const result = toBatchesOf(items, 100);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.length, 100);
  });

  test("101 items → 2 batches (100 + 1)", () => {
    const items = Array.from({ length: 101 }, (_, i) => i);
    const result = toBatchesOf(items, 100);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.length, 100);
    assert.equal(result[1]!.length, 1);
  });

  test("200 items → 2 batches of 100", () => {
    const items = Array.from({ length: 200 }, (_, i) => i);
    const result = toBatchesOf(items, 100);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.length, 100);
    assert.equal(result[1]!.length, 100);
  });

  test("201 items → 3 batches (100 + 100 + 1)", () => {
    const items = Array.from({ length: 201 }, (_, i) => i);
    const result = toBatchesOf(items, 100);
    assert.equal(result.length, 3);
    assert.equal(result[0]!.length, 100);
    assert.equal(result[1]!.length, 100);
    assert.equal(result[2]!.length, 1);
  });

  test("items are not mutated or duplicated", () => {
    const items = [10, 20, 30];
    const result = toBatchesOf(items, 2);
    assert.deepEqual(result, [[10, 20], [30]]);
    // original unchanged
    assert.deepEqual(items, [10, 20, 30]);
  });

  test("batch size 1 → N batches of 1", () => {
    const result = toBatchesOf([1, 2, 3], 1);
    assert.equal(result.length, 3);
    assert.deepEqual(result, [[1], [2], [3]]);
  });
});

// ── buildUploadResult ─────────────────────────────────────────────────────────

describe("buildUploadResult", () => {
  function make(
    batches: BatchUploadOutcome[],
    overrides: {
      readyCount?: number;
      skippedCount?: number;
      dryRun?: boolean;
    } = {},
  ) {
    return buildUploadResult({
      campaignId:   "campaign-ccc",
      clientId:     CLIENT_A,
      startedAt:    NOW,
      readyCount:   overrides.readyCount  ?? batches.reduce((s, b) => s + b.leadsInBatch, 0),
      batches,
      skippedCount: overrides.skippedCount ?? 0,
      dryRun:       overrides.dryRun       ?? false,
    });
  }

  test("no batches → all counts zero", () => {
    const r = make([]);
    assert.equal(r.uploadedCount,  0);
    assert.equal(r.duplicateCount, 0);
    assert.equal(r.failedCount,    0);
    assert.equal(r.skippedCount,   0);
  });

  test("single successful batch: uploadedCount = uploadCount", () => {
    const r = make([makeBatch({ uploadCount: 10, duplicateCount: 0 })]);
    assert.equal(r.uploadedCount,  10);
    assert.equal(r.duplicateCount, 0);
    assert.equal(r.failedCount,    0);
  });

  test("duplicateCount is accumulated separately from uploadedCount", () => {
    const r = make([makeBatch({ uploadCount: 0, duplicateCount: 10 })]);
    assert.equal(r.uploadedCount,  0);
    assert.equal(r.duplicateCount, 10);
    assert.equal(r.failedCount,    0);
  });

  test("mixed upload_count + duplicate_count in same batch", () => {
    const r = make([makeBatch({ uploadCount: 7, duplicateCount: 3 })]);
    assert.equal(r.uploadedCount,  7);
    assert.equal(r.duplicateCount, 3);
    assert.equal(r.failedCount,    0);
  });

  test("failed batch: leadsInBatch added to failedCount, not uploadedCount", () => {
    const r = make([makeBatch({ leadsInBatch: 10, failed: true, uploadCount: 0, duplicateCount: 0 })]);
    assert.equal(r.uploadedCount,  0);
    assert.equal(r.duplicateCount, 0);
    assert.equal(r.failedCount,    10);
  });

  test("mixed batches: successful + failed", () => {
    const r = make([
      makeBatch({ batchIndex: 0, leadsInBatch: 100, uploadCount: 90, duplicateCount: 10, failed: false }),
      makeBatch({ batchIndex: 1, leadsInBatch: 1,   uploadCount: 0,  duplicateCount: 0,  failed: true }),
    ]);
    assert.equal(r.uploadedCount,  90);
    assert.equal(r.duplicateCount, 10);
    assert.equal(r.failedCount,    1);
  });

  test("multiple successful batches: counts are summed", () => {
    const r = make([
      makeBatch({ batchIndex: 0, leadsInBatch: 100, uploadCount: 100, duplicateCount: 0 }),
      makeBatch({ batchIndex: 1, leadsInBatch: 1,   uploadCount: 0,   duplicateCount: 1 }),
    ]);
    assert.equal(r.uploadedCount,  100);
    assert.equal(r.duplicateCount, 1);
    assert.equal(r.failedCount,    0);
  });

  test("readyCount is passed through unchanged", () => {
    const r = make([], { readyCount: 99 });
    assert.equal(r.readyCount, 99);
  });

  test("skippedCount is passed through unchanged", () => {
    const r = make([], { skippedCount: 3 });
    assert.equal(r.skippedCount, 3);
  });

  test("dryRun=true is reflected in result", () => {
    const r = make([], { dryRun: true });
    assert.equal(r.dryRun, true);
  });

  test("dryRun=false is reflected in result", () => {
    const r = make([]);
    assert.equal(r.dryRun, false);
  });

  test("startedAt is correct ISO string", () => {
    const r = make([]);
    assert.equal(r.startedAt, NOW.toISOString());
  });

  test("campaignId and clientId are passed through", () => {
    const r = make([]);
    assert.equal(r.campaignId, "campaign-ccc");
    assert.equal(r.clientId,   CLIENT_A);
  });

  test("batches array is included in result", () => {
    const b = makeBatch({ batchIndex: 0, leadsInBatch: 5, uploadCount: 5 });
    const r = make([b]);
    assert.equal(r.batches.length, 1);
    assert.equal(r.batches[0]!.batchIndex, 0);
    assert.equal(r.batches[0]!.leadsInBatch, 5);
  });

  test("all three batch scenarios (success / all-duplicate / failure) handled correctly", () => {
    const r = make([
      makeBatch({ batchIndex: 0, leadsInBatch: 50,  uploadCount: 50,  duplicateCount: 0,  failed: false }),
      makeBatch({ batchIndex: 1, leadsInBatch: 50,  uploadCount: 0,   duplicateCount: 50, failed: false }),
      makeBatch({ batchIndex: 2, leadsInBatch: 10,  uploadCount: 0,   duplicateCount: 0,  failed: true  }),
    ]);
    assert.equal(r.uploadedCount,  50);
    assert.equal(r.duplicateCount, 50);
    assert.equal(r.failedCount,    10);
  });
});
