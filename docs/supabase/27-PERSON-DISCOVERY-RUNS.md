# PERSON_DISCOVERY_RUNS

## 1. What is this table?

`person_discovery_runs` stores one row per `(client_id, company_id, campaign_strategy_id)` combination, representing the most recent result of the Person Discovery Waterfall for that account × campaign pairing.

The waterfall finds the right **person** (by function and seniority fit) at a target company for a given campaign. This table is the audit trail for that search — not the contact itself.

Created by migration `0019_person_discovery.sql` (Stage 24).

## 2. Why does this table exist?

Without this table, every "did we already find the right person at this company?" question would require re-running the full waterfall — querying all providers, re-evaluating every candidate through Stage 23, and re-scoring relevance.

The table caches the waterfall result so that:
1. **Idempotency** — re-running the waterfall for an already-processed account skips provider calls and returns the stored result.
2. **Auditability** — you can see which provider found the selected contact, what score they got, and when the search was completed.
3. **Debugging** — the `total_attempts` and `providers_tried` columns show whether providers were exhausted or stopped early.

The row is **overwritten on re-run** (upsert on the unique constraint), not appended. Historical attempt rows are in `person_discovery_attempts`.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Row identifier |
| `client_id` | uuid | Tenant scoping (→ clients.id ON DELETE RESTRICT) |
| `company_id` | uuid | Target account (→ companies.id ON DELETE RESTRICT) |
| `campaign_strategy_id` | uuid | Campaign this search was for (→ campaign_strategies.id, no ON DELETE clause → RESTRICT by default) |
| `state` | text | Terminal state: `RELEVANT_FOUND` or `PERSON_DISCOVERY_EXHAUSTED` |
| `selected_contact_id` | uuid | The chosen contact (→ contacts.id ON DELETE SET NULL). NULL when state=EXHAUSTED or contact deleted. |
| `selected_provider` | text | Which provider found the selected contact (e.g. `"fake-provider"`, `"existing-stage23-result"`) |
| `selected_relevance_score` | integer | Stage 23 relevance score (0–100) for the selected contact |
| `selected_is_qualified` | boolean | `true` if selected contact also passed all Stage 17 eligibility gates |
| `selected_at` | timestamptz | When the selected candidate was chosen |
| `fatal_error_code` | text | `AUTH_ERROR`, `ACCOUNT_NOT_READY`, or `CAMPAIGN_NOT_FOUND` when the waterfall stopped fatally |
| `providers_tried` | text[] | Ordered list of provider IDs attempted this run |
| `total_attempts` | integer | Number of provider calls made |
| `reused_existing_result` | boolean | `true` when a fresh Stage 23 result was found before providers were called |
| `discovery_started_at` | timestamptz | Waterfall start time |
| `discovery_updated_at` | timestamptz | Waterfall completion time |
| `created_at` | timestamptz | Row first inserted |
| `updated_at` | timestamptz | Row last modified |

## 4. How is it connected to other tables?

```
clients           →  person_discovery_runs  ←  campaign_strategies
companies         →  person_discovery_runs
contacts          →  person_discovery_runs.selected_contact_id (ON DELETE SET NULL)
person_discovery_runs  →  person_discovery_attempts.run_id
```

**FK ON DELETE behavior:**
- `client_id`, `company_id`, `campaign_strategy_id` → RESTRICT (default; the run row must be deleted before its referenced row can be deleted)
- `selected_contact_id` → SET NULL (preserves historical audit when a contact is deleted)

## 5. When is it written to?

**Written by:** `persistPersonDiscoveryOutcome()` in `src/db/person-discovery.ts`

**Called from:** `runPersonDiscoveryWaterfall()` in `src/lib/person-discovery-waterfall.ts`, after every waterfall run (successful or exhausted)

**Write pattern:** Upsert on `(client_id, company_id, campaign_strategy_id)` — the unique constraint. Each re-run overwrites the existing row with the new result.

**FK violation handling:** If `client_id` does not exist in `clients` (e.g., a test fixture without a real client row), the insert fails with a FK violation. The waterfall wrapper catches this, skips persistence, and returns the outcome with `persistenceError: { code: "FK_VIOLATION", message: "..." }` — the in-memory result is still correct.

## 6. How is it queried?

**Check if a result already exists (idempotency check before calling providers):**
```typescript
const run = await getPersonDiscoveryRun(clientId, companyId, campaignStrategyId);
if (run?.state === "RELEVANT_FOUND") { /* skip providers */ }
```
Served by the UNIQUE constraint on `(client_id, company_id, campaign_strategy_id)`.

**Read helper:** `getPersonDiscoveryRun(clientId, companyId, campaignStrategyId)` in `src/db/person-discovery.ts`

## 7. Indexes

| Index name | Columns | Purpose |
|------------|---------|---------|
| `person_discovery_runs_pkey` | `id` | Primary key lookups |
| `person_discovery_runs_client_company_strategy_key` (UNIQUE) | `(client_id, company_id, campaign_strategy_id)` | Idempotency constraint + point-lookups |

## 8. Constraints

| Constraint | What it enforces |
|------------|-----------------|
| `person_discovery_runs_client_company_strategy_key` (UNIQUE) | One run per (client, company, campaign) — upsert target |
| `client_id` FK → `clients.id` | Run must belong to a real client |
| `company_id` FK → `companies.id` | Run must target a real company |
| `campaign_strategy_id` FK → `campaign_strategies.id` | Run must reference a real campaign strategy |
| `selected_contact_id` FK → `contacts.id` ON DELETE SET NULL | Selected contact can be deleted without losing the audit row |

## 9. Domain concepts

**`state`:** Two terminal values only:
- `RELEVANT_FOUND` — Stage 23 confirmed at least one candidate is relevant (correct function + seniority for this campaign)
- `PERSON_DISCOVERY_EXHAUSTED` — all configured providers were tried and none yielded a relevant contact (or a fatal error stopped the waterfall early)

**`reused_existing_result`:** When `true`, providers were NOT called. A fresh Stage 23 result for this (company, campaign) already existed in `contact_campaign_relevance`, and the waterfall returned it directly. Useful for understanding when idempotency is doing its job.

**`selected_is_qualified` vs `selected_contact_id`:** A contact can be selected (is the right person type) but not qualified (has no email, or is suppressed). `selected_is_qualified=false` means: right person, currently unreachable. Email enrichment or suppression resolution may fix this.

**PII:** `selected_contact_id` is a UUID, not a name or email. No PII from provider payloads is stored in this table. The waterfall candidate's `fullName`, `linkedinUrl`, and `companyDomain` are transient — evaluated in memory, never persisted here.

## 10. Security

- **RLS:** Enabled (`ALTER TABLE person_discovery_runs ENABLE ROW LEVEL SECURITY`) but **no policies defined**. All access is via the `service_role` key in server-side code. See `25-SUPABASE-SECURITY.md`.
- **Tenant isolation:** Every write scopes `client_id`. The UNIQUE constraint uses `client_id` as the leading column.
- **No PII:** Provider candidate data (names, LinkedIn URLs) never appears in this table. `selected_contact_id` is a UUID.
- **No credentials:** Provider API keys, Bearer tokens, and raw error payloads are never stored here. Sanitized error messages appear only in `person_discovery_attempts`.

## 11. What this table does NOT contain

- Provider error messages — those live in `person_discovery_attempts.error_message` (sanitized)
- Email addresses — `found_email` is deliberately absent; email lives in `contacts.email` or is returned in-memory by the email enrichment waterfall
- Full candidate list — only the winning contact is recorded; all attempts are in `person_discovery_attempts`
- Outreach readiness — `RELEVANT_FOUND` does NOT imply this contact is ready to email; that requires an activation stage gate check
- Multiple history points — each re-run overwrites the single row

## 12. Remaining limitations (as of Stage 24)

- `state` is a text column with no CHECK constraint — application code enforces the two-value enum
- `selected_relevance_score` has no CHECK constraint matching Stage 23's 0–100 range
- No automatic expiry — a `RELEVANT_FOUND` run from 6 months ago will be returned as fresh unless the caller checks `discovery_updated_at` vs the campaign's `updated_at`
- No RLS policies — blocking on auth/tenant-mapping design decision

## 13. Example row

```json
{
  "id": "b3c4d5e6-...",
  "client_id": "a29f5829-5412-49be-9a77-41c3edf3c14b",
  "company_id": "437a05ca-4443-418b-ba2f-37b53531f339",
  "campaign_strategy_id": "f2e1d0c9-...",
  "state": "RELEVANT_FOUND",
  "selected_contact_id": "550e8400-e29b-41d4-a716-446655440000",
  "selected_provider": "prospeo",
  "selected_relevance_score": 93,
  "selected_is_qualified": true,
  "selected_at": "2026-09-09T10:15:32Z",
  "fatal_error_code": null,
  "providers_tried": ["getleads", "prospeo"],
  "total_attempts": 2,
  "reused_existing_result": false,
  "discovery_started_at": "2026-09-09T10:15:28Z",
  "discovery_updated_at": "2026-09-09T10:15:32Z",
  "created_at": "2026-09-09T10:15:32Z",
  "updated_at": "2026-09-09T10:15:32Z"
}
```

In this example:
- `state=RELEVANT_FOUND` — a VP of Sales was found and scored 93 by Stage 23
- `selected_provider="prospeo"` — GetLeads was tried first but returned nothing relevant; Prospeo found the winner
- `selected_is_qualified=true` — the contact has a verified email and is not suppressed
- `reused_existing_result=false` — providers were called (not served from cache)
