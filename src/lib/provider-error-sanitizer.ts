/**
 * Provider error message sanitizer — Stage 24.
 *
 * Provider SDKs may embed PII (email addresses, candidate names) or credential
 * values (API keys, bearer tokens) in exception messages. This module redacts
 * those values before any message is persisted to person_discovery_attempts or
 * email_enrichment_attempts.
 *
 * ── Contract ──────────────────────────────────────────────────────────────────
 *
 * sanitizeProviderError(err) — the only public export.
 *   Input:  any caught exception value.
 *   Output: a sanitized string safe for DB persistence and logging.
 *   Never throws. Never logs the raw message. Returns a safe fallback string
 *   if extraction or sanitization itself fails.
 *
 * ── Redaction scope ───────────────────────────────────────────────────────────
 *
 * ALWAYS redacted:
 *   - email addresses (RFC 5321 pattern)
 *   - Bearer / Basic auth header values
 *   - key=value and key: value patterns for known credential keywords
 *   - prefixed API key formats (sk_*, sb_secret_*, pk_live_*, etc.)
 *   - bare alphanumeric strings >= 32 chars (MD5/SHA/JWT/random token length)
 *
 * PRESERVED:
 *   - HTTP status codes (429, 401, 500, …)
 *   - rate limit / timeout / network error text (classification depends on this)
 *   - error category identifiers (NOT_FOUND, RATE_LIMITED, etc.)
 *   - provider-id string (short label like "blitz", "prospeo")
 *   - UUIDs (contain hyphens — excluded from alphanumeric pattern)
 *   - all other non-sensitive diagnostic text
 *
 * ── Design notes ──────────────────────────────────────────────────────────────
 *
 * classifyErrorCode() reads the raw err.message to detect "rate limit", "429",
 * "timeout", etc. before any sanitization occurs. That read is in-memory only
 * and is never logged or persisted. sanitizeProviderError() is called separately
 * for the persisted string, so classification accuracy is unaffected.
 *
 * Centralized: one module used by both person-discovery-waterfall and
 * email-enrichment-waterfall — a single point of policy.
 */

// ── Replacement labels ────────────────────────────────────────────────────────

const R_EMAIL   = "[email redacted]";
const R_TOKEN   = "[token redacted]";
const R_CRED    = "[credential redacted]";
const R_KEY     = "[key redacted]";
const R_VALUE   = "[value redacted]";

// ── Patterns ─────────────────────────────────────────────────────────────────

/**
 * Email addresses — RFC 5321 local-part @ domain.
 * Covers all practical email formats including + addressing and subdomains.
 */
const EMAIL_RE =
  /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

/**
 * Authorization: Bearer <token>
 * Redacts the token value; preserves the word "Bearer" for readability.
 */
const BEARER_RE = /\bBearer\s+\S+/gi;

/**
 * Authorization: Basic <base64-credential>
 * Redacts the credential; preserves "Basic".
 */
const BASIC_AUTH_RE = /\bBasic\s+[A-Za-z0-9+/]+=*/gi;

/**
 * Credential keyword + assignment patterns.
 *
 * Matches structured forms like:
 *   api_key=sk-abc123      api-key: sk-abc123
 *   token=xyz789           secret="abc"
 *   authorization: Bearer  access_token: eyJ...
 *
 * The value after = or : is replaced; the keyword is preserved for diagnosis.
 */
const CRED_KV_RE =
  /\b(api[_\-]?key|apikey|access[_\-]?token|auth[_\-]?token|authorization|secret|password|credential|x-api-key)\s*[=:]\s*(\S+)/gi;

/**
 * Prefixed API key formats common to SaaS providers.
 *
 * Matches: sk_test_…  sk_live_…  sb_secret_…  sb_publishable_…
 *          pk_live_…  rk_live_…  api_live_…   key_prod_… etc.
 *
 * The two-to-eight char prefix + known qualifier word + underscore ensures
 * this does not fire on ordinary identifiers.
 */
const PREFIXED_KEY_RE =
  /\b[a-z]{2,8}[_\-](?:secret|test|live|prod|publishable|private|public|key)[_\-][A-Za-z0-9_\-]{8,}/gi;

/**
 * Long bare alphanumeric strings (>= 32 chars, no hyphens or underscores).
 *
 * Rationale:
 *   - UUIDs contain hyphens → excluded by character class.
 *   - Longest common English words are ~20 chars. 32+ is outside normal prose.
 *   - MD5 hashes (32 hex), SHA-1 (40 hex), JWT segments, random tokens all hit.
 *   - CamelCase class names sometimes reach 25-28 chars; 32 keeps false-positive
 *     rate low while catching the real targets.
 */
const LONG_TOKEN_RE = /\b[A-Za-z0-9]{32,}\b/g;

// ── Internal helpers ──────────────────────────────────────────────────────────

function extractRawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try { return String(err); } catch { return "[unparseable error]"; }
}

function applyRedactions(s: string): string {
  // Order matters: more specific patterns before generic catch-alls.

  // 1. Email addresses
  s = s.replace(EMAIL_RE, R_EMAIL);

  // 2. Bearer tokens — replaces full "Bearer <value>" with "Bearer [token redacted]"
  s = s.replace(BEARER_RE, `Bearer ${R_TOKEN}`);

  // 3. Basic auth credentials
  s = s.replace(BASIC_AUTH_RE, `Basic ${R_CRED}`);

  // 4. Credential keyword = value patterns
  //    Preserve the keyword (index 1); replace the value (index 2).
  s = s.replace(CRED_KV_RE, (_match, keyword: string) => `${keyword}=${R_KEY}`);

  // 5. Prefixed API keys (sk_live_…, sb_secret_…, etc.)
  s = s.replace(PREFIXED_KEY_RE, R_KEY);

  // 6. Long bare alphanumeric strings (32+ chars — token / hash length)
  s = s.replace(LONG_TOKEN_RE, R_VALUE);

  return s;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract and sanitize a provider exception message for safe persistence.
 *
 * The raw message is accessed internally and never returned or logged.
 * If extraction or sanitization fails, a safe fallback string is returned.
 *
 * @param err  Any caught exception (Error, string, unknown).
 * @returns    Sanitized string safe for DB persistence and structured logs.
 */
export function sanitizeProviderError(err: unknown): string {
  let raw: string;
  try {
    raw = extractRawMessage(err);
  } catch {
    return "[error occurred — message not extractable]";
  }

  try {
    return applyRedactions(raw);
  } catch {
    return "[error occurred — sanitization failed]";
  }
}
