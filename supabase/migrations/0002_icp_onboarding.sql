-- 0002_icp_onboarding.sql
--
-- ICP onboarding, segmented per company.
--   clients          : one row per company (the list you see + click)
--   icp_onboarding   : the 12 Q&A rows, linked to a client via client_id (FK)
-- Clicking a company in `clients` shows its onboarding rows as related records
-- (Supabase Table Editor follows the foreign key). ADDITIVE ONLY — two NEW
-- tables; nothing existing is touched. Apply once via Supabase SQL Editor or
-- the Cursor Supabase MCP.

-- Supersede the earlier single-table version of this table (it keyed rows by a
-- `business_slug` text column instead of a client FK, and held only seeded
-- questions — no answers). Safe to drop and recreate with the correct shape.
drop table if exists public.icp_onboarding;

-- Parent: the companies you're onboarding (the clickable list).
create table if not exists public.clients (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null,
  website    text,
  slug       text        not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.clients enable row level security;
grant select, insert, update, delete on public.clients to service_role;

-- Child: onboarding Q&A, one set per client. Deleting a client removes its rows.
create table if not exists public.icp_onboarding (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid        not null references public.clients(id) on delete cascade,
  position     int         not null,
  question_key text        not null,
  question     text        not null,
  answer       text,
  answered_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (client_id, question_key)   -- upsert answers by (client, question)
);
create index if not exists icp_onboarding_client_id_idx
  on public.icp_onboarding (client_id);
alter table public.icp_onboarding enable row level security;
grant select, insert, update, delete on public.icp_onboarding to service_role;

-- Seed the Gramscode client...
insert into public.clients (name, website, slug)
values ('Gramscode', 'https://gramscode.com', 'gramscode')
on conflict (slug) do nothing;

-- ...and its 12 onboarding questions, linked by FK (idempotent).
insert into public.icp_onboarding (client_id, position, question_key, question)
select c.id, q.position, q.question_key, q.question
from public.clients c
cross join (values
  (1,  'what_you_sell',      'What do you sell, in one sentence?'),
  (2,  'best_customer',      'Who is your single best customer — name a real one (or your last 3 by fit/revenue)?'),
  (3,  'buying_title',       'What job title actually buys this? (include synonyms)'),
  (4,  'headcount_range',    'Target company headcount — hard minimum and maximum (actual numbers)?'),
  (5,  'industries_in_out',  'Which industries are IN, and which are explicitly OUT?'),
  (6,  'geography',          'Geography — which countries, and any specific states/regions?'),
  (7,  'triggers',           'Any buying triggers worth personalizing on (fundraise, new hires, tech installed, launches)?'),
  (8,  'disqualifiers',      'Any disqualifiers/domains to exclude (competitors, existing customers, partners)?'),
  (9,  'offer_cta',          'Your offer / primary CTA — what exactly are you asking the lead to do?'),
  (10, 'lead_magnet',        'Lead magnet — what can you give away for free as the hook?'),
  (11, 'tone',               'Tone — casual or formal? peer-to-peer or vendor-to-buyer?'),
  (12, 'banned_words_legal', 'Any banned words or legal/compliance constraints on the messaging?')
) as q(position, question_key, question)
where c.slug = 'gramscode'
on conflict (client_id, question_key) do nothing;
