/**
 * Deterministic opportunity scoring — Stage 12.
 *
 * Computes a 0-100 opportunity score for a (client, company) pair from their
 * stored active signals. No I/O, no AI calls, no DB reads.
 *
 * Formula:
 *   rawScore     = sum over signals of: (signalStrength/100 × freshnessScore/100 × icpRelevance × 100)
 *   corroborated = rawScore × corroborationFactor
 *   finalScore   = min(100, round(corroborated × (icpScore / 100)))
 *
 * All weights are INITIAL_HYPOTHESIS_NOT_VALIDATED — starting hypotheses,
 * not commercially validated values.
 *
 * Two opportunity scores coexist in the system (known naming collision):
 *   account_intelligence.opportunity_score  — THIS module; deterministic
 *   enrichment_runs.output_data.opportunityScore — AI analytical estimate
 * This module does not touch the AI field.
 */

import type { SignalRow, SignalType } from "../domain/signal-types";
import { computeFreshnessScore, isExpired } from "./signal-freshness";

// ── ICP relevance weights ─────────────────────────────────────────────────────
// INITIAL_HYPOTHESIS_NOT_VALIDATED
// Weights reflect how strongly each signal type predicts ICP fit and buying
// intent for a typical B2B SaaS motion. Not validated against campaign data.

const ICP_RELEVANCE: Record<SignalType, number> = {
  funding_round:      1.00,
  executive_hire:     0.90,
  expansion:          0.80,
  technology_change:  0.75,
  product_launch:     0.70,
  partnership:        0.65,
  job_posting:        0.60,
  competitor_mention: 0.55,
  news_mention:       0.30,
  award:              0.25,
  website_change:     0.20,
  test:               0.00,
};

// ── Corroboration clusters ────────────────────────────────────────────────────
// INITIAL_HYPOTHESIS_NOT_VALIDATED
// Signals in the same cluster reinforce each other — multiple signals of the
// same theme are stronger evidence than one signal of high base strength.
//
// Corroboration factor = min(1.45, 1.0 + (clusterDepth - 1) × 0.15)
// where clusterDepth = distinct signal types in the deepest hit cluster,
// counting only signals whose occurredAt falls within CORROBORATION_WINDOW_DAYS.
//
// Max factor 1.45 is reached at clusterDepth = 4 (three types in one cluster).
// LEADERSHIP_CHANGE and DIGITAL_CHANGE have one member each — they never
// exceed a factor of 1.0 unless a future type is added to those clusters.

const CORROBORATION_CLUSTERS: ReadonlyArray<ReadonlyArray<SignalType>> = [
  // GROWTH — budget allocated and team expanding
  ["funding_round", "expansion", "job_posting"],
  // LEADERSHIP_CHANGE — new exec resets the vendor stack
  ["executive_hire"],
  // PRODUCT_MOTION — building / partnering / switching
  ["product_launch", "partnership", "technology_change"],
  // MARKET_SIGNAL — company in the public conversation
  ["news_mention", "competitor_mention", "award"],
  // DIGITAL_CHANGE — weakest; website in flux
  ["website_change"],
];

const CORROBORATION_WINDOW_DAYS = 90;
const CORROBORATION_PER_TYPE    = 0.15;
const CORROBORATION_CAP         = 1.45;

// ── Public types ──────────────────────────────────────────────────────────────

/** One active signal contributed to the scoring computation. */
export interface SignalScoreInput {
  /** UUID — must resolve to a row in the signals table. */
  signalId: string;
  signalType: SignalType;
  /** 0-100 base strength (from computeSignalStrength). */
  signalStrength: number;
  /** 0-100 freshness at scoring time (from computeFreshnessScore). */
  freshnessScore: number;
  /** ISO 8601 — when the event occurred (used for corroboration window). */
  occurredAt: string;
}

/** Per-signal breakdown stored in score_inputs.signals[]. */
export interface SignalContribution {
  signalId: string;
  signalType: SignalType;
  signalStrength: number;
  freshnessScore: number;
  icpRelevance: number;
  /** This signal's additive contribution to rawScore (before corroboration/ICP). */
  contribution: number;
}

/**
 * Full scoring result. Stored verbatim as score_inputs JSONB in
 * account_intelligence. Every field is traceable back to its inputs.
 */
export interface OpportunityScoreResult {
  /** Always "INITIAL_HYPOTHESIS_NOT_VALIDATED". */
  hypothesis: "INITIAL_HYPOTHESIS_NOT_VALIDATED";
  computedAt: string;
  signalCount: number;
  /** Sum of per-signal contributions before corroboration and ICP weighting. */
  rawScore: number;
  corroborationFactor: number;
  /** icpScore / 100 — multiplied into the final score. */
  icpFitWeight: number;
  icpScore: number;
  /**
   * Documents the architectural compromise: companies.icp_score is global.
   * When two clients target the same company the global value reflects the
   * last writer. Resolution: per-client icp_score column in this table
   * once a second production client targets companies in common.
   */
  icpScoreSource: "companies.icp_score (global — TEMPORARY COMPROMISE: reflects last writer when multiple clients target the same company)";
  /** 0-100 integer, capped. The value stored in account_intelligence.opportunity_score. */
  finalScore: number;
  /**
   * Number of SignalRows excluded before scoring — due to status !== "active"
   * or isExpired() returning true (in-memory race-condition guard).
   * Always 0 when calling computeOpportunityScore directly with SignalScoreInput[].
   * Non-zero only when caller used buildScoreInputs and passed the excludedCount through.
   */
  excludedSignalCount: number;
  signals: SignalContribution[];
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute the deterministic opportunity score for a (client, company) pair.
 *
 * @param signals  Active (non-expired) signal rows for this pair, already
 *                 loaded by the caller. Pass an empty array for zero score.
 * @param icpScore The global companies.icp_score value (0-100). A value of 0
 *                 collapses the final score to 0 regardless of signal evidence.
 * @param now      Override the current time. Defaults to new Date(). Used in
 *                 tests to reproduce deterministic results.
 *
 * @returns        A full result object. finalScore is the integer to store in
 *                 account_intelligence.opportunity_score. The full result is
 *                 stored as score_inputs JSONB.
 */
export function computeOpportunityScore(
  signals: SignalScoreInput[],
  icpScore: number,
  now: Date = new Date(),
  excludedSignalCount = 0,
): OpportunityScoreResult {
  const contributions = signals.map((s) => computeContribution(s));

  const rawScore = contributions.reduce((sum, c) => sum + c.contribution, 0);

  const corroborationFactor = computeCorroborationFactor(signals, now);

  const clampedIcp = Math.max(0, Math.min(100, icpScore));
  const icpFitWeight = clampedIcp / 100;

  const finalScore = Math.min(
    100,
    Math.round(rawScore * corroborationFactor * icpFitWeight),
  );

  return {
    hypothesis:          "INITIAL_HYPOTHESIS_NOT_VALIDATED",
    computedAt:          now.toISOString(),
    signalCount:         signals.length,
    rawScore:            Math.round(rawScore * 100) / 100,
    corroborationFactor: Math.round(corroborationFactor * 1000) / 1000,
    icpFitWeight:        Math.round(icpFitWeight * 100) / 100,
    icpScore:            clampedIcp,
    icpScoreSource:
      "companies.icp_score (global — TEMPORARY COMPROMISE: reflects last writer when multiple clients target the same company)",
    finalScore,
    excludedSignalCount,
    signals:             contributions,
  };
}

/**
 * Returns the ICP relevance weight for a signal type.
 * Exposed separately so tests can assert individual weights.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */
export function getIcpRelevance(signalType: SignalType): number {
  return ICP_RELEVANCE[signalType];
}

/**
 * Compute the corroboration factor (1.0 – 1.45) for the given signal set.
 *
 * Finds the cluster with the most distinct signal types represented within
 * CORROBORATION_WINDOW_DAYS of now. Applies:
 *   factor = min(CORROBORATION_CAP, 1.0 + (clusterDepth - 1) × CORROBORATION_PER_TYPE)
 *
 * Returns 1.0 when no signals are present or no cluster has more than one type.
 */
export function computeCorroborationFactor(
  signals: SignalScoreInput[],
  now: Date = new Date(),
): number {
  const windowMs = CORROBORATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const cutoffMs = now.getTime() - windowMs;

  // Distinct signal types within the corroboration window.
  const recentTypes = new Set<SignalType>(
    signals
      .filter((s) => {
        const ms = new Date(s.occurredAt).getTime();
        return !isNaN(ms) && ms >= cutoffMs;
      })
      .map((s) => s.signalType),
  );

  let maxClusterDepth = 1;
  for (const cluster of CORROBORATION_CLUSTERS) {
    const depth = cluster.filter((t) => recentTypes.has(t)).length;
    if (depth > maxClusterDepth) maxClusterDepth = depth;
  }

  return Math.min(
    CORROBORATION_CAP,
    1.0 + (maxClusterDepth - 1) * CORROBORATION_PER_TYPE,
  );
}

// ── DB → score input bridge ───────────────────────────────────────────────────

/**
 * Converts DB SignalRows to SignalScoreInputs for computeOpportunityScore.
 *
 * Exclusion uses two guards in combination:
 *   1. status !== "active"  — DB-authoritative (expired/dismissed by prior run)
 *   2. isExpired(expiresAt, now) — in-memory guard for signals whose expires_at
 *      has passed since the last expireStaleSignals run. Prevents a race where
 *      an active-status signal contributes to the score after its TTL has elapsed.
 *
 * Freshness is computed with computeFreshnessScore(occurredAt, expiresAt, now)
 * — the same algorithm used throughout the signal engine. Signal strength is
 * taken from the DB row (already computed at ingestion via computeSignalStrength)
 * and is NOT recomputed here.
 *
 * Returns the filtered inputs and the count of excluded signals. Pass the
 * excludedCount to computeOpportunityScore so the breakdown is self-contained:
 *
 *   const { inputs, excludedCount } = buildScoreInputs(rows, now);
 *   const result = computeOpportunityScore(inputs, icpScore, now, excludedCount);
 */
export function buildScoreInputs(
  signals: SignalRow[],
  now: Date = new Date(),
): { inputs: SignalScoreInput[]; excludedCount: number } {
  const inputs: SignalScoreInput[] = [];
  let excludedCount = 0;

  for (const s of signals) {
    if (s.status !== "active" || isExpired(s.expiresAt, now)) {
      excludedCount++;
      continue;
    }
    inputs.push({
      signalId:       s.id,
      signalType:     s.signalType,
      signalStrength: s.signalStrength,
      freshnessScore: computeFreshnessScore(s.occurredAt, s.expiresAt, now),
      occurredAt:     s.occurredAt,
    });
  }

  return { inputs, excludedCount };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function computeContribution(s: SignalScoreInput): SignalContribution {
  const icpRelevance = ICP_RELEVANCE[s.signalType];
  const strength     = Math.max(0, Math.min(100, s.signalStrength));
  const freshness    = Math.max(0, Math.min(100, s.freshnessScore));

  // (strength/100) × (freshness/100) × icpRelevance × 100
  // Simplified: strength × freshness × icpRelevance / 100
  const contribution = (strength * freshness * icpRelevance) / 100;

  return {
    signalId:       s.signalId,
    signalType:     s.signalType,
    signalStrength: strength,
    freshnessScore: freshness,
    icpRelevance,
    contribution:   Math.round(contribution * 100) / 100,
  };
}
