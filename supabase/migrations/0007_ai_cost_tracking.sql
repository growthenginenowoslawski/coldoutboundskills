-- 0007_ai_cost_tracking.sql
--
-- Adds token usage + client attribution to enrichment_runs so every AI call
-- is tracked for cost reporting and per-client budget queries.
--
--   input_tokens  — prompt tokens consumed (populated by OpenRouter response.usage)
--   output_tokens — completion tokens consumed
--   client_id     — FK to clients.id for per-client cost roll-up
--
-- Cost per call = tokens × model price. Since model is already stored in the
-- `provider` column, no separate cost_usd column is needed — it stays derivable.
-- ADDITIVE ONLY — no existing columns or tables are removed.

alter table public.enrichment_runs
  add column if not exists input_tokens   integer,
  add column if not exists output_tokens  integer,
  add column if not exists client_id      uuid references public.clients(id) on delete set null;

create index if not exists enrichment_runs_client_id_idx
  on public.enrichment_runs (client_id);

comment on column public.enrichment_runs.input_tokens
  is 'Prompt tokens consumed by this AI call (from provider usage object).';

comment on column public.enrichment_runs.output_tokens
  is 'Completion tokens consumed by this AI call (from provider usage object).';

comment on column public.enrichment_runs.client_id
  is 'Client this call was made for — enables per-client cost roll-up queries.';
