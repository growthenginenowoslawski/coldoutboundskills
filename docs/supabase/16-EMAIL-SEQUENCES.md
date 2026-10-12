# EMAIL_SEQUENCES

## 1. What is this table?

`email_sequences` stores the written cold email campaigns — one row per campaign sequence per client. It's the parent table: the sequence header. The actual emails (Day 0, Day 3, Day 7, Day 11) live in the child table `email_sequence_steps`.

## 2. Why does this table exist?

A cold email campaign is not one email — it's a sequence of 4 emails sent at intervals (Day 0, Day 3, Day 7, Day 11). Each campaign angle needs its own sequence. This table records the metadata about each sequence: which angle it tests, what audience it targets, what value proposition it leads with, and whether the client has approved it for sending.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier |
| `client_id` | uuid | Which client owns this sequence (→ clients.id) |
| `campaign_strategy_id` | uuid | Which strategy this sequence implements (→ campaign_strategies.id, nullable) |
| `name` | text | Sequence name: "Creative Use Case — Gramscode" |
| `campaign_angle` | text | 1-2 sentence summary of the approach |
| `target_audience` | text | Who this sequence is being sent to |
| `core_pain_point` | text | The pain this sequence addresses |
| `value_proposition` | text | The core promise being made |
| `proof_point` | text | Case study or metric referenced in the emails |
| `ai_variables` | jsonb | `[{name, source, example_value}]` — dynamic variables injected by AI |
| `overall_score` | int | Rubric score 0-100 (quality of the sequence) |
| `value_prop_type` | text | `frontend_offer` | `lead_magnet` | `free_work` | `unique_insights` |
| `status` | text | `draft` | `approved` | `active` | `archived` |
| `notes` | text | Additional notes |
| `created_at` | timestamptz | When created |
| `updated_at` | timestamptz | When last updated |

**value_prop_type options:**
- `frontend_offer` — leading with a specific paid offer
- `lead_magnet` — leading with a free value item
- `free_work` — offering a piece of free work upfront
- `unique_insights` — leading with a data insight or benchmark

**ai_variables jsonb structure:**
```json
[
  {
    "name": "{{agency_pricing_model}}",
    "source": "Clay enrichment / website scrape",
    "example_value": "monthly retainer model"
  },
  {
    "name": "{{biggest_client_category}}",
    "source": "LinkedIn / website",
    "example_value": "e-commerce brands"
  }
]
```

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `client_id → clients(id)` ON DELETE CASCADE
- `campaign_strategy_id → campaign_strategies(id)` ON DELETE SET NULL — if strategy is archived, sequence is kept

## 6. What comes before it?

- `clients` with completed onboarding
- `campaign_strategies` approved (the strategy this sequence implements)
- `/campaign-copywriting` skill runs

## 7. What comes after it?

- `email_sequence_steps` — the actual email text for each step in this sequence
- `campaign_reviews` — the review cycle references `sequence_id`
- Smartlead upload — approved sequences are uploaded to Smartlead as campaigns

## 8. Who writes to this table?

- **`insertEmailSequence(slug, sequence, steps)`** in `src/db/email-sequences.ts` — writes the parent sequence and its child steps atomically (in the same function call)

## 9. Who reads from this table?

- **`listEmailSequences(slug)`** — returns all sequences for a client with their steps (joined)
- `campaign_reviews` — references sequence_id for the review cycle
- Smartlead upload script — reads sequences to upload to Smartlead

## 10. Real example

```
client_id:             a29f5829-... (Gramscode)
name:                  Creative Use Case — ROCI for Agency Ops
campaign_angle:        Position ROCI as the profitability layer that shows agency
                       founders which clients, retainers, and team members are
                       actually profitable vs. draining cash.
target_audience:       UK bootstrapped digital agency founders, 10-50 headcount
core_pain_point:       Agency founders don't know which clients are profitable
                       until it's too late
value_proposition:     ROCI shows exactly where you're leaving money — before you
                       lose the client
proof_point:           "Clients typically find 1-2 high-margin services they were
                       undercharging by 40%"
ai_variables:          [{"name": "{{agency_name}}", "source": "Company name"},
                        {"name": "{{service_type}}", "source": "Website copy"}]
value_prop_type:       lead_magnet
overall_score:         82
status:                approved
```

## 11. How this table participates in a campaign

Email sequences are the product of Step 3 of the Campaign Creation Workflow. The flow:

1. Approved strategy → copywriter writes sequence
2. Sequence inserted with steps → status=draft
3. `/spam-word-checker` reviews for spam words
4. Client review → `campaign_reviews` row created
5. Approved → status updated to `approved`
6. Smartlead upload → sequence emails uploaded as campaign
7. Campaign launched → status updated to `active`

## 12. Simple mental model

"email_sequences = the campaign copy headers; one row per angle being run. The actual email text lives in email_sequence_steps children."

## 13. SQL to inspect it

```sql
-- All sequences for Gramscode with status
SELECT name, value_prop_type, overall_score, status, created_at
FROM email_sequences
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY created_at;

-- Sequence with its steps
SELECT
  es.name AS sequence,
  ess.step, ess.delay_days, ess.strategy_type, ess.has_personalization
FROM email_sequences es
JOIN email_sequence_steps ess ON ess.sequence_id = es.id
WHERE es.client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY es.name, ess.step;

-- Sequences by value_prop_type
SELECT value_prop_type, status, COUNT(*) AS count
FROM email_sequences
GROUP BY value_prop_type, status
ORDER BY value_prop_type, status;
```
