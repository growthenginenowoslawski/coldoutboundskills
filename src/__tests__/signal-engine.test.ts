/**
 * Signal Engine — comprehensive offline tests.
 *
 * All tests are pure / deterministic. No database, no network, no env vars.
 *
 * Coverage:
 *   signal-dedup     — tier selection, key stability, key distinctness
 *   signal-freshness — expires_at computation, freshness score, expiry detection
 *   signal-strength  — base strength, actionability, confidence clamping
 *   normalizer       — full field mapping, dedup assignment, error handling
 *   fake-provider    — scenario enumeration, event generation, limit
 *   db row-builders  — buildSignalRow / fromDbRow round-trip
 *   tenant isolation — clientId scoping
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDedupKey, dedupTier } from "../lib/signal-dedup";
import {
  computeExpiresAt,
  computeFreshnessScore,
  getTtlDays,
  isExpired,
} from "../lib/signal-freshness";
import {
  computeSignalStrength,
  computeActionabilityScore,
  defaultConfidence,
  validateConfidence,
} from "../lib/signal-strength";
import { normalizeEvent, normalizeBatch } from "../providers/signals/normalizer";
import { FakeSignalProvider, FAKE_SCENARIOS } from "../providers/signals/fake-provider";
import { buildSignalRow, fromDbRow } from "../db/signals";
import type { RawSignalEvent, SignalProviderEvent } from "../domain/signal-types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_A = "00000000-0000-0000-0000-000000000001";
const COMPANY_B = "00000000-0000-0000-0000-000000000002";
const CLIENT_A  = "00000000-0000-0000-0000-0000000000a1";
const CLIENT_B  = "00000000-0000-0000-0000-0000000000b1";

const FIXED_NOW = new Date("2026-09-01T12:00:00.000Z");

function makeRawEvent(overrides: Partial<RawSignalEvent> = {}): RawSignalEvent {
  return {
    source: "test",
    signalType: "executive_hire",
    title: "New VP of Sales",
    description: "Hired a VP of Sales 5 days ago",
    evidence: { event: "new_executive_hire", role: "VP Sales", name: "Alex Doe" },
    occurredAt: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

function makeProviderEvent(
  companyId = COMPANY_A,
  clientId = CLIENT_A,
  rawOverrides: Partial<RawSignalEvent> = {},
): SignalProviderEvent {
  return { companyId, clientId, rawEvent: makeRawEvent(rawOverrides) };
}

const DETECTED_AT = "2026-09-01T12:00:00.000Z";

// ── signal-dedup: tier selection ──────────────────────────────────────────────

test("dedup: provider ID present → tier is 'provider-id'", () => {
  const event = makeRawEvent({ providerEventId: "li-001" });
  assert.equal(dedupTier(event), "provider-id");
});

test("dedup: no provider ID, non-empty evidence → tier is 'content-fingerprint'", () => {
  const event = makeRawEvent({ providerEventId: undefined });
  assert.equal(dedupTier(event), "content-fingerprint");
});

test("dedup: no provider ID, empty evidence → tier is 'none'", () => {
  const event = makeRawEvent({ providerEventId: undefined, evidence: {} });
  assert.equal(dedupTier(event), "none");
});

// ── signal-dedup: key computation ─────────────────────────────────────────────

test("dedup: provider-ID key is non-null hex string", () => {
  const event = makeRawEvent({ providerEventId: "li-001" });
  const key = computeDedupKey(COMPANY_A, event);
  assert.ok(key !== null);
  assert.match(key!, /^[0-9a-f]{64}$/);
});

test("dedup: same provider ID → same key (deterministic)", () => {
  const event = makeRawEvent({ providerEventId: "li-001" });
  const k1 = computeDedupKey(COMPANY_A, event);
  const k2 = computeDedupKey(COMPANY_A, event);
  assert.equal(k1, k2);
});

test("dedup: different provider IDs → different keys", () => {
  const e1 = makeRawEvent({ providerEventId: "li-001" });
  const e2 = makeRawEvent({ providerEventId: "li-002" });
  assert.notEqual(computeDedupKey(COMPANY_A, e1), computeDedupKey(COMPANY_A, e2));
});

test("dedup: content fingerprint is non-null when evidence is non-empty", () => {
  const event = makeRawEvent({ providerEventId: undefined });
  const key = computeDedupKey(COMPANY_A, event);
  assert.ok(key !== null);
  assert.match(key!, /^[0-9a-f]{64}$/);
});

test("dedup: identical evidence → same content-fingerprint key", () => {
  const e1 = makeRawEvent({ providerEventId: undefined });
  const e2 = makeRawEvent({ providerEventId: undefined });
  assert.equal(computeDedupKey(COMPANY_A, e1), computeDedupKey(COMPANY_A, e2));
});

test("dedup: evidence key order does not affect content-fingerprint (stable sort)", () => {
  // { a: 1, b: 2 } and { b: 2, a: 1 } must produce the same key
  const e1 = makeRawEvent({ evidence: { a: 1, b: 2 }, providerEventId: undefined });
  const e2 = makeRawEvent({ evidence: { b: 2, a: 1 }, providerEventId: undefined });
  assert.equal(computeDedupKey(COMPANY_A, e1), computeDedupKey(COMPANY_A, e2));
});

test("dedup: different evidence → different content-fingerprint keys (two distinct events same day)", () => {
  // VP Sales hire and VP Engineering hire on the same day — must NOT collide
  const vpSales = makeRawEvent({
    providerEventId: undefined,
    evidence: { event: "new_executive_hire", role: "VP Sales", name: "Alex Doe" },
    occurredAt: "2026-09-01T09:00:00.000Z",
  });
  const vpEng = makeRawEvent({
    providerEventId: undefined,
    evidence: { event: "new_executive_hire", role: "VP Engineering", name: "Sam Okafor" },
    occurredAt: "2026-09-01T14:00:00.000Z",
  });
  assert.notEqual(
    computeDedupKey(COMPANY_A, vpSales),
    computeDedupKey(COMPANY_A, vpEng),
    "Two different hires on the same day must have different dedup keys",
  );
});

test("dedup: content-fingerprint key differs by companyId", () => {
  const event = makeRawEvent({ providerEventId: undefined });
  assert.notEqual(
    computeDedupKey(COMPANY_A, event),
    computeDedupKey(COMPANY_B, event),
  );
});

test("dedup: content-fingerprint key differs by signal type", () => {
  const e1 = makeRawEvent({ providerEventId: undefined, signalType: "executive_hire" });
  const e2 = makeRawEvent({ providerEventId: undefined, signalType: "funding_round" });
  assert.notEqual(computeDedupKey(COMPANY_A, e1), computeDedupKey(COMPANY_A, e2));
});

test("dedup: content-fingerprint key differs by source", () => {
  const e1 = makeRawEvent({ providerEventId: undefined, source: "linkedin" });
  const e2 = makeRawEvent({ providerEventId: undefined, source: "crunchbase" });
  assert.notEqual(computeDedupKey(COMPANY_A, e1), computeDedupKey(COMPANY_A, e2));
});

test("dedup: null key when evidence is empty and no provider ID", () => {
  const event = makeRawEvent({ providerEventId: undefined, evidence: {} });
  assert.equal(computeDedupKey(COMPANY_A, event), null);
});

test("dedup: provider-ID key is independent of companyId", () => {
  // Same provider event affecting two different companies → same key (provider owns identity)
  const event = makeRawEvent({ providerEventId: "li-001" });
  assert.equal(
    computeDedupKey(COMPANY_A, event),
    computeDedupKey(COMPANY_B, event),
  );
});

// ── signal-freshness: TTL and expires_at ──────────────────────────────────────

test("freshness: getTtlDays returns positive integer for every signal type", () => {
  const types = [
    "executive_hire", "funding_round", "job_posting", "news_mention",
    "website_change", "product_launch", "partnership", "technology_change",
    "competitor_mention", "award", "expansion", "test",
  ] as const;
  for (const t of types) {
    const ttl = getTtlDays(t);
    assert.ok(Number.isInteger(ttl) && ttl > 0, `TTL for ${t} must be a positive integer, got ${ttl}`);
  }
});

test("freshness: computeExpiresAt adds correct TTL for executive_hire (30d)", () => {
  const occurred = "2026-09-01T00:00:00.000Z";
  const expires = computeExpiresAt(occurred, "executive_hire");
  const diff = new Date(expires).getTime() - new Date(occurred).getTime();
  assert.equal(diff, 30 * 24 * 60 * 60 * 1000);
});

test("freshness: computeExpiresAt adds correct TTL for funding_round (90d)", () => {
  const occurred = "2026-06-01T00:00:00.000Z";
  const expires = computeExpiresAt(occurred, "funding_round");
  const diff = new Date(expires).getTime() - new Date(occurred).getTime();
  assert.equal(diff, 90 * 24 * 60 * 60 * 1000);
});

test("freshness: computeExpiresAt throws on invalid occurred_at", () => {
  assert.throws(
    () => computeExpiresAt("not-a-date", "executive_hire"),
    /Invalid occurredAt/,
  );
});

test("freshness: score is 100 when now equals occurred_at", () => {
  const t = "2026-09-01T00:00:00.000Z";
  const expires = computeExpiresAt(t, "test"); // 7-day TTL
  const score = computeFreshnessScore(t, expires, new Date(t));
  assert.equal(score, 100);
});

test("freshness: score is 0 when now equals expires_at", () => {
  const occurred = "2026-09-01T00:00:00.000Z";
  const expires = computeExpiresAt(occurred, "test");
  const score = computeFreshnessScore(occurred, expires, new Date(expires));
  assert.equal(score, 0);
});

test("freshness: score is 0 when now is after expires_at (stale signal)", () => {
  const occurred = "2026-08-01T00:00:00.000Z";
  const expires = computeExpiresAt(occurred, "test"); // 7-day TTL, expired Aug 8
  const now = new Date("2026-09-01T00:00:00.000Z"); // 31 days later
  const score = computeFreshnessScore(occurred, expires, now);
  assert.equal(score, 0);
});

test("freshness: score is 100 when now is before occurred_at (future event)", () => {
  const occurred = "2026-12-01T00:00:00.000Z";
  const expires = computeExpiresAt(occurred, "test");
  const now = new Date("2026-09-01T00:00:00.000Z");
  const score = computeFreshnessScore(occurred, expires, now);
  assert.equal(score, 100);
});

test("freshness: score is between 0 and 100 midway through TTL", () => {
  // Halfway through a 7-day window → ~50%
  const occurred = "2026-09-01T00:00:00.000Z";
  const expires = computeExpiresAt(occurred, "test");
  const halfwayMs =
    new Date(occurred).getTime() +
    (new Date(expires).getTime() - new Date(occurred).getTime()) / 2;
  const score = computeFreshnessScore(occurred, expires, new Date(halfwayMs));
  assert.ok(score > 0 && score <= 100, `Expected score between 1 and 100, got ${score}`);
  // Should be roughly 50 — floor means it could be 49 or 50
  assert.ok(Math.abs(score - 50) <= 1, `Expected score near 50, got ${score}`);
});

test("freshness: isExpired is false for fresh signal", () => {
  const expires = computeExpiresAt("2026-09-01T00:00:00.000Z", "funding_round");
  assert.equal(isExpired(expires, FIXED_NOW), false);
});

test("freshness: isExpired is true for stale signal", () => {
  const expires = computeExpiresAt("2026-08-01T00:00:00.000Z", "test"); // 7-day TTL, expired Aug 8
  assert.equal(isExpired(expires, FIXED_NOW), true);
});

// ── signal-strength ───────────────────────────────────────────────────────────

test("strength: funding_round has highest base strength (90)", () => {
  assert.equal(computeSignalStrength("funding_round"), 90);
});

test("strength: executive_hire has strength 75", () => {
  assert.equal(computeSignalStrength("executive_hire"), 75);
});

test("strength: website_change has lowest strength (35)", () => {
  assert.equal(computeSignalStrength("website_change"), 35);
});

test("strength: all signal types return a value between 0 and 100", () => {
  const types = [
    "executive_hire", "funding_round", "job_posting", "news_mention",
    "website_change", "product_launch", "partnership", "technology_change",
    "competitor_mention", "award", "expansion", "test",
  ] as const;
  for (const t of types) {
    const s = computeSignalStrength(t);
    assert.ok(s >= 0 && s <= 100, `Strength for ${t} out of range: ${s}`);
  }
});

test("strength: actionability score is product of strength and freshness divided by 100", () => {
  // 75 strength × 80 freshness / 100 = 60
  assert.equal(computeActionabilityScore(75, 80), 60);
});

test("strength: actionability score rounds correctly", () => {
  // 75 × 53 / 100 = 39.75 → rounds to 40
  assert.equal(computeActionabilityScore(75, 53), 40);
});

test("strength: actionability score clamps to 0 when freshness is 0", () => {
  assert.equal(computeActionabilityScore(90, 0), 0);
});

test("strength: actionability score clamps to signal strength when freshness is 100", () => {
  assert.equal(computeActionabilityScore(90, 100), 90);
});

test("strength: defaultConfidence is 0.800 for provider-id tier", () => {
  assert.equal(defaultConfidence("provider-id"), 0.800);
});

test("strength: defaultConfidence is 0.600 for content-fingerprint tier", () => {
  assert.equal(defaultConfidence("content-fingerprint"), 0.600);
});

test("strength: defaultConfidence is 0.500 for none tier", () => {
  assert.equal(defaultConfidence("none"), 0.500);
});

test("strength: validateConfidence clamps value above 1 to 1.000", () => {
  assert.equal(validateConfidence(1.5), 1.000);
});

test("strength: validateConfidence clamps negative value to 0.000", () => {
  assert.equal(validateConfidence(-0.5), 0.000);
});

test("strength: validateConfidence accepts 0", () => {
  assert.equal(validateConfidence(0), 0.000);
});

test("strength: validateConfidence accepts 1", () => {
  assert.equal(validateConfidence(1), 1.000);
});

test("strength: validateConfidence rounds to 3 decimal places", () => {
  // 0.7999999 → 0.800
  assert.equal(validateConfidence(0.7999999), 0.800);
});

test("strength: validateConfidence throws on NaN", () => {
  assert.throws(() => validateConfidence(NaN), /finite/);
});

test("strength: validateConfidence throws on Infinity", () => {
  assert.throws(() => validateConfidence(Infinity), /finite/);
});

// ── normalizer ────────────────────────────────────────────────────────────────

test("normalizer: signalType is preserved", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.signalType, "executive_hire");
});

test("normalizer: signalSource is set from raw event source", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.signalSource, "test");
});

test("normalizer: signalTitle is set from raw event title", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.signalTitle, "New VP of Sales");
});

test("normalizer: signalDescription is set from raw event description", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.signalDescription, "Hired a VP of Sales 5 days ago");
});

test("normalizer: signalDescription is null when description is absent", () => {
  const s = normalizeEvent(makeProviderEvent(COMPANY_A, CLIENT_A, { description: undefined }), DETECTED_AT);
  assert.equal(s.signalDescription, null);
});

test("normalizer: evidence is preserved from raw event", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.deepEqual(s.evidence, {
    event: "new_executive_hire",
    role: "VP Sales",
    name: "Alex Doe",
  });
});

test("normalizer: clientId is preserved", () => {
  const s = normalizeEvent(makeProviderEvent(COMPANY_A, CLIENT_A), DETECTED_AT);
  assert.equal(s.clientId, CLIENT_A);
});

test("normalizer: companyId is preserved", () => {
  const s = normalizeEvent(makeProviderEvent(COMPANY_A), DETECTED_AT);
  assert.equal(s.companyId, COMPANY_A);
});

test("normalizer: detectedAt matches the passed-in timestamp", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.detectedAt, DETECTED_AT);
});

test("normalizer: occurredAt matches raw event occurredAt", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.occurredAt, "2026-08-27T10:00:00.000Z");
});

test("normalizer: expiresAt is 30 days after occurredAt for executive_hire", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  const expected = computeExpiresAt("2026-08-27T10:00:00.000Z", "executive_hire");
  assert.equal(s.expiresAt, expected);
});

test("normalizer: signalStrength is 75 for executive_hire", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.signalStrength, 75);
});

test("normalizer: status is 'active' for a new signal", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.status, "active");
});

test("normalizer: sourceUrl is null when absent", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.sourceUrl, null);
});

test("normalizer: sourceUrl is preserved when present", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, {
    sourceUrl: "https://linkedin.com/posts/example",
  });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.sourceUrl, "https://linkedin.com/posts/example");
});

test("normalizer: metadata is null when absent", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.equal(s.metadata, null);
});

test("normalizer: confidence uses provider value when supplied", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, { confidence: 0.9 });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.confidence, 0.900);
});

test("normalizer: confidence defaults to 0.800 when provider ID present and no confidence given", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, {
    providerEventId: "li-001",
    confidence: undefined,
  });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.confidence, 0.800);
});

test("normalizer: confidence defaults to 0.600 when using content fingerprint", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, {
    providerEventId: undefined,
    confidence: undefined,
  });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.confidence, 0.600);
});

test("normalizer: confidence defaults to 0.500 when no fingerprint possible", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, {
    providerEventId: undefined,
    evidence: {},
    confidence: undefined,
  });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.confidence, 0.500);
});

test("normalizer: dedupKey is non-null when evidence is non-empty", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  assert.ok(s.dedupKey !== null);
});

test("normalizer: dedupKey is null when evidence empty and no provider ID", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, {
    providerEventId: undefined,
    evidence: {},
  });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.dedupKey, null);
});

test("normalizer: throws on invalid occurredAt", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, { occurredAt: "not-a-date" });
  assert.throws(() => normalizeEvent(ev, DETECTED_AT), /Invalid occurredAt/);
});

test("normalizer: two events for same company same type same day with different evidence get different dedup keys", () => {
  const vpSales = makeProviderEvent(COMPANY_A, CLIENT_A, {
    providerEventId: undefined,
    evidence: { event: "new_executive_hire", role: "VP Sales", name: "Alex Doe" },
  });
  const vpEng = makeProviderEvent(COMPANY_A, CLIENT_A, {
    providerEventId: undefined,
    evidence: { event: "new_executive_hire", role: "VP Engineering", name: "Sam Okafor" },
  });
  const s1 = normalizeEvent(vpSales, DETECTED_AT);
  const s2 = normalizeEvent(vpEng, DETECTED_AT);
  assert.notEqual(s1.dedupKey, s2.dedupKey);
});

test("normalizer: two identical events produce the same dedup key", () => {
  const ev = makeProviderEvent();
  const s1 = normalizeEvent(ev, DETECTED_AT);
  const s2 = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s1.dedupKey, s2.dedupKey);
});

// ── normalizer: tenant isolation ──────────────────────────────────────────────

test("normalizer: same event for two different clients produces different clientId on each signal", () => {
  const ev1 = makeProviderEvent(COMPANY_A, CLIENT_A);
  const ev2 = makeProviderEvent(COMPANY_A, CLIENT_B);
  const s1 = normalizeEvent(ev1, DETECTED_AT);
  const s2 = normalizeEvent(ev2, DETECTED_AT);
  assert.equal(s1.clientId, CLIENT_A);
  assert.equal(s2.clientId, CLIENT_B);
  // Both signals can exist independently — clientId scopes tenant isolation
  assert.equal(s1.companyId, s2.companyId);
});

test("normalizer: signals for different companies have different companyId", () => {
  const ev1 = makeProviderEvent(COMPANY_A, CLIENT_A);
  const ev2 = makeProviderEvent(COMPANY_B, CLIENT_A);
  const s1 = normalizeEvent(ev1, DETECTED_AT);
  const s2 = normalizeEvent(ev2, DETECTED_AT);
  assert.notEqual(s1.companyId, s2.companyId);
});

// ── normalizer: multiple signals for one company ───────────────────────────────

test("normalizer: batch normalizes multiple signals for one company", () => {
  const events: SignalProviderEvent[] = [
    makeProviderEvent(COMPANY_A, CLIENT_A, {
      signalType: "executive_hire",
      evidence: { role: "VP Sales", name: "Alex Doe" },
    }),
    makeProviderEvent(COMPANY_A, CLIENT_A, {
      signalType: "funding_round",
      evidence: { round: "Series A", amount_usd: 5_000_000 },
      occurredAt: "2026-08-20T00:00:00.000Z",
    }),
  ];
  const outcomes = normalizeBatch(events, DETECTED_AT);
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every((o) => o.ok === true));
  const signals = outcomes.filter((o) => o.ok).map((o) => (o as { ok: true; signal: ReturnType<typeof normalizeEvent> }).signal);
  assert.equal(signals[0].signalType, "executive_hire");
  assert.equal(signals[1].signalType, "funding_round");
  assert.equal(signals[0].companyId, COMPANY_A);
  assert.equal(signals[1].companyId, COMPANY_A);
});

test("normalizer: batch continues on error, returning ok:false for bad events", () => {
  const events: SignalProviderEvent[] = [
    makeProviderEvent(COMPANY_A, CLIENT_A, { occurredAt: "bad-date" }),
    makeProviderEvent(COMPANY_B, CLIENT_A),
  ];
  const outcomes = normalizeBatch(events, DETECTED_AT);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].ok, false);
  assert.equal(outcomes[1].ok, true);
});

// ── fake-provider ─────────────────────────────────────────────────────────────

test("fake-provider: isConfigured() always returns true", () => {
  const p = new FakeSignalProvider();
  assert.equal(p.isConfigured(), true);
});

test("fake-provider: id is 'test'", () => {
  assert.equal(new FakeSignalProvider().id, "test");
});

test("fake-provider: returns one event per company per scenario", async () => {
  const p = new FakeSignalProvider();
  const batch = await p.fetchEvents(
    [COMPANY_A, COMPANY_B],
    CLIENT_A,
    { scenarios: ["test_signal_with_provider_id"] },
  );
  assert.equal(batch.events.length, 2);
});

test("fake-provider: returns correct companyId on each event", async () => {
  const p = new FakeSignalProvider();
  const batch = await p.fetchEvents([COMPANY_A], CLIENT_A, {
    scenarios: ["test_signal_with_provider_id"],
  });
  assert.equal(batch.events[0].companyId, COMPANY_A);
  assert.equal(batch.events[0].clientId, CLIENT_A);
});

test("fake-provider: executive_hire_vp_sales scenario produces executive_hire type", async () => {
  const p = new FakeSignalProvider();
  const batch = await p.fetchEvents([COMPANY_A], CLIENT_A, {
    scenarios: ["executive_hire_vp_sales"],
  });
  assert.equal(batch.events[0].rawEvent.signalType, "executive_hire");
});

test("fake-provider: limit caps total events returned", async () => {
  const p = new FakeSignalProvider();
  const batch = await p.fetchEvents(
    [COMPANY_A, COMPANY_B],
    CLIENT_A,
    {
      scenarios: ["test_signal_with_provider_id", "test_signal_fingerprint_only"],
      limit: 1,
    },
  );
  assert.equal(batch.events.length, 1);
});

test("fake-provider: asOf controls occurred_at offset", async () => {
  const asOf = new Date("2026-06-01T00:00:00.000Z");
  const p = new FakeSignalProvider();
  const batch = await p.fetchEvents([COMPANY_A], CLIENT_A, {
    scenarios: ["executive_hire_vp_sales"], // 5 days ago
    asOf,
  });
  const expected = new Date(asOf.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(batch.events[0].rawEvent.occurredAt, expected);
});

test("fake-provider: unknown scenario throws descriptive error", async () => {
  const p = new FakeSignalProvider();
  await assert.rejects(
    () => p.fetchEvents([COMPANY_A], CLIENT_A, { scenarios: ["nonexistent_scenario"] }),
    /Unknown fake scenario/,
  );
});

test("fake-provider: availableScenarios() returns all scenario names", () => {
  const names = FakeSignalProvider.availableScenarios();
  assert.ok(names.includes("executive_hire_vp_sales"));
  assert.ok(names.includes("funding_series_a"));
  assert.ok(names.includes("test_signal_with_provider_id"));
  assert.ok(names.length === Object.keys(FAKE_SCENARIOS).length);
});

test("fake-provider: test_signal_no_evidence produces empty evidence (tier-3)", async () => {
  const p = new FakeSignalProvider();
  const batch = await p.fetchEvents([COMPANY_A], CLIENT_A, {
    scenarios: ["test_signal_no_evidence"],
  });
  assert.deepEqual(batch.events[0].rawEvent.evidence, {});
});

test("fake-provider: stale scenario normalizes with isExpired=true", async () => {
  const asOf = new Date("2026-09-01T00:00:00.000Z");
  const p = new FakeSignalProvider();
  const batch = await p.fetchEvents([COMPANY_A], CLIENT_A, {
    scenarios: ["test_signal_stale"],
    asOf,
  });
  const signal = normalizeEvent(batch.events[0], DETECTED_AT);
  // test TTL=7d, event was 9 days ago → already expired
  assert.equal(isExpired(signal.expiresAt, asOf), true);
  assert.equal(computeFreshnessScore(signal.occurredAt, signal.expiresAt, asOf), 0);
});

// ── db row-builders: round-trip ───────────────────────────────────────────────

test("db: buildSignalRow maps all fields to snake_case", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  const row = buildSignalRow(s);
  assert.equal(row.client_id, CLIENT_A);
  assert.equal(row.company_id, COMPANY_A);
  assert.equal(row.signal_type, "executive_hire");
  assert.equal(row.signal_source, "test");
  assert.equal(row.signal_title, "New VP of Sales");
  assert.equal(row.signal_description, "Hired a VP of Sales 5 days ago");
  assert.equal(row.signal_strength, 75);
  assert.equal(row.status, "active");
  assert.ok(row.dedup_key !== null);
});

test("db: fromDbRow maps snake_case DB row back to camelCase SignalRow", () => {
  const s = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  const row = buildSignalRow(s);
  const dbRow: Record<string, unknown> = {
    ...row,
    id: "test-uuid-123",
    created_at: DETECTED_AT,
  };
  const back = fromDbRow(dbRow);
  assert.equal(back.id, "test-uuid-123");
  assert.equal(back.clientId, CLIENT_A);
  assert.equal(back.companyId, COMPANY_A);
  assert.equal(back.signalType, "executive_hire");
  assert.equal(back.signalStrength, 75);
  assert.equal(back.status, "active");
  assert.equal(back.createdAt, DETECTED_AT);
});

test("db: round-trip preserves all fields", () => {
  const original = normalizeEvent(makeProviderEvent(COMPANY_A, CLIENT_A, {
    providerEventId: "li-001",
    sourceUrl: "https://example.com",
    metadata: { extra: "value" },
    confidence: 0.95,
  }), DETECTED_AT);
  const row = buildSignalRow(original);
  const dbRow: Record<string, unknown> = { ...row, id: "abc", created_at: DETECTED_AT };
  const back = fromDbRow(dbRow);
  assert.equal(back.confidence, 0.950);
  assert.equal(back.sourceUrl, "https://example.com");
  assert.deepEqual(back.metadata, { extra: "value" });
  assert.equal(back.signalDescription, original.signalDescription);
  assert.equal(back.expiresAt, original.expiresAt);
});

test("db: fromDbRow handles null optional fields gracefully", () => {
  const row: Record<string, unknown> = {
    id: "abc",
    client_id: CLIENT_A,
    company_id: COMPANY_A,
    signal_type: "test",
    signal_source: "test",
    signal_title: "Test",
    signal_description: null,
    evidence: {},
    signal_strength: 50,
    confidence: "0.500",
    occurred_at: "2026-09-01T00:00:00.000Z",
    detected_at: "2026-09-01T00:00:00.000Z",
    expires_at: "2026-09-08T00:00:00.000Z",
    source_url: null,
    status: "active",
    metadata: null,
    dedup_key: null,
    created_at: "2026-09-01T00:00:00.000Z",
  };
  const back = fromDbRow(row);
  assert.equal(back.signalDescription, null);
  assert.equal(back.sourceUrl, null);
  assert.equal(back.metadata, null);
  assert.equal(back.dedupKey, null);
});

// ── confidence boundaries ─────────────────────────────────────────────────────

test("confidence: value of exactly 0 is valid", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, { confidence: 0 });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.confidence, 0.000);
});

test("confidence: value of exactly 1 is valid", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, { confidence: 1 });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.confidence, 1.000);
});

test("confidence: value above 1 is clamped to 1.000", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, { confidence: 1.5 });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.confidence, 1.000);
});

test("confidence: negative value is clamped to 0.000", () => {
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, { confidence: -0.1 });
  const s = normalizeEvent(ev, DETECTED_AT);
  assert.equal(s.confidence, 0.000);
});

// ── signal-strength boundaries ────────────────────────────────────────────────

test("strength: all base strengths are in range [0, 100]", () => {
  const types = [
    "executive_hire", "funding_round", "job_posting", "news_mention",
    "website_change", "product_launch", "partnership", "technology_change",
    "competitor_mention", "award", "expansion", "test",
  ] as const;
  for (const t of types) {
    const s = computeSignalStrength(t);
    assert.ok(s >= 0 && s <= 100);
  }
});

test("strength: actionability(100, 100) equals 100", () => {
  assert.equal(computeActionabilityScore(100, 100), 100);
});

test("strength: actionability(0, 0) equals 0", () => {
  assert.equal(computeActionabilityScore(0, 0), 0);
});

// ── serialization/deserialization ─────────────────────────────────────────────

test("serialization: normalized signal can be JSON round-tripped", () => {
  const original = normalizeEvent(makeProviderEvent(), DETECTED_AT);
  const json = JSON.stringify(original);
  const parsed = JSON.parse(json);
  assert.equal(parsed.signalType, original.signalType);
  assert.equal(parsed.signalStrength, original.signalStrength);
  assert.equal(parsed.confidence, original.confidence);
  assert.deepEqual(parsed.evidence, original.evidence);
});

test("serialization: DB row with JSONB evidence round-trips correctly", () => {
  const evidence = { nested: { a: 1 }, arr: [1, 2, 3] };
  const ev = makeProviderEvent(COMPANY_A, CLIENT_A, { evidence });
  const s = normalizeEvent(ev, DETECTED_AT);
  const row = buildSignalRow(s);
  // Simulate Supabase JSONB parse (JSON stringify + parse)
  const serialized = JSON.parse(JSON.stringify(row));
  const back = fromDbRow({ ...serialized, id: "x", created_at: DETECTED_AT });
  assert.deepEqual(back.evidence, evidence);
});
