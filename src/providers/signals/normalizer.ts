/**
 * Converts raw provider events into normalized signals.
 *
 * Deterministic — no AI calls, no network I/O, no randomness.
 * Every output field is derived from the inputs alone.
 *
 * This is the ingestion boundary: providers hand raw events here; everything
 * downstream works with NormalizedSignal, never RawSignalEvent.
 */

import type {
  NormalizedSignal,
  SignalProviderEvent,
} from "../../domain/signal-types";
import { computeDedupKey, dedupTier } from "../../lib/signal-dedup";
import { computeExpiresAt } from "../../lib/signal-freshness";
import {
  computeSignalStrength,
  validateConfidence,
  defaultConfidence,
} from "../../lib/signal-strength";

/**
 * Normalize a single raw provider event into a NormalizedSignal.
 *
 * @param providerEvent  Raw event + routing context from a signal provider.
 * @param detectedAt     ISO timestamp of ingestion run. Pass explicitly in tests.
 *                       Defaults to current time.
 * @throws               When occurredAt is not a valid ISO timestamp.
 */
export function normalizeEvent(
  providerEvent: SignalProviderEvent,
  detectedAt: string = new Date().toISOString(),
): NormalizedSignal {
  const { companyId, clientId, rawEvent } = providerEvent;

  // Validate occurred_at before computing derived fields
  const occurredDate = new Date(rawEvent.occurredAt);
  if (isNaN(occurredDate.getTime())) {
    throw new Error(
      `Invalid occurredAt "${rawEvent.occurredAt}" for signal type "${rawEvent.signalType}"`,
    );
  }

  const tier = dedupTier(rawEvent);
  const dedupKey = computeDedupKey(companyId, rawEvent);
  const expiresAt = computeExpiresAt(rawEvent.occurredAt, rawEvent.signalType);
  const signalStrength = computeSignalStrength(rawEvent.signalType);
  const rawConfidence = rawEvent.confidence ?? defaultConfidence(tier);
  const confidence = validateConfidence(rawConfidence);

  return {
    clientId,
    companyId,
    signalType: rawEvent.signalType,
    signalSource: rawEvent.source,
    signalTitle: rawEvent.title,
    signalDescription: rawEvent.description ?? null,
    evidence: rawEvent.evidence,
    signalStrength,
    confidence,
    occurredAt: rawEvent.occurredAt,
    detectedAt,
    expiresAt,
    sourceUrl: rawEvent.sourceUrl ?? null,
    metadata: rawEvent.metadata ?? null,
    dedupKey,
    status: "active",
  };
}

export type NormalizeOutcome =
  | { ok: true; signal: NormalizedSignal }
  | { ok: false; error: string; event: SignalProviderEvent };

/**
 * Normalize a batch of provider events.
 * A failure in one event does not block the others.
 */
export function normalizeBatch(
  events: SignalProviderEvent[],
  detectedAt: string = new Date().toISOString(),
): NormalizeOutcome[] {
  return events.map((event) => {
    try {
      return { ok: true, signal: normalizeEvent(event, detectedAt) };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        event,
      };
    }
  });
}
