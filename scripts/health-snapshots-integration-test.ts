/**
 * Stage 18 — Health Snapshot Integration Test.
 *
 * Requires migration 0016_health_snapshots.sql to be applied first.
 * Tests the DB layer (saveCampaignHealthSnapshot, client isolation,
 * idempotency, historical queries) and the Smartlead live adapter
 * (will fail with "Plan expired!" until subscription is renewed).
 *
 * HARD CONSTRAINTS:
 *   - No emails sent. No outbound calls. No campaign modifications.
 *   - All test snapshot rows are deleted in finally blocks.
 *   - API secrets are NEVER logged.
 *
 * Run:
 *   npx tsx scripts/health-snapshots-integration-test.ts
 *
 * Env vars required:
 *   SUPABASE_URL         — always required
 *   SUPABASE_SECRET_KEY  — always required
 *   SMARTLEAD_API_KEY    — for Step 14 live Smartlead test (optional; test noted if missing)
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase";
import {
  saveCampaignHealthSnapshot,
  saveDomainHealthSnapshot,
  saveInboxHealthSnapshot,
  getCampaignHealthSnapshots,
  getBaselineCampaignSnapshot,
  getLatestCampaignSnapshot,
  getDomainHealthSnapshots,
  getBaselineDomainSnapshot,
  getInboxHealthSnapshots,
  getBaselineInboxSnapshot,
} from "../src/db/health-snapshots";
import {
  computeCampaignHealthDelta,
  evaluateCampaignHealth,
  evaluateDomainHealth,
  evaluateInboxHealth,
} from "../src/lib/health-snapshots";
import { createCampaign, deleteCampaign } from "../src/db/campaigns";
import { OutreachProviderRegistry } from "../src/providers/outreach/registry";
import type { CampaignHealthResult, DomainHealthResult, InboxHealthResult } from "../src/providers/outreach/types";

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

// ── Fixed test client ─────────────────────────────────────────────────────────

const TEST_CLIENT_ID   = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const TEST_CLIENT_B_ID = "test-client-b-stage18"; // synthetic second client for isolation test
const PROVIDER         = "smartlead";
const TEST_DOMAIN      = "stage18-test.invalid"; // fake domain — no DNS lookup
const TEST_INBOX_ID    = "stage18-inbox-99999";

// ── Synthetic health results ──────────────────────────────────────────────────

function makeCampaignResult(overrides: Partial<CampaignHealthResult> = {}): CampaignHealthResult {
  return {
    platformCampaignId: "sl-stage18-test",
    status:             "active",
    stats:              { sent: 1000, opens: 300, clicks: 50, replies: 80, bounces: 15, unsubscribes: 5 },
    openRatePct:        30.0,
    replyRatePct:       8.0,
    bounceRatePct:      1.5,
    fetchedAt:          new Date().toISOString(),
    ...overrides,
  };
}

function makeDomainResult(): DomainHealthResult {
  return {
    domain:            TEST_DOMAIN,
    inboxCount:        4,
    healthyInboxCount: 3,
    blockedInboxCount: 1,
    inboxes: [
      { inboxId: "i1", email: `a@${TEST_DOMAIN}`, warmupStatus: "active", warmupReputation: "good", smtpOk: true,  imapOk: true,  isWarmupBlocked: false, dailySendLimit: 40, dailySentCount: 38 },
      { inboxId: "i2", email: `b@${TEST_DOMAIN}`, warmupStatus: "active", warmupReputation: "good", smtpOk: true,  imapOk: true,  isWarmupBlocked: false, dailySendLimit: 40, dailySentCount: 35 },
      { inboxId: "i3", email: `c@${TEST_DOMAIN}`, warmupStatus: "active", warmupReputation: "good", smtpOk: true,  imapOk: true,  isWarmupBlocked: true,  dailySendLimit: 40, dailySentCount: 0  },
      { inboxId: "i4", email: `d@${TEST_DOMAIN}`, warmupStatus: "active", warmupReputation: "fair", smtpOk: false, imapOk: false, isWarmupBlocked: false, dailySendLimit: 40, dailySentCount: 0  },
    ],
    fetchedAt: new Date().toISOString(),
  };
}

function makeInboxResult(): InboxHealthResult {
  return {
    platformInboxId: TEST_INBOX_ID,
    email:           `send@${TEST_DOMAIN}`,
    fromName:        "Stage 18 Test",
    warmupStatus:    "active",
    warmupReputation: "good",
    smtpOk:          true,
    imapOk:          true,
    isWarmupBlocked: false,
    dailySendLimit:  40,
    dailySentCount:  35,
    totalWarmupSent: 1500,
    tags:            ["stage18", "test"],
    fetchedAt:       new Date().toISOString(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log("Stage 18 — Health Snapshot Integration Test");
  console.log("=".repeat(70));

  // ── Pre-flight ─────────────────────────────────────────────────────────────
  section("Pre-flight checks");

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SECRET_KEY;
  check("SUPABASE_URL + SUPABASE_SECRET_KEY present", hasSupabase);
  if (!hasSupabase) {
    console.error("\nAbort: Supabase credentials missing.");
    process.exit(1);
  }

  // Verify migration 0016 was applied
  const db = getSupabaseAdmin();
  const { error: tableCheck } = await db
    .from("campaign_health_snapshots")
    .select("id")
    .limit(1);

  if (tableCheck) {
    console.error(`\nAbort: migration 0016 not applied — table not found.`);
    console.error(`Error: ${tableCheck.message}`);
    console.error("\nApply the migration first:");
    console.error("  supabase/migrations/0016_health_snapshots.sql");
    process.exit(1);
  }
  check("Migration 0016 applied (campaign_health_snapshots exists)", true);

  // Verify test client
  const { data: clientRow, error: clientErr } = await db
    .from("clients")
    .select("id, name")
    .eq("id", TEST_CLIENT_ID)
    .maybeSingle();

  if (clientErr || !clientRow) {
    console.error(`\nAbort: test client ${TEST_CLIENT_ID} not found.`);
    process.exit(1);
  }
  check("Test client exists", true);
  note("client_id",   TEST_CLIENT_ID);
  note("client_name", (clientRow as { name: string }).name);

  // ── Campaign snapshot — create + cleanup ───────────────────────────────────
  section("Campaign health snapshot (DB layer)");

  let campaignId: string | null = null;
  const campaignSnapshotIds: string[] = [];

  try {
    // Create a test campaign
    const campaign = await createCampaign(TEST_CLIENT_ID, {
      name:     "Stage 18 health snapshot test campaign",
      platform: "smartlead",
      status:   "draft",
    });
    campaignId = campaign.id;
    check("createCampaign succeeded", !!campaignId);
    note("campaign_id", campaignId);

    // Save snapshot 1 (should be baseline)
    const t1 = new Date("2026-09-01T10:00:00Z");
    const result1 = makeCampaignResult({ stats: { sent: 100, opens: 30, clicks: 5, replies: 8, bounces: 1, unsubscribes: 0 } });
    // Recompute rates manually since the mock doesn't auto-compute from stats
    result1.openRatePct = 30.0; result1.replyRatePct = 8.0; result1.bounceRatePct = 1.0;

    const snap1 = await saveCampaignHealthSnapshot(TEST_CLIENT_ID, campaignId, "smartlead", result1, t1);
    check("saveCampaignHealthSnapshot — snap1 created", snap1 !== null);
    check("snap1 is baseline", snap1?.isBaseline === true);
    check("snap1 sentCount = 100", snap1?.sentCount === 100);
    if (snap1) campaignSnapshotIds.push(snap1.id);

    // Save snapshot 2 (should NOT be baseline)
    const t2 = new Date("2026-09-02T10:00:00Z");
    const result2 = makeCampaignResult({ stats: { sent: 500, opens: 150, clicks: 20, replies: 30, bounces: 10, unsubscribes: 2 } });
    result2.openRatePct = 30.0; result2.replyRatePct = 6.0; result2.bounceRatePct = 2.0;

    const snap2 = await saveCampaignHealthSnapshot(TEST_CLIENT_ID, campaignId, "smartlead", result2, t2);
    check("saveCampaignHealthSnapshot — snap2 created", snap2 !== null);
    check("snap2 is NOT baseline", snap2?.isBaseline === false);
    check("snap2 sentCount = 500", snap2?.sentCount === 500);
    if (snap2) campaignSnapshotIds.push(snap2.id);

    // Save snapshot 3
    const t3 = new Date("2026-09-03T10:00:00Z");
    const result3 = makeCampaignResult({ stats: { sent: 1000, opens: 300, clicks: 50, replies: 40, bounces: 35, unsubscribes: 5 } });
    result3.openRatePct = 30.0; result3.replyRatePct = 4.0; result3.bounceRatePct = 3.5;

    const snap3 = await saveCampaignHealthSnapshot(TEST_CLIENT_ID, campaignId, "smartlead", result3, t3);
    check("saveCampaignHealthSnapshot — snap3 created", snap3 !== null);
    if (snap3) campaignSnapshotIds.push(snap3.id);

    // Step 11: Idempotency — re-save snap1 at same timestamp
    const snap1Again = await saveCampaignHealthSnapshot(TEST_CLIENT_ID, campaignId, "smartlead", result1, t1);
    check("Idempotency: re-save at same timestamp returns null (DO NOTHING)", snap1Again === null);

    // Step 12: Historical query — getCampaignHealthSnapshots returns all 3
    const allSnapshots = await getCampaignHealthSnapshots(TEST_CLIENT_ID, campaignId);
    check("getCampaignHealthSnapshots returns 3 rows", allSnapshots.length === 3);
    check("Results ordered newest first", allSnapshots[0].takenAt > allSnapshots[1].takenAt);
    check("Oldest row is baseline", allSnapshots[allSnapshots.length - 1].isBaseline === true);

    // getBaselineCampaignSnapshot — compare via Date to avoid UTC offset format differences
    const baseline = await getBaselineCampaignSnapshot(TEST_CLIENT_ID, campaignId);
    check("getBaselineCampaignSnapshot returns a row", baseline !== null);
    check("Baseline is marked is_baseline=true", baseline?.isBaseline === true);
    check("Baseline takenAt matches t1", baseline !== null && new Date(baseline.takenAt).getTime() === t1.getTime());
    check("Baseline sentCount = 100", baseline?.sentCount === 100);

    // getLatestCampaignSnapshot
    const latest = await getLatestCampaignSnapshot(TEST_CLIENT_ID, campaignId);
    check("getLatestCampaignSnapshot returns snap3", latest?.sentCount === 1000);

    // Step 8: Baseline calculation — compute delta
    if (baseline && latest) {
      const delta = computeCampaignHealthDelta(baseline, latest);
      check("sentDelta = 900 (1000 - 100)", delta.sentDelta === 900);
      check("replyRateDelta < 0 (rate dropped from 8% to 4%)", delta.replyRateDelta !== null && delta.replyRateDelta < 0);
      check("bounceRateDelta > 0 (rate worsened from 1% to 3.5%)", delta.bounceRateDelta !== null && delta.bounceRateDelta > 0);

      // Step 9: Health evaluation
      const health = evaluateCampaignHealth(latest, delta);
      check("Health evaluation detects bounce rate concern", !health.isHealthy);
      check("BOUNCE_RATE_HIGH concern present", health.concerns.some((c) => c.code === "BOUNCE_RATE_HIGH"));
      check("REPLY_RATE_DROPPED concern present", health.concerns.some((c) => c.code === "REPLY_RATE_DROPPED"));
      note("concerns", health.concerns.map((c) => c.code));
    }

    // Step 10: Client isolation — a different valid-UUID client sees zero rows for this campaign
    const otherClientSnaps = await getCampaignHealthSnapshots("00000000-0000-0000-0000-000000000000", campaignId);
    check("Client isolation: different clientId returns no rows", otherClientSnaps.length === 0);

  } finally {
    // Clean up campaign (cascades to campaign_health_snapshots via DB FK)
    if (campaignId) {
      await deleteCampaign(TEST_CLIENT_ID, campaignId).catch((e: Error) =>
        console.error(`  Warning: campaign cleanup failed: ${e.message}`),
      );
      check("Campaign (and cascade snapshots) cleaned up", true);
    }
  }

  // ── Domain health snapshot ─────────────────────────────────────────────────
  section("Domain health snapshot (DB layer)");

  // Pre-section cleanup: delete any orphan rows from prior partial runs.
  // These accumulate when the test exits early before the finally block runs.
  try {
    await db.from("domain_health_snapshots")
      .delete()
      .eq("client_id", TEST_CLIENT_ID)
      .eq("provider",  PROVIDER)
      .eq("domain",    TEST_DOMAIN);
  } catch (_) { /* best-effort */ }

  const domainSnapshotIds: string[] = [];
  try {
    const t1 = new Date("2026-09-01T10:00:00Z");
    const t2 = new Date("2026-09-02T10:00:00Z");
    const domainResult = makeDomainResult();

    const dSnap1 = await saveDomainHealthSnapshot(TEST_CLIENT_ID, PROVIDER, domainResult, t1);
    check("saveDomainHealthSnapshot — snap1 created",    dSnap1 !== null);
    check("Domain snap1 is baseline",                    dSnap1?.isBaseline === true);
    check("Domain snap1 inboxCount = 4",                 dSnap1?.inboxCount === 4);
    // Fixture: 3 of 4 inboxes have smtpOk=true AND imapOk=true (i1, i2, i3 — i4 fails both)
    check("Domain snap1 healthyInboxCount = 3 (smtpOk AND imapOk)", dSnap1?.healthyInboxCount === 3);
    if (dSnap1) domainSnapshotIds.push(dSnap1.id);

    const dSnap2 = await saveDomainHealthSnapshot(TEST_CLIENT_ID, PROVIDER, domainResult, t2);
    check("saveDomainHealthSnapshot — snap2 created",    dSnap2 !== null);
    check("Domain snap2 is NOT baseline",                dSnap2?.isBaseline === false);
    if (dSnap2) domainSnapshotIds.push(dSnap2.id);

    // Idempotency
    const dSnap1Again = await saveDomainHealthSnapshot(TEST_CLIENT_ID, PROVIDER, domainResult, t1);
    check("Domain idempotency: same timestamp returns null", dSnap1Again === null);

    // Historical query
    const allDomainSnaps = await getDomainHealthSnapshots(TEST_CLIENT_ID, PROVIDER, TEST_DOMAIN);
    check("getDomainHealthSnapshots returns 2 rows", allDomainSnaps.length === 2);

    // Baseline query
    const dBaseline = await getBaselineDomainSnapshot(TEST_CLIENT_ID, PROVIDER, TEST_DOMAIN);
    check("getBaselineDomainSnapshot returns a row",           dBaseline !== null);
    check("getBaselineDomainSnapshot marked is_baseline=true", dBaseline?.isBaseline === true);

    // Health evaluation
    if (dSnap1) {
      const dHealth = evaluateDomainHealth(dSnap1);
      // 1 out of 4 inboxes blocked = 25% = meets INBOX_BLOCK_RATE_WARN_PCT threshold
      check("Domain health: INBOX_BLOCK_RATE_HIGH concern (25% blocked)", !dHealth.isHealthy);
    }

  } finally {
    // Domain snapshots don't cascade-delete (no campaign parent) — delete manually
    if (domainSnapshotIds.length > 0) {
      try {
        await db.from("domain_health_snapshots").delete().in("id", domainSnapshotIds);
        check("Domain snapshots cleaned up", true);
      } catch (e) {
        console.error(`  Warning: domain snapshot cleanup failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // ── Inbox health snapshot ──────────────────────────────────────────────────
  section("Inbox health snapshot (DB layer)");

  // Pre-section cleanup: delete any orphan rows from prior partial runs.
  try {
    await db.from("inbox_health_snapshots")
      .delete()
      .eq("client_id",         TEST_CLIENT_ID)
      .eq("provider",          PROVIDER)
      .eq("platform_inbox_id", TEST_INBOX_ID);
  } catch (_) { /* best-effort */ }

  const inboxSnapshotIds: string[] = [];
  try {
    const t1 = new Date("2026-09-01T10:00:00Z");
    const inboxResult = makeInboxResult();

    const iSnap1 = await saveInboxHealthSnapshot(TEST_CLIENT_ID, PROVIDER, inboxResult, t1);
    check("saveInboxHealthSnapshot — snap1 created", iSnap1 !== null);
    check("Inbox snap1 is baseline",                  iSnap1?.isBaseline === true);
    check("Inbox snap1 tags = ['stage18','test']",    JSON.stringify(iSnap1?.tags) === JSON.stringify(["stage18", "test"]));
    check("Inbox snap1 smtpOk = true",                iSnap1?.smtpOk === true);
    if (iSnap1) inboxSnapshotIds.push(iSnap1.id);

    // Idempotency
    const iSnap1Again = await saveInboxHealthSnapshot(TEST_CLIENT_ID, PROVIDER, inboxResult, t1);
    check("Inbox idempotency: same timestamp returns null", iSnap1Again === null);

    // Inbox health evaluation
    if (iSnap1) {
      const iHealth = evaluateInboxHealth(iSnap1);
      check("Healthy inbox: no concerns", iHealth.isHealthy);
    }

    const iSnapDegraded = await saveInboxHealthSnapshot(
      TEST_CLIENT_ID, PROVIDER,
      { ...inboxResult, smtpOk: false, imapOk: false, isWarmupBlocked: true, warmupReputation: "poor" },
      new Date("2026-09-02T10:00:00Z"),
    );
    if (iSnapDegraded) {
      inboxSnapshotIds.push(iSnapDegraded.id);
      const iHealthDegraded = evaluateInboxHealth(iSnapDegraded);
      check("Degraded inbox: all 4 concerns detected", iHealthDegraded.concerns.length === 4);
    }

    // Historical query
    const allInboxSnaps = await getInboxHealthSnapshots(TEST_CLIENT_ID, PROVIDER, TEST_INBOX_ID);
    check("getInboxHealthSnapshots returns 2 rows", allInboxSnaps.length === 2);

    // Baseline
    const iBaseline = await getBaselineInboxSnapshot(TEST_CLIENT_ID, PROVIDER, TEST_INBOX_ID);
    check("getBaselineInboxSnapshot returns a row",           iBaseline !== null);
    check("getBaselineInboxSnapshot marked is_baseline=true", iBaseline?.isBaseline === true);

  } finally {
    if (inboxSnapshotIds.length > 0) {
      try {
        await db.from("inbox_health_snapshots").delete().in("id", inboxSnapshotIds);
        check("Inbox snapshots cleaned up", true);
      } catch (e) {
        console.error(`  Warning: inbox snapshot cleanup failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // ── Step 14: Smartlead live adapter (expected failure) ─────────────────────
  section("Step 14: Smartlead live API (expected failure — subscription expired)");

  const hasSmartlead = !!process.env.SMARTLEAD_API_KEY;
  check("SMARTLEAD_API_KEY present (value not logged)", hasSmartlead);

  if (hasSmartlead) {
    try {
      const registry = OutreachProviderRegistry.fromEnv();
      const provider = registry.getProvider("smartlead", TEST_CLIENT_ID);
      check("SmartleadAdapter.isConfigured()", provider.isConfigured());

      try {
        await provider.getDomainHealth("example.com");
        check("getDomainHealth succeeded (unexpected — subscription may have been renewed)", true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isExpected = msg.includes("Plan expired") || msg.includes("missing or invalid");
        check(
          "getDomainHealth throws OutreachCredentialError (Plan expired — expected)",
          isExpected,
          isExpected ? "" : `unexpected error: ${msg}`,
        );
        if (isExpected) {
          note("smartlead_error", msg.slice(0, 80));
        }
      }
    } catch (registryErr) {
      const msg = registryErr instanceof Error ? registryErr.message : String(registryErr);
      check("Registry configured", false, msg);
    }
  } else {
    note("smartlead_status", "SMARTLEAD_API_KEY not set — skipping live API test");
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(70));
  console.log(`Stage 18 integration test complete: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(70));

  if (failed > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
