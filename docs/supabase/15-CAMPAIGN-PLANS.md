# CAMPAIGN_PLANS

## 1. What is this table?

`campaign_plans` stores the synthesized one-page campaign plan per client — the output of `/cold-email-kickoff` Step 5. It summarizes everything: the business, the ICP, the offer, the infrastructure status, and the top 3 campaigns to run. Think of it as the "campaign brief" document, stored in the database.

## 2. Why does this table exist?

After running through all onboarding, lead magnet brainstorm, and campaign strategy steps, you need one place that captures the final decision: here is the business, here is who we're targeting, here is the offer, here is the plan. This table is that place. It also tracks whether the plan has been approved by the client, creating a paper trail for the engagement.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier |
| `client_id` | uuid | Which client this plan belongs to (→ clients.id) |
| `business_summary` | text | One-liner from icp_onboarding.what_you_sell |
| `icp_summary` | text | Compiled from icp_onboarding answers: who, headcount, geography, triggers |
| `offer_summary` | text | Primary CTA + lead magnet: what we're offering, to whom, and how |
| `infrastructure_status` | jsonb | Step 1 answers: `{domains: true, inboxes: true, api_keys: true}` |
| `top_campaign_names` | text[] | Display names of top 3 campaigns from campaign_strategies |
| `next_steps` | text | Branched next-steps block from Step 6 of kickoff |
| `status` | text | `draft` | `approved` |
| `generated_at` | timestamptz | When this plan was generated |
| `created_at` | timestamptz | When this row was created |
| `updated_at` | timestamptz | When this row was last updated |

**infrastructure_status jsonb structure:**
```json
{
  "domains_purchased": true,
  "inboxes_warmed": false,
  "smartlead_configured": true,
  "api_keys_set": true,
  "warmup_days_remaining": 12
}
```

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `client_id → clients(id)` ON DELETE CASCADE

## 6. What comes before it?

- `clients` + `icp_onboarding` (provides the content for business_summary, icp_summary)
- `lead_magnets` selected (provides the offer_summary)
- `campaign_strategies` top 3 ranked (provides top_campaign_names)
- Infrastructure review (provides infrastructure_status)

## 7. What comes after it?

No tables depend on `campaign_plans`. It's a synthesis/summary document. The actual work continues in:
- Infrastructure setup (domain purchase, inbox warmup)
- List building (company sourcing)
- `email_sequences` (copywriting)

## 8. Who writes to this table?

- **`upsertCampaignPlan(slug, plan)`** in `src/db/campaign-plans.ts` — upserts the current draft plan for a client. If a draft exists, it updates it. If not, it inserts a new one. Only one active draft per client at a time.

## 9. Who reads from this table?

- **`getCampaignPlan(slug)`** — reads the most recent plan for a client
- Operator review — to see what the agreed plan is before executing

## 10. Real example

```
client_id:        a29f5829-... (Gramscode)
business_summary: "ROCI is a profitability analytics platform for agency
                   founders — shows you where you're leaving money on the table."
icp_summary:      "UK digital agency founders, 10-75 headcount, bootstrapped,
                   currently running retainer or project-based work. Triggers:
                   hiring their first ops hire, just lost a client, raised from
                   an accelerator."
offer_summary:    "Lead magnet: Free Agency Profitability Audit (30-min Loom
                   walkthrough). CTA: 'Want us to run the numbers on yours?'"
infrastructure_status: {"domains_purchased": true, "inboxes_warmed": false,
                        "warmup_days_remaining": 11}
top_campaign_names: ["Bootstrapped Agency Founder — ROCI Profitability Angle",
                     "New Ops Hire Signal — Scaling Pain Point",
                     "Lost Client Signal — Recovery Angle"]
next_steps:       "Infrastructure first: 11 more warmup days. Then: build list
                   (Prospeo UK agency founder pull). Copywriting starts in week 2."
status:           draft
```

## 11. How this table participates in a campaign

The campaign plan is the handoff document between kickoff and execution. After kickoff:
1. Infrastructure continues (domains warming)
2. List building starts (sourcing companies)
3. Copywriting starts (email_sequences written)

The plan records what was decided so any future Claude session can read `getCampaignPlan("gramscode")` and immediately understand the campaign context without re-running onboarding.

## 12. Simple mental model

"campaign_plans = the one-page brief; one per client, synthesizing ICP + offer + top campaigns into the document that drives all downstream execution."

## 13. SQL to inspect it

```sql
-- The current plan for Gramscode
SELECT business_summary, icp_summary, offer_summary,
       top_campaign_names, next_steps, status, generated_at
FROM campaign_plans
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY generated_at DESC
LIMIT 1;

-- Plans by status across all clients
SELECT c.name AS client, cp.status, cp.generated_at
FROM campaign_plans cp
JOIN clients c ON c.id = cp.client_id
ORDER BY cp.generated_at DESC;

-- Infrastructure status breakdown
SELECT
  client_id,
  infrastructure_status->>'domains_purchased' AS domains,
  infrastructure_status->>'inboxes_warmed' AS warmed,
  infrastructure_status->>'warmup_days_remaining' AS days_left
FROM campaign_plans
WHERE status = 'draft';
```
