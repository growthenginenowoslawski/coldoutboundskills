/**
 * Typed errors for outreach provider adapters.
 *
 * Separating error types from the main interface lets callers distinguish
 * credential failures from transient API failures from data-not-found — each
 * warrants a different response (config fix vs retry vs skip).
 */

export class OutreachProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OutreachProviderError";
  }
}

export class OutreachCredentialError extends OutreachProviderError {
  constructor(provider: string, detail?: string) {
    const suffix = detail ? ` — ${detail}` : "";
    super(`${provider}: missing or invalid API credentials${suffix}`, provider);
    this.name = "OutreachCredentialError";
  }
}

export class OutreachRateLimitError extends OutreachProviderError {
  constructor(
    provider: string,
    public readonly retryAfterMs: number,
  ) {
    super(`${provider}: rate limited — retry after ${retryAfterMs}ms`, provider);
    this.name = "OutreachRateLimitError";
  }
}

export class OutreachTimeoutError extends OutreachProviderError {
  constructor(provider: string) {
    super(`${provider}: request timed out`, provider);
    this.name = "OutreachTimeoutError";
  }
}

export class OutreachNotFoundError extends OutreachProviderError {
  constructor(provider: string, resource: string, id: string) {
    super(`${provider}: ${resource} not found — id=${id}`, provider);
    this.name = "OutreachNotFoundError";
  }
}

export class OutreachMalformedResponseError extends OutreachProviderError {
  constructor(provider: string, detail: string) {
    super(`${provider}: malformed provider response — ${detail}`, provider);
    this.name = "OutreachMalformedResponseError";
  }
}
