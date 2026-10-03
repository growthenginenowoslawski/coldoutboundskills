/**
 * Persistence layer for health snapshot tables — Stage 18.
 *
 * Three tables:
 *   campaign_health_snapshots  — campaign send/open/reply/bounce metrics
 *   domain_health_snapshots    — domain-level inbox aggregate
 *   inbox_health_snapshots     — per-inbox warmup/SMTP/IMAP state
 *
 * ── Baseline determination ────────────────────────────────────────────────────
 *
 * The FIRST snapshot per (clientId, entityId) is marked is_baseline=true.
 * Determination is checked before insert — if no existing row exists for the
 * entity, the new row is marked as baseline. Race conditions (two concurrent
 * snapshot runs for the same entity) are benign: both can be marked baseline,
 * or one wins; the duplicate timestamp triggers ON CONFLICT DO NOTHING.
 *
 * In practice, snapshots run on a scheduled cadence (not concurrently), so
 * true races do not occur in production.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * Each save function uses ON CONFLICT DO NOTHING on (client_id, entity_id, taken_at).
 * Snapshots are taken with second-level timestamp precision.
 * Re-running a snapshot job within the same second = silently skipped.
 * Re-running more than one second later = new row (expected, desired).
 *
 * ── Client isolation ──────────────────────────────────────────────────────────
 *
 * All reads include .eq("client_id", clientId) as defence-in-depth.
 * Campaign snapshots use a composite FK (client_id, campaign_id) → campaigns
 * enforced at the DB level (set in migration 0016).
 *
 * ── Excluded by design (Stage 18) ────────────────────────────────────────────
 *
 * No snapshot updates (snapshots are write-once, append-only).
 * No snapshot deletions (except cascade on campaign/client delete — DB-level).
 * No automatic scheduling — snapshots are triggered by the caller.
 */

import { getSupabaseAdmin } from "./supabase";
import type {
  CampaignHealthSnapshot,
  DomainHealthSnapshot,
  InboxHealthSnapshot,
} from "../lib/health-snapshots";
import type { CampaignHealthResult, DomainHealthResult, InboxHealthResult } from "../providers/outreach/types";

const CAMPAIGN_TABLE = "campaign_health_snapshots" as const;
const DOMAIN_TABLE   = "domain_health_snapshots"   as const;
const INBOX_TABLE    = "inbox_health_snapshots"     as const;

// ── Pure mappers ──────────────────────────────────────────────────────────────

export function fromCampaignSnapshotRow(row: Record<string, unknown>): CampaignHealthSnapshot {
  return {
    id:                 row.id                   as string,
    clientId:           row.client_id            as string,
    campaignId:         row.campaign_id          as string,
    platform:           row.platform             as string,
    platformCampaignId: row.platform_campaign_id as string,
    takenAt:            row.taken_at             as string,
    isBaseline:         row.is_baseline          as boolean,
    campaignStatus:     (row.campaign_status     as string | null) ?? null,
    sentCount:          (row.sent_count          as number) ?? 0,
    openCount:          (row.open_count          as number) ?? 0,
    clickCount:         (row.click_count         as number) ?? 0,
    replyCount:         (row.reply_count         as number) ?? 0,
    bounceCount:        (row.bounce_count        as number) ?? 0,
    unsubscribeCount:   (row.unsubscribe_count   as number) ?? 0,
    openRatePct:        (row.open_rate_pct       as number | null) ?? null,
    replyRatePct:       (row.reply_rate_pct      as number | null) ?? null,
    bounceRatePct:      (row.bounce_rate_pct     as number | null) ?? null,
  };
}

export function fromDomainSnapshotRow(row: Record<string, unknown>): DomainHealthSnapshot {
  return {
    id:                row.id                  as string,
    clientId:          row.client_id           as string,
    provider:          row.provider            as string,
    domain:            row.domain              as string,
    takenAt:           row.taken_at            as string,
    isBaseline:        row.is_baseline         as boolean,
    inboxCount:        (row.inbox_count        as number) ?? 0,
    healthyInboxCount: (row.healthy_inbox_count as number) ?? 0,
    blockedInboxCount: (row.blocked_inbox_count as number) ?? 0,
  };
}

export function fromInboxSnapshotRow(row: Record<string, unknown>): InboxHealthSnapshot {
  return {
    id:               row.id               as string,
    clientId:         row.client_id        as string,
    provider:         row.provider         as string,
    platformInboxId:  row.platform_inbox_id as string,
    inboxEmail:       (row.inbox_email     as string | null) ?? null,
    takenAt:          row.taken_at         as string,
    isBaseline:       row.is_baseline      as boolean,
    warmupStatus:     (row.warmup_status   as string | null) ?? null,
    warmupReputation: (row.warmup_reputation as string | null) ?? null,
    smtpOk:           (row.smtp_ok         as boolean | null) ?? null,
    imapOk:           (row.imap_ok         as boolean | null) ?? null,
    isWarmupBlocked:  (row.is_warmup_blocked as boolean | null) ?? null,
    dailySendLimit:   (row.daily_send_limit  as number | null) ?? null,
    dailySentCount:   (row.daily_sent_count  as number | null) ?? null,
    tags:             (row.tags             as string[] | null) ?? [],
  };
}

// ── Campaign health snapshots ─────────────────────────────────────────────────

/**
 * Persist a campaign health snapshot from a live provider result.
 *
 * @param clientId   The client who owns this campaign.
 * @param campaignId The campaign's UUID in OUR database (not the platform ID).
 * @param platform   The outreach platform ("smartlead", "instantly", "plusvibe").
 * @param result     The live result from OutreachProvider.getCampaignHealth().
 * @param takenAt    Snapshot timestamp. Defaults to now().
 *
 * @returns The persisted snapshot, or null if a snapshot at the same second
 *          already exists (ON CONFLICT DO NOTHING — idempotent, not an error).
 */
export async function saveCampaignHealthSnapshot(
  clientId:   string,
  campaignId: string,
  platform:   string,
  result:     CampaignHealthResult,
  takenAt:    Date = new Date(),
): Promise<CampaignHealthSnapshot | null> {
  const db = getSupabaseAdmin();

  // Check if this is the first snapshot for this (client, campaign) pair
  const { data: existing } = await db
    .from(CAMPAIGN_TABLE)
    .select("id")
    .eq("client_id",  clientId)
    .eq("campaign_id", campaignId)
    .limit(1)
    .maybeSingle();

  const isBaseline = existing === null;

  const row: Record<string, unknown> = {
    client_id:            clientId,
    campaign_id:          campaignId,
    platform,
    platform_campaign_id: result.platformCampaignId,
    taken_at:             takenAt.toISOString(),
    is_baseline:          isBaseline,
    campaign_status:      result.status,
    sent_count:           result.stats.sent,
    open_count:           result.stats.opens,
    click_count:          result.stats.clicks,
    reply_count:          result.stats.replies,
    bounce_count:         result.stats.bounces,
    unsubscribe_count:    result.stats.unsubscribes,
    open_rate_pct:        result.stats.sent > 0 ? result.openRatePct : null,
    reply_rate_pct:       result.stats.sent > 0 ? result.replyRatePct : null,
    bounce_rate_pct:      result.stats.sent > 0 ? result.bounceRatePct : null,
  };

  const { data, error } = await db
    .from(CAMPAIGN_TABLE)
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    // Unique constraint violation = snapshot already exists at this timestamp (idempotent skip)
    if (error.code === "23505") return null;
    throw new Error(`saveCampaignHealthSnapshot failed: ${error.message}`);
  }

  if (!data) return null;
  return fromCampaignSnapshotRow(data as Record<string, unknown>);
}

/**
 * Fetch all campaign health snapshots for a client+campaign, newest first.
 * @param opts.limit  Max rows to return. Defaults to 90 (3 months of daily snapshots).
 */
export async function getCampaignHealthSnapshots(
  clientId:   string,
  campaignId: string,
  opts: { limit?: number } = {},
): Promise<CampaignHealthSnapshot[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(CAMPAIGN_TABLE)
    .select("*")
    .eq("client_id",   clientId)
    .eq("campaign_id", campaignId)
    .order("taken_at", { ascending: false })
    .limit(opts.limit ?? 90);

  if (error) throw new Error(`getCampaignHealthSnapshots failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromCampaignSnapshotRow);
}

/** Returns the baseline snapshot for a campaign, or null if none exists. */
export async function getBaselineCampaignSnapshot(
  clientId:   string,
  campaignId: string,
): Promise<CampaignHealthSnapshot | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(CAMPAIGN_TABLE)
    .select("*")
    .eq("client_id",   clientId)
    .eq("campaign_id", campaignId)
    .eq("is_baseline", true)
    .maybeSingle();

  if (error) throw new Error(`getBaselineCampaignSnapshot failed: ${error.message}`);
  if (!data) return null;
  return fromCampaignSnapshotRow(data as Record<string, unknown>);
}

/** Returns the most recent campaign health snapshot, or null. */
export async function getLatestCampaignSnapshot(
  clientId:   string,
  campaignId: string,
): Promise<CampaignHealthSnapshot | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(CAMPAIGN_TABLE)
    .select("*")
    .eq("client_id",   clientId)
    .eq("campaign_id", campaignId)
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getLatestCampaignSnapshot failed: ${error.message}`);
  if (!data) return null;
  return fromCampaignSnapshotRow(data as Record<string, unknown>);
}

// ── Domain health snapshots ───────────────────────────────────────────────────

/**
 * Persist a domain health snapshot from a live provider result.
 *
 * @returns The persisted snapshot, or null if a conflict at same timestamp (idempotent).
 */
export async function saveDomainHealthSnapshot(
  clientId: string,
  provider: string,
  result:   DomainHealthResult,
  takenAt:  Date = new Date(),
): Promise<DomainHealthSnapshot | null> {
  const db = getSupabaseAdmin();

  const { data: existing } = await db
    .from(DOMAIN_TABLE)
    .select("id")
    .eq("client_id", clientId)
    .eq("provider",  provider)
    .eq("domain",    result.domain)
    .limit(1)
    .maybeSingle();

  const isBaseline = existing === null;

  const row: Record<string, unknown> = {
    client_id:            clientId,
    provider,
    domain:               result.domain,
    taken_at:             takenAt.toISOString(),
    is_baseline:          isBaseline,
    inbox_count:          result.inboxCount,
    // Use the provider's pre-computed value — SmartleadAdapter calculates this
    // as inboxes.filter(smtpOk && imapOk).length. No need to re-filter here.
    healthy_inbox_count:  result.healthyInboxCount,
    blocked_inbox_count:  result.blockedInboxCount,
  };

  const { data, error } = await db
    .from(DOMAIN_TABLE)
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return null;
    throw new Error(`saveDomainHealthSnapshot failed: ${error.message}`);
  }

  if (!data) return null;
  return fromDomainSnapshotRow(data as Record<string, unknown>);
}

/** Fetch domain health snapshots, newest first. */
export async function getDomainHealthSnapshots(
  clientId: string,
  provider: string,
  domain:   string,
  opts: { limit?: number } = {},
): Promise<DomainHealthSnapshot[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(DOMAIN_TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("provider",  provider)
    .eq("domain",    domain)
    .order("taken_at", { ascending: false })
    .limit(opts.limit ?? 90);

  if (error) throw new Error(`getDomainHealthSnapshots failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromDomainSnapshotRow);
}

/** Returns the baseline domain snapshot, or null. */
export async function getBaselineDomainSnapshot(
  clientId: string,
  provider: string,
  domain:   string,
): Promise<DomainHealthSnapshot | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(DOMAIN_TABLE)
    .select("*")
    .eq("client_id",   clientId)
    .eq("provider",    provider)
    .eq("domain",      domain)
    .eq("is_baseline", true)
    .maybeSingle();

  if (error) throw new Error(`getBaselineDomainSnapshot failed: ${error.message}`);
  if (!data) return null;
  return fromDomainSnapshotRow(data as Record<string, unknown>);
}

/**
 * Returns the latest domain health snapshot for each domain of a given provider.
 * Used by Stage 25 to aggregate healthy inbox counts without knowing individual domains.
 *
 * Implementation: fetches recent rows ordered by taken_at DESC, deduplicates by domain
 * (first occurrence = most recent). Limit 500 covers up to 500 domain entries per provider.
 */
export async function getLatestDomainSnapshotsByProvider(
  clientId: string,
  provider: string,
): Promise<DomainHealthSnapshot[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(DOMAIN_TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("provider",  provider)
    .order("taken_at", { ascending: false })
    .limit(500);

  if (error) throw new Error(`getLatestDomainSnapshotsByProvider failed: ${error.message}`);

  const seen = new Set<string>();
  const results: DomainHealthSnapshot[] = [];
  for (const row of (data as Record<string, unknown>[])) {
    const snap = fromDomainSnapshotRow(row);
    if (!seen.has(snap.domain)) {
      seen.add(snap.domain);
      results.push(snap);
    }
  }
  return results;
}

/** Returns the most recent domain snapshot, or null. */
export async function getLatestDomainSnapshot(
  clientId: string,
  provider: string,
  domain:   string,
): Promise<DomainHealthSnapshot | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(DOMAIN_TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("provider",  provider)
    .eq("domain",    domain)
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getLatestDomainSnapshot failed: ${error.message}`);
  if (!data) return null;
  return fromDomainSnapshotRow(data as Record<string, unknown>);
}

// ── Inbox health snapshots ────────────────────────────────────────────────────

/**
 * Persist an inbox health snapshot from a live provider result.
 *
 * @returns The persisted snapshot, or null if a conflict at same timestamp (idempotent).
 */
export async function saveInboxHealthSnapshot(
  clientId: string,
  provider: string,
  result:   InboxHealthResult,
  takenAt:  Date = new Date(),
): Promise<InboxHealthSnapshot | null> {
  const db = getSupabaseAdmin();

  const { data: existing } = await db
    .from(INBOX_TABLE)
    .select("id")
    .eq("client_id",        clientId)
    .eq("provider",         provider)
    .eq("platform_inbox_id", result.platformInboxId)
    .limit(1)
    .maybeSingle();

  const isBaseline = existing === null;

  const row: Record<string, unknown> = {
    client_id:         clientId,
    provider,
    platform_inbox_id: result.platformInboxId,
    inbox_email:       result.email || null,
    taken_at:          takenAt.toISOString(),
    is_baseline:       isBaseline,
    warmup_status:     result.warmupStatus,
    warmup_reputation: result.warmupReputation,
    smtp_ok:           result.smtpOk,
    imap_ok:           result.imapOk,
    is_warmup_blocked: result.isWarmupBlocked,
    daily_send_limit:  result.dailySendLimit,
    daily_sent_count:  result.dailySentCount,
    tags:              result.tags,
  };

  const { data, error } = await db
    .from(INBOX_TABLE)
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return null;
    throw new Error(`saveInboxHealthSnapshot failed: ${error.message}`);
  }

  if (!data) return null;
  return fromInboxSnapshotRow(data as Record<string, unknown>);
}

/** Fetch inbox health snapshots, newest first. */
export async function getInboxHealthSnapshots(
  clientId:        string,
  provider:        string,
  platformInboxId: string,
  opts: { limit?: number } = {},
): Promise<InboxHealthSnapshot[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(INBOX_TABLE)
    .select("*")
    .eq("client_id",         clientId)
    .eq("provider",          provider)
    .eq("platform_inbox_id", platformInboxId)
    .order("taken_at", { ascending: false })
    .limit(opts.limit ?? 90);

  if (error) throw new Error(`getInboxHealthSnapshots failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromInboxSnapshotRow);
}

/** Returns the baseline inbox snapshot, or null. */
export async function getBaselineInboxSnapshot(
  clientId:        string,
  provider:        string,
  platformInboxId: string,
): Promise<InboxHealthSnapshot | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(INBOX_TABLE)
    .select("*")
    .eq("client_id",         clientId)
    .eq("provider",          provider)
    .eq("platform_inbox_id", platformInboxId)
    .eq("is_baseline",       true)
    .maybeSingle();

  if (error) throw new Error(`getBaselineInboxSnapshot failed: ${error.message}`);
  if (!data) return null;
  return fromInboxSnapshotRow(data as Record<string, unknown>);
}

/** Returns the most recent inbox snapshot, or null. */
export async function getLatestInboxSnapshot(
  clientId:        string,
  provider:        string,
  platformInboxId: string,
): Promise<InboxHealthSnapshot | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(INBOX_TABLE)
    .select("*")
    .eq("client_id",         clientId)
    .eq("provider",          provider)
    .eq("platform_inbox_id", platformInboxId)
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getLatestInboxSnapshot failed: ${error.message}`);
  if (!data) return null;
  return fromInboxSnapshotRow(data as Record<string, unknown>);
}
