# EMAIL_VERIFICATIONS

## 1. What is this table?

`email_verifications` stores the results of checking whether an email address is deliverable. The system uses third-party verification providers (Millionverifier and Enirchley) to test each email before sending. Results land in this table.

**Important note on schema certainty:** The base schema for this table was created directly in the Supabase Dashboard (not via a migration file in this repository). The application code in this codebase does not directly reference this table — it's used upstream by Clay enrichment and the email verification step of the campaign workflow. The information below is inferred from migration comments and campaign workflow documentation, not directly from code. If you need to verify the exact columns, inspect the table in the Supabase Dashboard.

## 2. Why does this table exist?

Sending emails to bad addresses is one of the most damaging things you can do to your domain reputation. Every bounce hurts your domain's deliverability score. The email verification step exists to scrub bad addresses before they ever hit your email sending platform (Smartlead). This table records what each verification service said about each email.

## 3. What data does it store?

Based on migration 0006 comments and the campaign workflow documentation, the table likely includes:

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this verification result |
| `provider` | text | Which service verified it: "millionverifier" or "enirchley" |
| `email` | text | The email address that was verified |
| `status` | text | Verification result: "valid", "invalid", "catch_all", "unknown", etc. |
| `result` | jsonb | Full raw response from the provider |
| `contact_id` | uuid | Likely links to contacts.id (presumed) |
| `created_at` | timestamptz | When this verification was run |

**Verification status values (typical for these providers):**
- `valid` — safe to send; inbox confirmed to exist
- `catch_all` — the domain accepts all email (risky; could bounce)
- `invalid` — this address does not exist; do not send
- `unknown` — couldn't verify; use caution

## 4. Primary Key

`id` — UUID (presumed based on all other tables in this system).

## 5. Foreign Keys

Likely: `contact_id → contacts(id)` (not confirmed in code).

## 6. What comes before it?

- `contacts` must exist with email addresses
- Millionverifier or Enirchley API credentials must be configured
- Clay enrichment typically runs before verification (to get email addresses first)

## 7. What comes after it?

- `list_quality_scores.email_verification_score` — the scorecard uses verification results to grade the list
- Campaign upload — only "valid" and high-confidence emails go to Smartlead

## 8. Who writes to this table?

Based on workflow documentation:
- The Clay enrichment workflow (via the Clay → Millionverifier integration)
- Or a future `/email-verification` skill

## 9. Who reads from this table?

- The `/list-quality-scorecard` skill reads verification results to compute `email_verification_score`
- Campaign upload process filters to verified emails only

## 10. Real example

After verifying a contact's email via Millionverifier:
```
provider:   millionverifier
email:      sarah@agencyname.co.uk
status:     valid
result:     { "result": "ok", "free": false, "role": false, "disposable": false }
created_at: 2026-08-20T14:00:00Z
```

## 11. How this table participates in a campaign

Email verification sits between contact sourcing and campaign launch:

```
contacts (emails sourced)
  ↓
email_verifications (each email checked)
  ↓
list_quality_scores (email_verification_score calculated)
  ↓
campaign_reviews (only valid emails included)
  ↓
campaign upload (only valid/verified emails sent)
```

The rule: never send to an email marked `invalid`. For `catch_all` emails, consider the risk — UK agencies tend to use catch-all domains, which is why `catchall_density_score` is a separate dimension in the quality scorecard.

## 12. Simple mental model

"email_verifications = proof that each email address exists before you risk your domain reputation by sending to it."

## 13. SQL to inspect it

```sql
-- Summary of verification results
SELECT provider, status, COUNT(*) AS count
FROM email_verifications
GROUP BY provider, status
ORDER BY count DESC;

-- Invalid emails to remove from your list
SELECT email
FROM email_verifications
WHERE status = 'invalid';

-- Catch-all percentage (risky sends)
SELECT
  COUNT(*) AS total,
  COUNT(CASE WHEN status = 'catch_all' THEN 1 END) AS catch_alls,
  ROUND(
    100.0 * COUNT(CASE WHEN status = 'catch_all' THEN 1 END) / COUNT(*), 1
  ) AS catch_all_pct
FROM email_verifications;
```

**Note:** If these queries return errors or unexpected results, check the actual column names in the Supabase Dashboard — the schema above is inferred, not confirmed from migration SQL.
