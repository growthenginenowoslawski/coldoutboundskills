# GRAMSCODE OUTBOUND ENGINE — MASTER IMPLEMENTATION + LAUNCH PLAN

**Version 2.0** — canonical governing specification for all Gramscode outbound work.

> This is the MASTER SPECIFICATION. When building any part of the outbound engine,
> this document overrides ad-hoc decisions. (Source note: the pasted spec was
> truncated inside Stage 15's reply-classification list; Stages 15–16 are
> completed to the extent provided and should be re-confirmed with the owner.)

## Role

Senior software architect + implementation agent responsible for building
Gramscode's outbound campaign system into a reliable, modular, testable
outbound operating system.

## Canonical workflow (kept)

PREFLIGHT → STRATEGY → INFRASTRUCTURE → LIST BUILD → CONTACTS + EMAILS →
QUALITY GATE → COPY → UPLOAD (DRAFT) → REVIEW → GO LIVE → MEASURE → ITERATE

## Architecture layers

- **Supabase** — permanent source of truth (all important business state).
- **Trigger.dev** — workflow orchestration / background jobs / retries.
- **Claude** — AI reasoning: qualification, research, personalization, reply analysis.
- **Selected providers** — lead discovery / enrichment / contact discovery / email finding / verification.
- **Playwright MCP** — browser-level verification where appropriate (NOT a replacement for reliable APIs; NOT the email-verification service).
- **PlusVibe** — outbound sending platform.

Build **one stage at a time. NOTHING MOVES PAST A RED GATE.**

---

## Critical Rules (non-negotiable)

**#1 — Do not start coding immediately.** Read the whole plan; inspect repo,
code, `package.json`, Trigger.dev config, Supabase config, outbound/cold-email
skills, and env vars (without exposing secrets). Identify what exists, reusable
components, duplicates, and gaps. Then produce a **GRAMSCODE OUTBOUND — CURRENT
STATE REPORT**. Do not rebuild what works. Do not delete existing functionality.
Do not advance until the current stage is understood.

**#2 — Capability first, tool second.** The plan describes required
*capabilities*, not permanent provider lock-in. The owner chooses actual tools.
Before any provider-dependent implementation, create `docs/STACK_DECISIONS.md`
mapping, for every capability: required capability, possible providers,
recommendation, why, integration method (API/MCP/SDK/browser), expected
limitations, credentials required, status. Then **ASK the owner to select**.
Never silently choose a provider.

Capabilities requiring stack selection: (1) lead discovery, (2) company
discovery, (3) company enrichment, (4) decision-maker discovery, (5) contact
enrichment, (6) email finding, (7) LinkedIn/profile enrichment, (8) tech-stack
detection, (9) intent/signal detection, (10) AI research, (11) AI qualification,
(12) email verification, (13) browser automation/verification, (14) email
sending, (15) domain/inbox infrastructure, (16) analytics/reporting (if external).

Example providers (NOT automatic decisions): Prospeo, Blitz, GetLeads, Clay,
LeadMagic, MillionVerifier, BounceBan, Bouncer, PlusVibe, Playwright, Claude,
others. The owner may choose entirely different providers.

**#3 — Provider swappability.** Do not tightly couple to one vendor. Create
capability interfaces: `LeadSourceProvider`, `EnrichmentProvider`,
`ContactProvider`, `EmailFinderProvider`, `EmailVerificationProvider`,
`SendingProvider`, `AIProvider`. Concrete providers (ProspeoProvider,
BlitzProvider, GetLeadsProvider, ClayProvider, LeadMagicProvider,
MillionVerifierProvider, BounceBanProvider, BouncerProvider, PlusVibeProvider,
etc.) implement them. The rest of the app talks to the interface, not the vendor.

**#4 — Verify every integration.** Never assume it works because a key exists,
an SDK/MCP is installed, or a package imported. Every external integration must
pass: AUTHENTICATION + CONNECTIVITY + FUNCTIONAL TEST + EXPECTED RESPONSE +
SYSTEM INTEGRATION + SUPABASE STORAGE (where appropriate) = 🟢 VERIFIED.
Any failure ⇒ 🔴 STOP, do not proceed.

**#5 — Claude + selected tool connection.** Where a tool is meant to work with
Claude, test the actual connection (Claude → MCP/API/SDK → provider → response →
Claude → Supabase). If Trigger.dev will run the integration server-side, also
verify Trigger.dev → provider → response → Supabase. A local-only test is not
sufficient for a server-side integration.

**#6 — Human approval between stages.** After each major stage: run tests,
verify expected result, report what changed, report gate status, report
artifacts, explain the next stage, identify any tool decision needed next, then
**STOP**. Do not auto-advance. Wait for explicit owner approval.

---

## Test → Review → Production model

RAW → TEST → ENRICH → AI QUALIFICATION → HUMAN REVIEW → APPROVED → PRODUCTION →
CAMPAIGN READY → DRAFT → HUMAN REVIEW → SEND.

Experimental records must NOT auto-promote to production. TEST → APPROVED →
PRODUCTION is good; TEST → REJECTED means it stops.

## Layer responsibilities

- **Supabase = permanent DB.** Not Trigger.dev, not Clay, not PlusVibe. Stores
  companies, contacts, lists, list membership, enrichment history, email
  verification history, campaigns, campaign leads, jobs, and eventually replies,
  campaign events, experiment results.
- **Trigger.dev = orchestration.** Background jobs, batches, retries, scheduling,
  concurrency, provider calls, enrichment/lead/verification workflows, campaign
  prep, monitoring, recurring jobs. Workflows must be retryable, observable,
  idempotent where possible, rate-limited, resumable where possible, safe against
  duplicate processing.
- **Claude = intelligence.** Research, ICP qualification, lead scoring,
  enrichment interpretation, signal analysis, personalization, copy, reply
  classification, campaign/experiment analysis. Returns structured outputs, e.g.:
  `{ "qualified": true, "score": 91, "reason": "...", "industry_fit": true,
  "size_fit": true, "geography_fit": true, "decision_maker_fit": true,
  "pain_signal": "...", "recommended_angle": "..." }` (schema may evolve).

---

## Stages & gates

- **Stage 0 — Stack selection.** Inspect repo, identify capabilities + candidate
  providers, recommend, ask owner to choose, write `docs/STACK_DECISIONS.md`,
  identify integration methods. 🟢 GATE: all major provider decisions made.
- **Stage 1 — Preflight.** For every selected provider: credential present,
  authenticated request, expected response, balance/credits where relevant,
  API/MCP/SDK available, real round-trip. 🟢 GATE: all integrations healthy.
- **Stage 2 — Strategy.** Lock ICP, industries, titles, seniorities, geography,
  company size, exclusions, hard filters, offer, lead magnet, angles, value
  props, CTA. Create `client-profile.yaml`, `lead-magnets.md`,
  `campaign-strategy.md`, `campaign-plan.md`. Validate targeting against the
  SELECTED provider's actual filter vocabulary (don't assume Prospeo's list).
  🟢 GATE: ICP complete, filters valid for the selected provider.
- **Stage 3 — Infrastructure readiness.** Verify outbound domains, inboxes, DNS,
  SPF, DKIM, DMARC, warmup, inbox health, sending platform, sending limits.
  Hard warmup gate ~2 weeks for cold inboxes; never send from cold inboxes. The
  500/day target must not override infra health. 🟢 GATE: sending infra healthy
  and appropriately warmed; create an infrastructure health artifact.
- **Stage 4 — Trigger.dev + Supabase foundation.** Dev-only task:
  Trigger.dev → Supabase → create test job → read → update → completed. No real
  leads/providers/campaign/email. 🟢 GATE: test job created/read/updated.
- **Stage 5 — Lead building.** Use selected lead source(s). Validate on a
  50-lead sample before full processing. Pipeline: source → Trigger.dev →
  Supabase TEST → dedup → AI qualification. Validate company domain/identity,
  duplicates, source, ICP fit, required fields. 🟢 GATE: test list passes, then
  scale. Artifacts: companies, summary, qualification results, rejection audit,
  source info.
- **Stage 6 — Contact discovery + enrichment.** Separate capabilities: company
  enrichment, company research, decision-maker discovery, contact enrichment,
  email finding, LinkedIn/profile enrichment, tech detection, intent/signal
  detection, personalization research. Every provider op writes an
  `enrichment_runs` record (provider, operation, input, output, status,
  timestamps, errors). Test on a small sample first. 🟢 GATE: providers
  authenticated + connected + functionally tested + working with Claude/workflow
  + storing in Supabase; only then scale. Do not assume Clay is mandatory.
- **Stage 7 — Email finding.** Use selected email-finder(s). Provider-found
  email ≠ send-ready. Store candidates, track source/provider, dedup, then send
  all to verification. 🟢 GATE: candidates collected + stored.
- **Stage 8 — Email verification.** Use selected verifier (do NOT assume
  MillionVerifier). Candidate → EmailVerificationProvider → result → Supabase
  `email_verifications` → campaign-ready or rejected. Preserve history. 🟢 GATE:
  only acceptable results become campaign-ready.
- **Stage 9 — Quality gate.** Grade dedup, email validity, ICP fit,
  completeness, company/contact/enrichment quality, personalization readiness.
  Aim B+ or better; below threshold ⇒ STOP and return to list/enrichment/
  verification, do not upload. Create `scorecard-<date>.md`. 🟢 GATE: threshold
  passed.
- **Stage 10 — Copy + personalization.** Subjects, A/B/C variants, opening,
  value prop, CTA, personalization fields. Validate subject/body length,
  personalization variables, spam-risk terms, formatting, CTA, signature,
  sequence schema. Create `variants.yaml`. 🟢 GATE: copy QA passes.
- **Stage 11 — Campaign assembly.** Build in PlusVibe **DRAFT ONLY**; never
  activate via code. Validate lead count, name, sequence, variants, inboxes,
  schedule, timezone, daily limits, custom fields, personalization. 🟢 GATE:
  campaign exists as DRAFT, expected counts match actual.
- **Stage 12 — Browser/API verification.** API where reliable; Playwright MCP
  where valuable. Verify campaign exists + is DRAFT, lead count, inbox count,
  sequence, variables, schedule, no broken tokens, correct settings (expected
  vs actual). 🟢 GATE: everything matches; else STOP.
- **Stage 13 — Human review + go live.** Owner reviews subject, body,
  personalization, leads, inboxes, schedule, timezone, throttle, status, and
  manually presses START. No script/Trigger.dev task/Claude agent/Playwright may
  auto-activate a campaign. 🟢 GATE: human explicitly starts; create experiment
  log.
- **Stage 14 — Delivery watch (first 7 days).** Monitor sending activity, bounce
  rate, reply rate, inbox health, warmup state, blocked inboxes, campaign status.
  Operating thresholds (not universal guarantees): bounce < 2%, reply ≥ 1%. Red
  condition ⇒ STOP/PAUSE → INVESTIGATE → FIX → VERIFY → RESUME. Create delivery
  audit.
- **Stage 15 — Measure (~day 21).** Primary metric: positive reply rate =
  positive replies / total sent. Classify replies: positive_interested,
  positive_soft, positive_referral, negative, hostile, … *(spec truncated here —
  confirm full classification + Stage 16 Iterate with owner).*

---

## Current project status (as provided)

- **Google Workspace**: professional setup exists; SPF/DMARC/DKIM configured
  (DKIM propagation being verified). `gramscode.com` is the primary business
  domain — do NOT assume it's used for high-volume cold outreach.
- **PlusVibe**: account exists; outbound infra pending final config + human
  approval.
- **Target capacity**: ~500 emails/day is a long-term goal, NOT permission to
  send 500/day now. Scale gradually with inbox/domain health.
- **Supabase**: project exists; DB foundation created. Existing tables:
  `companies`, `contacts`, `lists`, `list_members`, `enrichment_runs`,
  `email_verifications`, `campaigns`, `campaign_leads`, `jobs`. RLS enabled.
  Do NOT delete/recreate these tables without approval.
- **Trigger.dev**: v4.5.12 installed. Project "Gramscode Outbound Automation",
  ref `proj_znllkfuivbgztrmbqfov`. Auth works, dev server connects,
  `hello-world` smoke task registered. No production workflows exist.
