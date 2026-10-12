-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0020 — Stage 25A: Campaign Readiness Assessment
-- (rev 2 — post-review corrections applied 2026-09-09)
--
-- STATUS: Written for review. NOT YET APPLIED to production.
-- Do not apply until this migration has been reviewed alongside:
--   src/db/campaign-readiness.ts
--   src/lib/campaign-readiness.ts
--   src/domain/campaign-readiness-types.ts
--
-- Creates two tables:
--   campaign_readiness_assessments — immutable per-evaluation snapshots
--   campaign_readiness_approvals   — immutable human-approval records (is_stale excepted)
--
-- ── Security model ────────────────────────────────────────────────────────────
--
-- Both tables have RLS enabled with zero policies (service_role only).
-- All writes include client_id for defence-in-depth tenant isolation.
-- contact_results JSONB contains contactId/companyId UUIDs only — no emails.
-- eligible_contact_ids is uuid[] — no emails.
--
-- ── Immutability ──────────────────────────────────────────────────────────────
--
-- campaign_readiness_assessments: fully immutable after INSERT. No updated_at.
-- campaign_readiness_approvals: immutable except (is_stale, stale_reason,
--   stale_set_at), which are updated only by the activation orchestrator
--   via markApprovalStale().
--
-- ── Tenant isolation ─────────────────────────────────────────────────────────
--
-- client_id ON DELETE CASCADE on both tables: deleting a client removes all
-- their assessments and approvals in one transaction.
--
-- Composite FK on assessments enforces that (client_id, campaign_id) matches
-- an existing row in campaigns(client_id, id) (unique constraint added in 0014).
-- This prevents cross-client campaign references at the DB level.
--
-- ── Approval/assessment binding ──────────────────────────────────────────────
--
-- campaign_id is intentionally NOT stored in campaign_readiness_approvals.
-- An approval is bound to a specific assessment via assessment_id (UNIQUE).
-- The campaign_id is always retrievable via the assessment row.
-- Storing a denormalized campaign_id would require a trigger or application-layer
-- enforcement; removing it eliminates the consistency problem entirely.
--
-- assessment_id ON DELETE RESTRICT: an assessment cannot be deleted while an
-- approval exists. This preserves the audit trail. To delete a campaign that has
-- approved assessments, remove the approvals first.
--
-- Cascade chain note: deleting a client cascades to assessments AND approvals
-- (both have client_id ON DELETE CASCADE). PostgreSQL processes both cascades
-- within the same statement; the RESTRICT check on assessment_id passes because
-- the approvals are also being deleted in the same cascade chain.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── campaign_readiness_assessments ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.campaign_readiness_assessments (
  id                                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenant isolation (CASCADE: deleting a client removes all their assessments)
  client_id                             UUID         NOT NULL
    REFERENCES public.clients(id) ON DELETE CASCADE,

  -- Campaign reference — FK enforced via composite constraint below
  campaign_id                           UUID         NOT NULL,

  -- Optional strategy reference.
  -- Simple FK only: campaign_strategies lacks UNIQUE(client_id, id),
  -- so a composite FK is not possible (same limitation as migration 0018).
  campaign_strategy_id                  UUID         NULL
    REFERENCES public.campaign_strategies(id) ON DELETE SET NULL,

  -- CHECK ensures only the three valid verdicts can be stored
  verdict                               TEXT         NOT NULL
    CHECK (verdict IN ('OUTREACH_READY', 'OUTREACH_READY_WITH_WARNINGS', 'HARD_BLOCKED')),

  -- Snapshot of campaign state at evaluation time
  campaign_status_at_evaluation         TEXT         NOT NULL,
  platform_campaign_id_at_evaluation    TEXT         NULL,

  -- Hard block and warning codes (detail strings are recomputed from the assessment)
  hard_block_codes                      TEXT[]       NOT NULL DEFAULT '{}',
  warning_codes                         TEXT[]       NOT NULL DEFAULT '{}',

  -- Eligible contact UUIDs only — no email addresses stored
  eligible_contact_ids                  UUID[]       NOT NULL DEFAULT '{}',

  -- Aggregate counts
  qualified_count                       INTEGER      NOT NULL DEFAULT 0,
  eligible_count                        INTEGER      NOT NULL DEFAULT 0,
  blocked_count                         INTEGER      NOT NULL DEFAULT 0,
  enrolled_count                        INTEGER      NOT NULL DEFAULT 0,
  uploaded_count                        INTEGER      NOT NULL DEFAULT 0,
  backfilled_count                      INTEGER      NOT NULL DEFAULT 0,
  smtp_healthy_inbox_count              INTEGER      NOT NULL DEFAULT 0,

  -- Per-contact detail as JSONB — ContactReadinessResult[] with no email addresses
  contact_results                       JSONB        NOT NULL DEFAULT '[]',

  evaluated_at                          TIMESTAMPTZ  NOT NULL,
  created_at                            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- Composite FK: (client_id, campaign_id) must exist in campaigns(client_id, id).
  -- Relies on campaigns_client_id_uq UNIQUE(client_id, id) added in migration 0014.
  -- ON DELETE CASCADE: deleting a campaign removes all its assessments.
  -- Cascade is blocked at assessment deletion if an approval exists
  -- (assessment_id ON DELETE RESTRICT on approvals table).
  CONSTRAINT campaign_readiness_assessments_client_campaign_fk
    FOREIGN KEY (client_id, campaign_id)
    REFERENCES public.campaigns(client_id, id)
    ON DELETE CASCADE,

  -- One row per (client, campaign, evaluation timestamp)
  CONSTRAINT campaign_readiness_assessments_client_campaign_evaluated_at_key
    UNIQUE (client_id, campaign_id, evaluated_at)
);

-- Fast lookup of latest assessment for a campaign
CREATE INDEX IF NOT EXISTS campaign_readiness_assessments_client_campaign_idx
  ON public.campaign_readiness_assessments (client_id, campaign_id, evaluated_at DESC);

-- RLS enabled — zero policies — access via service_role only
ALTER TABLE public.campaign_readiness_assessments ENABLE ROW LEVEL SECURITY;


-- ── campaign_readiness_approvals ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.campaign_readiness_approvals (
  id                            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Binds approval to a specific assessment (immutable binding).
  -- ON DELETE RESTRICT: an assessment cannot be deleted while an approval exists.
  -- Preserves the audit trail — remove the approval explicitly before deleting
  -- the campaign or assessment.
  assessment_id                 UUID         NOT NULL
    REFERENCES public.campaign_readiness_assessments(id) ON DELETE RESTRICT,

  -- Tenant isolation (CASCADE: deleting a client removes all their approvals)
  client_id                     UUID         NOT NULL
    REFERENCES public.clients(id) ON DELETE CASCADE,

  -- Who approved and when
  approved_by                   TEXT         NOT NULL,
  approved_at                   TIMESTAMPTZ  NOT NULL,

  -- Which warnings the approver explicitly acknowledged
  acknowledged_warning_codes    TEXT[]       NOT NULL DEFAULT '{}',

  -- Optional approver note — must not contain email addresses or credentials
  notes                         TEXT         NULL,

  -- Staleness fields — the ONLY mutable columns in this table.
  -- Updated exclusively by the activation orchestrator when critical state
  -- has changed since approval was granted (e.g. contacts re-suppressed,
  -- email verifications expired, campaign status changed).
  is_stale                      BOOLEAN      NOT NULL DEFAULT FALSE,
  stale_reason                  TEXT         NULL,
  stale_set_at                  TIMESTAMPTZ  NULL,

  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- One approval per assessment
  CONSTRAINT campaign_readiness_approvals_assessment_id_key UNIQUE (assessment_id)
);

-- Active approvals for a client — supports monitoring and audit queries
CREATE INDEX IF NOT EXISTS campaign_readiness_approvals_client_active_idx
  ON public.campaign_readiness_approvals (client_id, approved_at DESC)
  WHERE is_stale = FALSE;

-- RLS enabled — zero policies — access via service_role only
ALTER TABLE public.campaign_readiness_approvals ENABLE ROW LEVEL SECURITY;
