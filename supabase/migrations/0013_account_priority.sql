-- 0013_account_priority.sql
--
-- Stage 14: Account Prioritization — time-decayed priority score.
--
-- Adds two nullable columns to account_intelligence:
--   priority_score   — opportunity_score × recency_multiplier
--   prioritized_at   — when priority_score was calculated (NOT a freshness guarantee)
--
-- ── Design decisions ──────────────────────────────────────────────────────────
--
-- 1. NO SEPARATE TABLE. priority_score and prioritized_at are added directly to
--    account_intelligence because the natural key is identical — (client_id,
--    company_id) — so a new table would add a join with zero normalisation benefit.
--
-- 2. priority_score IS NULLABLE. Null means the account has not yet been through
--    a prioritisation run (e.g., it was scored by Stage 12/13 but Stage 14 has
--    not yet run). A null priority_score is distinct from zero — zero means the
--    account has been prioritised and has no active signals.
--
-- 3. priority_score ≠ opportunity_score.
--    opportunity_score  — ICP fit × signal quality. Time-invariant within
--                         a signal's TTL. Set by Stage 12 rescoreCompany().
--    priority_score     — opportunity_score × exp(-daysSinceLastSignal / HALF_LIFE).
--                         Changes daily as time passes even without new signals.
--                         Set by Stage 14 runAccountPrioritization().
--
-- 4. priority_rank IS NOT STORED. Rank is a relative position among all tracked
--    accounts for a client and changes every time a company is added, removed,
--    or rescored. Storing it would create stale data. Rank is always computed at
--    query time via a window function or ORDER BY.
--
-- 5. prioritized_at IS THE CALCULATION TIMESTAMP, NOT A FRESHNESS GUARANTEE.
--    priority_score decays continuously as time passes — a priority_score computed
--    yesterday is already stale because daysSinceLastSignal has increased by 1.
--    The scheduled prioritisation task must recompute priority_score on every run
--    using the current timestamp. prioritized_at exists for auditability only.
--
-- 6. HALF_LIFE = 14 days — INITIAL_HYPOTHESIS_NOT_VALIDATED. This constant is
--    defined in src/lib/account-prioritization.ts. The DB column stores the result
--    of the formula, not the formula's constants. Changing HALF_LIFE_DAYS in code
--    automatically changes future priority_scores without a migration.
--
-- 7. RLS is inherited from account_intelligence (enabled, no policies defined).
--    See docs/supabase/25-SUPABASE-SECURITY.md.
--
-- ADDITIVE ONLY — no existing columns, indexes, or constraints are modified.

alter table public.account_intelligence
  add column if not exists priority_score  numeric,
  add column if not exists prioritized_at  timestamptz;

-- ── Index ─────────────────────────────────────────────────────────────────────
--
-- Covers the primary prioritisation read pattern:
--   "top N accounts for this client ordered by priority_score DESC"
--
-- NULLS LAST ensures accounts that have not been through a prioritisation run
-- sort after accounts with a computed score (including zeros).
--
-- Partial index (WHERE priority_score IS NOT NULL) keeps the index small and
-- avoids scanning null rows for the common "show me ranked accounts" query.
-- Clients with a mix of scored and unscored accounts benefit most.

create index if not exists account_intelligence_priority_idx
  on public.account_intelligence (client_id, priority_score desc nulls last)
  where priority_score is not null;

-- ── Column comments ───────────────────────────────────────────────────────────

comment on column public.account_intelligence.priority_score is
  'Time-decayed priority score for this (client, company) pair. '
  'Formula: opportunity_score × exp(-daysSinceLastSignal / HALF_LIFE_DAYS). '
  'INITIAL_HYPOTHESIS_NOT_VALIDATED — HALF_LIFE_DAYS = 14 has not been validated '
  'against campaign outcome data. '
  'NULL means this account has not yet been through a prioritisation run. '
  'Zero means the account was prioritised and has no active signals. '
  'Distinct from opportunity_score: opportunity_score is time-invariant within a '
  'signal TTL; priority_score decays daily and must be recomputed on every run. '
  'Rank is NOT stored — compute with ORDER BY priority_score DESC at query time.';

comment on column public.account_intelligence.prioritized_at is
  'When priority_score was last calculated — the wall-clock time of the '
  'prioritisation run, not a guarantee that the score is current. '
  'priority_score decays continuously as time passes, so a score calculated '
  'yesterday is already stale. The scheduled task recomputes it daily. '
  'NULL when priority_score is NULL (account not yet prioritised).';
