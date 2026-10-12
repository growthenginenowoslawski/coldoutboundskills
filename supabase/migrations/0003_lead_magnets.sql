-- 0003_lead_magnets.sql
--
-- Lead magnet brainstorm results, segmented per client.
--   lead_magnets : one row per brainstormed magnet idea per client.
--                  archetype_key maps to the A-J archetypes in /lead-magnet-brainstorm.
--                  status: draft | selected | rejected
--                  rank: 1-3 for top picks (null = not in top picks)
-- ADDITIVE — does not touch any existing tables.

create table if not exists public.lead_magnets (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid        not null references public.clients(id) on delete cascade,
  archetype_key  text        not null,  -- free_audit | data_report | competitive_intel | template | intro | quick_win_work | specific_analysis | tool_free_account | working_session | benchmark
  name           text        not null,
  description    text,
  delivery_notes text,                  -- what you need to actually deliver this
  cta_example    text,                  -- example CTA line for the cold email
  score          int,                   -- rubric total out of 20
  rank           int,                   -- 1=top pick, 2=second, 3=third; null = not in top picks
  status         text        not null default 'draft',  -- draft | selected | rejected
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists lead_magnets_client_id_idx
  on public.lead_magnets (client_id);

alter table public.lead_magnets enable row level security;
grant select, insert, update, delete on public.lead_magnets to service_role;
