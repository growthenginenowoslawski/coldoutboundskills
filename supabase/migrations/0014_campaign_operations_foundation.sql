-- 0014_campaign_operations_foundation.sql
--
-- Stage 15: Campaign Operations — Data Foundation
--
-- ── WHAT THIS MIGRATION DOES ──────────────────────────────────────────────────
--
-- 1. campaigns — adds three columns:
--      client_id              uuid NOT NULL FK → clients(id)  (tenant isolation)
--      campaign_strategy_id   uuid nullable   FK → campaign_strategies(id)  (intelligence link)
--      list_id                uuid nullable   FK → lists(id)  (lead pool link)
--
-- 2. campaigns — adds UNIQUE(client_id, id) so campaign_leads can reference it
--      with a composite foreign key that enforces client consistency.
--
-- 3. campaigns — adds a BEFORE INSERT/UPDATE trigger that verifies
--      campaign_strategy_id (when non-null) belongs to the same client.
--      A composite FK cannot be used here because ON DELETE SET NULL on a
--      composite FK would null BOTH columns — including client_id, which must
--      remain NOT NULL. A trigger is the correct database-level solution.
--
-- 4. campaign_leads — adds client_id uuid NOT NULL FK → clients(id).
--
-- 5. campaign_leads — adds composite FK (client_id, campaign_id) →
--      campaigns(client_id, id) that prevents campaign_leads.client_id from
--      disagreeing with its campaign's client_id at the database level.
--      The existing simple FK campaign_id → campaigns(id) is preserved.
--
-- 6. contact_suppression — new table. Per-client safety gate. A contact is
--      suppressed when: expires_at IS NULL (permanent) OR expires_at > now().
--      Expired records are historical and do NOT block eligibility.
--      RLS enabled; no policies yet (service_role bypasses RLS; policies
--      added when auth/tenant mapping is finalised — see 25-SUPABASE-SECURITY.md).
--
-- ── SAFETY ───────────────────────────────────────────────────────────────────
--
-- campaigns:      0 rows at time of writing — NOT NULL without DEFAULT is safe.
-- campaign_leads: 0 rows at time of writing — NOT NULL and new FK are safe.
-- ADDITIVE ONLY:  no existing columns, constraints, or indexes are removed.
-- IF NOT EXISTS:  ADD COLUMN and CREATE INDEX are idempotent.
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER makes the trigger idempotent.
-- CREATE OR REPLACE FUNCTION makes the trigger function idempotent.
--
-- ── DESIGN DECISIONS ─────────────────────────────────────────────────────────
--
-- campaign_strategy_id cross-client enforcement (trigger, not composite FK):
--   PostgreSQL ON DELETE SET NULL on a composite FK sets ALL referenced columns
--   to NULL. We cannot null client_id. A BEFORE trigger fires for all connections
--   including direct psql (bypasses application code) — true DB-level enforcement.
--
-- campaign_leads composite FK UNIQUE(client_id, id) on campaigns:
--   id is already the PK (unique), so (client_id, id) is logically redundant.
--   PostgreSQL requires an explicit UNIQUE constraint on the referenced columns
--   for a composite FK. The constraint also documents the compound identity.
--
-- contact_suppression partial unique index (WHERE expires_at IS NULL):
--   "Active" is temporal (expires_at > now()); a static unique index cannot
--   express it. The partial index prevents duplicate PERMANENT suppressions.
--   Timed suppression deduplication is the application's responsibility.
--
-- contact_suppression scope (client-scoped, not global):
--   Different clients have independent suppression states. A future global
--   do-not-contact mechanism will be a SEPARATE table checked before this one.
--   No schema change is needed for that future extension.
--
-- lists is intentionally left WITHOUT client_id:
--   Lists are shared infrastructure (global). The campaign → list link is a
--   read reference; client ownership lives on campaigns, not lists.

-- =============================================================================
-- SECTION 1: campaigns — new columns
-- =============================================================================

alter table public.campaigns
  add column if not exists client_id            uuid not null
    references public.clients(id) on delete cascade,
  add column if not exists campaign_strategy_id uuid
    references public.campaign_strategies(id) on delete set null,
  add column if not exists list_id              uuid
    references public.lists(id) on delete set null;

-- =============================================================================
-- SECTION 2: campaigns — composite unique (enables composite FK from campaign_leads)
-- =============================================================================

-- UNIQUE(client_id, id) is logically satisfied by the existing PK on id, but
-- PostgreSQL requires an explicit constraint for composite FK references.
-- DO block makes this idempotent — ADD CONSTRAINT has no IF NOT EXISTS syntax.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'campaigns_client_id_uq'
       and conrelid = 'public.campaigns'::regclass
  ) then
    alter table public.campaigns add constraint campaigns_client_id_uq unique (client_id, id);
  end if;
end;
$$;

-- =============================================================================
-- SECTION 3: campaigns — indexes
-- =============================================================================

-- Primary Campaign Operations read pattern: "active campaigns for this client."
create index if not exists campaigns_client_status_idx
  on public.campaigns (client_id, status);

-- Reverse lookup: "which campaign is running this strategy?"
create index if not exists campaigns_strategy_idx
  on public.campaigns (campaign_strategy_id)
  where campaign_strategy_id is not null;

-- Reverse lookup: "which campaign draws from this list?"
create index if not exists campaigns_list_idx
  on public.campaigns (list_id)
  where list_id is not null;

-- =============================================================================
-- SECTION 4: campaigns — cross-client strategy trigger
-- =============================================================================

create or replace function public.check_campaign_strategy_client()
returns trigger
language plpgsql
as $$
begin
  if new.campaign_strategy_id is not null then
    if not exists (
      select 1
        from public.campaign_strategies
       where id        = new.campaign_strategy_id
         and client_id = new.client_id
    ) then
      raise exception
        'campaign_strategy_id % does not belong to client_id % — '
        'cross-client strategy assignment is not permitted',
        new.campaign_strategy_id, new.client_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists campaigns_strategy_client_check on public.campaigns;
create trigger campaigns_strategy_client_check
  before insert or update on public.campaigns
  for each row execute function public.check_campaign_strategy_client();

comment on function public.check_campaign_strategy_client() is
  'Enforces that campaign_strategy_id belongs to the same client as the campaign. '
  'Fires BEFORE INSERT OR UPDATE on campaigns. '
  'Returns NEW unchanged when campaign_strategy_id IS NULL (strategy not linked yet). '
  'Raises an exception when the strategy belongs to a different client.';

-- =============================================================================
-- SECTION 5: campaign_leads — client_id column
-- =============================================================================

alter table public.campaign_leads
  add column if not exists client_id uuid not null
    references public.clients(id) on delete cascade;

-- =============================================================================
-- SECTION 6: campaign_leads — composite FK enforcing client consistency
-- =============================================================================

-- WHAT: Prevents campaign_leads.client_id from disagreeing with
--   campaigns.client_id for the same campaign_id.
-- HOW:  (client_id, campaign_id) must match a row in campaigns(client_id, id).
--   If campaign X belongs to client A, inserting a lead with client_id = B
--   fails even though campaign_id = X is a valid campaigns.id.
-- COEXISTENCE: The existing FK campaign_id → campaigns(id) ON DELETE CASCADE
--   remains active. Both FKs fire on INSERT. On campaign DELETE, both cascade
--   to the same campaign_leads rows — PostgreSQL handles this correctly.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'campaign_leads_client_campaign_fk'
       and conrelid = 'public.campaign_leads'::regclass
  ) then
    alter table public.campaign_leads
      add constraint campaign_leads_client_campaign_fk
        foreign key (client_id, campaign_id)
        references public.campaigns(client_id, id)
        on delete cascade;
  end if;
end;
$$;

-- =============================================================================
-- SECTION 7: campaign_leads — indexes
-- =============================================================================

-- "How many leads are enrolled / active for this client?" — lead supply monitor.
create index if not exists campaign_leads_client_status_idx
  on public.campaign_leads (client_id, status);

-- "All leads for a specific campaign under this client."
create index if not exists campaign_leads_client_campaign_idx
  on public.campaign_leads (client_id, campaign_id);

-- =============================================================================
-- SECTION 8: contact_suppression — new table
-- =============================================================================

create table if not exists public.contact_suppression (
  id                 uuid        primary key default gen_random_uuid(),

  -- Tenant scope. Every suppression belongs to exactly one client.
  -- Different clients maintain independent suppression lists for the same contact.
  client_id          uuid        not null references public.clients(id)   on delete cascade,

  -- The contact being suppressed. Global entity — no client_id on contacts.
  -- The suppression is what makes the contact off-limits for THIS client.
  contact_id         uuid        not null references public.contacts(id)  on delete cascade,

  -- Why this contact is suppressed.
  -- unsubscribed   — contact explicitly opted out of emails from this client.
  -- negative_reply — contact replied asking to be removed.
  -- hard_bounce    — email address is permanently undeliverable.
  -- do_not_contact — legal or compliance hold (e.g. GDPR erasure request).
  -- manual         — operator-added suppression (no automated trigger).
  reason             text        not null,

  -- Who or what created this suppression. Free text — system component name,
  -- operator identifier, or external source. Nullable; set by the caller.
  suppressed_by      text,

  -- Which campaign triggered this suppression, if applicable.
  -- Null when suppression was created outside a campaign context.
  -- Set null on campaign deletion to preserve the suppression record.
  source_campaign_id uuid        references public.campaigns(id) on delete set null,

  -- Active suppression semantics:
  --   null       → permanent suppression (no expiry, always blocks eligibility)
  --   timestamp  → suppressed until this time; after it, record is historical only
  -- Application check: expires_at IS NULL OR expires_at > now()
  expires_at         timestamptz,

  -- Optional operator note. Free text.
  notes              text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- Reason must be one of the five defined categories.
  constraint contact_suppression_reason_check
    check (reason in ('unsubscribed','negative_reply','hard_bounce','do_not_contact','manual'))
);

-- RLS: enabled. No policies defined yet.
-- service_role bypasses RLS (application uses service_role key throughout).
-- Authenticated tenant policies will be added when auth/tenant mapping is
-- finalised — see docs/supabase/25-SUPABASE-SECURITY.md.
alter table public.contact_suppression enable row level security;

-- PERMANENT SUPPRESSION UNIQUENESS:
-- At most one permanent (expires_at IS NULL) suppression per (client, contact).
-- Timed suppressions cannot be unique-constrained at DB level because "active"
-- is temporal (expires_at > now()) and changes without a write.
-- The application manages timed suppression deduplication.
create unique index if not exists contact_suppression_permanent_uq
  on public.contact_suppression (client_id, contact_id)
  where expires_at is null;

-- Fast lookup: "is this contact suppressed for this client?"
-- Used by isContactSuppressed() on every lead eligibility check.
create index if not exists contact_suppression_lookup_idx
  on public.contact_suppression (client_id, contact_id);

-- Expiry sweep: "find all suppression records whose expiry has passed."
-- Supports a future cleanup job that archives stale historical records.
create index if not exists contact_suppression_expiry_idx
  on public.contact_suppression (expires_at)
  where expires_at is not null;

comment on table public.contact_suppression is
  'Per-client contact suppression records. '
  'Active = expires_at IS NULL (permanent) OR expires_at > now() (timed, not yet expired). '
  'Expired records (expires_at <= now()) are retained as history; they do NOT block eligibility. '
  'Future global do-not-contact mechanism will be a separate table — '
  'this table is intentionally client-scoped only.';

comment on column public.contact_suppression.expires_at is
  'NULL = permanent suppression (always active). '
  'Non-null = suppressed until this timestamp; past the timestamp the record is historical only. '
  'Eligibility check: expires_at IS NULL OR expires_at > now(). '
  'Expired suppression does NOT block contact enrollment.';

comment on column public.contact_suppression.reason is
  'unsubscribed | negative_reply | hard_bounce | do_not_contact | manual. '
  'Enforced by contact_suppression_reason_check constraint.';

comment on column public.contact_suppression.client_id is
  'Tenant owner. Suppression is per-client — the same contact can be '
  'suppressed by client A but eligible for client B.';
