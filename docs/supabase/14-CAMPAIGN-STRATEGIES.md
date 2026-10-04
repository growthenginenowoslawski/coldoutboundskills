# CAMPAIGN_STRATEGIES

## 1. What is this table?

`campaign_strategies` stores the output of the `/campaign-strategy` skill. One row per campaign idea per client — typically 15-25 ideas per client from one brainstorm session. Each row is a fully-described campaign angle: who it targets, how it personalizes at scale, and what value proposition it tests.

## 2. Why does this table exist?

Before writing a single email, you need to know *which angle* you're running. The campaign strategy defines the targeting level (Broad / Focused / Niche), the personalization approach (AI or static), and the value prop being tested. This table stores all the angles brainstormed so you can compare, rank, and approve the ones worth running.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier |
| `client_id` | uuid | Which client owns this strategy (→ clients.id) |
| `campaign_name` | text | Short name: "Creative Use Case — ROCI AI for Agency Ops" |
| `targeting_level` | text | `Broad` | `Focused` | `Niche` |
| `list_filters` | text | Additional filters beyond base ICP (e.g., "only agencies 20-50 heads") |
| `ai_strategy` | text | How AI personalization works for this campaign |
| `value_proposition` | text | Core promise / angle being tested |
| `campaign_overview` | text | Full description — enough context for a copywriter handoff |
| `is_no_ai` | bool | If true: static copy campaign (no AI variables) |
| `is_front_end_offer` | bool | If true: this is a front-end offer strategy (not lead magnet) |
| `rank` | int | 1=top pick; null=not ranked |
| `status` | text | `draft` | `approved` | `active` | `archived` |
| `notes` | text | Additional notes or refinements |
| `created_at` | timestamptz | When created |
| `updated_at` | timestamptz | When last updated |

**Targeting levels:**
- `Broad` — base ICP, 500+ companies possible, generic angle
- `Focused` — additional filters, 200-500 companies, more specific angle
- `Niche` — very specific sub-segment, 50-200 companies, highly targeted angle

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `client_id → clients(id)` ON DELETE CASCADE

## 6. What comes before it?

- `clients` with completed `icp_onboarding`
- `lead_magnets` with a selected magnet (the chosen magnet informs the value_proposition)
- `/campaign-strategy` skill run

## 7. What comes after it?

- `email_sequences.campaign_strategy_id` — each sequence optionally links back to the strategy that inspired it
- `campaign_plans.top_campaign_names` — the one-page plan references the top 3 strategy names

## 8. Who writes to this table?

- **`insertCampaignStrategy(slug, strategy)`** in `src/db/campaign-strategies.ts` — called by `/campaign-strategy` skill
- **`approveCampaignStrategy(id)`** — marks one strategy as approved for execution

## 9. Who reads from this table?

- **`listCampaignStrategies(slug)`** — returns all strategies for a client, ordered by rank
- `/campaign-copywriting` skill — reads the approved strategy to generate matching email copy

## 10. Real example

A Gramscode strategy targeting bootstrapped agency founders:
```
campaign_name:     Bootstrapped Agency Founder — ROCI Profitability Angle
targeting_level:   Focused
list_filters:      10-50 headcount; UK only; no private equity backing
ai_strategy:       Use AI to find each agency's current retainer pricing model
                   from their website; personalize by referencing their pricing structure
value_proposition: Most agencies leave 30-40% gross profit on the table — ROCI
                   shows you exactly where.
is_no_ai:          false
is_front_end_offer: false
rank:              1
status:            approved
```

## 11. How this table participates in a campaign

Campaign strategy is Step 3 of the kickoff flow. The workflow:

1. Brainstorm 15-25 strategies → insert all as `status=draft`
2. Client reviews → select top 3-5, mark as `approved`
3. Copywriter takes approved strategies → writes `email_sequences` for each
4. Each `email_sequence` optionally references its source strategy via `campaign_strategy_id`

The `is_no_ai` flag tells the copywriter whether to write static copy or design for AI variable injection. The `is_front_end_offer` flag signals a different CTA structure.

## 12. Simple mental model

"campaign_strategies = the menu of angles; each row is one approach the sales team could run. Rank and approve to choose which ones to build copy for."

## 13. SQL to inspect it

```sql
-- All approved strategies for Gramscode, ranked
SELECT rank, campaign_name, targeting_level, is_no_ai, status
FROM campaign_strategies
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY rank NULLS LAST, created_at;

-- Strategy linked to an email sequence
SELECT cs.campaign_name, es.name AS sequence_name, es.status
FROM email_sequences es
JOIN campaign_strategies cs ON cs.id = es.campaign_strategy_id
WHERE es.client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b';

-- How many approved vs draft strategies across all clients
SELECT status, COUNT(*) AS count
FROM campaign_strategies
GROUP BY status;
```
