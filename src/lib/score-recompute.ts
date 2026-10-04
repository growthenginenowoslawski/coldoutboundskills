/**
 * Signal-lifecycle scoring integration — Stage 12, Step 6.
 *
 * Wires the deterministic opportunity scoring engine into the signal lifecycle:
 *
 *   Signal change (new ingest OR expiry)
 *     → identify affected (client, company) pairs
 *     → fetch only the signals for those pairs
 *     → buildScoreInputs → computeOpportunityScore
 *     → upsertAccountIntelligence
 *
 * No AI calls. No global portfolio rescoring. Every operation is scoped to
 * the affected (client_id, company_id) pairs.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * rescoreCompany is fully idempotent:
 *   - getSignalsByCompany always returns the current DB state.
 *   - computeOpportunityScore is deterministic: same inputs → same output.
 *   - upsertAccountIntelligence uses ON CONFLICT (client_id, company_id) DO UPDATE.
 *
 * Running rescoreCompany twice for the same (client, company) at the same `now`
 * produces bitwise-identical score_inputs and updates the same row in place.
 * No duplicate account_intelligence rows are ever created.
 *
 * ── Failure handling ─────────────────────────────────────────────────────────
 *
 * rescoreCompany throws on any DB error. The account_intelligence row is only
 * written on full success. A failed rescore is surfaced immediately — no silent
 * stale state.
 *
 * rescoreAffectedCompanies captures per-company errors and continues; the
 * caller receives a RescoreResult with scored[] and failed[] so it can log,
 * alert, or schedule a retry for specific companies without aborting others.
 *
 * ── Trigger.dev caller notes ─────────────────────────────────────────────────
 *
 * This module has NO Trigger.dev imports. It is a pure orchestration layer
 * that a Trigger.dev task or an integration script calls after signal ingestion
 * or signal expiry. The caller is responsible for:
 *   1. Calling upsertSignal → if created, call rescoreCompany for that company.
 *   2. Calling expireStaleSignals → pass the returned affectedCompanyIds to
 *      rescoreAffectedCompanies.
 *
 * EXCLUDED by design (do not add):
 *   - Why Now / readiness / outbound execution
 *   - Contact prioritization
 *   - AI scoring / learning / feedback loops
 *   - Score history (each upsert is a point-in-time overwrite)
 *   - New signal providers
 */

import type { SignalRow } from "../domain/signal-types";
import type { OpportunityScoreResult } from "./opportunity-scoring";
import type { AccountIntelligenceRow } from "../db/account-intelligence";
import {
  buildScoreInputs,
  computeOpportunityScore,
} from "./opportunity-scoring";
import { getSignalsByCompany } from "../db/signals";
import { getCompanyIcpScore } from "../db/companies";
import { upsertAccountIntelligence } from "../db/account-intelligence";

// ── Public types ───────────────────────────────────────────────────────────────

export interface RescoreResult {
  /** Companies that were successfully rescored, with their new score. */
  scored: Array<{ companyId: string; score: number }>;
  /** Companies where rescoring failed. Caller should log/retry these. */
  failed: Array<{ companyId: string; error: string }>;
}

// ── Pure bridge (exported for testing) ───────────────────────────────────────

/**
 * Compute an opportunity score from pre-fetched signals and icp_score.
 *
 * Pure — no I/O. Bridges SignalRow[] (DB type) to OpportunityScoreResult
 * (scoring type) by running the two-step pipeline:
 *   buildScoreInputs → computeOpportunityScore
 *
 * This is the only new pure logic in Step 6 — everything else delegates to
 * existing pure functions already covered by their own tests. The bridge is
 * tested here because it is the type-seam between the DB layer and the
 * scoring layer.
 *
 * @param signals  All signals for the (client, company) pair — active and
 *                 inactive. buildScoreInputs applies the two-guard exclusion
 *                 (status check + isExpired check) and produces the filtered
 *                 inputs. Excluded signals are recorded as excludedSignalCount.
 * @param icpScore The global companies.icp_score value (0-100).
 * @param now      Override the current time. Defaults to new Date(). Required
 *                 for deterministic tests.
 */
export function computeCompanyScore(
  signals: SignalRow[],
  icpScore: number,
  now: Date = new Date(),
): OpportunityScoreResult {
  const { inputs, excludedCount } = buildScoreInputs(signals, now);
  return computeOpportunityScore(inputs, icpScore, now, excludedCount);
}

// ── Async orchestration ───────────────────────────────────────────────────────

/**
 * Recompute the opportunity score for a single (client, company) pair.
 *
 * Fetches active signals from the DB, reads the company's global icp_score,
 * runs computeCompanyScore, and persists the result via upsertAccountIntelligence.
 *
 * Client isolation: every DB query is scoped to clientId. The icp_score read
 * is from companies (global, per the documented TEMPORARY COMPROMISE) — not
 * per-client.
 *
 * @throws On any DB error (signal fetch, icp_score read, or upsert). The
 *         account_intelligence row is only updated on full success.
 */
export async function rescoreCompany(
  clientId: string,
  companyId: string,
  now: Date = new Date(),
): Promise<AccountIntelligenceRow> {
  // Fetch active signals scoped to this client. The DB query already filters
  // by status="active"; buildScoreInputs then applies the isExpired() guard
  // as a second check for signals whose expires_at has passed since the last
  // expireStaleSignals run (race-condition guard).
  const signals = await getSignalsByCompany(companyId, clientId, { status: "active" });
  const icpScore = await getCompanyIcpScore(companyId);
  const scoreResult = computeCompanyScore(signals, icpScore, now);
  return upsertAccountIntelligence(clientId, companyId, scoreResult, now);
}

/**
 * Recompute opportunity scores for a set of affected companies under one client.
 *
 * Designed to be called immediately after expireStaleSignals() returns its
 * affectedCompanyIds. Only rescores the listed companies — never the entire
 * client portfolio.
 *
 * Per-company errors are captured in failed[] rather than aborting the batch.
 * The caller should inspect failed[] and schedule retries or raise an alert.
 * Scored companies are unaffected by failures in other companies.
 *
 * Passing an empty companyIds array is a no-op (returns { scored: [], failed: [] }).
 *
 * @param now  Override the current time. Used in integration tests for
 *             determinism. All companies in the batch use the same `now`.
 */
export async function rescoreAffectedCompanies(
  clientId: string,
  companyIds: string[],
  now: Date = new Date(),
): Promise<RescoreResult> {
  const scored: RescoreResult["scored"] = [];
  const failed: RescoreResult["failed"] = [];

  for (const companyId of companyIds) {
    try {
      const row = await rescoreCompany(clientId, companyId, now);
      scored.push({ companyId, score: row.opportunityScore });
    } catch (err) {
      failed.push({
        companyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { scored, failed };
}
