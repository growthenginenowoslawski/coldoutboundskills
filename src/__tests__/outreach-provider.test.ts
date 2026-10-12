/**
 * Unit tests for Stage 16 outreach provider abstraction.
 *
 * All tests are pure — no network calls, no Supabase, no real credentials.
 * Network calls are intercepted using globalThis.fetch mock overrides.
 *
 * Run: node --import tsx --test "src/__tests__/outreach-provider.test.ts"
 */

import assert from "node:assert/strict";
import { test, beforeEach, afterEach } from "node:test";

import { SmartleadAdapter } from "../providers/outreach/smartlead.js";
import { OutreachProviderRegistry } from "../providers/outreach/registry.js";
import {
  OutreachCredentialError,
  OutreachNotFoundError,
  OutreachRateLimitError,
  OutreachTimeoutError,
  OutreachMalformedResponseError,
  OutreachProviderError,
} from "../providers/outreach/errors.js";

// ── Mock fetch helper ─────────────────────────────────────────────────────────

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

let originalFetch: typeof fetch;

function mockFetch(impl: FetchMock) {
  (globalThis as any).fetch = impl;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function statusResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Error types ───────────────────────────────────────────────────────────────

test("OutreachCredentialError has correct name and provider", () => {
  const err = new OutreachCredentialError("smartlead");
  assert.equal(err.name, "OutreachCredentialError");
  assert.equal(err.provider, "smartlead");
  assert.ok(err instanceof OutreachProviderError);
  assert.ok(err instanceof Error);
});

test("OutreachRateLimitError exposes retryAfterMs", () => {
  const err = new OutreachRateLimitError("smartlead", 5000);
  assert.equal(err.retryAfterMs, 5000);
  assert.equal(err.name, "OutreachRateLimitError");
});

test("OutreachNotFoundError includes resource type and id in message", () => {
  const err = new OutreachNotFoundError("smartlead", "campaign", "12345");
  assert.ok(err.message.includes("12345"));
  assert.ok(err.message.includes("campaign"));
});

// ── SmartleadAdapter.isConfigured() ──────────────────────────────────────────

test("isConfigured() returns false for empty apiKey", () => {
  const adapter = new SmartleadAdapter({ apiKey: "" });
  assert.equal(adapter.isConfigured(), false);
});

test("isConfigured() returns false for whitespace-only apiKey", () => {
  const adapter = new SmartleadAdapter({ apiKey: "   " });
  assert.equal(adapter.isConfigured(), false);
});

test("isConfigured() returns true for non-empty apiKey", () => {
  const adapter = new SmartleadAdapter({ apiKey: "test-key-123" });
  assert.equal(adapter.isConfigured(), true);
});

test("adapter id is 'smartlead'", () => {
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  assert.equal(adapter.id, "smartlead");
});

// ── getCampaignHealth — success ───────────────────────────────────────────────

test("getCampaignHealth parses analytics response correctly", async () => {
  mockFetch(async () =>
    jsonResponse({
      sent_count: 100,
      open_count: 30,
      click_count: 5,
      reply_count: 10,
      bounce_count: 2,
      unsubscribed_count: 1,
      campaign_status: "active",
    }),
  );

  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getCampaignHealth("42");

  assert.equal(result.platformCampaignId, "42");
  assert.equal(result.status, "active");
  assert.equal(result.stats.sent, 100);
  assert.equal(result.stats.opens, 30);
  assert.equal(result.stats.replies, 10);
  assert.equal(result.stats.bounces, 2);
  assert.equal(result.openRatePct, 30);
  assert.equal(result.replyRatePct, 10);
  assert.equal(result.bounceRatePct, 2);
  assert.ok(result.fetchedAt);
});

test("getCampaignHealth returns 0 rates when sent_count is 0", async () => {
  mockFetch(async () =>
    jsonResponse({ sent_count: 0, open_count: 0, reply_count: 0, bounce_count: 0 }),
  );
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getCampaignHealth("1");
  assert.equal(result.openRatePct, 0);
  assert.equal(result.replyRatePct, 0);
  assert.equal(result.bounceRatePct, 0);
});

test("getCampaignHealth maps unknown status to 'unknown'", async () => {
  mockFetch(async () => jsonResponse({ campaign_status: "weird_status" }));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getCampaignHealth("1");
  assert.equal(result.status, "unknown");
});

test("getCampaignHealth maps 'paused' correctly", async () => {
  mockFetch(async () => jsonResponse({ campaign_status: "paused" }));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getCampaignHealth("1");
  assert.equal(result.status, "paused");
});

// ── getCampaignHealth — error handling ───────────────────────────────────────

test("getCampaignHealth throws OutreachCredentialError on 401", async () => {
  mockFetch(async () => statusResponse(401));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.getCampaignHealth("1"),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});

test("getCampaignHealth throws OutreachCredentialError on 403", async () => {
  mockFetch(async () => statusResponse(403));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.getCampaignHealth("1"),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});

test("getCampaignHealth throws OutreachNotFoundError on 404", async () => {
  mockFetch(async () => statusResponse(404));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.getCampaignHealth("999"),
    (err: Error) => err instanceof OutreachNotFoundError,
  );
});

test("getCampaignHealth throws OutreachMalformedResponseError for non-JSON", async () => {
  mockFetch(async () => new Response("not json", { status: 200 }));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.getCampaignHealth("1"),
    (err: Error) => err instanceof OutreachMalformedResponseError,
  );
});

test("getCampaignHealth throws OutreachCredentialError when not configured", async () => {
  const adapter = new SmartleadAdapter({ apiKey: "" });
  await assert.rejects(
    () => adapter.getCampaignHealth("1"),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});

// ── getInboxHealth — success ──────────────────────────────────────────────────

test("getInboxHealth parses inbox account correctly", async () => {
  mockFetch(async () =>
    jsonResponse({
      id: 101,
      from_email: "hello@example.com",
      from_name: "Eric",
      is_smtp_success: true,
      is_imap_success: true,
      message_per_day: 50,
      daily_sent_count: 20,
      tags: [{ id: 1, name: "active" }],
      warmup_details: {
        status: "active",
        warmup_reputation: "excellent",
        max_email_per_day: 40,
        is_warmup_blocked: false,
        total_sent_count: 500,
      },
    }),
  );

  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getInboxHealth("101");

  assert.equal(result.platformInboxId, "101");
  assert.equal(result.email, "hello@example.com");
  assert.equal(result.fromName, "Eric");
  assert.equal(result.warmupStatus, "active");
  assert.equal(result.warmupReputation, "excellent");
  assert.equal(result.smtpOk, true);
  assert.equal(result.imapOk, true);
  assert.equal(result.isWarmupBlocked, false);
  assert.equal(result.dailySendLimit, 50);
  assert.equal(result.dailySentCount, 20);
  assert.equal(result.totalWarmupSent, 500);
  assert.deepEqual(result.tags, ["active"]);
});

test("getInboxHealth maps poor warmup reputation", async () => {
  mockFetch(async () =>
    jsonResponse({ id: 5, warmup_details: { warmup_reputation: "poor" } }),
  );
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getInboxHealth("5");
  assert.equal(result.warmupReputation, "poor");
});

test("getInboxHealth uses from_email over email field", async () => {
  mockFetch(async () =>
    jsonResponse({ id: 7, from_email: "primary@x.com", email: "fallback@x.com" }),
  );
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getInboxHealth("7");
  assert.equal(result.email, "primary@x.com");
});

// ── getDomainHealth — success ─────────────────────────────────────────────────

test("getDomainHealth filters inboxes by domain", async () => {
  let callCount = 0;
  mockFetch(async (url) => {
    callCount++;
    // Return two inboxes on example.com and one on other.com
    if (url.includes("email-accounts")) {
      return jsonResponse([
        { id: 1, from_email: "a@example.com", is_smtp_success: true, is_imap_success: true, warmup_details: { is_warmup_blocked: false } },
        { id: 2, from_email: "b@example.com", is_smtp_success: false, is_imap_success: false, warmup_details: { is_warmup_blocked: true } },
        { id: 3, from_email: "c@other.com", is_smtp_success: true, is_imap_success: true, warmup_details: { is_warmup_blocked: false } },
      ]);
    }
    return jsonResponse([]);
  });

  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getDomainHealth("example.com");

  assert.equal(result.domain, "example.com");
  assert.equal(result.inboxCount, 2);
  assert.equal(result.healthyInboxCount, 1);
  assert.equal(result.blockedInboxCount, 1);
  assert.equal(result.inboxes.length, 2);
});

test("getDomainHealth returns empty result for unknown domain", async () => {
  mockFetch(async () => jsonResponse([]));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getDomainHealth("unknown.com");
  assert.equal(result.inboxCount, 0);
  assert.equal(result.healthyInboxCount, 0);
  assert.equal(result.inboxes.length, 0);
});

test("getDomainHealth is case-insensitive for domain matching", async () => {
  mockFetch(async (url) => {
    if (url.includes("offset=0")) {
      return jsonResponse([
        { id: 1, from_email: "a@EXAMPLE.COM", is_smtp_success: true, is_imap_success: true, warmup_details: {} },
      ]);
    }
    return jsonResponse([]);
  });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result = await adapter.getDomainHealth("example.com");
  assert.equal(result.inboxCount, 1);
});

// ── OutreachProviderRegistry ──────────────────────────────────────────────────

test("registry.fromEnv() returns SmartleadAdapter when SMARTLEAD_API_KEY is set", () => {
  const original = process.env.SMARTLEAD_API_KEY;
  try {
    process.env.SMARTLEAD_API_KEY = "test-key";
    const registry = OutreachProviderRegistry.fromEnv();
    const provider = registry.getProvider("smartlead", "client-1");
    assert.equal(provider.id, "smartlead");
    assert.equal(provider.isConfigured(), true);
  } finally {
    if (original === undefined) delete process.env.SMARTLEAD_API_KEY;
    else process.env.SMARTLEAD_API_KEY = original;
  }
});

test("registry.fromEnv() throws OutreachCredentialError when SMARTLEAD_API_KEY missing", () => {
  const original = process.env.SMARTLEAD_API_KEY;
  try {
    delete process.env.SMARTLEAD_API_KEY;
    const registry = OutreachProviderRegistry.fromEnv();
    assert.throws(
      () => registry.getProvider("smartlead", "client-1"),
      (err: Error) => err instanceof OutreachCredentialError,
    );
  } finally {
    if (original !== undefined) process.env.SMARTLEAD_API_KEY = original;
  }
});

test("registry throws OutreachProviderError for unimplemented providers", () => {
  const registry = OutreachProviderRegistry.fromEnv();
  assert.throws(
    () => registry.getProvider("instantly", "client-1"),
    (err: Error) => err instanceof OutreachProviderError,
  );
  assert.throws(
    () => registry.getProvider("plusvibe", "client-1"),
    (err: Error) => err instanceof OutreachProviderError,
  );
});

// ── uploadLeads ───────────────────────────────────────────────────────────────

test("uploadLeads: empty leads returns zero without making a fetch call", async () => {
  let called = false;
  mockFetch(async () => { called = true; return jsonResponse({}); });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.uploadLeads("camp-1", []);
  assert.equal(result.uploadCount,   0);
  assert.equal(result.duplicateCount, 0);
  assert.equal(called, false, "fetch should not be called for empty leads array");
});

test("uploadLeads: throws OutreachCredentialError when not configured", async () => {
  const adapter = new SmartleadAdapter({ apiKey: "" });
  await assert.rejects(
    () => adapter.uploadLeads("camp-1", [{ email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" }]),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});

test("uploadLeads: maps upload_count to uploadCount on new lead", async () => {
  mockFetch(async () => jsonResponse({
    ok: true, upload_count: 1, duplicate_count: 0, already_added_to_campaign: 0,
  }));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.uploadLeads("camp-1", [
    { email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" },
  ]);
  assert.equal(result.uploadCount,    1);
  assert.equal(result.duplicateCount, 0);
});

test("uploadLeads: maps already_added_to_campaign to duplicateCount (per-campaign dedup)", async () => {
  mockFetch(async () => jsonResponse({
    ok: true, upload_count: 0, duplicate_count: 0, already_added_to_campaign: 1,
  }));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.uploadLeads("camp-1", [
    { email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" },
  ]);
  assert.equal(result.uploadCount,    0);
  assert.equal(result.duplicateCount, 1);
});

test("uploadLeads: already_added_to_campaign takes precedence over duplicate_count", async () => {
  mockFetch(async () => jsonResponse({
    ok: true, upload_count: 0, duplicate_count: 99, already_added_to_campaign: 3,
  }));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.uploadLeads("camp-1", [
    { email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" },
  ]);
  assert.equal(result.duplicateCount, 3, "already_added_to_campaign should win over duplicate_count");
});

test("uploadLeads: falls back to duplicate_count when already_added_to_campaign absent", async () => {
  mockFetch(async () => jsonResponse({
    ok: true, upload_count: 0, duplicate_count: 2,
    // already_added_to_campaign intentionally absent
  }));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.uploadLeads("camp-1", [
    { email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" },
  ]);
  assert.equal(result.duplicateCount, 2);
});

test("uploadLeads: POST URL does not contain ignore_duplicate parameter", async () => {
  let capturedUrl = "";
  mockFetch(async (url) => {
    capturedUrl = url;
    return jsonResponse({ ok: true, upload_count: 1, already_added_to_campaign: 0 });
  });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await adapter.uploadLeads("camp-42", [
    { email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" },
  ]);
  assert.ok(
    !capturedUrl.includes("ignore_duplicate"),
    "URL must not contain ignore_duplicate (rejected by Smartlead API with HTTP 400)",
  );
});

test("uploadLeads: POST URL contains correct /campaigns/{id}/leads path", async () => {
  let capturedUrl = "";
  mockFetch(async (url) => {
    capturedUrl = url;
    return jsonResponse({ ok: true, upload_count: 1, already_added_to_campaign: 0 });
  });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await adapter.uploadLeads("camp-42", [
    { email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" },
  ]);
  assert.ok(capturedUrl.includes("/campaigns/camp-42/leads"), "URL must contain the correct campaign leads path");
});

test("uploadLeads: API key never appears in error message on HTTP 400", async () => {
  mockFetch(async () => new Response(
    JSON.stringify({ message: "Bad Request" }),
    { status: 400 },
  ));
  const adapter = new SmartleadAdapter({ apiKey: "secret-key-xyz" });
  let errorMsg = "";
  try {
    await adapter.uploadLeads("camp-1", [{ email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" }]);
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }
  assert.ok(!errorMsg.includes("secret-key-xyz"), "API key must never appear in thrown error messages");
});

test("uploadLeads: throws OutreachCredentialError on 401", async () => {
  mockFetch(async () => new Response(
    JSON.stringify({ message: "Unauthorized" }), { status: 401 },
  ));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.uploadLeads("camp-1", [{ email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" }]),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});

test("uploadLeads: throws OutreachNotFoundError on 404", async () => {
  mockFetch(async () => statusResponse(404));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.uploadLeads("camp-999", [{ email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" }]),
    (err: Error) => err instanceof OutreachNotFoundError,
  );
});

test("uploadLeads: sends correct JSON body structure to Smartlead", async () => {
  let capturedBody = "";
  mockFetch(async (_, init) => {
    capturedBody = (init?.body as string) ?? "";
    return jsonResponse({ ok: true, upload_count: 1, already_added_to_campaign: 0 });
  });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await adapter.uploadLeads("camp-1", [
    { email: "test@example.com", firstName: "Jane", lastName: "Doe", companyName: "Acme" },
  ]);
  const parsed = JSON.parse(capturedBody) as { lead_list: unknown[] };
  assert.ok(Array.isArray(parsed.lead_list), "body must have lead_list array");
  assert.equal(parsed.lead_list.length, 1);
  const lead = parsed.lead_list[0] as Record<string, unknown>;
  assert.equal(lead.email,        "test@example.com");
  assert.equal(lead.first_name,   "Jane");
  assert.equal(lead.last_name,    "Doe");
  assert.equal(lead.company_name, "Acme");
  assert.deepEqual(lead.custom_fields, {});
});

test("uploadLeads: caps batch at 100 leads defensively even if caller sends more", async () => {
  let capturedBody = "";
  mockFetch(async (_, init) => {
    capturedBody = (init?.body as string) ?? "";
    return jsonResponse({ ok: true, upload_count: 100, already_added_to_campaign: 0 });
  });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const leads = Array.from({ length: 150 }, (_, i) => ({
    email: `lead${i}@example.com`, firstName: "F", lastName: "L", companyName: "Co",
  }));
  await adapter.uploadLeads("camp-1", leads);
  const parsed = JSON.parse(capturedBody) as { lead_list: unknown[] };
  assert.equal(parsed.lead_list.length, 100, "adapter must cap at 100 regardless of input size");
});

test("uploadLeads: throws OutreachProviderError on unexpected non-401/404 HTTP error", async () => {
  // 400 hits the generic !resp.ok branch (no retry loop) — confirms OutreachProviderError propagation
  mockFetch(async () => new Response(
    JSON.stringify({ message: "Bad Request" }), { status: 400 },
  ));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.uploadLeads("camp-1", [{ email: "a@b.com", firstName: "A", lastName: "B", companyName: "C" }]),
    (err: Error) => err instanceof OutreachProviderError,
  );
});

// ── getCampaignLeads ──────────────────────────────────────────────────────────

function makeSlLead(
  email:   string,
  mapId:   string | number,
  status = "STARTED",
) {
  return {
    campaign_lead_map_id: mapId,
    lead_category_id:     null,
    status,
    created_at:           "2026-09-05T12:00:00.000Z",
    lead: {
      id:              12345,
      email,
      first_name:      "Test",
      last_name:       "User",
      company_name:    "Acme",
      is_unsubscribed: false,
    },
  };
}

function makeLeadsResponse(leads: unknown[], offset = 0, limit = 100) {
  return { total_leads: String(leads.length), data: leads, offset, limit };
}

test("getCampaignLeads: empty data array returns []", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeads("camp-1");
  assert.deepEqual(result, []);
});

test("getCampaignLeads: throws OutreachCredentialError when not configured", async () => {
  const adapter = new SmartleadAdapter({ apiKey: "" });
  await assert.rejects(
    () => adapter.getCampaignLeads("camp-1"),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});

test("getCampaignLeads: maps campaign_lead_map_id to campaignLeadMapId", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([makeSlLead("a@b.com", "map-99")])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeads("camp-1");
  assert.equal(result[0]?.campaignLeadMapId, "map-99");
});

test("getCampaignLeads: extracts lead.email and normalizes to lowercase", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([makeSlLead("ALICE@EXAMPLE.COM", "map-1")])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeads("camp-1");
  assert.equal(result[0]?.email, "alice@example.com");
});

test("getCampaignLeads: maps status to smartleadStatus", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([makeSlLead("a@b.com", "map-1", "STARTED")])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeads("camp-1");
  assert.equal(result[0]?.smartleadStatus, "STARTED");
});

test("getCampaignLeads: skips items missing campaign_lead_map_id", async () => {
  const lead = makeSlLead("a@b.com", "map-1");
  mockFetch(async () => jsonResponse(makeLeadsResponse([{ ...lead, campaign_lead_map_id: undefined }])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeads("camp-1");
  assert.equal(result.length, 0);
});

test("getCampaignLeads: skips items missing lead.email", async () => {
  const lead = makeSlLead("a@b.com", "map-1");
  mockFetch(async () => jsonResponse(makeLeadsResponse([{ ...lead, lead: { ...lead.lead, email: undefined } }])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeads("camp-1");
  assert.equal(result.length, 0);
});

test("getCampaignLeads: numeric campaign_lead_map_id coerced to string", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([makeSlLead("a@b.com", 3643998176)])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeads("camp-1");
  assert.equal(typeof result[0]?.campaignLeadMapId, "string");
  assert.equal(result[0]?.campaignLeadMapId, "3643998176");
});

test("getCampaignLeads: paginates — fetches page 2 when page 1 is exactly 100", async () => {
  let callCount = 0;
  mockFetch(async (url) => {
    callCount++;
    if (url.includes("offset=0")) {
      const page1 = Array.from({ length: 100 }, (_, i) => makeSlLead(`lead${i}@test.com`, `id-${i}`));
      return jsonResponse(makeLeadsResponse(page1, 0, 100));
    }
    return jsonResponse(makeLeadsResponse([makeSlLead("lead100@test.com", "id-100")], 100, 100));
  });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeads("camp-1");
  assert.equal(callCount, 2, "must make 2 fetch calls for 101 leads");
  assert.equal(result.length, 101);
});

test("getCampaignLeads: stops pagination on partial page (< 100 items)", async () => {
  let callCount = 0;
  mockFetch(async () => {
    callCount++;
    return jsonResponse(makeLeadsResponse([makeSlLead("a@b.com", "id-1")], 0, 100));
  });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await adapter.getCampaignLeads("camp-1");
  assert.equal(callCount, 1, "must not fetch a 2nd page when first page has < 100 items");
});

test("getCampaignLeads: throws OutreachNotFoundError on 404", async () => {
  mockFetch(async () => statusResponse(404));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.getCampaignLeads("camp-999"),
    (err: Error) => err instanceof OutreachNotFoundError,
  );
});

test("getCampaignLeads: throws OutreachCredentialError on 401", async () => {
  mockFetch(async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  await assert.rejects(
    () => adapter.getCampaignLeads("camp-1"),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});

// ── getCampaignLeadDetail ─────────────────────────────────────────────────────

function makeDetailLead(
  email:   string,
  mapId:   string | number,
  overrides: Partial<{
    status:          string;
    lead_category_id: string | null;
    created_at:      string;
    sent_at:         string | null;
    replied_at:      string | null;
    bounced_at:      string | null;
    unsubscribed_at: string | null;
    reply_type:      string | null;
    is_unsubscribed: boolean;
    lead_id:         number;
  }> = {},
) {
  return {
    campaign_lead_map_id: mapId,
    lead_category_id:     overrides.lead_category_id ?? null,
    status:               overrides.status ?? "STARTED",
    created_at:           overrides.created_at ?? "2026-09-05T12:00:00.000Z",
    sent_at:              overrides.sent_at ?? null,
    replied_at:           overrides.replied_at ?? null,
    bounced_at:           overrides.bounced_at ?? null,
    unsubscribed_at:      overrides.unsubscribed_at ?? null,
    reply_type:           overrides.reply_type ?? null,
    lead: {
      id:              overrides.lead_id ?? 99999,
      email,
      first_name:      "Test",
      last_name:       "User",
      company_name:    "Acme",
      is_unsubscribed: overrides.is_unsubscribed ?? false,
    },
  };
}

test("getCampaignLeadDetail: returns null when lead not in campaign roster", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeadDetail("camp-1", "missing-id");
  assert.equal(result, null);
});

test("getCampaignLeadDetail: throws OutreachCredentialError when not configured", async () => {
  const adapter = new SmartleadAdapter({ apiKey: "" });
  await assert.rejects(
    () => adapter.getCampaignLeadDetail("camp-1", "some-id"),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});

test("getCampaignLeadDetail: returns matching lead by campaignLeadMapId", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([
    makeDetailLead("other@x.com", "map-1"),
    makeDetailLead("target@x.com", "map-42"),
  ])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeadDetail("camp-1", "map-42");
  assert.ok(result !== null);
  assert.equal(result.campaignLeadMapId, "map-42");
  assert.equal(result.email, "target@x.com");
});

test("getCampaignLeadDetail: maps all confirmed STARTED-state fields", async () => {
  const raw = makeDetailLead("test@acme.com", "map-7", {
    status:           "STARTED",
    lead_category_id: null,
    created_at:       "2026-09-05T12:00:00.000Z",
    lead_id:          123456,
    is_unsubscribed:  false,
  });
  mockFetch(async () => jsonResponse(makeLeadsResponse([raw])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeadDetail("camp-1", "map-7");
  assert.ok(result !== null);
  assert.equal(result.smartleadStatus, "STARTED");
  assert.equal(result.leadId,          "123456");
  assert.equal(result.leadCategoryId,  null);
  assert.equal(result.createdAt,       "2026-09-05T12:00:00.000Z");
  assert.equal(result.isUnsubscribed,  false);
});

test("getCampaignLeadDetail: engagement fields are null when absent (DRAFTED campaign)", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([makeDetailLead("a@b.com", "map-1")])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeadDetail("camp-1", "map-1");
  assert.ok(result !== null);
  assert.equal(result.sentAt,        null);
  assert.equal(result.repliedAt,     null);
  assert.equal(result.bouncedAt,     null);
  assert.equal(result.unsubscribedAt, null);
  assert.equal(result.replyType,     null);
});

test("getCampaignLeadDetail: engagement fields populated when present", async () => {
  const raw = makeDetailLead("a@b.com", "map-1", {
    sent_at:         "2026-10-01T09:00:00.000Z",
    replied_at:      "2026-10-02T10:00:00.000Z",
    reply_type:      "INTERESTED",
  });
  mockFetch(async () => jsonResponse(makeLeadsResponse([raw])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeadDetail("camp-1", "map-1");
  assert.ok(result !== null);
  assert.equal(result.sentAt,    "2026-10-01T09:00:00.000Z");
  assert.equal(result.repliedAt, "2026-10-02T10:00:00.000Z");
  assert.equal(result.replyType, "INTERESTED");
});

test("getCampaignLeadDetail: rawFields contains full unmodified lead object", async () => {
  const raw = makeDetailLead("a@b.com", "map-1", { status: "STARTED" });
  mockFetch(async () => jsonResponse(makeLeadsResponse([raw])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeadDetail("camp-1", "map-1");
  assert.ok(result !== null);
  // rawFields must expose the nested lead object and all top-level fields
  assert.ok("lead" in result.rawFields, "rawFields must contain nested lead object");
  assert.ok("campaign_lead_map_id" in result.rawFields, "rawFields must contain campaign_lead_map_id");
  assert.ok("status" in result.rawFields, "rawFields must contain status");
});

test("getCampaignLeadDetail: searches page 2 when lead not on page 1", async () => {
  let callCount = 0;
  mockFetch(async (url) => {
    callCount++;
    if (url.includes("offset=0")) {
      const page1 = Array.from({ length: 100 }, (_, i) => makeDetailLead(`lead${i}@x.com`, `id-${i}`));
      return jsonResponse(makeLeadsResponse(page1, 0, 100));
    }
    return jsonResponse(makeLeadsResponse([makeDetailLead("target@x.com", "id-100")], 100, 100));
  });
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeadDetail("camp-1", "id-100");
  assert.equal(callCount, 2, "must fetch page 2 to find a lead not on page 1");
  assert.ok(result !== null);
  assert.equal(result.campaignLeadMapId, "id-100");
});

test("getCampaignLeadDetail: numeric campaign_lead_map_id matched correctly", async () => {
  mockFetch(async () => jsonResponse(makeLeadsResponse([makeDetailLead("a@b.com", 3643998176)])));
  const adapter = new SmartleadAdapter({ apiKey: "k" });
  const result  = await adapter.getCampaignLeadDetail("camp-1", "3643998176");
  assert.ok(result !== null, "numeric id must match when searched as string");
  assert.equal(result.campaignLeadMapId, "3643998176");
});

// ── OutreachProviderRegistry ──────────────────────────────────────────────────

test("registry supports custom credential resolver for multi-tenant isolation", () => {
  const registry = new OutreachProviderRegistry((providerId, clientId) => {
    if (providerId === "smartlead" && clientId === "client-a") {
      return { apiKey: "key-for-client-a" };
    }
    return undefined;
  });

  const providerA = registry.getProvider("smartlead", "client-a");
  assert.equal(providerA.isConfigured(), true);

  assert.throws(
    () => registry.getProvider("smartlead", "client-b"),
    (err: Error) => err instanceof OutreachCredentialError,
  );
});
