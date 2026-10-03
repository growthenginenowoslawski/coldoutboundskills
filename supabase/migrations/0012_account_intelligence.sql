-- 0012_account_intelligence.sql
--
-- Stage 12: Account Intelligence — deterministic opportunity scoring
--
-- Stores the per-client, per-company opportunity score and its full input
-- breakdown. One row per (client_id, company_id) targeting relationship.
--
-- ── Design decisions ──────────────────────────────────────────────────────────
--
-- 1. TWO OPPORTUNITY SCORES COEXIST (naming collision — known technical debt)
--
--    account_intelligence.opportunity_score (this table, Stage 12):
--      Deterministic. Computed from stored signals without AI.
--      Labels: INITIAL_HYPOTHESIS_NOT_VALIDATED.
--
--    enrichment_runs.output_data.opportunityScore (signal intelligence task):
--      AI-derived analytical estimate. Labels: ANALYTICAL_ESTIMATE_ONLY.
--
--    These are different concepts. This table is the canonical score for
--    account prioritisation. The AI field is untouched by Stage 12.
--
-- 2. icp_score is read from companies.icp_score (global, not per-client).
--    TEMPORARY ARCHITECTURAL COMPROMISE: when two clients qualify the same
--    company, the global value reflects the last writer. The score_inputs
--    column documents this on every stored record. Resolution: migrate
--    icp_score into this table as a per-client column when a second
--    production client targets companies in common.
--
-- 3. RLS is enabled. No policies are defined yet because no user-facing
--    authentication exists. The intended future policy:
--
--      CREATE POLICY "authenticated_read_own_client"
--        ON public.account_intelligence FOR SELECT TO authenticated
--        USING (client_id = (auth.jwt() -> 'app_metadata' ->> 'client_id')::uuid);
--
--    This is BLOCKED pending auth/tenant-mapping design. See:
--    docs/supabase/25-SUPABASE-SECURITY.md
--
--    Application-layer .eq('client_id', clientId) is defense-in-depth,
--    not the primary security boundary.
--
-- ADDITIVE ONLY — no existing tables, columns, or indexes are modified.

-- ── Table ─────────────────────────────────────────────────────────────────────

create table if not exists public.account_intelligence (
  id                           uuid         primary key default gen_random_uuid(),

  client_id                    uuid         not null
                                            references public.clients(id)    on delete cascade,

  company_id                   uuid         not null
                                            references public.companies(id)  on delete cascade,

  -- Deterministic opportunity score. 0 = no signal evidence or no ICP fit.
  -- 100 = maximum signal evidence with full ICP fit.
  -- INITIAL_HYPOTHESIS_NOT_VALIDATED — formula weights have not been validated
  -- against campaign outcome data.
  opportunity_score            integer      not null
                                            check (opportunity_score between 0 and 100),

  -- When the opportunity_score was last computed. Used for staleness detection.
  opportunity_score_updated_at timestamptz  not null,

  -- Full breakdown of how the score was computed. Every contributing signal
  -- is listed by UUID so the score is traceable back to signals table rows.
  -- Includes hypothesis label, icp_score source note, and all intermediate
  -- values. Nullable only before the first scoring run (should never be null
  -- after a successful upsert from the scoring module).
  score_inputs                 jsonb,

  created_at                   timestamptz  not null default now(),
  updated_at                   timestamptz  not null default now(),

  -- Named constraint so callers can detect 23505 and identify the target
  -- without relying on a generated constraint name.
  constraint account_intelligence_client_company_key
    unique (client_id, company_id)
);

-- ── Row-Level Security ────────────────────────────────────────────────────────
--
-- RLS is enabled to establish the correct security posture. No policies are
-- defined yet: service_role (the only current access path) bypasses RLS by
-- PostgreSQL design. Any non-service_role role therefore sees NO rows by
-- default — this is the protective posture until authenticated policies exist.
--
-- RLS POLICY IMPLEMENTATION BLOCKED BY CURRENT AUTH/TENANT-MAPPING DESIGN.
-- See the header comment and docs/supabase/25-SUPABASE-SECURITY.md.

alter table public.account_intelligence enable row level security;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary ranked query: "top N accounts for this client ordered by score."
-- Covers the most common read pattern — getTopAccountsByScore().
create index if not exists account_intelligence_client_score_idx
  on public.account_intelligence (client_id, opportunity_score desc);

-- Single-record lookup and upsert target resolution.
-- Covers getAccountIntelligence() and the conflict path of upsertAccountIntelligence().
create index if not exists account_intelligence_client_company_idx
  on public.account_intelligence (client_id, company_id);

-- Staleness detection: find accounts not scored in the last N hours.
-- Used by maintenance sweeps to identify records that may need recomputation
-- after signal expiry (signals expired but no ingestion run has fired yet).
create index if not exists account_intelligence_staleness_idx
  on public.account_intelligence (opportunity_score_updated_at);

-- ── Table comment ─────────────────────────────────────────────────────────────

comment on table public.account_intelligence
  is 'Per-client, per-company account intelligence. One row per targeting '
     'relationship (client_id, company_id). Stores the deterministic opportunity '
     'score computed from stored signals without AI. Score is INITIAL_HYPOTHESIS_NOT_VALIDATED '
     '— weights have not been validated against campaign outcome data. '
     'Distinguished from the AI-derived opportunityScore in enrichment_runs '
     '(signal intelligence task), which is ANALYTICAL_ESTIMATE_ONLY.';

-- ── Column comments ───────────────────────────────────────────────────────────

comment on column public.account_intelligence.client_id
  is 'Tenant owner of this account intelligence record. '
     'All reads and writes must scope to this client_id (defense-in-depth). '
     'FK cascades on client delete.';

comment on column public.account_intelligence.company_id
  is 'The target company this record describes. '
     'companies is shared infrastructure (no client_id) — account_intelligence '
     'is how client-specific intelligence is attached to a global company row. '
     'FK cascades on company delete.';

comment on column public.account_intelligence.opportunity_score
  is '0–100 deterministic opportunity score for this (client, company) pair. '
     'Formula: sum(signal_strength/100 × freshness/100 × icp_relevance × 100) '
     '× corroboration_factor × (icp_score/100), capped at 100. '
     'INITIAL_HYPOTHESIS_NOT_VALIDATED — weights are starting hypotheses. '
     'icp_relevance weights and corroboration rules are in src/lib/opportunity-scoring.ts. '
     'icp_score is read from companies.icp_score (global — TEMPORARY COMPROMISE).';

comment on column public.account_intelligence.opportunity_score_updated_at
  is 'When opportunity_score was last computed. '
     'Used to detect stale scores: if no ingestion run has fired since signals '
     'expired, this timestamp reveals how out-of-date the score may be.';

comment on column public.account_intelligence.score_inputs
  is 'Full breakdown of how opportunity_score was computed. '
     'Contains: hypothesis label (always "INITIAL_HYPOTHESIS_NOT_VALIDATED"), '
     'computedAt, signalCount, rawScore, corroborationFactor, icpFitWeight, '
     'icpScore, icpScoreSource (documents the global icp_score compromise), '
     'finalScore, and a signals[] array. Each signals[] entry includes: '
     'signalId (UUID traceable to signals table), signalType, signalStrength, '
     'freshnessScore, icpRelevance, contribution. '
     'Every signalId must resolve to a row in the signals table.';

comment on column public.account_intelligence.created_at
  is 'When this (client, company) pair was first scored.';

comment on column public.account_intelligence.updated_at
  is 'When this row was last written — set on every upsert. '
     'Distinct from opportunity_score_updated_at: updated_at tracks row '
     'write time; opportunity_score_updated_at tracks scoring computation time.';
