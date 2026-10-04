# PERSON_DISCOVERY_ATTEMPTS

## 1. What is this table?

`person_discovery_attempts` stores one row per provider call within a Person Discovery Waterfall run. Each row records what a single provider returned (or failed with) when asked to find a relevant contact at a company.

Where `person_discovery_runs` stores the **final outcome** of a waterfall run, this table stores the **per-provider history** that led to that outcome.

Created by migration `0019_person_discovery.sql` (Stage 24).

## 2. Why does this table exist?

Provider behavior is opaque — when a waterfall returns `PERSON_DISCOVERY_EXHAUSTED`, there's no way to tell from the run row alone whether providers failed (errors), returned candidates that Stage 23 rejected (wrong function/seniority), or genuinely had no data. This table makes that history visible.

Specific use cases:
1. **Debugging exhausted runs** — which providers errored vs. returned irrelevant candidates?
2. **Provider performance tracking** — which providers consistently find relevant contacts vs. always return `NOT_FOUND`?
3. **Cost attribution** — how many provider calls were needed per successful discovery?
4. **Idempotency verification** — on re-run, no new attempt rows should be added (upsert with `ignoreDuplicates: true`)

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Row identifier |
| `run_id` | uuid | Parent run (→ person_discovery_runs.id ON DELETE CASCADE) |
| `provider_id` | text | Which provider made this attempt (e.g. `"pb01-prov-a"`, `"prospeo"`) |
| `attempt_number` | integer | 0-indexed position of this provider in the waterfall sequence |
| `candidates_returned` | integer | How many candidates the provider returned before Stage 23 evaluation |
| `candidates_evaluated` | integer | How many candidates were matched to DB contacts and evaluated via Stage 23 |
| `candidate_contact_id` | uuid | Best candidate's contact UUID (→ contacts.id ON DELETE SET NULL) |
| `candidate_relevance_score` | integer | Stage 23 score for the best candidate (0–100); NULL if no candidates evaluated |
| `candidate_is_relevant` | boolean | NULL = no candidate evaluated; true = best candidate was RELEVANT; false = best candidate was rejected |
| `error_code` | text | `NOT_FOUND`, `PROVIDER_ERROR`, `RATE_LIMITED`, `AUTH_ERROR`, or `TEMPORARY_FAILURE`; NULL on success |
| `error_message` | text | Sanitized provider error message (PII and credentials redacted). NULL on success. |
| `attempted_at` | timestamptz | When this provider call started |
| `completed_at` | timestamptz | When this provider call finished |
| `created_at` | timestamptz | Row creation time |

## 4. How is it connected to other tables?

```
person_discovery_runs  →  person_discovery_attempts.run_id  (ON DELETE CASCADE)
contacts               →  person_discovery_attempts.candidate_contact_id  (ON DELETE SET NULL)
```

**FK ON DELETE behavior:**
- `run_id` → CASCADE (deleting the run deletes all its attempts)
- `candidate_contact_id` → SET NULL (preserves attempt history when a contact is deleted)

## 5. When is it written to?

**Written by:** `insertPersonDiscoveryAttempt()` in `src/db/person-discovery.ts` (called once per provider attempt within `persistPersonDiscoveryOutcome()`)

**Write pattern:** Upsert on `(run_id, provider_id, attempt_number)` with `ignoreDuplicates: true`. On re-run of the same waterfall, attempt rows are NOT overwritten — first write wins. This is intentional: the initial attempt is the authoritative record; re-runs that hit the idempotency cache produce no new rows.

## 6. How is it queried?

**Read all attempts for a run (ordered by attempt_number):**
```typescript
const attempts = await listPersonDiscoveryAttempts(runId);
```
Returns rows ordered by `attempt_number ASC`.

**Read helper:** `listPersonDiscoveryAttempts(runId)` in `src/db/person-discovery.ts`

## 7. Indexes

| Index name | Columns | Purpose |
|------------|---------|---------|
| `person_discovery_attempts_pkey` | `id` | Primary key lookups |
| `person_discovery_attempts_run_provider_number_key` (UNIQUE) | `(run_id, provider_id, attempt_number)` | Idempotency constraint — prevents duplicate attempt rows on re-run |

## 8. Constraints

| Constraint | What it enforces |
|------------|-----------------|
| `person_discovery_attempts_run_provider_number_key` (UNIQUE) | One row per (run, provider, position) — idempotency target |
| `run_id` FK → `person_discovery_runs.id` ON DELETE CASCADE | Attempt must belong to a real run |
| `candidate_contact_id` FK → `contacts.id` ON DELETE SET NULL | Candidate contact can be deleted without losing the attempt row |

## 9. Domain concepts

**`candidate_is_relevant` tri-state mapping:**
- `NULL` — no candidates were evaluated (provider returned nothing, or none matched DB contacts)
- `true` — best candidate was judged RELEVANT by Stage 23 (score ≥ 30, no hard disqualifier)
- `false` — best candidate was evaluated but rejected (WRONG_FUNCTION, WRONG_SENIORITY, NO_TITLE, or SCORE_BELOW_THRESHOLD)

This is the `bestCandidateRejectionReason` from the in-memory waterfall: `undefined → null`, `null → true`, `string → false`.

**`error_code` values:**
- `NOT_FOUND` — provider explicitly has no results for this company
- `PROVIDER_ERROR` — 5xx or malformed response
- `RATE_LIMITED` — throttled (429 or explicit rate-limit message)
- `AUTH_ERROR` — credentials bad or missing; this causes the waterfall to stop (waterfall-fatal)
- `TEMPORARY_FAILURE` — network timeout / DNS failure

**`error_message` sanitization:** All error messages pass through `sanitizeProviderError()` in `src/lib/provider-error-sanitizer.ts` before being stored. This redacts: email addresses (`[email redacted]`), Bearer tokens (`[bearer-token]`), Basic auth (`[basic-auth]`), `key=value` pairs (`[redacted]`), long opaque tokens (`[long-token]`). Raw provider errors are never stored.

**`candidate_contact_id` is a UUID:** Provider candidates have `fullName`, `linkedinUrl`, and `companyDomain`. These are matched to DB contacts in memory. Only the matched contact's UUID is stored here — not the name or LinkedIn URL.

## 10. Security

- **RLS:** Enabled but **no policies defined**. Access via `service_role` only.
- **No PII in error messages:** `sanitizeProviderError()` redacts emails and tokens before storage. The redaction runs even when the error looks clean.
- **No raw provider payloads:** Full provider responses (which may include names, emails, and raw JSON) are never stored. Only the sanitized error message and numeric metrics are recorded.
- **candidate_contact_id is a UUID:** No name, email, or LinkedIn URL from the candidate payload persists in this table.

## 11. What this table does NOT contain

- The provider's raw response payload — only counts (`candidates_returned`, `candidates_evaluated`) and the best-candidate UUID
- Candidate names, LinkedIn URLs, or emails — these are transient; only the matched contact UUID persists
- All candidates evaluated — only the BEST candidate per provider attempt is recorded
- Stage 23 scoring breakdown for each candidate — only the final score for the best candidate

## 12. Remaining limitations (as of Stage 24)

- `error_code` is a text column with no CHECK constraint — application code enforces the five-value enum
- Only the BEST candidate per attempt is recorded; if a provider returns 10 candidates of which 3 are relevant but 7 are not, only the top-scoring one appears
- `candidate_relevance_score` has no CHECK constraint matching Stage 23's 0–100 range
- No attempt-level timing metrics beyond `attempted_at` / `completed_at` (no per-candidate evaluation time)

## 13. Example rows

**Attempt 0 — provider returned nothing relevant:**
```json
{
  "id": "aa11bb22-...",
  "run_id": "b3c4d5e6-...",
  "provider_id": "getleads",
  "attempt_number": 0,
  "candidates_returned": 3,
  "candidates_evaluated": 3,
  "candidate_contact_id": "uuid-of-best-candidate",
  "candidate_relevance_score": 12,
  "candidate_is_relevant": false,
  "error_code": null,
  "error_message": null,
  "attempted_at": "2026-09-09T10:15:28Z",
  "completed_at": "2026-09-09T10:15:30Z",
  "created_at": "2026-09-09T10:15:30Z"
}
```

**Attempt 1 — provider found a relevant contact:**
```json
{
  "id": "cc33dd44-...",
  "run_id": "b3c4d5e6-...",
  "provider_id": "prospeo",
  "attempt_number": 1,
  "candidates_returned": 5,
  "candidates_evaluated": 4,
  "candidate_contact_id": "550e8400-e29b-41d4-a716-446655440000",
  "candidate_relevance_score": 93,
  "candidate_is_relevant": true,
  "error_code": null,
  "error_message": null,
  "attempted_at": "2026-09-09T10:15:30Z",
  "completed_at": "2026-09-09T10:15:32Z",
  "created_at": "2026-09-09T10:15:32Z"
}
```

In this example: GetLeads tried first, returned 3 candidates, all evaluated, best scored 12 (not relevant — wrong seniority). Prospeo tried second, returned 5 candidates, 4 matched DB contacts, best scored 93 (RELEVANT). Waterfall stopped at attempt 1.
