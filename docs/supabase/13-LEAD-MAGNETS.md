# LEAD_MAGNETS

## 1. What is this table?

`lead_magnets` stores the results of the `/lead-magnet-brainstorm` skill. One row per brainstormed lead magnet idea per client. A lead magnet is the free thing you offer in cold email to get a meeting — a free audit, a data report, a competitive analysis.

## 2. Why does this table exist?

The lead magnet is the hook of every cold email. Getting it wrong means low reply rates no matter how good the copy is. This table stores the brainstormed options (typically 10-20 per client), their scores, and which one the client chose — so you can trace back to "why did we use this magnet?" months later.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier |
| `client_id` | uuid | Which client these magnets belong to (→ clients.id) |
| `archetype_key` | text | Which of the 10 lead magnet archetypes this is (see below) |
| `name` | text | Short name: "Free Agency Profitability Audit" |
| `description` | text | One-paragraph description of what this magnet delivers |
| `delivery_notes` | text | What's required to actually deliver this (time, tools, data) |
| `cta_example` | text | Example CTA line for cold email: "Want your free audit?" |
| `score` | int | Rubric score out of 20 (0-20) |
| `rank` | int | 1=top pick, 2=second, 3=third; null=not in top picks |
| `status` | text | `draft` | `selected` | `rejected` |
| `notes` | text | Any additional notes or refinements |
| `created_at` | timestamptz | When this row was created |
| `updated_at` | timestamptz | When this row was last updated |

**Archetype keys (10 types):**
- `free_audit` — a free assessment of their current state
- `data_report` — a custom data analysis or benchmark
- `competitive_intel` — competitive research on their space
- `template` — a ready-to-use template, checklist, or playbook
- `intro` — an introduction to a useful person or partner
- `quick_win_work` — a small piece of work done for free upfront
- `specific_analysis` — a custom analysis of their specific situation
- `tool_free_account` — access to a tool you've built or licensed
- `working_session` — a focused working session with an expert
- `benchmark` — how they compare to industry peers

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `client_id → clients(id)` ON DELETE CASCADE

## 6. What comes before it?

- `clients` must exist with an `icp_onboarding` complete
- The `/lead-magnet-brainstorm` skill must run (it calls `insertLeadMagnet()`)

## 7. What comes after it?

- The selected magnet's `cta_example` feeds into `email_sequences.value_proposition`
- `campaign_strategies` may reference which magnet angle is being tested
- `icp_onboarding.lead_magnet` question stores the decided magnet (separate from this table's brainstorm history)

## 8. Who writes to this table?

- **`insertLeadMagnet()` in `src/db/lead-magnets.ts`** — the `/lead-magnet-brainstorm` skill; writes one row per brainstormed option
- **`selectLeadMagnet(id)`** — marks the chosen magnet as `selected` and all others as `rejected`

## 9. Who reads from this table?

- **`listLeadMagnets(slug)`** — returns all magnets for a client, ordered by rank then score; used to review options

## 10. Real example

A brainstorm for Gramscode (ROCI product):
```
client_id:      a29f5829-... (Gramscode)
archetype_key:  free_audit
name:           Free Agency Profitability Audit
description:    30-minute review of how the agency tracks retention, AOV, and payroll
                relative to gross profit. Produces a one-page benchmark report.
delivery_notes: Requires P&L summary from client. 30 min Loom walkthrough.
cta_example:    "Want us to run the numbers on yours — no cost, 30 mins?"
score:          17
rank:           1
status:         selected
```

## 11. How this table participates in a campaign

Lead magnet selection is Step 2 of the kickoff flow. It feeds into:
1. The cold email CTA (the magnet is the call to action)
2. Campaign strategy (which magnet angles to test)
3. Email sequence (the offer written into every email)

The `rank` column tells you which one won. The `status=selected` row is the live campaign's hook.

## 12. Simple mental model

"lead_magnets = the brainstorm history of free offers; one selected winner powers the campaign's call to action."

## 13. SQL to inspect it

```sql
-- The chosen magnet for Gramscode
SELECT name, description, cta_example, score
FROM lead_magnets
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
  AND status = 'selected';

-- Full ranked list for a client
SELECT rank, name, archetype_key, score, status
FROM lead_magnets
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
ORDER BY rank NULLS LAST, score DESC;

-- Count by archetype across all clients
SELECT archetype_key, COUNT(*) AS total,
       COUNT(CASE WHEN status = 'selected' THEN 1 END) AS times_selected
FROM lead_magnets
GROUP BY archetype_key
ORDER BY times_selected DESC;
```
