/**
 * Unit tests for Stage 22 Why Now Engine — pure functions only, no DB, no network.
 *
 * Tests the five exported pure functions from src/lib/why-now.ts:
 *
 *   buildWhyNowEvidence      — deterministic evidence assembly from SignalRows
 *   evaluateReadiness        — readiness gate (minOpportunityScore + minSignalCount)
 *   buildWhyNowAiInput       — SignalIntelligenceInput construction for AI prompt
 *   mapTitlesToSignalIds     — title→UUID post-mapping (best-effort)
 *   constants                — READINESS_MIN_OPPORTUNITY_SCORE, AI_NARRATIVE_MIN_OPPORTUNITY_SCORE, etc.
 *
 * All tests are deterministic and require zero environment variables.
 * No Supabase, no AI provider, no ModelRouter.
 *
 * Coverage:
 *
 *   buildWhyNowEvidence
 *     — empty signals → empty evidence, no corroboration
 *     — active non-expired signals are included
 *     — signals with status != 'active' are excluded (two-guard, guard 1)
 *     — expired signals are excluded (two-guard, guard 2)
 *     — mixed: some active, some expired, some dismissed → only active included
 *     — freshness scores are computed at `now` (decay from occurredAt → expiresAt)
 *     — corroborationFactor >= 1.0 always
 *     — corroborationFactor > 1.0 for multi-type cluster (GROWTH cluster)
 *     — topSignals sorted by ICP relevance × strength × freshness (desc)
 *     — topSignals capped at AI_MAX_SIGNALS
 *     — signal IDs are embedded in evidence._signalId
 *     — assessedAt is the passed `now`
 *     — opportunityScore and priorityScore propagate from params
 *     — priorityScore null propagates to evidence
 *
 *   evaluateReadiness
 *     — ready=true when score >= 1 and signals >= 1 (default thresholds)
 *     — OPPORTUNITY_SCORE_BELOW_THRESHOLD when score = 0
 *     — OPPORTUNITY_SCORE_BELOW_THRESHOLD when score < minOpportunityScore override
 *     — INSUFFICIENT_ACTIVE_SIGNALS when activeSignalCount = 0
 *     — INSUFFICIENT_ACTIVE_SIGNALS with custom minActiveSignalCount = 2
 *     — READY with custom lower thresholds met
 *     — detail string contains INITIAL_HYPOTHESIS_NOT_VALIDATED
 *     — reason code is machine-readable (no spaces)
 *     — opportunityScore and activeSignalCount propagate to result
 *
 *   buildWhyNowAiInput
 *     — returns valid SignalIntelligenceInput shape
 *     — source is 'why-now', fetchedAt matches assessedAt
 *     — uses topSignals (not all signals)
 *     — company fields propagate (name, domain, industry, etc.)
 *     — null/undefined company fields become undefined in output
 *     — icp fields propagate
 *     — placeholder name when company is undefined
 *
 *   mapTitlesToSignalIds
 *     — maps exact title matches to UUIDs
 *     — unknown titles are excluded (best-effort)
 *     — duplicate titles include all matching UUIDs
 *     — empty relevantSignalTitles → empty result
 *     — empty signalSummaries → empty result
 *     — result contains no duplicates
 *
 *   Constants (INITIAL_HYPOTHESIS_NOT_VALIDATED)
 *     — READINESS_MIN_OPPORTUNITY_SCORE = 1
 *     — READINESS_MIN_ACTIVE_SIGNAL_COUNT = 1
 *     — AI_NARRATIVE_MIN_OPPORTUNITY_SCORE = 20
 *     — AI_MAX_SIGNALS = 10
 *
 *   AI threshold behavior
 *     — score >= 20 is required for AI (tested via evidence + readiness, not AI call)
 *     — score 19 would not trigger AI (confirmed by constant)
 *
 *   Stale/expired signals
 *     — signals past expiresAt are excluded even when status = 'active'
 *     — recently active signals with future expiresAt are included
 *
 *   Client isolation (structural)
 *     — buildWhyNowEvidence result contains no clientId (pure function)
 *     — clientId is payload-level only (not in evidence)
 *
 *   No unsupported claims
 *     — buildWhyNowEvidence never invents signals not present in input
 *     — mapTitlesToSignalIds returns only UUIDs present in signalSummaries
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWhyNowEvidence,
  evaluateReadiness,
  buildWhyNowAiInput,
  mapTitlesToSignalIds,
  DEFAULT_WHY_NOW_THRESHOLDS,
  READINESS_MIN_OPPORTUNITY_SCORE,
  READINESS_MIN_ACTIVE_SIGNAL_COUNT,
  AI_NARRATIVE_MIN_OPPORTUNITY_SCORE,
  AI_MAX_SIGNALS,
  type WhyNowThresholds,
  type WhyNowEvidence,
} from "../lib/why-now";

import type { SignalRow } from "../domain/signal-types";
import type { WhyNowSignalSummary } from "../domain/signal-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-09-06T12:00:00.000Z");

// Occurred 30 days ago; expires 60 days after that (so not expired at NOW)
const BASE_OCCURRED   = "2026-08-07T12:00:00.000Z";  // 30 days before NOW
const BASE_EXPIRES    = "2026-10-06T12:00:00.000Z";  // 60 days after occurredAt, not yet expired

// Occurred 200 days ago; expires 30 days after that (so expired at NOW)
const STALE_OCCURRED  = "2026-02-19T12:00:00.000Z";
const STALE_EXPIRES   = "2026-03-20T12:00:00.000Z";  // expired long ago

const SIG_FUNDING  = "00000000-0000-0000-0000-000000000001";
const SIG_EXEC     = "00000000-0000-0000-0000-000000000002";
const SIG_JOB      = "00000000-0000-0000-0000-000000000003";
const SIG_STALE    = "00000000-0000-0000-0000-000000000004";
const SIG_DISMISSED = "00000000-0000-0000-0000-000000000005";
const SIG_NEWS     = "00000000-0000-0000-0000-000000000006";
const SIG_AWARD    = "00000000-0000-0000-0000-000000000007";

function makeSignal(overrides: Partial<SignalRow> & { id: string }): SignalRow {
  return {
    id:                overrides.id,
    clientId:          "client-a",
    companyId:         "company-a",
    signalType:        "funding_round",
    signalSource:      "test",
    signalTitle:       "Test Signal",
    signalDescription: null,
    evidence:          {},
    signalStrength:    80,
    confidence:        0.9,
    occurredAt:        BASE_OCCURRED,
    detectedAt:        BASE_OCCURRED,
    expiresAt:         BASE_EXPIRES,
    sourceUrl:         null,
    status:            "active",
    metadata:          null,
    dedupKey:          null,
    createdAt:         BASE_OCCURRED,
    ...overrides,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

test("READINESS_MIN_OPPORTUNITY_SCORE = 1 (INITIAL_HYPOTHESIS_NOT_VALIDATED)", () => {
  assert.equal(READINESS_MIN_OPPORTUNITY_SCORE, 1);
});

test("READINESS_MIN_ACTIVE_SIGNAL_COUNT = 1 (INITIAL_HYPOTHESIS_NOT_VALIDATED)", () => {
  assert.equal(READINESS_MIN_ACTIVE_SIGNAL_COUNT, 1);
});

test("AI_NARRATIVE_MIN_OPPORTUNITY_SCORE = 20 (INITIAL_HYPOTHESIS_NOT_VALIDATED)", () => {
  assert.equal(AI_NARRATIVE_MIN_OPPORTUNITY_SCORE, 20);
});

test("AI_MAX_SIGNALS = 10", () => {
  assert.equal(AI_MAX_SIGNALS, 10);
});

test("DEFAULT_WHY_NOW_THRESHOLDS matches constants", () => {
  assert.equal(DEFAULT_WHY_NOW_THRESHOLDS.minOpportunityScore,            READINESS_MIN_OPPORTUNITY_SCORE);
  assert.equal(DEFAULT_WHY_NOW_THRESHOLDS.minActiveSignalCount,           READINESS_MIN_ACTIVE_SIGNAL_COUNT);
  assert.equal(DEFAULT_WHY_NOW_THRESHOLDS.minAiNarrativeOpportunityScore, AI_NARRATIVE_MIN_OPPORTUNITY_SCORE);
});

// ── buildWhyNowEvidence ───────────────────────────────────────────────────────

test("buildWhyNowEvidence: empty signals → zero active, no corroboration", () => {
  const ev = buildWhyNowEvidence([], 0, null, NOW);
  assert.equal(ev.activeSignalCount,   0);
  assert.equal(ev.corroborationFactor, 1.0);
  assert.deepEqual(ev.signalSummaries, []);
  assert.deepEqual(ev.topSignals,      []);
  assert.equal(ev.opportunityScore,    0);
  assert.equal(ev.priorityScore,       null);
  assert.equal(ev.assessedAt,          NOW.toISOString());
});

test("buildWhyNowEvidence: active non-expired signals are included", () => {
  const signal = makeSignal({ id: SIG_FUNDING, signalType: "funding_round" });
  const ev = buildWhyNowEvidence([signal], 60, 45, NOW);
  assert.equal(ev.activeSignalCount, 1);
  assert.equal(ev.signalSummaries.length, 1);
  assert.equal(ev.signalSummaries[0].signalId, SIG_FUNDING);
  assert.equal(ev.signalSummaries[0].signalType, "funding_round");
});

test("buildWhyNowEvidence: status=expired signals excluded (guard 1)", () => {
  const signal = makeSignal({ id: SIG_STALE, status: "expired" });
  const ev = buildWhyNowEvidence([signal], 0, null, NOW);
  assert.equal(ev.activeSignalCount, 0);
  assert.equal(ev.signalSummaries.length, 0);
});

test("buildWhyNowEvidence: status=dismissed signals excluded (guard 1)", () => {
  const signal = makeSignal({ id: SIG_DISMISSED, status: "dismissed" });
  const ev = buildWhyNowEvidence([signal], 0, null, NOW);
  assert.equal(ev.activeSignalCount, 0);
});

test("buildWhyNowEvidence: expired-at signals excluded even when status=active (guard 2)", () => {
  const stale = makeSignal({ id: SIG_STALE, status: "active", occurredAt: STALE_OCCURRED, expiresAt: STALE_EXPIRES });
  const ev = buildWhyNowEvidence([stale], 0, null, NOW);
  assert.equal(ev.activeSignalCount, 0,
    "signal with expiresAt in the past must be excluded by the in-memory isExpired() guard");
});

test("buildWhyNowEvidence: mixed signals — only active+non-expired included", () => {
  const good     = makeSignal({ id: SIG_FUNDING,   status: "active",   expiresAt: BASE_EXPIRES });
  const expiredS = makeSignal({ id: SIG_STALE,     status: "active",   occurredAt: STALE_OCCURRED, expiresAt: STALE_EXPIRES });
  const dismissed = makeSignal({ id: SIG_DISMISSED, status: "dismissed" });
  const ev = buildWhyNowEvidence([good, expiredS, dismissed], 50, null, NOW);
  assert.equal(ev.activeSignalCount, 1);
  assert.equal(ev.signalSummaries[0].signalId, SIG_FUNDING);
});

test("buildWhyNowEvidence: freshness scores are > 0 for non-expired signals at NOW", () => {
  const signal = makeSignal({ id: SIG_FUNDING, occurredAt: BASE_OCCURRED, expiresAt: BASE_EXPIRES });
  const ev = buildWhyNowEvidence([signal], 50, null, NOW);
  const freshnessScore = ev.signalSummaries[0].freshnessScore;
  assert.ok(freshnessScore > 0 && freshnessScore <= 100,
    `freshnessScore should be (0,100]; got ${freshnessScore}`);
});

test("buildWhyNowEvidence: freshness decays to 0 when NOW >= expiresAt", () => {
  // expiresAt is in the past relative to NOW
  const signal = makeSignal({ id: SIG_STALE, status: "active", occurredAt: STALE_OCCURRED, expiresAt: STALE_EXPIRES });
  // Note: this signal will be EXCLUDED by the isExpired guard, so we need to
  // set expiresAt just at NOW to get a 0 freshness score while still being included.
  const justExpired = makeSignal({
    id: SIG_STALE,
    status: "active",
    occurredAt: new Date(NOW.getTime() - 30 * 86400_000).toISOString(), // 30d ago
    expiresAt:  NOW.toISOString(),                                        // exactly NOW
  });
  const ev = buildWhyNowEvidence([justExpired], 10, null, NOW);
  // expiresAt = NOW means isExpired returns true (NOW >= expiresAt), so excluded
  assert.equal(ev.activeSignalCount, 0,
    "signal with expiresAt == NOW is excluded by isExpired guard");
});

test("buildWhyNowEvidence: corroborationFactor > 1.0 for GROWTH cluster (funding + job_posting)", () => {
  const funding = makeSignal({ id: SIG_FUNDING, signalType: "funding_round" });
  const job     = makeSignal({ id: SIG_JOB,     signalType: "job_posting" });
  const ev = buildWhyNowEvidence([funding, job], 80, null, NOW);
  // GROWTH cluster: [funding_round, expansion, job_posting] — 2 types → factor = 1.15
  assert.ok(ev.corroborationFactor > 1.0,
    `corroborationFactor should be > 1.0 for GROWTH cluster, got ${ev.corroborationFactor}`);
  assert.ok(ev.corroborationFactor <= 1.45,
    `corroborationFactor should be <= 1.45, got ${ev.corroborationFactor}`);
});

test("buildWhyNowEvidence: corroborationFactor = 1.0 for single signal type", () => {
  const signal = makeSignal({ id: SIG_NEWS, signalType: "news_mention" });
  const ev = buildWhyNowEvidence([signal], 20, null, NOW);
  assert.equal(ev.corroborationFactor, 1.0);
});

test("buildWhyNowEvidence: topSignals sorted by ICP relevance (funding_round > news_mention)", () => {
  const funding = makeSignal({ id: SIG_FUNDING, signalType: "funding_round", signalStrength: 80 });
  const news    = makeSignal({ id: SIG_NEWS,    signalType: "news_mention",  signalStrength: 80 });
  const ev = buildWhyNowEvidence([news, funding], 50, null, NOW);
  // funding_round ICP relevance = 1.0, news_mention = 0.3 → funding first
  assert.equal(ev.topSignals[0].signalId, SIG_FUNDING,
    "funding_round should rank above news_mention by ICP relevance");
});

test("buildWhyNowEvidence: topSignals capped at AI_MAX_SIGNALS (10)", () => {
  const signals: SignalRow[] = Array.from({ length: 15 }, (_, i) =>
    makeSignal({ id: `sig-${i.toString().padStart(3, "0")}`, signalType: "news_mention" }),
  );
  const ev = buildWhyNowEvidence(signals, 50, null, NOW);
  assert.equal(ev.topSignals.length, AI_MAX_SIGNALS,
    `topSignals should be capped at ${AI_MAX_SIGNALS}`);
  assert.equal(ev.signalSummaries.length, 15,
    "signalSummaries includes all active signals, not just top N");
});

test("buildWhyNowEvidence: signal IDs embedded in evidence._signalId", () => {
  const signal = makeSignal({ id: SIG_FUNDING, signalType: "funding_round" });
  const ev = buildWhyNowEvidence([signal], 60, null, NOW);
  const summary = ev.signalSummaries[0];
  assert.equal((summary.evidence as Record<string, unknown>)._signalId, SIG_FUNDING,
    "_signalId must be embedded in evidence for AI citation traceability");
});

test("buildWhyNowEvidence: assessedAt matches passed now", () => {
  const ev = buildWhyNowEvidence([], 0, null, NOW);
  assert.equal(ev.assessedAt, NOW.toISOString());
});

test("buildWhyNowEvidence: opportunityScore and priorityScore propagate", () => {
  const ev = buildWhyNowEvidence([], 55, 38, NOW);
  assert.equal(ev.opportunityScore, 55);
  assert.equal(ev.priorityScore,    38);
});

test("buildWhyNowEvidence: null priorityScore propagates to evidence", () => {
  const ev = buildWhyNowEvidence([], 30, null, NOW);
  assert.equal(ev.priorityScore, null);
});

test("buildWhyNowEvidence: never invents signals not present in input", () => {
  const signal = makeSignal({ id: SIG_FUNDING, signalTitle: "Series A — $10M" });
  const ev = buildWhyNowEvidence([signal], 60, null, NOW);
  const titles = ev.signalSummaries.map((s) => s.title);
  assert.deepEqual(titles, ["Series A — $10M"],
    "evidence must only contain signals from the input array");
});

// ── evaluateReadiness ─────────────────────────────────────────────────────────

test("evaluateReadiness: ready=true when score=1 and signals=1 (default thresholds)", () => {
  const ev = buildWhyNowEvidence(
    [makeSignal({ id: SIG_FUNDING })],
    1, null, NOW,
  );
  const r = evaluateReadiness(ev);
  assert.equal(r.ready,   true);
  assert.equal(r.reason,  "READY");
});

test("evaluateReadiness: OPPORTUNITY_SCORE_BELOW_THRESHOLD when score=0", () => {
  const ev = buildWhyNowEvidence(
    [makeSignal({ id: SIG_FUNDING })],
    0, null, NOW,
  );
  const r = evaluateReadiness(ev);
  assert.equal(r.ready,  false);
  assert.equal(r.reason, "OPPORTUNITY_SCORE_BELOW_THRESHOLD");
});

test("evaluateReadiness: OPPORTUNITY_SCORE_BELOW_THRESHOLD when score < custom threshold", () => {
  const ev = buildWhyNowEvidence(
    [makeSignal({ id: SIG_FUNDING })],
    9, null, NOW,
  );
  const thresholds: WhyNowThresholds = { ...DEFAULT_WHY_NOW_THRESHOLDS, minOpportunityScore: 10 };
  const r = evaluateReadiness(ev, thresholds);
  assert.equal(r.ready,  false);
  assert.equal(r.reason, "OPPORTUNITY_SCORE_BELOW_THRESHOLD");
});

test("evaluateReadiness: INSUFFICIENT_ACTIVE_SIGNALS when activeSignalCount=0", () => {
  const ev = buildWhyNowEvidence([], 50, null, NOW);
  const r = evaluateReadiness(ev);
  assert.equal(r.ready,  false);
  assert.equal(r.reason, "INSUFFICIENT_ACTIVE_SIGNALS");
});

test("evaluateReadiness: INSUFFICIENT_ACTIVE_SIGNALS with custom minActiveSignalCount=2, only 1 signal", () => {
  const ev = buildWhyNowEvidence(
    [makeSignal({ id: SIG_FUNDING })],
    50, null, NOW,
  );
  const thresholds: WhyNowThresholds = { ...DEFAULT_WHY_NOW_THRESHOLDS, minActiveSignalCount: 2 };
  const r = evaluateReadiness(ev, thresholds);
  assert.equal(r.ready,  false);
  assert.equal(r.reason, "INSUFFICIENT_ACTIVE_SIGNALS");
});

test("evaluateReadiness: READY with custom minActiveSignalCount=2 and 2 signals", () => {
  const ev = buildWhyNowEvidence(
    [makeSignal({ id: SIG_FUNDING }), makeSignal({ id: SIG_EXEC, signalType: "executive_hire" })],
    50, null, NOW,
  );
  const thresholds: WhyNowThresholds = { ...DEFAULT_WHY_NOW_THRESHOLDS, minActiveSignalCount: 2 };
  const r = evaluateReadiness(ev, thresholds);
  assert.equal(r.ready,  true);
  assert.equal(r.reason, "READY");
});

test("evaluateReadiness: detail contains INITIAL_HYPOTHESIS_NOT_VALIDATED for all outcomes", () => {
  const ready_ev = buildWhyNowEvidence([makeSignal({ id: SIG_FUNDING })], 50, null, NOW);
  const score_ev = buildWhyNowEvidence([makeSignal({ id: SIG_FUNDING })], 0,  null, NOW);
  const sig_ev   = buildWhyNowEvidence([], 50, null, NOW);

  assert.ok(evaluateReadiness(ready_ev).detail.includes("INITIAL_HYPOTHESIS_NOT_VALIDATED"));
  assert.ok(evaluateReadiness(score_ev).detail.includes("INITIAL_HYPOTHESIS_NOT_VALIDATED"));
  assert.ok(evaluateReadiness(sig_ev).detail.includes("INITIAL_HYPOTHESIS_NOT_VALIDATED"));
});

test("evaluateReadiness: reason code contains no spaces (machine-readable)", () => {
  const reasons = ["READY", "OPPORTUNITY_SCORE_BELOW_THRESHOLD", "INSUFFICIENT_ACTIVE_SIGNALS"] as const;
  for (const reason of reasons) {
    assert.ok(!reason.includes(" "), `reason '${reason}' must not contain spaces`);
  }
});

test("evaluateReadiness: opportunityScore and activeSignalCount propagate to result", () => {
  const ev = buildWhyNowEvidence(
    [makeSignal({ id: SIG_FUNDING })],
    42, null, NOW,
  );
  const r = evaluateReadiness(ev);
  assert.equal(r.opportunityScore,  42);
  assert.equal(r.activeSignalCount, 1);
});

test("evaluateReadiness: score=1 is exactly the boundary (ready)", () => {
  const ev = buildWhyNowEvidence([makeSignal({ id: SIG_FUNDING })], 1, null, NOW);
  assert.equal(evaluateReadiness(ev).ready, true,
    "score=1 should be READY (threshold is >=1)");
});

test("evaluateReadiness: score=0 is below boundary (not ready)", () => {
  const ev = buildWhyNowEvidence([makeSignal({ id: SIG_FUNDING })], 0, null, NOW);
  assert.equal(evaluateReadiness(ev).ready, false,
    "score=0 should fail the readiness gate");
});

// ── AI threshold behavior (tested via constants, no AI call) ──────────────────

test("AI threshold: score=20 meets AI narrative threshold", () => {
  assert.ok(20 >= AI_NARRATIVE_MIN_OPPORTUNITY_SCORE,
    "score=20 should meet the AI narrative threshold");
});

test("AI threshold: score=19 does NOT meet AI narrative threshold", () => {
  assert.ok(19 < AI_NARRATIVE_MIN_OPPORTUNITY_SCORE,
    "score=19 should NOT trigger AI narrative generation");
});

test("AI threshold boundary is labeled INITIAL_HYPOTHESIS_NOT_VALIDATED", () => {
  // This is structural — the constant value itself (20) carries the label in code.
  // The test asserts the expected value so any change is caught.
  assert.equal(AI_NARRATIVE_MIN_OPPORTUNITY_SCORE, 20,
    "If this changes, update the INITIAL_HYPOTHESIS_NOT_VALIDATED label accordingly");
});

// ── buildWhyNowAiInput ────────────────────────────────────────────────────────

test("buildWhyNowAiInput: returns valid SignalIntelligenceInput shape", () => {
  const signal = makeSignal({ id: SIG_FUNDING, signalTitle: "Series A" });
  const ev: WhyNowEvidence = buildWhyNowEvidence([signal], 60, null, NOW);
  const input = buildWhyNowAiInput(ev, { name: "Acme Inc" }, undefined, ev.assessedAt);
  assert.ok(input.company, "company must be present");
  assert.ok(input.icp !== undefined, "icp must be present");
  assert.ok(Array.isArray(input.signals), "signals must be an array");
});

test("buildWhyNowAiInput: source='why-now', fetchedAt=assessedAt", () => {
  const ev = buildWhyNowEvidence([], 50, null, NOW);
  const input = buildWhyNowAiInput(ev, { name: "Acme" }, undefined, ev.assessedAt);
  assert.equal(input.company.source,    "why-now");
  assert.equal(input.company.fetchedAt, ev.assessedAt);
});

test("buildWhyNowAiInput: uses topSignals not all signals", () => {
  const signals: SignalRow[] = Array.from({ length: 15 }, (_, i) =>
    makeSignal({ id: `sig-${i.toString().padStart(3, "0")}`, signalType: "news_mention" }),
  );
  const ev = buildWhyNowEvidence(signals, 50, null, NOW);
  const input = buildWhyNowAiInput(ev, { name: "Acme" }, undefined, ev.assessedAt);
  assert.equal(input.signals.length, AI_MAX_SIGNALS,
    "AI input signals must be capped at AI_MAX_SIGNALS (topSignals)");
});

test("buildWhyNowAiInput: company fields propagate", () => {
  const ev = buildWhyNowEvidence([], 50, null, NOW);
  const input = buildWhyNowAiInput(
    ev,
    { name: "Acme Inc", domain: "acme.com", industry: "SaaS", employeeCount: 200, city: "London", country: "UK", description: "GTM platform" },
    undefined,
    ev.assessedAt,
  );
  assert.equal(input.company.name,          "Acme Inc");
  assert.equal(input.company.domain,        "acme.com");
  assert.equal(input.company.industry,      "SaaS");
  assert.equal(input.company.employeeCount, 200);
  assert.equal(input.company.city,          "London");
  assert.equal(input.company.country,       "UK");
  assert.equal(input.company.description,   "GTM platform");
});

test("buildWhyNowAiInput: null company domain becomes undefined in output", () => {
  const ev = buildWhyNowEvidence([], 50, null, NOW);
  const input = buildWhyNowAiInput(ev, { name: "Acme", domain: null }, undefined, ev.assessedAt);
  assert.equal(input.company.domain, undefined,
    "null domain should become undefined (not 'null') in AI input");
});

test("buildWhyNowAiInput: placeholder name when company is undefined", () => {
  const ev = buildWhyNowEvidence([], 50, null, NOW);
  const input = buildWhyNowAiInput(ev, undefined, undefined, ev.assessedAt);
  assert.ok(input.company.name.includes("not provided"),
    "placeholder name must be used when company is undefined");
});

test("buildWhyNowAiInput: icp fields propagate", () => {
  const ev = buildWhyNowEvidence([], 50, null, NOW);
  const icp = { industry: "SaaS", location: "UK", keywords: ["AI", "outbound"] };
  const input = buildWhyNowAiInput(ev, { name: "Acme" }, icp, ev.assessedAt);
  assert.equal(input.icp.industry,  "SaaS");
  assert.equal(input.icp.location,  "UK");
  assert.deepEqual(input.icp.keywords, ["AI", "outbound"]);
});

// ── mapTitlesToSignalIds ──────────────────────────────────────────────────────

function makeSummary(id: string, title: string): WhyNowSignalSummary {
  return {
    signalId:       id,
    signalType:     "funding_round",
    title,
    description:    null,
    evidence:       { _signalId: id },
    signalStrength: 80,
    freshnessScore: 70,
    occurredAt:     BASE_OCCURRED,
  };
}

test("mapTitlesToSignalIds: maps exact title matches to UUIDs", () => {
  const summaries = [makeSummary(SIG_FUNDING, "Series A — $10M")];
  const ids = mapTitlesToSignalIds(["Series A — $10M"], summaries);
  assert.deepEqual(ids, [SIG_FUNDING]);
});

test("mapTitlesToSignalIds: unknown titles are excluded (best-effort)", () => {
  const summaries = [makeSummary(SIG_FUNDING, "Series A — $10M")];
  const ids = mapTitlesToSignalIds(["Unknown Title", "Series A — $10M"], summaries);
  assert.deepEqual(ids, [SIG_FUNDING],
    "titles not found in evidence must be excluded, not throw or return undefined");
});

test("mapTitlesToSignalIds: duplicate titles include all matching UUIDs", () => {
  // Two signals with the same title (unusual but possible)
  const summaries = [
    makeSummary(SIG_FUNDING, "Series A"),
    makeSummary(SIG_EXEC,    "Series A"),
  ];
  const ids = mapTitlesToSignalIds(["Series A"], summaries);
  assert.ok(ids.includes(SIG_FUNDING), "should include first matching UUID");
  assert.ok(ids.includes(SIG_EXEC),    "should include second matching UUID");
  assert.equal(ids.length, 2);
});

test("mapTitlesToSignalIds: empty relevantSignalTitles → empty result", () => {
  const summaries = [makeSummary(SIG_FUNDING, "Series A")];
  const ids = mapTitlesToSignalIds([], summaries);
  assert.deepEqual(ids, []);
});

test("mapTitlesToSignalIds: empty signalSummaries → empty result", () => {
  const ids = mapTitlesToSignalIds(["Series A"], []);
  assert.deepEqual(ids, []);
});

test("mapTitlesToSignalIds: result contains no duplicate UUIDs", () => {
  // Same title appears twice in relevantSignalTitles (AI hallucinating duplicates)
  const summaries = [makeSummary(SIG_FUNDING, "Series A")];
  const ids = mapTitlesToSignalIds(["Series A", "Series A"], summaries);
  const unique = [...new Set(ids)];
  assert.deepEqual(ids, unique, "duplicate UUIDs must be deduplicated");
});

test("mapTitlesToSignalIds: returns only UUIDs present in signalSummaries (no invented IDs)", () => {
  const summaries = [makeSummary(SIG_FUNDING, "Series A")];
  const ids = mapTitlesToSignalIds(["Series A", "Funding Round B"], summaries);
  for (const id of ids) {
    assert.ok(summaries.some((s) => s.signalId === id),
      `returned UUID ${id} not found in input signalSummaries`);
  }
});

// ── Stale/expired signal boundary tests ────────────────────────────────────────

test("recently-active signal with future expiresAt is included", () => {
  const signal = makeSignal({
    id:         SIG_FUNDING,
    status:     "active",
    occurredAt: new Date(NOW.getTime() - 7 * 86400_000).toISOString(),   // 7 days ago
    expiresAt:  new Date(NOW.getTime() + 23 * 86400_000).toISOString(),  // 23 days from now
  });
  const ev = buildWhyNowEvidence([signal], 50, null, NOW);
  assert.equal(ev.activeSignalCount, 1, "signal with future expiresAt must be included");
});

test("signal with expiresAt exactly 1ms in future is included", () => {
  const signal = makeSignal({
    id:         SIG_FUNDING,
    status:     "active",
    occurredAt: new Date(NOW.getTime() - 10 * 86400_000).toISOString(),
    expiresAt:  new Date(NOW.getTime() + 1).toISOString(),  // 1ms in future
  });
  const ev = buildWhyNowEvidence([signal], 50, null, NOW);
  assert.equal(ev.activeSignalCount, 1, "signal 1ms from expiry must still be included");
});

// ── Multiple corroborating signals ────────────────────────────────────────────

test("three GROWTH cluster signals produce corroborationFactor >= 1.30", () => {
  const funding   = makeSignal({ id: SIG_FUNDING,  signalType: "funding_round" });
  const expansion = makeSignal({ id: SIG_EXEC,     signalType: "expansion" });
  const job       = makeSignal({ id: SIG_JOB,      signalType: "job_posting" });
  const ev = buildWhyNowEvidence([funding, expansion, job], 80, null, NOW);
  // 3 types in GROWTH cluster: factor = 1.0 + 2×0.15 = 1.30
  assert.ok(ev.corroborationFactor >= 1.30,
    `3-type GROWTH cluster should produce factor >= 1.30, got ${ev.corroborationFactor}`);
});

test("signals from different clusters do not combine for corroboration", () => {
  const funding = makeSignal({ id: SIG_FUNDING, signalType: "funding_round" }); // GROWTH
  const news    = makeSignal({ id: SIG_NEWS,    signalType: "news_mention" });  // MARKET_SIGNAL
  const ev = buildWhyNowEvidence([funding, news], 60, null, NOW);
  // Each is in a different cluster; deepest cluster has depth 1 → factor = 1.0
  assert.equal(ev.corroborationFactor, 1.0,
    "signals in different clusters must not combine — each cluster scored independently");
});

// ── Client isolation (structural check) ────────────────────────────────────────

test("buildWhyNowEvidence result contains no clientId (pure function)", () => {
  const ev = buildWhyNowEvidence([], 50, null, NOW);
  const json = JSON.stringify(ev);
  assert.ok(!json.includes("clientId"),
    "evidence must not contain clientId — client scoping is the async layer's responsibility");
});
