-- 0021_account_campaign_qualification.sql
--
-- Stage 29 Phase 2: Account Qualification Persistence
--
-- Answers: "For a given campaign strategy, which companies qualify, and why?"
--
-- ── WHAT THIS MIGRATION DOES ──────────────────────────────────────────────────
--
-- One new table:
--
--   account_campaign_qualification (campaign-specific, one row per
--   client/company/campaign_strategy)
--   Stores the deterministic qualification result for a specific
--   (company, campaign_strategy) pair. The same company may QUALIFY for
--   one campaign and NOT QUALIFY for another — depending on the strategy's
--   ICP, geography, industry rules, and exclusions.
--
-- The account_intelligence table is NOT modified. account_intelligence is
-- campaign-agnostic (per client/company). Qualification is campaign-specific
-- and MUST be stored separately.
--
-- ── ARCHITECTURE RATIONALE ────────────────────────────────────────────────────
--
-- This table follows the EXACT pattern of contact_campaign_relevance (0018):
--
--   contact_intelligence        — per (client, company, contact)           — campaign-AGNOSTIC
--   contact_campaign_relevance  — per (client, company, contact, strategy) — campaign-SPECIFIC
--
--   account_intelligence         — per (client, company)           — campaign-AGNOSTIC
--   account_campaign_qualification — per (client, company, strategy) — campaign-SPECIFIC
--
-- Migration 0018 commentary applies verbatim:
--   "The same contact may be RELEVANT for one campaign and NOT RELEVANT for another."
--   → "The same company may QUALIFY for one campaign and NOT QUALIFY for another."
--
-- Storing is_qualified on account_intelligence (per client/company) would cause
-- the LAST qualification run to silently overwrite ALL previous campaign
-- qualifications — a multi-campaign correctness bug proven by Phase 1.5 tests.
--
-- ── TRIGGER: campaign_strategy_id client isolation ────────────────────────────
--
-- campaign_strategies has no UNIQUE(client_id, id), so a composite FK from
-- account_campaign_qualification(client_id, campaign_strategy_id) →
-- campaign_strategies(client_id, id) is not possible.
--
-- The same trigger pattern from migration 0018 (contact_campaign_relevance) and
-- migration 0014 (campaigns.campaign_strategy_id) is applied here:
--   A BEFORE INSERT/UPDATE trigger verifies that campaign_strategy_id belongs to
--   the same client_id as the account_campaign_qualification row.
--   Fires for all connections — psql, service_role, application code.
--
-- ── THRESHOLD LABELLING ───────────────────────────────────────────────────────
--
-- qualification_score and the qualified boolean are both
-- INITIAL_HYPOTHESIS_NOT_VALIDATED — computed from first-principles reasoning,
-- not validated against campaign outcome data.
-- See src/lib/account-qualification.ts for the scoring constants.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────
--
-- ADDITIVE ONLY — account_intelligence and all existing tables are unchanged.
-- IF NOT EXISTS / CREATE OR REPLACE: idempotent DDL throughout.
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER: trigger is idempotent.
-- No existing data is read or modified.

-- =============================================================================
-- SECTION 1: account_campaign_qualification — campaign-specific qualification
-- =============================================================================

create table if not exists public.account_campaign_qualification (
  id                         uuid        primary key default gen_random_uuid(),

  -- Tenant isolation. Every row belongs to exactly one client.
  client_id                  uuid        not null
                                         references public.clients(id) on delete cascade,

  -- The company being assessed.
  -- companies is shared infrastructure (no client_id).
  -- Client isolation is enforced by client_id on this row.
  company_id                 uuid        not null
                                         references public.companies(id) on delete cascade,

  -- The campaign strategy this qualification is for.
  -- Client isolation enforced by the trigger below — campaign_strategies
  -- has no UNIQUE(client_id, id) so a composite FK is not possible.
  campaign_strategy_id       uuid        not null
                                         references public.campaign_strategies(id) on delete cascade,

  -- Whether this company qualifies for the campaign strategy's ICP.
  -- True = no hard exclusions AND qualification_score >= threshold.
  -- All thresholds INITIAL_HYPOTHESIS_NOT_VALIDATED.
  qualified                  boolean     not null,

  -- 0–100 evidence score.
  -- Reflects dimension weights: geography, industry, headcount, hiring, opportunity.
  -- 0 when a hard exclusion applies.
  -- INITIAL_HYPOTHESIS_NOT_VALIDATED — all dimension weights are starting hypotheses.
  qualification_score        integer     not null
                                         check (qualification_score >= 0 and qualification_score <= 100),

  -- Full AccountQualificationResult JSONB:
  -- { hypothesis, qualified, qualificationScore, campaignStrategyId,
  --   exclusionReasons, geographyVerdict, industryVerdict, sizeVerdict,
  --   hiringEvidenceVerdict, positiveEvidence, negativeEvidence,
  --   missingInfo, warnings, assessedAt }
  -- hypothesis is always "INITIAL_HYPOTHESIS_NOT_VALIDATED".
  qualification              jsonb       not null,

  -- When computeAccountQualification() was last called for this row.
  qualification_assessed_at  timestamptz not null,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  -- Named constraint: one qualification row per (client, company, campaign_strategy).
  -- This is the idempotent upsert key — re-running qualification for the same
  -- (client, company, strategy) triple updates in place rather than creating duplicates.
  constraint account_campaign_qualification_key
    unique (client_id, company_id, campaign_strategy_id)
);

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.account_campaign_qualification enable row level security;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary lookup: "all companies assessed for this campaign strategy."
-- Used by Stage 25's "fetch qualifications for campaign" query.
create index if not exists account_campaign_qualification_client_strategy_idx
  on public.account_campaign_qualification (client_id, campaign_strategy_id);

-- Qualified-companies fast filter: "which companies qualified for this campaign?"
create index if not exists account_campaign_qualification_qualified_idx
  on public.account_campaign_qualification (client_id, campaign_strategy_id)
  where qualified = true;

-- Reverse lookup: "all campaigns a specific company has been assessed for."
create index if not exists account_campaign_qualification_company_idx
  on public.account_campaign_qualification (company_id);

-- Client + company lookup: "all strategies a company has been qualified against."
create index if not exists account_campaign_qualification_client_company_idx
  on public.account_campaign_qualification (client_id, company_id);

-- ── Column comments ───────────────────────────────────────────────────────────

comment on table public.account_campaign_qualification is
  'Campaign-specific account qualification. One row per (client_id, company_id, '
  'campaign_strategy_id). The same company may qualify for one campaign strategy '
  'and not another. ADDITIVE — account_intelligence is NOT modified. '
  'All thresholds are INITIAL_HYPOTHESIS_NOT_VALIDATED. '
  'Mirrors the contact_campaign_relevance pattern (migration 0018).';

comment on column public.account_campaign_qualification.qualified is
  'True when no hard exclusion applies and qualification_score meets the minimum '
  'threshold (INITIAL_HYPOTHESIS_NOT_VALIDATED). '
  'False when geography FAIL, industry OUT-list match, or disqualifier match. '
  'Distinct from account_intelligence.is_ready (Why Now signal check — '
  'campaign-agnostic). This column is campaign-specific.';

comment on column public.account_campaign_qualification.qualification_score is
  'Evidence strength 0–100. 0 when hard-excluded. '
  'Dimension weights (all INITIAL_HYPOTHESIS_NOT_VALIDATED): '
  'geography PASS=35, industry PASS=25, hiring PRESENT=20, size PASS=10, '
  'opportunity bonus max=10. Separate from qualified: a company can be '
  'qualified=true with score=25 (sparse data).';

comment on column public.account_campaign_qualification.qualification is
  'Full AccountQualificationResult JSONB: hypothesis, qualified, qualificationScore, '
  'campaignStrategyId, exclusionReasons, geographyVerdict, industryVerdict, '
  'sizeVerdict, hiringEvidenceVerdict, positiveEvidence, negativeEvidence, '
  'missingInfo, warnings, assessedAt. '
  'hypothesis is always "INITIAL_HYPOTHESIS_NOT_VALIDATED". '
  'Computed by computeAccountQualification() in src/lib/account-qualification.ts.';

comment on column public.account_campaign_qualification.qualification_assessed_at is
  'When computeAccountQualification() was last called. '
  'NOT a freshness guarantee — new signals or ICP answer changes may affect the result. '
  'Written atomically with qualified, qualification_score, and qualification.';

-- =============================================================================
-- SECTION 2: cross-client campaign_strategy_id trigger
-- =============================================================================
--
-- WHY: campaign_strategies has only PRIMARY KEY (id) — no UNIQUE(client_id, id).
-- A composite FK from account_campaign_qualification(client_id, campaign_strategy_id)
-- → campaign_strategies(client_id, id) is therefore not possible.
--
-- SOLUTION: Same trigger pattern as migration 0018 (contact_campaign_relevance)
-- and migration 0014 (campaigns.campaign_strategy_id).
-- The trigger fires BEFORE INSERT OR UPDATE and raises an exception if
-- campaign_strategy_id belongs to a different client.
--
-- ENFORCEMENT SCOPE: Fires for all connections (service_role, psql, application).
-- Protects at the DB level.

create or replace function public.check_account_qualification_strategy_client()
returns trigger
language plpgsql
as $$
begin
  if new.campaign_strategy_id is not null then
    if not exists (
      select 1
        from public.campaign_strategies
       where id        = new.campaign_strategy_id
         and client_id = new.client_id
    ) then
      raise exception
        'campaign_strategy_id % does not belong to client_id % — '
        'cross-client assignment on account_campaign_qualification is not permitted',
        new.campaign_strategy_id, new.client_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists account_qualification_strategy_client_check
  on public.account_campaign_qualification;

create trigger account_qualification_strategy_client_check
  before insert or update on public.account_campaign_qualification
  for each row execute function public.check_account_qualification_strategy_client();

comment on function public.check_account_qualification_strategy_client() is
  'Enforces that campaign_strategy_id on account_campaign_qualification belongs to '
  'the same client_id as the row. Compensates for campaign_strategies lacking '
  'UNIQUE(client_id, id) — the pattern from migrations 0014 and 0018. '
  'Fires BEFORE INSERT OR UPDATE. Raises an exception on cross-client violation.';
