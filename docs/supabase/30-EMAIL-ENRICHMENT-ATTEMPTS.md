# EMAIL_ENRICHMENT_ATTEMPTS

## 1. What is this table?

`email_enrichment_attempts` stores one row per provider call within an Email Enrichment Waterfall run. Each row records whether a single provider found an email for the target contact — or what error it returned.

Where `email_enrichment_runs` stores the **final outcome** of a waterfall run, this table stores the **per-provider history** that led to that outcome.

Created by migration `0019_person_discovery.sql` (Stage 24).

## 2. Why does this table exist?

When email enrichment returns `EMAIL_ENRICHMENT_EXHAUSTED`, there is no way from the run row alone to know whether providers returned errors, said "not found," or were simply not tried. This table makes the per-provider history visible for debugging and provider performance analysis.

Specific use cases:
1. **Debugging exhausted runs** — did all providers return NOT_FOUND (contact genuinely missing) or PROVIDER_ERROR (temporary issue, worth retrying)?
2. **Provider performance tracking** — which providers consistently find emails vs. always fail?
3. **Security audit** — verifying that no email addresses appear in `error_message` columns (the sanitizer redacts them)
4. **Idempotency verification** — on re-run, no new attempt rows should be added

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Row identifier |
| `run_id` | uuid | Parent run (→ email_enrichment_runs.id ON DELETE CASCADE) |
| `provider_id` | text | Which provider made this attempt (e.g. `"prospeo"`, `"hunter"`) |
| `attempt_number` | integer | 0-indexed position of this provider in the waterfall sequence |
| `email_found` | boolean | `true` if this provider returned a non-null email; `false` otherwise |
| `error_code` | text | `NOT_FOUND`, `PROVIDER_ERROR`, `RATE_LIMITED`, `AUTH_ERROR`, or `TEMPORARY_FAILURE`; NULL on success (including "not found" via null return — see below) |
| `error_message` | text | Sanitized provider error message (PII and credentials redacted). NULL when no exception was thrown. |
| `attempted_at` | timestamptz | When this provider call started |
| `completed_at` | timestamptz | When this provider call finished |
| `created_at` | timestamptz | Row creation time |

**Deliberately absent:** The found email address. `email_found=true` records that an email was found, not what it was. The email itself is never stored in this table.

## 4. How is it connected to other tables?

```
email_enrichment_runs  →  email_enrichment_attempts.run_id  (ON DELETE CASCADE)
```

**FK ON DELETE behavior:**
- `run_id` → CASCADE (deleting the run deletes all its attempts)

There is no FK to `contacts` in this table — the contact identity is on `email_enrichment_runs.contact_id`, not repeated on every attempt row.

## 5. When is it written to?

**Written by:** `insertEmailEnrichmentAttempt()` in `src/db/email-enrichment.ts` (called once per provider attempt within `persistEmailEnrichmentOutcome()`)

**Write pattern:** Upsert on `(run_id, provider_id, attempt_number)` with `ignoreDuplicates: true`. On re-run of the same waterfall, attempt rows are NOT overwritten — first write wins.

## 6. How is it queried?

**Read all attempts for a run (ordered by attempt_number):**
```typescript
const attempts = await listEmailEnrichmentAttempts(runId);
```

**Read helper:** `listEmailEnrichmentAttempts(runId)` in `src/db/email-enrichment.ts`

## 7. Indexes

| Index name | Columns | Purpose |
|------------|---------|---------|
| `email_enrichment_attempts_pkey` | `id` | Primary key lookups |
| `email_enrichment_attempts_run_provider_number_key` (UNIQUE) | `(run_id, provider_id, attempt_number)` | Idempotency constraint — prevents duplicate attempt rows on re-run |

## 8. Constraints

| Constraint | What it enforces |
|------------|-----------------|
| `email_enrichment_attempts_run_provider_number_key` (UNIQUE) | One row per (run, provider, position) — idempotency target |
| `run_id` FK → `email_enrichment_runs.id` ON DELETE CASCADE | Attempt must belong to a real run |

## 9. Domain concepts

**`email_found` vs `error_code` — the "NOT_FOUND via null return" pattern:**

Email enrichment providers signal "no email found" in two ways:
1. **Return `null`** (no email, no exception) — `email_found=false`, `error_code=null`, `error_message=null`
2. **Throw `NotFoundError`** — `email_found=false`, `error_code="NOT_FOUND"`, `error_message="[sanitized]"`

Both mean the provider has no email. The difference is whether the provider considers it an error condition. Pattern (1) is more common — it's the normal "we checked and found nothing" case. Pattern (2) is used by providers that consider not-found an exceptional state.

This means `error_code=null` does NOT imply success — it means no exception was thrown. The `email_found` column is the authoritative success indicator.

**`email_found=true` does not contain the address:**
The boolean `true` records that an email was found at this position in the waterfall. The address itself is only in the in-memory `EmailEnrichmentOutcome.foundEmail`. It is never stored in this table.

**`error_code` values:**
- `NOT_FOUND` — provider explicitly says no email exists for this person (via exception)
- `PROVIDER_ERROR` — 5xx or malformed response
- `RATE_LIMITED` — throttled (429 or explicit rate-limit message)
- `AUTH_ERROR` — credentials bad or missing; this causes the waterfall to stop
- `TEMPORARY_FAILURE` — network timeout / DNS failure

**`error_message` sanitization:** Same as `person_discovery_attempts` — all error messages pass through `sanitizeProviderError()` before storage. Email addresses in error messages are replaced with `[email redacted]`. Tokens/keys are redacted similarly.

## 10. Security

- **RLS:** Enabled but **no policies defined**. Access via `service_role` only.
- **No email addresses:** `email_found` is a boolean; the found email is never stored here. `error_message` is sanitized to redact any email addresses that appear in provider error strings.
- **No raw provider payloads:** Only counts, error codes, and sanitized messages are recorded.
- **Sanitizer is always applied:** Even when `error_message` looks clean, it passes through the 6-pass sanitizer before storage.

## 11. What this table does NOT contain

- The found email address — `email_found` is a boolean flag; the address is in-memory only
- Provider response confidence scores — used in-memory for candidate selection, not persisted
- Full provider API responses — only metrics and sanitized error strings
- Contact details — those live in `contacts`; only the run's `contact_id` on `email_enrichment_runs` identifies the subject

## 12. Remaining limitations (as of Stage 24)

- `error_code` is a text column with no CHECK constraint — application code enforces the five-value enum
- No email confidence score recorded — if a provider returns 0.45 confidence and the next provider is not tried, there is no record of why the waterfall stopped
- No attempt-level timing beyond `attempted_at` / `completed_at`
- The NOT_FOUND-via-null vs NOT_FOUND-via-exception ambiguity makes it impossible to distinguish "provider has no data" from "provider was not asked" from the attempt row alone — you also need to check `email_found`

## 13. Example rows

**Attempt 0 — provider returned null (no email, no exception):**
```json
{
  "id": "ff00aa11-...",
  "run_id": "e5f6a7b8-...",
  "provider_id": "hunter",
  "attempt_number": 0,
  "email_found": false,
  "error_code": null,
  "error_message": null,
  "attempted_at": "2026-09-09T10:20:10Z",
  "completed_at": "2026-09-09T10:20:12Z",
  "created_at": "2026-09-09T10:20:12Z"
}
```

**Attempt 1 — provider found an email:**
```json
{
  "id": "bb22cc33-...",
  "run_id": "e5f6a7b8-...",
  "provider_id": "prospeo",
  "attempt_number": 1,
  "email_found": true,
  "error_code": null,
  "error_message": null,
  "attempted_at": "2026-09-09T10:20:12Z",
  "completed_at": "2026-09-09T10:20:15Z",
  "created_at": "2026-09-09T10:20:15Z"
}
```

**Attempt with sanitized error:**
```json
{
  "id": "dd44ee55-...",
  "run_id": "c9d0e1f2-...",
  "provider_id": "some-provider",
  "attempt_number": 0,
  "email_found": false,
  "error_code": "PROVIDER_ERROR",
  "error_message": "Auth failed for [email redacted] — check [redacted]",
  "attempted_at": "2026-09-09T10:22:00Z",
  "completed_at": "2026-09-09T10:22:01Z",
  "created_at": "2026-09-09T10:22:01Z"
}
```

In the third example: the provider returned an error whose message originally contained an email address and an API key. `sanitizeProviderError()` replaced both with redacted placeholders before the row was written. The original error is gone — only the sanitized version is in the DB.
