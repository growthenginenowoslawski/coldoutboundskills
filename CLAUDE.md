# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Two systems in one repo

1. **`skills/`** — Claude Code skills for cold-email outbound (infrastructure, list building, copy, sending). Each subdirectory has a `SKILL.md` (frontmatter is exactly `name` + `description`) plus optional `scripts/` (tsx, Node built-ins only) and `references/`. Inherited from an upstream skills repo; `main` tracks it.
2. **A TypeScript GTM engine** (`src/`, `trigger/`, `supabase/`, `scripts/`) — Supabase + Trigger.dev + AI providers: signals, account scoring, qualification, campaign readiness. Built stage by stage (the "Stage N" in commits, comments and `scripts/stageNN-*`). Lives on `my-build`.

`README.md`, `docs/roadmap.md` and the `description:` fields double as the human-facing skill index; keep them aligned when adding a skill.

## Commands

```bash
npm test                                                    # all unit tests (src/**/*.test.ts), fully offline
node --import tsx --test src/__tests__/<name>.test.ts       # one test file
node --import tsx --test --test-name-pattern="<regex>" src/__tests__/<name>.test.ts   # one test
npx tsx scripts/<script>.ts                                 # live-DB script (needs .env) — see warning below
npx tsx src/scripts/apply-migration.ts supabase/migrations/NNNN_name.sql   # DDL via Supabase Management API
npm run trigger:dev | trigger:deploy                        # Trigger.dev tasks in trigger/
npx tsx skills/<skill>/scripts/<script>.ts --flag=value    # skill scripts
```

There is no lint or build step. `npx tsc --noEmit` currently fails because `@types/node` is not a dependency; tests run through `tsx` and don't need it.

Tests use `node:test`, mock `globalThis.fetch`, and never touch the network, Supabase or real keys. Fakes live in `src/testing/` and `src/providers/signals/fake-provider.ts`.

**`scripts/` is not the test suite.** These are live integration/validation scripts that hit real Supabase and sometimes real providers (e.g. `stage20-live-upload.ts` used a real Smartlead campaign). Read a script's header before running it; most declare what they mutate, and many are read-only by design.

## Engine architecture (needs several files to see)

**Layering** — keep the direction of dependencies:
`domain/` (types) → `lib/` (pure, deterministic logic: scoring, dedup, qualification, readiness; no I/O, time passed in) → `db/` (all Supabase access) → `tasks/` (orchestration logic with injectable deps, no Trigger.dev import) → `trigger/` (thin Trigger.dev wrappers).
Trigger tasks get exactly-once behaviour from the `jobs` table: an atomic `claimJob` keyed on `(job_type, idempotencyKey)` plus checkpoint statuses in `output_data`, so a retry resumes rather than repeats (see the header of `trigger/signal-ingestion.ts`).

**Providers sit behind interfaces; vendors are swapped in registries:**
- `providers/ai/`: `ModelRouter` (task + complexity → model) → `EscalationRouter` (start cheap, escalate on low confidence) → `execute<T>()` (captures latency/tokens/cost via `pricing.ts`). New AI tasks reuse `execute()`; don't re-implement observability.
- `providers/signals/`: `SignalProvider` → `normalizer` → `lib/signal-dedup` (3-tier: provider id, content fingerprint, none) + `signal-freshness` (per-type TTL) + `signal-strength`. PredictLeads is the only real provider; `news-event-mapper.ts` and `fake-news-events.ts` are pure/fixture-only and deliberately not wired into `fetchEvents` or the registry.
- `providers/outreach/`: `OutreachProvider` (Smartlead real; Instantly adapter written without a live key and **unvalidated**; PlusVibe not implemented). Registry reads `SMARTLEAD_API_KEY` / `INSTANTLY_API_KEY`. Smartlead puts its API key in the URL, so never log request URLs.

**Signal → score → campaign flow:** ingestion coordinator (`lib/signal-ingestion.ts`) upserts signals → `rescoreCompany` writes `account_intelligence.opportunity_score` = signals × freshness × per-type `ICP_RELEVANCE` × corroboration × (`companies.icp_score`/100). A NULL `icp_score` is read as 0, which zeroes the score. → account qualification (deterministic, campaign-aware) → contact/person discovery → campaign readiness gate → `lead-upload` (only `draft` Smartlead campaigns; other platforms are rejected before any call).

**Convention:** scoring weights, thresholds and category maps are marked `INITIAL_HYPOTHESIS_NOT_VALIDATED`. Don't change weights, TTLs or provider category mappings without explicit approval, and mark new unverified assumptions the same way.

## Database

Supabase Postgres, schema in `supabase/migrations/NNNN_*.sql`. **Before database work, read `docs/supabase/00-START-HERE.md` and the relevant table file** (13-section format, one per table). When a migration is applied or a schema changes, update `99-SUPABASE-CHANGELOG.md` and the table file. Security findings go in `25-SUPABASE-SECURITY.md`, then stop and ask before changing any policy.

- `getSupabaseAdmin()` uses the secret key, which bypasses RLS — server-side only.
- `companies`, `contacts`, `lists`, `list_members` are global (no `client_id`); tenant scoping lives on referencing rows (`signals`, `campaigns`, `account_intelligence`, …). Every query that is tenant data must filter by `client_id`.
- `companies.icp_score` is global, so with several clients it reflects the last writer (a documented compromise).
- Never log secrets, connect Smartlead, send email or trigger outbound from database/engine work.

## Environment

`.env` is loaded from the process working directory by `src/config/env.ts` (names are in `ENV_KEYS`); real env vars win. `.env` and `/profiles` are gitignored; client output in `profiles/<slug>/` must never be committed. Skills have their own loaders: list-builder reads the repo-root `.env`, cold-email-starter-kit reads `skills/cold-email-starter-kit/.env`.

## Skills

- Skills hand off in a pipeline (see `docs/roadmap.md`): `icp-onboarding` → `lead-magnet-brainstorm` → `campaign-strategy` → infra (`zapmail-domain-setup-public`, then inbox setup, ~2-week warmup) → a list-building skill → `list-quality-scorecard` → `campaign-copywriting` → `spam-word-checker` → `instantly-campaign-prep` (Instantly) or `smartlead-campaign-upload-public` (Smartlead) → 21-day wait → `positive-reply-scoring` → `experiment-design`. Entry point is `/cold-email-kickoff`.
- Every list-building skill invokes `/icp-prompt-builder` as a required step; changing it ripples across all of them.
- Skills that spend money or upload must confirm first and default to non-destructive (uploads are DRAFT; the human presses Start). `instantly-campaign-prep` makes no API calls at all.
- `SKILL.md` is the source of truth for behaviour; if you change a script's flags or output, update its `SKILL.md`.
- Reference-only skills (`smartlead-api`, `instantly-api`, `prospeo-search-api`, `smartlead-spintax`) have no scripts.
- `skills/list-builder/` has its own `RUNBOOK.md` — read it before touching it. Invariants: runs are resumable by re-running the same command (completion is judged from on-disk artifacts; never rename files in a run dir or hand-edit stream CSVs); never cap contacts per company, bypass the email finder, lower `PROSPEO_MIN_INTERVAL_MS`, or call Prospeo outside `lib.ts`.
- `skills/playbooks/` (19 signal playbooks): `clay-table.md` / `clay-workflow.md` are specs not run live; the `SKILL.md` verification line states what was actually executed.
