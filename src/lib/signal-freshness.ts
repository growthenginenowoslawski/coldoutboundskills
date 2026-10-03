/**
 * Deterministic freshness calculation for signals.
 *
 * Two representations:
 *
 *   expires_at      — absolute ISO timestamp, computed once at ingestion and
 *                     stored in the DB. Formula: occurred_at + TTL(signalType).
 *
 *   freshnessScore  — 0-100 integer, derived at query time from the elapsed
 *                     fraction of the TTL window. NOT stored; computed on demand.
 *                     Linear decay: 100 at occurred_at → 0 at expires_at.
 *
 * TTLs are outer bounds of actionability — not hard cutoffs. Sales teams
 * should act well before expiry. The scores rank urgency, not eligibility.
 */

import type { SignalType } from "../domain/signal-types";

// ── TTL registry (days) ───────────────────────────────────────────────────────

const SIGNAL_TTL_DAYS: Record<SignalType, number> = {
  executive_hire:     30,
  funding_round:      90,
  job_posting:        14,
  news_mention:        7,
  website_change:     60,
  product_launch:     60,
  partnership:        90,
  technology_change:  90,
  competitor_mention: 14,
  award:             180,
  expansion:          90,
  test:                7,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the TTL in days for a signal type.
 */
export function getTtlDays(signalType: SignalType): number {
  return SIGNAL_TTL_DAYS[signalType];
}

/**
 * Compute the expires_at timestamp for a signal.
 * Call once at ingestion; store the result in the DB.
 *
 * @throws  When occurredAt is not a valid ISO timestamp.
 */
export function computeExpiresAt(occurredAt: string, signalType: SignalType): string {
  const base = new Date(occurredAt);
  if (isNaN(base.getTime())) {
    throw new Error(`Invalid occurredAt timestamp: "${occurredAt}"`);
  }
  const ttlMs = SIGNAL_TTL_DAYS[signalType] * 24 * 60 * 60 * 1000;
  return new Date(base.getTime() + ttlMs).toISOString();
}

/**
 * Compute the freshness score (0-100) at a given point in time.
 *
 * - Returns 100 when now <= occurred_at (just happened or future-dated)
 * - Linear decay from 100 → 0 across the [occurred_at, expires_at] window
 * - Returns 0 when now >= expires_at
 * - Returns 0 on invalid timestamps
 *
 * @param occurredAt  ISO string — when the event happened.
 * @param expiresAt   ISO string — from the DB (computed at ingestion).
 * @param now         Override current time for testing. Defaults to Date.now().
 */
export function computeFreshnessScore(
  occurredAt: string,
  expiresAt: string,
  now: Date = new Date(),
): number {
  const occurredMs = new Date(occurredAt).getTime();
  const expiresMs = new Date(expiresAt).getTime();
  const nowMs = now.getTime();

  if (isNaN(occurredMs) || isNaN(expiresMs)) return 0;

  const windowMs = expiresMs - occurredMs;
  if (windowMs <= 0) return 100;

  if (nowMs <= occurredMs) return 100;
  if (nowMs >= expiresMs) return 0;

  const elapsed = nowMs - occurredMs;
  return Math.max(0, Math.floor((1 - elapsed / windowMs) * 100));
}

/**
 * Returns true when the signal has passed its expires_at timestamp.
 */
export function isExpired(expiresAt: string, now: Date = new Date()): boolean {
  const expiresMs = new Date(expiresAt).getTime();
  return isNaN(expiresMs) || now.getTime() >= expiresMs;
}
