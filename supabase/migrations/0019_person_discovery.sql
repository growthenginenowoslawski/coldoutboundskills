-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0019 — Person Discovery & Email Enrichment audit tables (Stage 24)
--
-- STATUS: PREPARED FOR APPROVAL — DO NOT APPLY UNTIL EXPLICITLY APPROVED
--
-- Creates four append-only audit tables for the Stage 24 waterfalls:
--
--   person_discovery_runs      — final waterfall state per (client, company, campaign)
--   person_discovery_attempts  — one row per provider attempt within a run
--   email_enrichment_runs      — final email waterfall state per (client, contact, campaign)
--   email_enrichment_attempts  — one row per email provider attempt
--
-- These tables are the PERSISTENCE LAYER for observability and idempotency.
-- They do not gate behavior — the waterfall lib returns results in-memory;
-- these tables store the audit trail after a run completes.
--
-- Dependencies (must be applied before this migration):
--   0001_grant_service_role.sql, 0002_icp_onboarding.sql, 0003_lead_magnets.sql,
--   0004_campaign_stages.sql, 0018_contact_intelligence.sql
--
-- Tenant isolation:
--   client_id is present on all four tables.
--   provider credentials are NEVER stored in any column (security invariant).
--
-- PII policy:
--   found_email is intentionally NOT persisted in email_enrichment_runs.
--   The discovered email address is returned in-memory only by the waterfall.
--   contacts.email + email_verifications remain the sole source of truth for
--   email addresses. Enrichment history stores only: provider, state,
--   timestamps, boolean found/not-found, and error codes — not the address.
--
-- FK / contact deletion policy:
--   selected_contact_id (person_discovery_runs) and
--   candidate_contact_id (person_discovery_attempts) use ON DELETE SET NULL.
--   These are historical audit references — if a contact is erased (GDPR),
--   the audit row is preserved with the contact pointer nulled out.
--   email_enrichment_runs.contact_id and email_enrichment_attempts.contact_id
--   use ON DELETE CASCADE because contact_id is the subject identity of those
--   rows (included in the UNIQUE key), not a historical reference.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── person_discovery_runs ─────────────────────────────────────────────────────
-- One row per (client, company, campaign_strategy). Tracks the final state of
-- the person discovery waterfall. Updated in-place as the waterfall progresses.

CREATE TABLE IF NOT EXISTS public.person_discovery_runs (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id             UUID NOT NULL REFERENCES public.clients(id),
  company_id            UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  campaign_strategy_id  UUID NOT NULL REFERENCES public.campaign_strategies(id),

  -- Waterfall terminal state. IN_PROGRESS only during a live run.
  state                 TEXT NOT NULL CHECK (state IN (
    'IN_PROGRESS',
    'RELEVANT_FOUND',
    'PERSON_DISCOVERY_EXHAUSTED'
  )),

  -- Selected candidate (only populated when state = 'RELEVANT_FOUND').
  -- ON DELETE SET NULL: if the contact is later erased, the audit row survives
  -- with selected_contact_id = NULL (contact pointer becomes stale).
  selected_contact_id       UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  selected_provider         TEXT,
  selected_relevance_score  INTEGER CHECK (
    selected_relevance_score IS NULL
    OR (selected_relevance_score >= 0 AND selected_relevance_score <= 100)
  ),
  -- Snapshot of isPersonQualified from Stage 23 at time of selection.
  -- Does NOT authorize outreach — activation must re-check eligibility live.
  selected_is_qualified     BOOLEAN,
  selected_at               TIMESTAMPTZ,

  -- Structured fatal error (AUTH_ERROR, ACCOUNT_NOT_READY, etc.).
  -- Null when state = RELEVANT_FOUND or exhausted without a fatal condition.
  fatal_error_code          TEXT,
  fatal_error_message       TEXT,

  -- Provenance summary (full detail lives in person_discovery_attempts).
  providers_tried           TEXT[] NOT NULL DEFAULT '{}',
  total_attempts            INTEGER NOT NULL DEFAULT 0,

  discovery_started_at      TIMESTAMPTZ NOT NULL,
  discovery_updated_at      TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (client_id, company_id, campaign_strategy_id)
);

-- ── person_discovery_attempts ─────────────────────────────────────────────────
-- One row per provider attempt. Linked to person_discovery_runs via run_id.
-- Captures what each provider returned and how Stage 23 evaluated it.

CREATE TABLE IF NOT EXISTS public.person_discovery_attempts (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id                UUID NOT NULL REFERENCES public.person_discovery_runs(id) ON DELETE CASCADE,
  client_id             UUID NOT NULL REFERENCES public.clients(id),
  company_id            UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  campaign_strategy_id  UUID NOT NULL REFERENCES public.campaign_strategies(id),

  -- Which provider and how many times we've called it in this run.
  -- UNIQUE (run_id, provider_id, attempt_number) prevents duplicate attempt rows.
  provider_id           TEXT NOT NULL,
  attempt_number        INTEGER NOT NULL,

  -- What the provider returned (counts only; candidate details are transient PII).
  candidates_returned   INTEGER NOT NULL DEFAULT 0,
  candidates_evaluated  INTEGER NOT NULL DEFAULT 0,

  -- Best candidate evaluated this attempt (null when provider returned nothing).
  -- ON DELETE SET NULL: if the contact is later erased, the attempt audit row
  -- survives with candidate_contact_id = NULL. The rejection reason and score
  -- remain intact for historical analysis.
  candidate_contact_id       UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  candidate_is_relevant      BOOLEAN,
  candidate_relevance_score  INTEGER CHECK (
    candidate_relevance_score IS NULL
    OR (candidate_relevance_score >= 0 AND candidate_relevance_score <= 100)
  ),
  candidate_rejection_reason TEXT CHECK (candidate_rejection_reason IS NULL OR candidate_rejection_reason IN (
    'RELEVANT', 'NO_TITLE', 'WRONG_FUNCTION', 'WRONG_SENIORITY', 'SCORE_BELOW_THRESHOLD'
  )),

  -- Error state. Null on success (even empty results).
  error_code            TEXT CHECK (error_code IS NULL OR error_code IN (
    'NOT_FOUND', 'PROVIDER_ERROR', 'RATE_LIMITED', 'AUTH_ERROR', 'TEMPORARY_FAILURE'
  )),
  error_message         TEXT,

  attempted_at          TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (run_id, provider_id, attempt_number)
);

-- ── email_enrichment_runs ─────────────────────────────────────────────────────
-- One row per (client, contact, campaign_strategy). Tracks the final state of
-- the email enrichment waterfall for a specific person.
--
-- found_email is intentionally absent. The email address is returned in-memory
-- by the waterfall and written to contacts.email + email_verifications by the
-- caller. This table records only provenance metadata: which provider found it,
-- when, and the terminal state.
--
-- contact_id ON DELETE CASCADE: the contact IS the subject identity of this
-- row (included in UNIQUE). If the contact is deleted, the enrichment run
-- no longer refers to anyone and should be deleted with it.

CREATE TABLE IF NOT EXISTS public.email_enrichment_runs (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id             UUID NOT NULL REFERENCES public.clients(id),
  contact_id            UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  campaign_strategy_id  UUID NOT NULL REFERENCES public.campaign_strategies(id),

  state                 TEXT NOT NULL CHECK (state IN (
    'IN_PROGRESS',
    'EMAIL_FOUND',
    'EMAIL_ENRICHMENT_EXHAUSTED'
  )),

  -- Provenance: which provider found the email (no address stored here).
  -- found_email is intentionally absent — see PII policy in file header.
  found_provider        TEXT,
  found_at              TIMESTAMPTZ,

  -- Provenance summary.
  providers_tried       TEXT[] NOT NULL DEFAULT '{}',
  total_attempts        INTEGER NOT NULL DEFAULT 0,

  enrichment_started_at TIMESTAMPTZ NOT NULL,
  enrichment_updated_at TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (client_id, contact_id, campaign_strategy_id)
);

-- ── email_enrichment_attempts ─────────────────────────────────────────────────
-- One row per email provider attempt. Linked to email_enrichment_runs.
-- Records boolean found/not-found and any error — NOT the address itself.
--
-- contact_id ON DELETE CASCADE: inherits the same subject-identity reasoning
-- as email_enrichment_runs.contact_id. Cascade chain:
--   contacts deleted → email_enrichment_runs deleted (CASCADE)
--                     → email_enrichment_attempts deleted (CASCADE via run_id)

CREATE TABLE IF NOT EXISTS public.email_enrichment_attempts (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  run_id                UUID NOT NULL REFERENCES public.email_enrichment_runs(id) ON DELETE CASCADE,
  client_id             UUID NOT NULL REFERENCES public.clients(id),
  contact_id            UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  campaign_strategy_id  UUID NOT NULL REFERENCES public.campaign_strategies(id),

  provider_id           TEXT NOT NULL,
  attempt_number        INTEGER NOT NULL,

  -- Boolean only — email address is not stored in enrichment history.
  email_found           BOOLEAN NOT NULL DEFAULT false,

  error_code            TEXT CHECK (error_code IS NULL OR error_code IN (
    'NOT_FOUND', 'PROVIDER_ERROR', 'RATE_LIMITED', 'AUTH_ERROR', 'TEMPORARY_FAILURE'
  )),
  error_message         TEXT,

  attempted_at          TIMESTAMPTZ NOT NULL,
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (run_id, provider_id, attempt_number)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- person_discovery_runs: lookup by client+company (account pipeline sweep)
CREATE INDEX IF NOT EXISTS person_discovery_runs_client_company_idx
  ON public.person_discovery_runs (client_id, company_id);

-- person_discovery_runs: lookup by client+strategy (all companies for one campaign)
CREATE INDEX IF NOT EXISTS person_discovery_runs_client_strategy_idx
  ON public.person_discovery_runs (client_id, campaign_strategy_id);

-- person_discovery_runs: filter by state (find all RELEVANT_FOUND)
-- Single-column intentionally: selectivity improvement deferred until real
-- production query patterns are available.
CREATE INDEX IF NOT EXISTS person_discovery_runs_state_idx
  ON public.person_discovery_runs (state);

-- person_discovery_attempts: fetch all attempts for a run
CREATE INDEX IF NOT EXISTS person_discovery_attempts_run_idx
  ON public.person_discovery_attempts (run_id);

-- email_enrichment_runs: lookup by client+contact (all campaigns for one person)
CREATE INDEX IF NOT EXISTS email_enrichment_runs_client_contact_idx
  ON public.email_enrichment_runs (client_id, contact_id);

-- email_enrichment_attempts: fetch all attempts for a run
CREATE INDEX IF NOT EXISTS email_enrichment_attempts_run_idx
  ON public.email_enrichment_attempts (run_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- service_role bypasses RLS; no anon key in use.
-- Consistent with all other Stage 23+ tables: RLS enabled, zero policies.
-- Add policies per FINDING 6 pattern when anon access is required.

ALTER TABLE public.person_discovery_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_discovery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_enrichment_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_enrichment_attempts ENABLE ROW LEVEL SECURITY;
