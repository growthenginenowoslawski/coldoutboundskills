/**
 * Deterministic signal-strength and confidence scoring.
 *
 * signal_strength is the BASE score for a signal type — how impactful this
 * category of event is for a typical B2B SaaS ICP, regardless of timing.
 *
 * Freshness is a separate axis (signal-freshness.ts). To rank signals for
 * outreach, combine: actionabilityScore = round(strength × freshness / 100).
 *
 * Base scores reflect buying-intent relevance:
 *   90  funding_round       — new budget, explicit growth mandate
 *   75  executive_hire      — new exec often resets the vendor stack within 90d
 *   70  product_launch      — build-vs-buy moment for adjacent tooling
 *   65  expansion           — growing fast → needs more infrastructure
 *   60  competitor_mention  — actively evaluating this space
 *   60  partnership         — ecosystem shift, adjacent tooling in scope
 *   55  technology_change   — switching costs low, stack in flux
 *   50  job_posting         — budget allocated for a function
 *   50  test                — mid-range for smoke tests
 *   45  award               — public proof point, good for warm outreach
 *   40  news_mention        — visibility signal, weaker buying intent
 *   35  website_change      — weakest; can mean many things
 */

import type { SignalType } from "../domain/signal-types";
import type { DedupTier } from "./signal-dedup";

const BASE_STRENGTH: Record<SignalType, number> = {
  funding_round:      90,
  executive_hire:     75,
  product_launch:     70,
  expansion:          65,
  competitor_mention: 60,
  partnership:        60,
  technology_change:  55,
  job_posting:        50,
  test:               50,
  award:              45,
  news_mention:       40,
  website_change:     35,
};

/**
 * Returns the base signal strength (0-100) for a signal type.
 * Deterministic — no external calls, no AI.
 */
export function computeSignalStrength(signalType: SignalType): number {
  return BASE_STRENGTH[signalType];
}

/**
 * Combined actionability score: strength × freshness / 100, rounded to integer.
 * Accounts for both what happened and how recently.
 */
export function computeActionabilityScore(
  signalStrength: number,
  freshnessScore: number,
): number {
  const raw = (signalStrength * freshnessScore) / 100;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

/**
 * Default confidence level derived from the dedup tier used.
 * Applied when the provider does not supply its own confidence value.
 *
 *   provider-id        → 0.800 (provider vouches for this specific event)
 *   content-fingerprint → 0.600 (inferred from evidence structure)
 *   none               → 0.500 (vague event, no fingerprint possible)
 */
export function defaultConfidence(tier: DedupTier): number {
  switch (tier) {
    case "provider-id":         return 0.800;
    case "content-fingerprint": return 0.600;
    case "none":                return 0.500;
  }
}

/**
 * Clamp a confidence value to [0.000, 1.000] rounded to 3 decimal places.
 * Throws for NaN or infinite inputs — these indicate a provider bug.
 */
export function validateConfidence(confidence: number): number {
  if (!Number.isFinite(confidence)) {
    throw new Error(
      `Confidence must be a finite number between 0 and 1, got: ${confidence}`,
    );
  }
  const clamped = Math.max(0, Math.min(1, confidence));
  return Math.round(clamped * 1000) / 1000;
}
