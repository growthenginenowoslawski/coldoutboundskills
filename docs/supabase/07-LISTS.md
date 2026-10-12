# LISTS

## 1. What is this table?

The `lists` table stores named batches of companies or contacts. When you run a list-building script, it creates one row in `lists` (e.g., "ROCI ICP - UK Agency Founders Aug 2026") and then populates `list_members` with the actual records.

Think of a list like a named folder. The folder itself is one row here. The contents of the folder are in `list_members`.

## 2. Why does this table exist?

You run multiple list-building campaigns over time. Without named lists, you'd have no way to say "these 200 companies are from the UK agency run in August" vs. "these 500 are from the fintech run in September." Lists give you:
- Organizational clarity (named batches)
- A unit of work for quality scoring (`list_quality_scores` references `list_id`)
- A pipeline stage tracker (`enrichment_status` column)
- Background job association (`jobs.list_id`)

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this list |
| `name` | text | Human-readable name, e.g., "ROCI ICP - UK Agency Founders Aug 2026" |
| `environment` | text | "production" or "test" — distinguishes real campaigns from testing |
| `status` | text | "active", "archived", etc. |
| `description` | text | Optional longer description of this list's purpose |
| `clay_imported_at` | timestamptz | When the list was imported to Clay for enrichment (added by migration 0006) |
| `clay_table_url` | text | URL to the Clay table built for this list |
| `enrichment_status` | text | Pipeline stage: `pending` → `clay_imported` → `enriched` → `verified` → `ready` |
| `created_at` | timestamptz | When this list was created |
| `updated_at` | timestamptz | When this list was last modified |

**Enrichment status values:**
- `pending` — just created, no enrichment yet
- `clay_imported` — list has been imported to Clay
- `enriched` — Clay has run enrichment (emails, LinkedIn, etc.)
- `verified` — emails verified via Millionverifier or Enirchley
- `ready` — fully processed and ready for campaign upload

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

None. `lists` is a root table — nothing points from it to other tables. Other tables point to it:
- `list_members.list_id → lists.id`
- `list_quality_scores.list_id → lists.id`
- `jobs.list_id → lists.id`
- `contacts.list_id → lists.id` (direct FK, pre-migration)

## 6. What comes before it?

Nothing — a list can be created independently. In practice, the ICP and campaign strategy inform what type of list to build.

## 7. What comes after it?

- `list_members` — the companies and contacts in this list
- `list_quality_scores` — scorecard results for this list
- `jobs` — background tasks associated with this list

## 8. Who writes to this table?

- **`createList()` in `src/db/companies.ts`** — creates a list row when starting a new sourcing run
- **`prospeo-pull.ts`** — calls createList() before inserting contacts
- **Any list-building skill** — creates one list per run
- **Migration 0006** — added clay_imported_at, clay_table_url, enrichment_status columns

## 9. Who reads from this table?

- **`show-contacts.ts`** — searches lists by name to find contacts
- **`list-test-lists.ts`** — lists all lists (for inspection)
- **`list_quality_scores` skill** — reads list_id to associate a scorecard run

## 10. Real example

```
id:                (uuid)
name:              ROCI ICP - UK Agency Founders Aug 2026
environment:       production
status:            active
enrichment_status: enriched
clay_imported_at:  2026-08-15T09:00:00Z
clay_table_url:    https://clay.com/t/...
created_at:        2026-08-14T18:00:00Z
```

## 11. How this table participates in a campaign

Lists are the batch unit for campaigns. The full pipeline:
1. List created → this table
2. Companies/contacts added → `list_members`
3. Clay enrichment → `enrichment_status` updated here
4. Email verification → `email_verifications` written
5. Scorecard run → `list_quality_scores` written (references this list)
6. Campaign built from this list → `campaign_reviews` → `campaigns` → `campaign_leads`

## 12. Simple mental model

"lists = named batches of prospects; one row per sourcing run, like a folder with a label."

## 13. SQL to inspect it

```sql
-- All lists, newest first
SELECT id, name, environment, status, enrichment_status, created_at
FROM lists
ORDER BY created_at DESC;

-- Lists ready for campaign upload
SELECT id, name, enrichment_status, created_at
FROM lists
WHERE enrichment_status = 'ready'
ORDER BY created_at DESC;

-- How many companies/contacts are in each list?
SELECT l.name,
       COUNT(CASE WHEN lm.company_id IS NOT NULL THEN 1 END) AS companies,
       COUNT(CASE WHEN lm.contact_id IS NOT NULL THEN 1 END) AS contacts
FROM lists l
LEFT JOIN list_members lm ON lm.list_id = l.id
GROUP BY l.id, l.name
ORDER BY l.created_at DESC;

-- Quality scores for each list
SELECT l.name, lqs.grade, lqs.overall_score, lqs.total_rows, lqs.scored_at
FROM lists l
JOIN list_quality_scores lqs ON lqs.list_id = l.id
ORDER BY lqs.scored_at DESC;
```
