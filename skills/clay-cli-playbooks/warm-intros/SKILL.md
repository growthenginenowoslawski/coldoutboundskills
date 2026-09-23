---
name: warm-intros
description: |
  Build a prospect list of people who used to work at one of your customers and have since moved on,
  and write the one-hop line that says so, from Clay's people search on past employers. Removes people
  still employed at the customer and people whose only tie was an advisory, board, fellowship or council
  seat, confirms each person's current employer and title on a free person enrichment, applies the ICP
  you define to the current role, and writes a line only when a dated past role at a named customer is
  on the row. Optional same-metro filter against your reps' cities. Use whenever someone asks: warm
  intro list, who used to work at our customers, alumni of our case-study companies, former employees
  of our clients who are now buyers, ex-customer employees in our ICP, they used to work at a company we
  work with. Do NOT use it to list people engaging with posts (linkedin-engagement), to read what an
  account posted (social-posts), or to read paid ads (ad-library).
---

# Warm intros (former employees of your customers, proven from the row)

The insight: **a past-employer search is not an alumni list until three kinds of people are taken out,
and the search row alone cannot show you one of them.** Measured live on 2026-09-23, ten former-employee
rows for one payroll-software customer, United States:

| Measured | Count | Why it matters |
|---|---|---|
| row carries a dated past role at the customer | 10 of 10 | this is the evidence the line is built from |
| that role was an advisory council seat, "advisor", "fellow" or similar, not a job | **4 of 10** | "you came up through X" is false for them |
| row carries the person's current employer or title | **0 of 10** | the search row returns matched past roles only |
| current employer and title after one free person enrichment | 10 of 10, 0 credits | now the ICP can be applied to the current role |
| still employed at the customer | 0 of 10 | a former-role arm makes this rare but does not rule it out; the enrichment confirms it |

The source build (Growth Engine X, 2026-08-07) ran the earlier form of this search, "include past
experiences", and measured **5 of 20** rows still employed at the customer. Scoping the arm to former
roles removes most of them in the query; confirming current employment on the enrichment catches anyone
who left and came back, and anyone the query form could not exclude.

Three consequences:

- **Exclude non-employment titles**, in the query when the search surface answers and always again on
  the row: advisory, council, board, fellow, investor and intern roles are common on large customers'
  alumni pages and none of them is "came up through".
- **Enrich before you judge.** The ICP describes the person's job now, and the row does not have it.
  The enrichment is a managed function at 0 credits per run, so there is no reason to guess from a
  headline.
- **The line is copied from the row, never inferred.** The customer name and the tenure come from
  `matched_experiences`; if either is missing, the line is blank.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and if an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **Customer list** | the customers or case-study companies the line may name, with each one's domain | no default. Never guess a customer: a wrong one puts a false claim in an email. The installer's own public case-study page is an acceptable source if they point to it |
| **Permission to name them** | confirmation that each customer may be named in outreach | ask per list; without it, write the line without the name or not at all |
| **The ICP** | current titles or functions, seniority, countries | stop and ask. Never infer a band or a country list |
| **Rep cities** | cities where their reps sit, if they want a same-metro cut | skip the metro filter |
| **Target count** | how many survivors they want | ask; plan to pull about 1.7 times it (see Step 3) |
| **Write a line?** | yes or no | default yes; the evidence columns ship either way |

**If an answer sheet is present beside this skill, load it and ask only for what it does not cover.**
Say which values came from the sheet before using them. If there is no sheet, say nothing about sheets.
At delivery, offer to save the answers (identifiers only, never a token): *"want me to save your answers
to a file, so the next person on your team doesn't have to answer these again?"*

## What this skill touches

- **Reads** — Clay's people search for former employees of the customers you name, and one free person
  enrichment per surviving row.
- **Writes** — nothing. The list and the lines are handed back to you.
- **Never** — names a customer you did not confirm, claims a relationship the row does not show, names a
  person as the intro path, or contacts anyone.
- **Halts** — Step 1 other, Step 4 sample-review.
- **Derived from** — the GEX warm-intros playbook, members 1 and 2 (Growth Engine X, probe 2026-08-07),
  ported to the Clay CLI and re-tested 2026-09-23. Not author-confirmed.

## Step 0 — Check the platform works, and say where the work runs

Say this first: *"This searches Clay's people data and enriches the matches; it writes nothing and
contacts nobody."*

```
clay whoami; echo "exit_code=$?"
clay --version                                   # measured on 1.3.0
clay searches query-mode reference | jq -r '.reference' > /tmp/clay-search-reference.md
clay routines list --limit 100                   # find Enrich Person by name
clay routines get <its id>                       # read estimatedCreditCost.perRun; expect 0
```

If `whoami` fails or the CLI is below the server minimum, name the component and the one command that
fixes it, and stop.

| Job | Expected | Declared cost | Field read |
|---|---|---|---|
| former employees of named companies | `clay searches query-mode` people search | search-result quota, not credits; read `periodQuota` | `matched_experiences[]`, `linkedin_url`, `location` |
| current employer and title | managed **Enrich Person**, input `Professional Profile URL` | `perRun` 0 measured | `experience[]` where `is_current`, `company_domain`, `title`; `org` |

If Enrich Person is absent or its `perRun` is above 0, say so and ask before continuing; never swap in a
paid person enrichment silently. The older `clay search filters-mode … include_past_experiences` form
the source build used is not on 1.3.0; the query form above replaces it.

Where the work runs: the search spends quota, the enrichment is free, and the drops, the ICP test and the
line happen in this conversation.

## Step 1 — Collect the definition

Ask for the customer list with domains, the permission to name them, and the ICP. **Do not start a step
before the steps above it have their answers. If a declared input is missing, ask for it — never assume
a default and continue.** If a customer's domain is uncertain, ask; the search returns zero on a wrong
domain rather than an error, which looks like "no alumni".

## Step 2 — Decide where each filter runs

| Filter | In the query | In the agent after enrichment |
|---|---|---|
| former role at a customer | always | — |
| non-employment titles (advisory, board, council, fellow, investor, intern) | when the search is responsive | always, as confirmation |
| country, rep metro | always (profile-level fields) | — |
| still employed at a customer | when the search is responsive | always, as confirmation |
| ICP on the current role | when the search is responsive | always, as confirmation |

A heavier query is not a different answer, only a different place to filter. Under workspace load the
two- and three-arm forms timed out (see `references/search-recipes.md`); the one-arm form plus
agent-side checks returns the same list.

## Step 3 — Count before you pull

Create the search and read the first page with `--limit 10`. If `hasMore` is false and the page is
short, the pool is small: say so before going further. Plan the pull at about 1.7 times the target: on
the measured page 4 of 10 were non-employment roles before the title exclusion existed, and the source
build lost 5 of 20 to still-employed; with both moved into the query, how many the ICP removes is
unmeasured, so read it off the ten-row batch rather than trusting this factor.

## Step 4 — Ten rows, then one gate

Run the free enrichment on the first ten rows, apply Steps 5 and 6, and show the ten rows as they would
be delivered with every drop reason, the estimated full pull, and the quota it will use. There is no
credit spend and nothing is written, so the gate is a sample review: stop and wait for the installer to
confirm the rows look like their market. Stop a second time only if the pool is far off the target.

## Step 5 — Pull, enrich, drop

1. Page the search to the planned count.
2. Enrich every row: `clay routines runs start <Enrich Person id> --input '{"items":[{"id":"r1","inputs":{"Professional Profile URL":"<linkedin_url>"}}]}'`,
   up to 100 items per run; poll `clay routines runs get <routineRunId>`; read
   `.data[i].result["Enrich person"]`.
3. Drop, in order:
   - `still_at_customer` — any current role whose `company_domain` is a customer domain (or, with no
     domain, whose squashed company name matches).
   - `non_employment_tie` — every matched role is an advisory, board, council, fellowship, investor or
     internship title (a query that missed a variant still gets caught here).
   - `outside_icp` — the current title, seniority or country fails the installer's ICP; name the clause.
   - `unenriched` — the enrichment returned nothing; kept in a separate list, never lined.

## Step 6 — Verdict and line, single-valued

Five values, no sixth: `still_at_customer`, `non_employment_tie`, `outside_icp`, `unenriched`, `kept`.
First match wins in that order.

For `kept` rows, when a line was asked for, write one clause that completes *"Noticed …."*:

- starts with *you*, lowercase, past tense for the old role, under 120 characters, no em dashes;
- names the **customer company**, shortened to how people say it (*Gusto*, not *Gusto, Inc.*), and only
  customers the installer cleared to be named;
- **never names a person** and never implies someone introduced them;
- uses the tenure only if both years are on the row; otherwise leaves duration out;
- adds *who we work with now* only if the installer confirmed the customer relationship is current.

Example: `you spent four years at Gusto before your current role`. No evidence on the row, no line.

## Step 7 — Deliver

`kept` rows with name, current title and company, the customer, the matched past title and dates, the
profile URL and the line; then the drops table and the coverage line, and the quota used.

## Representative output

### Alumni prospects

| Person | Now | Customer (past role, dates) | Line |
|---|---|---|---|
| Dana K. | VP Sales, Northwind Freight | Contoso Payroll (Account Executive, 2019-2023) | you spent four years at Contoso Payroll before Northwind |
| Sam R. | Director of Revenue Operations, Fabrikam | Contoso Payroll (Sales Ops Manager, 2021) | you were at Contoso Payroll before this |

### Drops

| Person | Reason |
|---|---|
| Lee M. | still_at_customer: current role at Contoso Payroll |
| Priya S. | non_employment_tie: Partner Advisory Council member only |
| Tomas B. | outside_icp: current title Senior Software Engineer |

### Coverage line

2 customers · 60 former employees pulled (search quota used: 60 results) · 60 enriched (0 credits) ·
18 kept · 3 still_at_customer · 5 non_employment_tie · 34 outside_icp · 0 unenriched.

## What this skill does not claim

- The source build's other warm-intro members are not here: shared investors (no investor field on the
  search surface), event attendees (a custom scrape every time), website visitors (no identified-visitor
  feed on this surface), and mutual connections (no authenticated graph, by design).
- No line has been graded against a labelled set; the example lines were written by the agent from
  measured rows.
- The ICP drop rate is unmeasured; the ten-row sample is the only estimate a run gets.
- Whether the in-query still-employed exclusion changes the result versus the enrichment check has not
  been compared on the same customer; both are applied.

## What good looks like

A good run is short and every kept row defends itself: a named customer the installer cleared, a real
job title there with years, a different employer now that fits the ICP, and a line whose every word
comes from those fields. The drops outnumber the keeps on most lists, and each drop reason is visible.
The coverage line adds up and states the quota spent.

A bad run lines people who never held a job at the customer (council members, advisors), lines someone
who still works there, applies the ICP to a past title because the current one was never fetched,
names a customer nobody cleared, or pads the line with a duration the row did not carry.

## Rules

- MUST use a former-role arm (`is_current = false`) on the customer domains, and drop rows whose only
  matched roles are non-employment titles (in the query when it answers, on the row always).
- MUST confirm the current employer and title on the free enrichment before applying the ICP or writing
  a line.
- MUST drop anyone currently at a customer, by domain first and squashed name second.
- MUST ask for the customer list, the permission to name each one, and the ICP; never infer any of them.
- NEVER name a person as the connection, and never claim a relationship absent from the row.
- NEVER print a month or a duration the row did not carry.
- NEVER substitute a paid person enrichment for the free one without asking.

## Worked example

Asked: *"our client sells to Gusto and Ramp; find US revenue leaders who used to work at either"*,
customers cleared to be named, ICP: current VP, Director or Head of sales or revenue, United States.

The two-arm query with the ICP timed out under workspace load, so the skill ran the one-arm form for one
customer (former Gusto role, United States) and read the first ten rows. Every row carried a dated past
role at Gusto; four of those roles were a partner advisory council seat, "advisor", "growth advisor" and
"fellow", which the next pull excludes in the query. The free enrichment returned the current employer
and title for all ten at 0 credits, and none still worked at Gusto.

| Current role (enriched) | Past role at Gusto | Verdict |
|---|---|---|
| Partner at a venture firm | finance and strategy, 2015-2017 | outside_icp (investor, not a revenue leader) |
| Manager, GTM Recruiting | senior recruiter, GTM, 2021-2025 | outside_icp |
| Founder and CEO of a startup | product and platform roles, 2021-2024 | outside_icp |
| Head of Talent | talent acquisition, 2023 | outside_icp |
| Growth Advisor and SEO consultant | growth advisor, 2020 | non_employment_tie |
| five others | advisory council member, advisor, fellow (non_employment_tie); software engineer, recruiter (outside_icp) | as listed |

Zero of ten in a revenue-leader ICP from an unfiltered first page, which is the finding the gate shows
the installer: put the ICP arm in the query when the search surface allows it, or pull deeper. The line
the skill would have written for the one recruiter had they fit: *you spent more than three years at
Gusto before your current role*.
