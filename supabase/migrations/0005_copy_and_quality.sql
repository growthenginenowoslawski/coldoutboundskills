-- 0005_copy_and_quality.sql
--
-- Tables for the two remaining cold-email-kickoff skill stages:
--   email_sequences       → /campaign-copywriting (parent: one sequence per campaign)
--   email_sequence_steps  → /campaign-copywriting (child: one row per email step, e.g. Day 0 / Day 3 / Day 7 / Day 11)
--   list_quality_scores   → /list-quality-scorecard (one scorecard run per list)
--
-- All tables key to clients.id so they work for ANY client.
-- ADDITIVE ONLY — no existing tables are touched.

-- ─────────────────────────────────────────────────────────────────────────────
-- email_sequences: one row per written campaign sequence per client
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.email_sequences (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid        not null references public.clients(id) on delete cascade,
  campaign_strategy_id  uuid        references public.campaign_strategies(id) on delete set null,
  name                  text        not null,              -- e.g. "Creative Use Case — Gramscode"
  campaign_angle        text,                              -- 1-2 sentence summary of approach
  target_audience       text,
  core_pain_point       text,
  value_proposition     text,
  proof_point           text,                              -- case study / metric referenced
  ai_variables          jsonb,                             -- [{name, source, example_value}]
  overall_score         int,                               -- 0-100 rubric score
  status                text        not null default 'draft',  -- draft | approved | active | archived
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists email_sequences_client_id_idx
  on public.email_sequences (client_id);

alter table public.email_sequences enable row level security;
grant select, insert, update, delete on public.email_sequences to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- email_sequence_steps: one row per email in the sequence (Day 0 / 3 / 7 / 11)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.email_sequence_steps (
  id                uuid primary key default gen_random_uuid(),
  sequence_id       uuid        not null references public.email_sequences(id) on delete cascade,
  step              int         not null,   -- 1=Day 0, 2=Day 3, 3=Day 7, 4=Day 11
  delay_days        int         not null,   -- 0 / 3 / 7 / 11
  is_new_thread     boolean     not null default false,
  strategy_type     text,                   -- problem_sniffing | billboard | ai_generic | creative_ideas | redirect | value_bomb
  value_prop_angle  text,                   -- save_time | make_money | save_money | value_bomb
  subject_options   text[],                 -- 2-3 subject line variants
  variants          jsonb       not null,   -- [{label: "A", subject: "", body: ""}]
  created_at        timestamptz not null default now(),
  unique (sequence_id, step)
);

create index if not exists email_sequence_steps_sequence_id_idx
  on public.email_sequence_steps (sequence_id);

alter table public.email_sequence_steps enable row level security;
grant select, insert, update, delete on public.email_sequence_steps to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- list_quality_scores: one scorecard run per list
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.list_quality_scores (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 uuid        not null references public.clients(id) on delete cascade,
  list_id                   uuid        references public.lists(id) on delete set null,
  list_name                 text,                  -- display name / file name scored
  total_rows                int,
  grade                     text,                  -- A+ | A | B | C | D | F
  overall_score             int,                   -- 0-100 weighted average
  email_verification_score  int,                   -- dimension 1
  duplicate_email_score     int,                   -- dimension 2
  duplicate_domain_score    int,                   -- dimension 3
  title_relevance_score     int,                   -- dimension 4
  bad_title_score           int,                   -- dimension 5
  catchall_density_score    int,                   -- dimension 6
  icp_fit_score             int,                   -- dimension 7
  name_quality_score        int,                   -- dimension 8
  top_issues                text[],                -- top 5 issues found
  pre_send_checklist        jsonb,                 -- [{item, checked}]
  scored_at                 timestamptz not null default now(),
  created_at                timestamptz not null default now()
);

create index if not exists list_quality_scores_client_id_idx
  on public.list_quality_scores (client_id);

create index if not exists list_quality_scores_list_id_idx
  on public.list_quality_scores (list_id);

alter table public.list_quality_scores enable row level security;
grant select, insert, update, delete on public.list_quality_scores to service_role;
