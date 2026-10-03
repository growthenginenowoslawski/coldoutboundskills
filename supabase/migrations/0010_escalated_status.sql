-- 0010_escalated_status.sql
--
-- Adds "escalated" to the enrichment_runs status check constraint.
--
-- Why: When storeEscalationResult writes multi-tier escalation chains
-- (low → medium → high), intermediate attempts are marked status="escalated"
-- to signal they completed but triggered a higher-tier re-run.  The original
-- constraint only included: pending, running, completed, failed.
--
-- This migration drops the old constraint and recreates it with "escalated"
-- included, making the escalation chain writes valid at the DB layer.

alter table public.enrichment_runs
  drop constraint if exists enrichment_runs_status_check;

alter table public.enrichment_runs
  add constraint enrichment_runs_status_check
    check (status in ('pending', 'running', 'completed', 'failed', 'escalated'));
