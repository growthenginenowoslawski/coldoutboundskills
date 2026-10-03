/**
 * Persistence layer for the `campaigns` table — Stage 15.
 *
 * A campaign is a client-scoped active outreach operation. It references an
 * optional strategy (campaign_strategies) that links it to the intelligence
 * layer, and an optional source list (lists) that scopes the contact pool.
 *
 * ── Tenant isolation ─────────────────────────────────────────────────────────
 *
 * Three database-level guards enforce client scoping:
 *   1. campaigns.client_id NOT NULL FK → clients(id) ON DELETE CASCADE
 *   2. UNIQUE(client_id, id) — composite FK target from campaign_leads
 *   3. Trigger check_campaign_strategy_client() — strategy must belong to same client
 *
 * All reads and writes in this module also include .eq("client_id", clientId)
 * as defence-in-depth (the DB constraint is the authoritative gate; the
 * application-layer filter prevents latent bugs from returning cross-client data).
 *
 * ── Platform note ─────────────────────────────────────────────────────────────
 *
 * campaigns.platform defaults to 'plusvibe' in the live schema.
 * The OutreachProviderAdapter (future Stage 16) will read this field to decide
 * which provider API to call for health data. Do not hardcode 'smartlead'.
 *
 * ── Excluded by design (Stage 15) ────────────────────────────────────────────
 *
 * No lead refill logic. No deliverability monitoring. No provider API calls.
 * No campaign_leads writes (enrollment is Stage 18+). No autonomous actions.
 */

import { getSupabaseAdmin } from "./supabase";

const TABLE = "campaigns" as const;

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Live DB CHECK constraint (campaigns_status_check) allows:
 *   draft | review | ready | running | paused | completed | cancelled
 *
 * Corrected in Stage 18 after live schema inspection found the TypeScript type
 * did not match the database constraint. "active" and "archived" were never
 * valid DB values — the DB uses "running" and "cancelled" respectively.
 */
export type CampaignStatus =
  | "draft"
  | "review"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export interface CampaignRow {
  id:                 string;
  /** Tenant owner. NOT NULL — every campaign belongs to exactly one client. */
  clientId:           string;
  name:               string;
  description:        string | null;
  /**
   * Which outreach platform hosts this campaign.
   * Live schema default: 'plusvibe'.
   * Do not assume 'smartlead' — read this field; do not hardcode.
   */
  platform:           string;
  /** Provider-assigned campaign ID (e.g. Smartlead campaign_id, PlusVibe ID). */
  platformCampaignId: string | null;
  /**
   * Links this campaign to a campaign_strategies row.
   * Null = strategy not yet linked; campaign is ineligible for signal-driven refill.
   * The DB trigger enforces this strategy belongs to the same client.
   */
  campaignStrategyId: string | null;
  /**
   * Source list this campaign draws contacts from.
   * Null = list not yet assigned.
   * contacts are found via: lists → list_members → contacts.
   */
  listId:             string | null;
  status:             CampaignStatus;
  dailySendLimit:     number | null;
  startDate:          string | null;
  endDate:            string | null;
  createdAt:          string;
  updatedAt:          string;
}

// ── Pure mapper ──────────────────────────────────────────────────────────────

/**
 * Maps a raw Supabase row → CampaignRow domain object.
 * Pure — no I/O; safe to test without a DB.
 */
export function fromCampaignRow(row: Record<string, unknown>): CampaignRow {
  return {
    id:                 row.id                   as string,
    clientId:           row.client_id            as string,
    name:               row.name                 as string,
    description:        (row.description         as string | null) ?? null,
    platform:           row.platform             as string,
    platformCampaignId: (row.platform_campaign_id as string | null) ?? null,
    campaignStrategyId: (row.campaign_strategy_id as string | null) ?? null,
    listId:             (row.list_id             as string | null) ?? null,
    status:             row.status               as CampaignStatus,
    dailySendLimit:     (row.daily_send_limit    as number | null) ?? null,
    startDate:          (row.start_date          as string | null) ?? null,
    endDate:            (row.end_date            as string | null) ?? null,
    createdAt:          row.created_at           as string,
    updatedAt:          row.updated_at           as string,
  };
}

// ── Async persistence ─────────────────────────────────────────────────────────

/**
 * Insert a new campaign for a client.
 *
 * DB guards that fire automatically:
 *   - client_id NOT NULL FK rejects an invalid clientId.
 *   - Trigger rejects campaignStrategyId that belongs to a different client.
 *   - listId FK rejects a non-existent list.
 *
 * Client isolation: clientId is set explicitly on the row; no cross-client
 * write is possible without a valid clients.id.
 */
export async function createCampaign(
  clientId: string,
  opts: {
    name:                string;
    description?:        string;
    platform?:           string;
    platformCampaignId?: string;
    campaignStrategyId?: string | null;
    listId?:             string | null;
    status?:             CampaignStatus;
    dailySendLimit?:     number;
    startDate?:          string;
    endDate?:            string;
  },
): Promise<CampaignRow> {
  const row: Record<string, unknown> = {
    client_id: clientId,
    name:      opts.name,
    status:    opts.status   ?? "draft",
    platform:  opts.platform ?? "plusvibe",
  };

  if (opts.description         !== undefined) row.description          = opts.description;
  if (opts.platformCampaignId  !== undefined) row.platform_campaign_id = opts.platformCampaignId;
  if (opts.campaignStrategyId  !== undefined) row.campaign_strategy_id = opts.campaignStrategyId;
  if (opts.listId              !== undefined) row.list_id              = opts.listId;
  if (opts.dailySendLimit      !== undefined) row.daily_send_limit     = opts.dailySendLimit;
  if (opts.startDate           !== undefined) row.start_date           = opts.startDate;
  if (opts.endDate             !== undefined) row.end_date             = opts.endDate;

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(`createCampaign failed: ${error.message}`);
  return fromCampaignRow(data as Record<string, unknown>);
}

/**
 * Fetch a campaign by ID, scoped to a client.
 * Returns null when the campaign does not exist or belongs to a different client.
 *
 * Client isolation: .eq("client_id") prevents cross-client reads.
 */
export async function getCampaignById(
  clientId:   string,
  campaignId: string,
): Promise<CampaignRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("id",        campaignId)
    .maybeSingle();

  if (error) throw new Error(`getCampaignById failed: ${error.message}`);
  if (!data) return null;
  return fromCampaignRow(data as Record<string, unknown>);
}

/**
 * Fetch campaigns for a client, ordered by created_at DESC.
 *
 * Client isolation: .eq("client_id") scopes the result.
 *
 * @param opts.status  Filter to a specific status. Omit to return all statuses.
 * @param opts.limit   Cap on rows returned. Defaults to 50.
 */
export async function getCampaignsByClientId(
  clientId: string,
  opts: { status?: CampaignStatus; limit?: number } = {},
): Promise<CampaignRow[]> {
  let query = getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 50);

  if (opts.status) query = query.eq("status", opts.status);

  const { data, error } = await query;
  if (error) throw new Error(`getCampaignsByClientId failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromCampaignRow);
}

/**
 * Delete a campaign by ID, scoped to a client.
 * Used in integration tests for cleanup.
 * On delete, campaign_leads rows cascade-delete automatically.
 *
 * Client isolation: .eq("client_id") prevents cross-client deletes.
 */
export async function deleteCampaign(
  clientId:   string,
  campaignId: string,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(TABLE)
    .delete()
    .eq("client_id", clientId)
    .eq("id",        campaignId);

  if (error) throw new Error(`deleteCampaign failed: ${error.message}`);
}

/**
 * Returns true when a contact is already enrolled in a campaign.
 *
 * Checks the campaign_leads table for UNIQUE(campaign_id, contact_id).
 * A contact enrolled with any status ('ready', 'sent', 'replied', etc.)
 * is considered enrolled — re-enrollment is blocked regardless of lead status.
 *
 * READ ONLY — Stage 17. No writes to campaign_leads until Stage 18+.
 */
export async function isContactEnrolledInCampaign(
  campaignId: string,
  contactId:  string,
): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("contact_id",  contactId)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`isContactEnrolledInCampaign failed: ${error.message}`);
  return data !== null;
}
