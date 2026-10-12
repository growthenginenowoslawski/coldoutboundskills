# CAMPAIGNS

## 1. What is this table?

`campaigns` stores the live Smartlead campaigns — one row per campaign running in the email sending platform. This is where approved email sequences become active outbound campaigns. The table bridges the internal campaign planning system and the external Smartlead API.

## 2. Why does this table exist?

Once an `email_sequence` is approved, it gets uploaded to Smartlead as a campaign. This table records the mapping between the internal representation (email_sequences) and the external platform (Smartlead). It tracks campaign status, lead counts, and reply metrics.

**Important note on schema certainty:** The `campaigns` table is referenced in `campaign_reviews.campaign_id` FK and `jobs.campaign_id` FK, but there is no migration file for it in this repository. It was either created directly in the Supabase Dashboard, or it was part of an earlier schema that pre-dates the migration files here. The columns below are inferred from code references and the campaign workflow documentation. Verify the exact schema in the Supabase Dashboard before writing queries against it.

## 3. What data does it store?

Based on FK references and the campaign workflow, the table likely includes:

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier (referenced by campaign_reviews and jobs) |
| `client_id` | uuid | Which client owns this campaign (→ clients.id) |
| `sequence_id` | uuid | Which email sequence this campaign runs (→ email_sequences.id) |
| `smartlead_campaign_id` | text | The campaign ID in Smartlead's system |
| `name` | text | Campaign display name |
| `status` | text | `draft` | `active` | `paused` | `completed` |
| `total_leads` | int | Number of leads uploaded to this campaign |
| `emails_sent` | int | Count of emails sent so far |
| `reply_count` | int | Total replies received |
| `positive_reply_count` | int | Replies classified as positive/interested |
| `created_at` | timestamptz | When this campaign row was created |
| `launched_at` | timestamptz | When the campaign was set to active in Smartlead |

## 4. Primary Key

`id` — UUID.

## 5. Foreign Keys (inferred)

- `client_id → clients(id)`
- `sequence_id → email_sequences(id)`

## 6. What comes before it?

- `email_sequences` with status=approved
- Campaign reviewed and approved via `campaign_reviews`
- `/smartlead-campaign-upload-public` skill uploads the campaign to Smartlead

## 7. What comes after it?

- `campaign_leads` — leads added to this campaign
- `campaign_reviews` — review row references campaign_id
- `jobs` — background jobs for this campaign reference campaign_id
- `/positive-reply-scoring` skill — processes replies for this campaign

## 8. Important safeguard

The `/smartlead-campaign-upload-public` skill **always uploads as DRAFT** — it never automatically starts sending. The user must manually click Start in Smartlead after reviewing the upload. This safeguard must never be bypassed.

## 9. Simple mental model

"campaigns = the live outbound campaigns in Smartlead; bridges the approved email sequence to the external sending platform. One row = one active campaign."

## 10. SQL to inspect it

```sql
-- All active campaigns for Gramscode
SELECT name, status, total_leads, emails_sent, reply_count, launched_at
FROM campaigns
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY launched_at DESC;

-- Reply rate by campaign
SELECT
  name,
  emails_sent,
  reply_count,
  ROUND(100.0 * reply_count / NULLIF(emails_sent, 0), 1) AS reply_rate_pct
FROM campaigns
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
  AND status IN ('active', 'completed')
ORDER BY reply_rate_pct DESC;
```

**Note:** If these queries return errors or unexpected results, inspect the actual column names in the Supabase Dashboard — the schema above is inferred from FK references in other tables, not confirmed from a migration file.
