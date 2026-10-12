# Supabase Database — Start Here

This is your complete guide to understanding the database that powers the GTM cold-outbound AI system. Start here. Read it once. Everything else in this folder builds on it.

---

## What is Supabase?

Supabase is a hosted PostgreSQL database with a REST API layer on top. In simple terms:

- **PostgreSQL** is the actual database engine — the same one used by major companies worldwide. It stores your data reliably and lets you query it with SQL.
- **Supabase** wraps PostgreSQL with a dashboard (so you can see your data in a browser), a REST API (so your code can read/write without raw SQL), authentication, and real-time subscriptions.

In this project, your TypeScript code talks to Supabase using the `@supabase/supabase-js` client. Every time the code calls `db.from("signals").insert(...)`, it's writing a row into your PostgreSQL database through Supabase's REST API.

---

## Core Concepts

### Table
A table is like a spreadsheet. It has columns (the fields, defined once) and rows (the data, one per record). Example: `companies` is a table where each row is one company you're targeting.

### Row
One record in a table. One company. One signal. One job. Each row has a value for every column.

### Column
One field in a table. `name`, `domain`, `status` are columns in `companies`. Every row in the table has a value for each column (or NULL if it's optional).

### Primary Key
Every table has a primary key — a column (always `id` in this system) that uniquely identifies each row. No two rows can have the same `id`. All IDs in this system are UUIDs: long random strings like `cac84e2a-caf5-4248-9190-17227de64af8`.

### Foreign Key
A foreign key is a column in one table that points to the `id` of another table. It's how tables connect.

Example: `signals.company_id` is a foreign key that points to `companies.id`. It means "this signal belongs to that company."

When you see `→` in this documentation, it means "points to":
```
signals.company_id → companies.id
```

---

## The Key IDs You'll See Everywhere

| ID | Table it lives in | What it identifies |
|----|-------------------|--------------------|
| `client_id` | `clients` | Your business — Gramscode, or any future client |
| `company_id` | `companies` | A target account you're prospecting |
| `contact_id` | `contacts` | A person at a target company |
| `list_id` | `lists` | A named batch of companies or contacts |
| `campaign_id` | `campaigns` | An active outreach campaign |
| `job_id` | `jobs` | A background Trigger.dev task |
| `signal_id` | `signals` | One buying signal event at a company |

Every piece of data in the system is scoped to a `client_id`. Gramscode's signals are invisible to any other client. This is **tenant isolation** — the multi-tenancy model.

**Global tables (no client_id):** `companies`, `contacts`, `lists`, `list_members` — these are shared infrastructure. The scoping lives on the rows that reference them (e.g. `signals.client_id`, `contact_suppression.client_id`, `campaigns.client_id`). Do not assume a table has `client_id` without checking — contacts and lists do NOT.

---

## The 30 Tables at a Glance

| # | Table | One-line purpose |
|---|-------|-----------------|
| 1 | `clients` | Your business identity — the top of every data chain |
| 2 | `icp_onboarding` | The 12 ICP questions and answers for each client |
| 3 | `lead_magnets` | Brainstormed free-offer ideas, ranked and selected |
| 4 | `campaign_strategies` | Campaign ideas (15-25 per client), each with an angle |
| 5 | `campaign_plans` | The synthesized one-page plan per client |
| 6 | `companies` | Target accounts being prospected |
| 7 | `contacts` | People at target companies (no client_id — global entity) |
| 8 | `lists` | Named batches of companies or contacts (no client_id — global) |
| 9 | `list_members` | Junction table linking lists to companies/contacts |
| 10 | `list_quality_scores` | Scorecard results for a list (A+ to F) |
| 11 | `email_verifications` | Email deliverability verification results |
| 12 | `enrichment_runs` | Every AI call — qualification, personalization, signal intelligence |
| 13 | `email_sequences` | Written email campaign sequences |
| 14 | `email_sequence_steps` | Individual emails in a sequence (Day 0, 3, 7, 11) |
| 15 | `signals` | Buying signals detected at target companies |
| 16 | `account_intelligence` | Derived scoring per (client, company) — opportunity_score + priority_score + why_now |
| 17 | `campaigns` | Active outreach campaigns — client-scoped (client_id added Stage 15) |
| 18 | `campaign_leads` | Individual leads assigned to a campaign (client_id + composite FK added Stage 15) |
| 19 | `campaign_reviews` | Client review and approval workflow |
| 20 | `jobs` | Background task queue for Trigger.dev operations |
| 21 | `contact_suppression` | Per-client safety gate — prevents suppressed contacts from being enrolled (added Stage 15) |
| 22 | `campaign_health_snapshots` | Append-only campaign send/open/reply/bounce metrics per snapshot (added Stage 18) |
| 23 | `domain_health_snapshots` | Append-only domain inbox aggregate (total/healthy/blocked inboxes) per snapshot (added Stage 18) |
| 24 | `inbox_health_snapshots` | Append-only per-inbox warmup/SMTP/IMAP health state per snapshot (added Stage 18) |
| 25 | `contact_intelligence` | Campaign-agnostic title classification + eligibility gate snapshot per (client, company, contact) — added Stage 23 |
| 26 | `contact_campaign_relevance` | Campaign-specific person relevance score + AI narrative per (client, company, contact, campaign_strategy) — added Stage 23 |
| 27 | `person_discovery_runs` | Most-recent Person Discovery Waterfall result per (client, company, campaign_strategy) — added Stage 24 |
| 28 | `person_discovery_attempts` | Per-provider attempt history within a person discovery run — added Stage 24 |
| 29 | `email_enrichment_runs` | Most-recent Email Enrichment Waterfall result per (client, contact, campaign_strategy); found_email never stored — added Stage 24 |
| 30 | `email_enrichment_attempts` | Per-provider attempt history within an email enrichment run — added Stage 24 |

---

## Architecture: The Full Picture

```
╔══════════════════════════════════════════════════════════════╗
║                    CAMPAIGN PIPELINE                         ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  clients                                                     ║
║    │  (who you are, which business)                          ║
║    ↓                                                         ║
║  icp_onboarding  ←  12 questions about your ideal customer   ║
║    │                                                         ║
║    ↓                                                         ║
║  lead_magnets    ←  free offers to attract prospects         ║
║    │                                                         ║
║    ↓                                                         ║
║  campaign_strategies  ←  15-25 campaign ideas ranked        ║
║    │                                                         ║
║    ↓                                                         ║
║  campaign_plans  ←  one synthesized page: ICP + offer + next ║
║    │                                                         ║
║    ├──────────────────────────────────────────────────────┐  ║
║    ↓                                                      ↓  ║
║  companies           lists                                ║  ║
║  (target accounts)     (named batches)                    ║  ║
║    │                     ↑                                ║  ║
║    └─────→ list_members ─┘                                ║  ║
║                │                                          ║  ║
║                ↓                                          ║  ║
║  contacts   enrichment_runs  list_quality_scores          ║  ║
║  (people)   (AI results)     (scorecard)                  ║  ║
║    │                                                      ║  ║
║    ↓                                                      ║  ║
║  email_verifications                                      ║  ║
║    │                                                      ║  ║
║    ↓                                                      ↓  ║
║  email_sequences ←  campaign_strategies ────────────────  ║  ║
║    │                                                         ║
║    ↓                                                         ║
║  email_sequence_steps  (Day 0, 3, 7, 11)                    ║
║    │                                                         ║
║    ↓                                                         ║
║  campaign_reviews  ←  client approves scripts + list         ║
║    │                                                         ║
║    ↓                                                         ║
║  campaigns  →  campaign_leads  →  OUTREACH SENT              ║
║       │                                                      ║
║       └──→  jobs  (Trigger.dev background tasks)             ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║                    SIGNAL ENGINE                             ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  PredictLeads API  (future: LinkedIn, Crunchbase, etc.)      ║
║       │                                                      ║
║       ↓   Trigger.dev signal-ingestion task                  ║
║  signals  ←  normalized buying events per company            ║
║  (job_posting, funding_round, executive_hire, etc.)          ║
║       │                                                      ║
║       ↓   computeFreshnessScore() + computeSignalStrength()  ║
║  ranked signals  (deterministic scoring, no AI here)         ║
║       │                                                      ║
║       ↓   enrichment_runs (task_type='signal_intelligence')  ║
║  AI WHY NOW analysis  →  whyNow + opportunityScore           ║
║       │                                                      ║
║       ↓                                                      ║
║  personalization  →  PERSONALIZED EMAIL COPY                 ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

## How Data Flows Through the System

Here is the journey of data from the first conversation to the first email sent:

**1. Client setup**
You create a client row in `clients` (e.g., Gramscode, slug='gramscode'). This is the anchor. Everything in the database belongs to a client.

**2. ICP onboarding**
You answer 12 questions (what you sell, target titles, headcount range, geography, etc.). Each answer is stored as a row in `icp_onboarding`, linked to your client via `client_id`.

**3. Lead magnet brainstorm**
The system generates 10 lead magnet ideas (A-J archetypes). Each is a row in `lead_magnets`. You pick the best one (status → 'selected').

**4. Campaign strategy**
The system generates 15-25 campaign angle ideas. Each is a row in `campaign_strategies`. You rank and approve the top 3.

**5. Campaign plan**
Everything synthesizes into one row in `campaign_plans` — your ICP summary, offer, top campaign names, and next steps.

**6. List building**
Scripts pull companies from Prospeo (or Apify, etc.) and write rows to `companies`. Each company is linked to a named list via `list_members`. The list itself is one row in `lists`.

**7. AI qualification**
For each company in the list, an AI runs ICP qualification. The result is stored in `enrichment_runs` (one row per AI call). The company's `icp_score` is updated.

**8. List scorecard**
You run the quality scorecard on your list. The result is one row in `list_quality_scores` with a grade (A+ to F) and eight dimension scores.

**9. Email verification**
Emails are verified via Millionverifier or Enirchley. Results go into `email_verifications`.

**10. Clay enrichment**
Contacts are added from Clay. New rows in `contacts`. The `lists.enrichment_status` advances from 'pending' → 'clay_imported' → 'enriched' → 'verified' → 'ready'.

**11. Copywriting**
You write the email sequence. One row in `email_sequences` (the overall campaign sequence). Four rows in `email_sequence_steps` — one for each touch (Day 0, Day 3, Day 7, Day 11).

**12. Client review**
You share the scripts and list with the client. One row in `campaign_reviews` tracks the whole process from sharing → feedback → revisions → green light approval.

**13. Launch**
A campaign is created in `campaigns`. Each contact gets a row in `campaign_leads`. A Trigger.dev background job is tracked in `jobs`.

**14. Signals (parallel track)**
While all of the above happens, PredictLeads signal ingestion runs via Trigger.dev. For each target company, new job postings and financing events become rows in `signals`. The AI can then reason over these signals to generate a "why now" for personalized outreach.

---

## Where Jobs and Enrichment Runs Fit

**`jobs`** is the task queue. Every Trigger.dev background operation — whether it's qualifying a list, running signal ingestion, or sending a campaign — creates a row in `jobs`. It tracks: what type of task, what its status is (pending → running → completed), how many items were processed, and any error messages. It's your operational visibility layer.

**`enrichment_runs`** is the AI ledger. Every single AI call made by the system writes one row here. It records: which model was used, how many tokens were consumed, what the cost was, how long it took, whether it succeeded, and (for multi-tier escalation) which cheaper attempt it escalated from. This table is how you understand AI cost and performance over time.

---

## For Deeper Reading

- **01-DATABASE-MAP.md** — Complete relational map of every table
- **02-CLIENTS.md through 20-CAMPAIGN-REVIEWS.md** — Deep docs for each table
- **21-CAMPAIGN-DATA-FLOW.md** — Step-by-step campaign walkthrough with real row examples
- **22-FOLLOW-A-COMPANY.md** — How to trace one company through every table
- **23-FOLLOW-A-CAMPAIGN.md** — How to trace one campaign through every table
- **24-SUPABASE-CONCEPTS.md** — Progressive learning guide (6 levels)
- **25-SUPABASE-SECURITY.md** — RLS status and security issues
- **99-SUPABASE-CHANGELOG.md** — Every database change, in order

**Health snapshot tables (Stage 18):** `campaign_health_snapshots`, `domain_health_snapshots`, and `inbox_health_snapshots` are documented in `99-SUPABASE-CHANGELOG.md` migration 0016. Their application layer lives in `src/db/health-snapshots.ts` and `src/lib/health-snapshots.ts`.
