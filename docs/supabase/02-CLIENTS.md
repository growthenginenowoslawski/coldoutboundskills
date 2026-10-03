# CLIENTS

## 1. What is this table?

The `clients` table is the very top of the data hierarchy. Every other piece of data in the database — signals, companies, contacts, campaigns — belongs to a client. Think of a client as "the business using this GTM system." Right now there is one client: Gramscode.

When you add a second business to this system, you create a second row in `clients`. That business's data will never mix with Gramscode's data because every table uses `client_id` to keep them separate.

## 2. Why does this table exist?

Without `clients`, the system couldn't tell "which data belongs to whom." It makes the database multi-tenant: one database can safely serve multiple businesses with zero data bleed between them. It is the anchor that every other table hangs from.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this client. Every other table references this via `client_id`. |
| `name` | text (required) | Human-readable business name, e.g., "Gramscode" |
| `website` | text | Business website URL, e.g., "https://gramscode.com" |
| `slug` | text (required, unique) | URL-safe short name, e.g., "gramscode". Used by scripts to look up a client without needing the UUID. |
| `created_at` | timestamptz | When this client was created |
| `updated_at` | timestamptz | When this client was last modified |

## 4. Primary Key

`id` — a UUID generated automatically by PostgreSQL (`gen_random_uuid()`). It looks like: `a29f5829-5412-49be-9a77-41c3edf3c14b`. This is the Gramscode client's ID.

## 5. Foreign Keys

None. `clients` is the root table — it has no parent. Everything else points to it.

## 6. What comes before it?

Nothing. The `clients` table is created first (migration 0002). Before a client exists, nothing else in the database can exist.

## 7. What comes after it?

Everything. These tables all have a `client_id → clients(id)` foreign key:
- `icp_onboarding` — the 12 ICP questions
- `lead_magnets` — offer ideas
- `campaign_strategies` — campaign angles
- `campaign_plans` — the synthesized plan
- `email_sequences` — written copy
- `list_quality_scores` — list scorecards
- `campaign_reviews` — approval tracking
- `enrichment_runs` — AI call ledger
- `signals` — buying signal events

## 8. Who writes to this table?

- The migration seed (0002) creates the Gramscode client automatically
- The `/cold-email-kickoff` skill creates new client rows when onboarding a new business
- Manual creation via Supabase Dashboard for new clients

## 9. Who reads from this table?

- `getClientIdBySlug(slug)` in `src/db/onboarding.ts` — used by every skill that needs to look up a client by slug
- Integration tests (the Stage 10.5 and Stage 11 tests verify Gramscode exists)
- All skills that write to other tables first resolve the client by slug to get the `id`

## 10. Real example

The Gramscode client row:
```
id:         a29f5829-5412-49be-9a77-41c3edf3c14b
name:       Gramscode
website:    https://gramscode.com
slug:       gramscode
created_at: (when migration 0002 ran)
```

## 11. How this table participates in a campaign

Every campaign starts here. The very first step of any operation is resolving the client: `getClientIdBySlug('gramscode')` returns the UUID. That UUID (`client_id`) travels through the entire pipeline and stamps every row created — companies discovered, signals ingested, AI runs made, emails sent — with Gramscode's identity.

## 12. Simple mental model

"clients = the business using this system; every row in the database ultimately traces back to a client."

## 13. SQL to inspect it

```sql
-- See all clients
SELECT id, name, slug, website, created_at
FROM clients
ORDER BY created_at;

-- Find Gramscode specifically
SELECT * FROM clients WHERE slug = 'gramscode';

-- Count how many records belong to Gramscode across key tables
SELECT
  (SELECT COUNT(*) FROM icp_onboarding WHERE client_id = c.id)        AS icp_answers,
  (SELECT COUNT(*) FROM lead_magnets WHERE client_id = c.id)           AS lead_magnets,
  (SELECT COUNT(*) FROM campaign_strategies WHERE client_id = c.id)    AS strategies,
  (SELECT COUNT(*) FROM signals WHERE client_id = c.id)                AS signals,
  (SELECT COUNT(*) FROM enrichment_runs WHERE client_id = c.id)        AS ai_runs
FROM clients c
WHERE c.slug = 'gramscode';
```
