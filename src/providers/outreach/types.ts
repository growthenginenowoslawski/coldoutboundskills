/**
 * Outreach provider abstraction — Stage 16.
 *
 * All campaign-sending platforms (Smartlead, Instantly, PlusVibe) implement
 * this interface. The campaign operations control plane depends only on this
 * contract — never on a vendor SDK directly.
 *
 * Stage 16 scope: READ-ONLY operations only.
 * Mutation operations (pause campaign, update sequence, enroll lead) are Stage 18+.
 *
 * Provider IDs must be stable — they appear in the database (campaigns.platform).
 */

/** Stable identifiers matching campaigns.platform values in the database. */
export type OutreachProviderId = "smartlead" | "instantly" | "plusvibe";

// ── Campaign health ───────────────────────────────────────────────────────────

export interface CampaignStats {
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
}

export interface CampaignHealthResult {
  /** Provider's own campaign ID (platform_campaign_id in our DB). */
  platformCampaignId: string;
  /** Provider-reported campaign status. */
  status: "active" | "paused" | "completed" | "draft" | "unknown";
  stats: CampaignStats;
  /** Open rate 0–100, derived from stats if not provided natively. */
  openRatePct: number;
  /** Reply rate 0–100. */
  replyRatePct: number;
  /** Hard bounce rate 0–100. */
  bounceRatePct: number;
  /** ISO timestamp of when this snapshot was taken. */
  fetchedAt: string;
}

// ── Domain health ─────────────────────────────────────────────────────────────

export type DomainReputationTier = "excellent" | "good" | "fair" | "poor" | "unknown";

export interface InboxSummary {
  inboxId: string;
  email: string;
  warmupStatus: string;
  warmupReputation: DomainReputationTier;
  smtpOk: boolean;
  imapOk: boolean;
  isWarmupBlocked: boolean;
  dailySendLimit: number;
  dailySentCount: number;
}

export interface DomainHealthResult {
  domain: string;
  /** Total inboxes on this domain. */
  inboxCount: number;
  /** Inboxes where SMTP connection is healthy. */
  healthyInboxCount: number;
  /** Inboxes currently blocked from warmup. */
  blockedInboxCount: number;
  /** Aggregate view of inboxes. */
  inboxes: InboxSummary[];
  fetchedAt: string;
}

// ── Inbox (email account) health ──────────────────────────────────────────────

export interface InboxHealthResult {
  /** Provider's own inbox ID. */
  platformInboxId: string;
  email: string;
  fromName: string;
  warmupStatus: "active" | "inactive" | "paused" | "unknown";
  warmupReputation: DomainReputationTier;
  smtpOk: boolean;
  imapOk: boolean;
  isWarmupBlocked: boolean;
  dailySendLimit: number;
  dailySentCount: number;
  totalWarmupSent: number;
  tags: string[];
  fetchedAt: string;
}

// ── Lead upload ───────────────────────────────────────────────────────────────

/** One lead to upload to a provider campaign. */
export interface UploadLeadInput {
  email:         string;
  firstName:     string;
  lastName:      string;
  companyName:   string;
  customFields?: Record<string, string>;
}

/**
 * Aggregate result returned by the provider after uploading a batch.
 * Smartlead returns only counts — no per-lead ID is available.
 */
export interface UploadLeadsResult {
  /** Leads accepted as new by the provider. */
  uploadCount:    number;
  /** Leads the provider already knew about (idempotent re-upload). */
  duplicateCount: number;
}

// ── Campaign lead roster ──────────────────────────────────────────────────────

/**
 * One lead record returned by the provider's campaign roster endpoint.
 * Used for platform_lead_id backfill (Stage 21A) and future outcome sync (Stage 21B).
 *
 * Smartlead field mapping (confirmed live 2026-09-05):
 *   campaignLeadMapId ← campaign_lead_map_id  (per-campaign junction key — use as platform_lead_id)
 *   email             ← lead.email            (normalized to lowercase)
 *   smartleadStatus   ← status                (raw string — only 'STARTED' confirmed for DRAFTED campaigns)
 *
 * NOTE: 'STARTED' means enrolled but sequence not yet begun. Status strings for
 * sent/replied/bounced are unconfirmed — do NOT map until Stage 21B.
 */
export interface CampaignLeadRecord {
  /** campaign_lead_map_id — unique per (campaign, lead) pair. Store as platform_lead_id. */
  campaignLeadMapId: string;
  /** Normalized email address (lowercase, trimmed) — the match key against contacts.email. */
  email: string;
  /** Raw Smartlead status string. Only 'STARTED' is confirmed for DRAFTED campaigns. */
  smartleadStatus: string;
}

/**
 * Enriched single-lead detail for Stage 21B discovery and status sync.
 * Extends CampaignLeadRecord with all engagement fields Smartlead may provide.
 *
 * Fields confirmed present for DRAFTED campaigns (status='STARTED'):
 *   campaignLeadMapId, email, smartleadStatus, leadId, leadCategoryId, createdAt, isUnsubscribed
 *
 * Fields expected only after sends (Stage 21B contract — unconfirmed until campaign goes active):
 *   sentAt, repliedAt, bouncedAt, unsubscribedAt, replyType
 *
 * rawFields: the full raw per-lead object from Smartlead for empirical field mapping.
 * Do not depend on rawFields in production code — it is for discovery only.
 */
export interface CampaignLeadDetail extends CampaignLeadRecord {
  /** Smartlead global lead ID (lead.id). Distinct from campaignLeadMapId. */
  leadId:           string | null;
  /** lead_category_id — semantics unknown for STARTED; preserved for Stage 21B mapping. */
  leadCategoryId:   string | null;
  /** ISO timestamp when this lead was added to the campaign (campaign roster created_at). */
  createdAt:        string | null;
  /** Whether the lead has globally unsubscribed. */
  isUnsubscribed:   boolean;
  /** ISO timestamp of first send to this lead. Null for DRAFTED campaigns. */
  sentAt:           string | null;
  /** ISO timestamp when this lead replied. Null until a reply is received. */
  repliedAt:        string | null;
  /** ISO timestamp when this lead's email bounced. Null until a bounce occurs. */
  bouncedAt:        string | null;
  /** ISO timestamp when this lead unsubscribed. Null until unsubscribed. */
  unsubscribedAt:   string | null;
  /** Reply classification string from Smartlead. Null until a reply is received. */
  replyType:        string | null;
  /** Full raw per-lead object from the Smartlead API. For Stage 21B field discovery only. */
  rawFields:        Record<string, unknown>;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface OutreachProvider {
  /** Stable platform identifier. Matches campaigns.platform in the database. */
  readonly id: OutreachProviderId;

  /**
   * Whether this adapter has valid credentials and can make API calls.
   * A provider that returns false here must throw OutreachCredentialError
   * on any actual API call rather than silently returning empty data.
   */
  isConfigured(): boolean;

  /**
   * Retrieve health metrics for one campaign.
   *
   * @param platformCampaignId — the provider's own campaign ID
   *   (stored in campaigns.platform_campaign_id in our DB)
   * @throws OutreachNotFoundError if the campaign doesn't exist
   * @throws OutreachCredentialError if credentials are invalid
   * @throws OutreachRateLimitError on 429
   * @throws OutreachTimeoutError on network timeout
   * @throws OutreachMalformedResponseError on unexpected response shape
   */
  getCampaignHealth(platformCampaignId: string): Promise<CampaignHealthResult>;

  /**
   * Retrieve aggregate health for all inboxes on a domain.
   *
   * Smartlead does not expose a native per-domain endpoint; this is derived
   * by filtering email-accounts by domain. Other providers may support it
   * natively.
   *
   * @param domain — bare domain, e.g. "example.com"
   */
  getDomainHealth(domain: string): Promise<DomainHealthResult>;

  /**
   * Retrieve health for one inbox (email account).
   *
   * @param platformInboxId — provider's own inbox/account ID
   */
  getInboxHealth(platformInboxId: string): Promise<InboxHealthResult>;

  /**
   * Upload a batch of leads to a provider campaign.
   *
   * Callers must batch to ≤ 100 leads before calling this method.
   * The provider may accept leads it already knows (idempotent re-upload) —
   * those are counted in duplicateCount, not treated as errors.
   *
   * platform_lead_id is NOT returned by Smartlead — do not attempt to populate it.
   *
   * @param platformCampaignId — the provider's own campaign ID
   * @param leads — up to 100 leads in this batch
   * @throws OutreachCredentialError on 401/403
   * @throws OutreachNotFoundError if the campaign doesn't exist
   * @throws OutreachRateLimitError on 429
   * @throws OutreachTimeoutError on network timeout
   * @throws OutreachProviderError on 5xx or unexpected response
   */
  uploadLeads(
    platformCampaignId: string,
    leads: UploadLeadInput[],
  ): Promise<UploadLeadsResult>;

  /**
   * Retrieve all leads enrolled in a provider campaign.
   * Handles pagination internally — returns a flat array.
   *
   * Used by Stage 21A platform_lead_id backfill.
   * campaignLeadMapId in each record is the authoritative platform_lead_id.
   * Email is normalized (lowercase, trimmed) for use as a match key.
   *
   * @throws OutreachCredentialError if credentials are invalid
   * @throws OutreachNotFoundError if the campaign does not exist on the provider
   */
  getCampaignLeads(platformCampaignId: string): Promise<CampaignLeadRecord[]>;

  /**
   * Retrieve enriched detail for a single lead in a campaign, matched by
   * campaign_lead_map_id (our platform_lead_id).
   *
   * Returns null if no lead with that campaignLeadMapId exists in the campaign.
   * Paginates the campaign roster internally — may make multiple GET calls for
   * campaigns with many leads.
   *
   * The rawFields property of the result contains the full unmodified Smartlead
   * lead object, enabling empirical Stage 21B field mapping without a second
   * deployment.
   *
   * Used by Stage 21B discovery. GET only — no mutations.
   *
   * @param platformCampaignId  — the provider's own campaign ID
   * @param campaignLeadMapId   — per-(campaign, lead) junction key (platform_lead_id)
   * @throws OutreachCredentialError if credentials are invalid
   * @throws OutreachNotFoundError if the campaign does not exist on the provider
   */
  getCampaignLeadDetail(
    platformCampaignId: string,
    campaignLeadMapId:  string,
  ): Promise<CampaignLeadDetail | null>;
}
