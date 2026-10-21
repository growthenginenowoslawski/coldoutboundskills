/**
 * InstantlyAdapter — offline unit tests (mocked fetch; no network, no key).
 *
 * The response shapes used here are HYPOTHESES about Instantly's v2 API that
 * have never been observed against the real service. These tests prove the
 * adapter's own behaviour (mapping, pagination, error handling, key hygiene),
 * not that Instantly returns these shapes.
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import { InstantlyAdapter } from "../providers/outreach/instantly.js";
import { OutreachProviderRegistry } from "../providers/outreach/registry.js";
import {
  OutreachCredentialError,
  OutreachMalformedResponseError,
  OutreachNotFoundError,
  OutreachProviderError,
  OutreachRateLimitError,
  OutreachTimeoutError,
} from "../providers/outreach/errors.js";

type Call = { url: string; init?: RequestInit };
let originalFetch: typeof fetch;
let calls: Call[];

beforeEach(() => { originalFetch = globalThis.fetch; calls = []; });
afterEach(() => { globalThis.fetch = originalFetch; });

function mock(...responses: Array<Response | Error>) {
  let i = 0;
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r.clone();
  };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const text = (status: number, body = "") => new Response(body, { status });

const KEY = "secret-instantly-key";
const noSleep = async () => {};
const adapter = () => new InstantlyAdapter({ apiKey: KEY }, { sleep: noSleep });

// ── configuration / key hygiene ───────────────────────────────────────────────

test("isConfigured: false for empty/blank key, true otherwise", () => {
  assert.equal(new InstantlyAdapter({ apiKey: "" }).isConfigured(), false);
  assert.equal(new InstantlyAdapter({ apiKey: "  " }).isConfigured(), false);
  assert.equal(adapter().isConfigured(), true);
});

test("unconfigured adapter throws OutreachCredentialError and makes no request", async () => {
  mock(json({}));
  const a = new InstantlyAdapter({ apiKey: "" });
  await assert.rejects(a.getCampaignHealth("c1"), OutreachCredentialError);
  await assert.rejects(a.getInboxHealth("a@b.com"), OutreachCredentialError);
  await assert.rejects(a.getDomainHealth("b.com"), OutreachCredentialError);
  await assert.rejects(a.uploadLeads("c1", [lead("x@y.com")]), OutreachCredentialError);
  await assert.rejects(a.getCampaignLeads("c1"), OutreachCredentialError);
  assert.equal(calls.length, 0);
});

test("key is sent as Bearer header and never appears in the URL", async () => {
  mock(json({ email: "a@b.com", status: 1 }));
  await adapter().getInboxHealth("a@b.com");
  assert.equal((calls[0].init!.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
  assert.ok(!calls[0].url.includes(KEY));
  assert.ok(calls[0].url.startsWith("https://api.instantly.ai/api/v2/"));
});

test("key never appears in thrown error messages", async () => {
  for (const r of [text(500), text(400, "bad"), text(401, "nope"), text(404)]) {
    mock(r);
    try { await adapter().getInboxHealth("a@b.com"); assert.fail("should throw"); }
    catch (e) { assert.ok(!String((e as Error).message).includes(KEY)); }
  }
});

// ── campaign health ───────────────────────────────────────────────────────────

test("getCampaignHealth: maps analytics array + numeric status", async () => {
  mock(
    json({ id: "c1", status: 1 }),
    json([{ emails_sent_count: 200, open_count: 80, link_click_count: 10, reply_count: 6, bounced_count: 4, unsubscribed_count: 2 }]),
  );
  const h = await adapter().getCampaignHealth("c1");
  assert.equal(h.status, "active");
  assert.deepEqual(h.stats, { sent: 200, opens: 80, clicks: 10, replies: 6, bounces: 4, unsubscribes: 2 });
  assert.equal(h.openRatePct, 40);
  assert.equal(h.replyRatePct, 3);
  assert.equal(h.bounceRatePct, 2);
  assert.ok(calls[1].url.endsWith("/campaigns/analytics?id=c1"));
});

test("getCampaignHealth: accepts bare-object analytics, alternate field names, string status", async () => {
  mock(json({ status: "paused" }), json({ sent_count: 10, reply_count: 1, bounce_count: 0, click_count: 2 }));
  const h = await adapter().getCampaignHealth("c1");
  assert.equal(h.status, "paused");
  assert.equal(h.stats.sent, 10);
  assert.equal(h.stats.clicks, 2);
});

test("getCampaignHealth: zero sent → 0% rates, no NaN", async () => {
  mock(json({ status: 0 }), json([{}]));
  const h = await adapter().getCampaignHealth("c1");
  assert.equal(h.status, "draft");
  assert.deepEqual([h.openRatePct, h.replyRatePct, h.bounceRatePct], [0, 0, 0]);
});

test("getCampaignHealth: unknown status → 'unknown'; empty analytics → malformed", async () => {
  mock(json({ status: 99 }), json([{ emails_sent_count: 1 }]));
  assert.equal((await adapter().getCampaignHealth("c1")).status, "unknown");
  mock(json({ status: 1 }), json([]));
  await assert.rejects(adapter().getCampaignHealth("c1"), OutreachMalformedResponseError);
});

test("getCampaignHealth: campaign id is URL-encoded", async () => {
  mock(json({ status: 1 }), json([{}]));
  await adapter().getCampaignHealth("a/b c");
  assert.ok(calls[0].url.endsWith("/campaigns/a%2Fb%20c"));
});

// ── inboxes ───────────────────────────────────────────────────────────────────

const acct = (email: string, over: Record<string, unknown> = {}) => ({
  email, first_name: "Sarah", last_name: "Chen", status: 1, warmup_status: 1,
  stat_warmup_score: 97, daily_limit: 30, ...over,
});

test("getInboxHealth: maps fields; id is the email", async () => {
  mock(json(acct("sarah@goacme.com", { tags: ["active", { label: "uk" }, { name: "x" }] })));
  const h = await adapter().getInboxHealth("sarah@goacme.com");
  assert.equal(h.platformInboxId, "sarah@goacme.com");
  assert.equal(h.fromName, "Sarah Chen");
  assert.equal(h.warmupStatus, "active");
  assert.equal(h.warmupReputation, "excellent");
  assert.equal(h.smtpOk, true);
  assert.equal(h.dailySendLimit, 30);
  assert.deepEqual(h.tags, ["active", "uk", "x"]);
  assert.ok(calls[0].url.endsWith("/accounts/sarah%40goacme.com"));
});

test("getInboxHealth: reputation tiers and unhealthy connection", async () => {
  const tier = async (score: unknown) => {
    mock(json(acct("a@b.com", { stat_warmup_score: score })));
    return (await adapter().getInboxHealth("a@b.com")).warmupReputation;
  };
  assert.equal(await tier(95), "excellent");
  assert.equal(await tier(80), "good");
  assert.equal(await tier(60), "fair");
  assert.equal(await tier(10), "poor");
  assert.equal(await tier(undefined), "unknown");
  mock(json(acct("a@b.com", { status: -1, warmup_status: 0 })));
  const h = await adapter().getInboxHealth("a@b.com");
  assert.equal(h.smtpOk, false);
  assert.equal(h.imapOk, false);
  assert.equal(h.warmupStatus, "inactive");
});

test("getDomainHealth: filters by domain case-insensitively and paginates by cursor", async () => {
  mock(
    json({ items: [acct("a@goacme.com"), acct("x@other.com")], next_starting_after: "cur1" }),
    json({ items: [acct("b@GoAcme.com", { status: -2 })], next_starting_after: null }),
  );
  const d = await adapter().getDomainHealth("GOACME.com");
  assert.equal(d.inboxCount, 2);
  assert.equal(d.healthyInboxCount, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.includes("starting_after=cur1"));
});

test("getDomainHealth: no matches → zero counts; missing items → malformed", async () => {
  mock(json({ items: [acct("x@other.com")] }));
  assert.equal((await adapter().getDomainHealth("goacme.com")).inboxCount, 0);
  mock(json({ nope: true }));
  await assert.rejects(adapter().getDomainHealth("goacme.com"), OutreachMalformedResponseError);
});

test("pagination cannot loop forever on a stuck cursor", async () => {
  mock(json({ items: [], next_starting_after: "same" }));
  // Terminates at MAX_PAGES instead of hanging.
  const d = await adapter().getDomainHealth("goacme.com");
  assert.equal(d.inboxCount, 0);
  assert.ok(calls.length >= 100);
});

// ── leads ─────────────────────────────────────────────────────────────────────

const lead = (email: string) => ({
  email, firstName: "A", lastName: "B", companyName: "Co", customFields: { situation_line: "hi" },
});

test("uploadLeads: empty → zero, no fetch", async () => {
  mock(json({}));
  assert.deepEqual(await adapter().uploadLeads("c1", []), { uploadCount: 0, duplicateCount: 0 });
  assert.equal(calls.length, 0);
});

test("uploadLeads: one POST /leads per lead with campaign + mapped fields", async () => {
  mock(json({ id: "l1" }));
  const r = await adapter().uploadLeads("c1", [lead("a@x.com"), lead("b@x.com")]);
  assert.deepEqual(r, { uploadCount: 2, duplicateCount: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init!.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init!.body)), {
    campaign: "c1", email: "a@x.com", first_name: "A", last_name: "B",
    company_name: "Co", custom_variables: { situation_line: "hi" }, skip_if_in_campaign: true,
  });
});

test("uploadLeads: 409 counted as duplicate, other errors propagate", async () => {
  mock(json({ id: "l1" }), text(409, "exists"), json({ id: "l3" }));
  const r = await adapter().uploadLeads("c1", [lead("a@x.com"), lead("b@x.com"), lead("c@x.com")]);
  assert.deepEqual(r, { uploadCount: 2, duplicateCount: 1 });
  mock(text(400, "invalid email"));
  await assert.rejects(adapter().uploadLeads("c1", [lead("bad")]), OutreachProviderError);
});

test("uploadLeads: caps a batch at 100 leads", async () => {
  mock(json({}));
  const many = Array.from({ length: 150 }, (_, i) => lead(`u${i}@x.com`));
  const r = await adapter().uploadLeads("c1", many);
  assert.equal(r.uploadCount, 100);
  assert.equal(calls.length, 100);
});

test("getCampaignLeads: normalises email, skips unusable rows, paginates", async () => {
  mock(
    json({ items: [{ id: "L1", email: " A@X.com ", status: 1 }, { id: "", email: "b@x.com" }, { id: "L3" }], next_starting_after: "c" }),
    json({ items: [{ id: 4, email: "d@x.com" }] }),
  );
  const r = await adapter().getCampaignLeads("c1");
  assert.deepEqual(r, [
    { campaignLeadMapId: "L1", email: "a@x.com", smartleadStatus: "1" },
    { campaignLeadMapId: "4", email: "d@x.com", smartleadStatus: "" },
  ]);
  assert.deepEqual(JSON.parse(String(calls[1].init!.body)), { campaign: "c1", limit: 100, starting_after: "c" });
});

test("getCampaignLeadDetail: finds by id with rawFields; null when absent", async () => {
  const items = [{ id: "L1", email: "a@x.com", status: 1, timestamp_created: "2026-10-01T00:00:00Z", extra: 1 }];
  mock(json({ items }));
  const d = await adapter().getCampaignLeadDetail("c1", "L1");
  assert.equal(d?.email, "a@x.com");
  assert.equal(d?.createdAt, "2026-10-01T00:00:00Z");
  assert.equal(d?.rawFields.extra, 1);
  assert.equal(d?.sentAt, null);
  mock(json({ items }));
  assert.equal(await adapter().getCampaignLeadDetail("c1", "nope"), null);
});

// ── HTTP error handling ───────────────────────────────────────────────────────

test("401/403 → OutreachCredentialError; 404 → OutreachNotFoundError", async () => {
  mock(text(401, "bad key"));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), OutreachCredentialError);
  mock(text(403));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), OutreachCredentialError);
  mock(text(404));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), OutreachNotFoundError);
});

test("429 retries once then succeeds; persistent 429 → OutreachRateLimitError", async () => {
  mock(text(429), json(acct("a@b.com")));
  assert.equal((await adapter().getInboxHealth("a@b.com")).email, "a@b.com");
  assert.equal(calls.length, 2);
  mock(new Response("", { status: 429, headers: { "Retry-After": "7" } }));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), (e: Error) =>
    e instanceof OutreachRateLimitError && e.retryAfterMs === 7000);
});

test("5xx retries up to 3 attempts then OutreachProviderError; recovers if later ok", async () => {
  mock(text(503));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), OutreachProviderError);
  assert.equal(calls.length, 3);
  calls = [];
  mock(text(500), json(acct("a@b.com")));
  assert.equal((await adapter().getInboxHealth("a@b.com")).email, "a@b.com");
});

test("timeout → OutreachTimeoutError; network failure → OutreachProviderError", async () => {
  const t = new Error("t"); t.name = "TimeoutError";
  mock(t);
  await assert.rejects(adapter().getInboxHealth("a@b.com"), OutreachTimeoutError);
  mock(new Error("ECONNRESET"));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), OutreachProviderError);
});

test("non-JSON and non-object bodies → OutreachMalformedResponseError", async () => {
  mock(new Response("<html>", { status: 200 }));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), OutreachMalformedResponseError);
  mock(json("a string"));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), OutreachMalformedResponseError);
});

test("other 4xx → OutreachProviderError carrying the status", async () => {
  mock(text(422, "unprocessable"));
  await assert.rejects(adapter().getInboxHealth("a@b.com"), /HTTP 422/);
});

// ── registry ──────────────────────────────────────────────────────────────────

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("registry.fromEnv(): instantly resolves to InstantlyAdapter with INSTANTLY_API_KEY", () => {
  withEnv({ INSTANTLY_API_KEY: "k", SMARTLEAD_API_KEY: undefined }, () => {
    const p = OutreachProviderRegistry.fromEnv().getProvider("instantly", "c1");
    assert.equal(p.id, "instantly");
    assert.ok(p instanceof InstantlyAdapter);
  });
});

test("registry.fromEnv(): missing INSTANTLY_API_KEY → OutreachCredentialError", () => {
  withEnv({ INSTANTLY_API_KEY: undefined, SMARTLEAD_API_KEY: "s" }, () => {
    assert.throws(() => OutreachProviderRegistry.fromEnv().getProvider("instantly", "c1"),
      OutreachCredentialError);
  });
});

test("registry.fromEnv(): providers do not borrow each other's keys", () => {
  withEnv({ INSTANTLY_API_KEY: "i", SMARTLEAD_API_KEY: undefined }, () => {
    assert.throws(() => OutreachProviderRegistry.fromEnv().getProvider("smartlead", "c1"),
      OutreachCredentialError);
  });
  withEnv({ INSTANTLY_API_KEY: undefined, SMARTLEAD_API_KEY: "s" }, () => {
    const p = OutreachProviderRegistry.fromEnv().getProvider("smartlead", "c1");
    assert.equal(p.id, "smartlead");
  });
});
