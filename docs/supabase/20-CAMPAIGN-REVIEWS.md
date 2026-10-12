# CAMPAIGN_REVIEWS

## 1. What is this table?

`campaign_reviews` tracks the client review cycle before a campaign goes live. One row per review engagement: notify client → share scripts → share list → collect feedback → revisions → get the green light. It's the paper trail for client sign-off.

## 2. Why does this table exist?

Before sending cold emails on a client's behalf, the scripts and lead list must be reviewed and approved by the client. This table records when things were shared, what feedback was received, how many revision rounds were needed, and when/who gave the green light to send. Without this record, disputes about what was approved become impossible to resolve.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier |
| `client_id` | uuid | Which client is reviewing (→ clients.id) |
| `campaign_id` | uuid | Which campaign is being reviewed (→ campaigns.id, nullable) |
| `sequence_id` | uuid | Which email sequence is being reviewed (→ email_sequences.id, nullable) |
| `scripts_shared_at` | timestamptz | When scripts were sent to client for review |
| `list_shared_at` | timestamptz | When the list was sent to client for review |
| `scripts_share_url` | text | Link to shared scripts (Google Doc, Notion, etc.) |
| `list_share_url` | text | Link to shared list (Google Sheet, etc.) |
| `client_feedback` | text | Raw feedback text from the client |
| `revision_notes` | text | What was changed in response to their feedback |
| `revision_count` | int | How many rounds of revisions were needed |
| `approved_by` | text | Name of the client contact who gave green light |
| `approved_at` | timestamptz | When the green light was given |
| `status` | text | Current stage (see below) |
| `created_at` | timestamptz | When this review cycle started |
| `updated_at` | timestamptz | When this row was last updated |

**Status values (the review pipeline):**
- `pending_review` — review cycle just opened; nothing shared yet
- `scripts_shared` — email scripts sent to client
- `list_shared` — lead list also sent to client
- `feedback_received` — client has responded with feedback
- `revisions_made` — revisions completed based on feedback
- `approved` — client gave green light; ready to launch

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `client_id → clients(id)` ON DELETE CASCADE
- `campaign_id → campaigns(id)` ON DELETE SET NULL — if campaign is deleted, review is kept
- `sequence_id → email_sequences(id)` ON DELETE SET NULL — if sequence is deleted, review is kept

## 6. What comes before it?

- `email_sequences` must be written and scored
- `campaigns` may or may not exist at the time of review (some reviews happen before upload)
- Client must be reachable (review happens outside the system — via email/Notion/Slack)

## 7. What comes after it?

No tables depend on `campaign_reviews`. Once approved, the next step is:
- Upload campaign to Smartlead (`/smartlead-campaign-upload-public`)
- Launch campaign → `campaigns.status` set to `active`

## 8. Who writes to this table?

- **`createCampaignReview(slug, review)`** in `src/db/campaign-reviews.ts` — opens a new review cycle
- **`updateCampaignReview(id, updates)`** — moves the review through its stages (share, feedback, revisions)
- **`approveCampaignReview(id, approvedBy)`** — marks the review approved with timestamp

## 9. Who reads from this table?

- **`listCampaignReviews(slug)`** — returns all review cycles for a client in reverse chronological order

## 10. Real example

```
client_id:         a29f5829-... (Gramscode)
sequence_id:       (uuid of "Creative Use Case — ROCI" sequence)
scripts_shared_at: 2026-08-25T10:00:00Z
scripts_share_url: https://docs.google.com/document/d/...
list_shared_at:    2026-08-25T10:05:00Z
list_share_url:    https://docs.google.com/spreadsheets/d/...
client_feedback:   "Love the angles. Can we soften the opener in email 3?
                   Also can you remove the mention of our competitor in step 2."
revision_notes:    "Email 3 opener changed to less direct ask. Competitor
                   reference removed from step 2."
revision_count:    1
approved_by:       Eric M.
approved_at:       2026-08-27T14:30:00Z
status:            approved
```

## 11. How this table participates in a campaign

Campaign review is Step 4 of the Campaign Creation Workflow:

```
email_sequences (written + scored)
  ↓
campaign_reviews (share → feedback → revisions → approved)
  ↓
campaigns (upload to Smartlead as DRAFT)
  ↓
Campaign launch (client clicks Start in Smartlead)
```

The review cycle may have multiple revisions. Each round: update `client_feedback`, increment `revision_count`, update `revision_notes`, update status. When done: `approveCampaignReview()`.

## 12. Simple mental model

"campaign_reviews = the approval paper trail; proves scripts and list were reviewed by the client before any email was sent."

## 13. SQL to inspect it

```sql
-- All open review cycles (not yet approved)
SELECT client_id, status, scripts_shared_at, revision_count, created_at
FROM campaign_reviews
WHERE status != 'approved'
ORDER BY created_at DESC;

-- Gramscode review history
SELECT status, approved_by, approved_at, revision_count, created_at
FROM campaign_reviews
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY created_at DESC;

-- Average revision rounds (how many rounds of feedback are typical?)
SELECT ROUND(AVG(revision_count), 1) AS avg_revisions
FROM campaign_reviews
WHERE status = 'approved';

-- Reviews waiting for client feedback
SELECT cr.id, c.name AS client, cr.scripts_shared_at, cr.status
FROM campaign_reviews cr
JOIN clients c ON c.id = cr.client_id
WHERE cr.status IN ('scripts_shared', 'list_shared')
ORDER BY cr.scripts_shared_at;
```
