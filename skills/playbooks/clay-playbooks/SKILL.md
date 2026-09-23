---
name: clay-playbooks
description: Index and shared harness for the 19 signal playbooks. Each playbook turns one buying signal (new in role, raised a round, hiring surge, pricing page, tech on website, ...) into one copy-ready sentence you can drop into a cold email. Every playbook ships three ways to run it: as a Claude skill, as a Clay table built through a browser harness, and as a tested skill that runs on the Clay CLI alone (skills/clay-cli-playbooks/). Use when someone says "personalize this list", "what signal should I use", "build the Clay column for X", or names any of the 19 signals.
---

# Clay Playbooks

Nineteen playbooks. Each one answers a single question:

> A campaign needs signal X on every row. What is the cheapest reliable way to get X, and what exact prompt turns X into copy-ready text?

One playbook produces one field. `new_in_role_line`. `funding_line`. `pricing_page_line`. That
field slots into one sentence of email 1. That is the whole product.

## The three run modes

Every playbook directory ships the same three files. They are three delivery mechanisms for the
same recipe, not three different recipes.

| File | What it is | Use it when |
|---|---|---|
| `SKILL.md` | The playbook itself: source chain, output contract, locked prompt, edge cases | You are running the signal from Claude, ad hoc, on a CSV or a one-off list |
| `clay-table.md` | The Clay **table** build: exact columns, types, formulas, credit gates, AI-column bindings | The signal needs to run continuously on a client table that other people will look at |
| `clay-workflow.md` | A pointer to the **tested Clay CLI skill** for this signal in `skills/clay-cli-playbooks/` | You want the signal to run on Clay alone, from a terminal, with no UI clicking |

**Why tables are browser-driven and workflows are CLI-driven.** This is a real constraint, not a
style choice. The `clay` CLI's `tables` command group is read-only (`list`, `get`, `columns`,
`rows`, `query`) — it cannot create a table or add a column. Tables must be built in the UI.
Workflows are the opposite: `clay workflows create` / `nodes create` / `publish` / `runs test`
all exist, so a workflow can be built end to end from a terminal.

Shared procedures, written once so the 19 playbooks do not repeat them:

- **`clay-table-harness.md`** — the generic browser procedure for building any playbook's table.
- **`clay-cli-harness.md`** — the generic `clay` CLI procedure for building any playbook's workflow.

Read the relevant harness once, then read the playbook's own `clay-table.md` / `clay-workflow.md`
for what is specific to that signal.

## Status: recipes, not verified builds

⚠️ **Read this before you tell anyone a playbook "works".**

The `SKILL.md` in each directory carries a verification line saying what was actually run and on
how many rows. Where it says PASS, real rows were graded.

**The `clay-table.md` files in every playbook are documented recipes that have not been built in
a live Clay workspace.** They are written against the real Clay action catalog, so the shapes are
right, but nobody has clicked through the table build. Treat them as specifications. Build one, run
it on 5 rows, read the output, and fix the file before you run it on a list.

**The Clay CLI versions were run live.** Each playbook's `clay-workflow.md` points to a skill in
`skills/clay-cli-playbooks/` that was built and run in a real Clay workspace on 2026-09-23 (CLI
1.3.0). 13 ran end to end; 6 ran their free path, with one paid step each priced but not run. Prefer
those over `clay-cli-harness.md`, which is the older untested procedure.

The one thing most likely to be wrong on first build is the AI column's reasoning-effort
parameter. See `clay-table-harness.md` § "The empty-column trap".

## The 19 playbooks

### Person-level signals (the person did something)

| Playbook | Output field | What it says |
|---|---|---|
| [`playbook-new-in-role`](../playbook-new-in-role/) | `new_in_role_line` | they just took this seat |
| [`playbook-linkedin-engagement`](../playbook-linkedin-engagement/) | `engagement_line` | they engaged with a relevant post |
| [`playbook-social-posts`](../playbook-social-posts/) | `social_post_line` | they posted about something you can speak to |
| [`playbook-warm-intros`](../playbook-warm-intros/) | `warm_intro_line` | you share a real connection |

### Company-level signals (the company did something)

| Playbook | Output field | What it says |
|---|---|---|
| [`playbook-fundraising`](../playbook-fundraising/) | `funding_line` | they raised, so they are buying |
| [`playbook-hiring-surge`](../playbook-hiring-surge/) | `hiring_line` | they are growing the team you sell to |
| [`playbook-job-posting-language`](../playbook-job-posting-language/) | `job_language_line` | their own job post names your problem |
| [`playbook-ad-library`](../playbook-ad-library/) | `ad_line` | they are spending on ads right now |

### Website-derived signals (their site says something)

| Playbook | Output field | What it says |
|---|---|---|
| [`playbook-pricing-page`](../playbook-pricing-page/) | `pricing_page_line` | how they price, read off their own page |
| [`playbook-case-study-page`](../playbook-case-study-page/) | `case_study_line` | who they brag about serving |
| [`playbook-tech-on-website`](../playbook-tech-on-website/) | `tech_line` | what they run, detected on the page |
| [`playbook-google-site-search`](../playbook-google-site-search/) | varies | find any page on their site by keyword |

### List-shaping playbooks (they make other playbooks work)

| Playbook | Output field | What it says |
|---|---|---|
| [`playbook-company-name-cleaning`](../playbook-company-name-cleaning/) | `company_name_clean` | "Irby Utilities, LLC" becomes "Irby" |
| [`playbook-first-name-cleaning`](../playbook-first-name-cleaning/) | `first_name_clean` | "MARIA-JOSE (MJ)" becomes "MJ" |
| [`playbook-social-link-finding`](../playbook-social-link-finding/) | `linkedin_url` etc. | find the profile you are missing |
| [`playbook-lookalikes`](../playbook-lookalikes/) | company list | more companies like these |
| [`playbook-name-to-other-prospects`](../playbook-name-to-other-prospects/) | contact list | more buyers at the same company |

### Copy-generation playbooks (they turn signals into words)

| Playbook | Output field | What it says |
|---|---|---|
| [`playbook-ai-specificity`](../playbook-ai-specificity/) | `specificity_line` | make a generic line concrete |
| [`playbook-creative-ideas`](../playbook-creative-ideas/) | campaign angles | what campaign to run at all |

## Cost tags

Every source row in every playbook carries one of these. They are relative to a 1,000-row list.

| Tag | Means |
|---|---|
| **FREE** | no per-row cost, or included in a flat plan |
| **CHEAP** | under $1 per 1,000 rows |
| **METERED** | $1 to $20 per 1,000 rows, scales with volume |
| **EXPENSIVE** | over $20 per 1,000 rows, or per-row LinkedIn reads |

## Rules that apply to all 19

1. **One playbook, one field.** If you need two signals, run two playbooks and let the copy pick.
2. **Abstain is empty string.** Never "N/A", never "unknown", never a guess. A blank is cheap; a
   confident wrong sentence about someone's own job costs you the account.
3. **The model never establishes a fact.** Every fact goes into the prompt already proven by a
   structured source. The model's only job is to turn a fact list into one sentence. If you find
   yourself asking a model "is this true?", you have skipped a source.
4. **Deterministic fields are computed in code, not by the model.** Dates, counts, enums, and
   anything that branches the copy. Models are for prose.
5. **Gate the paid column.** No paid enrichment runs on a row that failed a free upstream check or
   that has no valid email. This is the single biggest cost lever in Clay.
6. **Run 5 rows and read them before you run 5,000.** Every playbook has a smoke test. The failure
   modes are silent: empty columns, unbound variables, and gates that drop every row look
   identical to "still processing".
7. **No em dashes in generated copy.** They read as machine-written. Hyphens in number ranges are
   fine.

## What you need

Playbooks name credentials by environment variable, never by value. Copy `.env.example` to `.env`
and fill in only what the playbooks you actually run require. The common ones:

| Variable | Used by |
|---|---|
| `PROSPEO_API_KEY` | new-in-role, name-to-other-prospects, social-link-finding |
| `OPENAI_API_KEY` | every playbook with a locked prompt |
| `SERPER_API_KEY` (or another SERP provider) | google-site-search, case-study-page, pricing-page |
| `APIFY_API_TOKEN` | ad-library, linkedin-engagement, social-posts |
| `CLAY_API_KEY` | the `clay` CLI, if you are not using browser OAuth |

Never paste a key into a SKILL.md, a Clay column, or a workflow node body. Clay columns read
credentials from the workspace's saved integration auth; the CLI reads them from your shell.
