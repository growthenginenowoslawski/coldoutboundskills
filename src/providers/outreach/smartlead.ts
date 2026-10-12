/**
 * Smartlead outreach provider adapter — Stage 16.
 *
 * ── API contract ──────────────────────────────────────────────────────────────
 *   Base: https://server.smartlead.ai/api/v1
 *   Auth: ?api_key=<key> query parameter on every request
 *
 * ── Endpoints used ────────────────────────────────────────────────────────────
 *   GET  /campaigns/{id}/analytics         → getCampaignHealth
 *   GET  /email-accounts?offset=&limit=    → getDomainHealth, getInboxHealth (list)
 *   GET  /email-accounts/{id}              → getInboxHealth (single)
 *   POST /campaigns/{id}/leads             → uploadLeads (Stage 20)
 *   GET  /campaigns/{id}/leads             → getCampaignLeads (Stage 21A)
 *                                          → getCampaignLeadDetail (Stage 21B discovery)
 *
 * ── Retry / resilience ────────────────────────────────────────────────────────
 *   429 → read Retry-After header, sleep, retry once, then throw OutreachRateLimitError
 *   4xx (not 401/403/404) → throw OutreachProviderError
 *   401/403 → throw OutreachCredentialError
 *   404 → throw OutreachNotFoundError
 *   5xx → exponential back-off up to MAX_RETRIES, then throw OutreachProviderError
 *   Timeout → AbortSignal.timeout(REQUEST_TIMEOUT_MS), throw OutreachTimeoutError
 *   Malformed JSON → throw OutreachMalformedResponseError
 *
 * ── Multi-tenancy ─────────────────────────────────────────────────────────────
 *   The adapter is instantiated with credentials ({apiKey}) — it does not read
 *   from process.env directly. Credentials must be resolved per client_id by
 *   the caller (OutreachProviderRegistry). This keeps the adapter stateless
 *   and testable without environment setup.
 */

import {
  OutreachCredentialError,
  OutreachMalformedResponseError,
  OutreachNotFoundError,
  OutreachProviderError,
  OutreachRateLimitError,
  OutreachTimeoutError,
} from "./errors.js";
import type {
  CampaignHealthResult,
  CampaignLeadDetail,
  CampaignLeadRecord,
  DomainHealthResult,
  DomainReputationTier,
  InboxHealthResult,
  InboxSummary,
  OutreachProvider,
  UploadLeadInput,
  UploadLeadsResult,
} from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE = "https://server.smartlead.ai/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const INBOX_PAGE_SIZE = 100;

// ── Credential type ───────────────────────────────────────────────────────────

export interface SmartleadCredentials {
  apiKey: string;
}

// ── Internal API response shapes ──────────────────────────────────────────────

interface SmartleadUploadResponse {
  upload_count?:               number;
  /** Leads blocked by global suppression/unsubscribe lists — not the same as per-campaign dedup. */
  duplicate_count?:            number;
  /** Leads already present in THIS campaign — the authoritative per-campaign dedup counter. */
  already_added_to_campaign?:  number;
}

/**
 * Response envelope for GET /campaigns/{id}/leads (confirmed 2026-09-05):
 *   { total_leads: "1", data: [...], offset: 0, limit: 100 }
 * total_leads is a STRING, not a number.
 * data is the lead array; absent fields default to empty array.
 */
interface SmartleadGetLeadsResponse {
  total_leads?: string | number;
  data?:        SmartleadCampaignLeadRaw[];
  offset?:      number;
  limit?:       number;
}

interface SmartleadCampaignLeadRaw {
  /** Per-(campaign, lead) junction key — the authoritative platform_lead_id. */
  campaign_lead_map_id?: string | number;
  lead_category_id?:     string | number | null;
  status?:               string;
  created_at?:           string;
  // Engagement fields — confirmed absent for DRAFTED campaigns (status=STARTED).
  // Expected to appear once the campaign goes active (Stage 21B contract TBD).
  sent_at?:              string | null;
  replied_at?:           string | null;
  bounced_at?:           string | null;
  unsubscribed_at?:      string | null;
  reply_type?:           string | null;
  lead?: {
    id?:                 number;
    /** Raw email from Smartlead. Normalize (lowercase + trim) before using as match key. */
    email?:              string;
    first_name?:         string;
    last_name?:          string;
    company_name?:       string;
    is_unsubscribed?:    boolean;
    [key: string]:       unknown;
  };
  [key: string]: unknown;
}

interface SmartleadCampaignAnalytics {
  sent_count?: number;
  open_count?: number;
  click_count?: number;
  reply_count?: number;
  bounce_count?: number;
  unsubscribed_count?: number;
  campaign_status?: string;
  [key: string]: unknown;
}

interface SmartleadWarmupDetails {
  status?: string;
  warmup_reputation?: string;
  max_email_per_day?: number;
  is_warmup_blocked?: boolean;
  total_sent_count?: number;
}

interface SmartleadEmailAccount {
  id: number;
  from_email?: string;
  email?: string;
  from_name?: string;
  tags?: Array<{ id: number; name: string }>;
  warmup_details?: SmartleadWarmupDetails;
  message_per_day?: number;
  daily_sent_count?: number;
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapWarmupReputation(raw?: string): DomainReputationTier {
  switch ((raw ?? "").toLowerCase()) {
    case "excellent": return "excellent";
    case "good":      return "good";
    case "fair":      return "fair";
    case "poor":      return "poor";
    default:          return "unknown";
  }
}

function mapCampaignStatus(raw?: string): CampaignHealthResult["status"] {
  switch ((raw ?? "").toLowerCase()) {
    case "active":    return "active";
    case "paused":    return "paused";
    case "completed": return "completed";
    case "draft":     return "draft";
    default:          return "unknown";
  }
}

function mapWarmupStatus(raw?: string): InboxHealthResult["warmupStatus"] {
  switch ((raw ?? "").toLowerCase()) {
    case "active":   return "active";
    case "inactive": return "inactive";
    case "paused":   return "paused";
    default:         return "unknown";
  }
}

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // one decimal
}

function inboxEmail(account: SmartleadEmailAccount): string {
  return account.from_email ?? account.email ?? "";
}

function inboxDomain(account: SmartleadEmailAccount): string {
  const email = inboxEmail(account);
  const at = email.indexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
}

function toInboxSummary(account: SmartleadEmailAccount): InboxSummary {
  const w = account.warmup_details ?? {};
  return {
    inboxId: String(account.id),
    email: inboxEmail(account),
    warmupStatus: w.status ?? "unknown",
    warmupReputation: mapWarmupReputation(w.warmup_reputation),
    smtpOk: !!account.is_smtp_success,
    imapOk: !!account.is_imap_success,
    isWarmupBlocked: !!w.is_warmup_blocked,
    dailySendLimit: account.message_per_day ?? 0,
    dailySentCount: account.daily_sent_count ?? 0,
  };
}

function toInboxHealthResult(account: SmartleadEmailAccount): InboxHealthResult {
  const w = account.warmup_details ?? {};
  return {
    platformInboxId: String(account.id),
    email: inboxEmail(account),
    fromName: account.from_name ?? "",
    warmupStatus: mapWarmupStatus(w.status),
    warmupReputation: mapWarmupReputation(w.warmup_reputation),
    smtpOk: !!account.is_smtp_success,
    imapOk: !!account.is_imap_success,
    isWarmupBlocked: !!w.is_warmup_blocked,
    dailySendLimit: account.message_per_day ?? 0,
    dailySentCount: account.daily_sent_count ?? 0,
    totalWarmupSent: w.total_sent_count ?? 0,
    tags: (account.tags ?? []).map((t) => t.name),
    fetchedAt: new Date().toISOString(),
  };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class SmartleadAdapter implements OutreachProvider {
  readonly id = "smartlead" as const;

  constructor(private readonly creds: SmartleadCredentials) {}

  isConfigured(): boolean {
    return typeof this.creds.apiKey === "string" && this.creds.apiKey.trim().length > 0;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async getCampaignHealth(platformCampaignId: string): Promise<CampaignHealthResult> {
    if (!this.isConfigured()) throw new OutreachCredentialError("smartlead");

    const url = `${API_BASE}/campaigns/${encodeURIComponent(platformCampaignId)}/analytics`;
    const raw = await this._get<SmartleadCampaignAnalytics>(url, platformCampaignId, "campaign");

    const sent = raw.sent_count ?? 0;
    const opens = raw.open_count ?? 0;
    const clicks = raw.click_count ?? 0;
    const replies = raw.reply_count ?? 0;
    const bounces = raw.bounce_count ?? 0;
    const unsubscribes = raw.unsubscribed_count ?? 0;

    return {
      platformCampaignId,
      status: mapCampaignStatus(raw.campaign_status),
      stats: { sent, opens, clicks, replies, bounces, unsubscribes },
      openRatePct: pct(opens, sent),
      replyRatePct: pct(replies, sent),
      bounceRatePct: pct(bounces, sent),
      fetchedAt: new Date().toISOString(),
    };
  }

  async getDomainHealth(domain: string): Promise<DomainHealthResult> {
    if (!this.isConfigured()) throw new OutreachCredentialError("smartlead");

    const allInboxes = await this._listAllInboxes();
    const domainInboxes = allInboxes.filter(
      (a) => inboxDomain(a).toLowerCase() === domain.toLowerCase(),
    );

    const summaries = domainInboxes.map(toInboxSummary);
    const healthyCount = summaries.filter((s) => s.smtpOk && s.imapOk).length;
    const blockedCount = summaries.filter((s) => s.isWarmupBlocked).length;

    return {
      domain,
      inboxCount: summaries.length,
      healthyInboxCount: healthyCount,
      blockedInboxCount: blockedCount,
      inboxes: summaries,
      fetchedAt: new Date().toISOString(),
    };
  }

  async getInboxHealth(platformInboxId: string): Promise<InboxHealthResult> {
    if (!this.isConfigured()) throw new OutreachCredentialError("smartlead");

    const url = `${API_BASE}/email-accounts/${encodeURIComponent(platformInboxId)}`;
    const raw = await this._get<SmartleadEmailAccount>(url, platformInboxId, "inbox");
    return toInboxHealthResult(raw);
  }

  /**
   * Upload up to 100 leads to a Smartlead campaign.
   *
   * Uses ?ignore_duplicate=true so Smartlead silently accepts leads it already
   * knows about — duplicate_count in the response reflects those; they are not
   * treated as errors. platform_lead_id is NOT populated because Smartlead's
   * upload response does not return a per-lead identifier.
   *
   * The caller (lead-upload.ts) is responsible for batching to ≤ 100 leads.
   * This method enforces the cap defensively and processes only the first 100.
   *
   * SECURITY: The request URL contains the API key as a query param. It must
   * never be logged. This method ensures no thrown error includes the URL or key.
   *
   * ── Duplicate handling ─────────────────────────────────────────────────────
   * Smartlead accepts re-uploads of existing leads without error (HTTP 200).
   * The `already_added_to_campaign` field in the response is the authoritative
   * per-campaign dedup counter. `duplicate_count` is a separate global-list
   * counter (suppression/unsubscribe). We map `already_added_to_campaign` to
   * our internal `duplicateCount` with `duplicate_count` as fallback for
   * response shapes that predate this field.
   *
   * Note: `ignore_duplicate` is NOT a valid Smartlead API query parameter
   * (confirmed empirically — HTTP 400 if included). Smartlead handles dedup
   * natively; no extra parameter is required.
   */
  async uploadLeads(
    platformCampaignId: string,
    leads: UploadLeadInput[],
  ): Promise<UploadLeadsResult> {
    if (!this.isConfigured()) throw new OutreachCredentialError("smartlead");
    if (leads.length === 0) return { uploadCount: 0, duplicateCount: 0 };

    const batch = leads.slice(0, INBOX_PAGE_SIZE); // defensive 100-lead cap
    const path = `${API_BASE}/campaigns/${encodeURIComponent(platformCampaignId)}/leads`;
    const body = JSON.stringify({
      lead_list: batch.map((l) => ({
        email:         l.email,
        first_name:    l.firstName,
        last_name:     l.lastName,
        company_name:  l.companyName,
        custom_fields: l.customFields ?? {},
      })),
    });

    const raw = await this._post<SmartleadUploadResponse>(
      path,
      platformCampaignId,
      "campaign-leads",
      body,
    );

    return {
      uploadCount:    raw.upload_count ?? 0,
      // already_added_to_campaign is the per-campaign dedup counter;
      // fall back to duplicate_count for older response shapes.
      duplicateCount: raw.already_added_to_campaign ?? raw.duplicate_count ?? 0,
    };
  }

  /**
   * Retrieve all leads enrolled in a Smartlead campaign.
   * Paginates using offset/limit (100 per page) until a partial page is received.
   *
   * Response envelope: { total_leads: string, data: [...], offset, limit }
   * Per-lead shape:    { campaign_lead_map_id, status, created_at, lead: { email, ... } }
   *
   * Items missing campaign_lead_map_id or lead.email are silently skipped — they
   * cannot be matched back to our contacts and have no usable platform_lead_id.
   *
   * Returned emails are normalized (lowercase, trimmed) for case-insensitive matching.
   * campaign_lead_map_id is coerced to string even if Smartlead returns a number.
   *
   * SECURITY: The request URL contains the API key — never log it.
   */
  async getCampaignLeads(platformCampaignId: string): Promise<CampaignLeadRecord[]> {
    if (!this.isConfigured()) throw new OutreachCredentialError("smartlead");

    const all: CampaignLeadRecord[] = [];
    let offset = 0;

    while (true) {
      const path = `${API_BASE}/campaigns/${encodeURIComponent(platformCampaignId)}/leads?offset=${offset}&limit=${INBOX_PAGE_SIZE}`;
      const resp = await this._get<SmartleadGetLeadsResponse>(
        path,
        platformCampaignId,
        "campaign-leads",
      );

      const batch: SmartleadCampaignLeadRaw[] = Array.isArray(resp.data) ? resp.data : [];

      for (const item of batch) {
        const mapId = item.campaign_lead_map_id;
        const email = item.lead?.email;

        // Skip items that can't be matched or tracked
        if (mapId == null || mapId === "" || !email || !email.trim()) continue;

        all.push({
          campaignLeadMapId: String(mapId),
          email:             email.toLowerCase().trim(),
          smartleadStatus:   item.status ?? "",
        });
      }

      // Stop when a partial page is received — no more data
      if (batch.length < INBOX_PAGE_SIZE) break;
      offset += INBOX_PAGE_SIZE;
    }

    return all;
  }

  /**
   * Retrieve enriched detail for one lead in a campaign, matched by
   * campaign_lead_map_id.  Paginates the full roster until found or exhausted.
   * Returns null when no matching lead exists.
   *
   * rawFields in the returned object contains the full unprocessed Smartlead
   * per-lead object — all fields including those not yet mapped to our schema.
   * This is the primary instrument for Stage 21B field discovery.
   *
   * GET only — no mutations.
   */
  async getCampaignLeadDetail(
    platformCampaignId: string,
    campaignLeadMapId:  string,
  ): Promise<CampaignLeadDetail | null> {
    if (!this.isConfigured()) throw new OutreachCredentialError("smartlead");

    let offset = 0;
    while (true) {
      const path = `${API_BASE}/campaigns/${encodeURIComponent(platformCampaignId)}/leads?offset=${offset}&limit=${INBOX_PAGE_SIZE}`;
      const resp = await this._get<SmartleadGetLeadsResponse>(
        path,
        platformCampaignId,
        "campaign-leads",
      );

      const batch: SmartleadCampaignLeadRaw[] = Array.isArray(resp.data) ? resp.data : [];

      for (const item of batch) {
        const mapId = item.campaign_lead_map_id;
        if (mapId == null || mapId === "") continue;
        if (String(mapId) === campaignLeadMapId) {
          return this._rawToDetail(item);
        }
      }

      if (batch.length < INBOX_PAGE_SIZE) return null;
      offset += INBOX_PAGE_SIZE;
    }
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private _rawToDetail(item: SmartleadCampaignLeadRaw): CampaignLeadDetail {
    const mapId = item.campaign_lead_map_id;
    const email  = item.lead?.email ?? "";
    return {
      campaignLeadMapId: String(mapId ?? ""),
      email:             email.toLowerCase().trim(),
      smartleadStatus:   item.status ?? "",
      leadId:            item.lead?.id != null ? String(item.lead.id) : null,
      leadCategoryId:    item.lead_category_id != null ? String(item.lead_category_id) : null,
      createdAt:         item.created_at ?? null,
      isUnsubscribed:    !!item.lead?.is_unsubscribed,
      sentAt:            item.sent_at ?? null,
      repliedAt:         item.replied_at ?? null,
      bouncedAt:         item.bounced_at ?? null,
      unsubscribedAt:    item.unsubscribed_at ?? null,
      replyType:         item.reply_type ?? null,
      rawFields:         { ...item },
    };
  }

  private _url(path: string): string {
    const sep = path.includes("?") ? "&" : "?";
    // Trim to guard against whitespace in env vars
    return `${path}${sep}api_key=${this.creds.apiKey.trim()}`;
  }

  private async _get<T>(
    path: string,
    resourceId: string,
    resourceType: string,
  ): Promise<T> {
    const url = this._url(path);
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(url, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new OutreachTimeoutError("smartlead");
        }
        lastError = err;
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        // Read the body so the error message includes the API's own reason (e.g. "Plan expired!")
        const apiMsg = await resp.text().catch(() => "");
        let detail = "";
        try {
          const parsed = JSON.parse(apiMsg) as Record<string, unknown>;
          detail = typeof parsed.message === "string" ? parsed.message : apiMsg;
        } catch {
          detail = apiMsg;
        }
        throw new OutreachCredentialError("smartlead", detail.slice(0, 120) || undefined);
      }

      if (resp.status === 404) {
        throw new OutreachNotFoundError("smartlead", resourceType, resourceId);
      }

      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get("Retry-After") ?? "5") * 1000;
        if (attempt === 0) {
          await sleep(retryAfter);
          continue;
        }
        throw new OutreachRateLimitError("smartlead", retryAfter);
      }

      if (resp.status >= 500) {
        const backoff = 1000 * 2 ** attempt;
        await sleep(backoff);
        lastError = new OutreachProviderError(
          `smartlead: server error ${resp.status}`,
          "smartlead",
        );
        continue;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new OutreachProviderError(
          `smartlead: unexpected HTTP ${resp.status}: ${body.slice(0, 200)}`,
          "smartlead",
        );
      }

      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        throw new OutreachMalformedResponseError("smartlead", "response is not valid JSON");
      }

      if (json === null || typeof json !== "object") {
        throw new OutreachMalformedResponseError(
          "smartlead",
          `expected object, got ${typeof json}`,
        );
      }

      return json as T;
    }

    throw lastError instanceof OutreachProviderError
      ? lastError
      : new OutreachProviderError(
          `smartlead: request failed after ${MAX_RETRIES} attempts`,
          "smartlead",
          lastError,
        );
  }

  /**
   * Execute a POST request against the Smartlead API.
   *
   * Mirrors _get() but uses POST with a JSON body. The url parameter must not
   * be logged — it contains the API key appended by _url(). Error messages
   * are constructed from response bodies, never from the request URL.
   */
  private async _post<T>(
    path: string,
    resourceId: string,
    resourceType: string,
    body: string,
  ): Promise<T> {
    const url = this._url(path); // url contains api_key — never log it
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new OutreachTimeoutError("smartlead");
        }
        lastError = err;
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        const apiMsg = await resp.text().catch(() => "");
        let detail = "";
        try {
          const parsed = JSON.parse(apiMsg) as Record<string, unknown>;
          detail = typeof parsed.message === "string" ? parsed.message : apiMsg;
        } catch {
          detail = apiMsg;
        }
        throw new OutreachCredentialError("smartlead", detail.slice(0, 120) || undefined);
      }

      if (resp.status === 404) {
        throw new OutreachNotFoundError("smartlead", resourceType, resourceId);
      }

      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get("Retry-After") ?? "5") * 1000;
        if (attempt === 0) {
          await sleep(retryAfter);
          continue;
        }
        throw new OutreachRateLimitError("smartlead", retryAfter);
      }

      if (resp.status >= 500) {
        const backoff = 1000 * 2 ** attempt;
        await sleep(backoff);
        lastError = new OutreachProviderError(
          `smartlead: server error ${resp.status}`,
          "smartlead",
        );
        continue;
      }

      if (!resp.ok) {
        const respBody = await resp.text().catch(() => "");
        throw new OutreachProviderError(
          `smartlead: unexpected HTTP ${resp.status}: ${respBody.slice(0, 200)}`,
          "smartlead",
        );
      }

      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        throw new OutreachMalformedResponseError("smartlead", "response is not valid JSON");
      }

      if (json === null || typeof json !== "object") {
        throw new OutreachMalformedResponseError(
          "smartlead",
          `expected object, got ${typeof json}`,
        );
      }

      return json as T;
    }

    throw lastError instanceof OutreachProviderError
      ? lastError
      : new OutreachProviderError(
          `smartlead: request failed after ${MAX_RETRIES} attempts`,
          "smartlead",
          lastError,
        );
  }

  /**
   * Paginate through all email accounts.
   * Smartlead paginates at 100 per page via offset.
   */
  private async _listAllInboxes(): Promise<SmartleadEmailAccount[]> {
    const all: SmartleadEmailAccount[] = [];
    let offset = 0;

    while (true) {
      const url = `${API_BASE}/email-accounts?offset=${offset}&limit=${INBOX_PAGE_SIZE}`;
      const batch = await this._get<SmartleadEmailAccount[]>(url, "list", "inbox-list");

      if (!Array.isArray(batch)) {
        throw new OutreachMalformedResponseError(
          "smartlead",
          "email-accounts response is not an array",
        );
      }
      if (batch.length === 0) break;
      all.push(...batch);
      if (batch.length < INBOX_PAGE_SIZE) break;
      offset += INBOX_PAGE_SIZE;
    }

    return all;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
