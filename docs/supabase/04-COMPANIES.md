# COMPANIES

## 1. What is this table?

The `companies` table is your prospect database. Every company you've ever sourced — through Prospeo, Apify, manual addition, or the signal test suite — lives here as one row. It's the central account record that contacts, signals, enrichment runs, and list memberships all point back to.

## 2. Why does this table exist?

Companies are the fundamental unit of B2B outreach. Before you can send an email, you need to know which company you're targeting. This table is the single source of truth for all target accounts. It intentionally avoids duplicates by using domain as the primary dedup key — if stripe.com already exists, you don't create a second row for it.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this company |
| `name` | text (required) | Company name, e.g., "Stripe" |
| `domain` | text | Bare domain, e.g., "stripe.com" (no www, no https) |
| `website_url` | text | Full website URL, e.g., "https://stripe.com" |
| `industry` | text | Industry description from the data source |
| `company_size` | text | Headcount as a string, e.g., "50" or "1000-5000" |
| `country` | text | Country, e.g., "United Kingdom" |
| `city` | text | City, e.g., "London" |
| `region` | text | State/region, e.g., "England" |
| `status` | text | `review` (default), `approved`, or `rejected` — the human review stage |
| `source` | text | Where this company came from: "prospeo", "apify", "stage11-test" |
| `icp_score` | int | AI-assigned ICP fit score (0-100). Updated after qualification. |
| `created_at` | timestamptz | When this company was first added |
| `updated_at` | timestamptz | When this company was last modified |

**Status values:**
- `review` — newly sourced, not yet reviewed (all companies start here)
- `approved` — manually approved as a good ICP fit
- `rejected` — manually disqualified

**Important:** The AI qualification (`icp_score`) does NOT change `status`. You must manually move a company from `review` to `approved`. This is a deliberate safeguard.

## 4. Primary Key

`id` — UUID, auto-generated. Example for Stripe: `cac84e2a-caf5-4248-9190-17227de64af8`.

## 5. Foreign Keys

None. `companies` is a root entity — it doesn't point to any other table.

(Other tables point TO it: signals, contacts, enrichment_runs, list_members all have `company_id → companies.id`.)

## 6. What comes before it?

Nothing in the database — `companies` is a root table. But in practice, the ICP definition (from `icp_onboarding`) informs which companies get sourced. List building comes after you know your ICP.

## 7. What comes after it?

- `contacts` — people at this company
- `enrichment_runs` — AI qualification results for this company
- `signals` — buying signals detected at this company
- `list_members` — which lists this company appears on

## 8. Who writes to this table?

- **`prospeo-pull.ts`** — inserts companies sourced from Prospeo search results
- **`run-company-research.ts`** — inserts companies from other research sources
- **List-builder skills** (list-builder, blitz-list-builder, etc.) — insert companies they discover
- **Integration tests** — the Stage 11 test creates Stripe, OpenAI, Notion, and Anthropic rows for testing
- **`storeQualification()`** in `qualifications.ts` — updates `icp_score` when AI qualification runs

## 9. Who reads from this table?

- **`qualify-list.ts`** — reads company details to feed to the AI qualifier
- **`findExistingCompanyId()`** in `companies.ts` — dedup check before inserting
- **`signal-ingestion` Trigger.dev task** — reads `domain` to resolve company IDs for API calls
- **`show-contacts.ts`** — joins to `contacts` via company_id for display

## 10. Real example

Stripe as it exists in the database after Stage 11 testing:
```
id:           cac84e2a-caf5-4248-9190-17227de64af8
name:         Stripe
domain:       stripe.com
website_url:  https://stripe.com
industry:     (from source)
company_size: (from source)
status:       review
source:       stage11-test
icp_score:    (null until AI qualifies it)
```

## 11. How this table participates in a campaign

Companies are the starting point for list building. Once you have a list of companies in this table, you:
1. Link them to a list via `list_members`
2. Run AI qualification → `enrichment_runs` updated, `icp_score` written back here
3. Run the list quality scorecard
4. Source contacts for the approved companies
5. Eventually, contacts from these companies become `campaign_leads`

## 12. Simple mental model

"companies = your prospect database; every target account you've ever researched, each one row."

## 13. SQL to inspect it

```sql
-- See all companies with their status and ICP score
SELECT name, domain, status, icp_score, source, created_at
FROM companies
ORDER BY icp_score DESC NULLS LAST;

-- Find companies in a specific list
SELECT c.name, c.domain, c.status, c.icp_score
FROM companies c
JOIN list_members lm ON lm.company_id = c.id
JOIN lists l ON l.id = lm.list_id
WHERE l.name ILIKE '%ROCI ICP%'
ORDER BY c.icp_score DESC NULLS LAST;

-- Companies that have signals (buying activity detected)
SELECT DISTINCT c.name, c.domain, COUNT(s.id) AS signal_count
FROM companies c
JOIN signals s ON s.company_id = c.id
GROUP BY c.id, c.name, c.domain
ORDER BY signal_count DESC;

-- Check dedup: any domain appears more than once?
SELECT domain, COUNT(*) AS count
FROM companies
WHERE domain IS NOT NULL
GROUP BY domain
HAVING COUNT(*) > 1;
```
