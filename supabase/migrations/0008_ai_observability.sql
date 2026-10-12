-- 0008_ai_observability.sql
--
-- Stage 5: AI observability fields for enrichment_runs.
--
-- Every AI execution is now measurable so we can understand real cost,
-- performance, failures, and escalation behaviour across 100k+ jobs and
-- multiple clients.
--
-- New columns:
--   gateway              — AI gateway used ("anthropic-direct" | "openrouter")
--   task_type            — routing task type ("icp_qualification" | "personalization" | …)
--   latency_ms           — wall-clock milliseconds from start to completion
--   cost_usd             — estimated cost in USD (tokens × model price, or null)
--   error_message        — failure reason for non-completed runs (null on success)
--   cache_hit            — reserved for future caching layer; always null for now
--   escalated_from_run_id — FK to the cheaper attempt this run escalated from;
--                           null on first attempt or standalone (non-escalating) runs
--
-- Existing columns that cover the remaining required fields:
--   provider             — model string (e.g. "claude-opus-4-8")
--   input_tokens         — prompt tokens (from 0007)
--   output_tokens        — completion tokens (from 0007)
--   client_id            — tenant FK for per-client cost rollup (from 0007)
--   status               — "completed" | "failed" | …
--
-- ADDITIVE ONLY — no existing columns, tables, or indexes are removed.

alter table public.enrichment_runs
  add column if not exists gateway                text,
  add column if not exists task_type              text,
  add column if not exists latency_ms             integer,
  add column if not exists cost_usd               numeric(14, 8),
  add column if not exists error_message          text,
  add column if not exists cache_hit              boolean,
  add column if not exists escalated_from_run_id  uuid
    references public.enrichment_runs(id) on delete set null;

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- Chosen for the most common cost/performance reporting patterns:

-- Per-gateway breakdown (e.g. "what did OpenRouter cost this month?")
create index if not exists enrichment_runs_gateway_idx
  on public.enrichment_runs (gateway);

-- Per-task-type analysis ("average latency for icp_qualification over time")
create index if not exists enrichment_runs_task_type_idx
  on public.enrichment_runs (task_type);

-- Cross-dimension cost rollup ("cost by client AND task type")
-- Covers both (client_id) and (client_id, task_type) queries.
-- The 0007 single-column client_id index is superseded by this composite.
create index if not exists enrichment_runs_client_task_idx
  on public.enrichment_runs (client_id, task_type);

-- Escalation chain traversal ("find all runs that escalated from this run",
-- "reconstruct the full chain for a given final run")
create index if not exists enrichment_runs_escalated_from_idx
  on public.enrichment_runs (escalated_from_run_id)
  where escalated_from_run_id is not null;

-- ── Column comments ───────────────────────────────────────────────────────────

comment on column public.enrichment_runs.gateway
  is 'AI provider gateway: "anthropic-direct" (native SDK) or "openrouter" (gateway). '
     'Derived from the providerId prefix before the colon.';

comment on column public.enrichment_runs.task_type
  is 'Routing task type that determined the model tier: '
     'icp_qualification | icp_prefilter | personalization | '
     'reply_classify | text_normalize | campaign_strategy.';

comment on column public.enrichment_runs.latency_ms
  is 'Wall-clock milliseconds from the AI request start to response receipt. '
     'Null when the run errored before a response was received.';

comment on column public.enrichment_runs.cost_usd
  is 'Estimated cost in USD: input_tokens × input_price + output_tokens × output_price. '
     'Null when token counts are unavailable. Gateway markup included where applicable.';

comment on column public.enrichment_runs.error_message
  is 'Human-readable failure reason. Null for successful (status=completed) runs.';

comment on column public.enrichment_runs.cache_hit
  is 'Reserved for the caching layer (Stage 10). '
     'Null until caching is live; true/false once enabled.';

comment on column public.enrichment_runs.escalated_from_run_id
  is 'FK to the cheaper-tier attempt this run escalated from. '
     'Null when this is the first (or only) attempt. '
     'Follow the chain to reconstruct the full escalation path.';
