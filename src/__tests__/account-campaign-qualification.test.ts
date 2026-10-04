/**
 * Stage 29 Phase 3A — Account Campaign Qualification DB helper tests.
 *
 * Tests the pure functions in src/db/account-campaign-qualification.ts.
 * No DB connection required — all tests are in-memory.
 *
 * Coverage:
 *   1. buildAccountQualificationRow — column mapping, all fields present, no extras
 *   2. fromAccountCampaignQualificationRow — domain object mapping, round-trip fidelity
 *   3. Round-trip: build → from → verify all fields
 *   4. Complete evidence preservation (full AccountQualificationResult in JSONB)
 *   5. qualification_assessed_at sourced from result.assessedAt
 *   6. updated_at sourced from the `now` parameter (deterministic)
 *   7. created_at / id excluded from built row (DB owns these)
 *   8. qualification_score: integer column, correctly round-trips
 *   9. qualified=false preserves score=0 and exclusionReasons
 *  10. Hypothesis label preserved verbatim in stored JSONB
 *  11. Client scoping invariant: campaignStrategyId comes from result, not a separate param
 *  12. Null/missing optional fields handled gracefully by fromRow mapper
 *  13. Two qualifications for the same company differ by campaignStrategyId
 *  14. Mapper does not invent qualification fields absent from DB row
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAccountQualificationRow,
  fromAccountCampaignQualificationRow,
} from "../db/account-campaign-qualification";
import type { AccountQualificationResult } from "../domain/account-qualification-types";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const CLIENT_A    = "aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa";
const CLIENT_B    = "bbbbbbbb-0000-0000-0000-bbbbbbbbbbbb";
const COMPANY_X   = "cccccccc-0000-0000-0000-cccccccccccc";
const STRATEGY_1  = "dddddddd-0000-0000-0000-dddddddddddd";
const STRATEGY_2  = "eeeeeeee-0000-0000-0000-eeeeeeeeeeee";
const FIXED_NOW   = new Date("2026-09-11T10:00:00.000Z");
const ASSESSED_AT = "2026-09-11T09:55:00.000Z";

function makeResult(overrides: Partial<AccountQualificationResult> = {}): AccountQualificationResult {
  return {
    hypothesis:              "INITIAL_HYPOTHESIS_NOT_VALIDATED",
    qualified:               true,
    qualificationScore:      60,
    campaignStrategyId:      STRATEGY_1,
    exclusionReasons:        [],
    geographyVerdict:        "PASS",
    industryVerdict:         "PASS",
    sizeVerdict:             "UNKNOWN",
    hiringEvidenceVerdict:   "UNKNOWN",
    positiveEvidence:        ["Country: United Kingdom — matches target geography"],
    negativeEvidence:        [],
    missingInfo:             ["companySize: not provided"],
    warnings:                [],
    assessedAt:              ASSESSED_AT,
    ...overrides,
  };
}

// ── buildAccountQualificationRow ──────────────────────────────────────────────

describe("buildAccountQualificationRow — column mapping", () => {
  it("maps client_id, company_id, campaign_strategy_id correctly", () => {
    const row = buildAccountQualificationRow(CLIENT_A, COMPANY_X, makeResult(), FIXED_NOW);
    assert.equal(row.client_id,           CLIENT_A);
    assert.equal(row.company_id,          COMPANY_X);
    assert.equal(row.campaign_strategy_id, STRATEGY_1);
  });

  it("promotes qualified and qualification_score from result", () => {
    const row = buildAccountQualificationRow(CLIENT_A, COMPANY_X, makeResult({ qualified: true, qualificationScore: 72 }), FIXED_NOW);
    assert.equal(row.qualified,           true);
    assert.equal(row.qualification_score, 72);
  });

  it("stores the full AccountQualificationResult as the qualification JSONB", () => {
    const result = makeResult();
    const row    = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    assert.deepEqual(row.qualification, result,
      "The full result must be preserved verbatim as JSONB — no fields dropped");
  });

  it("sources qualification_assessed_at from result.assessedAt, not from `now`", () => {
    const result = makeResult({ assessedAt: "2026-09-11T06:00:00.000Z" });
    const row    = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    assert.equal(row.qualification_assessed_at, "2026-09-11T06:00:00.000Z");
    assert.notEqual(row.qualification_assessed_at, FIXED_NOW.toISOString(),
      "assessed_at is the computation time, not the DB write time");
  });

  it("sources updated_at from the `now` parameter", () => {
    const row = buildAccountQualificationRow(CLIENT_A, COMPANY_X, makeResult(), FIXED_NOW);
    assert.equal(row.updated_at, FIXED_NOW.toISOString());
  });

  it("does NOT include id (DB generates with gen_random_uuid)", () => {
    const row = buildAccountQualificationRow(CLIENT_A, COMPANY_X, makeResult(), FIXED_NOW);
    assert.equal("id" in row, false, "id must be absent — DB generates it");
  });

  it("does NOT include created_at (DB sets on INSERT only)", () => {
    const row = buildAccountQualificationRow(CLIENT_A, COMPANY_X, makeResult(), FIXED_NOW);
    assert.equal("created_at" in row, false, "created_at must be absent — DB sets it on INSERT");
  });

  it("includes all required upsert columns and no unexpected extras", () => {
    const row = buildAccountQualificationRow(CLIENT_A, COMPANY_X, makeResult(), FIXED_NOW);
    const keys = new Set(Object.keys(row));
    const expected = new Set([
      "client_id", "company_id", "campaign_strategy_id",
      "qualified", "qualification_score", "qualification",
      "qualification_assessed_at", "updated_at",
    ]);
    for (const k of expected) {
      assert.ok(keys.has(k), `Expected column ${k} to be present`);
    }
    const unexpected = [...keys].filter(k => !expected.has(k));
    assert.equal(unexpected.length, 0, `Unexpected columns: ${unexpected.join(", ")}`);
  });

  it("qualified=false, score=0, and exclusionReasons are all preserved", () => {
    const excluded = makeResult({
      qualified:         false,
      qualificationScore: 0,
      exclusionReasons:  ["Geography FAIL: country United States excluded by UK-only ICP"],
      geographyVerdict:  "FAIL",
    });
    const row = buildAccountQualificationRow(CLIENT_A, COMPANY_X, excluded, FIXED_NOW);
    assert.equal(row.qualified,           false);
    assert.equal(row.qualification_score, 0);
    const qual = row.qualification as AccountQualificationResult;
    assert.equal(qual.exclusionReasons.length, 1);
    assert.ok(qual.exclusionReasons[0].includes("Geography FAIL"));
  });

  it("hypothesis label is preserved verbatim in qualification JSONB", () => {
    const row  = buildAccountQualificationRow(CLIENT_A, COMPANY_X, makeResult(), FIXED_NOW);
    const qual = row.qualification as AccountQualificationResult;
    assert.equal(qual.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  });

  it("campaignStrategyId is sourced from result, not a separate function argument", () => {
    const result = makeResult({ campaignStrategyId: STRATEGY_2 });
    const row    = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    assert.equal(row.campaign_strategy_id, STRATEGY_2,
      "campaignStrategyId comes from result.campaignStrategyId — no separate param");
  });

  it("two qualifications for the same company differ by campaign_strategy_id", () => {
    const r1 = makeResult({ campaignStrategyId: STRATEGY_1, qualified: true,  qualificationScore: 60 });
    const r2 = makeResult({ campaignStrategyId: STRATEGY_2, qualified: false, qualificationScore: 0 });

    const row1 = buildAccountQualificationRow(CLIENT_A, COMPANY_X, r1, FIXED_NOW);
    const row2 = buildAccountQualificationRow(CLIENT_A, COMPANY_X, r2, FIXED_NOW);

    assert.equal(row1.campaign_strategy_id, STRATEGY_1);
    assert.equal(row2.campaign_strategy_id, STRATEGY_2);
    assert.notEqual(row1.qualified, row2.qualified,
      "Each strategy produces an independent qualification — no shared state");
  });
});

// ── fromAccountCampaignQualificationRow ───────────────────────────────────────

describe("fromAccountCampaignQualificationRow — domain object mapping", () => {
  const FAKE_DB_ROW: Record<string, unknown> = {
    id:                        "ffffffff-ffff-ffff-ffff-ffffffffffff",
    client_id:                 CLIENT_A,
    company_id:                COMPANY_X,
    campaign_strategy_id:      STRATEGY_1,
    qualified:                 true,
    qualification_score:       55,
    qualification:             makeResult({ qualificationScore: 55 }),
    qualification_assessed_at: ASSESSED_AT,
    created_at:                "2026-09-11T09:00:00.000Z",
    updated_at:                FIXED_NOW.toISOString(),
  };

  it("maps all columns to camelCase domain fields", () => {
    const domain = fromAccountCampaignQualificationRow(FAKE_DB_ROW);
    assert.equal(domain.id,                      FAKE_DB_ROW.id);
    assert.equal(domain.clientId,                CLIENT_A);
    assert.equal(domain.companyId,               COMPANY_X);
    assert.equal(domain.campaignStrategyId,      STRATEGY_1);
    assert.equal(domain.qualified,               true);
    assert.equal(domain.qualificationScore,      55);
    assert.equal(domain.qualificationAssessedAt, ASSESSED_AT);
    assert.equal(domain.createdAt,               FAKE_DB_ROW.created_at);
    assert.equal(domain.updatedAt,               FIXED_NOW.toISOString());
  });

  it("casts qualification_score to number (handles integer from DB)", () => {
    const domain = fromAccountCampaignQualificationRow({ ...FAKE_DB_ROW, qualification_score: "42" });
    assert.equal(typeof domain.qualificationScore, "number");
    assert.equal(domain.qualificationScore, 42);
  });

  it("preserves qualification JSONB as AccountQualificationResult", () => {
    const domain = fromAccountCampaignQualificationRow(FAKE_DB_ROW);
    assert.equal(domain.qualification.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
    assert.equal(domain.qualification.campaignStrategyId, STRATEGY_1);
    assert.equal(domain.qualification.qualified,          true);
    assert.equal(domain.qualification.qualificationScore, 55);
  });

  it("does not invent fields absent from the DB row", () => {
    const domain = fromAccountCampaignQualificationRow(FAKE_DB_ROW);
    const keys   = new Set(Object.keys(domain));
    const allowed = new Set([
      "id", "clientId", "companyId", "campaignStrategyId", "qualified",
      "qualificationScore", "qualification", "qualificationAssessedAt",
      "createdAt", "updatedAt",
    ]);
    const extra = [...keys].filter(k => !allowed.has(k));
    assert.equal(extra.length, 0, `Unexpected domain fields: ${extra.join(", ")}`);
  });
});

// ── Round-trip ────────────────────────────────────────────────────────────────

describe("round-trip: buildRow → fromRow", () => {
  it("all fields survive a build → from round-trip", () => {
    const result = makeResult({
      qualified:               true,
      qualificationScore:      72,
      campaignStrategyId:      STRATEGY_1,
      positiveEvidence:        ["e1", "e2"],
      negativeEvidence:        ["n1"],
      missingInfo:             ["m1"],
      warnings:                ["w1"],
      exclusionReasons:        [],
      geographyVerdict:        "PASS",
      industryVerdict:         "PASS",
      sizeVerdict:             "UNKNOWN",
      hiringEvidenceVerdict:   "PRESENT",
    });

    // Simulate what Supabase returns — add DB-generated fields
    const built  = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    const dbLike: Record<string, unknown> = {
      id:         "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      created_at: "2026-09-11T09:00:00.000Z",
      ...built,
    };

    const domain = fromAccountCampaignQualificationRow(dbLike);

    assert.equal(domain.clientId,                CLIENT_A);
    assert.equal(domain.companyId,               COMPANY_X);
    assert.equal(domain.campaignStrategyId,      STRATEGY_1);
    assert.equal(domain.qualified,               true);
    assert.equal(domain.qualificationScore,      72);
    assert.equal(domain.qualificationAssessedAt, ASSESSED_AT);
    assert.equal(domain.updatedAt,               FIXED_NOW.toISOString());

    // Full evidence preserved
    assert.deepEqual(domain.qualification.positiveEvidence, ["e1", "e2"]);
    assert.deepEqual(domain.qualification.negativeEvidence, ["n1"]);
    assert.deepEqual(domain.qualification.missingInfo,      ["m1"]);
    assert.deepEqual(domain.qualification.warnings,         ["w1"]);
    assert.equal(domain.qualification.hiringEvidenceVerdict, "PRESENT");
    assert.equal(domain.qualification.hypothesis,            "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  });

  it("qualified=false with hard exclusion round-trips without data loss", () => {
    const result = makeResult({
      qualified:           false,
      qualificationScore:  0,
      exclusionReasons:    ["Geography FAIL: United States not in target UK geography"],
      geographyVerdict:    "FAIL",
    });

    const built  = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    const dbLike = { id: "11111111-2222-3333-4444-555555555555", created_at: "2026-09-11T09:00:00.000Z", ...built };
    const domain = fromAccountCampaignQualificationRow(dbLike);

    assert.equal(domain.qualified,          false);
    assert.equal(domain.qualificationScore, 0);
    assert.equal(domain.qualification.exclusionReasons.length, 1);
    assert.ok(domain.qualification.exclusionReasons[0].includes("Geography FAIL"));
  });
});

// ── Client and strategy scoping invariants ────────────────────────────────────

describe("client and strategy scoping invariants", () => {
  it("buildRow uses the provided clientId — not the clientId inside result", () => {
    // result.campaignStrategyId is used (it IS in the result)
    // but clientId and companyId come from the function parameters
    const result = makeResult({ campaignStrategyId: STRATEGY_1 });
    const rowA   = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    const rowB   = buildAccountQualificationRow(CLIENT_B, COMPANY_X, result, FIXED_NOW);

    assert.equal(rowA.client_id, CLIENT_A);
    assert.equal(rowB.client_id, CLIENT_B);
    assert.equal(rowA.campaign_strategy_id, STRATEGY_1);
    assert.equal(rowB.campaign_strategy_id, STRATEGY_1);
    // Both rows point to the same result JSONB but different client keys
    assert.notEqual(rowA.client_id, rowB.client_id,
      "Tenant isolation: each client gets its own scoped row");
  });

  it("two clients with the same company + strategy produce separate rows", () => {
    const result = makeResult({ campaignStrategyId: STRATEGY_1 });
    const rowA   = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    const rowB   = buildAccountQualificationRow(CLIENT_B, COMPANY_X, result, FIXED_NOW);

    // Same company_id and campaign_strategy_id, different client_id
    // → (client_id, company_id, campaign_strategy_id) UNIQUE constraint
    //   treats these as distinct rows — no conflict, no overwrite
    assert.equal(rowA.company_id,          rowB.company_id);
    assert.equal(rowA.campaign_strategy_id, rowB.campaign_strategy_id);
    assert.notEqual(rowA.client_id,        rowB.client_id);
  });

  it("updating qualification_score for S1 does not modify the S2 row", () => {
    const r1v1  = makeResult({ campaignStrategyId: STRATEGY_1, qualificationScore: 60 });
    const r1v2  = makeResult({ campaignStrategyId: STRATEGY_1, qualificationScore: 75 });
    const r2    = makeResult({ campaignStrategyId: STRATEGY_2, qualificationScore: 0, qualified: false });

    const rowS1v1 = buildAccountQualificationRow(CLIENT_A, COMPANY_X, r1v1, FIXED_NOW);
    const rowS1v2 = buildAccountQualificationRow(CLIENT_A, COMPANY_X, r1v2, FIXED_NOW);
    const rowS2   = buildAccountQualificationRow(CLIENT_A, COMPANY_X, r2,   FIXED_NOW);

    // S1 updated: score changed
    assert.equal(rowS1v1.qualification_score, 60);
    assert.equal(rowS1v2.qualification_score, 75);

    // S2 unchanged (different campaign_strategy_id → different UNIQUE key)
    assert.equal(rowS2.qualification_score,   0);
    assert.equal(rowS2.qualified,             false);
    assert.equal(rowS2.campaign_strategy_id,  STRATEGY_2);
    assert.equal(rowS1v2.campaign_strategy_id, STRATEGY_1);
  });
});

// ── Complete evidence preservation ───────────────────────────────────────────

describe("complete qualification evidence preservation", () => {
  it("all 14 AccountQualificationResult fields are stored in qualification JSONB", () => {
    const result = makeResult();
    const row    = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    const qual   = row.qualification as AccountQualificationResult;

    const requiredFields: (keyof AccountQualificationResult)[] = [
      "hypothesis", "qualified", "qualificationScore", "campaignStrategyId",
      "exclusionReasons", "geographyVerdict", "industryVerdict",
      "sizeVerdict", "hiringEvidenceVerdict", "positiveEvidence",
      "negativeEvidence", "missingInfo", "warnings", "assessedAt",
    ];

    for (const field of requiredFields) {
      assert.ok(field in qual, `Field ${field} must be present in stored qualification JSONB`);
    }
  });

  it("qualification_assessed_at matches result.assessedAt in the built row", () => {
    const specificTime = "2026-09-11T07:30:00.000Z";
    const result = makeResult({ assessedAt: specificTime });
    const row    = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    assert.equal(row.qualification_assessed_at, specificTime);
    assert.equal((row.qualification as AccountQualificationResult).assessedAt, specificTime);
  });

  it("no credentials or secrets in the built row", () => {
    const result = makeResult();
    const rowStr = JSON.stringify(buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW));
    assert.ok(!rowStr.includes("password"),   "No passwords in persisted row");
    assert.ok(!rowStr.includes("api_key"),    "No api_key in persisted row");
    assert.ok(!rowStr.includes("secret"),     "No secrets in persisted row");
    assert.ok(!rowStr.includes("Bearer"),     "No Bearer tokens in persisted row");
  });

  it("positive and negative evidence arrays are preserved in JSONB", () => {
    const result = makeResult({
      positiveEvidence: ["Country: United Kingdom", "Industry: Creative agencies"],
      negativeEvidence: ["Company size 500+ — outside target range of 3-200"],
    });
    const row  = buildAccountQualificationRow(CLIENT_A, COMPANY_X, result, FIXED_NOW);
    const qual = row.qualification as AccountQualificationResult;
    assert.deepEqual(qual.positiveEvidence, result.positiveEvidence);
    assert.deepEqual(qual.negativeEvidence, result.negativeEvidence);
  });
});
