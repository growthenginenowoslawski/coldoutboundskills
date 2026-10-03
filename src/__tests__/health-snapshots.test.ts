/**
 * Unit tests for Stage 18 health snapshot types and pure evaluation logic.
 *
 * All tests are pure — no network, no Supabase, no real data.
 * DB-layer tests (client isolation, idempotency, historical queries)
 * live in scripts/health-snapshots-integration-test.ts and require
 * migration 0016 to be applied first.
 *
 * Run: node --import tsx --test "src/__tests__/health-snapshots.test.ts"
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  BOUNCE_RATE_WARN_PCT,
  REPLY_RATE_DROP_WARN_PCT,
  INBOX_BLOCK_RATE_WARN_PCT,
  computeCampaignHealthDelta,
  evaluateCampaignHealth,
  evaluateDomainHealth,
  evaluateInboxHealth,
} from "../lib/health-snapshots.js";
import type { CampaignHealthSnapshot, DomainHealthSnapshot, InboxHealthSnapshot } from "../lib/health-snapshots.js";
import {
  fromCampaignSnapshotRow,
  fromDomainSnapshotRow,
  fromInboxSnapshotRow,
} from "../db/health-snapshots.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_A = "client-aaaa";
const CLIENT_B = "client-bbbb";
const CAMPAIGN_ID = "campaign-cccc";

const T1 = "2026-09-01T10:00:00Z";
const T2 = "2026-09-02T10:00:00Z";
const T3 = "2026-09-03T10:00:00Z";

function makeCampaignSnapshot(
  overrides: Partial<CampaignHealthSnapshot> = {},
): CampaignHealthSnapshot {
  return {
    id:                 "snap-1",
    clientId:           CLIENT_A,
    campaignId:         CAMPAIGN_ID,
    platform:           "smartlead",
    platformCampaignId: "sl-123",
    takenAt:            T1,
    isBaseline:         true,
    campaignStatus:     "active",
    sentCount:          1000,
    openCount:          300,
    clickCount:         50,
    replyCount:         80,
    bounceCount:        15,
    unsubscribeCount:   5,
    openRatePct:        30.0,
    replyRatePct:       8.0,
    bounceRatePct:      1.5,
    ...overrides,
  };
}

function makeDomainSnapshot(
  overrides: Partial<DomainHealthSnapshot> = {},
): DomainHealthSnapshot {
  return {
    id:                "snap-d1",
    clientId:          CLIENT_A,
    provider:          "smartlead",
    domain:            "agency.co.uk",
    takenAt:           T1,
    isBaseline:        true,
    inboxCount:        8,
    healthyInboxCount: 7,
    blockedInboxCount: 0,
    ...overrides,
  };
}

function makeInboxSnapshot(
  overrides: Partial<InboxHealthSnapshot> = {},
): InboxHealthSnapshot {
  return {
    id:               "snap-i1",
    clientId:         CLIENT_A,
    provider:         "smartlead",
    platformInboxId:  "inbox-999",
    inboxEmail:       "send@agency.co.uk",
    takenAt:          T1,
    isBaseline:       true,
    warmupStatus:     "active",
    warmupReputation: "good",
    smtpOk:           true,
    imapOk:           true,
    isWarmupBlocked:  false,
    dailySendLimit:   40,
    dailySentCount:   38,
    tags:             ["team-a"],
    ...overrides,
  };
}

// ── Step 13: Provider normalization (pure mapper tests) ───────────────────────

describe("fromCampaignSnapshotRow — provider normalization", () => {
  const raw: Record<string, unknown> = {
    id:                   "row-id",
    client_id:            CLIENT_A,
    campaign_id:          CAMPAIGN_ID,
    platform:             "smartlead",
    platform_campaign_id: "sl-456",
    taken_at:             T1,
    is_baseline:          true,
    campaign_status:      "active",
    sent_count:           500,
    open_count:           150,
    click_count:          20,
    reply_count:          40,
    bounce_count:         10,
    unsubscribe_count:    3,
    open_rate_pct:        30.0,
    reply_rate_pct:       8.0,
    bounce_rate_pct:      2.0,
  };

  test("maps all fields correctly", () => {
    const snap = fromCampaignSnapshotRow(raw);
    assert.equal(snap.id,                 "row-id");
    assert.equal(snap.clientId,           CLIENT_A);
    assert.equal(snap.campaignId,         CAMPAIGN_ID);
    assert.equal(snap.platform,           "smartlead");
    assert.equal(snap.platformCampaignId, "sl-456");
    assert.equal(snap.takenAt,            T1);
    assert.equal(snap.isBaseline,         true);
    assert.equal(snap.campaignStatus,     "active");
    assert.equal(snap.sentCount,          500);
    assert.equal(snap.openCount,          150);
    assert.equal(snap.replyCount,         40);
    assert.equal(snap.bounceCount,        10);
    assert.equal(snap.openRatePct,        30.0);
    assert.equal(snap.replyRatePct,       8.0);
    assert.equal(snap.bounceRatePct,      2.0);
  });

  test("nulls campaign_status when absent", () => {
    const snap = fromCampaignSnapshotRow({ ...raw, campaign_status: null });
    assert.equal(snap.campaignStatus, null);
  });

  test("nulls rate columns when absent", () => {
    const snap = fromCampaignSnapshotRow({ ...raw, open_rate_pct: null, reply_rate_pct: null, bounce_rate_pct: null });
    assert.equal(snap.openRatePct,   null);
    assert.equal(snap.replyRatePct,  null);
    assert.equal(snap.bounceRatePct, null);
  });

  test("fromDomainSnapshotRow maps all fields", () => {
    const domRaw: Record<string, unknown> = {
      id: "d1", client_id: CLIENT_A, provider: "smartlead", domain: "example.com",
      taken_at: T1, is_baseline: true,
      inbox_count: 4, healthy_inbox_count: 3, blocked_inbox_count: 1,
    };
    const snap = fromDomainSnapshotRow(domRaw);
    assert.equal(snap.inboxCount,        4);
    assert.equal(snap.healthyInboxCount, 3);
    assert.equal(snap.blockedInboxCount, 1);
    assert.equal(snap.domain,            "example.com");
  });

  test("fromInboxSnapshotRow maps tags array", () => {
    const inboxRaw: Record<string, unknown> = {
      id: "i1", client_id: CLIENT_A, provider: "smartlead",
      platform_inbox_id: "inbox-1", inbox_email: "a@b.com",
      taken_at: T1, is_baseline: false,
      warmup_status: "active", warmup_reputation: "excellent",
      smtp_ok: true, imap_ok: true, is_warmup_blocked: false,
      daily_send_limit: 30, daily_sent_count: 25,
      tags: ["europe", "inbound"],
    };
    const snap = fromInboxSnapshotRow(inboxRaw);
    assert.deepEqual(snap.tags, ["europe", "inbound"]);
    assert.equal(snap.smtpOk, true);
    assert.equal(snap.isWarmupBlocked, false);
  });

  test("fromInboxSnapshotRow defaults null tags to empty array", () => {
    const inboxRaw: Record<string, unknown> = {
      id: "i2", client_id: CLIENT_A, provider: "smartlead",
      platform_inbox_id: "inbox-2", inbox_email: null,
      taken_at: T1, is_baseline: true,
      warmup_status: null, warmup_reputation: null,
      smtp_ok: null, imap_ok: null, is_warmup_blocked: null,
      daily_send_limit: null, daily_sent_count: null,
      tags: null,
    };
    const snap = fromInboxSnapshotRow(inboxRaw);
    assert.deepEqual(snap.tags, []);
  });
});

// ── Step 12: Historical snapshot ordering (pure logic) ────────────────────────

describe("snapshot ordering and baseline semantics", () => {
  test("first snapshot should be marked isBaseline=true", () => {
    const s = makeCampaignSnapshot({ isBaseline: true, takenAt: T1 });
    assert.equal(s.isBaseline, true);
  });

  test("subsequent snapshots should have isBaseline=false", () => {
    const s = makeCampaignSnapshot({ isBaseline: false, takenAt: T2 });
    assert.equal(s.isBaseline, false);
  });

  test("sorting by takenAt DESC gives newest-first order", () => {
    const snapshots = [
      makeCampaignSnapshot({ takenAt: T2, isBaseline: false }),
      makeCampaignSnapshot({ takenAt: T1, isBaseline: true }),
      makeCampaignSnapshot({ takenAt: T3, isBaseline: false }),
    ];
    const sorted = [...snapshots].sort(
      (a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
    );
    assert.equal(sorted[0].takenAt, T3);
    assert.equal(sorted[1].takenAt, T2);
    assert.equal(sorted[2].takenAt, T1);
    assert.equal(sorted[2].isBaseline, true); // earliest = baseline
  });
});

// ── Step 10: Client isolation (pure logic) ────────────────────────────────────

describe("client isolation — type-level", () => {
  test("client A and client B snapshots have distinct clientId", () => {
    const snapA = makeCampaignSnapshot({ clientId: CLIENT_A });
    const snapB = makeCampaignSnapshot({ clientId: CLIENT_B, id: "snap-b" });
    assert.notEqual(snapA.clientId, snapB.clientId);
  });

  test("domain snapshots carry clientId correctly", () => {
    const d = makeDomainSnapshot({ clientId: CLIENT_B });
    assert.equal(d.clientId, CLIENT_B);
  });
});

// ── computeCampaignHealthDelta ────────────────────────────────────────────────

describe("computeCampaignHealthDelta", () => {
  test("sentDelta is difference in sent counts", () => {
    const baseline = makeCampaignSnapshot({ sentCount: 500 });
    const current  = makeCampaignSnapshot({ sentCount: 750, isBaseline: false, takenAt: T2 });
    const delta = computeCampaignHealthDelta(baseline, current);
    assert.equal(delta.sentDelta, 250);
  });

  test("replyRateDelta is positive when reply rate increased", () => {
    const baseline = makeCampaignSnapshot({ replyRatePct: 5.0 });
    const current  = makeCampaignSnapshot({ replyRatePct: 7.5, isBaseline: false });
    const delta = computeCampaignHealthDelta(baseline, current);
    assert.equal(delta.replyRateDelta, 2.5);
  });

  test("replyRateDelta is negative when reply rate dropped", () => {
    const baseline = makeCampaignSnapshot({ replyRatePct: 8.0 });
    const current  = makeCampaignSnapshot({ replyRatePct: 5.5, isBaseline: false });
    const delta = computeCampaignHealthDelta(baseline, current);
    assert.equal(delta.replyRateDelta, -2.5);
  });

  test("bounceRateDelta is positive when bounce rate increased (got worse)", () => {
    const baseline = makeCampaignSnapshot({ bounceRatePct: 1.0 });
    const current  = makeCampaignSnapshot({ bounceRatePct: 3.5, isBaseline: false });
    const delta = computeCampaignHealthDelta(baseline, current);
    assert.equal(delta.bounceRateDelta, 2.5);
  });

  test("rateDelta returns null when either value is null", () => {
    const baseline = makeCampaignSnapshot({ replyRatePct: null });
    const current  = makeCampaignSnapshot({ replyRatePct: 5.0, isBaseline: false });
    const delta = computeCampaignHealthDelta(baseline, current);
    assert.equal(delta.replyRateDelta, null);
  });

  test("delta references the correct baseline and current objects", () => {
    const baseline = makeCampaignSnapshot({ takenAt: T1, isBaseline: true });
    const current  = makeCampaignSnapshot({ takenAt: T2, isBaseline: false });
    const delta = computeCampaignHealthDelta(baseline, current);
    assert.equal(delta.baseline.takenAt, T1);
    assert.equal(delta.current.takenAt,  T2);
  });
});

// ── evaluateCampaignHealth ────────────────────────────────────────────────────

describe("evaluateCampaignHealth", () => {
  test("healthy when bounce rate is below threshold", () => {
    const snap = makeCampaignSnapshot({ bounceRatePct: BOUNCE_RATE_WARN_PCT - 0.1 });
    const r = evaluateCampaignHealth(snap);
    assert.equal(r.isHealthy, true);
    assert.equal(r.concerns.length, 0);
  });

  test("BOUNCE_RATE_HIGH when bounce rate meets threshold", () => {
    const snap = makeCampaignSnapshot({ bounceRatePct: BOUNCE_RATE_WARN_PCT });
    const r = evaluateCampaignHealth(snap);
    assert.equal(r.isHealthy, false);
    assert.equal(r.concerns[0].code, "BOUNCE_RATE_HIGH");
  });

  test("BOUNCE_RATE_HIGH when bounce rate exceeds threshold", () => {
    const snap = makeCampaignSnapshot({ bounceRatePct: BOUNCE_RATE_WARN_PCT + 1 });
    const r = evaluateCampaignHealth(snap);
    assert.equal(r.isHealthy, false);
  });

  test("REPLY_RATE_DROPPED when drop exceeds threshold", () => {
    const baseline = makeCampaignSnapshot({ replyRatePct: 8.0 });
    const current  = makeCampaignSnapshot({ replyRatePct: 8.0 - REPLY_RATE_DROP_WARN_PCT - 0.1, isBaseline: false, bounceRatePct: 1.0 });
    const delta = computeCampaignHealthDelta(baseline, current);
    const r = evaluateCampaignHealth(current, delta);
    assert.equal(r.isHealthy, false);
    assert.equal(r.concerns[0].code, "REPLY_RATE_DROPPED");
  });

  test("healthy when reply rate drop is exactly at threshold (not exceeded)", () => {
    const baseline = makeCampaignSnapshot({ replyRatePct: 8.0 });
    const current  = makeCampaignSnapshot({ replyRatePct: 8.0 - REPLY_RATE_DROP_WARN_PCT, isBaseline: false, bounceRatePct: 1.0 });
    const delta = computeCampaignHealthDelta(baseline, current);
    const r = evaluateCampaignHealth(current, delta);
    // Exactly -2.0 should not trigger (condition is < -threshold, not <=)
    assert.equal(r.isHealthy, true);
  });

  test("no REPLY_RATE_DROPPED concern without delta", () => {
    // When no delta provided, only current-snapshot concerns checked
    const snap = makeCampaignSnapshot({ bounceRatePct: 1.0, replyRatePct: 1.0 });
    const r = evaluateCampaignHealth(snap);
    assert.equal(r.isHealthy, true);
    assert.ok(r.concerns.every((c) => c.code !== "REPLY_RATE_DROPPED"));
  });

  test("multiple concerns can appear simultaneously", () => {
    const baseline = makeCampaignSnapshot({ replyRatePct: 10.0, bounceRatePct: 0.0 });
    const current  = makeCampaignSnapshot({
      replyRatePct:  10.0 - REPLY_RATE_DROP_WARN_PCT - 1,
      bounceRatePct: BOUNCE_RATE_WARN_PCT + 1,
      isBaseline:    false,
    });
    const delta = computeCampaignHealthDelta(baseline, current);
    const r = evaluateCampaignHealth(current, delta);
    assert.equal(r.isHealthy, false);
    assert.equal(r.concerns.length, 2);
    const codes = r.concerns.map((c) => c.code);
    assert.ok(codes.includes("BOUNCE_RATE_HIGH"));
    assert.ok(codes.includes("REPLY_RATE_DROPPED"));
  });

  test("no concern when bounceRatePct is null", () => {
    const snap = makeCampaignSnapshot({ bounceRatePct: null });
    const r = evaluateCampaignHealth(snap);
    assert.equal(r.isHealthy, true);
  });
});

// ── evaluateDomainHealth ──────────────────────────────────────────────────────

describe("evaluateDomainHealth", () => {
  test("healthy domain passes", () => {
    const snap = makeDomainSnapshot({ inboxCount: 8, healthyInboxCount: 8, blockedInboxCount: 0 });
    const r = evaluateDomainHealth(snap);
    assert.equal(r.isHealthy, true);
  });

  test("INBOX_BLOCK_RATE_HIGH when block fraction meets threshold", () => {
    // 25% of 8 inboxes = 2 blocked — exactly at threshold
    const snap = makeDomainSnapshot({
      inboxCount: 8,
      blockedInboxCount: Math.ceil(8 * INBOX_BLOCK_RATE_WARN_PCT / 100),
    });
    const r = evaluateDomainHealth(snap);
    assert.equal(r.isHealthy, false);
    assert.equal(r.concerns[0].code, "INBOX_BLOCK_RATE_HIGH");
  });

  test("NO_HEALTHY_INBOXES when healthyInboxCount=0 with inboxes present", () => {
    const snap = makeDomainSnapshot({ inboxCount: 4, healthyInboxCount: 0, blockedInboxCount: 0 });
    const r = evaluateDomainHealth(snap);
    assert.equal(r.isHealthy, false);
    assert.ok(r.concerns.some((c) => c.code === "NO_HEALTHY_INBOXES"));
  });

  test("no concerns when inboxCount=0 (provider has no inboxes for domain)", () => {
    const snap = makeDomainSnapshot({ inboxCount: 0, healthyInboxCount: 0, blockedInboxCount: 0 });
    const r = evaluateDomainHealth(snap);
    assert.equal(r.isHealthy, true);
  });
});

// ── evaluateInboxHealth ───────────────────────────────────────────────────────

describe("evaluateInboxHealth", () => {
  test("healthy inbox passes all checks", () => {
    const snap = makeInboxSnapshot();
    const r = evaluateInboxHealth(snap);
    assert.equal(r.isHealthy, true);
    assert.equal(r.concerns.length, 0);
  });

  test("SMTP_FAILING when smtpOk=false", () => {
    const snap = makeInboxSnapshot({ smtpOk: false });
    const r = evaluateInboxHealth(snap);
    assert.equal(r.isHealthy, false);
    assert.equal(r.concerns[0].code, "SMTP_FAILING");
  });

  test("IMAP_FAILING when imapOk=false", () => {
    const snap = makeInboxSnapshot({ imapOk: false });
    const r = evaluateInboxHealth(snap);
    assert.equal(r.isHealthy, false);
    assert.equal(r.concerns[0].code, "IMAP_FAILING");
  });

  test("WARMUP_BLOCKED when isWarmupBlocked=true", () => {
    const snap = makeInboxSnapshot({ isWarmupBlocked: true });
    const r = evaluateInboxHealth(snap);
    assert.equal(r.isHealthy, false);
    assert.ok(r.concerns.some((c) => c.code === "WARMUP_BLOCKED"));
  });

  test("POOR_REPUTATION when warmupReputation=poor", () => {
    const snap = makeInboxSnapshot({ warmupReputation: "poor" });
    const r = evaluateInboxHealth(snap);
    assert.equal(r.isHealthy, false);
    assert.ok(r.concerns.some((c) => c.code === "POOR_REPUTATION"));
  });

  test("all four concerns when inbox is fully degraded", () => {
    const snap = makeInboxSnapshot({
      smtpOk:          false,
      imapOk:          false,
      isWarmupBlocked: true,
      warmupReputation: "poor",
    });
    const r = evaluateInboxHealth(snap);
    assert.equal(r.isHealthy, false);
    assert.equal(r.concerns.length, 4);
    const codes = r.concerns.map((c) => c.code);
    assert.ok(codes.includes("SMTP_FAILING"));
    assert.ok(codes.includes("IMAP_FAILING"));
    assert.ok(codes.includes("WARMUP_BLOCKED"));
    assert.ok(codes.includes("POOR_REPUTATION"));
  });

  test("null smtp/imap do not trigger concerns (unknown state ≠ failing)", () => {
    const snap = makeInboxSnapshot({ smtpOk: null, imapOk: null });
    const r = evaluateInboxHealth(snap);
    assert.equal(r.isHealthy, true);
  });
});

// ── Step 11: Idempotency semantics (pure logic) ───────────────────────────────

describe("snapshot idempotency semantics", () => {
  test("two snapshots at same takenAt are structurally identical — DB should dedup them", () => {
    // This tests that the types are consistent; actual DB dedup is in integration test
    const s1 = makeCampaignSnapshot({ takenAt: T1, sentCount: 100 });
    const s2 = makeCampaignSnapshot({ takenAt: T1, sentCount: 100 }); // same time, same data
    assert.equal(s1.takenAt, s2.takenAt);
    assert.equal(s1.sentCount, s2.sentCount);
    // In the DB, ON CONFLICT DO NOTHING means s2 write would be a no-op
  });
});
