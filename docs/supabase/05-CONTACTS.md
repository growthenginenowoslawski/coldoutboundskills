# CONTACTS

## 1. What is this table?

The `contacts` table stores individual people at target companies. Each row is one person — their name, job title, email address, LinkedIn URL, and which company they work for. These are the actual humans you'll send emails to.

## 2. Why does this table exist?

B2B outreach is person-to-person, not company-to-company. You don't email "Stripe" — you email the VP of Marketing at Stripe. This table bridges the gap between a target company and the specific decision-maker you want to reach.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this person |
| `company_id` | uuid | Which company they work at (→ companies.id) |
| `first_name` | text | First name |
| `last_name` | text | Last name |
| `full_name` | text | Full name (often populated even if first/last aren't split) |
| `job_title` | text | Current job title, e.g., "Founder", "Head of New Business" |
| `linkedin_url` | text | LinkedIn profile URL — primary dedup key |
| `email` | text | Email address — secondary dedup key |
| `email_status` | text | Verification status from Prospeo, e.g., "VERIFIED" |
| `status` | text | `review` (default), `approved`, `rejected` |
| `source` | text | Where this contact came from, e.g., "prospeo" |
| `list_id` | uuid | Direct link to a list (alternative to list_members junction) |
| `created_at` | timestamptz | When this contact was added |

**Note on list membership:** Contacts can belong to a list in two ways:
1. **Direct FK:** `contacts.list_id → lists.id` (simpler, one list per contact)
2. **Junction table:** `list_members.contact_id → contacts.id` (flexible, multiple lists)

Both patterns exist in the codebase. `prospeo-pull.ts` uses `list_members`.

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `company_id → companies(id)` — which company they work at
- `list_id → lists(id)` — optional direct list assignment

## 6. What comes before it?

- `companies` must exist first — you can't have a contact without a company
- `lists` must exist if using the `list_id` direct FK

## 7. What comes after it?

- `list_members` — junction rows linking this contact to lists
- `campaign_leads` — when this contact is assigned to a campaign (planned)
- `email_verifications` — email deliverability checks on this contact's email

## 8. Who writes to this table?

- **`prospeo-pull.ts`** — the primary writer; inserts contacts sourced from Prospeo search API
- **`prospeo-enrich.ts`** — updates email addresses by running Prospeo's enrich-person endpoint
- **Clay enrichment** — adds or updates contacts after Clay processing

Dedup logic in `prospeo-pull.ts`:
1. Check if `linkedin_url` already exists → skip if found
2. Check if `email` already exists → skip if found
3. Otherwise insert new row

## 9. Who reads from this table?

- **`show-contacts.ts`** — lists all contacts in a given list (joins to companies)
- **Campaign lead selection** — reads contacts for campaign assignment
- **AI personalization tasks** — reads contact details to personalize emails

## 10. Real example

A contact sourced from Prospeo for the ROCI ICP list:
```
id:           (uuid)
company_id:   (uuid pointing to their company)
first_name:   Sarah
last_name:    Mitchell
full_name:    Sarah Mitchell
job_title:    Managing Director
linkedin_url: https://linkedin.com/in/sarah-mitchell-md
email:        sarah@agencyname.co.uk
email_status: VERIFIED
status:       review
source:       prospeo
```

## 11. How this table participates in a campaign

Contacts are the final pre-campaign step. The pipeline flows:
1. Companies sourced → `companies` table
2. Contacts sourced for those companies → `contacts` table
3. Contacts linked to a list → `list_members`
4. List verified and scored → `list_quality_scores`
5. Emails verified → `email_verifications`
6. Campaign launched → `campaign_leads` created per contact

The contact's `email` and `full_name` are what goes into Smartlead when uploading a campaign.

## 12. Simple mental model

"contacts = the actual humans you'll email; one row per person at a target company."

## 13. SQL to inspect it

```sql
-- All contacts for a specific company
SELECT full_name, job_title, email, email_status, status
FROM contacts
WHERE company_id = 'cac84e2a-caf5-4248-9190-17227de64af8'  -- Stripe
ORDER BY created_at;

-- Contacts in a list (via list_members)
SELECT c.full_name, c.job_title, c.email, c.email_status,
       co.name AS company, co.domain
FROM contacts c
JOIN list_members lm ON lm.contact_id = c.id
JOIN companies co ON co.id = c.company_id
WHERE lm.list_id = 'your-list-id-here'
ORDER BY co.name, c.full_name;

-- Contacts missing emails (need enrichment)
SELECT full_name, job_title, linkedin_url, source
FROM contacts
WHERE email IS NULL
  AND linkedin_url IS NOT NULL
ORDER BY created_at DESC;

-- Count by status
SELECT status, COUNT(*) AS count
FROM contacts
GROUP BY status
ORDER BY count DESC;
```
