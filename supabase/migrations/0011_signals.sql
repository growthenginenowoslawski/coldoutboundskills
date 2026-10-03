-- 0011_signals.sql
--
-- Stage 10: GTM Signal Engine — signals table
--
-- A signal is a normalized, scored, timestamped business event that indicates
-- buying intent, timing opportunity, or ICP-relevance for a target account.
--
-- Signals are:
--   - Scoped to (client_id, company_id) — full tenant isolation
--   - Deduplicated via dedup_key (unique per client_id)
--   - Independently timestamped: occurred_at (when it happened),
--     detected_at (when we found it), expires_at (when it goes stale)
--   - Deterministically scored at ingestion — no AI required at this layer
--   - Designed to feed into the qualification + personalization pipeline
--
-- Dedup key tiers (computed in TypeScript, stored here):
--   Tier 1: hash("pid:" + source + ":" + providerEventId) — when provider ID available
--   Tier 2: hash("fp:" + companyId + ":" + type + ":" + source + ":" + contentHash) — content fingerprint
--   Tier 3: null — no dedup enforced (empty evidence + no provider ID)
--
-- ADDITIVE ONLY — no existing tables, columns, or indexes are removed.

create table if not exists public.signals (
  id                  uuid           primary key default gen_random_uuid(),
  client_id           uuid           not null
                                     references public.clients(id)   on delete cascade,
  company_id          uuid           not null
                                     references public.companies(id) on delete cascade,
  signal_type         text           not null,
  signal_source       text           not null,
  signal_title        text           not null,
  signal_description  text,
  evidence            jsonb,
  signal_strength     integer        not null check (signal_strength between 0 and 100),
  confidence          numeric(4, 3)  not null check (confidence between 0.000 and 1.000),
  occurred_at         timestamptz    not null,
  detected_at         timestamptz    not null default now(),
  expires_at          timestamptz    not null,
  source_url          text,
  status              text           not null default 'active'
                                     check (status in ('active', 'expired', 'dismissed')),
  metadata            jsonb,
  dedup_key           text,
  created_at          timestamptz    not null default now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary tenant-scoped lookup: "all signals for client X about company Y"
create index if not exists signals_client_company_idx
  on public.signals (client_id, company_id);

-- Signal type filtering within a company
create index if not exists signals_company_type_idx
  on public.signals (company_id, signal_type);

-- Freshness / expiry sweeps: "find all active signals expiring before T"
create index if not exists signals_status_expires_idx
  on public.signals (status, expires_at);

-- Deduplication: one (client_id, dedup_key) pair per unique event per client.
-- The WHERE clause leaves null dedup_keys out of uniqueness enforcement:
-- events with no fingerprint accept duplicates rather than risk false merges.
create unique index if not exists signals_client_dedup_idx
  on public.signals (client_id, dedup_key)
  where dedup_key is not null;

-- Time-based reporting: "signals detected / occurred in the last N days"
create index if not exists signals_occurred_at_idx
  on public.signals (occurred_at);

-- ── Column comments ───────────────────────────────────────────────────────────

comment on table public.signals
  is 'GTM Signal Engine — normalized, scored buying signals for target accounts. '
     'Each row is one event for one company for one client. '
     'Signals are deterministically scored; AI reasoning is a downstream step.';

comment on column public.signals.signal_type
  is 'Canonical event category: executive_hire | funding_round | job_posting | '
     'news_mention | website_change | product_launch | partnership | '
     'technology_change | competitor_mention | award | expansion | test.';

comment on column public.signals.signal_source
  is 'Provider that surfaced this signal: linkedin | crunchbase | builtwith | '
     'news | test | etc. Provider-agnostic; new sources plug in without schema changes.';

comment on column public.signals.evidence
  is 'Raw event payload from the provider — kept for audit and downstream AI reasoning. '
     'Schema varies by source; treated as opaque JSONB by the engine.';

comment on column public.signals.signal_strength
  is '0-100 base strength for this signal type, not freshness-adjusted. '
     'Combine with freshness score (computed at query time) for actionability ranking.';

comment on column public.signals.confidence
  is '0.0-1.0. How certain we are the event is real and correctly categorised. '
     '0.8 for provider-ID-backed events; 0.6 for content-fingerprint events; '
     '0.5 when neither is available.';

comment on column public.signals.occurred_at
  is 'When the underlying business event happened (not when we detected it). '
     'Primary timestamp for freshness and "why now" calculations.';

comment on column public.signals.detected_at
  is 'When this system ingested the signal. May be later than occurred_at '
     'due to polling intervals or delayed sourcing.';

comment on column public.signals.expires_at
  is 'When this signal becomes stale. Computed as occurred_at + TTL(signal_type). '
     'TTL is type-specific: executive_hire=30d, funding_round=90d, job_posting=14d, etc.';

comment on column public.signals.status
  is '"active" = valid and actionable. '
     '"expired" = past expires_at, auto-set by sweep. '
     '"dismissed" = manually suppressed.';

comment on column public.signals.dedup_key
  is 'Deterministic fingerprint preventing exact duplicate inserts. '
     'Tier 1: hash("pid:" + source + ":" + providerEventId) when provider ID available. '
     'Tier 2: hash("fp:" + companyId + ":" + type + ":" + source + ":" + contentHash). '
     'Null when no fingerprint possible — no dedup enforced for these rows. '
     'Unique per (client_id, dedup_key) via partial index signals_client_dedup_idx.';
