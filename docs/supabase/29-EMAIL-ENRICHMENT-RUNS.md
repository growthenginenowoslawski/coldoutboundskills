# EMAIL_ENRICHMENT_RUNS

## 1. What is this table?

`email_enrichment_runs` stores one row per `(client_id, contact_id, campaign_strategy_id)` combination, representing the most recent result of the Email Enrichment Waterfall for a specific person × campaign pairing.

The waterfall finds an **email address** for a contact whose identity is already known (person discovery has already selected them). This table is the audit trail for that search — the email itself is never stored here.

Created by migration `0019_person_discovery.sql` (Stage 24).

## 2. Why does this table exist?

The Email Enrichment Waterfall queries external email-finding providers (Prospeo, Hunter, etc.) which have per-call costs. This table prevents re-querying the same contact for the same campaign multiple times:

1. **Cost control** — if enrichment already ran and found (or didn't find) an email, skip the providers
2. **Auditability** — you can see which provider found the email, when, and how many providers were tried
3. **Debugging** — `total_attempts` and `state` show whether the contact is genuinely unreachable vs. temporarily failed

**Critical PII constraint:** The found email address is **never stored in this table**. It is returned in-memory by the waterfall (`EmailEnrichmentOutcome.foundEmail`) and must be handled by the caller without logging. What IS stored: which provider found it (`found_provider`), when (`found_at`), and provenance metadata — never the address itself.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Row identifier |
| `client_id` | uuid | Tenant scoping (→ clients.id ON DELETE RESTRICT) |
| `contact_id` | uuid | The person whose email was sought (→ contacts.id ON DELETE CASCADE) |
| `campaign_strategy_id` | uuid | Campaign context for this enrichment (→ campaign_strategies.id, RESTRICT by default) |
| `state` | text | Terminal state: `EMAIL_FOUND` or `EMAIL_ENRICHMENT_EXHAUSTED` |
| `found_provider` | text | Which provider found the email (e.g. `"prospeo"`). NULL if state=EXHAUSTED. |
| `found_at` | timestamptz | When the email was found. NULL if state=EXHAUSTED. |
| `providers_tried` | text[] | Ordered list of provider IDs attempted this run |
| `total_attempts` | integer | Number of provider calls made |
| `enrichment_started_at` | timestamptz | Waterfall start time |
| `enrichment_updated_at` | timestamptz | Waterfall completion time |
| `created_at` | timestamptz | Row first inserted |
| `updated_at` | timestamptz | Row last modified |

**Deliberately absent:** `found_email`. The email address is PII and must never be written to this table. Provenance (`found_provider`, `found_at`) is sufficient for audit purposes.

## 4. How is it connected to other tables?

```
clients            →  email_enrichment_runs  ←  campaign_strategies
contacts           →  email_enrichment_runs.contact_id  (ON DELETE CASCADE)
email_enrichment_runs  →  email_enrichment_attempts.run_id
```

**FK ON DELETE behavior:**
- `client_id`, `campaign_strategy_id` → RESTRICT (default; the run row must be deleted before its referenced row can be deleted)
- `contact_id` → CASCADE (deleting a contact removes all their enrichment run history — the contact is the subject of enrichment, so if the contact is gone the audit is no longer meaningful)

## 5. When is it written to?

**Written by:** `persistEmailEnrichmentOutcome()` in `src/db/email-enrichment.ts`

**Called from:** `runEmailEnrichmentWaterfall()` in `src/lib/email-enrichment-waterfall.ts`, after every waterfall run (successful or exhausted)

**Write pattern:** Upsert on `(client_id, contact_id, campaign_strategy_id)` — the unique constraint. Each re-run overwrites the existing row with the new result.

**FK violation handling:** Same as `person_discovery_runs` — if `client_id` does not exist in `clients`, the insert fails, and the waterfall wrapper returns `persistenceError: { code: "FK_VIOLATION" }` without throwing. The in-memory outcome (including `foundEmail`) is still correct.

**What is NOT written:** The `foundEmail` field from `EmailEnrichmentOutcome` is intentionally excluded from the persisted row. Callers receive it in-memory and are responsible for handling it securely.

## 6. How is it queried?

**Check if enrichment already ran for this contact × campaign:**
```typescript
const run = await getEmailEnrichmentRun(clientId, contactId, campaignStrategyId);
if (run?.state === "EMAIL_FOUND") { /* retrieve email from contacts table instead */ }
```

**Read helper:** `getEmailEnrichmentRun(clientId, contactId, campaignStrategyId)` in `src/db/email-enrichment.ts`

## 7. Indexes

| Index name | Columns | Purpose |
|------------|---------|---------|
| `email_enrichment_runs_pkey` | `id` | Primary key lookups |
| `email_enrichment_runs_client_contact_strategy_key` (UNIQUE) | `(client_id, contact_id, campaign_strategy_id)` | Idempotency constraint + point-lookups |

## 8. Constraints

| Constraint | What it enforces |
|------------|-----------------|
| `email_enrichment_runs_client_contact_strategy_key` (UNIQUE) | One run per (client, contact, campaign) — upsert target |
| `client_id` FK → `clients.id` | Run must belong to a real client |
| `contact_id` FK → `contacts.id` ON DELETE CASCADE | Run is tied to the contact's existence |
| `campaign_strategy_id` FK → `campaign_strategies.id` | Run must reference a real campaign strategy |

## 9. Domain concepts

**`state`:** Two terminal values:
- `EMAIL_FOUND` — a provider returned a non-null email address (stored by the caller in `contacts.email`; the address itself never enters this table)
- `EMAIL_ENRICHMENT_EXHAUSTED` — all configured providers were tried and none found an email, or a fatal AUTH_ERROR stopped the waterfall early

**Relationship to `person_discovery_runs`:** Email enrichment only starts after person discovery returns `RELEVANT_FOUND`. The two waterfalls are independent DB tables — there is no FK between `email_enrichment_runs` and `person_discovery_runs`. The shared anchor is `contact_id` (the person discovery run's `selected_contact_id` becomes the email enrichment run's `contact_id`).

**Campaign context:** `campaign_strategy_id` is included because email enrichment behavior may differ per campaign (different provider configurations, different cost budgets). The same contact might be enriched multiple times for different campaigns — each gets its own run row.

**`found_email` is absent by design:** This is not an oversight or a bug. The email address is PII. The DB audit table stores only provenance. If the email needs to be retrieved, query `contacts.email` (where it was written after successful enrichment) or re-run the waterfall.

## 10. Security

- **RLS:** Enabled but **no policies defined**. Access via `service_role` only.
- **No email addresses stored:** `found_email` is deliberately absent from the schema. The waterfall returns it in-memory; it must never be logged or written back to this table.
- **`found_provider` is not PII:** Provider names like `"prospeo"` are system identifiers, not personal data.
- **Tenant isolation:** Every write scopes `client_id`. The UNIQUE constraint uses `client_id` as the leading column.

## 11. What this table does NOT contain

- `found_email` — deliberately absent; email is PII and must not be persisted here
- Per-provider attempt details — those live in `email_enrichment_attempts`
- Confidence scores — provider-reported email confidence is not persisted (it may be used in-memory to select between candidates, but is not stored)
- Contact name or LinkedIn URL — those live in `contacts`

## 12. Remaining limitations (as of Stage 24)

- `state` is a text column with no CHECK constraint — application code enforces the two-value enum
- No automatic expiry — a `EMAIL_ENRICHMENT_EXHAUSTED` run from months ago will be returned as current until explicitly re-run
- No RLS policies — blocking on auth/tenant-mapping design decision
- No cost tracking — unlike `enrichment_runs` (Stage 12), this table does not record tokens or API call costs per provider

## 13. Example row

**EMAIL_FOUND:**
```json
{
  "id": "e5f6a7b8-...",
  "client_id": "a29f5829-5412-49be-9a77-41c3edf3c14b",
  "contact_id": "550e8400-e29b-41d4-a716-446655440000",
  "campaign_strategy_id": "f2e1d0c9-...",
  "state": "EMAIL_FOUND",
  "found_provider": "prospeo",
  "found_at": "2026-09-09T10:20:15Z",
  "providers_tried": ["hunter", "prospeo"],
  "total_attempts": 2,
  "enrichment_started_at": "2026-09-09T10:20:10Z",
  "enrichment_updated_at": "2026-09-09T10:20:15Z",
  "created_at": "2026-09-09T10:20:15Z",
  "updated_at": "2026-09-09T10:20:15Z"
}
```

**EMAIL_ENRICHMENT_EXHAUSTED:**
```json
{
  "id": "c9d0e1f2-...",
  "client_id": "a29f5829-5412-49be-9a77-41c3edf3c14b",
  "contact_id": "661f9511-f3ac-52e5-b827-557766551111",
  "campaign_strategy_id": "f2e1d0c9-...",
  "state": "EMAIL_ENRICHMENT_EXHAUSTED",
  "found_provider": null,
  "found_at": null,
  "providers_tried": ["hunter", "prospeo", "waterfall-fallback"],
  "total_attempts": 3,
  "enrichment_started_at": "2026-09-09T10:22:00Z",
  "enrichment_updated_at": "2026-09-09T10:22:08Z",
  "created_at": "2026-09-09T10:22:08Z",
  "updated_at": "2026-09-09T10:22:08Z"
}
```

In the first example: Hunter tried first but returned no email. Prospeo found it on attempt 2. Note `found_email` is absent — only `found_provider` and `found_at` are recorded. In the second example: three providers were tried; none found an email; the contact remains unreachable for this campaign.
