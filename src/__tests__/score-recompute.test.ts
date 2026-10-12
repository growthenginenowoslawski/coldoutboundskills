/**
 * Unit tests for src/lib/score-recompute.ts — Stage 12, Step 6.
 *
 * All tests are pure / deterministic. No database, no network, no env vars.
 *
 * Only computeCompanyScore is tested here — it is the only new pure logic in
 * Step 6. rescoreCompany and rescoreAffectedCompanies are async DB orchestrators
 * and are covered by the integration test (scripts/signal-lifecycle-integration-test.ts).
 *
 * Coverage:
 *   Empty signal set       — score 0; excludedSignalCount 0
 *   Excluded signals       — status='expired' excluded (DB-authoritative guard)
 *   Excluded signals       — status='dismissed' excluded
 *   Race-condition guard   — active-status signal past expiresAt excluded by isExpired()
 *   Active valid signal    — contributes to score; correct signalCount/excludedCount
 *   icp_score=0            — collapses finalScore to 0 regardless of signals
 *   icp_score propagation  — icpScore is passed through to computeOpportunityScore
 *   Mixed batch            — active + expired: correct inputs length and excludedCount
 *   Composition check      — computeCompanyScore == buildScoreInputs+computeOpportunityScore
 *   Determinism            — same inputs, same now → bitwise-identical result
 *   now propagation        — passed-in now is used for freshness + corroboration window
 *   excludedSignalCount    — always present in result; equals count of non-active/expired rows
 *   hypothesis             — always "INITIAL_HYPOTHESIS_NOT_VALIDATED"
 *   score_inputs fields    — all required fields present in returned result
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeCompanyScore } from "../lib/score-recompute";
import {
  buildScoreInputs,
  computeOpportunityScore,
} from "../lib/opportunity-scoring";
import type { SignalRow } from "../domain/signal-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_A  = "00000000-0000-0000-0000-0000000000a1";
const COMPANY_A = "00000000-0000-0000-0000-000000000001";

const FIXED_NOW = new Date("2026-09-01T12:00:00.000Z");

function daysAgo(n: number, from: Date = FIXED_NOW): string {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}
function daysAhead(n: number, from: Date = FIXED_NOW): string {
  return new Date(from.getTime() + n * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Builds a default SignalRow. Defaults are set so the row is:
 *   - status = "active"
 *   - signalType = "funding_round" (strength 90, ICP relevance 1.00)
 *   - occurredAt 10 days ago
 *   - expiresAt 80 days from now (funding_round TTL = 90 days total)
 *
 * Override any field with the `overrides` argument.
 */
function makeSignalRow(overrides: Partial<SignalRow> = {}): SignalRow {
  return {
    id:               "sr-default",
    clientId:         CLIENT_A,
    companyId:        COMPANY_A,
    signalType:       "funding_round",
    signalSource:     "test",
    signalTitle:      "Series A",
    signalDescription: null,
    evidence:         {},
    signalStrength:   90,
    confidence:       0.800,
    occurredAt:       daysAgo(10),
    detectedAt:       daysAgo(10),
    expiresAt:        daysAhead(80),   // 90-day TTL, 10 days elapsed
    sourceUrl:        null,
    metadata:         null,
    dedupKey:         "test-key",
    status:           "active",
    createdAt:        daysAgo(10),
    ...overrides,
  };
}

// ── 1. Empty signal set ───────────────────────────────────────────────────────

test("computeCompanyScore: empty signals → finalScore 0, signalCount 0, excludedSignalCount 0", () => {
  const result = computeCompanyScore([], 100, FIXED_NOW);
  assert.equal(result.finalScore, 0);
  assert.equal(result.signalCount, 0);
  assert.equal(result.excludedSignalCount, 0);
  assert.equal(result.rawScore, 0);
});

// ── 2. Signal exclusion — DB-authoritative status guard ───────────────────────

test("computeCompanyScore: signal with status='expired' is excluded (DB-authoritative guard)", () => {
  const row = makeSignalRow({ status: "expired" });
  const result = computeCompanyScore([row], 100, FIXED_NOW);
  assert.equal(result.finalScore, 0);
  assert.equal(result.signalCount, 0);
  assert.equal(result.excludedSignalCount, 1);
});

test("computeCompanyScore: signal with status='dismissed' is excluded", () => {
  const row = makeSignalRow({ status: "dismissed" });
  const result = computeCompanyScore([row], 100, FIXED_NOW);
  assert.equal(result.finalScore, 0);
  assert.equal(result.signalCount, 0);
  assert.equal(result.excludedSignalCount, 1);
});

// ── 3. Race-condition guard — active signal past expiresAt ────────────────────

test("computeCompanyScore: active-status signal whose expiresAt is in the past is excluded (isExpired race guard)", () => {
  // Status is still 'active' (expireStaleSignals has not yet run), but
  // expiresAt is past. buildScoreInputs catches this with isExpired().
  const row = makeSignalRow({
    status:    "active",
    occurredAt: daysAgo(100),  // funding_round: 100 days ago
    expiresAt:  daysAgo(10),   // 90-day TTL → expired 10 days ago
  });
  const result = computeCompanyScore([row], 100, FIXED_NOW);
  assert.equal(result.finalScore, 0);
  assert.equal(result.signalCount, 0);
  assert.equal(result.excludedSignalCount, 1);
});

// ── 4. Active valid signal contributes ───────────────────────────────────────

test("computeCompanyScore: active non-expired signal contributes to score", () => {
  const row = makeSignalRow();
  // funding_round, strength=90, expiresAt=80 days from now
  // freshness = floor((1 - 10/90) × 100) = floor(88.88) = 88
  // contribution = (90 × 88 × 1.00) / 100 = 79.20
  // rawScore=79.20; cf=1.0; icpFit=1.0
  // finalScore = min(100, round(79.20 × 1.0 × 1.0)) = 79
  const result = computeCompanyScore([row], 100, FIXED_NOW);
  assert.ok(result.finalScore > 0, `Expected positive score, got ${result.finalScore}`);
  assert.equal(result.signalCount, 1);
  assert.equal(result.excludedSignalCount, 0);
  assert.ok(result.signals.length === 1);
});

// ── 5. icp_score propagation ──────────────────────────────────────────────────

test("computeCompanyScore: icp_score=0 collapses finalScore to 0 regardless of signals", () => {
  const row = makeSignalRow();
  const result = computeCompanyScore([row], 0, FIXED_NOW);
  assert.equal(result.finalScore, 0);
  assert.equal(result.icpScore, 0);
  assert.equal(result.icpFitWeight, 0);
  // Signal IS still included in the computation; it just contributes nothing
  // because icpFitWeight=0 collapses the final product.
  assert.equal(result.signalCount, 1);
});

test("computeCompanyScore: higher icp_score produces higher finalScore (all else equal)", () => {
  const row = makeSignalRow();
  const r50  = computeCompanyScore([row], 50, FIXED_NOW);
  const r100 = computeCompanyScore([row], 100, FIXED_NOW);
  assert.ok(r100.finalScore > r50.finalScore,
    `icp_score=100 should score higher than icp_score=50: got ${r100.finalScore} vs ${r50.finalScore}`);
});

// ── 6. Mixed batch: active + excluded ────────────────────────────────────────

test("computeCompanyScore: mixed batch (1 active, 1 expired, 1 dismissed) → signalCount=1, excludedSignalCount=2", () => {
  const rows = [
    makeSignalRow({ id: "a1", status: "active" }),
    makeSignalRow({ id: "e1", status: "expired" }),
    makeSignalRow({ id: "d1", status: "dismissed" }),
  ];
  const result = computeCompanyScore(rows, 100, FIXED_NOW);
  assert.equal(result.signalCount, 1);
  assert.equal(result.excludedSignalCount, 2);
  assert.ok(result.finalScore > 0, "Active signal should contribute");
});

// ── 7. Composition check ──────────────────────────────────────────────────────

test("computeCompanyScore == buildScoreInputs + computeOpportunityScore composition", () => {
  // Prove that computeCompanyScore is a faithful bridge: it applies exactly
  // buildScoreInputs then computeOpportunityScore — no hidden transformations.
  const rows = [
    makeSignalRow({ id: "active-1", status: "active",   signalType: "funding_round" }),
    makeSignalRow({ id: "expired-1", status: "expired",  signalType: "executive_hire" }),
  ];
  const icpScore = 80;

  // Replicate the pipeline manually.
  const { inputs, excludedCount } = buildScoreInputs(rows, FIXED_NOW);
  const expected = computeOpportunityScore(inputs, icpScore, FIXED_NOW, excludedCount);

  // computeCompanyScore should produce bitwise-identical output.
  const actual = computeCompanyScore(rows, icpScore, FIXED_NOW);
  assert.deepEqual(actual, expected);
});

test("computeCompanyScore: empty array composition — matches zero-signal computeOpportunityScore", () => {
  const expected = computeOpportunityScore([], 75, FIXED_NOW, 0);
  const actual   = computeCompanyScore([], 75, FIXED_NOW);
  assert.deepEqual(actual, expected);
});

// ── 8. Determinism ────────────────────────────────────────────────────────────

test("computeCompanyScore: same inputs produce bitwise-identical results (determinism)", () => {
  const rows = [
    makeSignalRow({ id: "r1", signalType: "funding_round",  signalStrength: 90 }),
    makeSignalRow({ id: "r2", signalType: "executive_hire", signalStrength: 75, expiresAt: daysAhead(20) }),
    makeSignalRow({ id: "r3", status: "expired" }),
  ];
  const r1 = computeCompanyScore(rows, 72, FIXED_NOW);
  const r2 = computeCompanyScore(rows, 72, FIXED_NOW);
  assert.deepEqual(r1, r2);
});

// ── 9. now propagation ───────────────────────────────────────────────────────

test("computeCompanyScore: now is passed to computeFreshnessScore — older now yields higher freshness", () => {
  // funding_round occurred 10 days ago. Scoring at FIXED_NOW gives one freshness;
  // scoring at FIXED_NOW + 50 days gives a lower freshness (more time has elapsed).
  const row = makeSignalRow({
    occurredAt: daysAgo(10),
    expiresAt:  daysAhead(80),
  });

  const nowA = FIXED_NOW;
  const nowB = new Date(FIXED_NOW.getTime() + 50 * 24 * 60 * 60 * 1000);

  const rA = computeCompanyScore([row], 100, nowA);
  const rB = computeCompanyScore([row], 100, nowB);

  // At nowA, 10 days elapsed out of 90. At nowB, 60 days elapsed out of 90.
  // Freshness is lower at nowB → contribution is lower → finalScore is lower.
  assert.ok(
    rA.finalScore > rB.finalScore,
    `Score at nowA (${rA.finalScore}) should be higher than at nowB (${rB.finalScore})`,
  );
});

// ── 10. excludedSignalCount in result ────────────────────────────────────────

test("computeCompanyScore: excludedSignalCount in result equals the count of non-active/expired rows", () => {
  const rows = [
    makeSignalRow({ id: "ok1", status: "active" }),
    makeSignalRow({ id: "ex1", status: "expired" }),
    makeSignalRow({ id: "ex2", status: "dismissed" }),
    makeSignalRow({
      id: "ex3",
      status: "active",
      occurredAt: daysAgo(200),
      expiresAt:  daysAgo(110),  // far past expiry
    }),
  ];
  const result = computeCompanyScore(rows, 100, FIXED_NOW);
  assert.equal(result.signalCount, 1);
  assert.equal(result.excludedSignalCount, 3, "3 rows excluded (2 by status, 1 by isExpired)");
});

// ── 11. Required result fields ────────────────────────────────────────────────

test("computeCompanyScore: result always contains all required OpportunityScoreResult fields", () => {
  const result = computeCompanyScore([makeSignalRow()], 75, FIXED_NOW);
  assert.equal(result.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  assert.equal(typeof result.computedAt, "string");
  assert.equal(typeof result.signalCount, "number");
  assert.equal(typeof result.rawScore, "number");
  assert.equal(typeof result.corroborationFactor, "number");
  assert.equal(typeof result.icpFitWeight, "number");
  assert.equal(typeof result.icpScore, "number");
  assert.equal(typeof result.icpScoreSource, "string");
  assert.equal(typeof result.finalScore, "number");
  assert.equal(typeof result.excludedSignalCount, "number");
  assert.ok(Array.isArray(result.signals));
});

test("computeCompanyScore: hypothesis is always 'INITIAL_HYPOTHESIS_NOT_VALIDATED'", () => {
  const empty  = computeCompanyScore([], 0, FIXED_NOW);
  const active = computeCompanyScore([makeSignalRow()], 100, FIXED_NOW);
  assert.equal(empty.hypothesis,  "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  assert.equal(active.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
});

test("computeCompanyScore: computedAt equals now.toISOString()", () => {
  const result = computeCompanyScore([], 50, FIXED_NOW);
  assert.equal(result.computedAt, FIXED_NOW.toISOString());
});

// ── 12. Two signal types accumulate correctly ─────────────────────────────────

test("computeCompanyScore: two active signals from different clusters accumulate score", () => {
  // funding_round + executive_hire → GROWTH depth=1, LEADERSHIP_CHANGE depth=1
  // Max cluster depth = 1 → corroborationFactor = 1.0
  const rows = [
    makeSignalRow({ id: "fr", signalType: "funding_round",  signalStrength: 90 }),
    makeSignalRow({ id: "eh", signalType: "executive_hire", signalStrength: 75, expiresAt: daysAhead(20) }),
  ];
  const twoSignalScore = computeCompanyScore(rows, 100, FIXED_NOW);
  const oneSignalScore = computeCompanyScore([rows[0]], 100, FIXED_NOW);
  assert.ok(
    twoSignalScore.finalScore > oneSignalScore.finalScore,
    `Two signals should score higher than one: ${twoSignalScore.finalScore} vs ${oneSignalScore.finalScore}`,
  );
  assert.equal(twoSignalScore.signalCount, 2);
});

// ── 13. Corroboration boost via GROWTH cluster ────────────────────────────────

test("computeCompanyScore: GROWTH cluster (funding_round + expansion) produces corroborationFactor=1.15", () => {
  const rows = [
    makeSignalRow({ id: "fr", signalType: "funding_round", signalStrength: 90 }),
    makeSignalRow({ id: "ex", signalType: "expansion",     signalStrength: 65 }),
  ];
  const result = computeCompanyScore(rows, 100, FIXED_NOW);
  assert.equal(result.corroborationFactor, 1.15);
});
