/**
 * FakePersonDiscoveryProvider — deterministic person discovery for tests.
 *
 * Makes NO external API calls.
 * Modifies NO production data.
 * Contains NO real credentials.
 *
 * Configure with explicit candidates or a predefined error to throw.
 * Fake providers are stateless — each call returns the same result.
 *
 * Usage:
 *   const providerA = makeCandidateProvider("fake-a", [ctoCandidate]);
 *   const providerB = makeNotFoundProvider("fake-b");
 *   const providerC = makeAuthErrorProvider("fake-c");
 */

import type { PersonDiscoveryProvider } from "./types";
import type { PersonDiscoveryCandidate, PersonSearchQuery } from "../../domain/person-discovery-types";
import {
  PersonDiscoveryProviderError,
  PersonDiscoveryNotFoundError,
  PersonDiscoveryRateLimitError,
  PersonDiscoveryAuthError,
  PersonDiscoveryTemporaryFailureError,
} from "./types";

// ── Core fake provider ────────────────────────────────────────────────────────

export interface FakePersonDiscoveryConfig {
  readonly id: string;
  /**
   * Candidates to return from searchPeopleForCampaign.
   * Empty array = no candidates returned (different from NOT_FOUND error).
   */
  candidates?: PersonDiscoveryCandidate[];
  /** When set, throw this error instead of returning candidates. */
  errorToThrow?: PersonDiscoveryProviderError;
  /** Track call count (useful for TC02 early-stop assertions). */
  trackCalls?: boolean;
}

export class FakePersonDiscoveryProvider implements PersonDiscoveryProvider {
  readonly id: string;
  private callCount = 0;

  private readonly candidates: PersonDiscoveryCandidate[];
  private readonly errorToThrow?: PersonDiscoveryProviderError;
  private readonly shouldTrackCalls: boolean;

  constructor(config: FakePersonDiscoveryConfig) {
    this.id = config.id;
    this.candidates = config.candidates ?? [];
    this.errorToThrow = config.errorToThrow;
    this.shouldTrackCalls = config.trackCalls ?? false;
  }

  isConfigured(): boolean {
    return true;
  }

  async searchPeopleForCampaign(_query: PersonSearchQuery): Promise<PersonDiscoveryCandidate[]> {
    if (this.shouldTrackCalls) this.callCount++;
    if (this.errorToThrow) throw this.errorToThrow;
    return [...this.candidates];
  }

  /** Returns how many times searchPeopleForCampaign was called. */
  getCallCount(): number {
    return this.callCount;
  }

  wasNotCalled(): boolean {
    return this.callCount === 0;
  }
}

// ── Convenience constructors ──────────────────────────────────────────────────

/** Provider that returns specific candidates. trackCalls=true lets you assert it was/wasn't called. */
export function makeCandidateProvider(
  id: string,
  candidates: PersonDiscoveryCandidate[],
  opts: { trackCalls?: boolean } = {},
): FakePersonDiscoveryProvider {
  return new FakePersonDiscoveryProvider({
    id,
    candidates,
    trackCalls: opts.trackCalls,
  });
}

/** Provider that throws PersonDiscoveryNotFoundError (explicit "no people here"). */
export function makeNotFoundProvider(
  id: string,
  opts: { trackCalls?: boolean } = {},
): FakePersonDiscoveryProvider {
  return new FakePersonDiscoveryProvider({
    id,
    errorToThrow: new PersonDiscoveryNotFoundError(id, "test-company.invalid"),
    trackCalls: opts.trackCalls,
  });
}

/**
 * Provider that throws PersonDiscoveryRateLimitError.
 * Non-fatal — waterfall continues to next provider.
 */
export function makeRateLimitedProvider(
  id: string,
  retryAfterMs = 5000,
): FakePersonDiscoveryProvider {
  return new FakePersonDiscoveryProvider({
    id,
    errorToThrow: new PersonDiscoveryRateLimitError(id, retryAfterMs),
  });
}

/**
 * Provider that throws PersonDiscoveryAuthError.
 * WATERFALL-FATAL — stops the entire run.
 */
export function makeAuthErrorProvider(
  id: string,
  detail = "API key rejected by test harness",
): FakePersonDiscoveryProvider {
  return new FakePersonDiscoveryProvider({
    id,
    errorToThrow: new PersonDiscoveryAuthError(id, detail),
  });
}

/**
 * Provider that throws PersonDiscoveryTemporaryFailureError.
 * Non-fatal — waterfall continues to next provider.
 */
export function makeTemporaryFailureProvider(
  id: string,
  detail = "simulated connection timeout",
): FakePersonDiscoveryProvider {
  return new FakePersonDiscoveryProvider({
    id,
    errorToThrow: new PersonDiscoveryTemporaryFailureError(id, detail),
  });
}

/**
 * Provider that throws PersonDiscoveryProviderError (5xx/malformed).
 * Non-fatal — waterfall continues to next provider.
 */
export function makeProviderErrorProvider(
  id: string,
  detail = "500 Internal Server Error",
): FakePersonDiscoveryProvider {
  return new FakePersonDiscoveryProvider({
    id,
    errorToThrow: new PersonDiscoveryProviderError(`${id}: ${detail}`, id),
  });
}

/** Provider that returns an empty candidates list (no results, no error). */
export function makeEmptyProvider(id: string): FakePersonDiscoveryProvider {
  return new FakePersonDiscoveryProvider({ id, candidates: [] });
}

// ── Candidate factory helpers ─────────────────────────────────────────────────

/**
 * Build a PersonDiscoveryCandidate matching a DB contact by linkedin URL.
 * The waterfall uses linkedinUrl as the primary key for contact matching.
 *
 * Pass the exact linkedin_url from the test contact row.
 */
export function buildCandidate(opts: {
  fullName: string;
  title: string;
  companyDomain: string;
  linkedinUrl: string;
  source: string;
}): PersonDiscoveryCandidate {
  return {
    fullName: opts.fullName,
    title: opts.title,
    companyDomain: opts.companyDomain,
    linkedinUrl: opts.linkedinUrl,
    source: opts.source,
    discoveredAt: new Date().toISOString(),
  };
}
