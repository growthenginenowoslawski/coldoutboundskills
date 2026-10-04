/**
 * Since-cursor computation for incremental signal ingestion — Stage 13.
 *
 * The cursor is the maximum detected_at across all signals for a given
 * (client, company set, provider) triple. It is passed to a signal provider
 * as FetchOptions.since so the provider can skip events it has already served.
 *
 * ── Cursor semantics ──────────────────────────────────────────────────────────
 *
 * PredictLeads performs a client-side filter using its own detection timestamps:
 *   job_openings    → filters on first_seen_at (when PredictLeads indexed the job)
 *   financing_events → filters on found_at     (when PredictLeads found the event)
 *
 * Our signals.detected_at is our local ingestion time — set in normalizeEvent()
 * to new Date().toISOString() at processing time. It approximates the moment we
 * finished fetching from PredictLeads (detected_at ≈ T_run). Any event PredictLeads
 * newly indexes after T_run will have first_seen_at > T_run, so it passes the
 * since filter on the next run.
 *
 * ── Correctness guarantee ─────────────────────────────────────────────────────
 *
 * The cursor is a fetch-optimisation only. Three-tier deduplication in
 * upsertSignal() is the authoritative guard against duplicate rows. Even if
 * the cursor is imprecise (e.g. PredictLeads backfills an event with a backdated
 * first_seen_at), a subsequent full-fetch run (since=null for a new company)
 * will catch it, and dedup prevents double storage.
 *
 * ── No new schema ────────────────────────────────────────────────────────────
 *
 * signals.detected_at is the correct field — no cursor table is needed.
 * The cursor is derived from existing signal rows on every call.
 */

import { getSupabaseAdmin } from "../db/supabase";

/**
 * Compute the since-cursor for a batch of companies under one client and provider.
 *
 * Returns the maximum detected_at seen for any signal matching
 * (client_id = clientId, company_id IN companyIds, signal_source = providerId).
 *
 * Returns null when:
 *   - companyIds is empty
 *   - No signals have been ingested yet for this (client, companies, provider) set
 *
 * A null cursor causes the provider to return all available history — correct
 * for a first-time run or when new companies are added to the tracked set.
 */
export async function getSinceCursor(
  clientId: string,
  companyIds: string[],
  providerId: string,
): Promise<string | null> {
  if (companyIds.length === 0) return null;

  const { data, error } = await getSupabaseAdmin()
    .from("signals")
    .select("detected_at")
    .eq("client_id", clientId)
    .in("company_id", companyIds)
    .eq("signal_source", providerId)
    .order("detected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getSinceCursor failed: ${error.message}`);
  if (!data) return null;
  return (data as { detected_at: string }).detected_at;
}
