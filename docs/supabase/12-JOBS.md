# JOBS

## 1. What is this table?

`jobs` is the background task queue. Every time a Trigger.dev task runs — qualifying a list, ingesting signals, processing a campaign — it creates and tracks its lifecycle in this table. One row = one background operation.

## 2. Why does this table exist?

Long-running operations (qualifying 200 companies takes minutes; ingesting 3,000 signals takes 20+ minutes) can't run synchronously in a web request. They run in the background via Trigger.dev. But if Trigger.dev crashes mid-way, you need to know:
- Was this job already started?
- What's the current status?
- Was it already completed (so don't run it again)?
- How many items were processed successfully?

The `jobs` table is the answer to all of those questions. It's the single source of truth for operational state.

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this job |
| `job_type` | text | What kind of operation this is, e.g., "predictleads", "ai_qualify", "connectivity_test" |
| `status` | text | Current state of the job (see below) |
| `provider` | text | Which provider is running this job (nullable), e.g., "predictleads" |
| `list_id` | uuid | Which list this job is processing (nullable, → lists.id) |
| `campaign_id` | uuid | Which campaign this job relates to (nullable, → campaigns.id) |
| `total_items` | int | Total number of items to process |
| `processed_items` | int | How many have been processed so far |
| `successful_items` | int | How many succeeded |
| `failed_items` | int | How many failed |
| `input_data` | jsonb | What the job was given to work with (payload from the trigger) |
| `output_data` | jsonb | What the job produced; also stores checkpoints for resume-ability |
| `error_message` | text | Human-readable failure reason (null on success) |
| `started_at` | timestamptz | When the job began running |
| `completed_at` | timestamptz | When the job finished |
| `created_at` | timestamptz | When this row was created |
| `updated_at` | timestamptz | When this row was last modified |
| `idempotency_key` | text | Stable identifier preventing duplicate jobs (added migration 0009) |

**Status values:**
- `pending` — created, waiting to start
- `running` — actively executing
- `completed` — finished successfully
- `failed` — terminated with an error
- `cancelled` — manually stopped
- `queued` — waiting in queue

**Idempotency key format:** `<companyId>:<taskType>:<batchId>` for AI tasks. This prevents two concurrent Trigger.dev invocations from both creating a row for the same operation.

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `list_id → lists(id)` — nullable; which list this job is processing
- `campaign_id → campaigns(id)` — nullable; which campaign this job relates to

## 6. What comes before it?

- A Trigger.dev task must be invoked (which calls `claimJob()`)
- `lists` or `campaigns` must exist if the job is associated with them

## 7. What comes after it?

- `enrichment_runs` — AI calls spawned by this job point back via `job_id`

## 8. Who writes to this table?

All writes go through `src/db/jobs.ts`:
- **`claimJob()`** — atomic find-or-create; used by Stage 10+ Trigger.dev tasks. Inserts a new row or returns existing one if the idempotency key is already active.
- **`createJob()`** — simple insert (pre-Stage 10 tasks)
- **`updateJob()`** — updates status, processed counts, output data
- **`completeJob()`** — shortcut to mark status='completed' with completed_at
- **`deleteJob()`** — used only in connectivity tests (never in production flows)

## 9. Who reads from this table?

- **`getJob(id)`** — reads one job by ID; used in roundtrip tests
- **Trigger.dev tasks** — read their own job state during execution
- **Operator monitoring** — you can query this table to see what's running and what failed

## 10. Real example

A signal ingestion job for Gramscode:
```
id:               (uuid)
job_type:         predictleads
provider:         predictleads
status:           completed
total_items:      4           (4 companies requested)
processed_items:  4
successful_items: 4
failed_items:     0
input_data:       { clientId: "a29f5829-...", companyIds: [...] }
output_data:      {
                    _signal_checkpoint: {
                      stage: "signals_ingested",
                      newSignalCount: 3202,
                      skippedSignalCount: 0,
                      errorCount: 0
                    }
                  }
idempotency_key:  "a29f5829-...:predictleads:batch-2026-09-01"
started_at:       2026-09-01T10:00:00Z
completed_at:     2026-09-01T10:22:00Z
```

## 11. How this table participates in a campaign

Jobs track the background work that powers every campaign operation:

1. **Signal ingestion job** — `job_type='predictleads'`, `list_id` or `campaign_id` may be set. Reads companies, fetches signals, writes to `signals` table. Each AI run links back via `enrichment_runs.job_id`.
2. **Qualification job** — `job_type='ai_qualify'`, `list_id` set. Reads companies from `list_members`, runs AI, writes `enrichment_runs` and updates `companies.icp_score`.
3. **Campaign execution jobs** — future; will track email sending batches.

The `output_data` column stores checkpoints. If a job fails mid-way (e.g., after ingesting 1,000 of 3,000 signals), restarting it reads the checkpoint and resumes from where it left off — without re-processing the first 1,000.

## 12. Simple mental model

"jobs = the background task queue; one row per long-running operation, tracking what happened and whether it can be safely retried."

## 13. SQL to inspect it

```sql
-- All jobs, newest first
SELECT job_type, status, provider, total_items, processed_items,
       successful_items, failed_items, started_at, completed_at
FROM jobs
ORDER BY created_at DESC
LIMIT 20;

-- Failed jobs that need attention
SELECT id, job_type, error_message, created_at
FROM jobs
WHERE status = 'failed'
ORDER BY created_at DESC;

-- Signal ingestion history
SELECT id, status, total_items, successful_items,
       (output_data->'_signal_checkpoint'->>'newSignalCount')::int AS new_signals,
       started_at, completed_at
FROM jobs
WHERE job_type = 'predictleads'
ORDER BY created_at DESC;

-- Is there currently a job running?
SELECT id, job_type, status, started_at
FROM jobs
WHERE status IN ('pending', 'running')
ORDER BY started_at;

-- AI runs linked to a specific job
SELECT id, provider, task_type, status, cost_usd, latency_ms, attempt_number
FROM enrichment_runs
WHERE job_id = 'your-job-id-here'
ORDER BY attempt_number;
```
