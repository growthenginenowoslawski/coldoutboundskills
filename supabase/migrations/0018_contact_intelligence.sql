-- 0018_contact_intelligence.sql
--
-- Stage 23: Contact Intelligence & Person Relevance
--
-- Answers: "For an account worth pursuing, who is the right person to contact,
-- and why?"
--
-- ── WHAT THIS MIGRATION DOES ──────────────────────────────────────────────────
--
-- Two new tables:
--
--   1. contact_intelligence (campaign-agnostic, one row per client/company/contact)
--      Stores title classification (function + seniority + confidence) and a
--      snapshot of the Stage 17 contact eligibility gate result. These facts
--      are shared across all campaigns for the same contact.
--
--   2. contact_campaign_relevance (campaign-specific, one row per
--      client/company/contact/campaign_strategy)
--      Stores the deterministic relevance score and AI-generated explanation
--      for a specific (contact, campaign) pair. The same contact may be
--      RELEVANT for one campaign and NOT RELEVANT for another.
--
-- Both tables:
--   - Have UNIQUE constraints to enforce the one-row-per-entity invariant
--   - Have RLS enabled (no policies yet — service_role bypasses RLS)
--   - Are ADDITIVE ONLY — no existing tables or columns are modified
--
-- ── TRIGGER: campaign_strategy_id client isolation ────────────────────────────
--
-- campaign_strategies has no UNIQUE(client_id, id), so a composite FK from
-- contact_campaign_relevance(client_id, campaign_strategy_id) →
-- campaign_strategies(client_id, id) is not possible without adding that
-- constraint to campaign_strategies (which is not approved for this migration).
--
-- Instead, the same trigger pattern used in migration 0014 for
-- campaigns.campaign_strategy_id is applied here:
--   A BEFORE INSERT/UPDATE trigger verifies that campaign_strategy_id belongs
--   to the same client_id as the contact_campaign_relevance row.
--   This is true DB-level enforcement — it fires for all connections, including
--   direct psql, not just application code.
--
-- ── SNAPSHOT SEMANTICS — NOT OUTREACH AUTHORIZATION ──────────────────────────
--
-- contact_intelligence.is_contact_ready is a DISCOVERY snapshot only.
-- A stored is_contact_ready = true does NOT authorize outreach or enrollment.
-- Suppression, email validity, and account state can change after the snapshot.
-- The activation stage (Stage 24+) MUST re-run evaluateContactEligibility()
-- live immediately before any enrollment or outreach action.
--
-- contact_campaign_relevance.is_person_qualified is similarly a snapshot:
--   is_person_qualified = is_person_relevant AND is_contact_ready (snapshot)
-- It does NOT imply OUTREACH_READY.
--
-- Stage 23 never produces OUTREACH_READY. That state requires downstream checks
-- (Why Now currency, personalization, human review, campaign state, rate limits,
-- deliverability) and belongs to a future activation stage.
--
-- ── THRESHOLD LABELLING ───────────────────────────────────────────────────────
--
-- All numeric thresholds referenced by this table are INITIAL_HYPOTHESIS_NOT_VALIDATED
-- — computed from first-principles reasoning, not validated against campaign
-- outcome data. See src/lib/person-relevance.ts for the constants.
--
-- ── PII ───────────────────────────────────────────────────────────────────────
--
-- title_classification stores ONLY function bucket, seniority, and confidence.
-- The raw job title (contacts.job_title) is NEVER stored in JSONB.
-- It is used at assessment time for the AI narrative, then discarded.
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────
--
-- Both tables are NEW — no existing data affected.
-- ADDITIVE ONLY: no existing tables, constraints, or indexes are removed.
-- IF NOT EXISTS / CREATE OR REPLACE: idempotent DDL throughout.
-- DO blocks: constraint additions are idempotent (no IF NOT EXISTS syntax).
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER: trigger is idempotent.
--
-- ── FINDINGS ─────────────────────────────────────────────────────────────────
--
-- Pre-migration schema check (2026-09-07):
--   1. campaign_strategies — NO UNIQUE(client_id, id). Trigger pattern used.
--   2. contacts — updated_at column EXISTS in DB (no TS type — see ContactRow).
--      This means staleness detection can use contacts.updated_at if the TS
--      type is extended. Documented limitation in isContactIntelligenceStale().
--   3. Stage 23 tables do not exist yet — clean slate.

-- =============================================================================
-- SECTION 1: contact_intelligence — campaign-agnostic title + gate snapshot
-- =============================================================================

create table if not exists public.contact_intelligence (
  id                          uuid        primary key default gen_random_uuid(),

  -- Tenant isolation. Every row belongs to exactly one client.
  client_id                   uuid        not null
                                          references public.clients(id)   on delete cascade,

  -- The account this contact belongs to.
  -- companies is shared infrastructure (no client_id).
  company_id                   uuid        not null
                                          references public.companies(id) on delete cascade,

  -- The contact being assessed. contacts is global (no client_id).
  -- client isolation is enforced by client_id on this row.
  contact_id                   uuid        not null
                                          references public.contacts(id)  on delete cascade,

  -- Deterministic title classification: function bucket, seniority, confidence.
  -- rawTitle intentionally absent — PII minimisation.
  -- Null before the first assessment run.
  title_classification         jsonb,

  -- Snapshot of Stage 17 contact eligibility gate result.
  -- Structure: { accountGate, contactGate, emailGate, suppressionGate,
  --              blockingGate, blockingReason, evaluatedAt }
  -- DISCOVERY ONLY — see snapshot semantics note in header.
  gate_snapshot                jsonb,

  -- Summary of all four gate results. True = all gates passed.
  -- SNAPSHOT only — NOT authorization for outreach.
  -- Null before first assessment.
  is_contact_ready             boolean,

  -- When is_contact_ready was last evaluated.
  -- Null before first assessment.
  contact_readiness_assessed_at timestamptz,

  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  -- Named constraint: one assessment row per (client, company, contact).
  constraint contact_intelligence_client_company_contact_key
    unique (client_id, company_id, contact_id)
);

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.contact_intelligence enable row level security;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary read: "all contacts assessed for a client at a specific account."
create index if not exists contact_intelligence_client_company_idx
  on public.contact_intelligence (client_id, company_id);

-- Reverse lookup: "which clients have assessed this contact?"
create index if not exists contact_intelligence_contact_idx
  on public.contact_intelligence (contact_id);

-- Partial index: "all contacts that passed eligibility for this client."
-- Used when building contact shortlists from ready contacts.
create index if not exists contact_intelligence_ready_idx
  on public.contact_intelligence (client_id)
  where is_contact_ready = true;

-- ── Column comments ───────────────────────────────────────────────────────────

comment on table public.contact_intelligence
  is 'Campaign-agnostic contact assessment. One row per (client_id, company_id, '
     'contact_id). Stores deterministic title classification and a snapshot of '
     'the Stage 17 contact eligibility gate. is_contact_ready is a DISCOVERY '
     'artifact — NOT authorization for outreach. Stage 23 only; activation '
     'stage (Stage 24+) MUST re-run evaluateContactEligibility() live before enrollment.';

comment on column public.contact_intelligence.title_classification
  is 'Deterministic job title classification: { function, seniority, confidence }. '
     'rawTitle intentionally absent (PII minimisation). '
     'Null before first assessment.';

comment on column public.contact_intelligence.gate_snapshot
  is 'Snapshot of Stage 17 contact eligibility gate: '
     '{ accountGate, contactGate, emailGate, suppressionGate, '
     '  blockingGate, blockingReason, evaluatedAt }. '
     'DISCOVERY ONLY — not authorization for outreach. '
     'Suppression/email validity may have changed since snapshot.';

comment on column public.contact_intelligence.is_contact_ready
  is 'True when all four eligibility gates passed at contact_readiness_assessed_at. '
     'DISCOVERY SNAPSHOT ONLY — NOT authorization for outreach or enrollment. '
     'The activation stage MUST re-run evaluateContactEligibility() live.';

-- =============================================================================
-- SECTION 2: contact_campaign_relevance — campaign-specific relevance score
-- =============================================================================

create table if not exists public.contact_campaign_relevance (
  id                    uuid        primary key default gen_random_uuid(),

  -- Tenant isolation.
  client_id             uuid        not null
                                    references public.clients(id)            on delete cascade,

  -- The account this contact belongs to.
  company_id             uuid        not null
                                    references public.companies(id)          on delete cascade,

  -- The contact being assessed.
  contact_id             uuid        not null
                                    references public.contacts(id)           on delete cascade,

  -- The campaign strategy this relevance assessment is for.
  -- A simple FK enforces referential integrity.
  -- Client isolation is enforced by the trigger below (campaign_strategies
  -- has no UNIQUE(client_id, id) — see header).
  campaign_strategy_id   uuid        not null
                                    references public.campaign_strategies(id) on delete cascade,

  -- 0–100 weighted relevance score.
  -- Formula: function_match * 0.55 + seniority_match * 0.45 + signal_bonus.
  -- All weights INITIAL_HYPOTHESIS_NOT_VALIDATED.
  -- Null until first assessment.
  relevance_score        numeric(5, 2)
                                    check (relevance_score between 0 and 100),

  -- True when relevance_score >= PERSON_RELEVANCE_MIN_SCORE (30).
  -- INITIAL_HYPOTHESIS_NOT_VALIDATED threshold.
  is_person_relevant     boolean,

  -- is_person_relevant AND is_contact_ready (snapshot from contact_intelligence).
  -- Does NOT imply OUTREACH_READY. Stage 23 never produces OUTREACH_READY.
  is_person_qualified    boolean,

  -- Machine-readable outcome reason.
  -- RELEVANT, NO_TITLE, WRONG_FUNCTION, WRONG_SENIORITY, SCORE_BELOW_THRESHOLD.
  relevance_reason       text
                                    check (relevance_reason in (
                                      'RELEVANT',
                                      'NO_TITLE',
                                      'WRONG_FUNCTION',
                                      'WRONG_SENIORITY',
                                      'SCORE_BELOW_THRESHOLD'
                                    )),

  -- Full deterministic evidence: titleClassification, targetingPersona,
  -- signalAlignments, factorScores, relevanceScore, assessedAt, scoringVersion,
  -- hypothesis ("INITIAL_HYPOTHESIS_NOT_VALIDATED").
  -- rawTitle intentionally absent.
  evidence               jsonb,

  -- AI-generated "why this person" sentence.
  -- Structure: { whyThisPerson, confidence, model, analyzedAt, inputTokens,
  --              outputTokens, costUsd, latencyMs }
  -- Null when not generated (e.g., score below AI_RELEVANCE_MIN_SCORE, AI failed).
  narrative              jsonb,

  -- Scoring version at time of assessment.
  -- Promoted from evidence JSONB so staleness checks don't parse JSONB.
  -- When this differs from the current SCORING_VERSION constant, the row is stale.
  scoring_version        text,

  -- When relevance_score was last computed.
  relevance_assessed_at  timestamptz,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Named constraint: one relevance row per (client, company, contact, campaign).
  constraint contact_campaign_relevance_client_contact_campaign_key
    unique (client_id, company_id, contact_id, campaign_strategy_id)
);

-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table public.contact_campaign_relevance enable row level security;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary read: "all contacts assessed for this campaign."
create index if not exists contact_campaign_relevance_client_strategy_idx
  on public.contact_campaign_relevance (client_id, campaign_strategy_id);

-- Most common qualified-contacts query: "who's qualified for this campaign?"
create index if not exists contact_campaign_relevance_qualified_idx
  on public.contact_campaign_relevance (client_id, campaign_strategy_id)
  where is_person_qualified = true;

-- Stale-row detection when SCORING_VERSION is bumped.
-- SELECT * FROM contact_campaign_relevance WHERE scoring_version != '<new>';
create index if not exists contact_campaign_relevance_scoring_version_idx
  on public.contact_campaign_relevance (scoring_version);

-- Reverse lookup: "all campaigns this contact has been assessed for."
create index if not exists contact_campaign_relevance_contact_idx
  on public.contact_campaign_relevance (contact_id);

-- Account-level contact sweep: "all assessed contacts at an account for a client."
create index if not exists contact_campaign_relevance_client_company_idx
  on public.contact_campaign_relevance (client_id, company_id);

-- ── Column comments ───────────────────────────────────────────────────────────

comment on table public.contact_campaign_relevance
  is 'Campaign-specific person relevance. One row per (client_id, company_id, '
     'contact_id, campaign_strategy_id). The same contact may be relevant for '
     'one campaign and not another. is_person_qualified is a DISCOVERY snapshot '
     '(is_person_relevant AND is_contact_ready). Does NOT imply OUTREACH_READY. '
     'All thresholds are INITIAL_HYPOTHESIS_NOT_VALIDATED.';

comment on column public.contact_campaign_relevance.scoring_version
  is 'SCORING_VERSION from src/lib/person-relevance.ts at assessment time. '
     'Promoted from evidence JSONB for fast staleness comparison. '
     'Row is stale when scoring_version != current SCORING_VERSION constant.';

comment on column public.contact_campaign_relevance.is_person_qualified
  is 'is_person_relevant AND is_contact_ready (snapshot). '
     'Does NOT imply OUTREACH_READY — downstream checks (Why Now currency, '
     'personalization, human review, rate limits) belong to a future activation stage.';

comment on column public.contact_campaign_relevance.evidence
  is 'Deterministic scoring evidence (no rawTitle — PII). '
     'Contains: titleClassification, targetingPersona, signalAlignments, '
     'factorScores, relevanceScore, assessedAt, scoringVersion, hypothesis. '
     'hypothesis is always "INITIAL_HYPOTHESIS_NOT_VALIDATED".';

-- =============================================================================
-- SECTION 3: cross-client campaign_strategy_id trigger
-- =============================================================================
--
-- WHY: campaign_strategies has only PRIMARY KEY (id) — no UNIQUE(client_id, id).
-- A composite FK from contact_campaign_relevance(client_id, campaign_strategy_id)
-- → campaign_strategies(client_id, id) is therefore not possible without adding
-- that constraint (not approved for this migration — could affect existing data).
--
-- SOLUTION: Same trigger pattern as migration 0014 for campaigns.campaign_strategy_id.
-- The trigger fires BEFORE INSERT OR UPDATE on contact_campaign_relevance and
-- raises an exception if campaign_strategy_id belongs to a different client.
--
-- ENFORCEMENT SCOPE: Fires for all connections (service_role, psql, application).
-- Protects at the DB level — not just in application code.

create or replace function public.check_contact_campaign_strategy_client()
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
        'cross-client assignment on contact_campaign_relevance is not permitted',
        new.campaign_strategy_id, new.client_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists contact_campaign_strategy_client_check
  on public.contact_campaign_relevance;

create trigger contact_campaign_strategy_client_check
  before insert or update on public.contact_campaign_relevance
  for each row execute function public.check_contact_campaign_strategy_client();

comment on function public.check_contact_campaign_strategy_client() is
  'Enforces that campaign_strategy_id on contact_campaign_relevance belongs to the '
  'same client_id as the row. Compensates for campaign_strategies lacking '
  'UNIQUE(client_id, id) — the pattern from migration 0014. '
  'Fires BEFORE INSERT OR UPDATE. Raises an exception on cross-client violation.';
