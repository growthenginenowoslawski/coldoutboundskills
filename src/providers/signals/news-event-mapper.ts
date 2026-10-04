/**
 * PredictLeads news_events → canonical signal mapper — Stage 30C.3.
 *
 * Pure, offline, deterministic. No network, no DB, no env reads, no clock
 * reads (callers pass `now`). Nothing here is registered with the signal
 * provider registry or called by PredictLeadsSignalProvider.fetchEvents, so
 * importing this module cannot trigger an API request.
 *
 * ── Category → signal type (INITIAL_HYPOTHESIS_NOT_VALIDATED) ────────────────
 *
 *   acquisition / acquires              → expansion
 *   expansion / expands_offices_to /
 *     opens_new_location                → expansion
 *   product_launch / launches           → product_launch
 *   partnership / partners_with         → partnership
 *   award / receives_award              → award
 *   anything else (incl. unknown, null) → news_mention
 *
 * Executive hires are deliberately NOT mapped to `executive_hire`: whether
 * PredictLeads indexes them consistently for UK SME agencies is unvalidated
 * (Stage 30B §7), so they fall through to the weak `news_mention` type. The
 * original category is always preserved in evidence for later re-mapping.
 *
 * Scoring weights, TTLs and the dedup tiers are untouched: this module only
 * emits RawSignalEvent / SignalProviderEvent, which the existing normalizer
 * scores and expires.
 *
 * ── Tenant isolation ─────────────────────────────────────────────────────────
 * companyId and clientId come only from the caller's context and are copied
 * onto every emitted event. Nothing in a provider record can override them.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────────
 * Records with an id emit providerEventId (dedup tier 1, stable across runs).
 * Records without one emit none (tier 2 content fingerprint). Duplicates
 * inside one response are collapsed here and counted, first occurrence wins.
 */

import type {
  RawSignalEvent,
  SignalProviderEvent,
  SignalType,
} from "../../domain/signal-types";

// ── Provider record shapes (deliberately loose — input is untrusted) ─────────

export interface NewsEventRecord {
  id?: unknown;
  type?: unknown;
  attributes?: unknown;
}

export interface NewsEventContext {
  /** Our internal company UUID. */
  companyId: string;
  /** Tenant. Copied verbatim onto every event. */
  clientId: string;
  /** Bare domain the response was requested for. */
  domain: string;
  /** Provider name recorded as the signal source. */
  source: string;
  /** Only keep events first found at/after this ISO timestamp. */
  since?: string | null;
  /** Reference "now" for the future-date guard. Pass explicitly in tests. */
  now?: string;
}

export type NewsSkipReason =
  | "not_an_object"
  | "missing_attributes"
  | "missing_summary"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "future_timestamp"
  | "before_since"
  | "duplicate";

export type NewsMapOutcome =
  | { ok: true; event: RawSignalEvent }
  | { ok: false; reason: NewsSkipReason };

export interface NewsBatchResult {
  events: SignalProviderEvent[];
  skipped: { id: string | null; reason: NewsSkipReason }[];
  /** Set when the response body as a whole was unusable. */
  responseError?: "malformed_response" | "data_not_array";
}

// ── Constants ────────────────────────────────────────────────────────────────

const TITLE_MAX = 120;
/** Events dated more than this far past `now` are treated as bad data. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

const CATEGORY_TO_SIGNAL: Readonly<Record<string, SignalType>> = {
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

// ── Category mapping ─────────────────────────────────────────────────────────

/** Case/whitespace/hyphen-insensitive category → signal type. */
export function mapNewsCategory(category: unknown): SignalType {
  const key = asString(category)?.toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return "news_mention";
  return CATEGORY_TO_SIGNAL[key] ?? "news_mention";
}

// ── Single-record mapper ─────────────────────────────────────────────────────

export function mapNewsEventRecord(record: unknown, ctx: NewsEventContext): NewsMapOutcome {
  if (!isObject(record)) return { ok: false, reason: "not_an_object" };
  const attrs = record.attributes;
  if (!isObject(attrs)) return { ok: false, reason: "missing_attributes" };

  const summary = asString(attrs.summary);
  if (!summary) return { ok: false, reason: "missing_summary" };

  const foundAtRaw = asString(attrs.found_at);
  const publishedRaw = asString(attrs.published_at);
  const occurredRaw = publishedRaw ?? foundAtRaw;
  if (!occurredRaw) return { ok: false, reason: "missing_timestamp" };

  const occurredAt = toIso(occurredRaw);
  if (!occurredAt) return { ok: false, reason: "invalid_timestamp" };
  // found_at is provenance only; a bad value there must not drop the event.
  const foundAt = foundAtRaw ? toIso(foundAtRaw) : null;

  const nowMs = Date.parse(ctx.now ?? new Date().toISOString());
  if (Date.parse(occurredAt) > nowMs + FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: "future_timestamp" };
  }

  if (ctx.since) {
    const sinceMs = Date.parse(ctx.since);
    const detectedMs = Date.parse(foundAt ?? occurredAt);
    if (!Number.isNaN(sinceMs) && detectedMs < sinceMs) {
      return { ok: false, reason: "before_since" };
    }
  }

  const category = asString(attrs.category);
  const signalType = mapNewsCategory(category);
  const id = asString(record.id);
  const url = asString(attrs.url) ?? asString(attrs.source_url);
  const confidence = asUnitInterval(attrs.confidence);

  const evidence: Record<string, unknown> = {
    event: "news_event",
    summary,
    domain: ctx.domain,
    provider_record_id: id,
  };
  if (category) evidence.category = category;

  const event: RawSignalEvent = {
    source: ctx.source,
    signalType,
    title: summary.slice(0, TITLE_MAX),
    evidence,
    occurredAt,
    metadata: {
      module: "news_events",
      found_at: foundAt,
      published_at: publishedRaw ? toIso(publishedRaw) : null,
    },
  };
  if (id) event.providerEventId = id;
  if (url) event.sourceUrl = url;
  if (confidence != null) event.confidence = confidence;
  if (summary.length > TITLE_MAX) event.description = summary;

  return { ok: true, event };
}

// ── Response mapper ──────────────────────────────────────────────────────────

/**
 * Maps a whole news_events response body (JSON:API `{ data: [...] }`) for one
 * company. Never throws: malformed input yields an empty result with
 * `responseError` set; bad records are reported in `skipped`.
 */
export function mapNewsEventsResponse(body: unknown, ctx: NewsEventContext): NewsBatchResult {
  const result: NewsBatchResult = { events: [], skipped: [] };

  if (!isObject(body)) {
    result.responseError = "malformed_response";
    return result;
  }
  if (!Array.isArray(body.data)) {
    // A missing `data` key is an empty response, not an error.
    if (body.data !== undefined && body.data !== null) result.responseError = "data_not_array";
    return result;
  }

  const seen = new Set<string>();
  for (const record of body.data) {
    const outcome = mapNewsEventRecord(record, ctx);
    const id = isObject(record) ? asString(record.id) : null;
    if (!outcome.ok) {
      result.skipped.push({ id, reason: outcome.reason });
      continue;
    }

    const key = id ? `id:${id}` : `fp:${outcome.event.signalType}:${outcome.event.occurredAt}:${outcome.event.title}`;
    if (seen.has(key)) {
      result.skipped.push({ id, reason: "duplicate" });
      continue;
    }
    seen.add(key);

    result.events.push({
      companyId: ctx.companyId,
      clientId: ctx.clientId,
      rawEvent: outcome.event,
    });
  }

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function asUnitInterval(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

/**
 * Strict-ish ISO normalisation. Accepts YYYY-MM-DD (→ midnight UTC) and full
 * ISO 8601 with Z or an offset; rejects anything else (including bare
 * "July 2026" strings that Date.parse would guess at). Returns UTC ISO.
 */
function toIso(raw: string): string | null {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const isDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (!isDateOnly && !isDateTime) return null;
  const ms = Date.parse(isDateOnly ? `${raw}T00:00:00.000Z` : raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
