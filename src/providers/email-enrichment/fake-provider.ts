/**
 * FakeEmailEnrichmentProvider — deterministic email enrichment for tests.
 *
 * Makes NO external API calls.
 * Modifies NO production data.
 * Contains NO real credentials.
 *
 * Configure with an email to return (EMAIL_FOUND), null (NOT_FOUND),
 * or a predefined error to throw.
 *
 * IMPORTANT: The email returned by this fake is a test address (.invalid TLD).
 * It must never be used in real email sending.
 *
 * Usage:
 *   const emailProviderA = makeEmailNotFoundProvider("fake-email-a");
 *   const emailProviderB = makeEmailFoundProvider("fake-email-b", "vp.sales@test.invalid");
 */

import type { EmailEnrichmentProvider } from "./types";
import type { EmailEnrichmentCandidate, EmailEnrichmentQuery } from "../../domain/person-discovery-types";
import {
  EmailEnrichmentProviderError,
  EmailEnrichmentRateLimitError,
  EmailEnrichmentAuthError,
  EmailEnrichmentTemporaryFailureError,
} from "./types";

// ── Core fake provider ────────────────────────────────────────────────────────

export interface FakeEmailEnrichmentConfig {
  readonly id: string;
  /** Email to return. null = NOT_FOUND (provider has no result). */
  foundEmail?: string | null;
  /** Provider-reported confidence for the returned email. Default 0.9. */
  confidence?: number;
  /** When set, throw this error instead of returning a result. */
  errorToThrow?: EmailEnrichmentProviderError;
  trackCalls?: boolean;
}

export class FakeEmailEnrichmentProvider implements EmailEnrichmentProvider {
  readonly id: string;
  private callCount = 0;

  private readonly foundEmail: string | null | undefined;
  private readonly confidence: number;
  private readonly errorToThrow?: EmailEnrichmentProviderError;
  private readonly shouldTrackCalls: boolean;

  constructor(config: FakeEmailEnrichmentConfig) {
    this.id = config.id;
    this.foundEmail = config.foundEmail ?? null;
    this.confidence = config.confidence ?? 0.9;
    this.errorToThrow = config.errorToThrow;
    this.shouldTrackCalls = config.trackCalls ?? false;
  }

  isConfigured(): boolean {
    return true;
  }

  async findEmailForPerson(_query: EmailEnrichmentQuery): Promise<EmailEnrichmentCandidate | null> {
    if (this.shouldTrackCalls) this.callCount++;
    if (this.errorToThrow) throw this.errorToThrow;
    if (!this.foundEmail) return null;
    return {
      email: this.foundEmail,
      confidence: this.confidence,
      source: this.id,
      foundAt: new Date().toISOString(),
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  wasNotCalled(): boolean {
    return this.callCount === 0;
  }
}

// ── Convenience constructors ──────────────────────────────────────────────────

/** Provider that returns an email address (EMAIL_FOUND). */
export function makeEmailFoundProvider(
  id: string,
  email: string,
  opts: { confidence?: number; trackCalls?: boolean } = {},
): FakeEmailEnrichmentProvider {
  return new FakeEmailEnrichmentProvider({
    id,
    foundEmail: email,
    confidence: opts.confidence,
    trackCalls: opts.trackCalls,
  });
}

/** Provider that returns null (NOT_FOUND — try next provider). */
export function makeEmailNotFoundProvider(
  id: string,
  opts: { trackCalls?: boolean } = {},
): FakeEmailEnrichmentProvider {
  return new FakeEmailEnrichmentProvider({
    id,
    foundEmail: null,
    trackCalls: opts.trackCalls,
  });
}

/**
 * Provider that throws EmailEnrichmentRateLimitError.
 * Non-fatal — waterfall continues.
 */
export function makeEmailRateLimitedProvider(
  id: string,
  retryAfterMs = 5000,
): FakeEmailEnrichmentProvider {
  return new FakeEmailEnrichmentProvider({
    id,
    errorToThrow: new EmailEnrichmentRateLimitError(id, retryAfterMs),
  });
}

/**
 * Provider that throws EmailEnrichmentAuthError.
 * WATERFALL-FATAL — stops the entire email enrichment run.
 */
export function makeEmailAuthErrorProvider(
  id: string,
  detail = "API key rejected by test harness",
): FakeEmailEnrichmentProvider {
  return new FakeEmailEnrichmentProvider({
    id,
    errorToThrow: new EmailEnrichmentAuthError(id, detail),
  });
}

/** Provider that throws EmailEnrichmentTemporaryFailureError. Non-fatal. */
export function makeEmailTemporaryFailureProvider(
  id: string,
  detail = "simulated network timeout",
): FakeEmailEnrichmentProvider {
  return new FakeEmailEnrichmentProvider({
    id,
    errorToThrow: new EmailEnrichmentTemporaryFailureError(id, detail),
  });
}

/** Provider that throws EmailEnrichmentProviderError (5xx). Non-fatal. */
export function makeEmailProviderErrorProvider(
  id: string,
  detail = "500 Internal Server Error",
): FakeEmailEnrichmentProvider {
  return new FakeEmailEnrichmentProvider({
    id,
    errorToThrow: new EmailEnrichmentProviderError(`${id}: ${detail}`, id),
  });
}
