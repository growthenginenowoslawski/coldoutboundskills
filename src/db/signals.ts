/**
 * Supabase persistence layer for the `signals` table.
 *
 * Follows the same pattern as src/db/qualifications.ts:
 *   - Pure row-builder functions exported for testing without a DB
 *   - Async functions that call getSupabaseAdmin()
 *   - Idempotent upsert: duplicate dedup_key returns the existing row
 */

import type { NormalizedSignal, SignalRow, SignalStatus } from "../domain/signal-types";
import { getSupabaseAdmin } from "./supabase";

const TABLE = "signals";

// ── Row mapping (pure, no I/O) ────────────────────────────────────────────────

/** Maps NormalizedSignal → DB row dict. Pure — safe to test without a DB. */
export function buildSignalRow(signal: NormalizedSignal): Record<string, unknown> {
  return {
    client_id:          signal.clientId,
    company_id:         signal.companyId,
    signal_type:        signal.signalType,
    signal_source:      signal.signalSource,
    signal_title:       signal.signalTitle,
    signal_description: signal.signalDescription,
    evidence:           signal.evidence,
    signal_strength:    signal.signalStrength,
    confidence:         signal.confidence,
    occurred_at:        signal.occurredAt,
    detected_at:        signal.detectedAt,
    expires_at:         signal.expiresAt,
    source_url:         signal.sourceUrl,
    status:             signal.status,
    metadata:           signal.metadata,
    dedup_key:          signal.dedupKey,
  };
}

/** Maps a DB row → SignalRow domain object. Pure — safe to test without a DB. */
export function fromDbRow(row: Record<string, unknown>): SignalRow {
  return {
    id:                 row.id as string,
    clientId:           row.client_id as string,
    companyId:          row.company_id as string,
    signalType:         row.signal_type as SignalRow["signalType"],
    signalSource:       row.signal_source as string,
    signalTitle:        row.signal_title as string,
    signalDescription:  (row.signal_description as string | null) ?? null,
    evidence:           (row.evidence as Record<string, unknown>) ?? {},
    signalStrength:     row.signal_strength as number,
    confidence:         Number(row.confidence),
    occurredAt:         row.occurred_at as string,
    detectedAt:         row.detected_at as string,
    expiresAt:          row.expires_at as string,
    sourceUrl:          (row.source_url as string | null) ?? null,
    status:             row.status as SignalStatus,
    metadata:           (row.metadata as Record<string, unknown> | null) ?? null,
    dedupKey:           (row.dedup_key as string | null) ?? null,
    createdAt:          row.created_at as string,
  };
}

// ── Async persistence ─────────────────────────────────────────────────────────

/**
 * Insert a normalized signal.
 * Throws on any DB error including duplicate dedup_key.
 * Use upsertSignal for idempotent inserts.
 */
export async function insertSignal(signal: NormalizedSignal): Promise<SignalRow> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from(TABLE)
    .insert(buildSignalRow(signal))
    .select()
    .single();
  if (error) throw new Error(`insertSignal failed: ${error.message}`);
  return fromDbRow(data as Record<string, unknown>);
}

/**
 * Insert-or-find a signal using the dedup_key.
 *
 * When the (client_id, dedup_key) unique index fires (error 23505):
 *   → returns the existing row with created: false.
 *
 * When dedup_key is null (tier-3 events with no fingerprint):
 *   → always inserts a new row; no uniqueness is enforced.
 */
export async function upsertSignal(
  signal: NormalizedSignal,
): Promise<{ row: SignalRow; created: boolean }> {
  const db = getSupabaseAdmin();

  const { data, error } = await db
    .from(TABLE)
    .insert(buildSignalRow(signal))
    .select()
    .single();

  if (!error) {
    return { row: fromDbRow(data as Record<string, unknown>), created: true };
  }

  if (error.code === "23505" && signal.dedupKey !== null) {
    const { data: existing, error: lookupErr } = await db
      .from(TABLE)
      .select("*")
      .eq("client_id", signal.clientId)
      .eq("dedup_key", signal.dedupKey)
      .single();

    if (lookupErr) {
      throw new Error(`upsertSignal lookup failed: ${lookupErr.message}`);
    }
    return { row: fromDbRow(existing as Record<string, unknown>), created: false };
  }

  throw new Error(`upsertSignal failed: ${error.message}`);
}

/**
 * Fetch all signals for a company under a specific client.
 * Returns in descending occurred_at order (most recent first).
 */
export async function getSignalsByCompany(
  companyId: string,
  clientId: string,
  opts: { status?: SignalStatus } = {},
): Promise<SignalRow[]> {
  const db = getSupabaseAdmin();
  let q = db
    .from(TABLE)
    .select("*")
    .eq("company_id", companyId)
    .eq("client_id", clientId)
    .order("occurred_at", { ascending: false });

  if (opts.status) q = q.eq("status", opts.status);

  const { data, error } = await q;
  if (error) throw new Error(`getSignalsByCompany failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromDbRow);
}

/**
 * Fetch all signals for a client across all companies.
 */
export async function getSignalsByClient(
  clientId: string,
  opts: { status?: SignalStatus; limit?: number } = {},
): Promise<SignalRow[]> {
  const db = getSupabaseAdmin();
  let q = db
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("occurred_at", { ascending: false });

  if (opts.status) q = q.eq("status", opts.status);
  if (opts.limit) q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) throw new Error(`getSignalsByClient failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromDbRow);
}

/**
 * Return value of expireStaleSignals.
 * affectedCompanyIds lists companies whose active signal set changed — the
 * caller (signal-ingestion, Step 6) uses these to trigger score recomputation.
 */
export interface ExpireResult {
  count: number;
  affectedCompanyIds: string[];
}

/**
 * Mark signals as "expired" when their expires_at has passed.
 * Safe to run repeatedly — only touches active signals past their deadline.
 *
 * Returns { count, affectedCompanyIds } so the caller knows which companies
 * had signals expire and can trigger opportunity score recomputation for those
 * companies only (rather than rescoring the entire client portfolio).
 */
export async function expireStaleSignals(clientId: string): Promise<ExpireResult> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({ status: "expired" })
    .eq("client_id", clientId)
    .eq("status", "active")
    .lt("expires_at", now)
    .select("id, company_id");

  if (error) throw new Error(`expireStaleSignals failed: ${error.message}`);
  const rows = data as { id: string; company_id: string }[];
  const affectedCompanyIds = [...new Set(rows.map((r) => r.company_id))];
  return { count: rows.length, affectedCompanyIds };
}

/**
 * Delete a signal by ID.
 * For test cleanup only — production signals are expired, not deleted.
 */
export async function deleteSignal(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from(TABLE).delete().eq("id", id);
  if (error) throw new Error(`deleteSignal failed: ${error.message}`);
}
