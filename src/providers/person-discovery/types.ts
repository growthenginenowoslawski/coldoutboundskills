/**
 * PersonDiscoveryProvider interface and typed error hierarchy.
 *
 * A PersonDiscoveryProvider searches for people at a target company who match
 * a specified function + seniority persona. It does NOT evaluate whether the
 * person is relevant — that is Stage 23's responsibility. The provider finds
 * candidates; the PersonDiscoveryWaterfall evaluates them via Stage 23.
 *
 * Error handling contract:
 *   PersonDiscoveryAuthError     — waterfall-fatal; stops entire run
 *   PersonDiscoveryNotFoundError — not an error; try next provider
 *   PersonDiscoveryRateLimitError  — non-fatal; try next provider
 *   PersonDiscoveryTemporaryFailureError — non-fatal; try next provider
 *   PersonDiscoveryProviderError — catch-all 5xx/malformed; non-fatal; try next
 *
 * Provider credentials must NEVER be logged or appear in attempt records.
 */

import type { PersonDiscoveryCandidate, PersonSearchQuery } from "../../domain/person-discovery-types";

export interface PersonDiscoveryProvider {
  /** Stable provider identifier. Never logged alongside credentials. */
  readonly id: string;

  /**
   * Whether valid credentials are configured for this provider.
   * Returns false → provider is skipped without being called.
   */
  isConfigured(): boolean;

  /**
   * Search for people at the target company matching the query persona.
   *
   * Returns an empty array when no candidates are found (NOT_FOUND is also
   * acceptable via PersonDiscoveryNotFoundError — both mean "try next provider").
   *
   * @throws PersonDiscoveryNotFoundError — explicit not-found from provider
   * @throws PersonDiscoveryRateLimitError — rate limited (retryAfterMs available)
   * @throws PersonDiscoveryAuthError — credentials bad/missing (WATERFALL-FATAL)
   * @throws PersonDiscoveryTemporaryFailureError — transient network failure
   * @throws PersonDiscoveryProviderError — 5xx or unexpected response shape
   */
  searchPeopleForCampaign(query: PersonSearchQuery): Promise<PersonDiscoveryCandidate[]>;
}

// ── Typed error hierarchy ─────────────────────────────────────────────────────

export class PersonDiscoveryProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PersonDiscoveryProviderError";
  }
}

export class PersonDiscoveryNotFoundError extends PersonDiscoveryProviderError {
  constructor(provider: string, companyIdentifier: string) {
    super(`${provider}: no people found for "${companyIdentifier}"`, provider);
    this.name = "PersonDiscoveryNotFoundError";
  }
}

export class PersonDiscoveryRateLimitError extends PersonDiscoveryProviderError {
  constructor(
    provider: string,
    public readonly retryAfterMs: number,
  ) {
    super(`${provider}: rate limited — retry after ${retryAfterMs}ms`, provider);
    this.name = "PersonDiscoveryRateLimitError";
  }
}

/**
 * WATERFALL-FATAL. When this error is thrown, the PersonDiscoveryWaterfall
 * stops immediately without trying remaining providers.
 *
 * Rationale: bad credentials are a configuration problem, not a transient
 * failure. Silently falling through to other providers would mask the issue.
 */
export class PersonDiscoveryAuthError extends PersonDiscoveryProviderError {
  constructor(provider: string, detail?: string) {
    const suffix = detail ? ` — ${detail}` : "";
    super(`${provider}: missing or invalid API credentials${suffix}`, provider);
    this.name = "PersonDiscoveryAuthError";
  }
}

export class PersonDiscoveryTemporaryFailureError extends PersonDiscoveryProviderError {
  constructor(provider: string, detail?: string) {
    const suffix = detail ? `: ${detail}` : "";
    super(`${provider}: temporary failure${suffix}`, provider);
    this.name = "PersonDiscoveryTemporaryFailureError";
  }
}
