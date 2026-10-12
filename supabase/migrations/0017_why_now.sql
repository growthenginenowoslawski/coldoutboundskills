-- 0017_why_now.sql
--
-- Stage 22: Why Now Engine + Account Readiness
--
-- Adds three columns to account_intelligence:
--   why_now               JSONB       — full WhyNowAssessment (evidence + readiness + narrative)
--   is_ready              BOOLEAN     — deterministic readiness gate result (fast filtering)
--   readiness_assessed_at TIMESTAMPTZ — when the readiness was last evaluated
--
-- ── Design decisions ──────────────────────────────────────────────────────────
--
-- 1. why_now stores the complete WhyNowAssessment as a JSONB blob. The assessment
--    includes: evidence snapshot (signal summaries, corroboration factor,
--    opportunity/priority scores), readiness decision, and optionally an AI
--    narrative grounded in actual stored signal evidence.
--
--    why_now.narrative is null when:
--      - ready = false (insufficient evidence for contact discovery)
--      - skipAiNarrative=true was passed to assessWhyNow()
--      - opportunity_score < AI_NARRATIVE_MIN_OPPORTUNITY_SCORE (cost gate)
--      - AI call failed (failure is logged; deterministic assessment still stored)
--      - An existing narrative was reused from within the idempotency window
--
-- 2. is_ready is promoted to a native BOOLEAN column for fast indexed filtering.
--    Mirrors why_now->ready but avoids JSONB extraction on hot read paths.
--    The primary read pattern is: "which accounts are ready for contact discovery,
--    ranked by priority?" — covered by account_intelligence_ready_priority_idx.
--
-- 3. readiness_assessed_at records when the readiness gate was last evaluated.
--    Like prioritized_at (Stage 14), this is the calculation timestamp, NOT a
--    freshness guarantee. New signals ingested after this timestamp may change
--    the readiness decision. The Why Now task must rerun periodically.
--
-- 4. All thresholds are INITIAL_HYPOTHESIS_NOT_VALIDATED:
--      READINESS_MIN_OPPORTUNITY_SCORE       = 1  (matches Stage 17 account gate)
--      READINESS_MIN_ACTIVE_SIGNAL_COUNT     = 1
--      AI_NARRATIVE_MIN_OPPORTUNITY_SCORE    = 20
--    These are defined in src/lib/why-now.ts. Changing them requires no migration.
--
-- 5. The index is a PARTIAL index on is_ready=true. Accounts that have not been
--    assessed (is_ready IS NULL) and non-ready accounts (is_ready=false) are
--    excluded from the index — they are never queried by the "ready accounts" path.
--    NULLS LAST on priority_score ensures unscored-but-ready accounts sort last.
--
-- 6. RLS is inherited from account_intelligence (enabled, no policies defined yet).
--    See docs/supabase/25-SUPABASE-SECURITY.md.
--
-- ADDITIVE ONLY — no existing columns, indexes, constraints, or policies modified.

ALTER TABLE public.account_intelligence
  ADD COLUMN IF NOT EXISTS why_now               jsonb,
  ADD COLUMN IF NOT EXISTS is_ready              boolean,
  ADD COLUMN IF NOT EXISTS readiness_assessed_at timestamptz;

-- ── Index ─────────────────────────────────────────────────────────────────────
--
-- Primary Why Now read pattern:
--   "Which accounts are ready for contact discovery for this client,
--    ranked by priority score?"
--
-- PARTIAL on is_ready=true: excludes non-ready (false) and unassessed (null) rows,
-- keeping the index small. Clients querying ready accounts never touch other rows.
--
-- NULLS LAST on priority_score: accounts that are ready but not yet prioritised
-- (priority_score IS NULL — Stage 14 not yet run) sort after scored accounts.

CREATE INDEX IF NOT EXISTS account_intelligence_ready_priority_idx
  ON public.account_intelligence (client_id, priority_score DESC NULLS LAST)
  WHERE is_ready = true;

-- ── Column comments ───────────────────────────────────────────────────────────

COMMENT ON COLUMN public.account_intelligence.why_now IS
  'Full WhyNowAssessment JSONB — evidence snapshot, readiness decision, and AI narrative. '
  'Null until the first Stage 22 Why Now run touches this row. '
  'Contains: ready (bool), readinessReason (string), evidence (signal summaries, '
  'opportunityScore, priorityScore, corroborationFactor), narrative (AI why now text, '
  'relevantSignalTitles, relevantSignalIds traceable to signals.id, confidence, cost). '
  'why_now->ready mirrors is_ready — both are written atomically by setWhyNow(). '
  'hypothesis is always "INITIAL_HYPOTHESIS_NOT_VALIDATED". '
  'AI narrative is null for non-ready accounts, when skipAiNarrative=true, '
  'or when opportunity_score < AI_NARRATIVE_MIN_OPPORTUNITY_SCORE (currently 20, '
  'INITIAL_HYPOTHESIS_NOT_VALIDATED). '
  'Populated by Stage 22 assessWhyNow() in src/lib/why-now.ts.';

COMMENT ON COLUMN public.account_intelligence.is_ready IS
  'True when the account passes the deterministic readiness gate. '
  'Gate conditions (all INITIAL_HYPOTHESIS_NOT_VALIDATED): '
  '  opportunity_score >= READINESS_MIN_OPPORTUNITY_SCORE (currently 1) '
  '  AND active_signal_count >= READINESS_MIN_ACTIVE_SIGNAL_COUNT (currently 1). '
  'Null when the account has not yet been assessed by Stage 22. '
  'False when assessed but evidence is insufficient. '
  'True when evidence passes readiness thresholds. '
  'Indexed by account_intelligence_ready_priority_idx for fast filtering. '
  'Mirrors why_now->ready — always written together with why_now.';

COMMENT ON COLUMN public.account_intelligence.readiness_assessed_at IS
  'When the readiness gate was last evaluated. '
  'NOT a freshness guarantee — new signals ingested after this timestamp may '
  'change the readiness decision. The scheduled Why Now task must rerun periodically. '
  'Null when is_ready is null (account not yet assessed by Stage 22). '
  'Written atomically with is_ready and why_now by setWhyNow().';
