/**
 * Signal expiry task — Stage 13.
 *
 * Automatically expires signals past their TTL and rescores affected companies.
 * Closes the expiry → rescore loop that was previously only triggered manually.
 *
 * This is the entry point for a scheduled Trigger.dev task. The Trigger.dev task
 * wrapper (deployed externally) calls runSignalExpiry and stores the result in
 * jobs.output_data. This module has NO Trigger.dev imports and is fully testable
 * without the Trigger.dev SDK.
 *
 * ── What it does ──────────────────────────────────────────────────────────────
 *
 *   1. expireStaleSignals(clientId)
 *      UPDATE signals SET status='expired' WHERE client_id=$clientId
 *        AND status='active' AND expires_at < now()
 *      Returns { count, affectedCompanyIds }.
 *
 *   2. rescoreAffectedCompanies(clientId, affectedCompanyIds, now)
 *      Rescores only the companies whose active signal set changed.
 *      Returns { scored[], failed[] }.
 *
 *   3. Returns ExpiryReport — stored in jobs.output_data by the Trigger.dev wrapper.
 *
 * ── Failure handling ──────────────────────────────────────────────────────────
 *
 * The known Stage 13 limitation: if expireStaleSignals succeeds but one or more
 * rescoreAffectedCompanies calls fail, the affected companies will have stale
 * scores until the next scheduled run. The failed companies are recorded in
 * ExpiryReport.rescoreResults.failed[] and jobs.output_data so the failure is
 * diagnosable and the next daily run can retry.
 *
 * rescoreAffectedCompanies already captures per-company errors in failed[] without
 * aborting the batch — this is the existing behaviour from Stage 12 that Stage 13
 * surfaces in the report.
 *
 * No retry queue or new infrastructure is introduced. Trigger.dev retries the
 * entire task on uncaught exceptions (e.g. expireStaleSignals throws). The task
 * is idempotent — a second run finds no active-past-TTL signals (already expired)
 * and rescores the affected companies again (idempotent upsert).
 *
 * ── Scheduling ────────────────────────────────────────────────────────────────
 *
 * Scheduling is the Trigger.dev deployment's responsibility. Recommended:
 * daily at 04:00 UTC per client — 2 hours after signal refresh completes.
 *
 * ── Excluded by design ────────────────────────────────────────────────────────
 *
 *   No Why Now / personalization / outbound.
 *   No new schema changes.
 *   No changes to the Stage 12 scoring formula or documented limitations.
 */

import type { RescoreResult } from "../lib/score-recompute";
import { expireStaleSignals } from "../db/signals";
import { rescoreAffectedCompanies } from "../lib/score-recompute";

// ── Public types ───────────────────────────────────────────────────────────────

export interface ExpiryReport {
  clientId: string;
  startedAt: string;
  completedAt: string;
  /** Number of signals updated from status='active' → 'expired'. */
  signalsExpired: number;
  /** Number of distinct companies whose active signal set changed. */
  companiesAffected: number;
  /** Company IDs that had at least one signal expire. */
  affectedCompanyIds: string[];
  /**
   * Per-company rescore outcomes.
   * scored[].score — the new opportunity_score after expiry-driven rescore.
   * failed[].error — message for companies where rescore threw.
   *
   * A failed rescore leaves the company's score stale until the next daily run.
   * The failure is recorded here for observability and manual retry if needed.
   */
  rescoreResults: RescoreResult;
}

export interface SignalExpiryPayload {
  clientId: string;
  /**
   * Override the current time for deterministic scoring in tests.
   * ISO 8601 string. Defaults to new Date() at task start.
   */
  now?: string;
}

export interface SignalExpiryResult {
  clientId: string;
  report: ExpiryReport;
}

// ── Task function ──────────────────────────────────────────────────────────────

/**
 * Run the signal expiry + rescore cycle for one client.
 *
 * Throws only on fatal failures (expireStaleSignals throws). Per-company rescore
 * failures are captured in ExpiryReport.rescoreResults.failed[].
 *
 * Client isolation: expireStaleSignals and rescoreAffectedCompanies both scope
 * all DB operations to clientId.
 */
export async function runSignalExpiry(
  payload: SignalExpiryPayload,
): Promise<SignalExpiryResult> {
  const { clientId } = payload;
  const now       = payload.now ? new Date(payload.now) : new Date();
  const startedAt = new Date();

  const expireResult  = await expireStaleSignals(clientId);
  const rescoreResult = await rescoreAffectedCompanies(
    clientId,
    expireResult.affectedCompanyIds,
    now,
  );

  const report: ExpiryReport = {
    clientId,
    startedAt:          startedAt.toISOString(),
    completedAt:        new Date().toISOString(),
    signalsExpired:     expireResult.count,
    companiesAffected:  expireResult.affectedCompanyIds.length,
    affectedCompanyIds: expireResult.affectedCompanyIds,
    rescoreResults:     rescoreResult,
  };

  return { clientId, report };
}
