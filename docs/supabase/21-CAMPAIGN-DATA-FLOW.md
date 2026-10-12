# Campaign Data Flow

This document traces the complete journey of data through the system — from a client's first onboarding question to a cold email landing in a prospect's inbox. Every table involved is named, with the exact write that occurs at each step.

## The Full Pipeline

```
PHASE 1: ONBOARDING (Weeks 1-2)
  /icp-onboarding → clients + icp_onboarding
  /lead-magnet-brainstorm → lead_magnets (selected = 1, others rejected)
  /campaign-strategy → campaign_strategies (15-25 ideas brainstormed)
  /cold-email-kickoff Step 5 → campaign_plans (synthesized brief)

PHASE 2: INFRASTRUCTURE (Weeks 2-4, parallel)
  → Domain purchase (external: Dynadot API)
  → Inbox warmup (external: Smartlead warmup pool)
  → 2-week warmup window — no writes to DB during this phase

PHASE 3: LIST BUILDING (Weeks 3-4)
  list-builder skill → companies (insert/upsert)
  list-builder skill → lists (1 list per run)
  list-builder skill → list_members (1 row per company)

PHASE 4: QUALIFICATION (Weeks 3-4, runs during warmup)
  qualify-list.ts reads list_members → companies
  For each company:
    → enrichment_runs (one AI call per company)
    → companies.icp_score (updated)

PHASE 5: ENRICHMENT (Weeks 3-5)
  Clay import → lists.clay_imported_at, lists.enrichment_status = 'clay_imported'
  Clay enrichment → contacts (Prospeo data: email, title, LinkedIn)
  Email verification → email_verifications (Millionverifier/Enirchley)
  After all done → lists.enrichment_status = 'verified'

PHASE 6: CONTACT SOURCING (Week 4)
  prospeo-pull.ts → contacts (insert)
  prospeo-pull.ts → list_members (insert contact→list links)

PHASE 7: LIST SCORING (Week 4)
  /list-quality-scorecard → list_quality_scores (full 8-dimension scorecard)
  If grade < B → fix list → re-score
  If grade B+ → proceed

PHASE 8: SIGNALS (Week 4-5, Stage 10+)
  signal ingestion task runs:
    → jobs (one job row for the ingestion run)
    → signals (3,000+ rows for target companies)
  Signal intelligence task:
    → enrichment_runs (AI analysis of signals per company)

PHASE 9: COPYWRITING (Week 5)
  /campaign-copywriting skill:
    → email_sequences (1 row per angle)
    → email_sequence_steps (4 rows per sequence: Day 0/3/7/11)
  /spam-word-checker → reads steps, flags issues (no DB write)

PHASE 10: CLIENT REVIEW (Week 5-6)
  /campaign-review opens cycle:
    → campaign_reviews (status = pending_review)
  Scripts shared → campaign_reviews (status = scripts_shared, scripts_share_url)
  List shared → campaign_reviews (status = list_shared, list_share_url)
  Feedback received → campaign_reviews (client_feedback, status = feedback_received)
  Revisions made → campaign_reviews (revision_notes, revision_count++, status = revisions_made)
  Green light → campaign_reviews (approved_by, approved_at, status = approved)

PHASE 11: CAMPAIGN LAUNCH (Week 6)
  /smartlead-campaign-upload-public:
    → campaigns (new row, status = draft)
    → campaign_leads (one row per contact uploaded)
    → Smartlead API (external — uploads as DRAFT, never auto-launches)
  Human clicks Start in Smartlead
    → campaigns.status = active, campaigns.launched_at

PHASE 12: ACTIVE SENDING (Weeks 6-9, 21-day window)
  External: Smartlead sends Day 0 → Day 3 → Day 7 → Day 11
  Replies: Smartlead receives, webhooks update campaign_leads
    → campaign_leads.status, reply_received_at, reply_classification
  
PHASE 13: ITERATION (Week 9+)
  /positive-reply-scoring → reads campaign_leads, classifies replies
  /experiment-design → reads campaign_leads results, calculates metrics
  Next iteration starts back at PHASE 3 or PHASE 9
```

## Data Written at Each Phase

| Phase | Table Written | Key Field Set |
|-------|--------------|---------------|
| 1a | clients | slug, name |
| 1a | icp_onboarding | question_key, answer |
| 1b | lead_magnets | archetype_key, score, status=selected |
| 1c | campaign_strategies | campaign_name, rank, status=approved |
| 1d | campaign_plans | business_summary, infrastructure_status |
| 3 | companies | domain, status=review |
| 3 | lists | name, source |
| 3 | list_members | list_id, company_id |
| 4 | enrichment_runs | provider, cost_usd, status=completed |
| 4 | companies | icp_score (updated) |
| 5 | contacts | email, job_title, email_status |
| 5 | email_verifications | status=valid/invalid |
| 5 | lists | enrichment_status=verified |
| 6 | contacts | (prospeo data) |
| 6 | list_members | list_id, contact_id |
| 7 | list_quality_scores | grade, overall_score, 8 dimensions |
| 8 | jobs | job_type=predictleads, status=completed |
| 8 | signals | signal_type, signal_strength, occurs_at |
| 8 | enrichment_runs | task_type=signal_intelligence |
| 9 | email_sequences | name, value_prop_type, status=draft |
| 9 | email_sequence_steps | step, variants, has_personalization |
| 10 | campaign_reviews | status pipeline from pending → approved |
| 11 | campaigns | platform_campaign_id, status=draft, platform=plusvibe (live default) |
| 11 | campaign_leads | contact_id, status=ready (live default) |
| 12 | campaign_leads | status=sent/replied, reply_classification |

## What the "Signal Layer" Changes

The signal ingestion (Stage 10/11) adds a parallel intelligence track that runs during list building and qualification:

```
companies (target accounts)
  ↓
signals (buying signals from PredictLeads)
  ↓
enrichment_runs (AI reasoning: "why contact NOW?")
  ↓
email_sequence_steps.variants[].body (personalized with signal context)
```

This means a contact at a company that just raised a Series A gets an email mentioning the funding round and connecting it to the value proposition. The signal layer makes the outreach timely, not just targeted.

## Key Invariants

1. **Every company query scopes by client_id** — multi-tenant isolation
2. **Sequences are always uploaded as DRAFT** — no auto-launch
3. **Enrichment runs are append-only** — never update, always insert new
4. **Signals deduplicate via (client_id, dedup_key)** — idempotent ingestion
5. **list_quality_score gate** — grade B or better required before campaign upload
6. **campaign_reviews gate** — approved_at required before launch
