/**
 * Unit tests for src/db/account-intelligence.ts — Stage 12.
 *
 * All tests are pure / deterministic. No database, no network, no env vars.
 * Async persistence functions (upsertAccountIntelligence, getAccountIntelligence,
 * getTopAccountsByScore, getAllAccountIntelligence) are not tested here — they
 * require a live Supabase connection and are covered by the Step 8 integration
 * test (scripts/opportunity-scoring-integration-test.ts).
 *
 * Coverage:
 *   buildAccountIntelligenceRow  — column mapping, excluded fields, all values
 *   fromAccountIntelligenceRow   — camelCase mapping, null score_inputs handling
 *   Round-trip                   — build → from → verify all fields preserved
 *   Client isolation             — different clientId produces distinct row key
 *   score_inputs shape           — full OpportunityScoreResult round-trips intact
 *   opportunityScore             — always the integer finalScore from scoring result
 *   updated_at                   — always set to the passed-in `now`
 *   opportunity_score_updated_at — taken from scoreResult.computedAt
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAccountIntelligenceRow,
  fromAccountIntelligenceRow,
  buildRankedEntries,
} from "../db/account-intelligence";
import { computeOpportunityScore } from "../lib/opportunity-scoring";
import type { OpportunityScoreResult } from "../lib/opportunity-scoring";
import type { AccountIntelligenceRow, CompanyIdentity, RankedAccountEntry } from "../db/account-intelligence";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_A  = "00000000-0000-0000-0000-0000000000a1";
const CLIENT_B  = "00000000-0000-0000-0000-0000000000b1";
const COMPANY_A = "00000000-0000-0000-0000-000000000001";
const COMPANY_B = "00000000-0000-0000-0000-000000000002";

const FIXED_NOW    = new Date("2026-09-01T12:00:00.000Z");
const FIXED_NOW_TS = FIXED_NOW.toISOString();

// A hand-crafted score result whose arithmetic is independently verifiable:
//   funding_round: (90 × 80 × 1.00)/100 = 72.00  [GROWTH cluster]
//   executive_hire: (75 × 60 × 0.90)/100 = 40.50  [LEADERSHIP_CHANGE cluster]
//   rawScore = 112.50; cf = 1.0; icpFitWeight = 0.80
//   finalScore = min(100, round(112.50 × 1.0 × 0.80)) = round(90) = 90
const MOCK_SCORE_RESULT: OpportunityScoreResult = {
  hypothesis:          "INITIAL_HYPOTHESIS_NOT_VALIDATED",
  computedAt:          "2026-09-01T12:00:00.000Z",
  signalCount:         2,
  rawScore:            112.50,
  corroborationFactor: 1.0,
  icpFitWeight:        0.80,
  icpScore:            80,
  icpScoreSource:
    "companies.icp_score (global — TEMPORARY COMPROMISE: reflects last writer when multiple clients target the same company)",
  finalScore: 90,
  excludedSignalCount: 0,
  signals: [
    {
      signalId:       "sig-001",
      signalType:     "funding_round",
      signalStrength: 90,
      freshnessScore: 80,
      icpRelevance:   1.00,
      contribution:   72.00,
    },
    {
      signalId:       "sig-002",
      signalType:     "executive_hire",
      signalStrength: 75,
      freshnessScore: 60,
      icpRelevance:   0.90,
      contribution:   40.50,
    },
  ],
};

// A second result produced by the real scoring function (zero signals for simplicity)
const ZERO_SCORE_RESULT: OpportunityScoreResult = computeOpportunityScore([], 0, FIXED_NOW);

// A simulated DB row (as Supabase would return it after SELECT)
function makeDbRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id:                          "aaaaaaaa-0000-0000-0000-000000000001",
    client_id:                   CLIENT_A,
    company_id:                  COMPANY_A,
    opportunity_score:           90,
    opportunity_score_updated_at: "2026-09-01T12:00:00.000Z",
    score_inputs:                MOCK_SCORE_RESULT,
    created_at:                  "2026-08-01T00:00:00.000Z",
    updated_at:                  FIXED_NOW_TS,
    ...overrides,
  };
}

// ── buildAccountIntelligenceRow — column mapping ──────────────────────────────

test("buildRow: client_id maps from clientId argument", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.equal(row.client_id, CLIENT_A);
});

test("buildRow: company_id maps from companyId argument", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.equal(row.company_id, COMPANY_A);
});

test("buildRow: opportunity_score is the integer finalScore from the scoring result", () => {
  // MOCK_SCORE_RESULT.finalScore = 90
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.equal(row.opportunity_score, 90);
  assert.equal(typeof row.opportunity_score, "number");
});

test("buildRow: opportunity_score_updated_at is taken from scoreResult.computedAt", () => {
  // computedAt = "2026-09-01T12:00:00.000Z"; `now` argument is distinct
  const differentNow = new Date("2026-09-02T08:00:00.000Z");
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, differentNow);
  assert.equal(row.opportunity_score_updated_at, MOCK_SCORE_RESULT.computedAt);
  assert.notEqual(row.opportunity_score_updated_at, differentNow.toISOString());
});

test("buildRow: score_inputs stores the complete OpportunityScoreResult", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.deepEqual(row.score_inputs, MOCK_SCORE_RESULT);
});

test("buildRow: updated_at is set to now.toISOString()", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.equal(row.updated_at, FIXED_NOW_TS);
});

test("buildRow: id is not present (DB generates via gen_random_uuid)", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.equal("id" in row, false);
});

test("buildRow: created_at is not present (DB sets via DEFAULT now() on INSERT)", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.equal("created_at" in row, false);
});

test("buildRow: row contains exactly the 6 expected column keys", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  const keys = Object.keys(row).sort();
  assert.deepEqual(keys, [
    "client_id",
    "company_id",
    "opportunity_score",
    "opportunity_score_updated_at",
    "score_inputs",
    "updated_at",
  ]);
});

test("buildRow: finalScore 0 is stored as 0, not null or undefined", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, ZERO_SCORE_RESULT, FIXED_NOW);
  assert.equal(row.opportunity_score, 0);
  assert.notEqual(row.opportunity_score, null);
  assert.notEqual(row.opportunity_score, undefined);
});

test("buildRow: score_inputs.hypothesis is always INITIAL_HYPOTHESIS_NOT_VALIDATED", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  const si = row.score_inputs as OpportunityScoreResult;
  assert.equal(si.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
});

// ── buildAccountIntelligenceRow — client isolation ────────────────────────────

test("buildRow: different clientIds produce different client_id values (client isolation)", () => {
  const rowA = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  const rowB = buildAccountIntelligenceRow(CLIENT_B, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.notEqual(rowA.client_id, rowB.client_id);
  assert.equal(rowA.company_id, rowB.company_id);  // same company
});

test("buildRow: different companyIds produce different company_id values", () => {
  const rowA = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  const rowB = buildAccountIntelligenceRow(CLIENT_A, COMPANY_B, MOCK_SCORE_RESULT, FIXED_NOW);
  assert.equal(rowA.client_id, rowB.client_id);    // same client
  assert.notEqual(rowA.company_id, rowB.company_id);
});

// ── fromAccountIntelligenceRow — column mapping ───────────────────────────────

test("fromRow: id maps from row.id", () => {
  const result = fromAccountIntelligenceRow(makeDbRow());
  assert.equal(result.id, "aaaaaaaa-0000-0000-0000-000000000001");
});

test("fromRow: clientId maps from row.client_id", () => {
  const result = fromAccountIntelligenceRow(makeDbRow());
  assert.equal(result.clientId, CLIENT_A);
});

test("fromRow: companyId maps from row.company_id", () => {
  const result = fromAccountIntelligenceRow(makeDbRow());
  assert.equal(result.companyId, COMPANY_A);
});

test("fromRow: opportunityScore maps from row.opportunity_score", () => {
  const result = fromAccountIntelligenceRow(makeDbRow());
  assert.equal(result.opportunityScore, 90);
});

test("fromRow: opportunityScoreUpdatedAt maps from row.opportunity_score_updated_at", () => {
  const result = fromAccountIntelligenceRow(makeDbRow());
  assert.equal(result.opportunityScoreUpdatedAt, "2026-09-01T12:00:00.000Z");
});

test("fromRow: scoreInputs maps from row.score_inputs", () => {
  const result = fromAccountIntelligenceRow(makeDbRow());
  assert.deepEqual(result.scoreInputs, MOCK_SCORE_RESULT);
});

test("fromRow: createdAt maps from row.created_at", () => {
  const result = fromAccountIntelligenceRow(makeDbRow());
  assert.equal(result.createdAt, "2026-08-01T00:00:00.000Z");
});

test("fromRow: updatedAt maps from row.updated_at", () => {
  const result = fromAccountIntelligenceRow(makeDbRow());
  assert.equal(result.updatedAt, FIXED_NOW_TS);
});

test("fromRow: null score_inputs is returned as null (not undefined)", () => {
  const result = fromAccountIntelligenceRow(makeDbRow({ score_inputs: null }));
  assert.equal(result.scoreInputs, null);
  assert.notEqual(result.scoreInputs, undefined);
});

// ── Round-trip: buildRow → fromRow ────────────────────────────────────────────

test("round-trip: all persisted fields survive build → from", () => {
  const built = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);

  // Simulate what Supabase returns after INSERT/SELECT: add DB-generated columns
  const dbRow: Record<string, unknown> = {
    ...built,
    id:         "bbbbbbbb-0000-0000-0000-000000000002",
    created_at: "2026-08-15T00:00:00.000Z",
  };

  const result: AccountIntelligenceRow = fromAccountIntelligenceRow(dbRow);

  assert.equal(result.id,                        "bbbbbbbb-0000-0000-0000-000000000002");
  assert.equal(result.clientId,                  CLIENT_A);
  assert.equal(result.companyId,                 COMPANY_A);
  assert.equal(result.opportunityScore,          MOCK_SCORE_RESULT.finalScore);
  assert.equal(result.opportunityScoreUpdatedAt, MOCK_SCORE_RESULT.computedAt);
  assert.deepEqual(result.scoreInputs,           MOCK_SCORE_RESULT);
  assert.equal(result.createdAt,                 "2026-08-15T00:00:00.000Z");
  assert.equal(result.updatedAt,                 FIXED_NOW_TS);
});

test("round-trip: opportunityScore equals scoreInputs.finalScore after round-trip", () => {
  const built = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  const dbRow = { ...built, id: "cc-id", created_at: FIXED_NOW_TS };
  const result = fromAccountIntelligenceRow(dbRow);

  assert.equal(result.opportunityScore, result.scoreInputs?.finalScore);
});

test("round-trip: zero-signal zero-icp result round-trips correctly", () => {
  const built = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, ZERO_SCORE_RESULT, FIXED_NOW);
  const dbRow = { ...built, id: "dd-id", created_at: FIXED_NOW_TS };
  const result = fromAccountIntelligenceRow(dbRow);

  assert.equal(result.opportunityScore, 0);
  assert.equal(result.scoreInputs?.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  assert.equal(result.scoreInputs?.finalScore, 0);
  assert.equal(result.scoreInputs?.signalCount, 0);
});

// ── score_inputs shape — all required fields preserved ────────────────────────

test("score_inputs: all OpportunityScoreResult fields are preserved through buildRow", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  const si = row.score_inputs as OpportunityScoreResult;

  assert.equal(si.hypothesis,          "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  assert.equal(si.computedAt,          MOCK_SCORE_RESULT.computedAt);
  assert.equal(si.signalCount,         2);
  assert.equal(si.rawScore,            112.50);
  assert.equal(si.corroborationFactor, 1.0);
  assert.equal(si.icpFitWeight,        0.80);
  assert.equal(si.icpScore,            80);
  assert.equal(
    si.icpScoreSource,
    "companies.icp_score (global — TEMPORARY COMPROMISE: reflects last writer when multiple clients target the same company)",
  );
  assert.equal(si.finalScore, 90);
  assert.equal(si.excludedSignalCount, 0);
  assert.equal(si.signals.length, 2);
});

test("score_inputs: signals[] per-signal breakdown is preserved in full", () => {
  const row = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, MOCK_SCORE_RESULT, FIXED_NOW);
  const si = row.score_inputs as OpportunityScoreResult;
  const s0 = si.signals[0];
  const s1 = si.signals[1];

  assert.equal(s0.signalId,       "sig-001");
  assert.equal(s0.signalType,     "funding_round");
  assert.equal(s0.signalStrength, 90);
  assert.equal(s0.freshnessScore, 80);
  assert.equal(s0.icpRelevance,   1.00);
  assert.equal(s0.contribution,   72.00);

  assert.equal(s1.signalId,       "sig-002");
  assert.equal(s1.signalType,     "executive_hire");
  assert.equal(s1.icpRelevance,   0.90);
  assert.equal(s1.contribution,   40.50);
});

// ── Integration with computeOpportunityScore ──────────────────────────────────

test("integration: row built from real computeOpportunityScore output round-trips correctly", () => {
  // Use the real scoring function to produce a result, then verify the DB layer
  // stores and retrieves it intact — end-to-end without a real DB.
  const realResult = computeOpportunityScore(
    [
      {
        signalId:       "real-sig-001",
        signalType:     "funding_round",
        signalStrength: 90,
        freshnessScore: 100,
        occurredAt:     "2026-08-01T00:00:00.000Z",
      },
      {
        signalId:       "real-sig-002",
        signalType:     "expansion",
        signalStrength: 65,
        freshnessScore: 100,
        occurredAt:     "2026-08-20T00:00:00.000Z",
      },
    ],
    75,
    FIXED_NOW,
  );

  const built = buildAccountIntelligenceRow(CLIENT_A, COMPANY_A, realResult, FIXED_NOW);
  const dbRow = { ...built, id: "real-id", created_at: FIXED_NOW_TS };
  const result = fromAccountIntelligenceRow(dbRow);

  // finalScore from the formula:
  // funding_round: (90×100×1.00)/100 = 90; expansion: (65×100×0.80)/100 = 52
  // rawScore = 142; GROWTH depth=2 → cf=1.15; icpFit=0.75
  // finalScore = min(100, round(142 × 1.15 × 0.75)) = round(122.475) = 122 → capped at 100
  assert.equal(result.opportunityScore, realResult.finalScore);
  assert.equal(result.scoreInputs?.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  assert.equal(result.scoreInputs?.signalCount, 2);
  assert.equal(result.scoreInputs?.corroborationFactor, 1.15);
  assert.deepEqual(result.scoreInputs, realResult);
});

// ── buildRankedEntries — Step 7 ───────────────────────────────────────────────
//
// All tests below are pure / deterministic — no DB, no network.
//
// Coverage:
//   Empty input          — empty array in, empty array out
//   Field mapping        — all RankedAccountEntry fields populated correctly
//   opportunityScore     — preserved from AccountIntelligenceRow
//   opportunityScoreUpdatedAt — preserved (stale score visibility)
//   signalCount          — promoted from score_inputs
//   excludedSignalCount  — promoted from score_inputs
//   icpScore             — promoted from score_inputs
//   null scoreInputs     — promoted fields are null (pre-Stage-12 rows)
//   scoreInputs          — preserved in full for auditability
//   companyName/domain/websiteUrl — taken from company map
//   Missing company      — fallback companyName contains companyId
//   Input order preserved — ranking from DB query is not scrambled by the mapper
//   Tie-breaking         — equal-score rows in input order ⇒ same order in output
//   Client isolation     — clientId is preserved per entry; two clients produce distinct entries
//   Multiple entries     — all entries correct when input has many rows

// Helpers

function makeAiRow(overrides: Partial<AccountIntelligenceRow> = {}): AccountIntelligenceRow {
  return {
    id:                        "ai-row-001",
    clientId:                  CLIENT_A,
    companyId:                 COMPANY_A,
    opportunityScore:          75,
    opportunityScoreUpdatedAt: FIXED_NOW_TS,
    scoreInputs:               MOCK_SCORE_RESULT,
    createdAt:                 "2026-08-01T00:00:00.000Z",
    updatedAt:                 FIXED_NOW_TS,
    ...overrides,
  };
}

function makeCompanyMap(
  entries: Array<[string, Partial<CompanyIdentity>]> = [[COMPANY_A, {}]],
): Map<string, CompanyIdentity> {
  const map = new Map<string, CompanyIdentity>();
  for (const [id, override] of entries) {
    map.set(id, {
      name:       "Acme Corp",
      domain:     "acme.com",
      websiteUrl: "https://acme.com",
      ...override,
    });
  }
  return map;
}

// ── Empty input ───────────────────────────────────────────────────────────────

test("buildRankedEntries: empty aiRows → empty array", () => {
  const result = buildRankedEntries([], makeCompanyMap());
  assert.deepEqual(result, []);
});

// ── Field mapping ─────────────────────────────────────────────────────────────

test("buildRankedEntries: id maps from account_intelligence row id", () => {
  const row = makeAiRow({ id: "ai-uuid-001" });
  const [entry] = buildRankedEntries([row], makeCompanyMap());
  assert.equal(entry.id, "ai-uuid-001");
});

test("buildRankedEntries: clientId is preserved from account_intelligence row", () => {
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap());
  assert.equal(entry.clientId, CLIENT_A);
});

test("buildRankedEntries: companyId is preserved from account_intelligence row", () => {
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap());
  assert.equal(entry.companyId, COMPANY_A);
});

// ── opportunityScore ──────────────────────────────────────────────────────────

test("buildRankedEntries: opportunityScore is preserved from account_intelligence row", () => {
  const row = makeAiRow({ opportunityScore: 83 });
  const [entry] = buildRankedEntries([row], makeCompanyMap());
  assert.equal(entry.opportunityScore, 83);
});

test("buildRankedEntries: opportunityScore=0 is preserved (not coerced to null or undefined)", () => {
  const row = makeAiRow({ opportunityScore: 0 });
  const [entry] = buildRankedEntries([row], makeCompanyMap());
  assert.equal(entry.opportunityScore, 0);
  assert.notEqual(entry.opportunityScore, null);
  assert.notEqual(entry.opportunityScore, undefined);
});

// ── opportunityScoreUpdatedAt (stale score visibility) ────────────────────────

test("buildRankedEntries: opportunityScoreUpdatedAt is preserved from account_intelligence row", () => {
  // Stale timestamp — score was computed long ago. Must be visible in the entry,
  // not hidden or replaced. Stage 12 exposes the timestamp; callers decide staleness.
  const staleTs = "2026-01-01T00:00:00.000Z";
  const row = makeAiRow({ opportunityScoreUpdatedAt: staleTs });
  const [entry] = buildRankedEntries([row], makeCompanyMap());
  assert.equal(entry.opportunityScoreUpdatedAt, staleTs);
});

test("buildRankedEntries: opportunityScoreUpdatedAt is a string (not coerced)", () => {
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap());
  assert.equal(typeof entry.opportunityScoreUpdatedAt, "string");
});

// ── Score breakdown fields (promoted from scoreInputs) ────────────────────────

test("buildRankedEntries: signalCount promoted from score_inputs", () => {
  // MOCK_SCORE_RESULT.signalCount = 2
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap());
  assert.equal(entry.signalCount, 2);
});

test("buildRankedEntries: excludedSignalCount promoted from score_inputs", () => {
  // MOCK_SCORE_RESULT.excludedSignalCount = 0
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap());
  assert.equal(entry.excludedSignalCount, 0);
});

test("buildRankedEntries: icpScore promoted from score_inputs", () => {
  // MOCK_SCORE_RESULT.icpScore = 80
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap());
  assert.equal(entry.icpScore, 80);
});

test("buildRankedEntries: null score_inputs → signalCount is null", () => {
  const row = makeAiRow({ scoreInputs: null });
  const [entry] = buildRankedEntries([row], makeCompanyMap());
  assert.equal(entry.signalCount, null);
});

test("buildRankedEntries: null score_inputs → excludedSignalCount is null", () => {
  const row = makeAiRow({ scoreInputs: null });
  const [entry] = buildRankedEntries([row], makeCompanyMap());
  assert.equal(entry.excludedSignalCount, null);
});

test("buildRankedEntries: null score_inputs → icpScore is null", () => {
  const row = makeAiRow({ scoreInputs: null });
  const [entry] = buildRankedEntries([row], makeCompanyMap());
  assert.equal(entry.icpScore, null);
});

// ── scoreInputs (auditability) ────────────────────────────────────────────────

test("buildRankedEntries: scoreInputs is preserved in full for auditability", () => {
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap());
  assert.deepEqual(entry.scoreInputs, MOCK_SCORE_RESULT);
});

test("buildRankedEntries: null scoreInputs is returned as null (not undefined)", () => {
  const row = makeAiRow({ scoreInputs: null });
  const [entry] = buildRankedEntries([row], makeCompanyMap());
  assert.equal(entry.scoreInputs, null);
  assert.notEqual(entry.scoreInputs, undefined);
});

test("buildRankedEntries: scoreInputs.hypothesis is INITIAL_HYPOTHESIS_NOT_VALIDATED", () => {
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap());
  assert.equal(entry.scoreInputs?.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
});

// ── Company identity ──────────────────────────────────────────────────────────

test("buildRankedEntries: companyName taken from company map", () => {
  const map = makeCompanyMap([[COMPANY_A, { name: "TargetCo" }]]);
  const [entry] = buildRankedEntries([makeAiRow()], map);
  assert.equal(entry.companyName, "TargetCo");
});

test("buildRankedEntries: companyDomain taken from company map", () => {
  const map = makeCompanyMap([[COMPANY_A, { domain: "targetco.com" }]]);
  const [entry] = buildRankedEntries([makeAiRow()], map);
  assert.equal(entry.companyDomain, "targetco.com");
});

test("buildRankedEntries: companyWebsiteUrl taken from company map", () => {
  const map = makeCompanyMap([[COMPANY_A, { websiteUrl: "https://targetco.com" }]]);
  const [entry] = buildRankedEntries([makeAiRow()], map);
  assert.equal(entry.companyWebsiteUrl, "https://targetco.com");
});

test("buildRankedEntries: null domain in company map → companyDomain is null", () => {
  const map = makeCompanyMap([[COMPANY_A, { domain: null }]]);
  const [entry] = buildRankedEntries([makeAiRow()], map);
  assert.equal(entry.companyDomain, null);
});

test("buildRankedEntries: null websiteUrl in company map → companyWebsiteUrl is null", () => {
  const map = makeCompanyMap([[COMPANY_A, { websiteUrl: null }]]);
  const [entry] = buildRankedEntries([makeAiRow()], map);
  assert.equal(entry.companyWebsiteUrl, null);
});

// ── Missing company (defensive fallback) ──────────────────────────────────────

test("buildRankedEntries: missing company in map → companyName is fallback containing companyId", () => {
  // companyMap has no entry for COMPANY_A — simulate an unexpected orphan
  const emptyMap = new Map<string, CompanyIdentity>();
  const [entry] = buildRankedEntries([makeAiRow()], emptyMap);
  assert.ok(
    entry.companyName.includes(COMPANY_A),
    `Expected fallback string to contain companyId, got: "${entry.companyName}"`,
  );
});

test("buildRankedEntries: missing company in map → companyDomain is null", () => {
  const emptyMap = new Map<string, CompanyIdentity>();
  const [entry] = buildRankedEntries([makeAiRow()], emptyMap);
  assert.equal(entry.companyDomain, null);
});

test("buildRankedEntries: missing company in map → companyWebsiteUrl is null", () => {
  const emptyMap = new Map<string, CompanyIdentity>();
  const [entry] = buildRankedEntries([makeAiRow()], emptyMap);
  assert.equal(entry.companyWebsiteUrl, null);
});

// ── Input order preserved (ranking) ──────────────────────────────────────────

test("buildRankedEntries: output order matches input order — higher score first (ranking not scrambled)", () => {
  // The DB query orders by opportunity_score DESC. buildRankedEntries must
  // preserve that ordering — it must not reorder entries.
  const rowHigh = makeAiRow({ id: "ai-h", companyId: COMPANY_A, opportunityScore: 90 });
  const rowMid  = makeAiRow({ id: "ai-m", companyId: COMPANY_B, opportunityScore: 60 });
  const rowLow  = makeAiRow({ id: "ai-l", companyId: "00000000-0000-0000-0000-000000000003", opportunityScore: 30 });

  const map = makeCompanyMap([
    [COMPANY_A, { name: "HighCo" }],
    [COMPANY_B, { name: "MidCo"  }],
    ["00000000-0000-0000-0000-000000000003", { name: "LowCo" }],
  ]);

  const entries = buildRankedEntries([rowHigh, rowMid, rowLow], map);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].opportunityScore, 90);
  assert.equal(entries[1].opportunityScore, 60);
  assert.equal(entries[2].opportunityScore, 30);
  assert.equal(entries[0].companyName, "HighCo");
  assert.equal(entries[1].companyName, "MidCo");
  assert.equal(entries[2].companyName, "LowCo");
});

// ── Tie-breaking ──────────────────────────────────────────────────────────────

test("buildRankedEntries: equal scores — input order preserved (tie-break is DB's responsibility)", () => {
  // The DB orders equal-score rows by company_id ASC. buildRankedEntries must
  // not reorder them. We feed the rows in already-sorted order (aaa < bbb)
  // and verify the output preserves that order.
  const rowA = makeAiRow({
    id:               "ai-aaa",
    companyId:        "00000000-0000-0000-0000-aaaaaaaaaaaa",
    opportunityScore: 70,
  });
  const rowB = makeAiRow({
    id:               "ai-bbb",
    companyId:        "00000000-0000-0000-0000-bbbbbbbbbbbb",
    opportunityScore: 70,  // same score as rowA
  });

  const map = makeCompanyMap([
    ["00000000-0000-0000-0000-aaaaaaaaaaaa", { name: "AlphaCo" }],
    ["00000000-0000-0000-0000-bbbbbbbbbbbb", { name: "BetaCo"  }],
  ]);

  const entries = buildRankedEntries([rowA, rowB], map);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].opportunityScore, 70);
  assert.equal(entries[1].opportunityScore, 70);
  // Tie-break from DB: aaa < bbb → aaa comes first
  assert.equal(entries[0].companyId, "00000000-0000-0000-0000-aaaaaaaaaaaa");
  assert.equal(entries[1].companyId, "00000000-0000-0000-0000-bbbbbbbbbbbb");
  assert.equal(entries[0].companyName, "AlphaCo");
  assert.equal(entries[1].companyName, "BetaCo");
});

// ── Client isolation ──────────────────────────────────────────────────────────

test("buildRankedEntries: clientId is preserved per entry (client isolation)", () => {
  const rowA = makeAiRow({ id: "ai-ca", clientId: CLIENT_A, companyId: COMPANY_A });
  const rowB = makeAiRow({ id: "ai-cb", clientId: CLIENT_B, companyId: COMPANY_B });

  const map = makeCompanyMap([
    [COMPANY_A, { name: "CompanyA" }],
    [COMPANY_B, { name: "CompanyB" }],
  ]);

  const entries = buildRankedEntries([rowA, rowB], map);
  assert.equal(entries[0].clientId, CLIENT_A);
  assert.equal(entries[1].clientId, CLIENT_B);
});

test("buildRankedEntries: two clients produce entries with distinct clientIds", () => {
  const rowA = makeAiRow({ id: "ai-1", clientId: CLIENT_A });
  const rowB = makeAiRow({ id: "ai-2", clientId: CLIENT_B, companyId: COMPANY_B });
  const map  = makeCompanyMap([[COMPANY_A, {}], [COMPANY_B, {}]]);

  const entries = buildRankedEntries([rowA, rowB], map);
  assert.notEqual(entries[0].clientId, entries[1].clientId);
});

// ── Multiple entries ──────────────────────────────────────────────────────────

test("buildRankedEntries: correct entry count matches input row count", () => {
  const rows = [
    makeAiRow({ id: "r1", companyId: COMPANY_A }),
    makeAiRow({ id: "r2", companyId: COMPANY_B }),
    makeAiRow({ id: "r3", companyId: "00000000-0000-0000-0000-000000000003" }),
  ];
  const map = makeCompanyMap([
    [COMPANY_A, { name: "A" }],
    [COMPANY_B, { name: "B" }],
    ["00000000-0000-0000-0000-000000000003", { name: "C" }],
  ]);
  const entries = buildRankedEntries(rows, map);
  assert.equal(entries.length, 3);
});

test("buildRankedEntries: each entry has the correct companyId from its source row", () => {
  const rows = [
    makeAiRow({ id: "r1", companyId: COMPANY_A }),
    makeAiRow({ id: "r2", companyId: COMPANY_B }),
  ];
  const map = makeCompanyMap([[COMPANY_A, { name: "A" }], [COMPANY_B, { name: "B" }]]);
  const entries = buildRankedEntries(rows, map);
  assert.equal(entries[0].companyId, COMPANY_A);
  assert.equal(entries[1].companyId, COMPANY_B);
});

// ── RankedAccountEntry shape ──────────────────────────────────────────────────

test("buildRankedEntries: returned entry has all expected top-level fields", () => {
  const [entry] = buildRankedEntries([makeAiRow()], makeCompanyMap()) as RankedAccountEntry[];
  // Verify every required field is present (not undefined or missing key)
  const keys = Object.keys(entry).sort();
  assert.deepEqual(keys, [
    "clientId",
    "companyDomain",
    "companyId",
    "companyName",
    "companyWebsiteUrl",
    "excludedSignalCount",
    "icpScore",
    "id",
    "opportunityScore",
    "opportunityScoreUpdatedAt",
    "scoreInputs",
    "signalCount",
  ]);
});
