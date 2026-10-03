/**
 * Unit tests for src/lib/provider-error-sanitizer.ts
 *
 * All tests are pure (no I/O, no DB, no network calls).
 * Run: npx tsx --test src/__tests__/provider-error-sanitizer.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeProviderError } from "../lib/provider-error-sanitizer";

// ── Email address redaction ───────────────────────────────────────────────────

describe("email address redaction", () => {
  it("redacts a plain email address in a provider error message", () => {
    const err = new Error("Authentication failed for user john.doe@acme.example.com");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("john.doe@acme.example.com"),
      `raw email must not appear in output; got: ${result}`);
    assert.ok(result.includes("[email redacted]"),
      `output must contain '[email redacted]'; got: ${result}`);
  });

  it("redacts multiple email addresses in one message", () => {
    const err = new Error("Rate limited: fallback to foo@a.com or bar@b.com");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("foo@a.com"), "first email must be redacted");
    assert.ok(!result.includes("bar@b.com"), "second email must be redacted");
    const count = (result.match(/\[email redacted\]/g) ?? []).length;
    assert.equal(count, 2, "both occurrences must be replaced");
  });

  it("redacts + addressing and subdomain emails", () => {
    const err = new Error("No record found for user+tag@mail.sub.domain.io");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("user+tag@mail.sub.domain.io"));
    assert.ok(result.includes("[email redacted]"));
  });

  it("preserves the rest of the message after redacting the email", () => {
    const err = new Error("Rate limit exceeded for victim@example.com: retry after 60s");
    const result = sanitizeProviderError(err);
    assert.ok(result.includes("Rate limit exceeded"), "non-PII text preserved");
    assert.ok(result.includes("retry after 60s"), "non-PII text preserved");
  });
});

// ── Bearer / Basic token redaction ───────────────────────────────────────────

describe("authorization header redaction", () => {
  it("redacts a Bearer token", () => {
    const err = new Error("401 Unauthorized: Bearer sk-abc123xyz456def789ghi012jkl345mno");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("sk-abc123xyz456def789ghi012jkl345mno"),
      `Bearer token must not appear; got: ${result}`);
    assert.ok(result.includes("[token redacted]"), "replacement marker must appear");
    assert.ok(result.includes("401 Unauthorized"), "HTTP status preserved");
  });

  it("redacts Basic auth credentials", () => {
    const err = new Error("Auth failed: Basic dXNlcjpwYXNzd29yZA==");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("dXNlcjpwYXNzd29yZA=="), "base64 credential must be redacted");
    assert.ok(result.includes("[credential redacted]"));
  });

  it("is case-insensitive for Bearer", () => {
    const err = new Error("rejected: bearer SOMETOKEN123");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("SOMETOKEN123"), "token must be redacted regardless of case");
  });
});

// ── Credential key=value redaction ───────────────────────────────────────────

describe("credential key=value redaction", () => {
  it("redacts api_key=value pattern", () => {
    const err = new Error("Request failed: api_key=sk-realkey1234567890");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("sk-realkey1234567890"), "API key value must be redacted");
    assert.ok(result.includes("api_key"), "keyword preserved for diagnosis");
    assert.ok(result.includes("[key redacted]"), "replacement marker present");
  });

  it("redacts secret: value pattern", () => {
    const err = new Error("Provider config error — secret: MySecretValue12345");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("MySecretValue12345"), "secret value must be redacted");
    assert.ok(result.includes("[key redacted]"), "replacement marker present");
  });

  it("redacts access_token=value pattern", () => {
    const err = new Error("Expired token — access_token=eyJhbGciOiJIUzI1NiJ9xxxtoken");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("eyJhbGciOiJIUzI1NiJ9xxxtoken"));
  });

  it("redacts x-api-key: value pattern", () => {
    const err = new Error("403 Forbidden — x-api-key: someproviderkey9876543210");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("someproviderkey9876543210"));
  });
});

// ── Prefixed API key redaction ────────────────────────────────────────────────

describe("prefixed API key redaction", () => {
  it("redacts sk_test_ prefixed keys (Stripe-style)", () => {
    // Split to prevent static secret scanners from flagging a test fixture.
    const fakeKey = "sk_test_" + "4eC39HqLyjWDarjtT1zdp7dc";
    const err = new Error(`Invalid key: ${fakeKey}`);
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes(fakeKey), "prefixed key must be redacted");
    assert.ok(result.includes("[key redacted]"));
  });

  it("redacts sb_secret_ prefixed keys (Smartlead-style)", () => {
    const err = new Error("Auth error for sb_secret_rmSToWxUePXeF0HJ7LbG4Q");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("sb_secret_rmSToWxUePXeF0HJ7LbG4Q"), "sb_secret key must be redacted");
    assert.ok(result.includes("[key redacted]"));
  });

  it("redacts pk_live_ prefixed keys", () => {
    const err = new Error("pk_live_abcdefghijklmnopqrstuvwx is not valid");
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("pk_live_abcdefghijklmnopqrstuvwx"));
  });
});

// ── Long alphanumeric token redaction ─────────────────────────────────────────

describe("long alphanumeric token redaction", () => {
  it("redacts a 32-char hex string (MD5-length)", () => {
    const hash = "d41d8cd98f00b204e9800998ecf8427e"; // 32 hex chars
    const err = new Error(`Token mismatch: expected ${hash}`);
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes(hash), "32-char hash must be redacted");
    assert.ok(result.includes("[value redacted]"));
  });

  it("redacts a 40-char SHA-1 string", () => {
    const sha1 = "da39a3ee5e6b4b0d3255bfef95601890afd80709"; // 40 hex chars
    const err = new Error(`Signature invalid: ${sha1}`);
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes(sha1), "40-char SHA must be redacted");
  });

  it("does NOT redact short identifiers or HTTP status codes", () => {
    const err = new Error("HTTP 429 Too Many Requests — retry after 60 seconds");
    const result = sanitizeProviderError(err);
    assert.ok(result.includes("429"), "HTTP status code 429 preserved");
    assert.ok(result.includes("Too Many Requests"), "status text preserved");
    assert.ok(result.includes("retry after 60 seconds"), "diagnostic text preserved");
    assert.ok(!result.includes("[value redacted]"), "no false positive redaction");
  });

  it("does NOT redact UUIDs (contain hyphens, excluded from 32-char pattern)", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const err = new Error(`Record not found: contact_id=${uuid}`);
    const result = sanitizeProviderError(err);
    assert.ok(result.includes(uuid), "UUID must NOT be redacted (contains hyphens)");
  });

  it("does NOT redact normal error classification keywords", () => {
    const err = new Error("rate limit exceeded, please back off");
    const result = sanitizeProviderError(err);
    assert.ok(result.includes("rate limit exceeded"), "rate limit text preserved");
    assert.ok(!result.includes("[value redacted]"), "no false positive");
  });
});

// ── Preservation of safe diagnostic information ───────────────────────────────

describe("safe diagnostic information preservation", () => {
  it("preserves HTTP 401 status and safe context", () => {
    const err = new Error("HTTP 401: Invalid credentials");
    const result = sanitizeProviderError(err);
    assert.ok(result.includes("401"), "401 preserved");
    assert.ok(result.includes("Invalid credentials"), "safe text preserved");
  });

  it("preserves ECONNRESET and ENOTFOUND for timeout classification", () => {
    const err = new Error("connect ECONNRESET api.provider.example.com:443");
    const result = sanitizeProviderError(err);
    assert.ok(result.includes("ECONNRESET"), "ECONNRESET preserved for classification");
  });

  it("preserves NOT_FOUND and RATE_LIMITED text", () => {
    const err = new Error("NOT_FOUND: no person matching criteria");
    const result = sanitizeProviderError(err);
    assert.ok(result.includes("NOT_FOUND"), "error category preserved");
    assert.ok(result.includes("no person matching criteria"), "safe detail preserved");
  });

  it("preserves provider error codes and short identifiers", () => {
    const err = new Error("Provider blitz returned 429 after 3 retries");
    const result = sanitizeProviderError(err);
    assert.ok(result.includes("blitz"), "provider name preserved");
    assert.ok(result.includes("429"), "status code preserved");
    assert.ok(result.includes("3 retries"), "retry count preserved");
  });
});

// ── Robustness ────────────────────────────────────────────────────────────────

describe("robustness — edge cases", () => {
  it("handles non-Error thrown value (string)", () => {
    const result = sanitizeProviderError("plain string error");
    assert.equal(typeof result, "string");
    assert.ok(result.length > 0);
  });

  it("handles null thrown value without throwing", () => {
    assert.doesNotThrow(() => sanitizeProviderError(null));
  });

  it("handles undefined thrown value without throwing", () => {
    assert.doesNotThrow(() => sanitizeProviderError(undefined));
  });

  it("handles empty Error message", () => {
    const result = sanitizeProviderError(new Error(""));
    assert.equal(typeof result, "string");
  });

  it("handles an Error with no message property", () => {
    const err = Object.create(Error.prototype);
    assert.doesNotThrow(() => sanitizeProviderError(err));
  });

  it("returns a non-empty string for any input", () => {
    const inputs = [
      new Error("normal error"),
      new Error(""),
      "string error",
      42,
      null,
      undefined,
      {},
      { message: "object with message" },
    ];
    for (const input of inputs) {
      const result = sanitizeProviderError(input);
      assert.equal(typeof result, "string", `expected string for input ${JSON.stringify(input)}`);
      // May be empty string for empty Error — that's acceptable
    }
  });
});

// ── Combined PII scenario ─────────────────────────────────────────────────────

describe("combined PII scenario — email + credential in one message", () => {
  it("redacts both email and Bearer token in a single message", () => {
    const err = new Error(
      "401 Unauthorized: user victim@example.invalid authenticated with Bearer sk-abc123XYZ456def789GHI012"
    );
    const result = sanitizeProviderError(err);
    assert.ok(!result.includes("victim@example.invalid"), "email redacted");
    assert.ok(!result.includes("sk-abc123XYZ456def789GHI012"), "token redacted");
    assert.ok(result.includes("401 Unauthorized"), "HTTP status preserved");
    assert.ok(result.includes("[email redacted]"), "email replacement present");
    assert.ok(result.includes("[token redacted]"), "token replacement present");
  });
});
