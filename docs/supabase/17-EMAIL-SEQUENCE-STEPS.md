# EMAIL_SEQUENCE_STEPS

## 1. What is this table?

`email_sequence_steps` stores the individual emails within a sequence — one row per email step. A 4-email sequence has 4 rows: Day 0, Day 3, Day 7, Day 11. Each row contains the actual subject lines and email bodies (including A/B variants).

## 2. Why does this table exist?

Cold email sequences follow a specific cadence. Each email has a different strategy (the opener, the follow-up, the "did I lose you?", the breakup), a different delay, and sometimes a different subject. Storing each step as a separate row lets you:
- Track which day/step each email fires
- Store A/B variants for the same step
- Record whether a step has personalization variables
- Add spintax formatting for Smartlead import

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier |
| `sequence_id` | uuid | Which sequence this step belongs to (→ email_sequences.id) |
| `step` | int | Step number: 1=Day 0, 2=Day 3, 3=Day 7, 4=Day 11 |
| `delay_days` | int | Days after sequence start: 0, 3, 7, or 11 |
| `is_new_thread` | bool | If true, this starts a new email thread (vs. reply chain) |
| `strategy_type` | text | Email framework used for this step (see below) |
| `value_prop_angle` | text | Which value prop this step leans on (see below) |
| `subject_options` | text[] | 2-3 subject line variants to A/B test |
| `variants` | jsonb | `[{label, subject, body}]` — A/B variants with full text |
| `script_framework` | text | Writing framework: `case_study` | `pain_point` | `short_form` | `long_form` | `personalized` | `static` |
| `has_personalization` | bool | Whether this step uses AI-injected {{variables}} |
| `spintax_body` | text | Spintax-formatted body ready for Smartlead: `{Hi|Hello} {{first_name}}` |
| `created_at` | timestamptz | When created |

**Strategy type values:**
- `problem_sniffing` — opener that surfaces a pain without making claims
- `billboard` — creates curiosity without explaining too much
- `ai_generic` — AI-personalized angle
- `creative_ideas` — leads with creative use cases
- `redirect` — changes the angle if no reply to prior emails
- `value_bomb` — leads with maximum value upfront

**Value prop angle values:**
- `save_time` — the offer saves them time
- `make_money` — the offer helps them earn more
- `save_money` — the offer reduces costs
- `value_bomb` — the offer is so valuable it's hard to ignore

**variants jsonb structure:**
```json
[
  {
    "label": "A",
    "subject": "Agency margins aren't what you think",
    "body": "Hi {{first_name}},\n\nMost agencies think their..."
  },
  {
    "label": "B",
    "subject": "Quick question for {{agency_name}}",
    "body": "Hi {{first_name}},\n\nNoticed {{agency_name}} is..."
  }
]
```

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Unique Constraint

`UNIQUE (sequence_id, step)` — each step number appears only once per sequence. You can't have two "Day 0" emails for the same sequence.

## 6. Foreign Keys

- `sequence_id → email_sequences(id)` ON DELETE CASCADE — deleting a sequence removes all its steps

## 7. What comes before it?

- `email_sequences` must exist (parent row)
- `/campaign-copywriting` skill writes the steps as part of `insertEmailSequence()`

## 8. What comes after it?

No tables point to `email_sequence_steps`. The steps are the leaf nodes of the campaign content tree. They feed into:
- Smartlead campaign upload (steps become the email cadence in Smartlead)
- `/spam-word-checker` — scans step bodies for spam trigger words

## 9. Who writes to this table?

- **`insertEmailSequence(slug, sequence, steps)`** in `src/db/email-sequences.ts` — writes all steps as part of the atomic sequence insertion. Steps are never written separately.

## 10. Who reads from this table?

- **`listEmailSequences(slug)`** — joins and returns steps with their parent sequences
- Smartlead upload script — reads steps to construct the email cadence
- `/spam-word-checker` — reads `variants[].body` for each step

## 11. Real example

Step 1 (Day 0 opener) for the Gramscode creative use case sequence:
```
sequence_id:         (email_sequences.id for "Creative Use Case — ROCI")
step:                1
delay_days:          0
is_new_thread:       true
strategy_type:       problem_sniffing
value_prop_angle:    make_money
subject_options:     ["Agency margins aren't what you think",
                      "Quick question for {{agency_name}}",
                      "The profitability blind spot"]
has_personalization: true
script_framework:    personalized
variants: [
  {
    "label": "A",
    "subject": "Agency margins aren't what you think",
    "body": "Hi {{first_name}},\n\nMost agencies running a
             {{service_type}} model don't know which clients
             are actually profitable until they've already
             taken the meeting...\n\nWe built ROCI to fix that.
             It takes 30 minutes to show you where the margin
             is leaking.\n\nWant us to run the numbers on
             {{agency_name}}?\n\nEric"
  }
]
spintax_body:        "{Hi|Hey} {{first_name}},\n\n{Most|Many}..."
```

## 12. How this table participates in a campaign

Steps are the final deliverable before upload. The Smartlead import uses:
- `delay_days` → email cadence timing
- `variants[0].subject` → email subject line
- `spintax_body` (if set) or `variants[0].body` → email body
- `is_new_thread` → whether to continue thread or start fresh

## 13. Simple mental model

"email_sequence_steps = the actual email text; one row per email in the sequence. The variants column holds A/B options. spintax_body is the Smartlead-ready version."

## 14. SQL to inspect it

```sql
-- All steps for a specific sequence
SELECT step, delay_days, strategy_type, has_personalization,
       subject_options, array_length(subject_options, 1) AS subject_count
FROM email_sequence_steps
WHERE sequence_id = 'your-sequence-id'
ORDER BY step;

-- Step 1 email body (variant A) for a sequence
SELECT variants->0->>'body' AS email_body
FROM email_sequence_steps
WHERE sequence_id = 'your-sequence-id'
  AND step = 1;

-- Steps with personalization vs static
SELECT
  COUNT(*) FILTER (WHERE has_personalization) AS personalized_steps,
  COUNT(*) FILTER (WHERE NOT has_personalization) AS static_steps
FROM email_sequence_steps ess
JOIN email_sequences es ON es.id = ess.sequence_id
WHERE es.client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b';

-- Check which steps have spintax ready for Smartlead
SELECT ess.step, ess.delay_days,
       CASE WHEN ess.spintax_body IS NOT NULL THEN 'ready' ELSE 'needs spintax' END AS spintax_status
FROM email_sequence_steps ess
JOIN email_sequences es ON es.id = ess.sequence_id
WHERE es.client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY ess.step;
```
