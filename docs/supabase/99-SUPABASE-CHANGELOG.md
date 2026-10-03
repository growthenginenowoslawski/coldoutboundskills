# Supabase Schema Changelog

This document records every schema change in chronological order — what changed, why, and what it enables. Useful for understanding the evolution of the system without reading all migration files.

---

## Migration 0001 — grant_service_role (Stage 1)

**File:** `0001_grant_service_role.sql`

**What changed:** Granted `service_role` the ability to read, insert, update, and delete on all tables. This is the one-time permissions grant that lets application code access the database.

**Why:** Supabase by default restricts the service_role key to tables it has explicit grants for. This migration ensures the service_role can access everything.

**Tables affected:** All tables (blanket grant)

---

## Migration 0002 — icp_onboarding (Stage 1)

**File:** `0002_icp_onboarding.sql`

**What changed:**
- Dropped the old `icp_onboarding` table (previous version used `business_slug` text key instead of FK)
- Created `clients` table (one row per company being served)
- Created `icp_onboarding` table (12 Q&A rows per client, linked by FK)
- Seeded Gramscode as the first client

**Why:** The old schema used text slugs to link data. The new schema uses proper UUID foreign keys, enabling proper cascade deletes and relational integrity.

**New tables:** `clients`, `icp_onboarding`

**Key design decisions:**
- `clients.slug` is unique (lookup key throughout the codebase)
- `icp_onboarding` has `UNIQUE(client_id, question_key)` — answers can be upserted
- 12 fixed onboarding questions seeded for Gramscode

---

## Migration 0003 — lead_magnets (Stage 2)

**File:** `0003_lead_magnets.sql`

**What changed:** Created `lead_magnets` table — stores brainstormed lead magnet ideas per client.

**Why:** The `/lead-magnet-brainstorm` skill needed a place to store and compare its output. Previously results were only in markdown files.

**New tables:** `lead_magnets`

**Key design decisions:**
- `archetype_key` maps to 10 fixed archetypes (free_audit, data_report, etc.)
- `rank` 1-3 marks the top picks
- `status` (draft → selected → rejected) tracks which magnet was chosen
- Only ONE selected per client (enforced by `selectLeadMagnet()` helper)

---

## Migration 0004 — campaign_stages (Stage 3)

**File:** `0004_campaign_stages.sql`

**What changed:** Created `campaign_strategies` and `campaign_plans` tables.

**Why:** After onboarding and lead magnet, the campaign strategy brainstorm and kickoff plan needed persistent storage. Previously these lived only in profiles/ markdown files.

**New tables:** `campaign_strategies`, `campaign_plans`

**Key design decisions:**
- `campaign_strategies`: 15-25 ideas per client; `rank` + `status` used for approval
- `is_no_ai` and `is_front_end_offer` flags encode campaign type classification
- `campaign_plans`: one active draft per client at a time (enforced by `upsertCampaignPlan()`)
- `infrastructure_status` jsonb stores warmup/setup progress

---

## Migration 0005 — copy_and_quality (Stage 4-5)

**File:** `0005_copy_and_quality.sql`

**What changed:** Created `email_sequences`, `email_sequence_steps`, and `list_quality_scores` tables.

**Why:** Campaign copywriting output needed storage. List quality scorecard needed storage.

**New tables:** `email_sequences`, `email_sequence_steps`, `list_quality_scores`

**Key design decisions:**
- `email_sequences` parent / `email_sequence_steps` child relationship (1:many)
- `UNIQUE(sequence_id, step)` prevents duplicate step numbers
- `variants` jsonb stores A/B email copy (label, subject, body per variant)
- `list_quality_scores`: 8 scoring dimensions + overall grade + `pre_send_checklist` jsonb

---

## Migration 0006 — workflow_gaps (Stage 4)

**File:** `0006_workflow_gaps.sql`

**What changed:**
- Added `value_prop_type` column to `email_sequences`
- Added `script_framework`, `has_personalization`, `spintax_body` columns to `email_sequence_steps`
- Added `clay_imported_at`, `clay_table_url`, `enrichment_status` columns to `lists`
- Created `campaign_reviews` table

**Why:** Gap analysis between the schema and the Campaign Creation Workflow PDF revealed missing fields. The `campaign_reviews` table was needed to track client sign-off before launch.

**New tables:** `campaign_reviews`

**New columns:**
- `email_sequences.value_prop_type` — which of the 4 value prop types is being tested
- `email_sequence_steps.script_framework` — writing framework used (case_study, pain_point, etc.)
- `email_sequence_steps.has_personalization` — whether AI variables are used in this step
- `email_sequence_steps.spintax_body` — Smartlead-ready spintax version of the body
- `lists.clay_imported_at` — timestamp of Clay import
- `lists.enrichment_status` — pipeline stage: pending → clay_imported → enriched → verified → ready

---

## Migration 0007 — ai_cost_tracking (Stage 5)

**File:** `0007_ai_cost_tracking.sql`

**What changed:** Added `input_tokens`, `output_tokens`, and `client_id` columns to `enrichment_runs`.

**Why:** Stage 5 added the pricing engine. Without token counts and client attribution, there's no way to track AI spend per client.

**New columns on `enrichment_runs`:**
- `input_tokens` — prompt token count from provider usage object
- `output_tokens` — completion token count
- `client_id` — FK to clients; enables per-client cost roll-up

---

## Migration 0008 — ai_observability (Stage 5)

**File:** `0008_ai_observability.sql`

**What changed:** Added full observability columns to `enrichment_runs` — gateway, task_type, latency, cost, errors, cache, and escalation chain FK.

**Why:** The escalation system (try cheap model first, escalate if low confidence) needed columns to record the chain of attempts. Operational monitoring needed latency and cost data.

**New columns on `enrichment_runs`:**
- `gateway` — which API gateway was used (anthropic-direct or openrouter)
- `task_type` — what type of AI work this was (icp_qualification, personalization, etc.)
- `latency_ms` — wall-clock response time
- `cost_usd` — computed dollar cost for this call
- `error_message` — failure reason (null on success)
- `cache_hit` — reserved for future caching (always null now)
- `escalated_from_run_id` — self-referential FK to the cheaper attempt this escalated from

---

## Migration 0009 — operation_identity (Stage 10)

**File:** `0009_operation_identity.sql`

**What changed:**
- Added `idempotency_key` column to `jobs`
- Added partial unique index on `jobs` for (job_type, idempotency_key)
- Added `job_id` column to `enrichment_runs` (FK to jobs)
- Added `attempt_number` column to `enrichment_runs`
- Added partial unique index on `enrichment_runs` for (company_id, job_id, task_type, attempt_number)

**Why:** Stage 10 introduced the `claimJob()` pattern — atomic find-or-create for background jobs. Without an idempotency key, concurrent Trigger.dev invocations could create duplicate jobs for the same operation.

**New columns:**
- `jobs.idempotency_key` — stable identifier for dedup
- `enrichment_runs.job_id` — links AI calls back to the background job
- `enrichment_runs.attempt_number` — 0-based index in escalation chain

---

## Migration 0010 — escalated_status (Stage 10)

**File:** `0010_escalated_status.sql`

**What changed:** Added `escalated` to the `enrichment_runs.status` check constraint.

**Why:** The escalation system needs to mark a run as `escalated` (tried but confidence too low; a more expensive model will retry). The existing constraint only allowed `pending | running | completed | failed`.

**Changed constraint on `enrichment_runs`:**
```
status IN ('pending', 'running', 'completed', 'failed', 'escalated')
```

---

## Migration 0011 — signals (Stage 10/11)

**File:** `0011_signals.sql`

**What changed:** Created the `signals` table — the core table of the GTM Signal Engine.

**Why:** Stage 10 built the signal ingestion infrastructure. Signals represent buying intent events (job postings, funding rounds, executive hires, etc.) that indicate why to contact a company now, not next quarter.

**New tables:** `signals`

**Key design decisions:**
- `(client_id, company_id)` scoping for full tenant isolation
- 3-tier dedup system via `dedup_key` column + partial unique index
- `signal_strength` (0-100) is type-based, stored at ingestion; freshness score is computed at query time
- `confidence` (0.0-1.0) reflects how certain the event categorization is
- `occurred_at` vs `detected_at` vs `expires_at` — three distinct timestamps for different purposes
- TTLs vary by signal type: job_posting=14d, funding_round=90d, executive_hire=30d
- **Note:** RLS not explicitly enabled in this migration (see 25-SUPABASE-SECURITY.md FINDING 1)

---

## Migration 0012 — account_intelligence (Stage 12)

**File:** `0012_account_intelligence.sql`

**What changed:** Created the `account_intelligence` table — the derived-intelligence layer that stores one scored row per (client, company) pair.

**Why:** Signals are raw events. `account_intelligence` is the answer to "how good is this account right now?" — a single score that summarizes all active signals for a company under a given client. Without it, every query that needed to rank accounts would have to re-aggregate all signals from scratch.

**New table:** `account_intelligence`

**Key design decisions:**
- One row per `(client_id, company_id)` — enforced by named UNIQUE constraint `account_intelligence_client_company_key`
- `opportunity_score INTEGER NOT NULL` — range 0–100; enforced by CHECK constraint
- `score_inputs JSONB` — full breakdown (signal list, weights applied) for auditability
- `opportunity_score_updated_at` — when the score was last computed (not a recency guarantee)
- Two targeted indexes: `client_id + opportunity_score DESC` for "top accounts" queries; staleness index for "accounts due for rescore"
- RLS enabled but no policies defined (blocked pending auth/tenant-mapping design — see `25-SUPABASE-SECURITY.md`)
- Both FKs (`client_id`, `company_id`) have `ON DELETE CASCADE`

---

## Migration 0013 — account_priority (Stage 14)

**File:** `0013_account_priority.sql`

**What changed:** Added two columns to `account_intelligence` and one index:
- `priority_score NUMERIC NULL` — time-decayed score answering "which accounts should we act on *today*?"
- `prioritized_at TIMESTAMPTZ NULL` — when the priority_score was last calculated
- Index `account_intelligence_priority_idx` — `(client_id, priority_score DESC NULLS LAST) WHERE priority_score IS NOT NULL`

**Why:** `opportunity_score` is time-invariant within a signal's TTL — it tells you how good a fit this account is, not how urgent it is to contact today. As signals age, their urgency decays. `priority_score` applies exponential half-life decay to `opportunity_score` so that accounts with fresh signals rank above accounts with old ones. Without this column, every "who to contact today" query would have to join against `signals.detected_at` and compute decay inline.

**Conceptual distinction:**
```
Raw signal data (signals table)
  ↓ normalizeBatch + upsertSignal + rescoreCompany
opportunity_score (account_intelligence)          ← Stage 12/13, time-invariant
  = ICP fit × signal quality
  ↓ × recency_multiplier = 2^(−days/14)
priority_score (account_intelligence)             ← Stage 14, decays daily
  = "how actionable is this account RIGHT NOW?"
```

**Key design decisions:**
- `priority_score` is NULLABLE — `NULL` means "never prioritized", not zero
- `priority_score = 0` means "prioritized, but no active signals exist"
- `prioritized_at` is the calculation timestamp, NOT a freshness guarantee
- `PRIORITY_RECENCY_HALF_LIFE_DAYS = 14` is `INITIAL_HYPOTHESIS_NOT_VALIDATED` — a named constant, not a hardcoded assumption
- Rank is never stored — it is computed at query time from `ORDER BY priority_score DESC`
- Priority score must be recomputed daily because it changes even when no new signals arrive

**New columns on `account_intelligence`:**
- `priority_score NUMERIC NULL`
- `prioritized_at TIMESTAMPTZ NULL`

---

## Migration 0014 — campaign_operations_foundation (Stage 15)

**File:** `0014_campaign_operations_foundation.sql`

**What changed:**

1. **`campaigns` — three new columns:**
   - `client_id uuid NOT NULL` FK → `clients(id)` ON DELETE CASCADE — tenant isolation, previously missing
   - `campaign_strategy_id uuid NULL` FK → `campaign_strategies(id)` ON DELETE SET NULL — intelligence layer link
   - `list_id uuid NULL` FK → `lists(id)` ON DELETE SET NULL — source contact pool

2. **`campaigns` — UNIQUE(client_id, id)** — required by PostgreSQL as the target of the composite FK from `campaign_leads`; logically redundant with the PK but necessary for composite FK syntax

3. **`campaigns` — trigger `check_campaign_strategy_client()`** BEFORE INSERT OR UPDATE — verifies that when `campaign_strategy_id` is non-null, it belongs to the same client as the campaign. Uses a trigger (not a composite FK) because `ON DELETE SET NULL` on a composite FK would null both columns — including `client_id` which must remain NOT NULL.

4. **`campaign_leads` — `client_id uuid NOT NULL`** FK → `clients(id)` ON DELETE CASCADE

5. **`campaign_leads` — composite FK `(client_id, campaign_id)` → `campaigns(client_id, id)`** ON DELETE CASCADE — prevents campaign_leads.client_id from differing from its campaign's client_id at the database level. Coexists with the existing simple FK `campaign_id → campaigns(id)`.

6. **`contact_suppression` — new table.** Per-client contact suppression records. Active when `expires_at IS NULL` (permanent) or `expires_at > now()` (timed). Expired records (`expires_at <= now()`) are historical only and do NOT block eligibility. RLS enabled; no policies defined yet; service_role bypasses RLS. Partial unique index prevents duplicate permanent suppressions per (client, contact).

**Why:** Campaigns previously had no `client_id` column — any campaign could be read without client scoping (FINDING 4 in 25-SUPABASE-SECURITY.md). Stage 15 closes this gap and adds the contact suppression safety gate needed before campaign enrollment logic is built.

**Tables affected:** `campaigns` (3 new columns + unique constraint + trigger + 3 indexes), `campaign_leads` (1 new column + 1 new FK + 2 indexes), `contact_suppression` (new table with RLS + 3 indexes)

**Migration idempotency:** All column additions use `IF NOT EXISTS`. The two named constraints use DO blocks with `pg_constraint` existence checks. Trigger uses `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`. Table creation uses `CREATE TABLE IF NOT EXISTS`. Safe to re-run.

**Key design decisions:**
- `platform` DEFAULT 'plusvibe' confirmed from live schema — do not hardcode 'smartlead'
- `campaign_leads.status` DEFAULT 'ready' confirmed from live schema — NOT 'queued' (prior documentation was wrong)
- `lists` intentionally left without `client_id` — lists are shared infrastructure; client ownership lives on `campaigns`
- `contacts` confirmed to have NO `list_id` column — contacts link to lists via `list_members` only (prior documentation was wrong)
- Future global DNC override will be a SEPARATE table — no schema change to `contact_suppression` needed

---

## Migration 0015 — signals_rls (Stage 16)

**File:** `0015_signals_rls.sql`

**What changed:** Enabled Row Level Security on the `signals` table.

**Why:** Supabase flagged `signals` as a critical security issue — it was the ONLY table with `rowsecurity=false`. All 20 other tables have RLS enabled. This migration closes the gap so that all 21 tables share the same baseline protection.

**Tables affected:** `signals` (no schema change, only security posture change)

**Key design decisions:**
- No policies added — service_role bypasses RLS unconditionally; all existing queries work unchanged
- The anon/publishable key now correctly cannot access signals without an explicit policy
- Future policy: once authenticated user flows are added, a `USING (client_id = auth.jwt()->'app_metadata'->>'client_id')` policy should be added for tenant isolation
- This migration is idempotent — re-running it on a table where RLS is already enabled is a no-op in PostgreSQL

---

## Migration 0016 — health_snapshots (Stage 18)

**File:** `0016_health_snapshots.sql`

**Applied:** 2026-09-04

**What changed:** Created three append-only health snapshot tables for outreach provider metrics:

1. **`campaign_health_snapshots`** — point-in-time campaign send/open/reply/bounce metrics from a provider API. Composite FK `(client_id, campaign_id) → campaigns(client_id, id) ON DELETE CASCADE` enforces client_id integrity at the DB level (snapshots cascade-delete when the campaign is deleted).

2. **`domain_health_snapshots`** — per-domain inbox aggregate (total inboxes, healthy inboxes, blocked inboxes) from a provider API.

3. **`inbox_health_snapshots`** — per-inbox warmup/SMTP/IMAP health state, with tags array and daily send counts.

**Why:** Stage 18 introduced the Health Snapshot system to enable passive health monitoring. Each snapshot is a frozen point-in-time read from the outreach provider — no writes, no side effects. Baselines let us detect regressions: when `bounceRatePct` exceeds the baseline by more than `BOUNCE_RATE_WARN_PCT = 3.0%` (INITIAL_HYPOTHESIS_NOT_VALIDATED), or `replyRatePct` drops by more than `REPLY_RATE_DROP_WARN_PCT = 2.0%` (INITIAL_HYPOTHESIS_NOT_VALIDATED), a `HealthConcern` is emitted.

**New tables:** `campaign_health_snapshots`, `domain_health_snapshots`, `inbox_health_snapshots`

**Key design decisions:**
- **Append-only:** No UPDATE or DELETE in the application layer (only cascade-deletes at DB level when parent campaign/client is deleted)
- **Baseline = first snapshot:** The first row per `(client_id, entity_id)` is marked `is_baseline=true`. Determined application-side before insert (not a DB trigger). Concurrent races are benign — snapshots run on a scheduled cadence.
- **Idempotency:** `ON CONFLICT (client_id, entity_id, taken_at) DO NOTHING` — re-run within same second = no-op, returns `null` to caller (not an error).
- **Client isolation:** All reads include `.eq("client_id", clientId)`. Campaign snapshots additionally use the composite FK at the DB level.
- **RLS enabled** on all three tables. No policies defined — service_role bypasses RLS; anon key has no access.
- **`entity_id` column:** A stable text identifier for the snapshot entity (campaign UUID, domain name, or inbox platform ID). The composite unique constraint on `(client_id, entity_id, taken_at)` drives idempotency.
- **All thresholds labelled INITIAL_HYPOTHESIS_NOT_VALIDATED** — `BOUNCE_RATE_WARN_PCT=3.0`, `REPLY_RATE_DROP_WARN_PCT=2.0`, `INBOX_BLOCK_RATE_WARN_PCT=25.0`, `EMAIL_VERIFICATION_STALENESS_DAYS=90`. None validated against campaign outcome data.

**Tables affected:**
- `campaign_health_snapshots` (new — RLS + cascade FK + 3 indexes)
- `domain_health_snapshots` (new — RLS + 3 indexes)
- `inbox_health_snapshots` (new — RLS + 3 indexes)

---

## Tables Created Outside Migrations

The following tables appear to exist in the live database but have no migration files in this repository. They were likely created via the Supabase Dashboard.

| Table | Evidence | Notes |
|-------|----------|-------|
| `campaigns` | Referenced by `campaign_reviews.campaign_id` FK and `jobs.campaign_id` FK | Smartlead campaign records |
| `campaign_leads` | Referenced in campaign workflow documentation | Contacts enrolled in campaigns |
| `email_verifications` | Referenced in migration 0006 comments | Email verification results |
| `contacts` | `src/db/companies.ts` references it; no migration file | Contact records from Prospeo |
| `companies` | `src/db/companies.ts`; no migration file | Target company records |
| `lists` | `src/db/companies.ts`; altered in migration 0006 | List metadata |
| `list_members` | `src/db/companies.ts`; no migration file | List→company/contact junction |

These tables are documented in the individual table files (04-COMPANIES.md through 08-LIST-MEMBERS.md) based on TypeScript interface inspection.

---

## Application Layer Additions (No Migration Required)

The following application-layer modules were added in Stage 19A. They operate against existing tables and require no schema changes.

### Stage 19A — Lead Supply & Enrollment Readiness

**Files added:**
- `src/db/list-contacts.ts` — Batched DB reads: `getContactsForList` (Path A + Path B, dedup), `getAccountIntelligenceMap`, `getLatestEmailVerificationMap`, `getSuppressionMap`, `getEnrolledContactIds`. All read-only, no N+1 patterns.
- `src/lib/lead-supply.ts` — Pure types (`ContactAssessment`, `LeadSupplyReport`, `LeadSupplyInput`) + pure functions (`assessContactForCampaign`, `buildLeadSupplyReport`) + async orchestrator (`assessCampaignLeadSupply`). ~10 batched queries regardless of list size.
- `src/__tests__/lead-supply.test.ts` — 60 pure unit tests covering all five gates, all campaign statuses, FINDING 5 warning, breakdownByReason, dedup, client isolation, health advisories.
- `scripts/lead-supply-integration-test.ts` — 61 live integration checks against Gramscode test client. Creates and fully cleans up synthetic test fixtures. Full regression: 879/879.

**FINDING 5 documented (not resolved):**
`lists` and `list_members` have no `client_id`. There is no DB-level guarantee that `campaigns.list_id` references a list built for the same client. The `LeadSupplyReport.listClientWarning` field documents this gap on every report where `listId` is non-null. The account gate (Gate 1) provides a soft mitigation — contacts for companies with no `account_intelligence` for the client fail with `NO_ACCOUNT_INTELLIGENCE`. A schema fix (adding `client_id` to `lists` + `list_members`, or a junction table) requires explicit approval and a new migration.

**What Stage 19A does NOT do:**
- No writes to `campaign_leads`
- No email sends or provider API calls
- No migrations or RLS changes
- Does not resolve FINDING 5

---

## Application Layer Additions — Stage 20 (No Migration Required)

**Completed:** 2026-09-05

Stage 20 implements the provider lead upload path: takes `campaign_leads` rows with `status='ready'`, submits them to the Smartlead API, and transitions them to `status='uploaded'`. No new tables, no new columns, no migration. All changes are in the application layer.

### Files added / modified

| File | Change |
|------|--------|
| `src/db/campaign-leads.ts` | Added `getReadyLeadsForUpload` (reads `status='ready'` rows, oldest-first) and `markLeadsUploaded` (transitions rows with `status='ready'` guard) |
| `src/lib/lead-upload.ts` | `uploadCampaignLeads()` orchestrator — 3-gate precondition check (platform, status, platformCampaignId), batch-100 provider loop, crash-recovery idempotency |
| `src/providers/outreach/smartlead.ts` | `uploadLeads()` method — POST to `/api/v1/campaigns/{id}/leads`; response interface extended with `already_added_to_campaign` |
| `src/__tests__/lead-upload.test.ts` | Unit tests for the orchestrator (pure, no network) |
| `src/__tests__/outreach-provider.test.ts` | 14 `uploadLeads` unit tests added; 40 total, all passing |

### Critical API contract discovery: `ignore_duplicate` is invalid

The Stage 20 design assumed `?ignore_duplicate=true` was a valid Smartlead query parameter. Live testing confirmed it is **not valid** — Smartlead returns HTTP 400: `"ignore_duplicate" is not allowed`. The parameter was removed from the adapter. Smartlead handles campaign dedup natively.

**Correct field: `already_added_to_campaign`**

Smartlead's upload response includes two distinct dedup counters:

| Field | Meaning |
|-------|---------|
| `already_added_to_campaign` | Per-campaign dedup — non-zero when a lead is already in this specific campaign. This is the authoritative idempotency signal. Mapped to `duplicateCount` internally. |
| `duplicate_count` | Global suppression/unsubscribe counter — leads blocked by global lists. Different concept from campaign-level dedup. |

### `platform_lead_id` confirmed NULL after upload

Smartlead's `POST /campaigns/{id}/leads` returns aggregate counts only, no per-lead IDs. `campaign_leads.platform_lead_id` remains NULL. Backfill via `GET /campaigns/{id}/leads` is deferred to Stage 21+.

### Concurrency model (Stage 20)

Single-worker. No `uploading` claim status yet. Crash-recovery: if the process crashes after a successful provider call but before `markLeadsUploaded`, the row stays `ready`. On retry, Smartlead returns `already_added_to_campaign=1` (not an error); `markLeadsUploaded` then runs and advances the row to `uploaded`. The `WHERE status='ready'` guard in `markLeadsUploaded` prevents double-write.

### Open findings (unchanged from Stage 19B)

- **FINDING 5**: `lists` and `list_members` have no `client_id` — cross-client list isolation gap. Not resolved.
- **FINDING 6**: `campaign_leads` has RLS enabled but zero policies — service_role bypasses; no impact today. Not resolved.

### Test evidence (live Gramscode test, 2026-09-05)

| Phase | Result |
|-------|--------|
| Dry run | 5-gate pass, readyCount=1, 0 provider calls, 0 DB writes |
| Live upload (pre-fix) | HTTP 400 from `?ignore_duplicate=true`; row stayed `ready` (correct failure recovery) |
| Adapter fix | `ignore_duplicate` removed; `already_added_to_campaign` mapped; 968/968 regression pass |
| Reconciliation call | Smartlead: `upload_count=1, already_added_to_campaign=1`; DB: `ready → uploaded`; `updated_at` advanced |
| Idempotency rerun | 0 provider POSTs; `readyCount=0`; DB unchanged; campaign remained DRAFTED |
| Supabase independent verification | campaign_lead count=1, uploaded=1, ready=0, campaign_status=draft — PASSED |

---

## Migration 0017 — why_now (Stage 22)

**File:** `0017_why_now.sql`

**What changed:**

Three additive columns on `account_intelligence`:

- `why_now JSONB` — Full `WhyNowAssessment` blob: deterministic evidence snapshot (signal summaries, corroboration factor, opportunity/priority scores), readiness decision, and optional AI narrative grounded in actual stored signal evidence. Null until first `assessWhyNow()` run.
- `is_ready BOOLEAN` — Promoted from `why_now->ready` for fast indexed filtering. Null = not yet assessed. False = assessed but insufficient evidence. True = passes readiness gate.
- `readiness_assessed_at TIMESTAMPTZ` — When the readiness gate was last evaluated. NOT a freshness guarantee — new signals ingested after this timestamp may change readiness.

Partial index `account_intelligence_ready_priority_idx` on `(client_id, priority_score DESC NULLS LAST) WHERE is_ready = true` — fast filtering of ready accounts ordered by priority.

**Why:** Stage 22 Why Now Engine. Answers "why should we reach out to this company right now?" using a three-stage pipeline: deterministic evidence assembly from stored signals → readiness gate → optional AI narrative. The AI system prompt explicitly prohibits inventing facts not in evidence.

**Tables affected:** `account_intelligence` (additive only — no existing columns modified)

**Key design decisions:**
- All readiness thresholds are `INITIAL_HYPOTHESIS_NOT_VALIDATED` (minOpportunityScore=1, minActiveSignalCount=1, aiNarrativeMinScore=20)
- `is_ready` is promoted to a native column for fast indexed queries (avoids JSONB extraction on hot paths)
- AI narrative is gated: only generated when `ready=true` AND `opportunity_score >= 20`. AI failures are non-fatal (narrative=null, deterministic assessment still persisted)
- 23-hour idempotency window: existing narratives reused within the window to prevent duplicate AI spend
- Signal UUIDs embedded in `evidence._signalId`; AI returns signal titles; post-mapping maps titles → UUIDs (best-effort)
- File was originally numbered 0014 — renamed to 0017 before application (0014 was already taken by Stage 15 campaign operations migration)

**Test results (applied 2026-09-06):**
| Check | Result |
|-------|--------|
| Unit tests | 55/55 pass |
| Regression suite | 1063/1063 pass |
| Company A (1 funding signal, score=32) | ready=true, persisted, reason=READY |
| Company B (expired signal, score=0) | ready=false, reason=OPPORTUNITY_SCORE_BELOW_THRESHOLD |
| Company C (no account_intelligence row) | ready=false, not persisted, reason=NO_ACCOUNT_INTELLIGENCE |
| Company D (3 GROWTH signals, score=100) | ready=true, AI narrative generated (14180ms, $0.009) |
| Corroboration (Company D) | factor=1.3 (3-type GROWTH cluster confirmed) |
| Idempotency | Second run within 23h: narrativeReused=true, no AI call made |
| Client isolation | Cross-client lookup returns NO_ACCOUNT_INTELLIGENCE; real row unchanged |
| getReadyAccounts() | Returns Company A and D only; excludes B (not ready) and C (not assessed) |

---

## Migration 0018 — contact_intelligence (Stage 23)

**File:** `0018_contact_intelligence.sql`

**Applied:** 2026-09-08

**What changed:** Two new tables for Stage 23 Contact Intelligence & Person Relevance:

1. **`contact_intelligence`** — campaign-agnostic, one row per `(client_id, company_id, contact_id)`. Stores deterministic job title classification (`title_classification JSONB`: function bucket, seniority, confidence — raw title intentionally absent for PII minimisation) and a snapshot of the Stage 17 contact eligibility gate (`gate_snapshot JSONB`). Promoted boolean `is_contact_ready` for fast indexed queries. `is_contact_ready` is a **DISCOVERY snapshot** — not authorization for outreach.

2. **`contact_campaign_relevance`** — campaign-specific, one row per `(client_id, company_id, contact_id, campaign_strategy_id)`. Stores the deterministic relevance score (0–100, `NUMERIC(5,2)`) and AI-generated "why this person" sentence. `relevance_reason` has a `CHECK` constraint enforcing the 5 valid values. `scoring_version` promoted from JSONB for fast staleness comparison without JSONB parsing. `is_person_qualified = is_person_relevant AND is_contact_ready (snapshot)` — does NOT imply OUTREACH_READY.

3. **Trigger `contact_campaign_strategy_client_check`** — BEFORE INSERT OR UPDATE on `contact_campaign_relevance`. Verifies `campaign_strategy_id` belongs to the same `client_id`. Compensates for `campaign_strategies` having no `UNIQUE(client_id, id)` constraint — same pattern as migration 0014. Fires for all connections.

**Why:** Stage 23 answers "for an account worth pursuing, who is the right person to contact, and why?" The two-table design separates campaign-agnostic facts (title classification, eligibility gate) from campaign-specific facts (relevance score, AI narrative). The same contact reuses its `contact_intelligence` row across all campaigns.

**New tables:** `contact_intelligence`, `contact_campaign_relevance`

**Key design decisions:**
- `is_contact_ready` and `is_person_qualified` are **snapshots** — NOT outreach authorization. The activation stage (Stage 24+) must re-run `evaluateContactEligibility()` live.
- Stage 23 does NOT produce `OUTREACH_READY`. That belongs to a future activation stage.
- `SCORING_VERSION = "1.0.0"` (INITIAL_HYPOTHESIS_NOT_VALIDATED thresholds: `PERSON_RELEVANCE_MIN_SCORE=30`, `AI_RELEVANCE_MIN_SCORE=40`, staleness ceiling 7 days).
- All indexes `IF NOT EXISTS`, DDL idempotent throughout.
- RLS enabled on both tables; no policies yet — service_role bypasses RLS.

**Verification (applied 2026-09-08):**
| Check | Result |
|-------|--------|
| contact_intelligence exists | ✓ |
| contact_campaign_relevance exists | ✓ |
| UNIQUE(client,company,contact) on contact_intelligence | ✓ |
| UNIQUE(client,company,contact,campaign) on contact_campaign_relevance | ✓ |
| All 8 expected indexes present | ✓ |
| Trigger contact_campaign_strategy_client_check | ✓ |
| RLS enabled on both tables | ✓ |
| All columns match designed schema | ✓ |
| Unit tests (person-relevance, contact-eligibility) | 1186/1186 pass |

---

## Stage 21B — Controlled First-Send Experiment (CLOSED 2026-09-08)

**No migration required.** Application-layer observation only.

**Experiment:** Single test lead enrolled, campaign manually activated in Smartlead UI. BEFORE snapshot taken before activation; AFTER snapshot taken 2026-09-08 after UI confirmed `Completed, 1/1 sends, 1 opened`.

### Confirmed API field changes after a send

| Source | Field | BEFORE | AFTER |
|--------|-------|--------|-------|
| Smartlead campaign object | `status` | `DRAFTED` | `COMPLETED` |
| Campaign roster | per-lead `status` | `STARTED` | `COMPLETED` |
| Campaign roster | `sent_at` | `null` | `null` (CRITICAL — not populated) |
| Global lead | `last_sent_at` | `null` | `2026-09-07T08:01:57.411+00:00` |
| Global lead | `last_activity_at` | `null` | `2026-09-07T08:01:57.411+00:00` |
| Analytics | `sent_count` | `0` | `1` |
| Analytics | `open_count` | `0` | `1` |

### Critical findings

1. **`roster.sent_at` is permanently null** — Smartlead does NOT populate it after a send. Never use it for send detection.
2. **`global_lead.last_sent_at` is the authoritative send timestamp** — `GET /leads/?email=...` → `lead_campaign_data[].last_sent_at`.
3. **Status `STARTED → COMPLETED`** confirmed for a fully-sequenced lead (1-step sequence here; INPROGRESS for mid-sequence is unconfirmed).
4. **`lead_category_id` stays null** through a send event — do not use.
5. **`contacts.updated_at` exists in live DB** — confirmed by schema probe. TypeScript `ContactRow` type doesn't expose it yet.

Full findings documented in `docs/supabase/19-CAMPAIGN-LEADS.md` § 15.

---

## Stage 23 — Pre-Migration Schema Analysis (2026-09-08)

**Migration 0018 applied 2026-09-08. All checks passed.**

### Live schema findings

1. **`campaign_strategies` has NO `UNIQUE(client_id, id)`** — Only `PRIMARY KEY (id)` and FK to `clients`. Confirmed via `pg_constraint` query. Migration 0018 uses the trigger pattern (same as migration 0014) for client isolation on `contact_campaign_relevance` instead.

2. **Stage 23 tables (`contact_intelligence`, `contact_campaign_relevance`) do NOT yet exist** — `information_schema.tables` query returned empty. Migration 0018 is a clean-slate migration (no existing data to worry about).

3. **`contacts.updated_at` EXISTS as `timestamp with time zone`** — Confirmed. Not yet typed in `ContactRow`. Enables richer staleness detection when the type is updated.

4. **All referenced columns exist** — `campaign_strategies.targeting_level`, `campaign_strategies.value_proposition`, `campaign_strategies.updated_at` all confirmed in live schema.

### Application layer (completed, pending migration)

| File | Status |
|------|--------|
| `src/domain/contact-intelligence-types.ts` | Complete |
| `src/db/contact-intelligence.ts` | Complete |
| `src/lib/contact-intelligence.ts` | Complete |
| `src/lib/person-relevance.ts` | Complete |
| `src/lib/contact-eligibility.ts` | Complete |
| `src/__tests__/person-relevance.test.ts` | 123/123 pass |
| `src/__tests__/contact-eligibility.test.ts` | Complete |
| `supabase/migrations/0018_contact_intelligence.sql` | Prepared, NOT applied |

**Production gate:** Migration 0018 is awaiting explicit approval before application.

---

## Migration 0019 — person_discovery (Stage 24)

**File:** `0019_person_discovery.sql`
**Applied:** 2026-09-08 via Supabase Management API (Supabase CLI not available)

**What changed:** Created four audit tables for the Stage 24 person discovery and email enrichment waterfalls.

**New tables:**

| Table | Purpose |
|-------|---------|
| `person_discovery_runs` | One row per (client, company, campaign_strategy) — the latest waterfall result |
| `person_discovery_attempts` | One row per provider call within a discovery run |
| `email_enrichment_runs` | One row per (client, contact, campaign_strategy) — the latest enrichment result |
| `email_enrichment_attempts` | One row per provider call within an enrichment run |

**Key design decisions:**

- **`found_email` deliberately absent** from `email_enrichment_runs` and `email_enrichment_attempts`. The found email is PII; it is returned in-memory via `EmailEnrichmentOutcome.foundEmail` only and must never be persisted to these tables.
- **FK ON DELETE behavior:** `selected_contact_id` and `candidate_contact_id` → SET NULL (preserves audit when contact deleted). `contact_id` on email enrichment → CASCADE (contact is the subject; audit is meaningless without the contact). All `client_id`, `company_id`, `campaign_strategy_id` references → RESTRICT (default; prevents orphaned runs).
- **Idempotency:** Both `*_runs` tables use UNIQUE on `(client_id, company_id/contact_id, campaign_strategy_id)` — upsert on re-run overwrites the run row. Both `*_attempts` tables use UNIQUE on `(run_id, provider_id, attempt_number)` with `ignoreDuplicates: true` — first write wins on re-run.
- **RLS enabled, zero policies** on all four tables — consistent with the rest of the schema. Access is via `service_role` only.
- **FK violation observable:** If `client_id` does not exist in `clients` (e.g., test fixture without a real client row), the waterfall wrapper returns `persistenceError: { code: "FK_VIOLATION", message: "..." }` on the outcome instead of silently swallowing the error.

**Application layer added (Stage 24):**

| File | What it does |
|------|-------------|
| `src/db/person-discovery.ts` | `upsertPersonDiscoveryRun`, `insertPersonDiscoveryAttempt`, `persistPersonDiscoveryOutcome`, `getPersonDiscoveryRun`, `listPersonDiscoveryAttempts` |
| `src/db/email-enrichment.ts` | `upsertEmailEnrichmentRun`, `insertEmailEnrichmentAttempt`, `persistEmailEnrichmentOutcome`, `getEmailEnrichmentRun`, `listEmailEnrichmentAttempts` |
| `src/lib/person-discovery-waterfall.ts` | Public `runPersonDiscoveryWaterfall` wraps `_runPersonDiscoveryCore` + persist. FK violations → `persistenceError` on outcome. |
| `src/lib/email-enrichment-waterfall.ts` | Same pattern: `runEmailEnrichmentWaterfall` wraps `_runEmailEnrichmentCore` + persist. |
| `src/lib/provider-error-sanitizer.ts` | 6-pass redaction (email, Bearer, Basic, key=value, prefixed keys, long tokens) — applied before any error message is stored |
| `src/domain/person-discovery-types.ts` | `PersistenceError` interface + `persistenceError?` field on both outcome types |

**Verified:** 40/40 schema checks (via `scripts/verify-0019-schema.ts`), 112/112 Stage 24 controlled validation, 66/66 Stage 24B persistence integration, 1241/1241 full regression. No emails sent. No campaigns modified. Stage 23 tables unchanged.

---

## Migration 0021 — account_campaign_qualification (Stage 29 Phase 2)

**File:** `0021_account_campaign_qualification.sql`
**Applied:** 2026-09-11 via Supabase Management API
**SHA256:** `83ba74d82ae42f8a049dd2bc0607fd69d41b640de144aff3c1a8765a47808930`

**What changed:** Created one new table for campaign-specific account qualification. `account_intelligence` was NOT modified.

**New table:**

| Table | Key | Purpose |
|-------|-----|---------|
| `account_campaign_qualification` | UNIQUE(client_id, company_id, campaign_strategy_id) | Campaign-specific qualification verdict for a company against a specific ICP |

**Key design decisions:**

- **account_intelligence is NOT modified.** The original migration 0021 proposal (adding `qualification`, `is_qualified`, `qualification_assessed_at` to `account_intelligence`) was rejected by the Phase 1.5 architecture review. Adding campaign-specific data to a per-(client, company) table would cause the last qualification run to silently overwrite all previous campaigns' qualifications for the same company.

- **Follows the `contact_campaign_relevance` pattern exactly (migration 0018).** "The same company may QUALIFY for one campaign and NOT QUALIFY for another" — identical reasoning to "The same contact may be RELEVANT for one campaign and NOT RELEVANT for another."

- **UNIQUE(client_id, company_id, campaign_strategy_id)** — the idempotent upsert key. Re-running qualification for the same (client, company, strategy) triple updates in place.

- **qualification_score CHECK(0–100)** — enforces valid range at the DB level.

- **Client-isolation trigger** `account_qualification_strategy_client_check` — same pattern as migration 0018 trigger (`check_contact_campaign_strategy_client`). Fires BEFORE INSERT OR UPDATE. Raises an exception if `campaign_strategy_id` does not belong to the same `client_id`.

- **RLS enabled, zero policies** — consistent with all other tables. Access via service_role only.

- **Indexes:** `(client_id, campaign_strategy_id)` for Stage 25 campaign queries; `(client_id, campaign_strategy_id) WHERE qualified=true` partial index for qualified-companies filter; `(company_id)` and `(client_id, company_id)` for reverse lookups.

- **All thresholds INITIAL_HYPOTHESIS_NOT_VALIDATED** — `qualification_score` weights and the `qualified` gate threshold are starting hypotheses, not validated against campaign outcome data.

**Migration 0020 note:** Migration 0020 (`campaign_readiness_assessments` + `campaign_readiness_approvals`) was applied as part of Stage 25A (2026-09-09) and is documented here for completeness. The migration numbering jumped from 0019 → 0021 because 0020 was applied before the qualification table design was finalised.

**Verification script:** `scripts/apply-0021-migration.ts` — 103/103 checks, 0 failures.

**Functional tests passed:**
- Test A: Idempotent upsert — same (client, company, strategy) → no duplicate row
- Test B: Same (client, company), two strategies → both coexist with correct independent values
- Test C: CHECK constraint rejects `qualification_score` = -1 and 101
- Test D: Client-isolation trigger rejects a strategy belonging to a different (or non-existent) client
- Test E: UNIQUE key prevents Strategy A from overwriting Strategy B

**Delta:**
- `account_campaign_qualification` rows: 0 → 0 (test rows inserted and cleaned up)
- All unrelated tables: unchanged (15 ai rows, 1 campaign, 3239 signals, 243 companies, 215 contacts, 3 strategies, 3 ccr rows, 3 ci rows)
- Provider calls: 0
- Outreach: 0

---

## Schema Evolution Summary

| Migration | Key Addition | Enables |
|-----------|-------------|---------|
| 0001 | Service role grants | Database access |
| 0002 | clients + icp_onboarding | Multi-client onboarding |
| 0003 | lead_magnets | Lead magnet brainstorm storage |
| 0004 | campaign_strategies + campaign_plans | Campaign planning storage |
| 0005 | email_sequences + steps + scores | Copywriting + list scoring |
| 0006 | campaign_reviews + extra columns | Client review workflow |
| 0007 | AI cost tracking columns | Per-client AI spend tracking |
| 0008 | AI observability + escalation chain | Multi-tier AI with monitoring |
| 0009 | Idempotency keys + job linkage | Atomic job claiming + resume |
| 0010 | escalated status | Explicit escalation state |
| 0011 | signals | GTM Signal Engine |
| 0012 | account_intelligence | Opportunity score per (client, company) |
| 0013 | priority_score + prioritized_at on account_intelligence | Time-decayed account prioritization |
| 0014 | campaigns.client_id + composite FK + contact_suppression | Campaign tenant isolation + suppression gate |
| 0015 | signals RLS enabled | Baseline protection aligned with all other tables |
| 0016 | campaign/domain/inbox health snapshot tables | Append-only provider health monitoring + baseline regression detection |
| Stage 19A (no migration) | Lead supply assessment + list-contacts DB layer | Read-only enrollment readiness: 5-gate check across full list, breakdownByReason, health advisories |
| Stage 20 (no migration) | Provider lead upload — `uploadCampaignLeads()` + `uploadLeads()` adapter | `ready → uploaded` lifecycle; crash-recovery idempotency; `already_added_to_campaign` dedup mapping confirmed live |
| 0017 | `why_now JSONB` + `is_ready BOOLEAN` + `readiness_assessed_at TIMESTAMPTZ` on `account_intelligence` + partial index | Stage 22 Why Now Engine: deterministic evidence + readiness gate + optional AI narrative grounded in stored signals |
| Stage 21B (no migration) | Controlled first-send experiment — BEFORE/AFTER snapshots | Confirmed: `roster.sent_at` always null; `global_lead.last_sent_at` is authoritative; status STARTED→COMPLETED |
| 0018 | `contact_intelligence` + `contact_campaign_relevance` tables + cross-client trigger | Stage 23: title classification + contact eligibility gate snapshot + campaign-specific relevance scoring |
| 0019 | `person_discovery_runs` + `person_discovery_attempts` + `email_enrichment_runs` + `email_enrichment_attempts` | Stage 24: person discovery + email enrichment waterfall audit trail; found_email never stored |
| 0020 | `campaign_readiness_assessments` + `campaign_readiness_approvals` tables | Stage 25: deterministic OUTREACH_READY/HARD_BLOCKED verdict + human approval gate before outreach |
| 0021 | `account_campaign_qualification` table + cross-client trigger | Stage 29: campaign-specific account qualification; UNIQUE(client,company,strategy); account_intelligence NOT modified |
