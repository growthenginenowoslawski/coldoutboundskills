-- 0004_campaign_stages.sql
--
-- Tables for every remaining stage of the cold-email-kickoff flow.
-- All tables key to `clients.id` so they work for ANY client, not just Gramscode.
--
-- Stages covered:
--   campaign_strategies  → /campaign-strategy output (15-25+ ideas per client)
--   campaign_plans       → /cold-email-kickoff synthesis (the one-page summary per client)
--
-- Existing stages already have tables:
--   clients + icp_onboarding  (0002)
--   lead_magnets              (0003)
-- ADDITIVE ONLY — no existing tables are touched.

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_strategies: one row per campaign idea per client
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.campaign_strategies (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid        not null references public.clients(id) on delete cascade,
  campaign_name      text        not null,
  targeting_level    text,                   -- Broad | Focused | Niche
  list_filters       text,                   -- additional filters beyond base ICP
  ai_strategy        text,                   -- how we personalize at scale
  value_proposition  text,                   -- core promise / angle
  campaign_overview  text,                   -- full description — enough detail for copywriter handoff
  is_no_ai           boolean     not null default false,  -- true = no-AI static campaign
  is_front_end_offer boolean     not null default false,  -- true = a front-end offer suggestion
  rank               int,                    -- 1 = top pick; null = not ranked
  status             text        not null default 'draft',  -- draft | approved | active | archived
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists campaign_strategies_client_id_idx
  on public.campaign_strategies (client_id);

alter table public.campaign_strategies enable row level security;
grant select, insert, update, delete on public.campaign_strategies to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- campaign_plans: the synthesised one-page plan per client
-- (one active plan per client at a time; prior drafts kept for history)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.campaign_plans (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid        not null references public.clients(id) on delete cascade,
  business_summary       text,               -- one-liner from icp_onboarding.what_you_sell
  icp_summary            text,               -- compiled from icp_onboarding answers
  offer_summary          text,               -- primary CTA + lead magnet
  infrastructure_status  jsonb,              -- Step 1 answers: {domains, inboxes, api_keys}
  top_campaign_names     text[],             -- display names of top 3 campaigns (denorm for quick read)
  next_steps             text,               -- branched next-steps block from Step 6
  status                 text        not null default 'draft',  -- draft | approved
  generated_at           timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists campaign_plans_client_id_idx
  on public.campaign_plans (client_id);

alter table public.campaign_plans enable row level security;
grant select, insert, update, delete on public.campaign_plans to service_role;
