/**
 * News-event mapper — Stage 30C.3. Offline: no network, no DB, no env.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mapNewsCategory,
  mapNewsEventRecord,
  mapNewsEventsResponse,
  type NewsEventContext,
} from "../providers/signals/news-event-mapper";
import {
  FakeNewsEventsSignalProvider,
  FAKE_NEWS_EVENTS_FIXTURES,
} from "../providers/signals/fake-news-events";
import { getSignalProviders } from "../providers/signals/registry";
import { normalizeEvent } from "../providers/signals/normalizer";

const NOW = "2026-10-01T00:00:00.000Z";
const CLIENT_A = "00000000-0000-0000-0000-0000000000a1";
const CLIENT_B = "00000000-0000-0000-0000-0000000000b2";
const COMPANY = "00000000-0000-0000-0000-000000000001";

const ctx = (over: Partial<NewsEventContext> = {}): NewsEventContext => ({
  companyId: COMPANY,
  clientId: CLIENT_A,
  domain: "northlight-studio.example",
  source: "predictleads",
  now: NOW,
  ...over,
});

const rec = (attrs: Record<string, unknown> = {}, id: unknown = "n-1") => ({
  id,
  type: "news_event",
  attributes: {
    category: "acquisition",
    summary: "Acme acquires Beta",
    found_at: "2026-09-20T08:00:00.000Z",
    ...attrs,
  },
});

// ── category mapping ──────────────────────────────────────────────────────────

test("category map: exact signal types", () => {
  const expected: Record<string, string> = {
    acquisition: "expansion",
    acquires: "expansion",
    expansion: "expansion",
    expands_offices_to: "expansion",
    opens_new_location: "expansion",
    product_launch: "product_launch",
    launches: "product_launch",
    partnership: "partnership",
    partners_with: "partnership",
    award: "award",
    receives_award: "award",
  };
  for (const [cat, type] of Object.entries(expected)) {
    assert.equal(mapNewsCategory(cat), type, cat);
  }
});

test("category map: case, spaces and hyphens normalised", () => {
  assert.equal(mapNewsCategory("Product Launch"), "product_launch");
  assert.equal(mapNewsCategory("PARTNERS-WITH"), "partnership");
});

test("category map: unknown, empty, non-string and executive hires → news_mention", () => {
  for (const c of ["hires", "executive_hire", "something_new", "", "  ", null, undefined, 42, {}]) {
    assert.equal(mapNewsCategory(c), "news_mention", String(c));
  }
});

// ── valid events ──────────────────────────────────────────────────────────────

test("valid event: canonical structure, provenance and evidence", () => {
  const out = mapNewsEventRecord(
    rec({ confidence: 0.9, url: "https://news.example/a", published_at: "2026-09-19" }),
    ctx(),
  );
  assert.ok(out.ok);
  const e = out.event;
  assert.equal(e.signalType, "expansion");
  assert.equal(e.source, "predictleads");
  assert.equal(e.providerEventId, "n-1");
  assert.equal(e.title, "Acme acquires Beta");
  assert.equal(e.sourceUrl, "https://news.example/a");
  assert.equal(e.confidence, 0.9);
  assert.equal(e.occurredAt, "2026-09-19T00:00:00.000Z");
  assert.deepEqual(e.evidence, {
    event: "news_event",
    summary: "Acme acquires Beta",
    domain: "northlight-studio.example",
    provider_record_id: "n-1",
    category: "acquisition",
  });
  assert.deepEqual(e.metadata, {
    module: "news_events",
    found_at: "2026-09-20T08:00:00.000Z",
    published_at: "2026-09-19T00:00:00.000Z",
  });
});

test("valid event: long summary → title truncated to 120, full text in description", () => {
  const long = "x".repeat(300);
  const out = mapNewsEventRecord(rec({ summary: long }), ctx());
  assert.ok(out.ok);
  assert.equal(out.event.title.length, 120);
  assert.equal(out.event.description, long);
});

test("valid event: output is accepted by the existing normalizer (no scoring/TTL change)", () => {
  const out = mapNewsEventRecord(rec(), ctx());
  assert.ok(out.ok);
  const sig = normalizeEvent(
    { companyId: COMPANY, clientId: CLIENT_A, rawEvent: out.event },
    NOW,
  );
  assert.equal(sig.signalType, "expansion");
  assert.equal(sig.signalStrength, 65);
  assert.equal(sig.status, "active");
  assert.ok(sig.dedupKey);
  // expansion TTL is 90 days from occurredAt
  assert.equal(sig.expiresAt, "2026-12-19T08:00:00.000Z");
});

// ── missing / invalid fields ──────────────────────────────────────────────────

test("missing fields are skipped with a specific reason", () => {
  const reason = (r: unknown) => {
    const o = mapNewsEventRecord(r, ctx());
    return o.ok ? "ok" : o.reason;
  };
  assert.equal(reason(null), "not_an_object");
  assert.equal(reason("str"), "not_an_object");
  assert.equal(reason([]), "not_an_object");
  assert.equal(reason({ id: "x" }), "missing_attributes");
  assert.equal(reason({ id: "x", attributes: [] }), "missing_attributes");
  assert.equal(reason(rec({ summary: "   " })), "missing_summary");
  assert.equal(reason(rec({ summary: 5 })), "missing_summary");
  assert.equal(reason(rec({ found_at: undefined })), "missing_timestamp");
});

test("missing category still maps (news_mention) and omits evidence.category", () => {
  const out = mapNewsEventRecord(rec({ category: undefined }), ctx());
  assert.ok(out.ok);
  assert.equal(out.event.signalType, "news_mention");
  assert.equal("category" in out.event.evidence, false);
});

test("missing record id: no providerEventId, evidence.provider_record_id is null", () => {
  const out = mapNewsEventRecord(rec({}, null), ctx());
  assert.ok(out.ok);
  assert.equal("providerEventId" in out.event, false);
  assert.equal(out.event.evidence.provider_record_id, null);
});

test("out-of-range or non-numeric confidence is dropped", () => {
  for (const c of [5, -0.1, "high", NaN, null]) {
    const out = mapNewsEventRecord(rec({ confidence: c }), ctx());
    assert.ok(out.ok);
    assert.equal(out.event.confidence, undefined, String(c));
  }
  const ok = mapNewsEventRecord(rec({ confidence: "0.5" }), ctx());
  assert.ok(ok.ok);
  assert.equal(ok.event.confidence, 0.5);
});

// ── timestamps ────────────────────────────────────────────────────────────────

test("timestamps: published_at wins over found_at; date-only → midnight UTC", () => {
  const o = mapNewsEventRecord(rec({ published_at: "2026-08-01" }), ctx());
  assert.ok(o.ok);
  assert.equal(o.event.occurredAt, "2026-08-01T00:00:00.000Z");
});

test("timestamps: falls back to found_at when published_at absent", () => {
  const o = mapNewsEventRecord(rec(), ctx());
  assert.ok(o.ok);
  assert.equal(o.event.occurredAt, "2026-09-20T08:00:00.000Z");
});

test("timestamps: offsets converted to UTC", () => {
  const o = mapNewsEventRecord(rec({ found_at: "2026-09-20T10:00:00+02:00" }), ctx());
  assert.ok(o.ok);
  assert.equal(o.event.occurredAt, "2026-09-20T08:00:00.000Z");
});

test("timestamps: unparseable or loose formats rejected", () => {
  for (const bad of ["not-a-date", "July 2026", "2026-13-45", "2026-09-20 08:00:00", "1700000000"]) {
    const o = mapNewsEventRecord(rec({ found_at: bad }), ctx());
    assert.deepEqual(o, { ok: false, reason: "invalid_timestamp" }, bad);
  }
});

test("timestamps: invalid found_at is ignored when published_at is valid", () => {
  const o = mapNewsEventRecord(rec({ found_at: "garbage", published_at: "2026-09-01" }), ctx());
  assert.ok(o.ok);
  assert.equal(o.event.occurredAt, "2026-09-01T00:00:00.000Z");
  assert.equal(o.event.metadata?.found_at, null);
});

test("timestamps: far-future rejected, within 24h tolerance accepted", () => {
  assert.deepEqual(
    mapNewsEventRecord(rec({ found_at: "2026-11-01T00:00:00.000Z" }), ctx()),
    { ok: false, reason: "future_timestamp" },
  );
  assert.ok(mapNewsEventRecord(rec({ found_at: "2026-10-01T12:00:00.000Z" }), ctx()).ok);
});

test("since filter uses found_at; boundary is inclusive; falls back to occurredAt", () => {
  const since = "2026-09-20T08:00:00.000Z";
  assert.ok(mapNewsEventRecord(rec(), ctx({ since })).ok);
  assert.deepEqual(
    mapNewsEventRecord(rec({ found_at: "2026-09-20T07:59:59.000Z" }), ctx({ since })),
    { ok: false, reason: "before_since" },
  );
  // old publication but freshly found → kept
  assert.ok(mapNewsEventRecord(rec({ published_at: "2026-01-01" }), ctx({ since })).ok);
});

// ── malformed responses ───────────────────────────────────────────────────────

test("malformed response bodies never throw", () => {
  for (const body of [null, undefined, "x", 5, [], true]) {
    const r = mapNewsEventsResponse(body, ctx());
    assert.deepEqual(r.events, []);
    assert.equal(r.responseError, "malformed_response", String(body));
  }
});

test("data not an array → responseError; missing/null data → empty, no error", () => {
  assert.equal(mapNewsEventsResponse({ data: "x" }, ctx()).responseError, "data_not_array");
  assert.equal(mapNewsEventsResponse({ data: {} }, ctx()).responseError, "data_not_array");
  for (const body of [{}, { data: null }, { data: [] }]) {
    const r = mapNewsEventsResponse(body, ctx());
    assert.deepEqual(r.events, []);
    assert.equal(r.responseError, undefined);
  }
});

test("mixed good and bad records: bad skipped with reasons, good returned", () => {
  const r = mapNewsEventsResponse(
    { data: [rec({}, "ok-1"), null, rec({ summary: "" }, "bad-2"), "junk", rec({ found_at: "nope" }, "bad-3")] },
    ctx(),
  );
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.skipped, [
    { id: null, reason: "not_an_object" },
    { id: "bad-2", reason: "missing_summary" },
    { id: null, reason: "not_an_object" },
    { id: "bad-3", reason: "invalid_timestamp" },
  ]);
});

// ── duplicates / idempotency ──────────────────────────────────────────────────

test("duplicate record ids in one response collapse; first wins", () => {
  const r = mapNewsEventsResponse(
    { data: [rec({ summary: "first" }, "dup"), rec({ summary: "second" }, "dup"), rec({}, "other")] },
    ctx(),
  );
  assert.deepEqual(r.events.map((e) => e.rawEvent.title), ["first", "Acme acquires Beta"]);
  assert.deepEqual(r.skipped, [{ id: "dup", reason: "duplicate" }]);
});

test("id-less identical records collapse on content; different ones do not", () => {
  const r = mapNewsEventsResponse(
    { data: [rec({}, null), rec({}, null), rec({ summary: "Different" }, null)] },
    ctx(),
  );
  assert.equal(r.events.length, 2);
  assert.deepEqual(r.skipped, [{ id: null, reason: "duplicate" }]);
});

test("idempotent: same response mapped twice → identical events and identical dedup keys", () => {
  const body = { data: [rec({}, "a"), rec({ category: "award" }, "b")] };
  const run = () => mapNewsEventsResponse(body, ctx());
  const one = run();
  const two = run();
  assert.deepEqual(one, two);
  const keys = (r: typeof one) =>
    r.events.map((e) => normalizeEvent(e, NOW).dedupKey);
  assert.deepEqual(keys(one), keys(two));
  assert.equal(new Set(keys(one)).size, 2);
});

test("mapper does not mutate its input", () => {
  const body = { data: [rec({}, "a")] };
  const snapshot = JSON.parse(JSON.stringify(body));
  mapNewsEventsResponse(body, ctx());
  assert.deepEqual(body, snapshot);
});

// ── tenant isolation ──────────────────────────────────────────────────────────

test("clientId/companyId come from context only and are on every event", () => {
  const body = {
    data: [
      // hostile payload trying to set tenant fields
      rec({ client_id: CLIENT_B, clientId: CLIENT_B, company_id: "evil", companyId: "evil" }, "a"),
      rec({}, "b"),
    ],
  };
  const r = mapNewsEventsResponse(body, ctx());
  assert.equal(r.events.length, 2);
  for (const e of r.events) {
    assert.equal(e.clientId, CLIENT_A);
    assert.equal(e.companyId, COMPANY);
    assert.ok(!JSON.stringify(e.rawEvent).includes(CLIENT_B));
  }
});

test("same response for two tenants yields separate, correctly tagged events", () => {
  const body = { data: [rec({}, "a")] };
  const a = mapNewsEventsResponse(body, ctx({ clientId: CLIENT_A }));
  const b = mapNewsEventsResponse(body, ctx({ clientId: CLIENT_B }));
  assert.equal(a.events[0].clientId, CLIENT_A);
  assert.equal(b.events[0].clientId, CLIENT_B);
});

// ── fake provider (fixtures only) ─────────────────────────────────────────────

test("fake provider: realistic fixture maps to expected signal types", async () => {
  const p = new FakeNewsEventsSignalProvider();
  const batch = await p.fetchEvents([COMPANY], CLIENT_A, {
    companyDomains: new Map([[COMPANY, "northlight-studio.example"]]),
    now: NOW,
  });
  assert.deepEqual(
    batch.events.map((e) => [e.rawEvent.providerEventId, e.rawEvent.signalType]),
    [
      ["news-001", "expansion"],
      ["news-002", "award"],
      ["news-003", "news_mention"], // executive hire intentionally not executive_hire
    ],
  );
  assert.ok(batch.events.every((e) => e.clientId === CLIENT_A && e.companyId === COMPANY));
});

test("fake provider: empty, malformed and unknown domains, limit and since", async () => {
  const p = new FakeNewsEventsSignalProvider();
  const A = "00000000-0000-0000-0000-00000000000a";
  const B = "00000000-0000-0000-0000-00000000000b";
  const C = "00000000-0000-0000-0000-00000000000c";
  const D = "00000000-0000-0000-0000-00000000000d";
  const domains = new Map([
    [A, "quietlane.example"],
    [B, "broken.example"],
    [C, "unknown.example"],
    // D deliberately absent
  ]);
  const batch = await p.fetchEvents([A, B, C, D], CLIENT_A, { companyDomains: domains, now: NOW });
  assert.equal(batch.events.length, 0);
  assert.ok(batch.meta?.skipped && B in (batch.meta.skipped as object));

  const nl = new Map([[COMPANY, "northlight-studio.example"]]);
  const limited = await p.fetchEvents([COMPANY], CLIENT_A, { companyDomains: nl, now: NOW, limit: 1 });
  assert.equal(limited.events.length, 1);
  const since = await p.fetchEvents([COMPANY], CLIENT_A, {
    companyDomains: nl, now: NOW, since: "2026-09-23T00:00:00.000Z",
  });
  assert.deepEqual(since.events.map((e) => e.rawEvent.providerEventId), ["news-003"]);
});

test("fixtures are not shared mutable state across calls", async () => {
  const before = JSON.stringify(FAKE_NEWS_EVENTS_FIXTURES);
  const p = new FakeNewsEventsSignalProvider();
  await p.fetchEvents([COMPANY], CLIENT_A, {
    companyDomains: new Map([[COMPANY, "northlight-studio.example"]]), now: NOW,
  });
  assert.equal(JSON.stringify(FAKE_NEWS_EVENTS_FIXTURES), before);
});

// ── no live wiring / no network ───────────────────────────────────────────────

test("no network: fetch is never called by mapper or fake provider", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("network forbidden"); }) as typeof fetch;
  try {
    mapNewsEventsResponse({ data: [rec()] }, ctx());
    await new FakeNewsEventsSignalProvider().fetchEvents([COMPANY], CLIENT_A, {
      companyDomains: new Map([[COMPANY, "northlight-studio.example"]]), now: NOW,
    });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls, 0);
});

test("fake news provider is not registered as a live provider", () => {
  const ids = getSignalProviders().map((p) => p.id);
  assert.deepEqual(ids, ["predictleads"]);
});
