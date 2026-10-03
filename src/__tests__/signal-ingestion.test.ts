/**
 * Unit tests for Stage 13 signal ingestion — pure, no DB, no network, no env vars.
 *
 * Tests the buildIngestionReport() pure function exported from
 * src/lib/signal-ingestion.ts. This function aggregates per-company results
 * into an IngestionReport — the report is what gets stored in jobs.output_data
 * and is the primary observability surface for the refresh pipeline.
 *
 * Coverage:
 *   Total aggregation        — sum of per-company counts
 *   Empty companies array    — all totals zero
 *   companiesSucceeded       — companiesWithDomain minus companiesFailed
 *   companiesFailed          — count of keys in providerErrors
 *   startedAt / completedAt  — iso strings from Date inputs
 *   since null propagation   — null since passes through unchanged
 *   since cursor propagation — non-null since passes through unchanged
 *   provider id propagation  — provider string passes through
 *   No credentials in report — provider field is an id, not a key
 *   Multiple companies       — each contributes correctly to totals
 *   Rescore null preserved   — companies with no new signals have rescore=null
 *   Rescore error preserved  — captured error passes through to report
 *   Rescore score preserved  — captured score passes through to report
 *   companiesWithDomain = 0  — companiesSucceeded clamps to 0
 *   Single failed company    — companiesSucceeded = withDomain - 1
 *   Mixed success/failure    — totals correct across mixed results
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildIngestionReport,
  type CompanyIngestionResult,
  type IngestionReportInput,
} from "../lib/signal-ingestion";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_A   = "00000000-0000-0000-0000-0000000000a1";
const COMPANY_A  = "00000000-0000-0000-0000-000000000001";
const COMPANY_B  = "00000000-0000-0000-0000-000000000002";
const COMPANY_C  = "00000000-0000-0000-0000-000000000003";

const STARTED_AT   = new Date("2026-09-03T02:00:00.000Z");
const COMPLETED_AT = new Date("2026-09-03T02:05:00.000Z");

function makeCompanyResult(overrides: Partial<CompanyIngestionResult> = {}): CompanyIngestionResult {
  return {
    companyId:           COMPANY_A,
    signalsFetched:      3,
    signalsInserted:     2,
    signalsDuplicated:   1,
    normalizationErrors: 0,
    upsertErrors:        0,
    rescore:             { score: 63 },
    ...overrides,
  };
}

function makeInput(overrides: Partial<IngestionReportInput> = {}): IngestionReportInput {
  return {
    clientId:            CLIENT_A,
    provider:            "predictleads",
    since:               null,
    startedAt:           STARTED_AT,
    completedAt:         COMPLETED_AT,
    companiesRequested:  1,
    companiesWithDomain: 1,
    companies:           [makeCompanyResult()],
    providerErrors:      {},
    ...overrides,
  };
}

// ── 1. Total aggregation ──────────────────────────────────────────────────────

test("buildIngestionReport: totalSignalsFetched is sum across all companies", () => {
  const input = makeInput({
    companies: [
      makeCompanyResult({ companyId: COMPANY_A, signalsFetched: 5 }),
      makeCompanyResult({ companyId: COMPANY_B, signalsFetched: 3 }),
    ],
    companiesRequested:  2,
    companiesWithDomain: 2,
  });
  const report = buildIngestionReport(input);
  assert.equal(report.totalSignalsFetched, 8);
});

test("buildIngestionReport: totalSignalsInserted is sum across all companies", () => {
  const input = makeInput({
    companies: [
      makeCompanyResult({ companyId: COMPANY_A, signalsInserted: 4 }),
      makeCompanyResult({ companyId: COMPANY_B, signalsInserted: 1 }),
    ],
    companiesRequested:  2,
    companiesWithDomain: 2,
  });
  const report = buildIngestionReport(input);
  assert.equal(report.totalSignalsInserted, 5);
});

test("buildIngestionReport: totalSignalsDuplicated is sum across all companies", () => {
  const input = makeInput({
    companies: [
      makeCompanyResult({ companyId: COMPANY_A, signalsDuplicated: 2 }),
      makeCompanyResult({ companyId: COMPANY_B, signalsDuplicated: 7 }),
    ],
    companiesRequested:  2,
    companiesWithDomain: 2,
  });
  const report = buildIngestionReport(input);
  assert.equal(report.totalSignalsDuplicated, 9);
});

test("buildIngestionReport: totalNormalizationErrors is sum across all companies", () => {
  const input = makeInput({
    companies: [
      makeCompanyResult({ companyId: COMPANY_A, normalizationErrors: 1 }),
      makeCompanyResult({ companyId: COMPANY_B, normalizationErrors: 3 }),
    ],
    companiesRequested:  2,
    companiesWithDomain: 2,
  });
  const report = buildIngestionReport(input);
  assert.equal(report.totalNormalizationErrors, 4);
});

test("buildIngestionReport: totalUpsertErrors is sum across all companies", () => {
  const input = makeInput({
    companies: [
      makeCompanyResult({ companyId: COMPANY_A, upsertErrors: 0 }),
      makeCompanyResult({ companyId: COMPANY_B, upsertErrors: 2 }),
    ],
    companiesRequested:  2,
    companiesWithDomain: 2,
  });
  const report = buildIngestionReport(input);
  assert.equal(report.totalUpsertErrors, 2);
});

// ── 2. Empty companies array ──────────────────────────────────────────────────

test("buildIngestionReport: empty companies array → all totals zero", () => {
  const input = makeInput({
    companies:           [],
    companiesRequested:  0,
    companiesWithDomain: 0,
  });
  const report = buildIngestionReport(input);
  assert.equal(report.totalSignalsFetched,      0);
  assert.equal(report.totalSignalsInserted,      0);
  assert.equal(report.totalSignalsDuplicated,    0);
  assert.equal(report.totalNormalizationErrors,  0);
  assert.equal(report.totalUpsertErrors,         0);
  assert.equal(report.companiesSucceeded,        0);
  assert.equal(report.companiesFailed,           0);
});

// ── 3. companiesSucceeded ─────────────────────────────────────────────────────

test("buildIngestionReport: companiesSucceeded = companiesWithDomain when no errors", () => {
  const input = makeInput({
    companies:           [
      makeCompanyResult({ companyId: COMPANY_A }),
      makeCompanyResult({ companyId: COMPANY_B }),
    ],
    companiesRequested:  2,
    companiesWithDomain: 2,
    providerErrors:      {},
  });
  const report = buildIngestionReport(input);
  assert.equal(report.companiesSucceeded, 2);
  assert.equal(report.companiesFailed,    0);
});

test("buildIngestionReport: companiesSucceeded = companiesWithDomain - companiesFailed", () => {
  const input = makeInput({
    companies:           [makeCompanyResult({ companyId: COMPANY_B })],
    companiesRequested:  2,
    companiesWithDomain: 2,
    providerErrors:      { [COMPANY_A]: "connection timeout" },
  });
  const report = buildIngestionReport(input);
  assert.equal(report.companiesFailed,    1);
  assert.equal(report.companiesSucceeded, 1);
});

test("buildIngestionReport: companiesSucceeded clamps to 0 when all failed", () => {
  const input = makeInput({
    companies:           [],
    companiesRequested:  2,
    companiesWithDomain: 2,
    providerErrors:      {
      [COMPANY_A]: "timeout",
      [COMPANY_B]: "429 rate limit",
    },
  });
  const report = buildIngestionReport(input);
  assert.equal(report.companiesFailed,    2);
  assert.equal(report.companiesSucceeded, 0);
});

test("buildIngestionReport: companiesWithDomain=0, no failures → companiesSucceeded=0", () => {
  const input = makeInput({
    companies:           [],
    companiesRequested:  3,
    companiesWithDomain: 0,
    providerErrors:      {},
  });
  const report = buildIngestionReport(input);
  assert.equal(report.companiesSucceeded, 0);
  assert.equal(report.companiesFailed,    0);
});

// ── 4. Timestamp propagation ──────────────────────────────────────────────────

test("buildIngestionReport: startedAt is ISO string of input.startedAt", () => {
  const report = buildIngestionReport(makeInput());
  assert.equal(report.startedAt, STARTED_AT.toISOString());
});

test("buildIngestionReport: completedAt is ISO string of input.completedAt", () => {
  const report = buildIngestionReport(makeInput());
  assert.equal(report.completedAt, COMPLETED_AT.toISOString());
});

test("buildIngestionReport: startedAt is always before or equal completedAt", () => {
  const report = buildIngestionReport(makeInput());
  assert.ok(
    report.startedAt <= report.completedAt,
    `startedAt (${report.startedAt}) should be <= completedAt (${report.completedAt})`,
  );
});

// ── 5. Since cursor propagation ───────────────────────────────────────────────

test("buildIngestionReport: since=null propagates to report.since", () => {
  const report = buildIngestionReport(makeInput({ since: null }));
  assert.equal(report.since, null);
});

test("buildIngestionReport: non-null since propagates unchanged", () => {
  const cursor = "2026-09-02T02:00:00.000Z";
  const report = buildIngestionReport(makeInput({ since: cursor }));
  assert.equal(report.since, cursor);
});

// ── 6. Provider id propagation ────────────────────────────────────────────────

test("buildIngestionReport: provider id passes through unchanged", () => {
  const report = buildIngestionReport(makeInput({ provider: "predictleads" }));
  assert.equal(report.provider, "predictleads");
});

test("buildIngestionReport: test provider id passes through unchanged", () => {
  const report = buildIngestionReport(makeInput({ provider: "test" }));
  assert.equal(report.provider, "test");
});

// ── 7. No credentials in report ───────────────────────────────────────────────

test("buildIngestionReport: report fields contain no API key or token strings", () => {
  const report = buildIngestionReport(makeInput({ provider: "predictleads" }));
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("apiKey"),   "apiKey must not appear in report");
  assert.ok(!serialized.includes("apiToken"), "apiToken must not appear in report");
  assert.ok(!serialized.includes("password"), "password must not appear in report");
  assert.ok(!serialized.includes("secret"),   "secret must not appear in report");
});

// ── 8. Rescore result preservation ───────────────────────────────────────────

test("buildIngestionReport: rescore=null preserved in companies array", () => {
  const noRescore = makeCompanyResult({ rescore: null });
  const report = buildIngestionReport(makeInput({ companies: [noRescore] }));
  assert.equal(report.companies[0].rescore, null);
});

test("buildIngestionReport: rescore={ score } preserved in companies array", () => {
  const withScore = makeCompanyResult({ rescore: { score: 75 } });
  const report = buildIngestionReport(makeInput({ companies: [withScore] }));
  const rescore = report.companies[0].rescore as { score: number };
  assert.equal(rescore.score, 75);
});

test("buildIngestionReport: rescore={ error } preserved in companies array", () => {
  const withError = makeCompanyResult({ rescore: { error: "DB connection lost" } });
  const report = buildIngestionReport(makeInput({ companies: [withError] }));
  const rescore = report.companies[0].rescore as { error: string };
  assert.equal(rescore.error, "DB connection lost");
});

// ── 9. Companies array reference ──────────────────────────────────────────────

test("buildIngestionReport: companies array contains all input companies", () => {
  const companies = [
    makeCompanyResult({ companyId: COMPANY_A }),
    makeCompanyResult({ companyId: COMPANY_B }),
    makeCompanyResult({ companyId: COMPANY_C }),
  ];
  const report = buildIngestionReport(makeInput({
    companies,
    companiesRequested:  3,
    companiesWithDomain: 3,
  }));
  assert.equal(report.companies.length, 3);
  assert.equal(report.companies[0].companyId, COMPANY_A);
  assert.equal(report.companies[1].companyId, COMPANY_B);
  assert.equal(report.companies[2].companyId, COMPANY_C);
});

// ── 10. providerErrors propagation ───────────────────────────────────────────

test("buildIngestionReport: providerErrors passes through to report", () => {
  const errors = { [COMPANY_A]: "timeout", [COMPANY_B]: "404 not found" };
  const report = buildIngestionReport(makeInput({
    providerErrors:      errors,
    companiesRequested:  3,
    companiesWithDomain: 3,
    companies:           [makeCompanyResult({ companyId: COMPANY_C })],
  }));
  assert.deepEqual(report.providerErrors, errors);
});

// ── 11. Mixed rescore outcomes in multi-company batch ─────────────────────────

test("buildIngestionReport: mixed rescore outcomes across three companies", () => {
  const companies = [
    makeCompanyResult({ companyId: COMPANY_A, signalsInserted: 2, signalsDuplicated: 0, rescore: { score: 63 } }),
    makeCompanyResult({ companyId: COMPANY_B, signalsInserted: 0, signalsDuplicated: 3, rescore: null }),
    makeCompanyResult({ companyId: COMPANY_C, signalsInserted: 1, signalsDuplicated: 0, rescore: { error: "rescore failed" } }),
  ];
  const report = buildIngestionReport(makeInput({
    companies,
    companiesRequested:  3,
    companiesWithDomain: 3,
  }));
  assert.equal(report.totalSignalsInserted,   3);
  assert.equal(report.totalSignalsDuplicated, 3);
  assert.equal(report.companiesSucceeded,     3); // no providerErrors
  assert.equal(report.companies[0].rescore, report.companies[0].rescore);
  assert.equal((report.companies[0].rescore as { score: number }).score, 63);
  assert.equal(report.companies[1].rescore, null);
  assert.equal((report.companies[2].rescore as { error: string }).error, "rescore failed");
});

// ── 12. clientId propagation ──────────────────────────────────────────────────

test("buildIngestionReport: clientId passes through unchanged", () => {
  const report = buildIngestionReport(makeInput({ clientId: CLIENT_A }));
  assert.equal(report.clientId, CLIENT_A);
});

// ── 13. companiesRequested propagation ───────────────────────────────────────

test("buildIngestionReport: companiesRequested propagates to report", () => {
  const report = buildIngestionReport(makeInput({
    companiesRequested:  5,
    companiesWithDomain: 4,
    companies:           Array.from({ length: 4 }, (_, i) =>
      makeCompanyResult({ companyId: `company-${i}` }),
    ),
  }));
  assert.equal(report.companiesRequested,  5);
  assert.equal(report.companiesWithDomain, 4);
});
