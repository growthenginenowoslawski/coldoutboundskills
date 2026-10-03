/**
 * Deterministic deduplication key computation for signals.
 *
 * Three-tier hierarchy — uses the first applicable tier:
 *
 *   Tier 1 — Provider event ID (strongest)
 *     The provider assigns a stable, unique ID to this event.
 *     Key: SHA-256("pid:" + source + ":" + providerEventId)
 *     Two reports of the same event → same provider ID → same key → deduplicated.
 *
 *   Tier 2 — Content fingerprint (most common)
 *     No provider ID, but evidence is non-empty.
 *     Key: SHA-256("fp:" + companyId + ":" + signalType + ":" + source + ":" + contentHash)
 *     contentHash = SHA-256(stable-sorted JSON of the evidence object)
 *     Two VP-of-Sales hires → different evidence (different people) → different keys.
 *     Same hire reported twice → identical evidence → same key → deduplicated.
 *
 *   Tier 3 — null (no dedup)
 *     No provider ID AND evidence is empty.
 *     We accept duplicates rather than risk false merges on vague events.
 *     The DB unique index excludes null dedup_keys, so these rows are unconstrained.
 *
 * Key invariant: occurredAt is NOT included in the fingerprint.
 * Including detection time would make two reports of the same event on different
 * days appear unique.  Evidence is the discriminator, not time.
 */

import { createHash } from "node:crypto";
import type { RawSignalEvent } from "../domain/signal-types";

export type DedupTier = "provider-id" | "content-fingerprint" | "none";

/**
 * Stable, sorted JSON serialization.
 * { b: 1, a: 2 } and { a: 2, b: 1 } produce the same string.
 * Nested objects are also sorted recursively.
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => [JSON.stringify(k), stableJson(v)].join(":"));
  return "{" + entries.join(",") + "}";
}

function sha256hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function hasContent(evidence: Record<string, unknown>): boolean {
  return Object.keys(evidence).length > 0;
}

/**
 * Returns which dedup tier will be used for an event, without computing the key.
 * Useful for logging and for computing the default confidence level.
 */
export function dedupTier(
  event: Pick<RawSignalEvent, "providerEventId" | "evidence">,
): DedupTier {
  if (event.providerEventId) return "provider-id";
  if (hasContent(event.evidence)) return "content-fingerprint";
  return "none";
}

/**
 * Compute the dedup key for a raw signal event.
 *
 * @param companyId  The target company UUID (scopes the content fingerprint).
 * @param event      The raw event from a signal provider.
 * @returns          Hex string dedup key, or null when no fingerprint is possible.
 */
export function computeDedupKey(
  companyId: string,
  event: Pick<RawSignalEvent, "providerEventId" | "source" | "signalType" | "evidence">,
): string | null {
  // Tier 1: stable provider-assigned event ID
  if (event.providerEventId) {
    return sha256hex(`pid:${event.source}:${event.providerEventId}`);
  }

  // Tier 2: content fingerprint from evidence
  if (hasContent(event.evidence)) {
    const contentHash = sha256hex(stableJson(event.evidence));
    return sha256hex(
      `fp:${companyId}:${event.signalType}:${event.source}:${contentHash}`,
    );
  }

  // Tier 3: no fingerprint possible
  return null;
}
