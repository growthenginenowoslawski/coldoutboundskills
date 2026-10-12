# LIST_QUALITY_SCORES

## 1. What is this table?

`list_quality_scores` stores the results of running the `/list-quality-scorecard` skill on a list. It's a detailed report card: one row per scoring run, with an overall grade (A+ to F) and eight individual dimension scores.

## 2. Why does this table exist?

Before you spend thousands of dollars sending emails to a list, you need to know whether the list is actually any good. Bad lists waste money on bounced emails, hurt your domain reputation, and waste time on unqualified contacts. This table stores the objective quality measurement of each list so you can make a go/no-go decision before campaign launch.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this scoring run |
| `client_id` | uuid | Which client owns this score (→ clients.id) |
| `list_id` | uuid | Which list was scored (→ lists.id, nullable) |
| `list_name` | text | Display name of the list scored (in case list is deleted) |
| `total_rows` | int | Total number of rows in the list that were scored |
| `grade` | text | Overall letter grade: A+, A, B, C, D, or F |
| `overall_score` | int | Weighted average score (0-100) |
| `email_verification_score` | int | % of emails that are verified/deliverable |
| `duplicate_email_score` | int | Score based on email deduplication |
| `duplicate_domain_score` | int | Score based on domain deduplication (avoid same company twice) |
| `title_relevance_score` | int | % of job titles matching your ICP buying title |
| `bad_title_score` | int | Penalty for irrelevant titles (HR, interns, etc.) |
| `catchall_density_score` | int | Penalty for catch-all email addresses (risky to send to) |
| `icp_fit_score` | int | How well companies match your ICP |
| `name_quality_score` | int | Quality of contact name data (no "N/A", weird characters, etc.) |
| `top_issues` | text[] | Top 5 issues found in the list |
| `pre_send_checklist` | jsonb | [{item: "...", checked: true/false}] — final pre-send verification |
| `scored_at` | timestamptz | When this scorecard was run |
| `created_at` | timestamptz | When this row was created |

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `client_id → clients(id)` ON DELETE CASCADE
- `list_id → lists(id)` ON DELETE SET NULL — if the list is deleted, the scorecard is kept (historical record)

## 6. What comes before it?

- `clients` must exist
- `lists` should exist (though `list_id` is nullable for historical scores)
- The list must have been built (companies/contacts in `list_members`)
- Email verification should ideally be complete before scoring

## 7. What comes after it?

No tables depend on `list_quality_scores`. It's a decision-support record. The human reads it and decides: is this list good enough to campaign? If grade is B or better, proceed to copywriting and campaign upload.

## 8. Who writes to this table?

- **`/list-quality-scorecard` skill** — the only writer, via `insertListQualityScore()` in `src/db/list-quality-scores.ts`

## 9. Who reads from this table?

- **Operator review** — you read the score before deciding to launch a campaign
- **`listQualityScores()` helper** — returns all scores for a client in reverse chronological order

## 10. Real example

A scorecard run on a 200-contact Prospeo pull:
```
client_id:                 a29f5829-... (Gramscode)
list_id:                   (uuid of the list)
list_name:                 ROCI ICP - UK Agency Founders Aug 2026
total_rows:                197
grade:                     B
overall_score:             74
email_verification_score:  85  (good — 85% verified)
duplicate_email_score:     95  (very good — almost no dupes)
duplicate_domain_score:    90  (good)
title_relevance_score:     70  (decent — most are founders/MDs)
bad_title_score:           80  (few bad titles)
catchall_density_score:    60  (some catchalls — UK agencies common)
icp_fit_score:             75  (most fit the agency profile)
name_quality_score:        90  (names look clean)
top_issues:                ["22% catchall emails", "8 duplicate domains", ...]
grade:                     B
```

## 11. How this table participates in a campaign

This table is the gateway check before campaign launch. The rule: **if the grade is C or below, fix the list before sending.** The `pre_send_checklist` column gives you a specific to-do list. Once you have an A or B, you proceed to:
1. Copywriting → `email_sequences`
2. Client review → `campaign_reviews`
3. Campaign upload → `campaigns` + `campaign_leads`

## 12. Simple mental model

"list_quality_scores = your list's report card before you spend money sending to it."

## 13. SQL to inspect it

```sql
-- Latest scorecard for Gramscode
SELECT list_name, grade, overall_score, total_rows, scored_at
FROM list_quality_scores
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY scored_at DESC
LIMIT 5;

-- All dimension scores for a specific scorecard
SELECT
  grade, overall_score,
  email_verification_score,
  duplicate_email_score,
  duplicate_domain_score,
  title_relevance_score,
  bad_title_score,
  catchall_density_score,
  icp_fit_score,
  name_quality_score,
  top_issues
FROM list_quality_scores
WHERE id = 'your-scorecard-id';

-- Score history: has list quality improved over time?
SELECT list_name, grade, overall_score, scored_at
FROM list_quality_scores
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY scored_at;
```
