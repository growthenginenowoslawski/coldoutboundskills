# ICP_ONBOARDING

## 1. What is this table?

The `icp_onboarding` table stores the answers to 12 discovery questions about your Ideal Customer Profile. It's the structured form that tells the system who you're selling to, what you sell, and how you want to sound when you reach out.

Each row is one question-answer pair. One client has exactly 12 rows (one per question). Answers start as NULL and get filled in as you complete the onboarding interview.

## 2. Why does this table exist?

The ICP (Ideal Customer Profile) is the foundation of everything: which companies to target, how to score them, what to say in emails. Storing it in a structured table (rather than a text file or a doc) means:
- Any skill can read the ICP by querying this table
- You can update one answer without re-running the whole onboarding
- Different clients can have completely different ICPs in the same database

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique ID for this question-answer row |
| `client_id` | uuid | Which client this belongs to (→ clients.id) |
| `position` | int | Display order: 1-12 |
| `question_key` | text | Machine-readable identifier for the question |
| `question` | text | The full question text as shown to the user |
| `answer` | text | The user's answer (NULL until answered) |
| `answered_at` | timestamptz | When the answer was saved |
| `created_at` | timestamptz | When this question row was created |
| `updated_at` | timestamptz | When this row was last updated |

**The 12 question keys:**

| Position | Question Key | What it asks |
|----------|-------------|-------------|
| 1 | `what_you_sell` | What do you sell, in one sentence? |
| 2 | `best_customer` | Who is your single best customer? |
| 3 | `buying_title` | What job title actually buys this? |
| 4 | `headcount_range` | Target company headcount (min and max) |
| 5 | `industries_in_out` | Which industries are IN vs. OUT? |
| 6 | `geography` | Which countries/regions? |
| 7 | `triggers` | Buying triggers worth personalizing on |
| 8 | `disqualifiers` | What to exclude (competitors, existing customers) |
| 9 | `offer_cta` | Your primary CTA — what are you asking them to do? |
| 10 | `lead_magnet` | What can you give away free as the hook? |
| 11 | `tone` | Casual or formal? Peer-to-peer or vendor? |
| 12 | `banned_words_legal` | Any banned words or legal constraints? |

## 4. Primary Key

`id` — UUID, auto-generated per row.

## 5. Foreign Keys

`client_id → clients(id)` ON DELETE CASCADE

If you delete a client, all their ICP rows are automatically deleted too.

## 6. What comes before it?

`clients` must exist first. The migration seed creates all 12 question rows for Gramscode automatically when migration 0002 runs. Answers are filled in later via the onboarding interview.

## 7. What comes after it?

- `/campaign-strategy` reads the answered ICP to generate campaign ideas
- `/cold-email-kickoff` reads the ICP to build the `campaign_plans` row
- AI qualification (`enrichment_runs`) uses the ICP to score companies
- `campaign_plans.icp_summary` is compiled from these answers

## 8. Who writes to this table?

- **Migration 0002** seeds the 12 blank question rows for Gramscode
- **`saveAnswer()` in `src/db/onboarding.ts`** writes the user's answer to a specific question. Called by the `/icp-onboarding` skill as you work through the interview.

## 9. Who reads from this table?

- `/campaign-strategy` skill reads all answers to generate campaign ideas
- `/cold-email-kickoff` skill reads answers to synthesize the campaign plan
- Any AI qualification that needs the ICP definition

## 10. Real example

After completing the onboarding interview, Gramscode's row for position 1 looks like:

```
id:           (some uuid)
client_id:    a29f5829-5412-49be-9a77-41c3edf3c14b
position:     1
question_key: what_you_sell
question:     What do you sell, in one sentence?
answer:       Done-for-you cold outbound systems for B2B founders who are
              tired of inconsistent pipeline.
answered_at:  2026-08-01T10:30:00Z
```

## 11. How this table participates in a campaign

Before any campaign can be built, the ICP must be answered. The campaign strategy skill reads all 12 answers and uses them to generate targeted campaign angles. The answers for `headcount_range`, `industries_in_out`, and `buying_title` directly determine which companies qualify and which contacts to target.

## 12. Simple mental model

"icp_onboarding = the 12-question brief that tells the system who to target and how to talk to them."

## 13. SQL to inspect it

```sql
-- See all ICP answers for Gramscode
SELECT position, question_key, question, answer, answered_at
FROM icp_onboarding
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY position;

-- Check which questions are still unanswered
SELECT position, question_key, question
FROM icp_onboarding
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
  AND answer IS NULL
ORDER BY position;

-- Upsert an answer (how the skill does it)
UPDATE icp_onboarding
SET answer = 'Your answer here',
    answered_at = now(),
    updated_at = now()
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
  AND question_key = 'what_you_sell';
```
