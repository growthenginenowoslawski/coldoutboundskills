/**
 * Persistence layer for the `contact_suppression` table — Stage 15.
 *
 * Contact suppression is the per-client safety gate that prevents a contact
 * from being enrolled in campaigns. A contact is suppressed when:
 *
 *   expires_at IS NULL        → permanent suppression (always blocks eligibility)
 *   expires_at > now()        → timed-active suppression (blocks until that time)
 *   expires_at <= now()       → expired/historical ONLY (does NOT block eligibility)
 *
 * This distinction is always evaluated at check time — there is no background
 * job that flips suppression state; the eligibility check re-evaluates the
 * condition on every call.
 *
 * ── Tenant isolation ─────────────────────────────────────────────────────────
 *
 * Suppression is per-client. Client A's suppression of contact X has no effect
 * on client B's ability to contact X. The same contact can be suppressed by
 * one client and eligible for another simultaneously.
 *
 * All reads and writes include .eq("client_id", clientId) as defence-in-depth.
 *
 * ── Future global do-not-contact ─────────────────────────────────────────────
 *
 * A future global DNC mechanism (e.g. GDPR erasure, cross-client opt-out) will
 * be implemented as a SEPARATE table (e.g. `global_contact_suppression`) checked
 * BEFORE this table in any eligibility check. No schema change to contact_suppression
 * is needed for that extension. See isContactSuppressed() for the hook point.
 *
 * ── RLS status ───────────────────────────────────────────────────────────────
 *
 * RLS is enabled on contact_suppression; no policies are defined yet.
 * service_role (used throughout) bypasses RLS — no application impact.
 * Authenticated tenant policies are added when auth/tenant mapping is finalised.
 * See docs/supabase/25-SUPABASE-SECURITY.md.
 */

import { getSupabaseAdmin } from "./supabase";

const TABLE = "contact_suppression" as const;

// ── Types ──────────────────────────────────────────────────────────────────────

export type SuppressionReason =
  | "unsubscribed"
  | "negative_reply"
  | "hard_bounce"
  | "do_not_contact"
  | "manual";

/** All valid suppression reason values — matches the DB CHECK constraint. */
export const VALID_SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  "unsubscribed",
  "negative_reply",
  "hard_bounce",
  "do_not_contact",
  "manual",
];

export interface ContactSuppressionRow {
  id:               string;
  /** Tenant owner — suppression is per-client, not global. */
  clientId:         string;
  /** The contact being suppressed. contacts is a global table (no client_id). */
  contactId:        string;
  reason:           SuppressionReason;
  /** Who or what created this suppression. Free text; null when not specified. */
  suppressedBy:     string | null;
  /**
   * Which campaign triggered this suppression, if applicable.
   * Null when suppression was created outside a campaign context (e.g. manual DNC).
   * Set to null on campaign deletion (ON DELETE SET NULL).
   */
  sourceCampaignId: string | null;
  /**
   * Active suppression semantics:
   *   null      → permanent (always blocks eligibility)
   *   timestamp → suppressed until this time; after it, record is historical only
   *
   * Eligibility check: expires_at IS NULL OR expires_at > now()
   * Expired records do NOT block eligibility — they are audit history.
   */
  expiresAt:        string | null;
  notes:            string | null;
  createdAt:        string;
  updatedAt:        string;
}

// ── Pure predicates (exported for testing without a DB) ───────────────────────

/**
 * Returns true when the given suppression record is currently active.
 *
 * Active = permanent (expiresAt === null) OR timed and not yet expired
 *          (expiresAt > now).
 *
 * Expired records (expiresAt <= now) return false — they are historical
 * and do NOT block contact eligibility.
 *
 * @param record  A ContactSuppressionRow (or any object with expiresAt).
 * @param now     Wall-clock time for the expiry comparison. Defaults to
 *                new Date(). Pass a fixed value in tests for determinism.
 */
export function isActiveSuppression(
  record: Pick<ContactSuppressionRow, "expiresAt">,
  now: Date = new Date(),
): boolean {
  if (record.expiresAt === null) return true;            // permanent
  return new Date(record.expiresAt) > now;              // timed, not yet expired
}

/**
 * Returns true when at least one record in the array is an active suppression.
 *
 * Pass the full set of suppression records for a (client, contact) pair.
 * Returns false immediately when records is empty.
 *
 * @param records  All ContactSuppressionRow entries for one (client, contact).
 * @param now      Wall-clock time. Defaults to new Date(). Pass a fixed value
 *                 in tests for determinism.
 */
export function isContactSuppressedFromRecords(
  records: Pick<ContactSuppressionRow, "expiresAt">[],
  now: Date = new Date(),
): boolean {
  return records.some((r) => isActiveSuppression(r, now));
}

// ── Pure mapper ───────────────────────────────────────────────────────────────

/**
 * Maps a raw Supabase row → ContactSuppressionRow domain object.
 * Pure — no I/O.
 */
export function fromContactSuppressionRow(
  row: Record<string, unknown>,
): ContactSuppressionRow {
  return {
    id:               row.id                 as string,
    clientId:         row.client_id          as string,
    contactId:        row.contact_id         as string,
    reason:           row.reason             as SuppressionReason,
    suppressedBy:     (row.suppressed_by     as string | null) ?? null,
    sourceCampaignId: (row.source_campaign_id as string | null) ?? null,
    expiresAt:        (row.expires_at        as string | null) ?? null,
    notes:            (row.notes             as string | null) ?? null,
    createdAt:        row.created_at         as string,
    updatedAt:        row.updated_at         as string,
  };
}

// ── Async persistence ─────────────────────────────────────────────────────────

/**
 * Add a suppression record for a contact under a client.
 *
 * Permanent suppression (expiresAt === undefined or null):
 *   The DB partial unique index `contact_suppression_permanent_uq` —
 *   UNIQUE(client_id, contact_id) WHERE expires_at IS NULL — prevents
 *   duplicate permanent suppressions. A second permanent suppress throws at
 *   the DB level. Call liftSuppression() first if you need to re-suppress.
 *
 * Timed suppression (expiresAt is an ISO timestamp):
 *   No DB uniqueness constraint — multiple timed records can coexist.
 *   The application is responsible for deduplication if needed.
 *
 * Client isolation: clientId is set on the row; no cross-client write is
 * possible without a valid clients.id.
 *
 * @param opts.expiresAt  null or omitted → permanent; ISO timestamp → timed.
 */
export async function suppressContact(
  clientId:  string,
  contactId: string,
  opts: {
    reason:            SuppressionReason;
    suppressedBy?:     string;
    sourceCampaignId?: string;
    expiresAt?:        string | null;
    notes?:            string;
  },
): Promise<ContactSuppressionRow> {
  const row: Record<string, unknown> = {
    client_id:  clientId,
    contact_id: contactId,
    reason:     opts.reason,
  };

  if (opts.suppressedBy     !== undefined) row.suppressed_by      = opts.suppressedBy;
  if (opts.sourceCampaignId !== undefined) row.source_campaign_id = opts.sourceCampaignId;
  // expires_at null = permanent; omitting also means permanent (DB default is null)
  row.expires_at = opts.expiresAt ?? null;
  if (opts.notes            !== undefined) row.notes              = opts.notes;

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(`suppressContact failed: ${error.message}`);
  return fromContactSuppressionRow(data as Record<string, unknown>);
}

/**
 * Lift a suppression by setting expires_at = now (making it historical).
 *
 * The record is NOT deleted — it is retained as audit history. After this call
 * the record has expires_at <= now(), so isActiveSuppression returns false
 * and the contact is eligible for enrollment again.
 *
 * Client isolation: .eq("client_id") prevents lifting another client's record.
 *
 * @param suppressionId  UUID of the contact_suppression row to lift.
 */
export async function liftSuppression(
  clientId:      string,
  suppressionId: string,
): Promise<void> {
  const now = new Date().toISOString();

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ expires_at: now, updated_at: now })
    .eq("client_id", clientId)
    .eq("id",        suppressionId)
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`liftSuppression failed: ${error.message}`);
  if (!data) {
    throw new Error(
      `liftSuppression found no record id=${suppressionId} for client=${clientId}`,
    );
  }
}

/**
 * Check whether a contact is currently suppressed for a client.
 *
 * Returns true when at least one active suppression record exists:
 *   expires_at IS NULL (permanent) OR expires_at > now().
 *
 * Expired records (expires_at <= now()) do NOT count — they are historical.
 *
 * ── Future global DNC hook ────────────────────────────────────────────────────
 * A future global do-not-contact check would run BEFORE this function:
 *   if (await isGloballyDNC(contactId)) return true;
 * No schema change to contact_suppression is needed for that extension.
 *
 * Client isolation: always scoped to clientId.
 *
 * @param now  Override for testing. Defaults to new Date().
 */
export async function isContactSuppressed(
  clientId:  string,
  contactId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const records = await getSuppressionRecords(clientId, contactId);
  return isContactSuppressedFromRecords(records, now);
}

/**
 * Fetch all suppression records for a (client, contact) pair — active AND
 * historical — ordered by created_at DESC.
 *
 * Returns an empty array when no records exist.
 *
 * Use this when you need the full audit trail. For a binary eligibility check,
 * use isContactSuppressed() which applies isContactSuppressedFromRecords().
 *
 * Client isolation: .eq("client_id") scopes the result.
 */
export async function getSuppressionRecords(
  clientId:  string,
  contactId: string,
): Promise<ContactSuppressionRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id",  clientId)
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getSuppressionRecords failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromContactSuppressionRow);
}

/**
 * Return the first active suppression record for a (client, contact) pair, or
 * null when the contact is not suppressed.
 *
 * "Active" = expires_at IS NULL (permanent) OR expires_at > now().
 *
 * Fetches all records and evaluates locally — avoids a computed-column query
 * that PostgREST cannot express. For a binary suppression check, use
 * isContactSuppressed() instead.
 *
 * Client isolation: scoped to clientId.
 *
 * @param now  Override for testing. Defaults to new Date().
 */
export async function getActiveSuppression(
  clientId:  string,
  contactId: string,
  now: Date = new Date(),
): Promise<ContactSuppressionRow | null> {
  const records = await getSuppressionRecords(clientId, contactId);
  return records.find((r) => isActiveSuppression(r, now)) ?? null;
}
