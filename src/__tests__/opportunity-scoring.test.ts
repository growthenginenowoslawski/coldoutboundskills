/**
 * Unit tests for src/lib/opportunity-scoring.ts — Stage 12.
 *
 * All tests are pure / deterministic. No database, no network, no env vars.
 * No mocks — the module has no I/O to mock.
 *
 * INITIAL_HYPOTHESIS_NOT_VALIDATED — all weight assertions document assumed
 * values, not commercially validated ones. If the weights change, update tests.
 *
 * Formula under test:
 *   contribution  = Math.round((strength × freshness × icpRelevance) / 100 × 100) / 100
 *   rawScore      = sum(contribution_i)
 *   corrobFactor  = min(1.45, 1.0 + (maxClusterDepth − 1) × 0.15)
 *   icpFitWeight  = clamp(icpScore, 0, 100) / 100
 *   finalScore    = min(100, Math.round(rawScore × corrobFactor × icpFitWeight))
 *
 * Coverage:
 *   Basic scoring    — zero signals, icp_score=0, max single signal, test-type signal
 *   Formula axes     — strength, freshness, icp_relevance each in isolation
 *   ICP weights      — all 12 types via getIcpRelevance (INITIAL_HYPOTHESIS_NOT_VALIDATED)
 *   Accumulation     — multiple signals, duplicate signal types
 *   Corroboration    — depth 1/2/3, clusters don't stack, 90-day window, boundary, export
 *   ICP weighting    — applied after corroboration, proportional, clamped inputs
 *   Capping/rounding — finalScore ≤ 100, .5 rounds up, deterministic
 *   score_inputs     — all required fields, icpScoreSource string, signals[] breakdown
 *   Determinism      — same inputs → bitwise-identical result
 *   now override     — corroboration window shifts; older signals exit the window
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeOpportunityScore,
  computeCorroborationFactor,
  getIcpRelevance,
  buildScoreInputs,
} from "../lib/opportunity-scoring";
import type { SignalScoreInput } from "../lib/opportunity-scoring";
import type { SignalRow } from "../domain/signal-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

// All corroboration window checks are relative to this timestamp.
const FIXED_NOW = new Date("2026-09-01T12:00:00.000Z");

function daysAgo(n: number, from: Date = FIXED_NOW): string {
  return new Date(from.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function sig(
  type: SignalScoreInput["signalType"],
  strength: number,
  freshness: number,
  occurredDaysAgo = 10,
  id?: string,
): SignalScoreInput {
  return {
    signalId:      id ?? `${type}-${occurredDaysAgo}`,
    signalType:    type,
    signalStrength: strength,
    freshnessScore: freshness,
    occurredAt:    daysAgo(occurredDaysAgo),
  };
}

// ── 1. Basic scoring — zero and boundary cases ────────────────────────────────

test("scoring: zero signals → finalScore 0, rawScore 0, signalCount 0", () => {
  const r = computeOpportunityScore([], 80, FIXED_NOW);
  assert.equal(r.finalScore, 0);
  assert.equal(r.rawScore, 0);
  assert.equal(r.signalCount, 0);
});

test("scoring: icp_score 0 collapses finalScore to 0 regardless of signal evidence", () => {
  // contribution = (90 × 100 × 1.00)/100 = 90; raw = 90; cf = 1.0; icpFit = 0/100 = 0
  // finalScore = min(100, round(90 × 1.0 × 0)) = 0
  const r = computeOpportunityScore(
    [sig("funding_round", 90, 100)],
    0,
    FIXED_NOW,
  );
  assert.equal(r.finalScore, 0);
});

test("scoring: max single signal (funding_round, strength 100, freshness 100, icp_score 100) → finalScore 100", () => {
  // contribution = (100 × 100 × 1.00)/100 = 100
  // rawScore = 100; cf = 1.0; icpFit = 1.0
  // finalScore = min(100, round(100 × 1.0 × 1.0)) = 100
  const r = computeOpportunityScore(
    [sig("funding_round", 100, 100)],
    100,
    FIXED_NOW,
  );
  assert.equal(r.finalScore, 100);
});

test("scoring: test signal (icpRelevance = 0.00) contributes 0 regardless of strength and freshness", () => {
  // contribution = (50 × 100 × 0.00)/100 = 0; rawScore = 0; finalScore = 0
  const r = computeOpportunityScore(
    [sig("test", 50, 100)],
    100,
    FIXED_NOW,
  );
  assert.equal(r.finalScore, 0);
  assert.equal(r.rawScore, 0);
  assert.equal(r.signals[0].contribution, 0);
});

// ── 2. Formula axes — strength, freshness, relevance in isolation ─────────────

test("scoring: signal strength affects contribution proportionally (90 vs 45, same type/freshness)", () => {
  // strength=90: contribution = (90 × 100 × 1.00)/100 = 90; finalScore = round(90 × 1.0) = 90
  // strength=45: contribution = (45 × 100 × 1.00)/100 = 45; finalScore = round(45 × 1.0) = 45
  const r90 = computeOpportunityScore([sig("funding_round", 90, 100)], 100, FIXED_NOW);
  const r45 = computeOpportunityScore([sig("funding_round", 45, 100)], 100, FIXED_NOW);
  assert.equal(r90.finalScore, 90);
  assert.equal(r45.finalScore, 45);
  assert.ok(r90.finalScore === r45.finalScore * 2, "Halving strength halves the final score");
});

test("scoring: freshness score affects contribution proportionally (100 vs 50, same type/strength)", () => {
  // freshness=100: contribution = (90 × 100 × 1.00)/100 = 90; finalScore = 90
  // freshness=50:  contribution = (90 × 50 × 1.00)/100 = 45;  finalScore = 45
  const r100 = computeOpportunityScore([sig("funding_round", 90, 100)], 100, FIXED_NOW);
  const r50  = computeOpportunityScore([sig("funding_round", 90, 50)],  100, FIXED_NOW);
  assert.equal(r100.finalScore, 90);
  assert.equal(r50.finalScore, 45);
  assert.ok(r100.finalScore === r50.finalScore * 2, "Halving freshness halves the final score");
});

test("scoring: icp_relevance is applied — funding_round (1.00) vs website_change (0.20) at same strength/freshness", () => {
  // funding_round: contribution = (100 × 100 × 1.00)/100 = 100; finalScore = 100
  // website_change: contribution = (100 × 100 × 0.20)/100 = 20;  finalScore = 20
  const rFunding = computeOpportunityScore([sig("funding_round",  100, 100)], 100, FIXED_NOW);
  const rWebsite = computeOpportunityScore([sig("website_change", 100, 100)], 100, FIXED_NOW);
  assert.equal(rFunding.finalScore, 100);
  assert.equal(rWebsite.finalScore, 20);
  assert.equal(rFunding.signals[0].icpRelevance, 1.00);
  assert.equal(rWebsite.signals[0].icpRelevance, 0.20);
});

// ── 3. All 12 ICP relevance weights (INITIAL_HYPOTHESIS_NOT_VALIDATED) ────────

test("icp_relevance: all 12 signal types return their documented INITIAL_HYPOTHESIS_NOT_VALIDATED weight", () => {
  const expected: Array<[SignalScoreInput["signalType"], number]> = [
    ["funding_round",      1.00],
    ["executive_hire",     0.90],
    ["expansion",          0.80],
    ["technology_change",  0.75],
    ["product_launch",     0.70],
    ["partnership",        0.65],
    ["job_posting",        0.60],
    ["competitor_mention", 0.55],
    ["news_mention",       0.30],
    ["award",              0.25],
    ["website_change",     0.20],
    ["test",               0.00],
  ];
  for (const [type, weight] of expected) {
    assert.equal(
      getIcpRelevance(type),
      weight,
      `${type}: expected icp_relevance ${weight} (INITIAL_HYPOTHESIS_NOT_VALIDATED)`,
    );
  }
});

// ── 4. Multi-signal accumulation ──────────────────────────────────────────────

test("scoring: two signals from different clusters accumulate correctly (explicit formula check)", () => {
  // funding_round: (50 × 80 × 1.00)/100 = 40.00  [GROWTH cluster]
  // executive_hire: (60 × 70 × 0.90)/100 = 37.80  [LEADERSHIP_CHANGE cluster]
  // rawScore = 40.00 + 37.80 = 77.80
  // cf = 1.0 (each cluster has depth 1; max = 1)
  // icpFitWeight = 80/100 = 0.80
  // finalScore = min(100, round(77.80 × 1.0 × 0.80)) = round(62.24) = 62
  const r = computeOpportunityScore(
    [
      sig("funding_round",  50, 80),
      sig("executive_hire", 60, 70),
    ],
    80,
    FIXED_NOW,
  );
  assert.equal(r.signals[0].contribution, 40.00);
  assert.equal(r.signals[1].contribution, 37.80);
  assert.equal(r.rawScore, 77.80);
  assert.equal(r.corroborationFactor, 1.0);
  assert.equal(r.icpFitWeight, 0.80);
  assert.equal(r.finalScore, 62);
});

test("scoring: two signals of the same type both contribute to rawScore (corroboration depth stays 1)", () => {
  // Two funding_round signals (different IDs), each contribution = (50 × 100 × 1.00)/100 = 50
  // rawScore = 100 (not 50 — both contribute)
  // recentTypes = {"funding_round"} → GROWTH depth = 1 → cf = 1.0
  // icp_score=100; finalScore = min(100, round(100)) = 100
  const r = computeOpportunityScore(
    [
      sig("funding_round", 50, 100, 10, "fr-1"),
      sig("funding_round", 50, 100, 10, "fr-2"),
    ],
    100,
    FIXED_NOW,
  );
  assert.equal(r.rawScore, 100);
  assert.equal(r.signalCount, 2);
  assert.equal(r.corroborationFactor, 1.0);
  assert.equal(r.finalScore, 100);
});

// ── 5. Corroboration factor ───────────────────────────────────────────────────

test("corroboration: single signal → factor 1.0", () => {
  const cf = computeCorroborationFactor([sig("funding_round", 90, 100)], FIXED_NOW);
  assert.equal(cf, 1.0);
});

test("corroboration: GROWTH cluster depth 2 (funding_round + expansion) → factor 1.15", () => {
  // min(1.45, 1.0 + (2−1) × 0.15) = 1.15
  const cf = computeCorroborationFactor(
    [sig("funding_round", 90, 100), sig("expansion", 65, 100)],
    FIXED_NOW,
  );
  assert.equal(cf, 1.15);
});

test("corroboration: GROWTH cluster depth 3 (all three types) → factor 1.30", () => {
  // min(1.45, 1.0 + (3−1) × 0.15) = 1.30
  const cf = computeCorroborationFactor(
    [
      sig("funding_round", 90, 100),
      sig("expansion",     65, 100),
      sig("job_posting",   50, 100),
    ],
    FIXED_NOW,
  );
  assert.equal(cf, 1.30);
});

test("corroboration: PRODUCT_MOTION cluster depth 3 (all three types) → factor 1.30", () => {
  // min(1.45, 1.0 + (3−1) × 0.15) = 1.30
  const cf = computeCorroborationFactor(
    [
      sig("product_launch",     70, 100),
      sig("partnership",        60, 100),
      sig("technology_change",  55, 100),
    ],
    FIXED_NOW,
  );
  assert.equal(cf, 1.30);
});

test("corroboration: signals from two different clusters do not stack — only max cluster depth counts", () => {
  // GROWTH depth=3, PRODUCT_MOTION depth=3 — both max out at 3
  // Factor = min(1.45, 1.0 + (3−1) × 0.15) = 1.30 (NOT 1.60 from summing both)
  const cf = computeCorroborationFactor(
    [
      sig("funding_round",    90, 100),
      sig("expansion",        65, 100),
      sig("job_posting",      50, 100),
      sig("product_launch",   70, 100),
      sig("partnership",      60, 100),
      sig("technology_change", 55, 100),
    ],
    FIXED_NOW,
  );
  assert.equal(cf, 1.30);
});

test("corroboration: signals outside the 90-day window are excluded from cluster depth (no boost)", () => {
  // award (95 days ago — outside window) + competitor_mention (10 days ago — inside window)
  // Both in MARKET_SIGNAL cluster, but only competitor_mention is within 90 days
  // recentTypes = {"competitor_mention"} → depth = 1 → factor = 1.0
  const cfOutside = computeCorroborationFactor(
    [
      sig("award",              45, 50, 95),  // 95 days ago, outside window
      sig("competitor_mention", 60, 90, 10),  // 10 days ago, inside window
    ],
    FIXED_NOW,
  );
  assert.equal(cfOutside, 1.0);

  // With award inside the window → depth = 2 → factor = 1.15
  const cfInside = computeCorroborationFactor(
    [
      sig("award",              45, 80, 30),  // 30 days ago, inside window
      sig("competitor_mention", 60, 90, 10),  // 10 days ago, inside window
    ],
    FIXED_NOW,
  );
  assert.equal(cfInside, 1.15);
});

test("corroboration: signal exactly at the 90-day boundary (inclusive) is counted in the window", () => {
  // The code filters: ms >= cutoffMs (where cutoff = now − 90 days).
  // A signal at exactly 90 days ago has ms === cutoffMs → included.
  const exactly90 = daysAgo(90);  // ms === cutoffMs
  const signals: SignalScoreInput[] = [
    { signalId: "fr-90", signalType: "funding_round", signalStrength: 90, freshnessScore: 1, occurredAt: exactly90 },
    sig("expansion", 65, 100, 10),  // clearly inside
  ];
  const cf = computeCorroborationFactor(signals, FIXED_NOW);
  assert.equal(cf, 1.15, "Signal at exactly the 90-day boundary must be included");
});

test("corroboration: computeCorroborationFactor is exported and returns a number in [1.0, 1.45]", () => {
  const cf = computeCorroborationFactor([], FIXED_NOW);
  assert.equal(typeof cf, "number");
  assert.ok(cf >= 1.0 && cf <= 1.45);
});

test("corroboration: full score with GROWTH depth 2 is higher than same signals with corroboration factor 1.0 (explicit)", () => {
  // funding_round (strength=30, freshness=100): contribution = (30×100×1.00)/100 = 30.00
  // expansion (strength=30, freshness=100): contribution = (30×100×0.80)/100 = 24.00
  // rawScore = 54.00
  //
  // With cf=1.15 (GROWTH depth 2), icp_score=60, icpFit=0.60:
  //   finalScore = min(100, round(54 × 1.15 × 0.60)) = round(37.26) = 37
  //
  // If cf were 1.0 (no corroboration), same formula:
  //   round(54 × 1.0 × 0.60) = round(32.4) = 32
  //
  // result.corroborationFactor must be 1.15 and finalScore must be 37.
  const r = computeOpportunityScore(
    [
      sig("funding_round", 30, 100),
      sig("expansion",     30, 100),
    ],
    60,
    FIXED_NOW,
  );
  assert.equal(r.corroborationFactor, 1.15);
  assert.equal(r.finalScore, 37, "Expected round(54 × 1.15 × 0.60) = round(37.26) = 37");
});

// ── 6. ICP weighting ─────────────────────────────────────────────────────────

test("scoring: icp_score=50 produces exactly half the finalScore of icp_score=100 (single clean signal)", () => {
  // funding_round: contribution = (50 × 100 × 1.00)/100 = 50; rawScore = 50; cf = 1.0
  // icp_score=100: finalScore = round(50 × 1.0 × 1.00) = 50
  // icp_score=50:  finalScore = round(50 × 1.0 × 0.50) = 25
  const r100 = computeOpportunityScore([sig("funding_round", 50, 100)], 100, FIXED_NOW);
  const r50  = computeOpportunityScore([sig("funding_round", 50, 100)],  50, FIXED_NOW);
  assert.equal(r100.finalScore, 50);
  assert.equal(r50.finalScore,  25);
  assert.ok(r100.finalScore === r50.finalScore * 2, "icp_score=100 should be 2× icp_score=50");
});

test("scoring: icp_score is applied after corroboration (explicit formula check)", () => {
  // expansion + job_posting: GROWTH cluster depth=2, cf=1.15
  // expansion: (30×100×0.80)/100 = 24.00
  // job_posting: (30×100×0.60)/100 = 18.00
  // rawScore = 42.00
  //
  // icp_score=80, icpFit=0.80:
  //   finalScore = min(100, round(42 × 1.15 × 0.80)) = round(38.64) = 39
  //
  // If ICP were applied before corroboration (wrong): round(42 × 0.80) × 1.15 = round(33.6) × 1.15 = 34 × 1.15 ≠ 39
  // The correct order (corroboration then ICP) gives 39.
  const r = computeOpportunityScore(
    [
      sig("expansion",   30, 100),
      sig("job_posting", 30, 100),
    ],
    80,
    FIXED_NOW,
  );
  assert.equal(r.corroborationFactor, 1.15);
  assert.equal(r.icpFitWeight, 0.80);
  assert.equal(r.finalScore, 39, "Expected round(42 × 1.15 × 0.80) = round(38.64) = 39");
});

test("scoring: icp_score clamped to 0 at lower bound (negative input → finalScore 0)", () => {
  const r = computeOpportunityScore(
    [sig("funding_round", 90, 100)],
    -10,
    FIXED_NOW,
  );
  assert.equal(r.icpScore, 0);
  assert.equal(r.icpFitWeight, 0);
  assert.equal(r.finalScore, 0);
});

test("scoring: icp_score clamped to 100 at upper bound (value 150 behaves as 100)", () => {
  const rClamped = computeOpportunityScore(
    [sig("funding_round", 50, 100)],
    150,
    FIXED_NOW,
  );
  const r100 = computeOpportunityScore(
    [sig("funding_round", 50, 100)],
    100,
    FIXED_NOW,
  );
  assert.equal(rClamped.icpScore, 100);
  assert.equal(rClamped.icpFitWeight, 1.0);
  assert.equal(rClamped.finalScore, r100.finalScore);
});

// ── 7. Final score capping and rounding ───────────────────────────────────────

test("scoring: finalScore is capped at 100 when rawScore × cf × icpFitWeight exceeds 100", () => {
  // funding_round (90, 100): 90 + executive_hire (75, 100): 67.5 + product_launch (70, 100): 49
  // + partnership (60, 100): 39 → rawScore = 245.5
  // PRODUCT_MOTION: product_launch + partnership → depth=2, cf=1.15
  // finalScore = min(100, round(245.5 × 1.15 × 1.0)) = min(100, 282) = 100
  const r = computeOpportunityScore(
    [
      sig("funding_round",  90, 100),
      sig("executive_hire", 75, 100),
      sig("product_launch", 70, 100),
      sig("partnership",    60, 100),
    ],
    100,
    FIXED_NOW,
  );
  assert.equal(r.finalScore, 100);
});

test("scoring: rounding — .5 rounds up (Math.round behaviour)", () => {
  // funding_round: (50×100×1.00)/100 = 50; rawScore=50; cf=1.0; icpFit=0.61
  // finalScore = min(100, round(50 × 1.0 × 0.61)) = round(30.5) = 31
  const r = computeOpportunityScore(
    [sig("funding_round", 50, 100)],
    61,
    FIXED_NOW,
  );
  assert.equal(r.finalScore, 31, "round(30.5) must equal 31 (rounds up at .5)");
});

test("scoring: finalScore is a non-negative integer in [0, 100] for any valid input", () => {
  const cases: Array<[number, number, number]> = [
    [0,   0,   0],
    [100, 100, 100],
    [47,  63,  72],
    [1,   1,   1],
  ];
  for (const [strength, freshness, icpScore] of cases) {
    const r = computeOpportunityScore(
      [sig("funding_round", strength, freshness)],
      icpScore,
      FIXED_NOW,
    );
    assert.ok(
      Number.isInteger(r.finalScore) && r.finalScore >= 0 && r.finalScore <= 100,
      `finalScore out of range for strength=${strength}, freshness=${freshness}, icp=${icpScore}: ${r.finalScore}`,
    );
  }
});

// ── 8. score_inputs structure ─────────────────────────────────────────────────

test("score_inputs: all required top-level fields are present in the result", () => {
  const r = computeOpportunityScore(
    [sig("funding_round", 90, 80)],
    75,
    FIXED_NOW,
  );
  assert.equal(r.hypothesis,          "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  assert.equal(typeof r.computedAt,   "string");
  assert.equal(typeof r.signalCount,  "number");
  assert.equal(typeof r.rawScore,     "number");
  assert.equal(typeof r.corroborationFactor, "number");
  assert.equal(typeof r.icpFitWeight, "number");
  assert.equal(typeof r.icpScore,     "number");
  assert.equal(typeof r.icpScoreSource, "string");
  assert.equal(typeof r.finalScore,   "number");
  assert.equal(typeof r.excludedSignalCount, "number");
  assert.ok(Array.isArray(r.signals));
});

test("score_inputs: excludedSignalCount defaults to 0 when computeOpportunityScore is called directly", () => {
  const r = computeOpportunityScore([sig("funding_round", 90, 80)], 75, FIXED_NOW);
  assert.equal(r.excludedSignalCount, 0);
});

test("score_inputs: excludedSignalCount is preserved when caller passes a non-zero value", () => {
  // Caller used buildScoreInputs and found 3 excluded signals before scoring.
  const r = computeOpportunityScore([sig("funding_round", 90, 80)], 75, FIXED_NOW, 3);
  assert.equal(r.excludedSignalCount, 3);
  // Scoring formula is unaffected — only the breakdown field changes.
  assert.equal(r.signalCount, 1);
});

test("score_inputs: icpScoreSource is the exact documented compromise string", () => {
  const r = computeOpportunityScore([], 50, FIXED_NOW);
  assert.equal(
    r.icpScoreSource,
    "companies.icp_score (global — TEMPORARY COMPROMISE: reflects last writer when multiple clients target the same company)",
  );
});

test("score_inputs: hypothesis is always 'INITIAL_HYPOTHESIS_NOT_VALIDATED'", () => {
  const r0 = computeOpportunityScore([], 0, FIXED_NOW);
  const r1 = computeOpportunityScore([sig("funding_round", 90, 100)], 100, FIXED_NOW);
  assert.equal(r0.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  assert.equal(r1.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
});

test("score_inputs: computedAt equals the passed-in now.toISOString()", () => {
  const r = computeOpportunityScore([], 50, FIXED_NOW);
  assert.equal(r.computedAt, FIXED_NOW.toISOString());
});

test("score_inputs: signalCount equals the number of signals passed in", () => {
  const r0 = computeOpportunityScore([], 80, FIXED_NOW);
  const r1 = computeOpportunityScore([sig("funding_round", 90, 100)], 80, FIXED_NOW);
  const r3 = computeOpportunityScore(
    [sig("funding_round", 90, 100), sig("expansion", 65, 80), sig("executive_hire", 75, 90)],
    80,
    FIXED_NOW,
  );
  assert.equal(r0.signalCount, 0);
  assert.equal(r1.signalCount, 1);
  assert.equal(r3.signalCount, 3);
});

test("score_inputs: signals[] contains per-signal breakdown with all required fields and correct values", () => {
  // funding_round: strength=75, freshness=80, icpRelevance=1.00
  // contribution = Math.round((75 × 80 × 1.00)/100 × 100)/100 = Math.round(6000)/100 = 60.00
  const r = computeOpportunityScore(
    [{ signalId: "fr-uuid", signalType: "funding_round", signalStrength: 75, freshnessScore: 80, occurredAt: daysAgo(10) }],
    100,
    FIXED_NOW,
  );
  assert.equal(r.signals.length, 1);
  const s = r.signals[0];
  assert.equal(s.signalId,       "fr-uuid");
  assert.equal(s.signalType,     "funding_round");
  assert.equal(s.signalStrength, 75);
  assert.equal(s.freshnessScore, 80);
  assert.equal(s.icpRelevance,   1.00);
  assert.equal(s.contribution,   60.00);  // round((75 × 80 × 1.00)/100 × 100)/100
});

test("score_inputs: signals[] contribution for executive_hire (explicit formula check)", () => {
  // executive_hire: strength=75, freshness=60, icpRelevance=0.90
  // contribution = Math.round((75 × 60 × 0.90)/100 × 100)/100 = Math.round(4050)/100 = 40.50
  const r = computeOpportunityScore(
    [sig("executive_hire", 75, 60)],
    100,
    FIXED_NOW,
  );
  assert.equal(r.signals[0].contribution, 40.50);
  assert.equal(r.signals[0].icpRelevance, 0.90);
});

test("score_inputs: rawScore in result equals sum of rounded per-signal contributions", () => {
  // funding_round: (50 × 80 × 1.00)/100 = 40.00 → stored 40.00
  // executive_hire: (60 × 70 × 0.90)/100 = 37.80 → stored 37.80
  // rawScore (stored) = 40.00 + 37.80 = 77.80
  const r = computeOpportunityScore(
    [sig("funding_round", 50, 80), sig("executive_hire", 60, 70)],
    80,
    FIXED_NOW,
  );
  const sumOfContributions = r.signals.reduce((acc, s) => acc + s.contribution, 0);
  // rawScore stored is also rounded to 2dp — use tolerance for floating-point sum
  assert.ok(
    Math.abs(r.rawScore - sumOfContributions) < 0.01,
    `rawScore ${r.rawScore} should equal sum of contributions ${sumOfContributions}`,
  );
  assert.equal(r.rawScore, 77.80);
});

// ── 9. Determinism ────────────────────────────────────────────────────────────

test("scoring: same inputs produce bitwise-identical results (determinism)", () => {
  const signals = [
    sig("funding_round",  90, 80),
    sig("expansion",      65, 75),
    sig("executive_hire", 75, 60),
  ];
  const r1 = computeOpportunityScore(signals, 72, FIXED_NOW);
  const r2 = computeOpportunityScore(signals, 72, FIXED_NOW);
  assert.deepEqual(r1, r2);
});

// ── 10. now override — corroboration window shifts ────────────────────────────

test("scoring: now override shifts corroboration window — signals exit the window as time passes", () => {
  // funding_round occurred 60 days before FIXED_NOW → within the 90-day window at FIXED_NOW
  // expansion occurred 10 days before FIXED_NOW → within window at FIXED_NOW
  //
  // At FIXED_NOW: both in window → GROWTH depth=2 → cf=1.15
  // At FIXED_NOW + 35 days: funding_round is now 95 days old (outside), expansion is 45 days old (inside)
  //                          → GROWTH depth=1 → cf=1.0
  //
  // funding_round: (50×100×1.00)/100 = 50.00; expansion: (50×100×0.80)/100 = 40.00
  // rawScore = 90.00; icp_score=60, icpFitWeight=0.60
  //
  // At FIXED_NOW (cf=1.15):  finalScore = round(90 × 1.15 × 0.60) = round(62.10) = 62
  // At later now  (cf=1.0):  finalScore = round(90 × 1.0 × 0.60)  = round(54.00) = 54

  const signals: SignalScoreInput[] = [
    sig("funding_round", 50, 100, 60),  // 60 days ago
    sig("expansion",     50, 100, 10),  // 10 days ago
  ];

  const nowA = FIXED_NOW;
  const nowB = new Date(FIXED_NOW.getTime() + 35 * 24 * 60 * 60 * 1000);

  const rA = computeOpportunityScore(signals, 60, nowA);
  const rB = computeOpportunityScore(signals, 60, nowB);

  assert.equal(rA.corroborationFactor, 1.15, "At FIXED_NOW both signals are in the 90-day window");
  assert.equal(rA.finalScore, 62, "Expected round(90 × 1.15 × 0.60) = round(62.10) = 62");

  assert.equal(rB.corroborationFactor, 1.0,  "35 days later, funding_round exits the window");
  assert.equal(rB.finalScore, 54, "Expected round(90 × 1.0 × 0.60) = 54");
});

// ── 11. buildScoreInputs — bridge from SignalRow[] to SignalScoreInput[] ──────
//
// Tests verify:
//   - Active, non-expired signals are included
//   - Expired-status signals are excluded (DB-authoritative guard)
//   - Dismissed-status signals are excluded
//   - Active-status signals past their expiresAt are excluded (race-condition guard)
//   - freshnessScore is computed via computeFreshnessScore (linear decay)
//   - signalStrength is taken from the DB row, not recomputed
//   - excludedCount is correct in all cases
//   - The two-guard combination is explicit and independently testable

// Helpers for buildScoreInputs tests only — distinct from the sig() helper above.

function daysAhead(n: number, from: Date = FIXED_NOW): string {
  return new Date(from.getTime() + n * 24 * 60 * 60 * 1000).toISOString();
}

function makeSignalRow(overrides: Partial<SignalRow> = {}): SignalRow {
  // executive_hire TTL = 30 days.
  // Default: occurredAt 15 days ago, expiresAt 15 days from now → freshness ≈ 50.
  return {
    id:               "sr-default",
    clientId:         "00000000-0000-0000-0000-0000000000a1",
    companyId:        "00000000-0000-0000-0000-000000000001",
    signalType:       "executive_hire",
    signalSource:     "test",
    signalTitle:      "New VP of Sales",
    signalDescription: null,
    evidence:         {},
    signalStrength:   75,
    confidence:       0.800,
    occurredAt:       daysAgo(15),
    detectedAt:       daysAgo(15),
    expiresAt:        daysAhead(15),
    sourceUrl:        null,
    metadata:         null,
    dedupKey:         null,
    status:           "active",
    createdAt:        daysAgo(15),
    ...overrides,
  };
}

test("buildScoreInputs: empty array → { inputs: [], excludedCount: 0 }", () => {
  const { inputs, excludedCount } = buildScoreInputs([], FIXED_NOW);
  assert.deepEqual(inputs, []);
  assert.equal(excludedCount, 0);
});

test("buildScoreInputs: active, non-expired signal is included in inputs", () => {
  const row = makeSignalRow({ id: "active-01" });
  const { inputs, excludedCount } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs.length, 1);
  assert.equal(excludedCount, 0);
  assert.equal(inputs[0].signalId, "active-01");
});

test("buildScoreInputs: signal with status 'expired' is excluded (DB-authoritative guard)", () => {
  const row = makeSignalRow({ status: "expired" });
  const { inputs, excludedCount } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs.length, 0);
  assert.equal(excludedCount, 1);
});

test("buildScoreInputs: signal with status 'dismissed' is excluded", () => {
  const row = makeSignalRow({ status: "dismissed" });
  const { inputs, excludedCount } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs.length, 0);
  assert.equal(excludedCount, 1);
});

test("buildScoreInputs: active-status signal whose expiresAt is in the past is excluded (race-condition guard)", () => {
  // Status is 'active' (expireStaleSignals has not yet run), but expiresAt is past.
  // The in-memory isExpired() guard catches this.
  const row = makeSignalRow({
    status:   "active",
    occurredAt: daysAgo(62),   // executive_hire: 62 days ago
    expiresAt:  daysAgo(32),   // 30-day TTL → expired 32 days ago
  });
  const { inputs, excludedCount } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs.length, 0);
  assert.equal(excludedCount, 1);
});

test("buildScoreInputs: freshnessScore is computed from computeFreshnessScore (linear decay, explicit formula)", () => {
  // executive_hire (30-day TTL):
  //   occurredAt = 15 days ago, expiresAt = 15 days from now
  //   window = 30 days; elapsed = 15 days
  //   freshnessScore = floor((1 - 15/30) × 100) = floor(50.0) = 50
  const row = makeSignalRow({
    occurredAt: daysAgo(15),
    expiresAt:  daysAhead(15),
    signalStrength: 75,
  });
  const { inputs } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].freshnessScore, 50, "Expected floor((1 - 15/30) × 100) = 50");
});

test("buildScoreInputs: freshnessScore at edge — fully fresh (occurredAt = now) → 100", () => {
  const row = makeSignalRow({
    occurredAt: FIXED_NOW.toISOString(),  // just happened
    expiresAt:  daysAhead(30),
  });
  const { inputs } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs[0].freshnessScore, 100);
});

test("buildScoreInputs: freshnessScore at edge — signal one second before expiresAt → 0 (last moment)", () => {
  // At exactly expiresAt, isExpired returns true and the signal is excluded.
  // One millisecond before expiresAt the signal is included with freshnessScore = 0.
  const expiresAt = new Date(FIXED_NOW.getTime() + 1000).toISOString();  // 1s from now
  const row = makeSignalRow({
    occurredAt: daysAgo(30),
    expiresAt,
    status: "active",
  });
  const { inputs, excludedCount } = buildScoreInputs([row], FIXED_NOW);
  // expiresAt is 1s in the future, so isExpired=false → included
  assert.equal(inputs.length, 1);
  assert.equal(excludedCount, 0);
  // Freshness: nearly expired → very low; floor((1 - ~29.999/30) × 100) ≈ 0
  assert.ok(inputs[0].freshnessScore <= 1, `Expected near-zero freshness, got ${inputs[0].freshnessScore}`);
});

test("buildScoreInputs: signalStrength is taken from the DB row, not recomputed", () => {
  // The row's signalStrength is a custom value (99), not the type-default (75).
  // buildScoreInputs must pass it through unchanged.
  const row = makeSignalRow({ signalStrength: 99, signalType: "executive_hire" });
  const { inputs } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs[0].signalStrength, 99);
});

test("buildScoreInputs: signalId is taken from the DB row's id field", () => {
  const row = makeSignalRow({ id: "signal-uuid-abc" });
  const { inputs } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs[0].signalId, "signal-uuid-abc");
});

test("buildScoreInputs: occurredAt is passed through to SignalScoreInput", () => {
  const occurredAt = daysAgo(10);
  const row = makeSignalRow({ occurredAt, expiresAt: daysAhead(20) });
  const { inputs } = buildScoreInputs([row], FIXED_NOW);
  assert.equal(inputs[0].occurredAt, occurredAt);
});

test("buildScoreInputs: mixed batch (2 active, 1 expired, 1 dismissed) → 2 inputs, 2 excluded", () => {
  const rows = [
    makeSignalRow({ id: "a1", status: "active" }),
    makeSignalRow({ id: "a2", status: "active" }),
    makeSignalRow({ id: "e1", status: "expired" }),
    makeSignalRow({ id: "d1", status: "dismissed" }),
  ];
  const { inputs, excludedCount } = buildScoreInputs(rows, FIXED_NOW);
  assert.equal(inputs.length, 2);
  assert.equal(excludedCount, 2);
  assert.ok(inputs.some((i) => i.signalId === "a1"));
  assert.ok(inputs.some((i) => i.signalId === "a2"));
});

test("buildScoreInputs: different signal types pass through with correct type field", () => {
  const rows = [
    makeSignalRow({ id: "fr", signalType: "funding_round",  expiresAt: daysAhead(90) }),
    makeSignalRow({ id: "jp", signalType: "job_posting",    expiresAt: daysAhead(14) }),
    makeSignalRow({ id: "nm", signalType: "news_mention",   expiresAt: daysAhead(7)  }),
  ];
  const { inputs, excludedCount } = buildScoreInputs(rows, FIXED_NOW);
  assert.equal(inputs.length, 3);
  assert.equal(excludedCount, 0);
  const types = inputs.map((i) => i.signalType).sort();
  assert.deepEqual(types, ["funding_round", "job_posting", "news_mention"]);
});

test("buildScoreInputs → computeOpportunityScore: full integration with explicit formula check", () => {
  // executive_hire: strength=75 (from row), occurredAt=15d ago, expiresAt=15d from now
  //   freshnessScore = floor((1 - 15/30) × 100) = 50
  //   contribution   = (75 × 50 × 0.90) / 100 = 33.75
  //   rawScore = 33.75; LEADERSHIP_CHANGE cluster depth=1 → cf=1.0
  //   icpScore=80; icpFitWeight=0.80
  //   finalScore = min(100, round(33.75 × 1.0 × 0.80)) = round(27.0) = 27
  //
  // Also includes 1 excluded signal (status='expired') → excludedSignalCount=1

  const rows = [
    makeSignalRow({ id: "sr-active", signalType: "executive_hire", signalStrength: 75 }),
    makeSignalRow({ id: "sr-expired", status: "expired" }),
  ];

  const { inputs, excludedCount } = buildScoreInputs(rows, FIXED_NOW);
  assert.equal(inputs.length, 1);
  assert.equal(excludedCount, 1);
  assert.equal(inputs[0].freshnessScore, 50);

  const result = computeOpportunityScore(inputs, 80, FIXED_NOW, excludedCount);

  assert.equal(result.signalCount,         1);
  assert.equal(result.excludedSignalCount, 1);
  assert.equal(result.signals[0].contribution, 33.75, "Expected (75×50×0.90)/100 = 33.75");
  assert.equal(result.rawScore,            33.75);
  assert.equal(result.corroborationFactor, 1.0);
  assert.equal(result.icpFitWeight,        0.80);
  assert.equal(result.finalScore,          27, "Expected round(33.75 × 1.0 × 0.80) = round(27.0) = 27");
});
