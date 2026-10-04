/**
 * EmailEnrichmentProvider interface and typed error hierarchy.
 *
 * An EmailEnrichmentProvider takes a known person (name + company domain +
 * optional LinkedIn URL) and returns an email address.
 *
 * This provider is SEPARATE from PersonDiscoveryProvider. Email enrichment
 * only runs after the PersonDiscoveryWaterfall returns RELEVANT_FOUND.
 * Do not combine these two discovery processes.
 *
 * Error handling contract:
 *   EmailEnrichmentAuthError           — waterfall-fatal; stops entire run
 *   returning null                     — not found; try next provider
 *   EmailEnrichmentRateLimitError      — non-fatal; try next provider
 *   EmailEnrichmentTemporaryFailureError — non-fatal; try next provider
 *   EmailEnrichmentProviderError       — catch-all; non-fatal; try next
 *
 * The email address returned must NEVER be logged by the waterfall orchestrator.
 * The found_email value in EmailEnrichmentOutcome is marked "NEVER log — PII".
 */

import type { EmailEnrichmentCandidate, EmailEnrichmentQuery } from "../../domain/person-discovery-types";

export interface EmailEnrichmentProvider {
  /** Stable provider identifier. Never logged alongside credentials. */
  readonly id: string;

  isConfigured(): boolean;

  /**
   * Find an email address for the given person.
   *
   * Returns null when the provider has no result for this person (NOT_FOUND).
   * null is not an error — it means try the next provider.
   *
   * @throws EmailEnrichmentRateLimitError — rate limited
   * @throws EmailEnrichmentAuthError — credentials bad/missing (WATERFALL-FATAL)
   * @throws EmailEnrichmentTemporaryFailureError — transient failure
   * @throws EmailEnrichmentProviderError — 5xx or unexpected response shape
   */
  findEmailForPerson(query: EmailEnrichmentQuery): Promise<EmailEnrichmentCandidate | null>;
}

// ── Typed error hierarchy ─────────────────────────────────────────────────────

export class EmailEnrichmentProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmailEnrichmentProviderError";
  }
}

export class EmailEnrichmentRateLimitError extends EmailEnrichmentProviderError {
  constructor(
    provider: string,
    public readonly retryAfterMs: number,
  ) {
    super(`${provider}: rate limited — retry after ${retryAfterMs}ms`, provider);
    this.name = "EmailEnrichmentRateLimitError";
  }
}

/**
 * WATERFALL-FATAL. Stops the EmailEnrichmentWaterfall immediately.
 */
export class EmailEnrichmentAuthError extends EmailEnrichmentProviderError {
  constructor(provider: string, detail?: string) {
    const suffix = detail ? ` — ${detail}` : "";
    super(`${provider}: missing or invalid API credentials${suffix}`, provider);
    this.name = "EmailEnrichmentAuthError";
  }
}

export class EmailEnrichmentTemporaryFailureError extends EmailEnrichmentProviderError {
  constructor(provider: string, detail?: string) {
    const suffix = detail ? `: ${detail}` : "";
    super(`${provider}: temporary failure${suffix}`, provider);
    this.name = "EmailEnrichmentTemporaryFailureError";
  }
}
