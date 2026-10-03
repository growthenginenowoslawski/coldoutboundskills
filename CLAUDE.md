# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is a **collection of Claude Code skills** for cold-email outbound (infrastructure, list building, copywriting, sending, iteration) — not a conventional application. There is no root build, no `package.json`, and no test suite. The "product" is the `skills/` directory: each subdirectory is a self-contained skill that a user invokes as a slash command (e.g. `/cold-email-kickoff`, `/list-builder`).

A skill = a directory under `skills/<skill-name>/` containing:
- `SKILL.md` (required) — the skill definition. Frontmatter is exactly two fields, `name` and `description`; the description is a dense paragraph that tells Claude when to invoke it. The body is the operating procedure Claude follows.
- `scripts/` (optional) — runnable TypeScript (`.ts`, run with `tsx`) and occasionally Python.
- `references/` (optional) — deeper docs the SKILL.md points to.

When editing a skill, the `SKILL.md` *is* the source of truth for behavior — the scripts are tools it calls. Keep the two in sync: if you change a script's flags or output contract, update the SKILL.md (and any `RUNBOOK.md`) that documents it.

## Running scripts

Scripts are executed directly, never built. Requires `tsx` on PATH (`npm install -g tsx`). All `.ts` scripts use **only Node built-ins** — there are no third-party npm dependencies and no lockfile to install.

```bash
# General form — run from the skill directory
npx tsx skills/<skill>/scripts/<script>.ts --flag=value

# Verify your API keys are wired up (do this first on a fresh checkout)
npx tsx skills/cold-email-starter-kit/scripts/verify-credentials.ts
```

The one Python script (`skills/list-builder/scripts/push-sheet.py`) needs `gspread` and a service-account JSON (`GOOGLE_APPLICATION_CREDENTIALS`).

There is no lint, typecheck, or test command in this repo. "Testing" a change means running the relevant script against real (or 5-row sample) data and reading its output artifact.

## Credentials & env loading

All secrets come from a `.env` file (copy `.env.example` → `.env`). You never need all keys — only those used by the skills you run. Minimum viable set: `SMARTLEAD_API_KEY`, `PROSPEO_API_KEY`, `DYNADOT_API_KEY`, `ZAPMAIL_API_KEY`.

Two env-loading conventions exist — match the one used by the skill you're editing:
- **list-builder / list-expander** (`scripts/lib.ts`): walks up from the script to the **repo-root `.env`**, then `$CWD/.env`, then `~/.env`. Real `process.env` always wins.
- **cold-email-starter-kit** (`scripts/_lib.ts`): loads `.env` from the **skill root** (`skills/cold-email-starter-kit/.env`), falling back to `process.env`.

`.env` and `/profiles` are gitignored. User output (client profiles, scores, experiment logs) lives in `profiles/<business-slug>/` and must never be committed.

## The skill graph (how skills relate)

Skills are designed to hand off to each other in a pipeline. The two orchestrators are the entry points; most other skills are steps invoked by them or run standalone.

- **`/cold-email-kickoff`** — the recommended single entry point. Orchestrates `icp-onboarding` → `lead-magnet-brainstorm` → `campaign-strategy`, then branches to infra setup or list building based on the user's answers. Produces `profiles/<slug>/campaign-plan.md`.
- **`/cold-email-starter-kit`** — the alternative long-form 14-step manual tutorial covering the same ground.

Canonical linear flow (see `docs/roadmap.md` for the full stage→skill table and troubleshooting tree):
`icp-onboarding` → `lead-magnet-brainstorm` → `campaign-strategy` → (infra: `zapmail-domain-setup-public` → `smartlead-inbox-manager`, ~2-week warmup) → a list-building skill → `list-quality-scorecard` → `campaign-copywriting` → `spam-word-checker` → `smartlead-campaign-upload-public` → (21-day wait) → `positive-reply-scoring` → `experiment-design`.

**Every list-building skill** (`prospeo-full-export`, `disco-like`, `google-maps-list-builder`, `blitz-list-builder`, `competitor-engagers`, `list-builder`, `list-expander`) invokes **`/icp-prompt-builder`** as a required qualification step — a change to how ICP prompts are built ripples across all of them.

## list-builder — the complex subsystem

`skills/list-builder/` is the most involved skill and has its own **`RUNBOOK.md`** — read it before touching anything there. Key invariants that the code enforces and you must not break:

- **Everything is resumable.** Re-running the *same* command after a failure is the entire recovery model. Completion is decided from on-disk artifacts, not from a run flag. Never move/rename files inside a run dir or hand-edit stream CSVs.
- Run artifacts live under `~/output/list-builder/lanes/<client>-<lane>/`; `summary.md`'s first line is `# READY` / `# NOT READY` with the next command embedded. `# READY` is the only green light for deliverability.
- Pipeline: `make-judge.ts` (judge prompt — never hand-write one, the template's mandatory blocks prevent known false-negative classes) → `run-lane.ts` (PRECHECK→…→REPORT stages) → `snowball.ts` (exhaustive sweep) → `contacts.ts` (GetLeads→Blitz→Prospeo→email finder). `fleet.ts` is a read-only status board, safe on live runs.
- **Never** cap contacts per company, send provider (GetLeads/Blitz/Prospeo) emails directly without the email finder, lower `PROSPEO_MIN_INTERVAL_MS` (it's clamped), or run Prospeo calls outside `lib.ts`. Recall is the product; do not trim sweeps to save cost.

## Track 6 — signal playbooks

`skills/playbooks/` holds 19 playbooks, each turning one buying signal into one copy-ready sentence. Each ships three files with a deliberate split: `SKILL.md` (the playbook + locked prompt), `clay-table.md` (browser-driven Clay table build), and `clay-workflow.md` (CLI-driven Clay workflow build via the `clay` CLI). The table/workflow split is a real constraint — the `clay` CLI is read-only for tables but can create/edit/publish workflows. Treat `clay-table.md` / `clay-workflow.md` as **specifications that have not been run live**; the `SKILL.md` verification line states what was actually executed and on how many rows.

## Conventions when adding or editing skills

- The `SKILL.md` `description` field is what makes a skill discoverable/invocable — write it as an explicit "use this when…" so Claude picks the right skill. Keep it aligned with the entries in `README.md` and `docs/roadmap.md`, which double as the human-facing skill index.
- Skills that spend real money (buying domains, sending) or upload to a platform must confirm with the user first and default to non-destructive (e.g. `smartlead-campaign-upload-public` always uploads as DRAFT; the user hits Start manually). Preserve these safeguards.
- Reference-only skills (`smartlead-api`, `prospeo-search-api`, `smartlead-spintax`) are documentation surfaces with no scripts — they exist so Claude has the API/format details inline.

## Supabase Documentation Rule

`docs/supabase/` contains a permanent, validated documentation system for the Supabase database. **Before any database work in a new conversation, read `docs/supabase/00-START-HERE.md` and the relevant table file(s).** This saves you from re-deriving the schema from migrations and TypeScript interfaces every session.

**When to update these docs:**
- A new migration is applied → update `99-SUPABASE-CHANGELOG.md` + the affected table file(s)
- A table schema changes (column added, type changed) → update the corresponding `NN-TABLENAME.md` file
- A new table is created → create a new table doc in the 13-section format used by existing table files
- A security finding is discovered → document it in `25-SUPABASE-SECURITY.md` using the PROBLEM/WHY IT MATTERS/CURRENT STATE/RECOMMENDED FIX/WHAT COULD BREAK format, then STOP and ask before changing any policy

**Critical security constraints that apply when working with Supabase:**
- API secrets must NEVER be logged
- Do NOT connect Smartlead / send emails / trigger outbound
- Do not automatically change security policies while documenting
- If you discover a security issue: document it in `25-SUPABASE-SECURITY.md`, then stop and ask before changing production security configuration

**File map:**
- `00-START-HERE.md` — architecture overview, 19 tables at a glance, data flow
- `01-DATABASE-MAP.md` — full relational map with ASCII tree
- `02` to `20` — one file per table (13-section format)
- `21-CAMPAIGN-DATA-FLOW.md` — complete pipeline trace (idea → inbox)
- `22-FOLLOW-A-COMPANY.md` — single company traced through all tables
- `23-FOLLOW-A-CAMPAIGN.md` — single campaign traced from idea to results
- `24-SUPABASE-CONCEPTS.md` — how Supabase works (6 progressive levels)
- `25-SUPABASE-SECURITY.md` — RLS status, security findings, data classification
- `99-SUPABASE-CHANGELOG.md` — migration history and schema evolution
