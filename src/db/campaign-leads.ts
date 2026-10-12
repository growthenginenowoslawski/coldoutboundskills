/**
 * Persistence layer for the `campaign_leads` table — Stage 19B.
 *
 * campaign_leads tracks which contacts have been enrolled in each campaign.
 * One row = one contact enrolled in one campaign.
 *
 * ── DB constraints relied upon ────────────────────────────────────────────────
 *
 * UNIQUE (campaign_id, contact_id): enforced by a btree index and constraint
 *   campaign_leads_campaign_id_contact_id_key. Confirmed live via Management API
 *   inspection (Stage 19B pre-work). Concurrent enrollments for the same pair
 *   result in exactly one inserted row — the loser gets an ON CONFLICT skip.
 *
 * FK (client_id, campaign_id) → campaigns(client_id, id): composite FK enforced
 *   by campaign_leads_client_campaign_fk. Prevents insertion of a campaign_leads
 *   row where client_id does not match the campaign's actual client. This is a
 *   DB-level tenant integrity check — no application-layer workaround can bypass it.
 *
 * STATUS CHECK: status must be one of:
 *   ready | uploaded | queued | sending | sent |
 *   replied | positive_reply | negative_reply | bounced | unsubscribed | stopped
 *
 * ── No triggers ───────────────────────────────────────────────────────────────
 *
 * There are no DB triggers on campaign_leads (confirmed live). updated_at must
 * be set explicitly on every INSERT or UPDATE.
 *
 * ── FINDING 6 (open) ──────────────────────────────────────────────────────────
 *
 * RLS is enabled on campaign_leads but zero policies are defined. service_role
 * (used throughout) bypasses RLS — no application impact today. See
 * docs/supabase/25-SUPABASE-SECURITY.md FINDING 6. Do not add policies without
 * explicit approval.
 *
 * ── Excluded by design (Stage 19B) ───────────────────────────────────────────
 *
 * No email sends. No provider API calls. No campaign status mutations.
 * No cascade deletes (campaigns.ON DELETE CASCADE handles cleanup automatically).
 */

import { getSupabaseAdmin } from "./supabase";

const TABLE = "campaign_leads" as const;

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * All valid values for campaign_leads.status.
 * Matches the live DB CHECK constraint campaign_leads_status_check (confirmed Stage 19B).
 *
 * Newly enrolled leads always start as 'ready'.
 */
export type CampaignLeadStatus =
  | "ready"
  | "uploaded"
  | "queued"
  | "sending"
  | "sent"
  | "replied"
  | "positive_reply"
  | "negative_reply"
  | "bounced"
  | "unsubscribed"
  | "stopped";

export interface CampaignLeadRow {
  id:             string;
  campaignId:     string;
  contactId:      string;
  clientId:       string;
  status:         CampaignLeadStatus;
  platformLeadId: string | null;
  sentAt:         string | null;
  repliedAt:      string | null;
  replyType:      string | null;
  createdAt:      string;
  updatedAt:      string;
}

// ── Pure mapper ───────────────────────────────────────────────────────────────

export function fromCampaignLeadRow(row: Record<string, unknown>): CampaignLeadRow {
  return {
    id:             row.id              as string,
    campaignId:     row.campaign_id     as string,
    contactId:      row.contact_id      as string,
    clientId:       row.client_id       as string,
    status:         row.status          as CampaignLeadStatus,
    platformLeadId: (row.platform_lead_id as string | null) ?? null,
    sentAt:         (row.sent_at         as string | null) ?? null,
    repliedAt:      (row.replied_at      as string | null) ?? null,
    replyType:      (row.reply_type      as string | null) ?? null,
    createdAt:      row.created_at       as string,
    updatedAt:      row.updated_at       as string,
  };
}

// ── Writes ─────────────────────────────────────────────────────────────────────

/**
 * Batch-insert contacts into campaign_leads using ON CONFLICT (campaign_id, contact_id)
 * DO NOTHING for atomic idempotency.
 *
 * Returns only the rows that were newly inserted. Contacts already enrolled
 * (ON CONFLICT skip) do not appear in the return value. The caller infers
 * "already enrolled" from the difference between submitted and returned IDs.
 *
 * Explicitly sets updated_at on every row — no DB trigger exists for this.
 *
 * The composite FK (client_id, campaign_id) → campaigns(client_id, id) provides
 * DB-level tenant integrity: an invalid (client_id, campaign_id) pair causes the
 * entire batch to fail with a foreign key violation, not a silent skip.
 *
 * Initial status is always 'ready' — the only valid status for a new enrollment.
 */
export async function insertCampaignLeads(
  rows: Array<{
    campaignId: string;
    contactId:  string;
    clientId:   string;
    now:        string; // ISO 8601 — set explicitly (no trigger)
  }>,
): Promise<Array<{ id: string; contactId: string; createdAt: string }>> {
  if (rows.length === 0) return [];

  const insertRows = rows.map((r) => ({
    campaign_id: r.campaignId,
    contact_id:  r.contactId,
    client_id:   r.clientId,
    status:      "ready" as const,
    created_at:  r.now,
    updated_at:  r.now,
  }));

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .upsert(insertRows, { onConflict: "campaign_id,contact_id", ignoreDuplicates: true })
    .select("id, contact_id, created_at");

  if (error) throw new Error(`insertCampaignLeads failed: ${error.message}`);

  return (data as Array<{ id: string; contact_id: string; created_at: string }>).map(
    (r) => ({ id: r.id, contactId: r.contact_id, createdAt: r.created_at }),
  );
}

// ── Reads ──────────────────────────────────────────────────────────────────────

/**
 * Count the number of contacts enrolled in a campaign.
 *
 * Client-scoped via .eq("client_id") as defence-in-depth.
 * The composite FK means the DB-level count is already client-correct.
 */
export async function getCampaignLeadCount(
  campaignId: string,
  clientId:   string,
): Promise<number> {
  const { count, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("client_id",   clientId);

  if (error) throw new Error(`getCampaignLeadCount failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Fetch campaign_leads rows with status='ready' for a campaign, ordered by
 * created_at ASC (oldest first — process in enrollment order).
 *
 * Client-scoped via .eq("client_id") as defence-in-depth.
 * Only 'ready' rows are returned — 'uploaded', 'sent', etc. are excluded.
 *
 * Used exclusively by Stage 20 lead-upload orchestrator.
 * limit is optional; when omitted all ready leads are returned.
 */
export async function getReadyLeadsForUpload(
  campaignId: string,
  clientId:   string,
  limit?:     number,
): Promise<CampaignLeadRow[]> {
  let query = getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("client_id",   clientId)
    .eq("status",      "ready")
    .order("created_at", { ascending: true });

  if (limit !== undefined) query = query.limit(limit);

  const { data, error } = await query;
  if (error) throw new Error(`getReadyLeadsForUpload failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromCampaignLeadRow);
}

/**
 * Transition a set of campaign_leads rows from 'ready' to 'uploaded'.
 *
 * The WHERE clause includes status='ready' as a safety guard — a row that
 * was already marked 'uploaded' (e.g. by a concurrent run) is silently
 * skipped by Postgres rather than double-written.
 *
 * updated_at is set explicitly — no DB trigger exists on campaign_leads.
 *
 * leadIds must originate from a client-scoped read (getReadyLeadsForUpload).
 * Client isolation is enforced at the read boundary; no client_id filter is
 * added here to keep the UPDATE simple and fast (IDs are already trusted).
 */
export async function markLeadsUploaded(
  leadIds: string[],
  now:     string, // ISO 8601 — set explicitly (no trigger)
): Promise<void> {
  if (leadIds.length === 0) return;

  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ status: "uploaded", updated_at: now })
    .in("id", leadIds)
    .eq("status", "ready"); // safety guard: only advance rows that are still 'ready'

  if (error) throw new Error(`markLeadsUploaded failed: ${error.message}`);
}

/**
 * Fetch all campaign_leads rows for a campaign with status='uploaded'.
 *
 * Used by Stage 21A platform_lead_id backfill. Returns rows regardless of
 * whether platform_lead_id is already set — the orchestrator decides whether
 * to skip or update each row.
 *
 * Client-scoped via .eq("client_id") as defence-in-depth.
 */
export async function getUploadedLeads(
  campaignId: string,
  clientId:   string,
): Promise<CampaignLeadRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("client_id",   clientId)
    .eq("status",      "uploaded")
    .order("created_at", { ascending: true });

  if (error) throw new Error(`getUploadedLeads failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromCampaignLeadRow);
}

/**
 * Write the provider-assigned campaign_lead_map_id back to platform_lead_id.
 *
 * Only updates platform_lead_id and updated_at. Does NOT touch status,
 * sent_at, replied_at, or reply_type — those are managed by the outcome
 * sync (Stage 21B+).
 *
 * The caller (backfillPlatformLeadIds) is responsible for skipping rows
 * where platform_lead_id already matches — this function writes unconditionally
 * given a leadId. No trigger exists; updated_at must be set explicitly.
 */
export async function updateLeadPlatformId(
  leadId:         string,
  platformLeadId: string,
  now:            string, // ISO 8601
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ platform_lead_id: platformLeadId, updated_at: now })
    .eq("id", leadId);

  if (error) throw new Error(`updateLeadPlatformId failed: ${error.message}`);
}

/**
 * Fetch campaign_leads rows for a campaign, filtered to a specific set of contactIds.
 * Returns a Map<contactId, CampaignLeadRow> for O(1) lookup.
 *
 * Used to verify enrollment outcomes in integration tests.
 * Client-scoped via .eq("client_id").
 */
export async function getCampaignLeadsByContactIds(
  campaignId:  string,
  clientId:    string,
  contactIds:  string[],
): Promise<Map<string, CampaignLeadRow>> {
  if (contactIds.length === 0) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("client_id",   clientId)
    .in("contact_id",  contactIds);

  if (error) throw new Error(`getCampaignLeadsByContactIds failed: ${error.message}`);

  const result = new Map<string, CampaignLeadRow>();
  for (const row of (data as Record<string, unknown>[] ?? [])) {
    const lead = fromCampaignLeadRow(row);
    result.set(lead.contactId, lead);
  }
  return result;
}
