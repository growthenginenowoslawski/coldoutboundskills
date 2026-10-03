-- 0009_operation_identity.sql
--
-- Stage 10: Production Job Identity and Database-Level Idempotency
--
-- Problem: The current idempotency model stores the key inside input_data JSONB
-- and has no unique constraint, so two concurrent requests can both see "no job"
-- and both create rows.  Enrichment_runs has no FK to its originating job and no
-- attempt-number, so a retry after the enrichment write can produce duplicate rows.
--
-- Solution:
--   1. Promote idempotency_key to a native TEXT column on jobs (fast indexed lookup).
--   2. Add a PARTIAL unique index so only one active job can exist per
--      (job_type, idempotency_key). Failed/cancelled rows are excluded so retries
--      can create a fresh row without first deleting the old one.
--   3. Add job_id + attempt_number to enrichment_runs and a unique index on
--      (job_id, attempt_number) so a retried storeEscalationResult is idempotent.
--
-- Terminal statuses for the partial index:
--   failed    → retry allowed (excluded from uniqueness check)
--   cancelled → retry allowed (excluded from uniqueness check)
--   pending, running, completed, queued → active; block concurrent duplicates
--
-- ADDITIVE ONLY — no existing columns, tables, or indexes are removed.

-- ── 1. Native idempotency_key column on jobs ──────────────────────────────────

alter table public.jobs
  add column if not exists idempotency_key text;

comment on column public.jobs.idempotency_key
  is 'Caller-supplied stable key that uniquely identifies a logical operation. '
     'Format: <companyId>:<taskType>:<batchId> for AI tasks. '
     'Null for legacy jobs that pre-date Stage 10.';

-- ── 2. Backfill existing rows from input_data JSONB ───────────────────────────
-- Runs only if there are rows with a nested idempotencyKey (Stage 9 jobs).
-- Safe to re-run (SET is idempotent when value already matches).

update public.jobs
set    idempotency_key = input_data ->> 'idempotencyKey'
where  idempotency_key is null
  and  input_data is not null
  and  input_data ? 'idempotencyKey';

-- ── 3. Partial unique index — one active job per (job_type, idempotency_key) ─
--
-- "Active" means status NOT IN ('failed', 'cancelled').
-- Failed / cancelled rows are excluded so a retry can INSERT a fresh row
-- without first deleting the old one.
--
-- PostgreSQL enforces uniqueness within the partial index's WHERE clause only.
-- A new INSERT with the same (job_type, idempotency_key) raises error 23505
-- unless an existing row is failed or cancelled.

create unique index if not exists jobs_active_idempotency_idx
  on public.jobs (job_type, idempotency_key)
  where status not in ('failed', 'cancelled')
    and idempotency_key is not null;

comment on index public.jobs_active_idempotency_idx
  is 'Partial unique index: at most one active (non-failed, non-cancelled) job per '
     '(job_type, idempotency_key). Protects against concurrent duplicate creation.';

-- ── 4. Lookup index (for queries that do not filter on status) ────────────────

create index if not exists jobs_idempotency_key_idx
  on public.jobs (idempotency_key)
  where idempotency_key is not null;

-- ── 5. Link enrichment_runs to their originating job ─────────────────────────

alter table public.enrichment_runs
  add column if not exists job_id uuid references public.jobs(id) on delete set null;

comment on column public.enrichment_runs.job_id
  is 'FK to the jobs row that produced this enrichment run. '
     'Null for runs written before Stage 10. '
     'Combined with attempt_number to enforce duplicate-run prevention.';

-- ── 6. Attempt number within the escalation chain ─────────────────────────────

alter table public.enrichment_runs
  add column if not exists attempt_number integer;

comment on column public.enrichment_runs.attempt_number
  is '0-based index of this attempt within its escalation chain. '
     'Attempt 0 = first (cheapest) try; 1 = first escalation; 2 = second, etc. '
     'Null for runs written before Stage 10.';

-- ── 7. Unique index: duplicate-run prevention per job ─────────────────────────
--
-- If storeEscalationResult is retried (e.g., after a crash between checkpoint 1
-- and checkpoint 2), the INSERT for attempt i raises 23505.  The caller catches
-- it, looks up the existing row ID, and continues — guaranteeing idempotent
-- enrichment writes without double-counting cost.
--
-- The WHERE clause (both columns NOT NULL) leaves pre-Stage-10 rows unaffected.

create unique index if not exists enrichment_runs_job_attempt_idx
  on public.enrichment_runs (job_id, attempt_number)
  where job_id is not null
    and attempt_number is not null;

comment on index public.enrichment_runs_job_attempt_idx
  is 'Partial unique index: at most one enrichment_run per (job_id, attempt_number). '
     'Ensures retried storeEscalationResult calls return existing row IDs rather '
     'than creating duplicates.';

-- ── 8. Covering index for job → runs lookups ─────────────────────────────────

create index if not exists enrichment_runs_job_id_idx
  on public.enrichment_runs (job_id)
  where job_id is not null;
