---
name: hiring-surge
description: |
  Find which accounts are growing one specific department right now (sales, marketing,
  engineering, whatever you sell to) and write a first line about it that a team lead cannot
  disprove: pull the department's current people from Clay's people index, count whose current
  role started inside the window, review the titles, gate on floors plus a growth ratio, and
  word the result as role starts, never as hires. Use whenever someone asks: who is scaling their
  sales team, hiring surge, growing their marketing team, which accounts added SDRs, department
  headcount growth, is this team growing, build the team is scaling angle. Role starts include
  promotions and moves (measured 28% internal), and titles containing a department's word are
  not all in that department, so this skill counts people it has read and words the result
  as role starts, not hires.
  Do NOT use it to count job postings or rank accounts by open roles (hiring-radar), to match
  the wording of job ads (job-posting-language), for company-wide employee growth alone, for
  the individual people who just started (new-in-role skills), or funding (fundraising).
---

# Hiring surge (count role starts in the team, read who they are, word them as role starts)

The insight: **a department surge is a count of people whose current role started in the window —
not a count of hires, and not a count of everyone whose title contains the department's word.**
Both gaps are large enough to flip the verdict, and both are measured:

| Measurement | Result | Date |
|---|---|---|
| Of 276 people whose current role started inside a six-month window at 18 companies, how many already worked there before the window? | **78, 28.3%** (sales titles 24.4%, marketing 34.6%); a lower bound | 2026-08-05 |
| One real account, "sales" by title words, from Clay's people index | **25 people, 10 role starts, +66.7%**, verdict surge | 2026-09-23 |
| The same payload after reading the titles | 12 of the 25 were contract AI-training roles with "sales" in the title; the real team was **13 people with 2 role starts**, one of them a Director of Sales promoted to VP | 2026-09-23 |
| A growth-ratio gate with and without absolute floors (at least 2 starts, team of at least 4), benched on 20 held-out companies | **17 of 20** correct with floors, 10 of 20 without | 2026-08-05 |
| The same floors on 3,964 companies | cut the gated share from 14.6% to **5.2%** | 2026-08-05 |
| Does a company-wide employee-growth filter find department surges? | 17.6% of companies inside the filter cleared the gate vs 13.7% outside; a 1.28× lift that discards ~76% of the list | 2026-08-05 |

What follows, step by step:

**Read the people, not a number.** Clay's people index returns every current employee matching the
department's title words with their current role's start month, at search quota and no credits. A
count-only action exists (1 credit, Step 0), but a count cannot be reviewed; the list can, and
the list is what exposed the 25 → 13.

**Promotions are in the count.** The same payload shows a person's earlier role at the same
company when its title also matches, so the skill reports how many starts it can *see* were
internal moves. It cannot see them all, which is why the copy says "started new roles" and never
"hired", "added" or "brought on".

**Department, not company.** Company-wide growth is a list pre-filter at best: a 1.28× lift for
three-quarters of the list. Use it only when the list is at least four times larger than needed.

Do not start a step before the steps above it have their answers. If a declared input is missing,
ask for it — never assume a default and continue.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and if an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The accounts** | domains (or an ICP to search for them) | no default |
| **Departments** | which teams matter to the offer | no default; it is the whole question |
| **Title words per department** | the words that put a title in that team | the author's sets are in `references/department-title-words.md`; show them, and let them edit |
| **Title exclusions** | words that put a title *outside* the team (contractors, trainers, client-service "account" roles at agencies) | none up front; they are chosen at the Step 4 review from titles actually returned |
| **Window** | months for "recent" | the author used 6; if they have no view, use it and SAY it is borrowed |
| **Gate** | floors and growth threshold | the author's: at least 2 starts, a team of at least 4, and growth over 15% or more than 6 starts; SAY they are borrowed |
| **Copy frame** | the sentence the line completes | the author used `Noticed <line>.` |

**If an answer sheet is present beside this skill, load it and ask only for what it does not
cover.** Say which values came from the sheet. If there is no sheet, say nothing about sheets. At
delivery, offer to save the answers (never a token).

## What this skill touches

- **Reads** — the accounts you supply and Clay's people and company search indexes.
- **Writes** — nothing. The verdicts and lines are handed back to you.
- **Never** — says a company hired anyone, names a person in copy, or counts a title the installer excluded at review.
- **Halts** — Step 4 sample-review.

## Step 0 — Check the platform, and say where the work runs

Say to the installer first: *"This only searches Clay's people index — search quota, no credits —
and writes nothing. I will show you real titles from ten accounts before running the rest."*

```
clay whoami; echo "exit_code=$?"
clay --version
clay searches query-mode --help        # the plan's per-request and per-period result limits
clay workflows actions schema e251a70e-46d7-4f3a-b3ef-a211ad3d8bd2 cpj-get-counts-for-profiles-v2
```

| Job | What runs | Declared cost | What you read |
|---|---|---|---|
| department people, per account | people search, `select from people ...` | search result quota, one result per person returned | `matched_experiences[].title`, `.start_date`, `.end_date`, `.company`; `hasMore` |
| count only (not used; for comparison) | `(e251a70e-46d7-4f3a-b3ef-a211ad3d8bd2, cpj-get-counts-for-profiles-v2)` | `creditCost 1` | `roleCount` |

Each person returned consumes one search result from the plan's period quota: a 50-person
department costs 50 results. Say the plan's limit from `--help` before a large run. If search is
unavailable or the plan's quota cannot cover the run, say so and stop. If the platform check
fails, name the component, the version and the one command that fixes it; fetch nothing.

Where the work runs: the people pull in Clay search; every count, ratio and verdict in the agent
by `scripts/surge_gate.py`; the wording in the agent.

## Step 1 — Collect the definition (interview; do not guess)

Ask for the accounts, the departments, the window and the gate. Show the title words for each
department from `references/department-title-words.md` and ask them to add or strike. Ask
nothing about exclusions yet: they are decided on real titles in Step 4.

## Step 2 — Free pre-filter, only if the list is oversized

If the installer's list is at least four times larger than the number of lines they need, offer a
company-level cut first (it discards most of the list for a small lift):

```
select from companies where clay.include_company_identifiers((...)) and employee_growth_6mo >= 1.1
```

Otherwise skip it. Under load the growth field combined with a headquarters-location clause timed
out repeatedly on the test day; the growth field alone returned.

## Step 3 — Pull each department once per account

One search per account per department. The title words and the current-role scope sit inside
**one** `experiences.any(...)`; the employer is `clay.filter_to_companies`:

```
clay searches query-mode create --query 'select from people where clay.filter_to_companies(("example.com")) and experiences.any(is_current = true and job_title contains ("sales", "account executive", "business development", "sales development", "account manager"))'
clay searches query-mode run <searchId> --limit 500
```

Save each page as `<domain>.<department>.json`. There is no separate "recent" query: each person's
current-role `start_date` is in the payload, so the window is applied in the agent, and one query
serves both the team size and the role starts.

Use `contains` with the declared words rather than `is_similar_to`: the similarity operator
expands titles differently over time, and on the test day it timed out more often. Retry a page
that returned HTTP 504 after twenty seconds; never re-create a search that already returned data.

## Step 4 — Ten accounts, then ONE review

Run Step 3 for ten accounts and gate them (Step 5). Then show, in one message:

- per account and department: team, role starts, verdict;
- **every distinct current title that was counted**, grouped, most frequent first — this is the
  review that turned 25 into 13 on the test day;
- that no credits were used, and how many search results the full list will consume;
- the ask: *"any titles to exclude before I run the rest?"*

Stop and wait. Apply the exclusions to the ten saved pages with `--exclude` (no second search),
show the changed verdicts, and use the same exclusions on every later account.

## Step 5 — Gate in code

```
python3 scripts/surge_gate.py example.com.sales.json "Example" 2026-03 --exclude "trainer,ai training"
```

The cutoff is today minus the window, as `YYYY-MM` (six months before 2026-09-23 is `2026-03`).
The company name is the one Clay's company search returns for the domain (`name`), spelled
exactly: the people payload names employers, and a person can match through a sales title at a
*second* current employer — on the test day two of darwix.ai's five matches held their sales
title at another company. The script keeps only people whose current matched role is at the named
company, drops excluded
titles, counts role starts on or after the cutoff, counts starts that follow an earlier role at the
same company as `internal_moves_seen`, and returns one verdict — five values, first match wins:

1. `no_department_found` — nobody at the company matched the title words.
2. `lower_bound_only` — the page was capped (`hasMore` true); the counts are floors, never gated.
3. `below_floor` — fewer starts or a smaller team than the floors.
4. `surge` — growth, measured as starts over the team that was there before the window, above the
   threshold, or the whole team new, or more starts than the override.
5. `steady` — everything else.

People whose current start date is empty or a bare year cannot be placed in a month window; they
count toward the team and are reported as `undated`.

Two author-flagged guards are **not** in the script because they were never benched: a large
team (hundreds of people) with ordinary churn can pass on the override alone, and at agencies
"account executive" and "account manager" are often client service. Name them to the installer
when an account looks like either.

## Step 6 — Word the line

For each `surge` account, one clause per account, the first surging department in the installer's
order:

- completes the frame (`Noticed <line>.`); second person; lowercase first letter; no trailing
  period; no dashes; under 90 characters;
- the exact `role_starts` number and the department name; the time phrase is "in the last six
  months" (or the declared window in words), never a month or date;
- says people *started new roles*, never that the company hired, added, recruited or grew by them;
  never the company's name, never a person's name.

Example: `your sales team has 8 people who started new roles in the last six months`.

## Step 7 — Deliver

Per account: domain, department, team, role starts, internal moves seen, undated, growth %,
verdict, line. Above it: the window, gate and title words, each marked chosen or borrowed, and the
exclusions agreed at review.

## Representative output

### Department surge table

| Account | Department | Team | Role starts (6 mo) | Internal moves seen | Growth | Verdict | Line |
|---|---|---|---|---|---|---|---|
| northwind.example | sales | 28 | 8 | 2 | +40.0% | surge | your sales team has 8 people who started new roles in the last six months |
| contoso.example | marketing | 15 | 2 | 0 | +15.4% | surge | on your marketing team, 2 people started new roles in the past six months |
| fabrikam.example | sales | 3 | 1 | 0 | +50.0% | below_floor | |
| tailspin.example | marketing | 0 | 0 | 0 | — | no_department_found | |

### Review sheet

| Title counted as "sales" | People | Kept after review? |
|---|---|---|
| Account Executive | 9 | yes |
| AI Trainer - Sales Expert | 6 | no, excluded as "trainer" |

### Coverage line

120 accounts · 2 departments · 96 with a sales team found · 11 surge after review · 3 capped at 500, reported as floors · window, gate and title words borrowed from the author.

## What this skill does not claim

- The 28.3% internal-move rate and the 17-of-20 bench come from the author's earlier builds on another source; on Clay search the skill only reports the internal moves it can see, which is fewer.
- Title words are a proxy for department; the review step catches what it shows, not what it hides.
- The paid count-only action was not run (1 credit per call, read live 2026-09-23); it is named for comparison, not used.
- Clay's people search timed out repeatedly under load on the test day, so throughput per hour is not measured.
- The large-team and agency guards are unbenched and not enforced.

## What good looks like

A good run delivers, for every account, a team size and a role-start count the reader can trace to
named titles they approved, a verdict from the fixed five, and a line only on `surge` rows that
says people started new roles. The review sheet shows what was excluded and why, and the borrowed
thresholds are labelled. Capped pages appear as floors and are never gated.

A thin run delivers numbers nobody looked behind: counts with no title review, a surge on an
account whose "department" is a contractor pool, "hired" in a line, or a zero where the page was
capped. The quiet failure is the one measured above — a verdict that holds at 25 people and
collapses at 13 — which is why Step 4 shows titles, not just totals.

## Rules

- MUST read the department's people and show their titles for review before gating the full list.
- MUST count role starts from each person's current matched role at that company, inside the declared window.
- MUST report internal moves seen, and MUST word every line as people who started new roles; NEVER "hired", "added", "brought on", "recruited" or "grew".
- MUST apply the floors before the ratio; NEVER gate a capped page.
- MUST keep the title words and exclusions identical across the cohort once agreed.
- NEVER put a person's name or the company's name in the line.
- NEVER use company-wide growth as the department signal.

## Worked example

Asked: *"which of these fast-growing software companies are scaling their sales or marketing
teams?"* Window 6 months, gate and title words borrowed.

Step 3, live on 2026-09-23 at search quota only, micro1.ai sales: 25 current people matched the
sales words; 10 started their current role in or after 2026-03; growth +66.7%; verdict `surge`.

Step 4 review of the same page: 12 of the titles were "AI Trainer - Sales Expert"-style contract
roles. Excluding "ai trainer", "ai training", "training expert", "ai expert", "human data expert"
and "trainer" with `--exclude` on the saved page, no second search: team 13, role starts 2, one
of them a Director of Sales who became VP of Sales in 2026-04 (`internal_moves_seen: 1`), growth
+18.2%, verdict still `surge` — and the line changes from "10 people" to
`your sales team has 2 people who started new roles in the last six months`, with a note to the
installer that one of the two is a promotion.

The other accounts in the ten-row batch, same day, same words, search quota only:

| Account | Department | People returned | Team at the company | Role starts | Growth | Verdict | Line |
|---|---|---|---|---|---|---|---|
| n8n.io | sales | 59 | 59 | 22 | +59.5% | surge | your sales team has 22 people who started new roles in the last six months |
| n8n.io | marketing | 21 | 21 | 5 | +31.2% | surge (second department; the line goes to sales, first in the installer's order) | |
| darwix.ai | sales | 5 | 3 (two held their sales title at another employer) | 2 | +200% | below_floor | |
| darwix.ai | marketing | 0 | 0 | 0 | — | no_department_found | |
| n8n.io | sales, page capped at 20 | 20 | — | — | — | lower_bound_only | |

darwix.ai is the floors earning their place: +200% on a three-person team is two people, and the
author's bench says a line there reads worse than no line.
