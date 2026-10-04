# Gramscode Outbound System — Full Overview
**Last Updated:** 2026-08-22
**Author:** Claude Code (AI build partner)

---

## What This System Is (The Big Picture)

Gramscode is building a **done-for-you cold outbound machine** — a system that finds the right companies, researches them, qualifies them with AI, writes personalised emails, and tracks everything from first contact to booked meeting.

The system does two jobs at once:

1. **It runs outbound FOR Gramscode** (finding clients for Gramscode's own GTM/outbound service)
2. **It IS the product** — the same engine gets used to run outbound for any business Gramscode onboards as a client

Everything lives in Supabase (the database). Every action the system takes — finding a company, qualifying it, writing copy, scoring a list — gets stored there so you always have a record, can inspect what happened, and can connect it to Clay for a visual dashboard.

---

## How We Got Here — The Build Journey

### Phase 1: The Research Engine (Stage 1–5)
*Built: 2026-08-21*

Before we could do anything, we needed a brain that could find companies and decide if they're worth contacting.

**Stage 1 — Foundation**
Built the modular code structure inside `src/`. This is the backbone — it defines what a "company record" looks like, how providers (data sources) talk to each other, and how duplicates get removed. Nothing touches the internet yet, just structure.

**Stage 2 — Supabase Connected**
Wired the code to the live Supabase database. The system can now read and write real data. Tested with a full round-trip: write a record → read it back → confirm it worked.

**Stage 3 — First Data Source: Apify Google Maps**
The owner chose **Apify** as the first lead sourcing tool. Built the Apify Google Maps provider — it takes a search (e.g. "marketing agencies in Austin, TX") and returns real business data. Tested live: searched, got results, normalised them, removed duplicates.

**Stage 4 — Trigger.dev Pipeline (Background Jobs)**
Built the full automated pipeline using Trigger.dev (a background job runner):
- Source companies from Apify
- Remove duplicates
- Fan out to child workers that store each company in Supabase
- Track the whole job in the `jobs` table
- Verified live: 5 companies sourced → 5 stored, all linked to a test list

**Stage 5 — AI Qualification (Built, Pending API Key)**
Built the AI qualification layer using Claude. It reads each company and scores it against the ICP (Ideal Customer Profile) — deciding whether it's a good prospect or not. Structured to write results to `enrichment_runs`. Currently waiting on `ANTHROPIC_API_KEY` to be added to `.env` before it can run live.

---

### Phase 2: The Skills Layer (Kickoff Flow)
*Built: 2026-08-22*

This is the **client-facing part** — the step-by-step process for onboarding any business onto cold outbound.

The kickoff flow runs in order:

```
ICP Onboarding → Lead Magnet Brainstorm → Campaign Strategy
→ Campaign Plan → List Building → List Quality Check
→ Campaign Copywriting → Send (PlusVibe, DRAFT only)
```

Every stage now has:
- A **Supabase table** to store its output (so nothing is lost)
- A **db module** in code to read/write that table
- A **show script** so you can inspect the data any time

---

## Every Table — What It Is, What Goes In, What It Does

### CLIENT MANAGEMENT

---

#### `clients`
**What it is:** The master list of every business you're running outbound for.

**What goes in:**
- Business name (e.g. "Gramscode")
- Website URL
- A slug (short ID used everywhere, e.g. "gramscode")

**What it does:** Acts as the anchor. Every other table links back here via `client_id`. When you add a new client, you add one row here first — then everything else (their ICP answers, their campaigns, their email copy) hangs off that row.

**Clay view:** A simple list of your clients. Click one to see everything about them across all other tables.

---

#### `icp_onboarding`
**What it is:** The 12-question intake interview answers for each client.

**What goes in:** One row per question per client:
1. What do you sell?
2. Who is your best customer?
3. What job title buys this?
4. Target headcount range?
5. Which industries are IN / OUT?
6. Geography?
7. Any buying triggers to personalise on?
8. Any domains/companies to exclude?
9. What's your offer / CTA?
10. What's your lead magnet?
11. What tone — casual or formal?
12. Any legal/banned word constraints?

**What it does:** Every other skill in the system reads these answers. The ICP answers tell the list-building tools who to find, tell the copywriting tool what to say, and tell the AI qualifier what "good" looks like. Without this, everything downstream is guessing.

**Clay view:** Per-client Q&A grid. See all 12 answers at a glance, with ✓ for answered and · for blank.

---

### CAMPAIGN PLANNING

---

#### `lead_magnets`
**What it is:** Brainstormed lead magnet ideas per client — the free thing you offer in the cold email to get a reply.

**What goes in:** One row per idea:
- Archetype (e.g. "free_audit", "data_report", "template", "quick_win_work")
- Name and description
- How you'd actually deliver it
- Example CTA line for the cold email (e.g. "Reply Y and I'll send it over")
- Rubric score out of 20 (cheap to deliver + genuinely valuable + shows competence + unique)
- Rank (1 = top pick) and status (draft / selected / rejected)

**What it does:** A cold email with "book a call" as the ask gets 3-10x fewer replies than one with a concrete free offer. This table stores the brainstorm so you're not reinventing it every campaign — you pick from what's already been scored and ranked.

**Clay view:** Ranked list of offer ideas per client. See which one was selected and why.

---

#### `campaign_strategies`
**What it is:** The 15–25 campaign ideas generated per client — the full menu of targeting angles before you pick which one to run first.

**What goes in:** One row per campaign idea:
- Campaign name (e.g. "New Hire Welcome", "Creative Use Case", "Lookalike — Funded SaaS")
- Targeting level (Broad / Focused / Niche)
- List filters (what makes this list different from the base ICP)
- AI strategy (how personalisation works at scale)
- Value proposition (what you're promising — make money / save time / save money)
- Full campaign overview (enough detail to hand off to a copywriter)
- Whether it uses AI or is a static "no-AI" campaign
- Whether it's a front-end offer (softer first step before the main pitch)
- Rank and status

**What it does:** Most businesses launch one campaign and call it their strategy. This table captures a full menu of angles so you can test, learn, and rotate. The best operators run 3–5 campaigns simultaneously, each targeting a different slice of the ICP.

**Clay view:** Campaign ideas table, sortable by targeting level or value prop. Approved ones are flagged green.

---

#### `campaign_plans`
**What it is:** The synthesised one-page summary that brings ICP + lead magnet + top campaigns together into a single plan per client.

**What goes in:** One row per client (updated as drafts evolve):
- Business summary (one-liner)
- ICP summary (compiled from onboarding answers)
- Offer summary (CTA + chosen lead magnet)
- Infrastructure status (do they have sending domains? warmed inboxes? API keys?)
- Top 3 campaign names chosen from `campaign_strategies`
- Next steps (branched: if no infra → set up domains; if infra ready → build list)
- Status (draft / approved)

**What it does:** This is the document you'd show a client or a stakeholder. It answers "what are we doing and why" in one page. Also the handoff document to whoever runs the campaigns.

**Clay view:** One-row-per-client summary card. The executive overview of each client's outbound plan.

---

### LIST BUILDING & PROSPECTS

---

#### `companies`
**What it is:** Every prospect company the system has sourced — from Apify Google Maps, or any future provider.

**What goes in:** One row per company:
- Name, domain, website
- Industry, city, country
- Phone, description
- ICP score (set by AI qualification in Stage 5)
- Status: `review` (new, needs human check) / `approved` (ready to contact) / `rejected` (not a fit)
- Source (which provider found them)

**What it does:** The core prospect database. Every company the system finds from any source lands here first, deduplicated by domain. The AI qualification step scores them, humans approve or reject, and approved ones move toward campaigns.

**Clay view:** Your prospect pipeline. Filter by status, ICP score, industry, or source. Approve/reject directly in Clay.

---

#### `contacts`
**What it is:** The individual people at each company — the actual humans who receive the emails.

**What goes in:** One row per person:
- First name, last name, email
- Job title
- LinkedIn URL
- Company they work at (linked to `companies`)
- Email verification status

**What it does:** Companies don't reply to emails — people do. This table stores the actual decision-makers found via enrichment tools (Prospeo, Apollo, etc.). Linked to `companies` so you can always see which company each person belongs to.

**Clay view:** Contact list, filterable by title, company, or verification status. Your actual send list.

---

#### `lists`
**What it is:** Named groups of companies — the output of each list-building run.

**What goes in:** One row per list:
- Name (e.g. "Marketing Agencies Austin TX — Aug 2026")
- Environment (test / production)
- Status (active / archived)
- Created date

**What it does:** Organises companies into batches so you can track which list a campaign was run against. A list might be "500 SaaS companies, Series A, US" or "200 restaurants in Miami." Having them named and dated means you never accidentally re-send to the same companies.

**Clay view:** List registry. See all your sourcing runs, how many companies in each, and which ones have been sent to.

---

#### `list_members`
**What it is:** The link between companies and lists (one company can be in multiple lists).

**What goes in:** One row per company-list pair:
- Which company
- Which list it belongs to

**What it does:** A junction/linking table. It's what lets you say "show me all companies in the Austin August list" without duplicating company data. Supabase and Clay both follow these links automatically.

**Clay view:** Not usually viewed directly — it powers the relationships between `companies` and `lists`.

---

### ENRICHMENT & VERIFICATION

---

#### `enrichment_runs`
**What it is:** A log of every enrichment or AI qualification job run against a company.

**What goes in:** One row per enrichment action:
- Which company was enriched
- Which provider did it (e.g. "claude-opus-4-8", "prospeo", "millionverifier")
- What operation was performed (e.g. "ai_qualification", "email_find", "company_news")
- The raw input sent to the provider
- The raw output received back
- When it happened

**What it does:** Full audit trail of every enrichment. If a company gets a bad AI score, you can see exactly what data the AI was given and what it said. Also used to avoid re-running expensive enrichments on the same company twice.

**Clay view:** Enrichment log. Filter by operation type or provider to see what's been run and what it returned.

---

#### `email_verifications`
**What it is:** The results of running every email address through a verification service.

**What goes in:** One row per email verified:
- The email address
- Which contact it belongs to
- Verification result (valid / invalid / catch-all / unknown)
- The provider that verified it (e.g. MillionVerifier)
- When it was verified

**What it does:** Unverified emails = bounces = dead sending domains. Every email must be verified before it goes into a campaign. This table proves it was done and stores the result, so you don't re-verify the same email and waste credits.

**Clay view:** Verification coverage report. See what % of contacts are verified, which ones failed, and which need re-verification.

---

### COPYWRITING

---

#### `email_sequences`
**What it is:** The written email campaigns — one sequence per campaign idea per client.

**What goes in:** One row per written campaign:
- Which client and which campaign strategy it was written for
- The campaign angle (the overall approach in 1–2 sentences)
- Target audience, core pain point, value proposition
- The proof point / case study referenced
- AI variables used (e.g. `{{ai_company_mission}}`, `{{ai_customer_type}}`)
- Overall copy score (0–100 based on the QA rubric)
- Status (draft / approved / active / archived)

**What it does:** Stores the strategic brief for each sequence. Linked to the steps table below for the actual email text. Having this in Supabase means you can compare sequences across clients, track which ones performed, and never lose approved copy.

**Clay view:** Campaign copy library. Filter by client, status, or score. Approved sequences ready to send are flagged.

---

#### `email_sequence_steps`
**What it is:** The actual emails — one row per email in the sequence (Day 0, Day 3, Day 7, Day 11).

**What goes in:** One row per email step:
- Which sequence it belongs to
- Step number (1–4) and delay in days (0, 3, 7, 11)
- Whether it's a new thread or replies to the previous email
- Strategy type (problem-sniffing / billboard / creative-ideas / redirect / value-bomb)
- Value prop angle (save time / make money / save money / value bomb)
- Subject line options (2–3 variants)
- Full email variants (A, B, C) with subject and body text — including all `{{variables}}`

**What it does:** The actual words that go into PlusVibe. The 4-step sequence (Day 0 → Day 3 threaded → Day 7 new thread → Day 11 final) is a proven structure: each email uses a different value prop angle so if one didn't land, the next one tries a different angle. Storing each step separately makes it easy to A/B test individual emails.

**Clay view:** Full sequence viewer. See all 4 emails for any campaign, with their variants side by side.

---

### LIST QUALITY

---

#### `list_quality_scores`
**What it is:** The scored report card for each list before it gets sent to.

**What goes in:** One row per scoring run:
- Which client and which list was scored
- Total rows in the list
- **Letter grade** (A+ to F)
- **Overall score** (0–100)
- 8 individual dimension scores:
  1. Email verification coverage (are all emails verified?)
  2. Duplicate email rate (how many repeats?)
  3. Duplicate domain rate (are you over-indexing on one company?)
  4. Title relevance (do job titles match the ICP?)
  5. Bad title detection (any interns, assistants, students in the list?)
  6. Catch-all domain density (risky email addresses like info@ or hello@?)
  7. ICP fit (industry + headcount match declared ICP?)
  8. Name quality (are first/last names clean and human?)
- Top 5 issues found
- Pre-send checklist

**What it does:** Catches bad lists before they burn your sending reputation. A C-grade list will produce reply rates below 1% and can damage domain deliverability. This table stores the score so you have proof of quality before every campaign launch — and a history of list health over time.

**Clay view:** Quality dashboard. See grades across all lists, track improvement over time, and flag anything below B before it goes to PlusVibe.

---

### SENDING

---

#### `campaigns`
**What it is:** The actual email campaigns created in PlusVibe (the sending platform).

**What goes in:** One row per campaign:
- Campaign name
- Linked client
- Which email sequence it uses
- Sending schedule (timezone, days, hours, max leads/day)
- Status (draft / active / paused / complete)
- PlusVibe campaign ID (for syncing back)
- Launch date

**What it does:** The bridge between what's planned (in `email_sequences`) and what's live (in PlusVibe). Campaigns are ALWAYS created as DRAFT — a human presses Start manually. This table tracks every campaign ever created so you have a full history.

**Clay view:** Active campaign tracker. See what's live, what's in draft, and sending stats per campaign.

---

#### `campaign_leads`
**What it is:** Every lead added to every campaign.

**What goes in:** One row per lead-campaign pair:
- Which contact (from `contacts`)
- Which campaign they're in
- Status (pending / sent / replied / bounced / unsubscribed)
- When they were added
- Reply or bounce details

**What it does:** Tracks the journey of every individual lead through every campaign. Lets you answer: "Has this person already been in a previous campaign?" (avoid re-sending), "What's our bounce rate on this campaign?" (deliverability health), "Who replied?" (reply handling).

**Clay view:** Lead-level pipeline. See every lead's status across campaigns. Filter for replies, bounces, or leads never contacted.

---

### INTERNAL / ORCHESTRATION

---

#### `jobs`
**What it is:** Background job tracking for the Trigger.dev automation layer.

**What goes in:** One row per background job run:
- Job type (e.g. "company-research")
- Status (pending / running / complete / failed)
- Input parameters (what the job was asked to do)
- Result summary
- Started/completed timestamps

**What it does:** Trigger.dev runs the heavy lifting in the background — sourcing companies, running enrichment batches, qualifying lists. This table logs every job so you can see what ran, when, and whether it succeeded or failed. Purely internal — not useful for Clay.

**Clay view:** Excluded from Clay (internal orchestration only).

---

## The Full Flow — How It All Connects

```
CLIENT ONBOARDED
       │
       ▼
clients ──────────────────────────────────────┐
       │                                       │
       ▼                                       ▼
icp_onboarding (Q1-Q12)              campaign_plans (the 1-page plan)
       │                                       ▲
       ▼                                       │
lead_magnets (free offer ideas)       campaign_strategies (15-25 ideas)
                                               │
                                               ▼
                    ┌──────────────────────────┘
                    │
                    ▼
RESEARCH ENGINE RUNS
       │
       ├── companies (sourced via Apify)
       │       └── list_members → lists (grouped batches)
       │
       ├── enrichment_runs (AI qualification, Claude scores each company)
       │
       └── contacts (people found at approved companies)
               └── email_verifications (every email checked)
                           │
                           ▼
              list_quality_scores (grade the list before sending)
                           │
                   Grade ≥ B? PROCEED
                           │
                           ▼
              email_sequences (the campaign brief)
                    └── email_sequence_steps (the 4 actual emails)
                                   │
                                   ▼
                         campaigns (created in PlusVibe, DRAFT)
                              └── campaign_leads (every lead tracked)
                                         │
                                         ▼
                                  HUMAN PRESSES START
                                  (Never automated)
```

---

## What This Means for Businesses

Any business Gramscode onboards gets:

1. **A researched, qualified list** — not a generic CSV download, but companies that have been AI-scored against their specific ICP
2. **Personalised email sequences** — not templates, but copy written around their actual offer, proof points, and the specific pain of their target audience
3. **A clean list** — verified emails, no bad titles, no domain over-concentration, graded B or above before anything sends
4. **Full Supabase visibility** — every step stored, every decision traceable
5. **Clay dashboard** — visual overview of the entire pipeline from client onboarding to active campaigns
6. **Safety by design** — campaigns always launch as DRAFT; a human reviews and presses Start; never automated sending

The result: a repeatable outbound system that any business can plug into, with everything tracked in one place.

---

## Current Status (2026-08-23)

### API Keys
| Key | Status | Notes |
|---|---|---|
| `SUPABASE_URL` + `SUPABASE_SECRET_KEY` | ✅ Live | All tables accessible |
| `APIFY_API_TOKEN` | ✅ Live | Google Maps sourcing working |
| `PROSPEO_API_KEY` | ✅ Live | Search 39/50 used today, Enrich 32/50 used today |
| `DISCOLIKE_API_KEY` | ⚠️ Key set, blocked | Account needs subscription upgrade |
| `APOLLO_API_KEY` | ⚠️ Key set, blocked | Free plan — needs upgrade for API search |
| `ANTHROPIC_API_KEY` | ❌ Missing | Blocks Stage 5 AI qualification |
| `MILLIONVERIFIER_API_KEY` | ❌ Missing | Needed for email verification waterfall |
| `HUNTER_API_KEY` | ❌ Missing | Needed for email waterfall step 2 |
| `SMARTLEAD_API_KEY` | ❌ Missing | Sending platform (PlusVibe preferred per Master Plan) |

---

### System Components
| Component | Status |
|---|---|
| Research engine (Stages 1–4) | ✅ Live and tested |
| AI qualification (Stage 5) | ⏳ Built — waiting on `ANTHROPIC_API_KEY` |
| All 17 Supabase tables | ✅ Created and accessible |
| Clay integration architecture | ✅ Confirmed — Supabase → Clay → CSV export → Supabase import |
| **Gramscode** — client record | ✅ In Supabase (slug: `gramscode`) |
| **Gramscode** — ICP onboarding Q1 | ✅ Answered |
| **Gramscode** — ICP onboarding Q2–12 | ⬜ Pending owner input |
| **ROCI Agency** — client record | ✅ In Supabase (slug: `roci`) |
| **ROCI Agency** — ICP onboarding (12/12) | ✅ Complete |
| **ROCI Agency** — 200 contacts pulled | ✅ In Supabase, list: "ROCI ICP - UK Agency Founders Aug 2026" |
| **ROCI Agency** — 33 emails enriched | ✅ Real emails written to Supabase |
| **ROCI Agency** — 17 email no-matches | ⏳ Waterfall needed (Hunter → pattern → MillionVerifier) |
| **ROCI Agency** — 150 contacts unenriched | ⏳ Enrich 50/day until done (resets daily) |
| **ROCI Agency** — email verification | ⬜ Needs MillionVerifier key |
| **ROCI Agency** — list quality scorecard | ⬜ Run after emails enriched |
| **ROCI Agency** — campaign copywriting | ⬜ Lead magnet selection first |
| Lead magnet brainstorm (any client) | ⬜ Not yet run |
| Campaign strategy (any client) | ⬜ Not yet run |
| PlusVibe sending setup | ⬜ Domains/inboxes warmed — ready when campaigns written |

---

### Scripts Available
| Script | What it does |
|---|---|
| `npx tsx src/scripts/show-icp.ts` | List all clients |
| `npx tsx src/scripts/show-icp.ts <slug>` | View any client's full ICP onboarding |
| `npx tsx src/scripts/show-contacts.ts` | List all contact lists |
| `npx tsx src/scripts/show-contacts.ts "<name>"` | View contacts in a list |
| `npx tsx src/scripts/prospeo-pull.ts --list-name="..." --pages=8` | Pull contacts from Prospeo into Supabase |
| `npx tsx src/scripts/prospeo-enrich.ts --list="..." --limit=50` | Reveal real emails (50/day limit) |
| `npx tsx src/scripts/seed-roci-icp.ts` | Re-seed ROCI ICP onboarding (safe to re-run) |
| `npx tsx src/scripts/inspect-schema.ts` | Show all Supabase table schemas |
| `npx tsx src/scripts/show-list.ts <listId>` | Show companies in a list |

---

### What's Next (Priority Order)
1. **Add `ANTHROPIC_API_KEY`** → unlocks Stage 5 AI qualification on all lists
2. **Add `MILLIONVERIFIER_API_KEY`** → unlocks email verification + waterfall for 17 ROCI no-matches
3. **Add `HUNTER_API_KEY`** → waterfall step 2 for no-matches
4. **Run email enrich daily** → `npx tsx src/scripts/prospeo-enrich.ts --list="ROCI" --limit=50` (until all 200 done)
5. **Gramscode ICP Q2–12** → complete onboarding so Gramscode campaign can start
6. **ROCI lead magnet selection** → pick from brainstorm before writing copy
7. **ROCI campaign copywriting** → Step 6 of GTM framework, email sequences
8. **DiscoLike / Apollo plan upgrades** → unlock TAM mapping and automated list sourcing

---

## Campaign Strategy Workflow

This is the exact order of operations for taking any business from zero to a live cold email campaign. Every step maps to a Supabase table where the output is stored.

---

### STEP 1 — Onboard the Client
**Skill:** `/icp-onboarding`
**Table:** `clients` + `icp_onboarding`

- [ ] Add the business to the `clients` table (name, website, slug)
- [ ] Answer the 12 ICP onboarding questions (Q1–Q12) and save each answer
- [ ] Confirm: What do you sell? Who buys it? What titles? What headcount? What industries? What geography?
- [ ] Confirm: What triggers matter? What domains to exclude? What's the CTA? What's the tone? Any legal constraints?
- [ ] All 12 questions answered before moving to Step 2

---

### STEP 2 — Choose a Lead Magnet (Free Offer)
**Skill:** `/lead-magnet-brainstorm`
**Table:** `lead_magnets`

- [ ] Run the brainstorm using Q1 (what you sell) and Q9 (your CTA) as inputs
- [ ] Generate 5–10 magnet ideas across the archetypes (free audit, data report, template, quick-win work, etc.)
- [ ] Score each idea out of 20 (cheap to deliver + genuinely valuable + shows competence + unique)
- [ ] Rank the top 2–3 ideas
- [ ] Owner selects one — status set to `selected` in `lead_magnets`
- [ ] The chosen magnet becomes the hook for all email copy downstream

---

### STEP 3 — Generate Campaign Ideas
**Skill:** `/campaign-strategy`
**Table:** `campaign_strategies`

- [ ] Pull the ICP answers from `icp_onboarding` and the chosen lead magnet from `lead_magnets`
- [ ] Research the client's website (case studies, pricing signals, who they've helped)
- [ ] Generate 15–25 campaign ideas ranging from broad to niche — stored as individual rows
- [ ] Every output must include: Creative Use Case campaign, New Hire campaign, Lookalike campaign (these 3 are non-negotiable)
- [ ] Add at least 2–3 creative stretch campaigns beyond the obvious
- [ ] Add at least 1 no-AI static campaign
- [ ] Add 1–3 front-end offer suggestions
- [ ] Owner reviews all rows in `campaign_strategies`, marks top picks with rank 1/2/3 and status `approved`

---

### STEP 4 — Synthesise the Campaign Plan
**Skill:** `/cold-email-kickoff` (Step 5)
**Table:** `campaign_plans`

- [ ] Pull from all three previous steps: ICP summary, chosen lead magnet, top 3 approved campaigns
- [ ] Record infrastructure status (domains? inboxes warmed? API keys in .env?)
- [ ] Write the one-page plan: business summary, ICP, offer, top 3 campaigns, next steps
- [ ] Save to `campaign_plans` with status `draft`
- [ ] Owner reviews and approves — status set to `approved`
- [ ] This is the document you show stakeholders. Nothing moves to Step 5 without an approved plan.

---

### STEP 5 — Source the Prospect Companies
**Skill:** Research Engine (Trigger.dev pipeline)
**Tables:** `companies`, `lists`, `list_members`, `jobs`

- [ ] Define the search parameters from the approved ICP (industry, geography, headcount, any triggers)
- [ ] Run the company research pipeline (Apify Google Maps or future provider)
- [ ] Companies land in `companies` table with status `review`
- [ ] They are grouped into a named list in `lists` and linked via `list_members`
- [ ] Background job tracked in `jobs` — confirm it completed successfully
- [ ] Target: enough companies to produce 500–2,000 verified contacts after enrichment and filtering

---

### STEP 6 — Find Contacts + AI Qualify
**Skills:** Enrichment tools + `/icp-prompt-builder`
**Tables:** `contacts`, `enrichment_runs`

- [ ] For each approved company, find the right contact (title match from Q3 of ICP onboarding)
- [ ] Contacts stored in `contacts` table linked to their company
- [ ] Run AI qualification (Claude) against each company — scores stored in `enrichment_runs`
- [ ] Update `companies.icp_score` based on AI output
- [ ] Companies scoring below threshold → status set to `rejected` (do not contact)
- [ ] Companies scoring above threshold → status set to `approved` (ready for next step)
- [ ] **Gate:** Do not proceed until ANTHROPIC_API_KEY is in `.env` and qualification has run

---

### STEP 7 — Verify Every Email
**Tool:** MillionVerifier (or equivalent)
**Table:** `email_verifications`

- [ ] Run every contact email through the verification tool
- [ ] Results stored in `email_verifications` (valid / invalid / catch-all / unknown)
- [ ] Remove all invalid emails from the contact list
- [ ] Flag catch-all addresses — deprioritise or drop depending on volume
- [ ] Target: 100% verification coverage before scoring the list
- [ ] **Gate:** Do not score or send until all emails are verified

---

### STEP 8 — Score the List
**Skill:** `/list-quality-scorecard`
**Table:** `list_quality_scores`

- [ ] Run the scorecard against the verified contact list
- [ ] Scores stored across 8 dimensions: verification coverage, duplicate emails, duplicate domains, title relevance, bad titles, catch-all density, ICP fit, name quality
- [ ] Overall letter grade calculated (A+ to F)
- [ ] If grade is **B or above** → proceed to Step 9
- [ ] If grade is **C or below** → fix the top issues flagged (bad titles, duplicates, ICP drift), re-run scorecard, do not proceed until grade ≥ B
- [ ] **Gate:** A C-grade list will produce reply rates below 1% and will damage domain reputation. No exceptions.

---

### STEP 9 — Write the Email Copy
**Skill:** `/campaign-copywriting`
**Tables:** `email_sequences`, `email_sequence_steps`

- [ ] Pick one campaign from the approved `campaign_strategies` rows (start with Creative Use Case or Lookalike)
- [ ] Confirm campaign direction (target audience, pain point, value prop, proof point) — get approval
- [ ] Confirm subject line + first line strategy (3 options: problem-sniffing / billboard / AI generic) — get approval
- [ ] Confirm body structure (value prop angle, case study, AI variables, CTA style) — get approval
- [ ] Output the 4-email sequence:
  - Email 1 (Day 0) — strongest signal, best case study, clearest CTA
  - Email 2 (Day 3, threaded) — different value prop angle from Email 1
  - Email 3 (Day 7, new thread) — stand-alone, different angle again
  - Email 4 (Day 11) — redirect or resource offer or value bomb
- [ ] Each email stored as a step in `email_sequence_steps` with all variants (A / B / C)
- [ ] Run QA checklist — all items must pass (word count, no banned phrases, CTA ≤5 words to reply, no em dashes)
- [ ] Overall copy score stored in `email_sequences` — must be 85+ to ship; 70–84 needs one more pass; below 70 start over

---

### STEP 10 — Upload to PlusVibe (DRAFT ONLY)
**Platform:** PlusVibe
**Table:** `campaigns`, `campaign_leads`

- [ ] Create the campaign in PlusVibe as **DRAFT** — never active
- [ ] Upload the verified contact list as leads
- [ ] Assign the sending inboxes (minimum 20 warmed inboxes, 2+ weeks warmup)
- [ ] Set sending schedule: weekdays only, 8am–5pm, max 30 leads/day per inbox
- [ ] Every lead tracked in `campaign_leads` with status `pending`
- [ ] Campaign row created in `campaigns` with status `draft`
- [ ] **Human reviews the draft in PlusVibe UI**
- [ ] Human presses Start manually — this is NEVER automated
- [ ] Campaign status updated to `active`

---

### STEP 11 — Monitor + Iterate
**Skill:** `/cold-email-weekly-rhythm`
**Tables:** `campaigns`, `campaign_leads`, `email_verifications`

- [ ] Week 1: Watch bounce rate — must stay below 2%. If above 2%, pause and investigate
- [ ] Week 1: Watch reply rate — target above 1%. If below 0.5% after 200 sends, the copy or list needs work
- [ ] Week 2+: Replies handled manually — positive replies go to sales, negative replies used to refine ICP
- [ ] Every 2–3 weeks: Run a new campaign from `campaign_strategies` (pick the next approved one)
- [ ] After 21 days: Run `/positive-reply-scoring` to score what's working
- [ ] After 21 days: Run `/experiment-design` to decide what to change for the next round
- [ ] Update `campaign_leads` statuses (sent / replied / bounced / unsubscribed) as results come in

---

### THE GOLDEN RULES (Never Break These)

1. **Never send from a cold inbox.** Minimum 2 weeks warmup before any campaign goes live.
2. **Never skip list quality scoring.** Grade must be B or above. No exceptions.
3. **Never activate a campaign via code.** Human presses Start in PlusVibe UI only.
4. **Never batch all campaigns at once.** One campaign live at a time until you understand what's working.
5. **Bounce rate above 2% = stop immediately.** Pause the campaign, investigate the list, fix before resuming.
6. **Reply rate below 1% after 200 sends = the copy or list is wrong.** Don't keep sending hoping it improves.
7. **Every answer, every score, every piece of copy goes into Supabase.** Nothing lives only in a file or in your head.

---

## Campaign Creation Workflow (Source: Christian Plascencia / GTM Elites)
### Mapped to Supabase — Every Step Has a Home

This is the exact 5-stage workflow used to create and launch campaigns. Each step below shows what happens, which tool is used, and exactly which Supabase table captures the output.

---

### STAGE 1 — Craft Messaging Around Campaign Thesis
*Goal: Write and test the emails before touching a single lead.*

#### 1a. Test Different Value Propositions
What you do: Decide which type of offer to lead with in this campaign.

| Value Prop Type | What It Means | Example |
|---|---|---|
| Frontend offer | A softer first ask before the main pitch | "Free 5-minute audit of your outbound setup" |
| Lead magnet | Something free you give in exchange for a reply | "Reply Y and I'll send you our ICP scoring template" |
| Free work | You do a small piece of real work for them at no cost | "I'll write 3 subject lines tailored to your ICP, free" |
| Unique insights | A data point or observation only you could share | "We analysed 200 companies like yours — here's what the top 10% do differently" |

**Supabase:** `email_sequences.value_prop_type` — tag which type this sequence is testing so you can compare results across types later.

---

#### 1b. Test Different Script Frameworks
What you do: Choose the copy structure for this sequence.

| Framework | When to Use |
|---|---|
| `case_study` | You have a strong proof point — lead with the story |
| `pain_point` | No case study yet — lead with the problem they recognise |
| `short_form` | Broad list, low trust — punchy, 50–70 words |
| `long_form` | Niche list, high context — up to 125 words with AI personalisation |
| `personalized` | Uses `{{ai_variables}}` for dynamic per-company content |
| `static` | Same copy for every lead — no AI variables |

**Supabase:** `email_sequence_steps.script_framework` + `email_sequence_steps.has_personalization` — stored per step so you can A/B test frameworks within the same sequence.

---

#### 1c. Add Spintax to Finalised Scripts
What you do: Once the copy is approved, convert it to spintax format so PlusVibe can randomise phrasing across sends — reducing repetition flags and improving deliverability.

Example: `{Hi|Hey|Hello} {{first_name}}, {I noticed|I saw|Saw that} {{company_name}}...`

**Supabase:** `email_sequence_steps.spintax_body` — the spintax version is stored alongside the clean readable version (`variants` JSONB). Never overwrite the clean version — keep both.

---

### STAGE 2 — Build List Around ICP Criteria
*Goal: Find the right companies and people, then clean the data until it's ready to send.*

#### 2a. Determine Segment of TAM to Target

| Sub-step | What Happens | Supabase Table |
|---|---|---|
| Create accounts list | Source companies matching ICP (industry, headcount, geography, triggers) via Apify / Apollo / LinkedIn | `companies` + `lists` + `list_members` |
| Find relevant decision makers | Match contacts to the job titles from `icp_onboarding.buying_title` | `contacts` |
| Scrape email addresses, LI profiles, phone numbers | Pull contact data via enrichment tools | `contacts` (email, linkedin_url, phone columns) |

#### 2b. Data Enrichment and Cleaning

| Sub-step | Tool | What Happens | Supabase Table |
|---|---|---|---|
| Import list to Clay | Clay | Upload the accounts list to a Clay table for multi-provider enrichment | `lists.clay_imported_at` + `lists.clay_table_url` |
| Enrich with multiple providers | Clay (waterfall) | Clay runs data providers in order — Apollo, LinkedIn, Clearbit, etc. — filling gaps in company + contact data | `enrichment_runs` (provider='clay', operation='multi_provider_enrichment') |
| Verify with Millionverifier | Millionverifier | Check every email is deliverable (valid / invalid / unknown) | `email_verifications` (provider='millionverifier') |
| Verify catch-alls with Enirchley | Enirchley | Catch-all addresses pass Millionverifier but may still bounce — Enirchley probes deeper | `email_verifications` (provider='enirchley') |
| AI tools for personalisation, lead scoring, intent data | Claude / Clay AI | Score each lead against ICP; generate `{{ai_variables}}` for copy; flag high-intent signals | `enrichment_runs` (operation='ai_qualification') |

**Gate:** List must be fully enriched and verified before moving to Stage 3.
**Check:** `lists.enrichment_status` must be `verified` or `ready`.

---

### STAGE 3 — Add Assets to Campaign
*Goal: Load the approved copy and list into PlusVibe and configure the campaign correctly.*

#### 3a. Audit Campaign Scripts and Variables for Errors
- [ ] Every `{{variable}}` in the copy exists in the contact list as a column
- [ ] No `{{variable}}` returns blank for more than 5% of leads (if it does, remove it or add a fallback)
- [ ] No banned phrases slipped through (`/spam-word-checker` catches these)
- [ ] Spintax formatting is valid — every `{option1|option2}` has a closing `}`
- [ ] Word count checked per step (50–90 words target; max 125 with AI justification)

**Supabase:** QA results stored in `email_sequences.overall_score` and `email_sequences.notes`.

#### 3b. Enable All Optimised Campaign Settings
Settings stored in `campaigns`:

| Setting | Recommended Value |
|---|---|
| Max leads per day | 30 per inbox |
| Min time between emails | 10 minutes |
| Sending days | Monday–Friday only |
| Sending hours | 08:00–17:00 prospect timezone |
| Inbox rotation | All warmed inboxes on the account (minimum 20) |
| Inbox tag | `active` (only use inboxes tagged active) |
| Open tracking | OFF (triggers spam filters) |
| Click tracking | OFF (triggers spam filters) |

#### 3c. Set Correct Email Accounts and Sending Times by Timezone
- [ ] Match sending timezone to prospect geography from `icp_onboarding.geography`
- [ ] US West Coast targets → Pacific timezone (08:00–17:00 PT)
- [ ] UK targets → GMT/BST timezone
- [ ] Mixed geography → split into separate sub-campaigns per timezone
- [ ] Confirm `campaigns.sending_timezone` is set before activating

**Supabase:** All settings stored in `campaigns` row for this campaign.

---

### STAGE 4 — Send Campaign for Review
*Goal: Get client sign-off on scripts and list before anything goes live.*
**Supabase table: `campaign_reviews`**

#### 4a. Notify Client
- [ ] Share the email scripts — paste into a Google Doc or Notion page, share link
  → Record in `campaign_reviews.scripts_share_url` + set `scripts_shared_at = now()`
  → Update `campaign_reviews.status = 'scripts_shared'`
- [ ] Share the list — export as CSV or share Google Sheet
  → Record in `campaign_reviews.list_share_url` + set `list_shared_at = now()`
  → Update `campaign_reviews.status = 'list_shared'`

#### 4b. Make Adjustments According to Feedback
- [ ] Client feedback captured in `campaign_reviews.client_feedback`
- [ ] Changes made to copy → updated in `email_sequence_steps.variants` (and `spintax_body` if already spintaxed)
- [ ] Changes made to list → re-run list quality scorecard if significant rows removed
- [ ] Revision notes recorded in `campaign_reviews.revision_notes`
- [ ] `campaign_reviews.revision_count` incremented for each round of changes
- [ ] `campaign_reviews.status` updated to `revisions_made`

#### 4c. Get Green Light
- [ ] Client confirms approval verbally or in writing
- [ ] Record in `campaign_reviews.approved_by` (name of client contact)
- [ ] Record in `campaign_reviews.approved_at` (timestamp)
- [ ] Update `campaign_reviews.status = 'approved'`
- [ ] **NOTHING launches until this row is in `approved` status**

---

### STAGE 5 — Launch
*Goal: Activate the campaign in PlusVibe. Human only — never automated.*

- [ ] Open PlusVibe — find the campaign in DRAFT status
- [ ] Final check: correct inboxes assigned? Sending times set? Lead count looks right?
- [ ] Press **Start** manually in the PlusVibe UI
- [ ] Update `campaigns.status = 'active'` in Supabase
- [ ] Update `campaigns.launched_at` timestamp
- [ ] All leads update to `campaign_leads.status = 'pending'` → `'sent'` as emails go out
- [ ] Monitor deliverability dashboard daily for the first week

**Gate:** `campaign_reviews.status` must be `approved` before anyone touches the Start button.

---

### SUPABASE TABLE REFERENCE — Campaign Creation Workflow

| PDF Step | Sub-step | Supabase Table | Column(s) |
|---|---|---|---|
| 1a | Value prop type | `email_sequences` | `value_prop_type` |
| 1b | Script framework | `email_sequence_steps` | `script_framework`, `has_personalization` |
| 1c | Spintax | `email_sequence_steps` | `spintax_body` |
| 2a-i | Accounts list | `companies`, `lists`, `list_members` | all |
| 2a-ii | Decision makers | `contacts` | all |
| 2a-iii | Email / LI / phone | `contacts` | `email`, `linkedin_url`, `phone` |
| 2b-i | Import to Clay | `lists` | `clay_imported_at`, `clay_table_url` |
| 2b-ii | Multi-provider enrichment | `enrichment_runs` | `provider='clay'` |
| 2b-iii | Millionverifier | `email_verifications` | `provider='millionverifier'` |
| 2b-iv | Enirchley catch-alls | `email_verifications` | `provider='enirchley'` |
| 2b-v | AI lead scoring | `enrichment_runs` | `operation='ai_qualification'` |
| 3a | Script audit | `email_sequences` | `overall_score`, `notes` |
| 3b | Campaign settings | `campaigns` | all settings columns |
| 3c | Timezone config | `campaigns` | `sending_timezone` |
| 4a | Share scripts | `campaign_reviews` | `scripts_shared_at`, `scripts_share_url` |
| 4a | Share list | `campaign_reviews` | `list_shared_at`, `list_share_url` |
| 4b | Client feedback | `campaign_reviews` | `client_feedback`, `revision_notes`, `revision_count` |
| 4c | Green light | `campaign_reviews` | `approved_by`, `approved_at`, `status='approved'` |
| 5 | Launch | `campaigns`, `campaign_leads` | `status='active'`, `launched_at` |
