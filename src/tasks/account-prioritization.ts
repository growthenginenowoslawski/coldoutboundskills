/**
 * Account prioritization task — Stage 14.
 *
 * Answers "which tracked accounts should we act on today?" by computing a
 * time-decayed priority score for every tracked account under a client and
 * persisting the result to account_intelligence.priority_score.
 *
 * This is the entry point for a scheduled Trigger.dev task. The Trigger.dev
 * task wrapper (deployed externally) calls runAccountPrioritization and stores
 * the result in jobs.output_data. This module has NO Trigger.dev imports and
 * is fully testable without the Trigger.dev SDK.
 *
 * ── What it does ──────────────────────────────────────────────────────────────
 *
 *   1. rankAccountsForClient(clientId, { now, halfLifeDays })
 *      Reads account_intelligence + signals, computes priority_score for every
 *      tracked account, and returns a sorted list (priority_score DESC).
 *
 *   2. For each account:
 *      setPriorityScore(clientId, companyId, priorityScore, prioritizedAt)
 *      Writes priority_score and prioritized_at to account_intelligence.
 *      Does NOT touch opportunity_score or score_inputs.
 *
 *   3. buildPrioritizationReport(...)
 *      Returns PrioritizationReport — stored in jobs.output_data.
 *      topAccounts is the top N by priority_score (default 20).
 *      All accounts receive a priority_score write, not just top N.
 *
 * ── Why priority_score must be recomputed every run ───────────────────────────
 *
 * priority_score decays as time passes even when no new signals arrive. A score
 * written yesterday is already stale because daysSinceLastSignal has increased
 * by 1. The task must run daily and recompute from the current timestamp.
 * prioritized_at records when the calculation happened — it is NOT a guarantee
 * that the stored score reflects today's decay.
 *
 * ── Scheduling ────────────────────────────────────────────────────────────────
 *
 * Scheduling is the Trigger.dev deployment's responsibility.
 * Recommended: daily at 06:00 UTC per client (after signal refresh at 02:00
 * and expiry at 04:00 complete).
 *
 * ── Excluded by design ────────────────────────────────────────────────────────
 *
 *   No Why Now, no contact discovery, no personalization, no outbound.
 *   No AI, no new signal providers.
 *   No stored rank — rank is computed at query time.
 *   No campaign/contact state.
 */

import {
  rankAccountsForClient,
  buildPrioritizationReport,
  PRIORITY_RECENCY_HALF_LIFE_DAYS,
} from "../lib/account-prioritization";
import type {
  AccountPriorityResult,
  PrioritizationReport,
} from "../lib/account-prioritization";
import { setPriorityScore } from "../db/account-intelligence";

// Re-export for callers that import the task module.
export type { AccountPriorityResult, PrioritizationReport };

// ── Public types ───────────────────────────────────────────────────────────────

export interface AccountPrioritizationPayload {
  clientId: string;
  /**
   * Override the current time for deterministic tests.
   * ISO 8601 string. Defaults to new Date() at task start.
   *
   * Because priority_score decays with time, every test that checks a specific
   * score value must supply a fixed `now`. Without it, two runs on different days
   * produce different scores even with identical signals.
   */
  now?: string;
  /**
   * Maximum accounts to include in PrioritizationReport.topAccounts.
   * Does NOT limit which accounts receive a priority_score write — all
   * tracked accounts are scored and persisted regardless of this value.
   * Defaults to 20.
   */
  topN?: number;
  /**
   * Override the recency half-life for this run.
   * Defaults to PRIORITY_RECENCY_HALF_LIFE_DAYS (14).
   * INITIAL_HYPOTHESIS_NOT_VALIDATED.
   * Useful for sensitivity analysis without code changes.
   */
  halfLifeDays?: number;
}

export interface AccountPrioritizationResult {
  clientId: string;
  report: PrioritizationReport;
}

// ── Task function ──────────────────────────────────────────────────────────────

/**
 * Run a complete account prioritisation cycle for one client.
 *
 * Steps:
 *   1. Rank all tracked accounts by time-decayed priority score.
 *   2. Write priority_score + prioritized_at to account_intelligence for each account.
 *   3. Return PrioritizationReport (stored in jobs.output_data by Trigger.dev wrapper).
 *
 * Returns a report with accountsRanked=0 when the client has no tracked accounts.
 * Does not throw on that case.
 *
 * Idempotency: running twice for the same client at the same `now` produces
 * identical priority_scores. Running twice at different times produces different
 * scores (time-decay is monotonically decreasing without new signals).
 *
 * Client isolation: rankAccountsForClient and setPriorityScore both scope all
 * DB operations to clientId. Cross-client data is never accessed.
 */
export async function runAccountPrioritization(
  payload: AccountPrioritizationPayload,
): Promise<AccountPrioritizationResult> {
  const { clientId }   = payload;
  const now            = payload.now ? new Date(payload.now) : new Date();
  const topN           = payload.topN ?? 20;
  const halfLifeDays   = payload.halfLifeDays ?? PRIORITY_RECENCY_HALF_LIFE_DAYS;
  const startedAt      = new Date();
  const prioritizedAt  = now.toISOString();

  const accounts = await rankAccountsForClient(clientId, { now, halfLifeDays });

  // Write priority_score to all tracked accounts (not just top N).
  for (const account of accounts) {
    await setPriorityScore(clientId, account.companyId, account.priorityScore, prioritizedAt);
  }

  const report = buildPrioritizationReport({
    clientId,
    startedAt,
    completedAt: new Date(),
    topN,
    halfLifeDays,
    accounts,
  });

  return { clientId, report };
}
