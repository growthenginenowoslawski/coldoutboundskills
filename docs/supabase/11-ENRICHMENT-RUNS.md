# ENRICHMENT_RUNS

## 1. What is this table?

`enrichment_runs` is the AI call ledger. Every single time the system calls an AI model — to qualify a company, generate personalization, analyze signals, or run any other AI task — it writes one row to this table. That row records what was asked, what came back, which model was used, how many tokens were consumed, how long it took, and what it cost.

This is how you understand and control your AI costs.

## 2. Why does this table exist?

AI calls cost real money. Without tracking them, you'd have no idea:
- How much each client's campaign is costing in AI fees
- Which model tiers are being used (cheap Haiku vs. expensive Opus)
- Whether the escalation system (try cheap first, escalate if low confidence) is working
- What your per-company qualification cost is
- Where AI failures are happening

`enrichment_runs` is your financial and operational audit trail for every AI call.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this AI call |
| `company_id` | uuid | Which company this AI call was about (→ companies.id) |
| `client_id` | uuid | Which client this call is for (→ clients.id) — for cost roll-up |
| `provider` | text | The model string used, e.g., "claude-haiku-4-5-20251001" or "openrouter/anthropic/claude-3-haiku" |
| `operation` | text | Type of operation: "ai_qualification" |
| `status` | text | `pending`, `running`, `completed`, `failed`, or `escalated` |
| `input_data` | jsonb | What the AI saw: company snapshot + ICP definition |
| `output_data` | jsonb | What the AI returned: QualificationResult or SignalIntelligenceResult |
| `started_at` | timestamptz | When the AI call started |
| `completed_at` | timestamptz | When the AI call finished |
| `created_at` | timestamptz | When this row was created |
| `updated_at` | timestamptz | When this row was last updated |
| `input_tokens` | int | Prompt tokens consumed (from the provider's usage object) |
| `output_tokens` | int | Completion tokens consumed |
| `gateway` | text | AI gateway: "anthropic-direct" or "openrouter" |
| `task_type` | text | Routing type that determined the model tier (see below) |
| `latency_ms` | int | Wall-clock milliseconds from request to response |
| `cost_usd` | numeric(14,8) | Estimated cost: input_tokens × price + output_tokens × price |
| `error_message` | text | Failure reason (null on success) |
| `cache_hit` | boolean | Reserved for future caching layer (always null now) |
| `escalated_from_run_id` | uuid | FK to cheaper attempt this escalated from (→ enrichment_runs.id) |
| `job_id` | uuid | FK to the background job that triggered this run (→ jobs.id) |
| `attempt_number` | int | 0-based index within an escalation chain (0 = first/cheapest try) |

**Task types:**
- `icp_qualification` — full ICP fit assessment
- `icp_prefilter` — quick pass/fail before full qualification
- `personalization` — writing personalized email copy
- `reply_classify` — classifying an email reply
- `text_normalize` — normalizing text
- `campaign_strategy` — generating campaign ideas
- `signal_intelligence` — WHY NOW analysis over signals

**Status values:**
- `pending` — created but not yet started
- `running` — AI call in flight
- `completed` — success
- `failed` — error; see error_message
- `escalated` — this tier completed but confidence was too low; a more expensive model was tried next

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `company_id → companies(id)` — which company was analyzed
- `client_id → clients(id)` — for per-client cost tracking (added migration 0007)
- `escalated_from_run_id → enrichment_runs(id)` — self-referential; the cheaper attempt this escalated from (added 0008)
- `job_id → jobs(id)` — the background job that triggered this AI call (added 0009)

**Self-referential escalation chain example:**
```
attempt 0: claude-haiku (status=escalated) → escalated_from_run_id=NULL
attempt 1: claude-sonnet (status=escalated) → escalated_from_run_id=attempt_0.id
attempt 2: claude-opus (status=completed) → escalated_from_run_id=attempt_1.id
```

## 6. What comes before it?

- `companies` must exist (for company_id)
- `clients` for cost attribution
- `jobs` for job-linked runs (Stage 10+)
- The AI model credentials must be configured

## 7. What comes after it?

No tables depend on `enrichment_runs`. It's a write-once audit record. But:
- The AI's output (stored in `output_data`) influences `companies.icp_score`
- Signal intelligence results feed into personalization
- Cost data feeds into per-client budget dashboards (planned)

## 8. Who writes to this table?

- **`storeQualification()`** in `src/db/qualifications.ts` — for single-model calls
- **`storeEscalationResult()`** in `src/db/qualifications.ts` — for multi-tier escalation chains; writes one row per attempt
- Both are called by Trigger.dev background tasks

## 9. Who reads from this table?

- Cost reporting queries (sum cost_usd by client, by task_type, by gateway)
- Escalation chain analysis (follow escalated_from_run_id chain)
- Performance monitoring (latency_ms distributions by model)
- Signal intelligence pipeline reads previous qualification results

## 10. Real example

A three-tier escalation chain for qualifying one company:

```
-- Attempt 0: tried Claude Haiku first (cheap)
id:               run-001
company_id:       (Acme Corp uuid)
client_id:        a29f5829-... (Gramscode)
provider:         claude-haiku-4-5-20251001
gateway:          anthropic-direct
task_type:        icp_qualification
attempt_number:   0
status:           escalated  (confidence too low)
input_tokens:     450
output_tokens:    120
cost_usd:         0.0000540
latency_ms:       800
escalated_from_run_id: NULL

-- Attempt 1: escalated to Claude Sonnet
id:               run-002
provider:         claude-sonnet-4-6
attempt_number:   1
status:           completed
cost_usd:         0.0032400
escalated_from_run_id: run-001

-- Total cost for this company: ~$0.003
```

## 11. How this table participates in a campaign

Before a campaign launches, every company in the list should have at least one `enrichment_runs` row (the AI qualification). The flow:

1. `qualify-list.ts` picks up companies from `list_members`
2. For each company, calls AI qualification
3. AI result → row written to `enrichment_runs`
4. `companies.icp_score` updated
5. List quality scorecard reads `icp_fit_score` dimension from these results

Later, when running personalized outreach:
- Signal intelligence runs → new `enrichment_runs` rows with `task_type='signal_intelligence'`
- Personalization runs → new rows with `task_type='personalization'`

## 12. Simple mental model

"enrichment_runs = the receipt for every AI call; tracks what it cost, how long it took, and whether it worked."

## 13. SQL to inspect it

```sql
-- Total AI spend for Gramscode
SELECT
  task_type,
  COUNT(*) AS calls,
  SUM(cost_usd) AS total_cost_usd,
  ROUND(AVG(latency_ms)) AS avg_latency_ms
FROM enrichment_runs
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
  AND status = 'completed'
GROUP BY task_type
ORDER BY total_cost_usd DESC;

-- Escalation rate: how often does the cheap model fail?
SELECT
  COUNT(*) FILTER (WHERE status = 'escalated') AS escalated,
  COUNT(*) FILTER (WHERE status = 'completed') AS completed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'escalated') / COUNT(*), 1) AS escalation_pct
FROM enrichment_runs
WHERE task_type = 'icp_qualification';

-- Cost by gateway
SELECT gateway, COUNT(*) AS calls, ROUND(SUM(cost_usd)::numeric, 4) AS total_usd
FROM enrichment_runs
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
GROUP BY gateway;

-- Trace a full escalation chain for one company
WITH RECURSIVE chain AS (
  SELECT id, provider, status, cost_usd, attempt_number, escalated_from_run_id
  FROM enrichment_runs
  WHERE company_id = 'your-company-id'
    AND escalated_from_run_id IS NULL
    AND job_id IS NOT NULL
  UNION ALL
  SELECT r.id, r.provider, r.status, r.cost_usd, r.attempt_number, r.escalated_from_run_id
  FROM enrichment_runs r
  JOIN chain c ON r.escalated_from_run_id = c.id
)
SELECT * FROM chain ORDER BY attempt_number;
```
