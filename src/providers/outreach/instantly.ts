/**
 * Instantly outreach provider adapter.
 *
 * ── STATUS: UNVALIDATED ───────────────────────────────────────────────────────
 *   Written WITHOUT access to Instantly's official API reference and WITHOUT a
 *   live API key. Endpoint paths, request bodies and response field names come
 *   from third-party descriptions of the v2 API plus recall, and have NEVER
 *   been observed against a real response. Every mapping below is an
 *   INITIAL_HYPOTHESIS_NOT_VALIDATED. Confirm each against a real response
 *   (read-only calls first) before relying on this adapter.
 *
 *   Write paths (uploadLeads) are implemented but the lead-upload pipeline
 *   still rejects platform='instantly' campaigns (src/lib/lead-upload.ts), so
 *   nothing in the system calls them yet.
 *
 * ── API contract (as understood, unverified) ──────────────────────────────────
 *   Base: https://api.instantly.ai/api/v2
 *   Auth: Authorization: Bearer <api key>   (header — never in the URL)
 *
 * ── Endpoints used ────────────────────────────────────────────────────────────
 *   GET  /campaigns/{id}                       → status
 *   GET  /campaigns/analytics?id={id}          → getCampaignHealth stats
 *   GET  /accounts?limit=&starting_after=      → getDomainHealth (list)
 *   GET  /accounts/{email}                     → getInboxHealth
 *   POST /leads                                → uploadLeads (one lead per call)
 *   POST /leads/list                           → getCampaignLeads / Detail
 *
 * ── Identity mapping ──────────────────────────────────────────────────────────
 *   Instantly identifies an inbox by its email address, so platformInboxId is
 *   the email. Instantly has no per-campaign junction key like Smartlead's
 *   campaign_lead_map_id; the lead's own id is used as campaignLeadMapId.
 *   (The field names on CampaignLeadRecord are Smartlead-flavoured but the
 *   interface is shared.)
 *
 * ── Resilience (mirrors SmartleadAdapter) ─────────────────────────────────────
 *   429 → sleep Retry-After, retry once, then OutreachRateLimitError
 *   401/403 → OutreachCredentialError;  404 → OutreachNotFoundError
 *   5xx → exponential back-off up to MAX_RETRIES;  timeout → OutreachTimeoutError
 *   Non-JSON / non-object body → OutreachMalformedResponseError
 *
 * ── Multi-tenancy ─────────────────────────────────────────────────────────────
 *   Credentials are injected by the constructor; the adapter never reads
 *   process.env. Error messages never include the API key.
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

const PROVIDER = "instantly";
const API_BASE = "https://api.instantly.ai/api/v2";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 100;
/** Hard stop so a cursor that never ends cannot loop forever. */
const MAX_PAGES = 500;

export interface InstantlyCredentials {
  apiKey: string;
}

export interface InstantlyAdapterOptions {
  /** Injectable for tests so back-off does not slow the suite. */
  sleep?: (ms: number) => Promise<void>;
}

// ── Raw shapes (UNVALIDATED) ──────────────────────────────────────────────────

interface InstantlyList<T> {
  items?: T[];
  next_starting_after?: string | null;
}

interface InstantlyAccount {
  email?: string;
  first_name?: string;
  last_name?: string;
  /** Hypothesis: 1 = active, negative = error states. */
  status?: number | string;
  /** Hypothesis: 1 = active, 0 = inactive; strings also accepted. */
  warmup_status?: number | string;
  /** Hypothesis: 0–100 warmup score. */
  stat_warmup_score?: number;
  daily_limit?: number;
  tags?: Array<string | { label?: string; name?: string }>;
  [key: string]: unknown;
}

interface InstantlyCampaign {
  id?: string;
  /** Hypothesis: 0 draft, 1 active, 2 paused, 3 completed. */
  status?: number | string;
  [key: string]: unknown;
}

interface InstantlyAnalytics {
  emails_sent_count?: number;
  sent_count?: number;
  open_count?: number;
  link_click_count?: number;
  click_count?: number;
  reply_count?: number;
  bounced_count?: number;
  bounce_count?: number;
  unsubscribed_count?: number;
  [key: string]: unknown;
}

interface InstantlyLead {
  id?: string;
  email?: string;
  status?: number | string;
  timestamp_created?: string;
  lt_interest_status?: number | string | null;
  [key: string]: unknown;
}

// ── Mapping helpers ───────────────────────────────────────────────────────────

function mapCampaignStatus(raw: unknown): CampaignHealthResult["status"] {
  if (typeof raw === "number") {
    switch (raw) {
      case 0: return "draft";
      case 1: return "active";
      case 2: return "paused";
      case 3: return "completed";
      default: return "unknown";
    }
  }
  switch (String(raw ?? "").toLowerCase()) {
    case "draft":     return "draft";
    case "active":    return "active";
    case "paused":    return "paused";
    case "completed": return "completed";
    default:          return "unknown";
  }
}

function mapWarmupStatus(raw: unknown): InboxHealthResult["warmupStatus"] {
  if (typeof raw === "number") {
    if (raw === 1) return "active";
    if (raw === 0) return "inactive";
    return "unknown";
  }
  switch (String(raw ?? "").toLowerCase()) {
    case "active":   return "active";
    case "inactive": return "inactive";
    case "paused":   return "paused";
    default:         return "unknown";
  }
}

/** Score thresholds are a hypothesis, not Instantly's own tiers. */
function mapReputation(score: unknown): DomainReputationTier {
  if (typeof score !== "number" || !Number.isFinite(score)) return "unknown";
  if (score >= 95) return "excellent";
  if (score >= 80) return "good";
  if (score >= 60) return "fair";
  return "poor";
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function tagNames(tags: InstantlyAccount["tags"]): string[] {
  if (!Array.isArray(tags)) return [];
  return tags
    .map((t) => (typeof t === "string" ? t : (t?.label ?? t?.name ?? "")))
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

function domainOf(email: string): string {
  const at = email.indexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

/** Only status === 1 is treated as a healthy connection. Unvalidated. */
function isConnected(status: unknown): boolean {
  return status === 1 || status === "1" || String(status).toLowerCase() === "active";
}

function toSummary(a: InstantlyAccount): InboxSummary {
  const ok = isConnected(a.status);
  return {
    inboxId: a.email ?? "",
    email: a.email ?? "",
    warmupStatus: String(mapWarmupStatus(a.warmup_status)),
    warmupReputation: mapReputation(a.stat_warmup_score),
    smtpOk: ok,
    imapOk: ok,
    // Instantly's account payload has no known "warmup blocked" flag.
    isWarmupBlocked: false,
    dailySendLimit: num(a.daily_limit),
    dailySentCount: 0, // not exposed on the account object (unverified)
  };
}

function toInboxHealth(a: InstantlyAccount): InboxHealthResult {
  const ok = isConnected(a.status);
  return {
    platformInboxId: a.email ?? "",
    email: a.email ?? "",
    fromName: [a.first_name, a.last_name].filter(Boolean).join(" "),
    warmupStatus: mapWarmupStatus(a.warmup_status),
    warmupReputation: mapReputation(a.stat_warmup_score),
    smtpOk: ok,
    imapOk: ok,
    isWarmupBlocked: false,
    dailySendLimit: num(a.daily_limit),
    dailySentCount: 0,
    totalWarmupSent: 0,
    tags: tagNames(a.tags),
    fetchedAt: new Date().toISOString(),
  };
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class InstantlyAdapter implements OutreachProvider {
  readonly id = "instantly" as const;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly creds: InstantlyCredentials,
    opts: InstantlyAdapterOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  isConfigured(): boolean {
    return typeof this.creds.apiKey === "string" && this.creds.apiKey.trim().length > 0;
  }

  async getCampaignHealth(platformCampaignId: string): Promise<CampaignHealthResult> {
    this.assertConfigured();
    const id = encodeURIComponent(platformCampaignId);

    const campaign = await this.request<InstantlyCampaign>(
      "GET", `/campaigns/${id}`, platformCampaignId, "campaign",
    );
    const analyticsRaw = await this.request<unknown>(
      "GET", `/campaigns/analytics?id=${id}`, platformCampaignId, "campaign-analytics",
    );
    // Analytics may come back as a one-element array or a bare object.
    const a = (Array.isArray(analyticsRaw) ? analyticsRaw[0] : analyticsRaw) as
      InstantlyAnalytics | undefined;
    if (!a || typeof a !== "object") {
      throw new OutreachMalformedResponseError(PROVIDER, "campaign analytics is empty");
    }

    const sent = num(a.emails_sent_count ?? a.sent_count);
    const opens = num(a.open_count);
    const clicks = num(a.link_click_count ?? a.click_count);
    const replies = num(a.reply_count);
    const bounces = num(a.bounced_count ?? a.bounce_count);
    const unsubscribes = num(a.unsubscribed_count);

    return {
      platformCampaignId,
      status: mapCampaignStatus(campaign.status),
      stats: { sent, opens, clicks, replies, bounces, unsubscribes },
      openRatePct: pct(opens, sent),
      replyRatePct: pct(replies, sent),
      bounceRatePct: pct(bounces, sent),
      fetchedAt: new Date().toISOString(),
    };
  }

  async getDomainHealth(domain: string): Promise<DomainHealthResult> {
    this.assertConfigured();
    const wanted = domain.toLowerCase();
    const all = await this.listAllAccounts();
    const summaries = all
      .filter((a) => domainOf(a.email ?? "") === wanted)
      .map(toSummary);

    return {
      domain,
      inboxCount: summaries.length,
      healthyInboxCount: summaries.filter((s) => s.smtpOk && s.imapOk).length,
      blockedInboxCount: summaries.filter((s) => s.isWarmupBlocked).length,
      inboxes: summaries,
      fetchedAt: new Date().toISOString(),
    };
  }

  async getInboxHealth(platformInboxId: string): Promise<InboxHealthResult> {
    this.assertConfigured();
    const raw = await this.request<InstantlyAccount>(
      "GET", `/accounts/${encodeURIComponent(platformInboxId)}`, platformInboxId, "inbox",
    );
    return toInboxHealth(raw);
  }

  /**
   * Upload up to 100 leads, one POST /leads per lead (sequential).
   *
   * Duplicate detection is UNVERIFIED: a 409 is counted as a duplicate; any
   * other 2xx is counted as uploaded. skip_if_in_campaign is requested so a
   * re-upload does not create a second copy, but the response cannot tell us
   * whether the lead was new — so true duplicates may be over-counted as
   * uploads until this is validated against the live API.
   */
  async uploadLeads(
    platformCampaignId: string,
    leads: UploadLeadInput[],
  ): Promise<UploadLeadsResult> {
    this.assertConfigured();
    if (leads.length === 0) return { uploadCount: 0, duplicateCount: 0 };

    let uploadCount = 0;
    let duplicateCount = 0;

    for (const l of leads.slice(0, PAGE_SIZE)) {
      try {
        await this.request<unknown>("POST", "/leads", platformCampaignId, "campaign-leads", {
          campaign: platformCampaignId,
          email: l.email,
          first_name: l.firstName,
          last_name: l.lastName,
          company_name: l.companyName,
          custom_variables: l.customFields ?? {},
          skip_if_in_campaign: true,
        });
        uploadCount++;
      } catch (err) {
        if (err instanceof OutreachProviderError && /HTTP 409\b/.test(err.message)) {
          duplicateCount++;
          continue;
        }
        throw err;
      }
    }
    return { uploadCount, duplicateCount };
  }

  async getCampaignLeads(platformCampaignId: string): Promise<CampaignLeadRecord[]> {
    this.assertConfigured();
    const out: CampaignLeadRecord[] = [];
    for (const lead of await this.listCampaignLeads(platformCampaignId)) {
      const id = lead.id;
      const email = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
      if (id == null || id === "" || !email) continue;
      out.push({
        campaignLeadMapId: String(id),
        email,
        smartleadStatus: lead.status == null ? "" : String(lead.status),
      });
    }
    return out;
  }

  async getCampaignLeadDetail(
    platformCampaignId: string,
    campaignLeadMapId: string,
  ): Promise<CampaignLeadDetail | null> {
    this.assertConfigured();
    for (const lead of await this.listCampaignLeads(platformCampaignId)) {
      if (String(lead.id ?? "") !== campaignLeadMapId) continue;
      const email = typeof lead.email === "string" ? lead.email.trim().toLowerCase() : "";
      return {
        campaignLeadMapId,
        email,
        smartleadStatus: lead.status == null ? "" : String(lead.status),
        leadId: lead.id == null ? null : String(lead.id),
        leadCategoryId: lead.lt_interest_status == null ? null : String(lead.lt_interest_status),
        createdAt: typeof lead.timestamp_created === "string" ? lead.timestamp_created : null,
        isUnsubscribed: false, // unverified: no known flag
        sentAt: null,
        repliedAt: null,
        bouncedAt: null,
        unsubscribedAt: null,
        replyType: null,
        rawFields: lead as Record<string, unknown>,
      };
    }
    return null;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new OutreachCredentialError(PROVIDER);
  }

  private async listAllAccounts(): Promise<InstantlyAccount[]> {
    const all: InstantlyAccount[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const qs = `limit=${PAGE_SIZE}` + (cursor ? `&starting_after=${encodeURIComponent(cursor)}` : "");
      const resp: InstantlyList<InstantlyAccount> = await this.request(
        "GET", `/accounts?${qs}`, "list", "inbox-list",
      );
      if (!Array.isArray(resp.items)) {
        throw new OutreachMalformedResponseError(PROVIDER, "accounts response has no items array");
      }
      all.push(...resp.items);
      cursor = resp.next_starting_after ?? null;
      if (!cursor) break;
    }
    return all;
  }

  private async listCampaignLeads(platformCampaignId: string): Promise<InstantlyLead[]> {
    const all: InstantlyLead[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = { campaign: platformCampaignId, limit: PAGE_SIZE };
      if (cursor) body.starting_after = cursor;
      const resp: InstantlyList<InstantlyLead> = await this.request(
        "POST", "/leads/list", platformCampaignId, "campaign-leads", body,
      );
      if (!Array.isArray(resp.items)) {
        throw new OutreachMalformedResponseError(PROVIDER, "leads response has no items array");
      }
      all.push(...resp.items);
      cursor = resp.next_starting_after ?? null;
      if (!cursor) break;
    }
    return all;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    resourceId: string,
    resourceType: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${API_BASE}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.creds.apiKey}`,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          throw new OutreachTimeoutError(PROVIDER);
        }
        lastError = err;
        continue;
      }

      if (resp.status === 401 || resp.status === 403) {
        const detail = (await resp.text().catch(() => "")).slice(0, 120);
        throw new OutreachCredentialError(PROVIDER, detail || undefined);
      }
      if (resp.status === 404) {
        throw new OutreachNotFoundError(PROVIDER, resourceType, resourceId);
      }
      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get("Retry-After") ?? "5") * 1000;
        if (attempt === 0) {
          await this.sleep(retryAfter);
          continue;
        }
        throw new OutreachRateLimitError(PROVIDER, retryAfter);
      }
      if (resp.status >= 500) {
        await this.sleep(1000 * 2 ** attempt);
        lastError = new OutreachProviderError(`${PROVIDER}: server error ${resp.status}`, PROVIDER);
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new OutreachProviderError(
          `${PROVIDER}: unexpected HTTP ${resp.status}: ${text.slice(0, 200)}`,
          PROVIDER,
        );
      }

      let json: unknown;
      try {
        json = await resp.json();
      } catch {
        throw new OutreachMalformedResponseError(PROVIDER, "response is not valid JSON");
      }
      if (json === null || typeof json !== "object") {
        throw new OutreachMalformedResponseError(PROVIDER, `expected object, got ${typeof json}`);
      }
      return json as T;
    }

    throw lastError instanceof OutreachProviderError
      ? lastError
      : new OutreachProviderError(
          `${PROVIDER}: request failed after ${MAX_RETRIES} attempts`,
          PROVIDER,
          lastError,
        );
  }
}
