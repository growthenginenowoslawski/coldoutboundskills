/**
 * PredictLeads signal provider — Stage 11.
 *
 * Fetches real buying-intent signals from the PredictLeads API v3 and maps
 * them into the existing RawSignalEvent / RawEventBatch format without
 * modifying the SignalProvider interface.
 *
 * ── Signal types supported in Stage 11 ───────────────────────────────────────
 *
 *   job_posting     ← PredictLeads /companies/{domain}/job_openings
 *   funding_round   ← PredictLeads /companies/{domain}/financing_events
 *
 * news_events, technology_detections, and other modules are intentionally
 * deferred: news_events require a complex category → SignalType mapping that
 * should be designed carefully; technology_detections have ambiguous signal
 * strength mapping. Add them in a future stage.
 *
 * ── Authentication ────────────────────────────────────────────────────────────
 *
 *   Both PREDICTLEADS_API_KEY and PREDICTLEADS_API_TOKEN are required.
 *   Sent as HTTP headers: X-Api-Key and X-Api-Token.
 *   Never logged. Never embedded in URLs.
 *
 *   Source: docs.predictleads.com — "With HTTP headers" authentication.
 *
 * ── Endpoint pattern (confirmed) ─────────────────────────────────────────────
 *
 *   GET https://predictleads.com/api/v3/companies/{domain}/{module}
 *   Example: GET https://predictleads.com/api/v3/companies/nvidia.com/job_openings
 *
 * ── Incremental polling ───────────────────────────────────────────────────────
 *
 *   PredictLeads does not expose a server-side date filter on the per-company
 *   endpoints. Filtering is applied client-side on first_seen_at (the timestamp
 *   when PredictLeads first detected the event). This means:
 *   - Old events still in PredictLeads' index but already in our DB are caught
 *     by the 3-tier dedup (provider ID = PredictLeads record UUID).
 *   - New events PredictLeads recently indexed pass the since filter.
 *   - The since cursor lives in the Trigger.dev task (MAX occurred_at from DB).
 *
 * ── Reliability ───────────────────────────────────────────────────────────────
 *
 *   429 → read Retry-After, sleep, retry ONCE; let Trigger.dev handle the rest.
 *   4xx → throw PredictLeadsApiError (caught per-company in fetchEvents loop).
 *   5xx → throw PredictLeadsApiError (caught per-company, Trigger.dev retries task).
 *   Timeout → AbortSignal.timeout(15 s).
 *   Malformed JSON → JSON.parse throws, caught per-company.
 *   Empty response → returned as 0 events, not an error.
 *
 * ── Tenant isolation ──────────────────────────────────────────────────────────
 *
 *   clientId is threaded from the caller through every RawEventBatch event.
 *   The provider never reads or modifies client state.
 *
 * ── Data integrity ────────────────────────────────────────────────────────────
 *
 *   Evidence is preserved verbatim from the API response.
 *   No fields are fabricated.
 *   A signal is only emitted when the event has sufficient data to produce
 *   a usable RawSignalEvent (title, date, and at minimum one evidence field).
 */

import type { SignalProvider, FetchOptions } from "./types";
import type { RawSignalEvent, RawEventBatch } from "../../domain/signal-types";
import { ENV_KEYS, optionalEnv } from "../../config/env";

// ── PredictLeads-specific fetch options ───────────────────────────────────────

/**
 * Extended options for PredictLeadsSignalProvider.fetchEvents().
 *
 * companyDomains is required because PredictLeads identifies companies by
 * domain. The Trigger.dev task resolves our internal company UUIDs → bare
 * domains from the companies table, then passes them here.
 *
 * Extends FetchOptions without modifying the SignalProvider interface.
 */
export interface PredictLeadsFetchOptions extends FetchOptions {
  /**
   * Map of companyId (our UUID) → bare domain (e.g. "stripe.com").
   * Companies absent from this map are silently skipped.
   */
  companyDomains: Map<string, string>;
}

// ── PredictLeads API v3 types (JSON API format) ───────────────────────────────

interface PredictLeadsResponse {
  data?: PredictLeadsRecord[];
  meta?: {
    schema_version?: string;
    record_state?: string;
    count?: number;
  };
}

interface PredictLeadsRecord {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PL_BASE_URL = "https://predictleads.com/api/v3";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_WAIT_MS = 120_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

// ── Provider ──────────────────────────────────────────────────────────────────

export class PredictLeadsSignalProvider implements SignalProvider {
  readonly id = "predictleads";

  isConfigured(): boolean {
    return (
      optionalEnv(ENV_KEYS.predictleadsApiKey) !== undefined &&
      optionalEnv(ENV_KEYS.predictleadsApiToken) !== undefined
    );
  }

  async fetchEvents(
    companyIds: string[],
    clientId: string,
    opts: PredictLeadsFetchOptions,
  ): Promise<RawEventBatch> {
    const apiKey = optionalEnv(ENV_KEYS.predictleadsApiKey);
    const apiToken = optionalEnv(ENV_KEYS.predictleadsApiToken);

    if (!apiKey || !apiToken) {
      return {
        events: [],
        meta: { source: this.id, error: "not_configured", generatedAt: new Date().toISOString() },
      };
    }

    const auth = { apiKey, apiToken };
    const sinceDate = opts.since ?? null;
    const events: RawEventBatch["events"] = [];

    const meta: Record<string, unknown> = {
      source: this.id,
      generatedAt: new Date().toISOString(),
      companiesRequested: companyIds.length,
      sinceDate,
    };

    let companiesProcessed = 0;
    let companiesSkipped = 0;
    const perCompanyErrors: Record<string, string> = {};

    for (const companyId of companyIds) {
      if (opts.limit != null && events.length >= opts.limit) break;

      const domain = opts.companyDomains.get(companyId);
      if (!domain) {
        companiesSkipped++;
        continue;
      }

      try {
        const companyEvents = await this.fetchCompanyEvents(
          domain,
          companyId,
          clientId,
          sinceDate,
          auth,
          opts.limit != null ? opts.limit - events.length : undefined,
        );
        events.push(...companyEvents);
        companiesProcessed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        perCompanyErrors[companyId] = message;
      }
    }

    meta.companiesProcessed = companiesProcessed;
    meta.companiesSkipped = companiesSkipped;
    meta.eventsReturned = events.length;
    if (Object.keys(perCompanyErrors).length > 0) {
      meta.perCompanyErrors = perCompanyErrors;
    }

    return { events, meta };
  }

  // ── Private: per-company fetch ──────────────────────────────────────────────

  private async fetchCompanyEvents(
    domain: string,
    companyId: string,
    clientId: string,
    since: string | null,
    auth: { apiKey: string; apiToken: string },
    remaining?: number,
  ): Promise<RawEventBatch["events"]> {
    const events: RawEventBatch["events"] = [];

    const jobOpenings = await this.fetchModule(domain, "job_openings", auth);
    const financingEvents = await this.fetchModule(domain, "financing_events", auth);

    for (const record of jobOpenings) {
      if (remaining != null && events.length >= remaining) break;
      const raw = mapJobOpening(record, domain, this.id, since);
      if (raw) events.push({ companyId, clientId, rawEvent: raw });
    }

    for (const record of financingEvents) {
      if (remaining != null && events.length >= remaining) break;
      const raw = mapFinancingEvent(record, domain, this.id, since);
      if (raw) events.push({ companyId, clientId, rawEvent: raw });
    }

    return events;
  }

  /**
   * Paginate through a PredictLeads module endpoint for a single domain.
   * Stops when: last page returned fewer records than PAGE_SIZE, or MAX_PAGES reached.
   */
  private async fetchModule(
    domain: string,
    module: "job_openings" | "financing_events",
    auth: { apiKey: string; apiToken: string },
  ): Promise<PredictLeadsRecord[]> {
    const results: PredictLeadsRecord[] = [];
    const url = `${PL_BASE_URL}/companies/${encodeURIComponent(domain)}/${module}`;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const pageUrl = `${url}?page=${page}&per_page=${PAGE_SIZE}`;
      const resp = await this.fetchWithRetry(pageUrl, {
        method: "GET",
        headers: {
          "X-Api-Key": auth.apiKey,
          "X-Api-Token": auth.apiToken,
          Accept: "application/json",
        },
      });

      const body = (await resp.json()) as PredictLeadsResponse;
      const records = body.data ?? [];
      results.push(...records);

      if (records.length < PAGE_SIZE) break;
    }

    return results;
  }

  /**
   * Makes a fetch with a 15 s timeout and handles 429 with a single retry.
   * Throws PredictLeadsApiError on non-2xx responses.
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const resp = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (resp.status === 429) {
      const waitMs = parse429Wait(resp.headers.get("Retry-After"));
      await sleep(waitMs);
      const retry = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!retry.ok) {
        throw new PredictLeadsApiError(retry.status, await safeBodyText(retry), extractHeaders(retry.headers));
      }
      return retry;
    }

    if (!resp.ok) {
      throw new PredictLeadsApiError(resp.status, await safeBodyText(resp), extractHeaders(resp.headers));
    }

    return resp;
  }
}

// ── PredictLeads-specific error ───────────────────────────────────────────────

export class PredictLeadsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly responseHeaders: Record<string, string> = {},
  ) {
    super(`PredictLeads API error ${status}: ${body.slice(0, 400)}`);
    this.name = "PredictLeadsApiError";
  }
}

// ── Job posting classification ────────────────────────────────────────────────

export type JobClass =
  | "bd_commercial"
  | "senior_leadership"
  | "marketing_creative"
  | "tech_digital"
  | "talent_people"
  | "operations_delivery"
  | "general";

/**
 * Deterministic job-posting classifier for UK agency ICP signals.
 *
 * Priority order reflects ICP signal value for UK creative/agency targets:
 *   senior_leadership → bd_commercial → marketing_creative
 *   → tech_digital → talent_people → operations_delivery → general
 *
 * Pure function — no network calls, no DB reads, no side effects.
 * First-match wins; category takes precedence only when no title keyword fires.
 */
export function classifyJobPosting(
  title: string | null,
  category: string | null,
  seniority: string | null,
): JobClass {
  const t = (title ?? "").toLowerCase();
  const cat = (category ?? "").toLowerCase();
  const sen = (seniority ?? "").toLowerCase();

  if (
    sen === "c-suite" ||
    /\b(managing director|chief executive officer|chief operating officer|chief financial officer|co-founder|founder|managing partner)\b/.test(t) ||
    /\bceo\b|\bcoo\b|\bcfo\b|\bmd\b/.test(t)
  ) {
    return "senior_leadership";
  }

  if (
    cat === "sales" ||
    /\b(business development director|commercial director|sales director|head of sales|head of business development|business development manager|account director|client services director|new business director)\b/.test(t) ||
    /\bbdm\b/.test(t)
  ) {
    return "bd_commercial";
  }

  if (
    cat === "marketing" ||
    /\b(creative director|executive creative director|head of creative|brand director|marketing director|chief creative officer|head of brand|chief marketing officer)\b/.test(t) ||
    /\bcmo\b/.test(t)
  ) {
    return "marketing_creative";
  }

  if (
    cat === "engineering" ||
    cat === "technology" ||
    /\b(technology director|head of digital|digital director|chief technology officer|head of technology)\b/.test(t) ||
    /\bcto\b/.test(t)
  ) {
    return "tech_digital";
  }

  if (
    cat === "human resources" ||
    /\b(people director|head of people|hr director|talent director|chief people officer|head of hr)\b/.test(t)
  ) {
    return "talent_people";
  }

  if (
    cat === "operations" ||
    /\b(head of production|studio director|operations director|project director|delivery director|studio manager|head of operations)\b/.test(t)
  ) {
    return "operations_delivery";
  }

  return "general";
}

// ── Job opening mapper ────────────────────────────────────────────────────────

/**
 * Maps a PredictLeads job_opening record to a RawSignalEvent.
 * Returns null when the record lacks minimum required fields.
 *
 * occurred_at = attributes.posted_at (when job was first posted),
 *   fallback to first_seen_at (when PredictLeads first indexed it).
 *
 * since filter: skip records where first_seen_at < since (new to us check).
 * Dedup (via providerEventId = record.id) handles the authoritative guard.
 */
function mapJobOpening(
  record: PredictLeadsRecord,
  domain: string,
  source: string,
  since: string | null,
): RawSignalEvent | null {
  const attrs = record.attributes;
  const title = asString(attrs.title);
  if (!title) return null;

  const firstSeenAt = asString(attrs.first_seen_at);
  const postedAt = asString(attrs.posted_at) ?? firstSeenAt;
  if (!postedAt) return null;

  // Client-side since filter: only surface events newly detected since cursor.
  if (since && firstSeenAt && firstSeenAt < since) return null;

  const category = asString(attrs.category);
  const seniority = asString(attrs.seniority);
  const url = asString(attrs.url) ?? asString(attrs.source_url);
  const description = asString(attrs.description);

  const evidence: Record<string, unknown> = {
    event: "job_posting",
    title,
    domain,
  };
  if (category) evidence.category = category;
  if (seniority) evidence.seniority = seniority;
  evidence.job_class = classifyJobPosting(title, category, seniority);

  const signalTitle = seniority
    ? `Hiring: ${seniority} ${title}`
    : `Hiring: ${title}`;

  return {
    providerEventId: record.id,
    source,
    signalType: "job_posting",
    title: signalTitle.slice(0, 120),
    description: description ?? undefined,
    evidence,
    occurredAt: normalizeTimestamp(postedAt),
    sourceUrl: url ?? undefined,
    metadata: {
      first_seen_at: firstSeenAt,
      last_seen_at: asString(attrs.last_seen_at),
    },
  };
}

// ── Financing event mapper ────────────────────────────────────────────────────

/**
 * Maps a PredictLeads financing_event record to a RawSignalEvent.
 * Returns null when the record lacks minimum required fields.
 *
 * occurred_at = attributes.effective_date (when the round closed),
 *   fallback to found_at (when PredictLeads detected it in the news).
 *
 * since filter: skip records where found_at < since.
 */
function mapFinancingEvent(
  record: PredictLeadsRecord,
  domain: string,
  source: string,
  since: string | null,
): RawSignalEvent | null {
  const attrs = record.attributes;

  const foundAt = asString(attrs.found_at);
  const effectiveDate = asString(attrs.effective_date);
  const occurredRaw = effectiveDate ?? foundAt;
  if (!occurredRaw) return null;

  // Client-side since filter.
  if (since && foundAt && foundAt < since) return null;

  const financingType = asString(attrs.financing_type) ?? "unknown";
  const roundLabel = formatFinancingType(financingType);
  const amount = asNumber(attrs.amount);
  const amountNormalized = asString(attrs.amount_normalized);
  const investors = asStringArray(attrs.investors);

  const evidence: Record<string, unknown> = {
    event: "funding_round",
    financing_type: financingType,
    round: roundLabel,
    domain,
  };
  if (amount != null) evidence.amount = amount;
  if (amountNormalized) evidence.amount_normalized = amountNormalized;
  if (investors.length > 0) evidence.investors = investors;

  const title = amount != null
    ? `${roundLabel} funding round closed`
    : `${roundLabel} funding announced`;

  return {
    providerEventId: record.id,
    source,
    signalType: "funding_round",
    title,
    evidence,
    occurredAt: normalizeTimestamp(occurredRaw),
    metadata: {
      found_at: foundAt,
      effective_date: effectiveDate,
    },
  };
}

// ── Financing type labels ─────────────────────────────────────────────────────

const FINANCING_TYPE_LABELS: Record<string, string> = {
  pre_seed: "Pre-Seed",
  seed: "Seed",
  angel: "Angel",
  series_a: "Series A",
  series_a_plus: "Series A+",
  series_b: "Series B",
  series_b1: "Series B1",
  series_c: "Series C",
  series_d: "Series D",
  series_e: "Series E",
  series_f: "Series F",
  series_g: "Series G",
  series_h: "Series H",
  series_i: "Series I",
  series_j: "Series J",
  venture: "Venture",
  private_equity: "Private Equity",
  convertible_note: "Convertible Note",
  debt_financing: "Debt Financing",
  grant: "Grant",
  corporate_round: "Corporate Round",
  secondary_market: "Secondary Market",
  post_ipo_equity: "Post-IPO Equity",
  post_ipo_debt: "Post-IPO Debt",
};

function formatFinancingType(financingType: string): string {
  return FINANCING_TYPE_LABELS[financingType] ?? financingType;
}

// ── Value extractors ──────────────────────────────────────────────────────────

function asString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

/**
 * Normalizes a PredictLeads date string to ISO 8601 with time.
 * PredictLeads uses both "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS.sssZ".
 */
function normalizeTimestamp(raw: string): string {
  if (raw.includes("T")) return raw; // already has time component
  return `${raw}T00:00:00.000Z`;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function parse429Wait(retryAfterHeader: string | null): number {
  if (!retryAfterHeader) return 60_000;
  const secs = parseInt(retryAfterHeader, 10);
  const ms = isNaN(secs) ? 60_000 : secs * 1000;
  return Math.min(Math.max(ms, 1_000), MAX_RETRY_WAIT_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeBodyText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "<unreadable>";
  }
}

function extractHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}
