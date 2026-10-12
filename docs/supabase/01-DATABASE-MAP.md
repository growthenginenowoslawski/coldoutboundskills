# Database Map — Master Relational Reference

This is the authoritative map of every table, its relationships, and its role. Update this document whenever a table is added, removed, or gets a new foreign key.

---

## Full Relationship Tree

```
clients
  ├── icp_onboarding          (12 Q&A rows per client)
  ├── lead_magnets             (brainstormed offer ideas)
  ├── campaign_strategies      (15-25 campaign angle ideas)
  ├── campaign_plans           (synthesized one-pager)
  ├── email_sequences          (written email sequences)
  ├── list_quality_scores      (list scorecard results)
  ├── campaign_reviews         (approval workflow)
  ├── enrichment_runs          (AI call ledger, added Stage 7)
  ├── signals                  (buying signals, added Stage 11)
  ├── account_intelligence     (opportunity + priority scores, added Stage 12/14)
  ├── campaigns                (active outreach campaigns, client_id added Stage 15)
  └── contact_suppression      (per-client contact suppression records, added Stage 15)

companies
  ├── contacts                 (people at this company)
  ├── enrichment_runs          (AI qualification runs)
  ├── signals                  (buying signals at this company)
  └── account_intelligence     (opportunity/priority score per client)

lists
  ├── list_members             (junction to companies/contacts)
  ├── list_quality_scores      (scorecard runs on this list)
  ├── jobs                     (background tasks for this list)
  └── campaigns                (campaigns that draw from this list — optional, via list_id)

contacts
  ├── list_members             (junction to lists)
  └── contact_suppression      (per-client suppression records for this contact)

campaign_strategies
  ├── email_sequences          (written copy for this strategy)
  └── campaigns                (campaigns running this strategy — optional, via campaign_strategy_id)

email_sequences
  └── email_sequence_steps     (individual emails: Day 0,3,7,11)

campaigns
  ├── campaign_leads           (individual prospects in campaign — client_id + composite FK, Stage 15)
  ├── campaign_reviews         (approval records)
  └── jobs                     (background task tracking)

jobs
  └── enrichment_runs          (AI runs spawned by this job)

enrichment_runs
  └── enrichment_runs          (self-referential: escalated_from_run_id)
```

---

## Table-by-Table Reference

### `clients`
**Purpose:** Top-level tenant. Every piece of data belongs to a client.
**Created by:** Migration 0002
**PK:** `id` (uuid)
**FKs:** none — this is the root table
**Parent:** none
**Children:** icp_onboarding, lead_magnets, campaign_strategies, campaign_plans, email_sequences, list_quality_scores, campaign_reviews, enrichment_runs (via 0007), signals
**Writes:** /cold-email-kickoff skill, migration seed data
**Reads:** All skills that need client context; getClientIdBySlug() helper
**RLS:** ENABLED

---

### `icp_onboarding`
**Purpose:** The 12 ICP discovery questions and their answers for each client.
**Created by:** Migration 0002
**PK:** `id` (uuid)
**FKs:** `client_id → clients(id)` ON DELETE CASCADE
**Parent:** clients
**Children:** none
**Writes:** /icp-onboarding skill via saveAnswer()
**Reads:** /campaign-strategy, /cold-email-kickoff skills
**RLS:** ENABLED

---

### `lead_magnets`
**Purpose:** Brainstormed free-offer ideas per client. One row per idea. One gets selected.
**Created by:** Migration 0003
**PK:** `id` (uuid)
**FKs:** `client_id → clients(id)` ON DELETE CASCADE
**Parent:** clients
**Children:** none
**Writes:** /lead-magnet-brainstorm skill
**Reads:** /campaign-copywriting, /cold-email-kickoff skills
**RLS:** ENABLED

---

### `campaign_strategies`
**Purpose:** Campaign angle ideas (15-25 per client). Each has a targeting level, AI strategy, and value proposition.
**Created by:** Migration 0004
**PK:** `id` (uuid)
**FKs:** `client_id → clients(id)` ON DELETE CASCADE
**Parent:** clients
**Children:** email_sequences (via campaign_strategy_id)
**Writes:** /campaign-strategy skill
**Reads:** /cold-email-kickoff, /campaign-copywriting skills
**RLS:** ENABLED

---

### `campaign_plans`
**Purpose:** Synthesized one-page campaign plan per client. The output of /cold-email-kickoff.
**Created by:** Migration 0004
**PK:** `id` (uuid)
**FKs:** `client_id → clients(id)` ON DELETE CASCADE
**Parent:** clients
**Children:** none
**Writes:** /cold-email-kickoff skill Step 5
**Reads:** /cold-email-kickoff, operator review
**RLS:** ENABLED

---

### `companies`
**Purpose:** Target accounts. Every prospect company sourced by any list-building skill.
**Created by:** Supabase Dashboard (pre-migration)
**PK:** `id` (uuid)
**FKs:** none (root entity)
**Parent:** none
**Children:** contacts, enrichment_runs, signals, list_members (via company_id)
**Writes:** prospeo-pull.ts, run-company-research.ts, list-builder skills
**Reads:** qualify-list.ts, signal-ingestion task, all list queries
**RLS:** UNKNOWN (created before migrations; assumed service_role access)

---

### `contacts`
**Purpose:** Individual people at target companies. Sourced from Prospeo.
**Created by:** Supabase Dashboard (pre-migration)
**PK:** `id` (uuid)
**FKs:** `company_id → companies(id)` — no `list_id` column (contacts link to lists via list_members junction only)
**Parent:** companies
**Children:** list_members (via contact_id), contact_suppression (via contact_id)
**Writes:** prospeo-pull.ts, Clay enrichment
**Reads:** show-contacts.ts, campaign lead selection
**RLS:** UNKNOWN
**Note:** Live schema inspection (Stage 15) confirmed `contacts` has NO `list_id` column. The `01-DATABASE-MAP.md` previously claimed `list_id → lists(id)` as a direct FK — this was wrong. Contacts attach to lists exclusively via `list_members`.

---

### `lists`
**Purpose:** Named batches of companies or contacts. One list per sourcing run.
**Created by:** Supabase Dashboard (pre-migration); columns added by Migration 0006
**PK:** `id` (uuid)
**FKs:** none
**Parent:** none
**Children:** list_members, list_quality_scores, jobs (via list_id)
**Writes:** prospeo-pull.ts, storeCompaniesInList(), createList()
**Reads:** qualify-list.ts, show-contacts.ts, list-quality-scorecard
**RLS:** UNKNOWN

---

### `list_members`
**Purpose:** Junction table. Links lists to both companies and contacts.
**Created by:** Supabase Dashboard (pre-migration)
**PK:** `id` (uuid)
**FKs:** `list_id → lists(id)`, `company_id → companies(id)` (nullable), `contact_id → contacts(id)` (nullable)
**Parent:** lists + companies/contacts
**Children:** none
**Writes:** storeCompaniesInList() in companies.ts, prospeo-pull.ts linkContactToList()
**Reads:** qualify-list.ts (joins to companies), show-contacts.ts
**RLS:** UNKNOWN

---

### `list_quality_scores`
**Purpose:** Scorecard result for a list. Grades eight dimensions from email validity to ICP fit.
**Created by:** Migration 0005
**PK:** `id` (uuid)
**FKs:** `client_id → clients(id)` ON DELETE CASCADE, `list_id → lists(id)` ON DELETE SET NULL
**Parent:** clients + lists
**Children:** none
**Writes:** /list-quality-scorecard skill
**Reads:** operator review before campaign launch
**RLS:** ENABLED

---

### `email_verifications`
**Purpose:** Email deliverability check results from Millionverifier or Enirchley.
**Created by:** Supabase Dashboard (pre-migration)
**PK:** `id` (uuid)
**FKs:** likely contact_id or email reference (exact schema not confirmed in code)
**Parent:** contacts (presumed)
**Children:** none
**Writes:** /smartlead-campaign-upload-public or Clay enrichment step
**Reads:** list_quality_scores scoring (email_verification_score dimension)
**RLS:** UNKNOWN
**Note:** Schema partially inferred. The migration 0006 comments confirm this table exists with a `provider` column ('millionverifier', 'enirchley'). Full column list not confirmed in code.

---

### `enrichment_runs`
**Purpose:** AI call ledger. One row per AI invocation — qualification, personalization, signal intelligence.
**Created by:** Supabase Dashboard (pre-migration); many columns added by migrations 0007/0008/0009/0010
**PK:** `id` (uuid)
**FKs:** `company_id → companies(id)`, `client_id → clients(id)` (0007), `escalated_from_run_id → enrichment_runs(id)` (0008, self-ref), `job_id → jobs(id)` (0009)
**Parent:** companies + clients + jobs
**Children:** enrichment_runs (self-referential escalation chain)
**Writes:** storeQualification(), storeEscalationResult() in qualifications.ts
**Reads:** Cost reporting queries, signal intelligence pipeline
**RLS:** UNKNOWN
**Partial unique index:** (job_id, attempt_number) WHERE both NOT NULL — prevents duplicate AI runs on retry

---

### `jobs`
**Purpose:** Background task queue. One row per Trigger.dev task. Tracks lifecycle from pending to completed.
**Created by:** Supabase Dashboard (pre-migration); idempotency_key added by Migration 0009
**PK:** `id` (uuid)
**FKs:** `list_id → lists(id)` (nullable), `campaign_id → campaigns(id)` (nullable)
**Parent:** lists and/or campaigns (when applicable)
**Children:** enrichment_runs (via job_id)
**Writes:** claimJob(), createJob(), updateJob(), completeJob() in jobs.ts
**Reads:** Trigger.dev tasks, operator monitoring
**RLS:** UNKNOWN
**Partial unique index:** (job_type, idempotency_key) WHERE status NOT IN ('failed','cancelled') AND idempotency_key IS NOT NULL

---

### `signals`
**Purpose:** Normalized buying signals at target companies. One row per event (job posting, funding round, etc.).
**Created by:** Migration 0011
**PK:** `id` (uuid)
**FKs:** `client_id → clients(id)` ON DELETE CASCADE, `company_id → companies(id)` ON DELETE CASCADE
**Parent:** clients + companies
**Children:** none (consumed by WHY NOW AI layer)
**Writes:** signal-ingestion Trigger.dev task via upsertSignal() in signals.ts
**Reads:** Signal intelligence AI tasks, WHY NOW analysis
**RLS:** NOT ENABLED IN MIGRATION — SEE 25-SUPABASE-SECURITY.md
**Partial unique index:** (client_id, dedup_key) WHERE dedup_key IS NOT NULL — prevents duplicate ingestion

---

### `email_sequences`
**Purpose:** Written email campaign sequences. One per campaign angle. Contains the AI variables for personalization.
**Created by:** Migration 0005; value_prop_type added by Migration 0006
**PK:** `id` (uuid)
**FKs:** `client_id → clients(id)` ON DELETE CASCADE, `campaign_strategy_id → campaign_strategies(id)` ON DELETE SET NULL
**Parent:** clients + campaign_strategies
**Children:** email_sequence_steps, campaign_reviews (via sequence_id)
**Writes:** /campaign-copywriting skill
**Reads:** Campaign launch process, campaign_reviews
**RLS:** ENABLED

---

### `email_sequence_steps`
**Purpose:** Individual emails in a sequence. Day 0 (first touch), Day 3, Day 7, Day 11.
**Created by:** Migration 0005; script_framework, has_personalization, spintax_body added by Migration 0006
**PK:** `id` (uuid)
**FKs:** `sequence_id → email_sequences(id)` ON DELETE CASCADE
**Parent:** email_sequences
**Children:** none
**Writes:** /campaign-copywriting skill (inserted together with the sequence)
**Reads:** Campaign upload to Smartlead
**RLS:** ENABLED

---

### `campaigns`
**Purpose:** An active outreach campaign. The launch point for sending emails. Scoped to a single client (tenant).
**Created by:** Supabase Dashboard (pre-migration); columns added by Migration 0014
**PK:** `id` (uuid)
**FKs:**
- `client_id → clients(id)` ON DELETE CASCADE (NOT NULL — every campaign belongs to one client)
- `campaign_strategy_id → campaign_strategies(id)` ON DELETE SET NULL (nullable; links to intelligence layer)
- `list_id → lists(id)` ON DELETE SET NULL (nullable; source list for contact pool)
**Composite unique:** `(client_id, id)` — required target for campaign_leads composite FK
**Trigger:** `check_campaign_strategy_client()` BEFORE INSERT OR UPDATE — verifies campaign_strategy_id belongs to the same client
**Parent:** clients + campaign_strategies (optional) + lists (optional)
**Children:** campaign_leads, campaign_reviews, jobs, contact_suppression (via source_campaign_id)
**Writes:** createCampaign() in src/db/campaigns.ts
**Reads:** getCampaignsByClientId(), getCampaignById() in src/db/campaigns.ts
**RLS:** UNKNOWN (pre-migration; service_role bypasses RLS)
**Live schema:** platform DEFAULT 'plusvibe' (NOT 'smartlead' — always read the platform field, never hardcode)
**Stage 15 key invariants:**
- `client_id` is NOT NULL — there is no campaign without a client owner
- `platform` defaults to 'plusvibe' — the OutreachProviderAdapter reads this to route provider API calls
- `campaign_strategy_id` is enforced by trigger; a cross-client assignment raises an exception

---

### `campaign_leads`
**Purpose:** Individual prospects assigned to a campaign. One row per contact enrolled per campaign.
**Created by:** Supabase Dashboard (pre-migration); client_id + composite FK added by Migration 0014
**PK:** `id` (uuid)
**FKs:**
- `campaign_id → campaigns(id)` ON DELETE CASCADE (simple FK — original)
- `contact_id → contacts(id)` (simple FK — original)
- `client_id → clients(id)` ON DELETE CASCADE (NOT NULL — added Stage 15)
- `(client_id, campaign_id) → campaigns(client_id, id)` ON DELETE CASCADE (composite FK — enforces client_id consistency at DB level; a lead's client_id cannot differ from its campaign's client_id)
**Parent:** campaigns + contacts + clients
**Children:** none
**Writes:** not yet implemented (Stage 18+)
**Reads:** reply scoring, experiment design tasks
**RLS:** UNKNOWN (pre-migration)
**Live schema:** status DEFAULT 'ready' (NOT 'queued' — earlier documentation was wrong; confirmed by OpenAPI spec inspection in Stage 15)
**Stage 15 key invariants:**
- `client_id` is NOT NULL — inserted alongside campaign_id; must match campaigns.client_id for the same campaign
- Composite FK enforced at DB level — application code cannot create cross-client leads even with a bug

---

### `contact_suppression`
**Purpose:** Per-client contact suppression records. Safety gate preventing a contact from being enrolled in campaigns.
**Created by:** Migration 0014 (Stage 15)
**PK:** `id` (uuid)
**FKs:**
- `client_id → clients(id)` ON DELETE CASCADE (NOT NULL)
- `contact_id → contacts(id)` ON DELETE CASCADE (NOT NULL)
- `source_campaign_id → campaigns(id)` ON DELETE SET NULL (nullable — which campaign triggered the suppression)
**Parent:** clients + contacts + campaigns (optional)
**Children:** none
**Writes:** suppressContact(), liftSuppression() in src/db/contact-suppression.ts
**Reads:** isContactSuppressed(), getSuppressionRecords(), getActiveSuppression() in src/db/contact-suppression.ts
**RLS:** ENABLED — no policies defined yet; service_role bypasses RLS; authenticated tenant policies added when auth/tenant mapping is finalised
**Partial unique index:** `(client_id, contact_id) WHERE expires_at IS NULL` — prevents duplicate permanent suppressions
**Active suppression semantics:**
- `expires_at IS NULL` → permanent (always blocks eligibility)
- `expires_at > now()` → timed-active (blocks until timestamp)
- `expires_at <= now()` → expired/historical ONLY — does NOT block eligibility
**Reason CHECK constraint:** `unsubscribed | negative_reply | hard_bounce | do_not_contact | manual`
**Future extension:** A global do-not-contact mechanism (GDPR, cross-client DNC) will be a SEPARATE table checked BEFORE this one; no schema change to contact_suppression is needed
**Stage 15 key invariants:**
- Suppression is per-client — client A's suppression of contact X does not affect client B
- liftSuppression() sets expires_at = now() (historical) rather than deleting — preserves audit trail
- Expired records are retained; they are never automatically deleted

---

### `campaign_reviews`
**Purpose:** Client review and approval workflow. Tracks from sharing scripts → feedback → revisions → green light.
**Created by:** Migration 0006
**PK:** `id` (uuid)
**FKs:** `client_id → clients(id)` ON DELETE CASCADE, `campaign_id → campaigns(id)` ON DELETE SET NULL, `sequence_id → email_sequences(id)` ON DELETE SET NULL
**Parent:** clients + campaigns + email_sequences
**Children:** none
**Writes:** createCampaignReview(), updateCampaignReview(), approveCampaignReview() in campaign-reviews.ts
**Reads:** /cold-email-kickoff Step 4, operator review
**RLS:** ENABLED

---

## Migration vs. Dashboard

| Origin | Tables |
|--------|--------|
| Migration 0002 | clients, icp_onboarding |
| Migration 0003 | lead_magnets |
| Migration 0004 | campaign_strategies, campaign_plans |
| Migration 0005 | email_sequences, email_sequence_steps, list_quality_scores |
| Migration 0006 | campaign_reviews; alters lists, email_sequences, email_sequence_steps |
| Migration 0007 | Alters enrichment_runs (adds input_tokens, output_tokens, client_id) |
| Migration 0008 | Alters enrichment_runs (adds observability columns) |
| Migration 0009 | Alters jobs (idempotency_key); alters enrichment_runs (job_id, attempt_number) |
| Migration 0010 | Alters enrichment_runs (adds 'escalated' status) |
| Migration 0011 | signals |
| Migration 0012 | account_intelligence |
| Migration 0013 | Alters account_intelligence (priority_score, prioritized_at) |
| Migration 0014 | Alters campaigns (client_id, campaign_strategy_id, list_id, trigger); alters campaign_leads (client_id, composite FK); creates contact_suppression |
| Supabase Dashboard | companies, contacts, lists, list_members, enrichment_runs (base), jobs (base), campaigns (base), email_verifications |

## RLS Status Summary

| Status | Tables |
|--------|--------|
| RLS ENABLED | clients, icp_onboarding, lead_magnets, campaign_strategies, campaign_plans, email_sequences, email_sequence_steps, list_quality_scores, campaign_reviews, account_intelligence, **contact_suppression** |
| RLS NOT SET in migration | signals (security gap — see 25-SUPABASE-SECURITY.md FINDING 1) |
| RLS UNKNOWN (pre-migration) | companies, contacts, lists, list_members, enrichment_runs, jobs, campaigns, campaign_leads, email_verifications |

**Note:** The application exclusively uses the `service_role` key (via `getSupabaseAdmin()`), which bypasses RLS by design. No user-facing JWT auth is implemented. RLS would only matter if direct database access were granted outside service_role.
