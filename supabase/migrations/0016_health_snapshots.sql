-- Migration 0016: Provider health snapshot tables — Stage 18.
--
-- Creates three append-only time-series tables for provider health monitoring:
--   campaign_health_snapshots  — campaign send/open/reply/bounce metrics
--   domain_health_snapshots    — domain-level inbox aggregate
--   inbox_health_snapshots     — per-inbox warmup/SMTP/IMAP state
--
-- Design decisions:
--   1. Append-only: snapshots are never updated, only inserted.
--   2. Baseline: the first snapshot per (client, entity) is marked is_baseline=true.
--      Subsequent snapshots are compared to the baseline to detect regressions.
--   3. Idempotency: UNIQUE(client_id, entity_id, taken_at) with ON CONFLICT DO NOTHING
--      in the application layer. Re-running a snapshot job within the same second = no-op.
--   4. Cascade delete: campaign snapshots cascade when their campaign is deleted.
--      Domain and inbox snapshots cascade only when their client is deleted.
--   5. RLS: all three tables have RLS enabled (consistent with all other tables).
--      No policies defined yet — service_role bypasses RLS for all queries.
--
-- PROPOSED CHANGE — NOT YET APPLIED. Requires explicit approval from the operator.

-- ── Campaign health snapshots ─────────────────────────────────────────────────
--
-- Stores send/open/reply/bounce metrics for one campaign at a point in time.
-- Composite FK (client_id, campaign_id) → campaigns(client_id, id) ensures the
-- snapshot's client always matches the campaign's client (data integrity guard).

CREATE TABLE IF NOT EXISTS public.campaign_health_snapshots (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id            UUID        NOT NULL,
  campaign_id          UUID        NOT NULL,
  -- Which outreach platform this campaign runs on (matches campaigns.platform).
  platform             TEXT        NOT NULL,
  -- Provider's own campaign ID (matches campaigns.platform_campaign_id).
  platform_campaign_id TEXT        NOT NULL,
  -- When this snapshot was taken. Second-level precision.
  taken_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- True only for the first snapshot per (client_id, campaign_id).
  is_baseline          BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Provider-reported campaign status at snapshot time.
  campaign_status      TEXT,
  -- Raw send counts.
  sent_count           INTEGER     NOT NULL DEFAULT 0,
  open_count           INTEGER     NOT NULL DEFAULT 0,
  click_count          INTEGER     NOT NULL DEFAULT 0,
  reply_count          INTEGER     NOT NULL DEFAULT 0,
  bounce_count         INTEGER     NOT NULL DEFAULT 0,
  unsubscribe_count    INTEGER     NOT NULL DEFAULT 0,
  -- Derived rates 0–100, one decimal place.
  -- NULL when sent_count = 0 (no denominator for a meaningful rate).
  open_rate_pct        NUMERIC(5,1),
  reply_rate_pct       NUMERIC(5,1),
  bounce_rate_pct      NUMERIC(5,1),
  -- Composite FK: guarantees snapshot.client_id = campaign.client_id.
  -- Cascade delete: losing a campaign loses its snapshot history.
  CONSTRAINT fk_campaign_health_campaign
    FOREIGN KEY (client_id, campaign_id)
    REFERENCES public.campaigns (client_id, id)
    ON DELETE CASCADE,
  -- Uniqueness: one snapshot per (client, campaign, second).
  CONSTRAINT uq_campaign_health_taken
    UNIQUE (client_id, campaign_id, taken_at)
);

-- Efficient lookup: all snapshots for a campaign, newest first.
CREATE INDEX idx_chs_client_campaign
  ON public.campaign_health_snapshots (client_id, campaign_id, taken_at DESC);

ALTER TABLE public.campaign_health_snapshots ENABLE ROW LEVEL SECURITY;


-- ── Domain health snapshots ───────────────────────────────────────────────────
--
-- Stores aggregate inbox health for one domain at a point in time.
-- Domain is a provider-side concept (not a DB entity), so no campaign FK.

CREATE TABLE IF NOT EXISTS public.domain_health_snapshots (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id            UUID        NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  -- Which provider manages these inboxes (smartlead, instantly, plusvibe).
  provider             TEXT        NOT NULL,
  -- Bare domain, e.g. "agency.co.uk". No protocol, no trailing slash.
  domain               TEXT        NOT NULL,
  taken_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_baseline          BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Total inboxes on this domain registered with the provider.
  inbox_count          INTEGER     NOT NULL DEFAULT 0,
  -- Inboxes where smtp_ok = true AND imap_ok = true.
  healthy_inbox_count  INTEGER     NOT NULL DEFAULT 0,
  -- Inboxes currently blocked from warmup.
  blocked_inbox_count  INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT uq_domain_health_taken
    UNIQUE (client_id, provider, domain, taken_at)
);

-- Efficient lookup: all domain snapshots for a client+provider+domain, newest first.
CREATE INDEX idx_dhs_client_domain
  ON public.domain_health_snapshots (client_id, provider, domain, taken_at DESC);

ALTER TABLE public.domain_health_snapshots ENABLE ROW LEVEL SECURITY;


-- ── Inbox health snapshots ────────────────────────────────────────────────────
--
-- Stores per-inbox warmup/SMTP/IMAP state at a point in time.
-- Inbox is a provider-side entity (not in our DB), so FK is to client only.

CREATE TABLE IF NOT EXISTS public.inbox_health_snapshots (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id            UUID        NOT NULL REFERENCES public.clients (id) ON DELETE CASCADE,
  provider             TEXT        NOT NULL,
  -- Provider's own inbox/email-account ID.
  platform_inbox_id    TEXT        NOT NULL,
  -- The sending email address. Informational — not a FK (emails are not entities in our DB).
  inbox_email          TEXT,
  taken_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_baseline          BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Warmup status: "active" | "inactive" | "paused" | "unknown".
  warmup_status        TEXT,
  -- Reputation tier: "excellent" | "good" | "fair" | "poor" | "unknown".
  warmup_reputation    TEXT,
  smtp_ok              BOOLEAN,
  imap_ok              BOOLEAN,
  is_warmup_blocked    BOOLEAN,
  daily_send_limit     INTEGER,
  daily_sent_count     INTEGER,
  -- Provider tags on this inbox (string array).
  tags                 TEXT[],
  CONSTRAINT uq_inbox_health_taken
    UNIQUE (client_id, provider, platform_inbox_id, taken_at)
);

-- Efficient lookup: all inbox snapshots for a client+provider+inbox, newest first.
CREATE INDEX idx_ihs_client_inbox
  ON public.inbox_health_snapshots (client_id, provider, platform_inbox_id, taken_at DESC);

ALTER TABLE public.inbox_health_snapshots ENABLE ROW LEVEL SECURITY;
