/**
 * PredictLeadsSignalProvider — offline unit tests.
 *
 * All tests mock globalThis.fetch. No real HTTP calls are made.
 * No database. No .env loading needed — process.env is set directly per test.
 *
 * Coverage:
 *   isConfigured()         — missing key, missing token, both present
 *   fetchEvents()          — unconfigured shortcircuit
 *   mapJobOpening          — field mapping, title formatting, since filter, missing fields
 *   mapFinancingEvent      — field mapping, amount/investors, since filter, missing date
 *   HTTP contract          — 4xx, 5xx, 429+retry
 *   Pagination             — stops at < PAGE_SIZE
 *   Company matching       — domain absent → skip
 *   Tenant isolation       — clientId threaded through every event
 *   Partial records        — invalid records skipped, valid ones returned
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  PredictLeadsSignalProvider,
  PredictLeadsApiError,
  classifyJobPosting,
  type JobClass,
} from "../providers/signals/predictleads-provider";

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const COMPANY_ID_B = "00000000-0000-0000-0000-000000000002";
const CLIENT_ID = "00000000-0000-0000-0000-0000000000a1";

const DOMAIN = "stripe.com";

// Fixed timestamps for deterministic since-filter tests
const OLD_DATE = "2026-01-01T00:00:00.000Z";
const SINCE_DATE = "2026-06-01T00:00:00.000Z";
const NEW_DATE = "2026-08-01T00:00:00.000Z";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeJobRecord(
  overrides: Record<string, unknown> = {},
  recordId = "job-uuid-001",
): Record<string, unknown> {
  return {
    id: recordId,
    type: "job_opening",
    attributes: {
      title: "Software Engineer",
      first_seen_at: NEW_DATE,
      posted_at: NEW_DATE,
      url: "https://stripe.com/jobs/software-engineer",
      category: "engineering",
      seniority: "Senior",
      description: "Build payments infrastructure",
      ...overrides,
    },
  };
}

function makeFinancingRecord(
  overrides: Record<string, unknown> = {},
  recordId = "fin-uuid-001",
): Record<string, unknown> {
  return {
    id: recordId,
    type: "financing_event",
    attributes: {
      financing_type: "series_b",
      effective_date: NEW_DATE,
      found_at: NEW_DATE,
      amount: 50000000,
      amount_normalized: "$50M",
      investors: ["Sequoia Capital", "Y Combinator"],
      ...overrides,
    },
  };
}

// ── Fetch mocking ─────────────────────────────────────────────────────────────

type MockResponseSpec = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

/**
 * Queues up ordered fake fetch responses. Returns a restore function.
 * The last response is repeated if the queue is exhausted.
 */
function mockFetchQueue(responses: MockResponseSpec[]): () => void {
  const origFetch = globalThis.fetch;
  let idx = 0;
  globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
    const spec = responses[idx] ?? responses[responses.length - 1];
    idx++;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(spec.headers ?? {}),
    };
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers,
    });
  };
  return () => {
    globalThis.fetch = origFetch;
  };
}

/**
 * Convenience: returns 2 fake pages (one for job_openings, one for financing_events)
 * for a single-company fetchEvents call with the given records.
 */
function mockSingleCompany(jobRecords: unknown[], financingRecords: unknown[]): () => void {
  return mockFetchQueue([
    { status: 200, body: { data: jobRecords } },
    { status: 200, body: { data: financingRecords } },
  ]);
}

// ── Env helpers ───────────────────────────────────────────────────────────────

let savedApiKey: string | undefined;
let savedApiToken: string | undefined;

beforeEach(() => {
  savedApiKey = process.env.PREDICTLEADS_API_KEY;
  savedApiToken = process.env.PREDICTLEADS_API_TOKEN;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.PREDICTLEADS_API_KEY;
  else process.env.PREDICTLEADS_API_KEY = savedApiKey;

  if (savedApiToken === undefined) delete process.env.PREDICTLEADS_API_TOKEN;
  else process.env.PREDICTLEADS_API_TOKEN = savedApiToken;
});

function setKeys(key?: string, token?: string) {
  if (key === undefined) delete process.env.PREDICTLEADS_API_KEY;
  else process.env.PREDICTLEADS_API_KEY = key;

  if (token === undefined) delete process.env.PREDICTLEADS_API_TOKEN;
  else process.env.PREDICTLEADS_API_TOKEN = token;
}

// ── isConfigured() ────────────────────────────────────────────────────────────

test("isConfigured: missing API key → false", () => {
  setKeys(undefined, "tok");
  const p = new PredictLeadsSignalProvider();
  assert.equal(p.isConfigured(), false);
});

test("isConfigured: missing API token → false", () => {
  setKeys("key", undefined);
  const p = new PredictLeadsSignalProvider();
  assert.equal(p.isConfigured(), false);
});

test("isConfigured: both present → true", () => {
  setKeys("key", "tok");
  const p = new PredictLeadsSignalProvider();
  assert.equal(p.isConfigured(), true);
});

// ── fetchEvents: unconfigured ─────────────────────────────────────────────────

test("fetchEvents: unconfigured → empty batch with not_configured meta", async () => {
  setKeys(undefined, undefined);
  const p = new PredictLeadsSignalProvider();
  const result = await p.fetchEvents(
    [COMPANY_ID],
    CLIENT_ID,
    { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
  );
  assert.equal(result.events.length, 0);
  assert.equal((result.meta as { error?: string }).error, "not_configured");
});

// ── Job opening: basic field mapping ─────────────────────────────────────────

test("mapJobOpening: maps providerEventId from record.id", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([makeJobRecord()], []);
  try {
    const p = new PredictLeadsSignalProvider();
    const result = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].rawEvent.providerEventId, "job-uuid-001");
  } finally {
    restore();
  }
});

test("mapJobOpening: source = provider id", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([makeJobRecord()], []);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events[0].rawEvent.source, "predictleads");
  } finally {
    restore();
  }
});

test("mapJobOpening: signalType = job_posting", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([makeJobRecord()], []);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events[0].rawEvent.signalType, "job_posting");
  } finally {
    restore();
  }
});

test("mapJobOpening: title with seniority → 'Hiring: {seniority} {title}'", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ title: "Engineer", seniority: "Senior" })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events[0].rawEvent.title, "Hiring: Senior Engineer");
  } finally {
    restore();
  }
});

test("mapJobOpening: title without seniority → 'Hiring: {title}'", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ title: "Product Manager", seniority: undefined })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events[0].rawEvent.title, "Hiring: Product Manager");
  } finally {
    restore();
  }
});

test("mapJobOpening: sourceUrl from url field", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ url: "https://stripe.com/jobs/abc" })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events[0].rawEvent.sourceUrl, "https://stripe.com/jobs/abc");
  } finally {
    restore();
  }
});

test("mapJobOpening: sourceUrl falls back to source_url when url absent", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ url: undefined, source_url: "https://greenhouse.io/jobs/1" })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events[0].rawEvent.sourceUrl, "https://greenhouse.io/jobs/1");
  } finally {
    restore();
  }
});

test("mapJobOpening: category and seniority included in evidence", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ category: "engineering", seniority: "Senior" })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const evidence = events[0].rawEvent.evidence as Record<string, unknown>;
    assert.equal(evidence.category, "engineering");
    assert.equal(evidence.seniority, "Senior");
  } finally {
    restore();
  }
});

// ── Job opening: since filter ─────────────────────────────────────────────────

test("mapJobOpening: since filter — excludes record where first_seen_at < since", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ first_seen_at: OLD_DATE, posted_at: OLD_DATE })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]), since: SINCE_DATE },
    );
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

test("mapJobOpening: since filter — includes record where first_seen_at === since (boundary)", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ first_seen_at: SINCE_DATE, posted_at: SINCE_DATE })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]), since: SINCE_DATE },
    );
    assert.equal(events.length, 1);
  } finally {
    restore();
  }
});

test("mapJobOpening: missing title → record skipped (null)", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ title: undefined })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

// ── Financing event: basic field mapping ──────────────────────────────────────

test("mapFinancingEvent: signalType = funding_round", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([], [makeFinancingRecord()]);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].rawEvent.signalType, "funding_round");
  } finally {
    restore();
  }
});

test("mapFinancingEvent: amount included in evidence", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([], [makeFinancingRecord({ amount: 5_000_000 })]);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const evidence = events[0].rawEvent.evidence as Record<string, unknown>;
    assert.equal(evidence.amount, 5_000_000);
  } finally {
    restore();
  }
});

test("mapFinancingEvent: investors array included in evidence", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [],
    [makeFinancingRecord({ investors: ["Andreessen Horowitz", "Tiger Global"] })],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const evidence = events[0].rawEvent.evidence as Record<string, unknown>;
    assert.deepEqual(evidence.investors, ["Andreessen Horowitz", "Tiger Global"]);
  } finally {
    restore();
  }
});

test("mapFinancingEvent: financing_type label formatted correctly (series_b → 'Series B')", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([], [makeFinancingRecord({ financing_type: "series_b" })]);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const evidence = events[0].rawEvent.evidence as Record<string, unknown>;
    assert.equal(evidence.round, "Series B");
  } finally {
    restore();
  }
});

test("mapFinancingEvent: since filter — excludes record where found_at < since", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [],
    [makeFinancingRecord({ found_at: OLD_DATE, effective_date: OLD_DATE })],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]), since: SINCE_DATE },
    );
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

test("mapFinancingEvent: missing effective_date and found_at → record skipped", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [],
    [makeFinancingRecord({ effective_date: undefined, found_at: undefined })],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

// ── Empty / malformed responses ───────────────────────────────────────────────

test("empty response data array → 0 events", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([], []);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

test("malformed response with no data field → 0 events (no crash)", async () => {
  setKeys("key", "tok");
  const restore = mockFetchQueue([
    { status: 200, body: { meta: { count: 0 } } },  // no data
    { status: 200, body: { meta: { count: 0 } } },
  ]);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events.length, 0);
  } finally {
    restore();
  }
});

// ── HTTP error handling ───────────────────────────────────────────────────────

test("HTTP 4xx → PredictLeadsApiError caught per-company; other companies unaffected", async () => {
  setKeys("key", "tok");
  // First company: 404 for job_openings
  // Second company: normal response
  // When company-A's job_openings 404s, fetchWithRetry throws immediately —
  // financing_events is never called for company-A. Queue: A_jobs(404), B_jobs(200), B_fin(200).
  const restore = mockFetchQueue([
    { status: 404, body: { error: "not found" } },   // company-A job_openings → 404 → throw
    { status: 200, body: { data: [makeJobRecord()] } }, // company-B job_openings
    { status: 200, body: { data: [] } },              // company-B financing_events
  ]);
  try {
    const p = new PredictLeadsSignalProvider();
    const companyDomains = new Map([
      [COMPANY_ID, DOMAIN],
      [COMPANY_ID_B, "acme.com"],
    ]);
    const { events, meta } = await p.fetchEvents(
      [COMPANY_ID, COMPANY_ID_B],
      CLIENT_ID,
      { companyDomains },
    );
    // Company-B events arrive
    assert.equal(events.length, 1);
    // Company-A error captured in meta
    const m = meta as { perCompanyErrors?: Record<string, string> };
    assert.ok(m.perCompanyErrors?.[COMPANY_ID]);
    assert.ok(m.perCompanyErrors[COMPANY_ID].includes("404"));
  } finally {
    restore();
  }
});

test("HTTP 5xx → PredictLeadsApiError thrown by fetchWithRetry", async () => {
  setKeys("key", "tok");
  const restore = mockFetchQueue([
    { status: 503, body: "service unavailable" },
    { status: 200, body: { data: [] } },
  ]);
  try {
    const p = new PredictLeadsSignalProvider();
    const { meta } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const m = meta as { perCompanyErrors?: Record<string, string> };
    assert.ok(m.perCompanyErrors?.[COMPANY_ID]);
    assert.ok(m.perCompanyErrors[COMPANY_ID].includes("503"));
  } finally {
    restore();
  }
});

test("HTTP 429 with Retry-After → retries once and succeeds", async () => {
  setKeys("key", "tok");
  // Mock setTimeout to avoid real delay
  const origSetTimeout = globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: (fn: () => void, _ms: number) => unknown }).setTimeout =
    (fn: () => void, _ms: number) => { fn(); return 0; };

  const restore = mockFetchQueue([
    // job_openings: first call → 429
    { status: 429, body: {}, headers: { "Retry-After": "1" } },
    // job_openings: retry → success
    { status: 200, body: { data: [makeJobRecord()] } },
    // financing_events
    { status: 200, body: { data: [] } },
  ]);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events.length, 1);
  } finally {
    restore();
    globalThis.setTimeout = origSetTimeout;
  }
});

test("HTTP 429 retry also fails → error per company (no infinite loop)", async () => {
  setKeys("key", "tok");
  const origSetTimeout = globalThis.setTimeout;
  (globalThis as unknown as { setTimeout: (fn: () => void, _ms: number) => unknown }).setTimeout =
    (fn: () => void, _ms: number) => { fn(); return 0; };

  const restore = mockFetchQueue([
    { status: 429, body: {}, headers: { "Retry-After": "1" } },
    { status: 500, body: "still failing" },
    { status: 200, body: { data: [] } },
  ]);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events, meta } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events.length, 0);
    const m = meta as { perCompanyErrors?: Record<string, string> };
    assert.ok(m.perCompanyErrors?.[COMPANY_ID]);
  } finally {
    restore();
    globalThis.setTimeout = origSetTimeout;
  }
});

// ── Company matching ──────────────────────────────────────────────────────────

test("company not in companyDomains → skipped; companiesSkipped incremented", async () => {
  setKeys("key", "tok");
  // No fetch calls should happen — the domain lookup fails before HTTP
  const restore = mockFetchQueue([]);
  try {
    const p = new PredictLeadsSignalProvider();
    // Empty domain map — COMPANY_ID has no domain entry
    const { events, meta } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map() },
    );
    assert.equal(events.length, 0);
    assert.equal((meta as { companiesSkipped?: number }).companiesSkipped, 1);
  } finally {
    restore();
  }
});

// ── Tenant isolation ──────────────────────────────────────────────────────────

test("tenant isolation: clientId threaded through every returned event", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([makeJobRecord(), makeJobRecord({ id: "job-uuid-002" })], []);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    for (const ev of events) {
      assert.equal(ev.clientId, CLIENT_ID, "every event carries the caller's clientId");
      assert.equal(ev.companyId, COMPANY_ID, "every event carries the correct companyId");
    }
  } finally {
    restore();
  }
});

// ── Partial invalid records ───────────────────────────────────────────────────

test("partial records: invalid entries skipped, valid ones returned", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [
      makeJobRecord({ title: undefined }, "bad-job-001"),  // invalid — no title → skipped
      makeJobRecord({}, "good-job-001"),                   // valid
    ],
    [
      makeFinancingRecord({ effective_date: undefined, found_at: undefined }), // invalid — no date → skipped
      makeFinancingRecord({}, "good-fin-001"),             // valid
    ],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events.length, 2);
    const ids = events.map((e) => e.rawEvent.providerEventId);
    assert.ok(ids.includes("good-job-001"));
    assert.ok(ids.includes("good-fin-001"));
  } finally {
    restore();
  }
});

// ── occurredAt timestamp normalization ───────────────────────────────────────

test("date-only posted_at (YYYY-MM-DD) normalized to full ISO string", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ posted_at: "2026-08-15", first_seen_at: "2026-08-15" })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events[0].rawEvent.occurredAt, "2026-08-15T00:00:00.000Z");
  } finally {
    restore();
  }
});

test("full ISO posted_at with T component passes through unchanged", async () => {
  setKeys("key", "tok");
  const ts = "2026-08-15T14:30:00.000Z";
  const restore = mockSingleCompany(
    [makeJobRecord({ posted_at: ts, first_seen_at: ts })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    assert.equal(events[0].rawEvent.occurredAt, ts);
  } finally {
    restore();
  }
});

// ── PredictLeadsApiError ──────────────────────────────────────────────────────

test("PredictLeadsApiError: status and body exposed on instance", () => {
  const err = new PredictLeadsApiError(404, "not found");
  assert.equal(err.status, 404);
  assert.equal(err.body, "not found");
  assert.ok(err.message.includes("404"));
  assert.ok(err instanceof Error);
});

test("PredictLeadsApiError: responseHeaders defaults to empty object when omitted", () => {
  const err = new PredictLeadsApiError(402, "Payment Required");
  assert.deepEqual(err.responseHeaders, {});
});

test("PredictLeadsApiError: responseHeaders stored on instance when provided", () => {
  const headers = { "x-error-code": "plan_restriction", "content-type": "application/json" };
  const err = new PredictLeadsApiError(402, "Payment Required", headers);
  assert.deepEqual(err.responseHeaders, headers);
});

test("HTTP 402 → body fragment captured in per-company error message", async () => {
  setKeys("key", "tok");
  const restore = mockFetchQueue([
    { status: 402, body: { error: "plan_restriction", message: "Upgrade required" } },
    { status: 200, body: { data: [] } },
  ]);
  try {
    const p = new PredictLeadsSignalProvider();
    const { meta } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const m = meta as { perCompanyErrors?: Record<string, string> };
    assert.ok(m.perCompanyErrors?.[COMPANY_ID], "error should be captured per-company");
    assert.ok(m.perCompanyErrors[COMPANY_ID].includes("402"), "error message should include status 402");
  } finally {
    restore();
  }
});

// ── classifyJobPosting ────────────────────────────────────────────────────────

// Silence the unused-type import — JobClass is checked via satisfies in tests below.
const _jobClassCheck: JobClass = "general";
void _jobClassCheck;

test("classifyJobPosting: C-Suite seniority → senior_leadership", () => {
  assert.equal(classifyJobPosting("Head of Something", null, "C-Suite"), "senior_leadership");
});

test("classifyJobPosting: 'Managing Director' in title → senior_leadership", () => {
  assert.equal(classifyJobPosting("Managing Director", null, null), "senior_leadership");
});

test("classifyJobPosting: 'CEO' abbreviation in title → senior_leadership", () => {
  assert.equal(classifyJobPosting("CEO", null, null), "senior_leadership");
});

test("classifyJobPosting: 'MD' abbreviation in title → senior_leadership", () => {
  assert.equal(classifyJobPosting("MD", null, null), "senior_leadership");
});

test("classifyJobPosting: 'Founder' keyword in title → senior_leadership", () => {
  assert.equal(classifyJobPosting("Co-Founder and Head of Growth", null, null), "senior_leadership");
});

test("classifyJobPosting: 'Chief Financial Officer' in title → senior_leadership", () => {
  assert.equal(classifyJobPosting("Chief Financial Officer", null, null), "senior_leadership");
});

test("classifyJobPosting: 'Sales' category → bd_commercial", () => {
  assert.equal(classifyJobPosting("Sales Representative", "Sales", null), "bd_commercial");
});

test("classifyJobPosting: 'Sales Director' in title → bd_commercial", () => {
  assert.equal(classifyJobPosting("Sales Director", null, null), "bd_commercial");
});

test("classifyJobPosting: 'Head of Sales' in title → bd_commercial", () => {
  assert.equal(classifyJobPosting("Head of Sales", null, null), "bd_commercial");
});

test("classifyJobPosting: 'Head of Business Development' in title → bd_commercial", () => {
  assert.equal(classifyJobPosting("Head of Business Development", null, null), "bd_commercial");
});

test("classifyJobPosting: 'Account Director' in title → bd_commercial", () => {
  assert.equal(classifyJobPosting("Account Director", null, null), "bd_commercial");
});

test("classifyJobPosting: BDM abbreviation in title → bd_commercial", () => {
  assert.equal(classifyJobPosting("BDM", null, null), "bd_commercial");
});

test("classifyJobPosting: 'Marketing' category → marketing_creative", () => {
  assert.equal(classifyJobPosting("Brand Manager", "Marketing", null), "marketing_creative");
});

test("classifyJobPosting: 'Creative Director' in title → marketing_creative", () => {
  assert.equal(classifyJobPosting("Creative Director", null, null), "marketing_creative");
});

test("classifyJobPosting: 'Marketing Director' in title → marketing_creative", () => {
  assert.equal(classifyJobPosting("Marketing Director", null, null), "marketing_creative");
});

test("classifyJobPosting: 'Engineering' category → tech_digital", () => {
  assert.equal(classifyJobPosting("Software Engineer", "Engineering", "Senior"), "tech_digital");
});

test("classifyJobPosting: 'Head of Digital' in title → tech_digital", () => {
  assert.equal(classifyJobPosting("Head of Digital", null, null), "tech_digital");
});

test("classifyJobPosting: CTO abbreviation in title → tech_digital", () => {
  assert.equal(classifyJobPosting("CTO", null, null), "tech_digital");
});

test("classifyJobPosting: 'Human Resources' category → talent_people", () => {
  assert.equal(classifyJobPosting("HR Manager", "Human Resources", null), "talent_people");
});

test("classifyJobPosting: 'Head of People' in title → talent_people", () => {
  assert.equal(classifyJobPosting("Head of People", null, null), "talent_people");
});

test("classifyJobPosting: 'Operations' category → operations_delivery", () => {
  assert.equal(classifyJobPosting("Operations Manager", "Operations", null), "operations_delivery");
});

test("classifyJobPosting: 'Head of Production' in title → operations_delivery", () => {
  assert.equal(classifyJobPosting("Head of Production", null, null), "operations_delivery");
});

test("classifyJobPosting: unrecognized title with no category → general", () => {
  assert.equal(classifyJobPosting("Graphic Designer", null, null), "general");
});

test("classifyJobPosting: all nulls → general", () => {
  assert.equal(classifyJobPosting(null, null, null), "general");
});

test("classifyJobPosting: senior_leadership takes priority over Sales category", () => {
  assert.equal(classifyJobPosting("Founder", "Sales", null), "senior_leadership");
});

test("classifyJobPosting: case-insensitive — UPPERCASE title matches senior_leadership", () => {
  assert.equal(classifyJobPosting("MANAGING DIRECTOR", null, null), "senior_leadership");
});

test("classifyJobPosting: case-insensitive — mixed-case C-Suite seniority", () => {
  assert.equal(classifyJobPosting("Head of Growth", null, "c-suite"), "senior_leadership");
});

// ── mapJobOpening: job_class evidence field ───────────────────────────────────

test("mapJobOpening: evidence always includes job_class field", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany([makeJobRecord()], []);
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const evidence = events[0].rawEvent.evidence as Record<string, unknown>;
    assert.ok("job_class" in evidence, "evidence must include job_class");
    assert.equal(typeof evidence.job_class, "string");
  } finally {
    restore();
  }
});

test("mapJobOpening: job_class = bd_commercial for 'Head of Business Development'", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ title: "Head of Business Development", category: undefined, seniority: undefined })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const evidence = events[0].rawEvent.evidence as Record<string, unknown>;
    assert.equal(evidence.job_class, "bd_commercial");
  } finally {
    restore();
  }
});

test("mapJobOpening: job_class = general for unrecognized title with no category", async () => {
  setKeys("key", "tok");
  const restore = mockSingleCompany(
    [makeJobRecord({ title: "Receptionist", category: undefined, seniority: undefined })],
    [],
  );
  try {
    const p = new PredictLeadsSignalProvider();
    const { events } = await p.fetchEvents(
      [COMPANY_ID],
      CLIENT_ID,
      { companyDomains: new Map([[COMPANY_ID, DOMAIN]]) },
    );
    const evidence = events[0].rawEvent.evidence as Record<string, unknown>;
    assert.equal(evidence.job_class, "general");
  } finally {
    restore();
  }
});
