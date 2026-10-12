-- 0006_workflow_gaps.sql
--
-- Fills the gaps between our existing tables and the Campaign Creation Workflow (PDF):
--
--   1. ALTER email_sequences      → add value_prop_type (which of the 4 value prop types is being tested)
--   2. ALTER email_sequence_steps → add script_framework, has_personalization, spintax_body
--   3. ALTER lists                → add clay_imported_at (Step 2b.i — import to Clay)
--   4. CREATE campaign_reviews    → Step 4 (share scripts + list, client feedback, revisions, green light)
--
-- Providers already covered by existing tables:
--   Millionverifier  → email_verifications (provider='millionverifier')
--   Enirchley        → email_verifications (provider='enirchley')
--   Clay enrichment  → enrichment_runs    (provider='clay')
--   AI lead scoring  → enrichment_runs    (operation='ai_qualification')
-- ADDITIVE ONLY — no existing columns or tables are removed.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. email_sequences: tag which value prop type this sequence is testing
--    (matches PDF Step 1a: frontend offer / lead magnet / free work / unique insights)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.email_sequences
  add column if not exists value_prop_type text;
-- allowed values: frontend_offer | lead_magnet | free_work | unique_insights

comment on column public.email_sequences.value_prop_type
  is 'Which value prop type this sequence tests (PDF Step 1a): frontend_offer | lead_magnet | free_work | unique_insights';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. email_sequence_steps: track script framework, personalization flag, spintax
--    (matches PDF Step 1b and 1c)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.email_sequence_steps
  add column if not exists script_framework     text,
  add column if not exists has_personalization  boolean not null default false,
  add column if not exists spintax_body         text;
-- script_framework: case_study | pain_point | short_form | long_form | personalized | static
-- has_personalization: true = uses {{ai_variables}}, false = static copy
-- spintax_body: the {spintax|formatted} version of the email body, ready for PlusVibe

comment on column public.email_sequence_steps.script_framework
  is 'PDF Step 1b: case_study | pain_point | short_form | long_form | personalized | static';
comment on column public.email_sequence_steps.spintax_body
  is 'PDF Step 1c: spintax-formatted version of the body, added after script is finalised';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. lists: record when the list was imported to Clay for enrichment
--    (matches PDF Step 2b.i — Import list to Clay)
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.lists
  add column if not exists clay_imported_at  timestamptz,
  add column if not exists clay_table_url    text,
  add column if not exists enrichment_status text not null default 'pending';
-- enrichment_status: pending | clay_imported | enriched | verified | ready

comment on column public.lists.clay_imported_at
  is 'PDF Step 2b.i: timestamp when the list was imported to Clay for multi-provider enrichment';
comment on column public.lists.enrichment_status
  is 'Pipeline stage: pending → clay_imported → enriched → verified → ready';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. campaign_reviews: Step 4 — send campaign for review, collect feedback, get green light
--    (matches PDF Step 4: notify client → share scripts → share list → adjustments → green light)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.campaign_reviews (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid        not null references public.clients(id) on delete cascade,
  campaign_id         uuid        references public.campaigns(id) on delete set null,
  sequence_id         uuid        references public.email_sequences(id) on delete set null,

  -- Step 4a: notify client
  scripts_shared_at   timestamptz,          -- when scripts were sent to client for review
  list_shared_at      timestamptz,          -- when list was sent to client for review
  scripts_share_url   text,                 -- link to shared scripts (Google Doc, Notion, etc.)
  list_share_url      text,                 -- link to shared list (Google Sheet, etc.)

  -- Step 4b: adjustments
  client_feedback     text,                 -- raw feedback from client
  revision_notes      text,                 -- what was changed in response to feedback
  revision_count      int not null default 0,

  -- Step 4c: green light
  approved_by         text,                 -- name of client contact who approved
  approved_at         timestamptz,          -- when green light was given

  status              text not null default 'pending_review',
  -- pending_review | scripts_shared | list_shared | feedback_received | revisions_made | approved

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists campaign_reviews_client_id_idx
  on public.campaign_reviews (client_id);

create index if not exists campaign_reviews_campaign_id_idx
  on public.campaign_reviews (campaign_id);

alter table public.campaign_reviews enable row level security;
grant select, insert, update, delete on public.campaign_reviews to service_role;
