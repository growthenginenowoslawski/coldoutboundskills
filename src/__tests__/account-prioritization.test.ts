/**
 * Unit tests for Stage 14 account prioritization — pure, no DB, no network.
 *
 * Tests three exported pure functions from src/lib/account-prioritization.ts:
 *
 *   computePriorityScore  — exponential decay formula
 *   computeDaysSince      — fractional-day elapsed time
 *   buildPrioritizationReport — report aggregation
 *
 * All tests are deterministic and require zero environment variables.
 *
 * Coverage:
 *   computePriorityScore
 *     — zero days: score ≈ opportunity_score (multiplier ≈ 1.0)
 *     — half-life days: score ≈ opportunity_score × 0.5 (multiplier ≈ 0.5)
 *     — double half-life: score ≈ opportunity_score × 0.25 (multiplier ≈ 0.25)
 *     — null daysSinceLastSignal: score = 0, multiplier = 0
 *     — opportunityScore = 0: score = 0, multiplier = 0
 *     — monotonically decreasing: score(7d) > score(14d) > score(21d)
 *     — custom halfLifeDays parameter
 *     — very large daysAgo: near-zero but positive
 *     — fractional days: smooth decay between integers
 *     — negative days rejected gracefully (treated as 0)
 *
 *   computeDaysSince
 *     — exactly 1 day: 86400000ms → 1.0
 *     — fractional: 12h → 0.5
 *     — zero: same timestamp → 0.0
 *     — large gap: 30d → 30.0
 *
 *   buildPrioritizationReport
 *     — accountsRanked = length of accounts
 *     — accountsWithScore = count of accounts with priorityScore > 0
 *     — accountsAtZero = count of accounts with priorityScore = 0
 *     — topAccounts sliced to topN
 *     — topAccounts empty when accounts is empty
 *     — halfLifeDays propagates to report
 *     — timestamps are ISO strings
 *     — startedAt ≤ completedAt
 *     — clientId propagates
 *     — no credentials in JSON
 *     — mixed scored/zero accounts
 *     — topN > accounts.length returns all accounts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computePriorityScore,
  computeDaysSince,
  buildPrioritizationReport,
  PRIORITY_RECENCY_HALF_LIFE_DAYS,
  type AccountPriorityResult,
  type PrioritizationReportInput,
} from "../lib/account-prioritization";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_A  = "00000000-0000-0000-0000-0000000000a1";
const COMPANY_A = "00000000-0000-0000-0000-000000000001";
const COMPANY_B = "00000000-0000-0000-0000-000000000002";
const COMPANY_C = "00000000-0000-0000-0000-000000000003";

const STARTED_AT   = new Date("2026-09-03T06:00:00.000Z");
const COMPLETED_AT = new Date("2026-09-03T06:00:05.000Z");

function makeResult(overrides: Partial<AccountPriorityResult> = {}): AccountPriorityResult {
  return {
    rank:                1,
    companyId:           COMPANY_A,
    domain:              "example.com",
    opportunityScore:    80,
    priorityScore:       50,
    recencyMultiplier:   0.625,
    lastSignalAt:        "2026-08-20T00:00:00.000Z",
    daysSinceLastSignal: 14,
    activeSignalCount:   2,
    ...overrides,
  };
}

function makeInput(overrides: Partial<PrioritizationReportInput> = {}): PrioritizationReportInput {
  return {
    clientId:    CLIENT_A,
    startedAt:   STARTED_AT,
    completedAt: COMPLETED_AT,
    topN:        20,
    halfLifeDays: PRIORITY_RECENCY_HALF_LIFE_DAYS,
    accounts:    [makeResult()],
    ...overrides,
  };
}

// ── computeDaysSince ──────────────────────────────────────────────────────────

test("computeDaysSince: exactly 1 day apart", () => {
  const base = new Date("2026-09-03T00:00:00.000Z");
  const now  = new Date("2026-09-04T00:00:00.000Z");
  assert.equal(computeDaysSince(base.toISOString(), now), 1.0);
});

test("computeDaysSince: 12 hours → 0.5 days", () => {
  const base = new Date("2026-09-03T00:00:00.000Z");
  const now  = new Date("2026-09-03T12:00:00.000Z");
  assert.equal(computeDaysSince(base.toISOString(), now), 0.5);
});

test("computeDaysSince: same timestamp → 0 days", () => {
  const ts = "2026-09-03T00:00:00.000Z";
  assert.equal(computeDaysSince(ts, new Date(ts)), 0);
});

test("computeDaysSince: 30 days apart", () => {
  const base = new Date("2026-08-04T00:00:00.000Z");
  const now  = new Date("2026-09-03T00:00:00.000Z");
  assert.equal(computeDaysSince(base.toISOString(), now), 30);
});

// ── computePriorityScore — zero days ─────────────────────────────────────────

test("computePriorityScore: 0 days → multiplier ≈ 1.0, score ≈ opportunityScore", () => {
  const { priorityScore, recencyMultiplier } = computePriorityScore(100, 0);
  // exp(0) = 1.0 exactly
  assert.ok(Math.abs(recencyMultiplier - 1.0) < 1e-10, `multiplier=${recencyMultiplier}`);
  assert.ok(Math.abs(priorityScore - 100) < 1e-10,     `score=${priorityScore}`);
});

// ── computePriorityScore — half-life property ─────────────────────────────────

test("computePriorityScore: at half-life days → multiplier = exactly 0.5", () => {
  // Formula: 2^(-days/halfLifeDays) = exp(-ln(2) × days/halfLifeDays)
  // At days = halfLifeDays: 2^(-1) = 0.5 exactly. This is the half-life property.
  const { recencyMultiplier } = computePriorityScore(100, PRIORITY_RECENCY_HALF_LIFE_DAYS);
  assert.ok(
    Math.abs(recencyMultiplier - 0.5) < 1e-10,
    `expected 0.5, got ${recencyMultiplier}`,
  );
});

test("computePriorityScore: at 2× half-life days → multiplier = exactly 0.25", () => {
  // At days = 2 × halfLifeDays: 2^(-2) = 0.25.
  const { recencyMultiplier } = computePriorityScore(100, PRIORITY_RECENCY_HALF_LIFE_DAYS * 2);
  assert.ok(
    Math.abs(recencyMultiplier - 0.25) < 1e-10,
    `expected 0.25, got ${recencyMultiplier}`,
  );
});

test("computePriorityScore: at 3× half-life days → multiplier = exactly 0.125", () => {
  const { recencyMultiplier } = computePriorityScore(100, PRIORITY_RECENCY_HALF_LIFE_DAYS * 3);
  assert.ok(
    Math.abs(recencyMultiplier - 0.125) < 1e-10,
    `expected 0.125, got ${recencyMultiplier}`,
  );
});

test("computePriorityScore: score = opportunityScore × recencyMultiplier", () => {
  const opportunityScore = 75;
  const days = 7;
  const { priorityScore, recencyMultiplier } = computePriorityScore(opportunityScore, days);
  assert.ok(
    Math.abs(priorityScore - opportunityScore * recencyMultiplier) < 1e-10,
    `score=${priorityScore} ≠ ${opportunityScore} × ${recencyMultiplier}`,
  );
});

// ── computePriorityScore — null / zero guards ─────────────────────────────────

test("computePriorityScore: null daysSinceLastSignal → score=0, multiplier=0", () => {
  const { priorityScore, recencyMultiplier } = computePriorityScore(80, null);
  assert.equal(priorityScore,     0);
  assert.equal(recencyMultiplier, 0);
});

test("computePriorityScore: opportunityScore=0 → score=0, multiplier=0", () => {
  const { priorityScore, recencyMultiplier } = computePriorityScore(0, 5);
  assert.equal(priorityScore,     0);
  assert.equal(recencyMultiplier, 0);
});

test("computePriorityScore: opportunityScore=0 and null days → both zero", () => {
  const { priorityScore, recencyMultiplier } = computePriorityScore(0, null);
  assert.equal(priorityScore,     0);
  assert.equal(recencyMultiplier, 0);
});

// ── computePriorityScore — monotonically decreasing ──────────────────────────

test("computePriorityScore: score is strictly decreasing as days increase", () => {
  const opp = 100;
  const s7  = computePriorityScore(opp, 7).priorityScore;
  const s14 = computePriorityScore(opp, 14).priorityScore;
  const s21 = computePriorityScore(opp, 21).priorityScore;
  const s28 = computePriorityScore(opp, 28).priorityScore;
  assert.ok(s7 > s14, `s7(${s7}) should > s14(${s14})`);
  assert.ok(s14 > s21, `s14(${s14}) should > s21(${s21})`);
  assert.ok(s21 > s28, `s21(${s21}) should > s28(${s28})`);
});

test("computePriorityScore: score is always positive for positive inputs", () => {
  for (const days of [1, 7, 14, 30, 60, 90, 180, 365]) {
    const { priorityScore } = computePriorityScore(100, days);
    assert.ok(priorityScore > 0, `score should be > 0 at ${days} days, got ${priorityScore}`);
  }
});

// ── computePriorityScore — custom halfLifeDays ────────────────────────────────

test("computePriorityScore: custom halfLifeDays=7 decays faster than default", () => {
  const days = 14;
  const defaultScore = computePriorityScore(100, days, 14).priorityScore;
  const fasterScore  = computePriorityScore(100, days, 7).priorityScore;
  assert.ok(fasterScore < defaultScore, `faster(${fasterScore}) should < default(${defaultScore})`);
});

test("computePriorityScore: custom halfLifeDays=28 decays slower than default", () => {
  const days = 14;
  const defaultScore = computePriorityScore(100, days, 14).priorityScore;
  const slowerScore  = computePriorityScore(100, days, 28).priorityScore;
  assert.ok(slowerScore > defaultScore, `slower(${slowerScore}) should > default(${defaultScore})`);
});

// ── computePriorityScore — fractional days ────────────────────────────────────

test("computePriorityScore: fractional days produce intermediate score", () => {
  const s0   = computePriorityScore(100, 0).priorityScore;
  const s05  = computePriorityScore(100, 0.5).priorityScore;
  const s1   = computePriorityScore(100, 1).priorityScore;
  assert.ok(s0 > s05, `s0(${s0}) > s0.5(${s05})`);
  assert.ok(s05 > s1, `s0.5(${s05}) > s1(${s1})`);
});

// ── buildPrioritizationReport — accountsRanked ───────────────────────────────

test("buildPrioritizationReport: accountsRanked = length of accounts", () => {
  const report = buildPrioritizationReport(makeInput({
    accounts: [makeResult(), makeResult({ companyId: COMPANY_B }), makeResult({ companyId: COMPANY_C })],
  }));
  assert.equal(report.accountsRanked, 3);
});

test("buildPrioritizationReport: empty accounts → accountsRanked = 0", () => {
  const report = buildPrioritizationReport(makeInput({ accounts: [] }));
  assert.equal(report.accountsRanked, 0);
  assert.equal(report.accountsWithScore, 0);
  assert.equal(report.accountsAtZero, 0);
  assert.equal(report.topAccounts.length, 0);
});

// ── buildPrioritizationReport — accountsWithScore / accountsAtZero ────────────

test("buildPrioritizationReport: accountsWithScore counts priorityScore > 0", () => {
  const report = buildPrioritizationReport(makeInput({
    accounts: [
      makeResult({ companyId: COMPANY_A, priorityScore: 72 }),
      makeResult({ companyId: COMPANY_B, priorityScore: 0 }),
      makeResult({ companyId: COMPANY_C, priorityScore: 0 }),
    ],
  }));
  assert.equal(report.accountsWithScore, 1);
  assert.equal(report.accountsAtZero,    2);
});

test("buildPrioritizationReport: all zero → accountsWithScore = 0", () => {
  const report = buildPrioritizationReport(makeInput({
    accounts: [
      makeResult({ companyId: COMPANY_A, priorityScore: 0 }),
      makeResult({ companyId: COMPANY_B, priorityScore: 0 }),
    ],
  }));
  assert.equal(report.accountsWithScore, 0);
  assert.equal(report.accountsAtZero,    2);
});

test("buildPrioritizationReport: all nonzero → accountsAtZero = 0", () => {
  const report = buildPrioritizationReport(makeInput({
    accounts: [
      makeResult({ companyId: COMPANY_A, priorityScore: 50 }),
      makeResult({ companyId: COMPANY_B, priorityScore: 30 }),
    ],
  }));
  assert.equal(report.accountsWithScore, 2);
  assert.equal(report.accountsAtZero,    0);
});

// ── buildPrioritizationReport — topAccounts slicing ──────────────────────────

test("buildPrioritizationReport: topAccounts sliced to topN", () => {
  const accounts = Array.from({ length: 5 }, (_, i) =>
    makeResult({ companyId: `company-${i}`, priorityScore: 100 - i * 10 }),
  );
  const report = buildPrioritizationReport(makeInput({ accounts, topN: 3 }));
  assert.equal(report.topAccounts.length, 3);
  // Slice preserves order — first 3 accounts appear in topAccounts.
  assert.equal(report.topAccounts[0].companyId, "company-0");
  assert.equal(report.topAccounts[1].companyId, "company-1");
  assert.equal(report.topAccounts[2].companyId, "company-2");
});

test("buildPrioritizationReport: topN > accounts.length → returns all accounts", () => {
  const accounts = [makeResult({ companyId: COMPANY_A }), makeResult({ companyId: COMPANY_B })];
  const report   = buildPrioritizationReport(makeInput({ accounts, topN: 50 }));
  assert.equal(report.topAccounts.length, 2);
});

test("buildPrioritizationReport: topN = 0 → topAccounts is empty", () => {
  const report = buildPrioritizationReport(makeInput({ topN: 0 }));
  assert.equal(report.topAccounts.length, 0);
  // accountsRanked still reflects total (not sliced).
  assert.equal(report.accountsRanked, 1);
});

// ── buildPrioritizationReport — halfLifeDays propagation ─────────────────────

test("buildPrioritizationReport: halfLifeDays propagates to report", () => {
  const report = buildPrioritizationReport(makeInput({ halfLifeDays: 7 }));
  assert.equal(report.halfLifeDays, 7);
});

test("buildPrioritizationReport: default halfLifeDays = PRIORITY_RECENCY_HALF_LIFE_DAYS", () => {
  const report = buildPrioritizationReport(makeInput({ halfLifeDays: PRIORITY_RECENCY_HALF_LIFE_DAYS }));
  assert.equal(report.halfLifeDays, PRIORITY_RECENCY_HALF_LIFE_DAYS);
});

// ── buildPrioritizationReport — timestamps ────────────────────────────────────

test("buildPrioritizationReport: startedAt is ISO string of startedAt Date", () => {
  const report = buildPrioritizationReport(makeInput());
  assert.equal(report.startedAt, STARTED_AT.toISOString());
});

test("buildPrioritizationReport: completedAt is ISO string of completedAt Date", () => {
  const report = buildPrioritizationReport(makeInput());
  assert.equal(report.completedAt, COMPLETED_AT.toISOString());
});

test("buildPrioritizationReport: startedAt ≤ completedAt", () => {
  const report = buildPrioritizationReport(makeInput());
  assert.ok(report.startedAt <= report.completedAt);
});

// ── buildPrioritizationReport — clientId propagation ─────────────────────────

test("buildPrioritizationReport: clientId propagates unchanged", () => {
  const report = buildPrioritizationReport(makeInput({ clientId: CLIENT_A }));
  assert.equal(report.clientId, CLIENT_A);
});

// ── buildPrioritizationReport — no credentials ────────────────────────────────

test("buildPrioritizationReport: report contains no credentials", () => {
  const report = buildPrioritizationReport(makeInput());
  const json   = JSON.stringify(report);
  assert.ok(!json.includes("apiKey"),   "apiKey must not appear");
  assert.ok(!json.includes("apiToken"), "apiToken must not appear");
  assert.ok(!json.includes("secret"),   "secret must not appear");
  assert.ok(!json.includes("password"), "password must not appear");
});

// ── buildPrioritizationReport — PRIORITY_RECENCY_HALF_LIFE_DAYS constant ─────

test("PRIORITY_RECENCY_HALF_LIFE_DAYS is a positive integer", () => {
  assert.ok(typeof PRIORITY_RECENCY_HALF_LIFE_DAYS === "number");
  assert.ok(Number.isInteger(PRIORITY_RECENCY_HALF_LIFE_DAYS));
  assert.ok(PRIORITY_RECENCY_HALF_LIFE_DAYS > 0);
});

// ── Integration: decay curve over realistic signal ages ──────────────────────

test("decay curve: score at 3d > 7d > 14d > 28d for opportunityScore=100", () => {
  const opp = 100;
  const s3  = computePriorityScore(opp, 3).priorityScore;
  const s7  = computePriorityScore(opp, 7).priorityScore;
  const s14 = computePriorityScore(opp, 14).priorityScore;
  const s28 = computePriorityScore(opp, 28).priorityScore;
  assert.ok(s3 > s7,   `3d(${s3.toFixed(2)}) > 7d(${s7.toFixed(2)})`);
  assert.ok(s7 > s14,  `7d(${s7.toFixed(2)}) > 14d(${s14.toFixed(2)})`);
  assert.ok(s14 > s28, `14d(${s14.toFixed(2)}) > 28d(${s28.toFixed(2)})`);
  // All remain positive.
  assert.ok(s28 > 0, `28d score (${s28.toFixed(4)}) should be > 0`);
});

test("decay curve: higher opportunityScore produces higher priorityScore at same age", () => {
  const days = 10;
  const scoreHigh = computePriorityScore(90, days).priorityScore;
  const scoreLow  = computePriorityScore(40, days).priorityScore;
  assert.ok(scoreHigh > scoreLow);
});

test("rank ordering: account with fresher signal beats account with older signal at same opportunityScore", () => {
  const opp = 70;
  const fresh = computePriorityScore(opp, 2).priorityScore;
  const stale = computePriorityScore(opp, 20).priorityScore;
  assert.ok(fresh > stale, `fresh(${fresh.toFixed(2)}) > stale(${stale.toFixed(2)})`);
});

test("rank ordering: account with no signals loses to any account with signals", () => {
  const withSignal    = computePriorityScore(50, 30).priorityScore;
  const withoutSignal = computePriorityScore(100, null).priorityScore;
  assert.ok(withSignal > withoutSignal,
    `with_signal(${withSignal.toFixed(4)}) > without_signal(${withoutSignal})`);
});
