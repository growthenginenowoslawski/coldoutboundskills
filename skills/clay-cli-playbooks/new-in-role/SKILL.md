---
name: new-in-role
description: |
  Find people who took their current job title in the last few months, prove the start month and
  whether it was an internal move or a new hire, and write one copy-ready opening clause per person
  ("you stepped into the COO seat at Northwind in July"). Filters on role start date at the source in
  Clay people search, reads each person's full work history with the free person-enrichment function,
  derives promotion versus new hire in code, and only then writes the line. Use whenever someone asks:
  who just started, new in role, recently promoted, new VP of X, new COOs in my market, job change
  signal, people who just took the seat, congratulate new leaders, first 90 days in role. The search
  row carries only the current role, so without the history read one line in five says "joined" to
  someone who was promoted. Do NOT use it to track your own champions or customers moving to a new
  company (track-champion-job-changes), to measure company hiring (hiring-radar), or to find colleagues
  of a known prospect (name-2-other-prospects).
---

# New in role (filter on the start date at the source, then read the history before writing a word)

The insight: **"new in role" is a search filter, not an enrichment — and the filter proves only the
date. It does not prove the direction of the move, and the search row cannot tell you.** Measured on
2026-09-23 against Clay people search: one query with
`experiences.any(is_current = true and job_title is_similar_to (...) and start_date >= today() - interval 3 months ...)`
returned 10 of 10 rows whose current role started 2026-07 to 2026-09, at zero credits, and the
filter held in the other direction too: three COOs 4 to 19 years in the seat were absent when the same
query was scoped to their three companies — which returned instead a different, genuinely new COO at
one of them. But each row
carries only the experience that matched — no prior roles, no company domain. A free profile read of
the same 10 people showed **2 of 10 were internal promotions** (a General Manager who became COO; an
SVP who became COO). A line written from the search row alone says "you joined" to both. That is a
false statement to 20% of the list, about the one fact the email opens on.

Three more things the same run showed, each of which shapes a step below:

- **The title filter expands on purpose.** `job_title is_similar_to ("VP of Operations")` returned an
  "Executive Vice President of Operations" — the platform documents `is_similar_to` as synonym
  expansion. So a title gate in code, on the current title, with your abbreviations, is mandatory.
- **"Current" can mean eleven things.** One person carried 11 concurrent current roles (board and
  advisory seats). The search matched the COO one correctly, but a line about "your new seat" to a
  serial advisor reads differently; the fact pack carries the count so the agent can see it.
- **The search row has no company domain.** The profile read supplies it — and once returned a parent
  group's domain rather than the operating company's. Never key a downstream email lookup on it
  without a look.

What was measured before this port (2026-08-04, a different people database, same design): on one
title in the US at 50–1,000 employees, **1,662 people unfiltered → 22 in a 6-month window → 2 in a
3-month window**. A 90-day window costs about 90% of the volume, and widening the title family moved
volume far more than widening the window did (a five-title family returned 1,925 at 6 months). The
same run found **1 in 10 lines asserted a title the company's own website contradicted** — a wrong
title in the source data, faithfully rewritten into polished copy. No check over the generated line
can catch that, because the line is a correct rewrite of a wrong fact.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and where an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **Target titles** | the role family, as the people who hold it write it (e.g. COO, VP of Operations, Head of Operations) | no default — there is nothing to search for |
| **Title gate keywords** | the words a current title must contain to count, **including abbreviations** (coo, vp ops) | derive them from the titles, show the list, and ask them to add abbreviations; never run with an empty gate |
| **Geography** | countries, or states/cities | no default — ask |
| **Company size** | the headcount bands their market sits in | no default — ask; it is the easiest filter to widen later |
| **Window** | months since the role started | **3 months is defensible** (the "first 90 days" premise) and must be stated; 6 is the first widening; never past 9, where "just started" stops being true |
| **What an empty line means** | keep the person without the clause, or drop them | ask — a "congrats on the new seat" campaign drops; a general campaign keeps |
| **How many people** | the list size they need | ask — it decides whether the window or the title family has to widen, and the order is fixed (Step 2) |

**If an answer sheet is present beside this skill, load it and ask only for what it does not cover.**
Say which values came from the sheet before using them. If there is no sheet, say nothing about
sheets. At delivery, offer to save the answers (identifiers only, never a token or a password),
private and never published: *"want me to save your answers to a file, so the next person on your team
doesn't have to answer these again?"*

## What this skill touches

- **Reads** — Clay people search (search-result quota, not credits), and the free person-enrichment
  function for each person the search returns.
- **Writes** — nothing. The deliverable is a table handed back to you; nothing is written to a CRM, a
  sequence or a Clay table.
- **Never** — sends, enrolls or writes anything; states a promotion the work history does not show; or
  writes a line for a person whose start month it could not read.
- **Halts** — Step 4 sample-review.

## Step 0 — Verify Clay and pull the live surfaces

Say this to the installer as the run starts: *this reads Clay people search and a free person
enrichment, writes nothing, and hands you a table.* Then:

```
clay whoami; echo "exit_code=$?"
clay --version
clay searches query-mode reference | jq -r '.reference' > /tmp/clay-search-reference.md
clay routines list --limit 100 | jq '.data[] | select(.name == "Enrich Person")'
clay routines get <the id that returned>
```

What each must show, and what to do if it does not:

| Check | Expect | If not |
|---|---|---|
| `whoami` | exit 0, a workspace name | stop; run the Clay plugin's `setup` skill |
| search reference | a section on dates and tenure that documents `start_date` as a month field inside `experiences.any(...)` and `today() - interval N months` | stop and say so; the whole skill rests on this filter |
| `Enrich Person` in the routine list | present; ids differ per workspace, so find it by name | stop and report it missing; do not substitute another person enrichment, which costs credits |
| `routines get` | `estimatedCreditCost.perRun` of **0**, and an input named `Professional Profile URL` | if the cost is above 0, price it per person at Step 4 and add `spend-approval` to that gate; if the input name differs, use the live name |

Where the work runs: the search and the enrichment run on Clay; the date arithmetic, the promotion
logic and the title gate run locally in `scripts/derive_role_facts.py` (free, no network); the line is
written by you, the agent reading this skill. **No Clay AI column and no outside model key.**

If the platform check fails, say which component is wrong and the one command that fixes it. Do not
install, upgrade or fetch anything to repair it.

## Step 1 — Collect the definition (do not guess)

Do not start a step before the steps above it have their answers. If a declared input is missing, ask
for it — never assume a default and continue.

Front-load titles, geography, size and window, because they decide what gets pulled. Ask the rest at
the step that needs it. Show the title gate you derived from their titles and ask them to add the
abbreviations their market uses: a gate of "chief operating officer" silently drops every "COO".

## Step 2 — Write the query, and size it before pulling

One query, the window inside the same `experiences.any(...)` as the title so both describe the same
current role:

```
select from people
where experiences.any(
        is_current = true
        and job_title is_similar_to ("Chief Operating Officer", "VP of Operations")
        and start_date >= today() - interval 3 months
        and company.company_size in ("51-200", "201-500", "501-1,000", "1,001-5,000"))
  and location_country = "United States"
```

- Use `today() - interval N months`, never a frozen `"YYYY-MM"`: the saved query stays correct next month.
- The window is month-granular. "Last 30 days" rounds to 1 month, never looser.
- Size filters go on `company.company_size` buckets, which are band-aligned outward (a stated ceiling
  of 2,000 becomes the 1,001–5,000 bucket). Say so in the output.
- **Name only the titles the installer named.** `is_similar_to` already expands; adding synonyms
  double-expands.

`clay searches query-mode create --query '<query>'` returns a `searchId`; `clay searches query-mode run
<searchId> --limit 10` returns the first page. Both are search quota, not credits. The iterator is
forward-only: save every page to a file as it arrives, because a page cannot be re-read.

**If the list is too thin, widen in this order and record it:** (1) more titles in the family, (2)
wider geography or a lower size floor, (3) the window, to 6 months and never past 9. Titles multiply
volume; the window mostly adds people whose news is old.

Read `periodQuota` on each page if present (it is optional in the response) and report what the run
used.

## Step 3 — Free checks before anything else

On the saved page, before any enrichment:

- Every row's `matched_experiences[0].start_date` is inside the window. A row outside it means the query
  was written wrong — stop and fix the query, do not filter it away.
- An empty first page (`data: []`, `hasMore: false`, `exhaustionReason: "no_more_results"`) is a real
  answer: no one matches. Report it with the query, and offer the Step 2 widening order. Never widen
  silently.
- A retry: `server_error` and `rate_limited` are transient, and the help says a retry can re-serve and
  re-count a page. Retry only when no data came back.

## Step 4 — Ten rows, then ONE gate

Take the first 10 rows. Build the enrichment run body with item ids `p0`…`p9` in page order (the
derive script joins on them), from each row's `linkedin_url`:

```
{"items": [{"id": "p0", "inputs": {"Professional Profile URL": "<row 0 linkedin_url>"}}, ...]}
clay routines runs start <Enrich Person id> --input body.json      -> routineRunId
clay routines runs get <routineRunId> --limit 100 --wait 120
```

Runs take up to 100 items; inline runs of 5 and 10 completed in under 30 seconds when measured. Then:

```
python3 scripts/derive_role_facts.py --search page1.json --enrich run1.json \
  --window 3 --gate "chief operating officer,coo,vp of operations,vp operations" --today 2026-09
```

It emits, per row, a single verdict (Step 6), the start month, months in role, `promotion` or
`new_hire`, the prior title and company, the company domain, and how many current roles the profile
carries. **Two traps it already handles:** a person the enrichment cannot find comes back
`status: complete` with an **empty result**, not an error, so a success count is not a found count;
the result is keyed `"Enrich person"` although the routine is listed as `"Enrich Person"`, so the
script takes the single value rather than trusting the name; and `runs get` returns **20 items per page
by default**, so a larger run fetched without `--limit 100` silently drops people — the script refuses
to run when a file holds fewer items than the run's `total`.

**Percent-encode each profile URL before it goes in the run body.** Profile slugs can carry non-Latin
characters, and one such URL rejects the **whole** run with `validation_error` ("Must be a valid URI
including protocol"), not just that item (measured). In Python: `urllib.parse.quote(url, safe=":/%")`.

Write the 10 lines (Step 5), then stop and show, in one message: the 10 rows with their verdicts and
lines; the pull size you expect for the full run and how many pages that is; the cost — search quota
only and 0 credits for the enrichment as read at Step 0 (or the per-person figure if it read higher);
that nothing is written anywhere; and the ask: *run the rest?* Wait.

Stop a second time only if the full run reveals something the batch could not show — a verdict mix far
off the batch's, or a class of title nobody mentioned.

## Step 5 — Write the line (you are the writer)

Only for rows whose verdict is `ready`. The line completes the sentence **"Saw ___."**

- Lowercase first letter, no trailing period, no quotation marks, at most 90 characters, short words,
  no em or en dashes.
- Say the seat, the company and when. Use the month name. Say "earlier this year" only when the start
  year is the current year **and** the month is more than 4 months ago; for a start in a previous year,
  say the month and the year.
- `promotion` → "you stepped into the COO seat at …" or "you took over …". **Never** "moved up", "got
  promoted" or "was promoted": the history proves an internal move, not its direction.
- `new_hire` → "you joined … as …" is allowed.
- The company's shortest spoken form: drop anything in parentheses, legal suffixes and trailing
  descriptions. Drop parenthetical qualifiers from titles too ("Chief Operating Officer (AI
  Transformation)" → "COO").
- Never mention anything not in the fact pack: no headcount, funding, industry or prior employer.
- If the title, the company or the start month is missing, write nothing for that row.

## Step 6 — Verdicts, single-valued, first match wins

Five values, no sixth, resolved in this order by the script:

1. `no_profile` — the enrichment returned nothing, or no start month. No line.
2. `role_mismatch` — the profile carries no current role matching the search row's company or title:
   the index is stale or the profile is a different person. No line.
3. `outside_window` — the profile's start month is older than the window. No line.
4. `title_off_target` — the current title contains none of the gate keywords (the synonym expansion
   caught something the installer did not ask for). No line, listed so they can widen the gate.
5. `ready` — write the line.

## Step 7 — Deliver

One table, then a coverage line stating: the query as run, the window and whether it was chosen or
accepted, rows pulled, the verdict counts, and how many lines were written. List `title_off_target`
rows separately — they are the installer's call. Say plainly that titles were not checked against an
independent source (see below).

## Representative output

### New-in-role lines

| Person | Company | Current title | Started | Months | Move | Prior title | Verdict | Line |
|---|---|---|---|---|---|---|---|---|
| Dana K. | Northwind Traders | Chief Operating Officer | July 2026 | 2 | new_hire | SVP Operations, Contoso | ready | you joined Northwind Traders as COO back in July |
| Marcus L. | Fabrikam | Chief Operating Officer | August 2026 | 1 | promotion | General Manager | ready | you stepped into the COO seat at Fabrikam in August |
| Priya S. | Tailspin Toys | Executive Vice President of Operations | July 2026 | 2 | new_hire | VP Operations, Litware | title_off_target | — |
| Omar H. | Adventure Works | — | — | — | — | — | no_profile | — |

### Coverage line

Query: COO or VP of Operations, US, 51–5,000 employees (buckets), started in the last 3 months (window
chosen). 40 pulled · 34 ready · 3 title_off_target · 2 no_profile · 1 role_mismatch · 34 lines written.
Titles are as the profile states them; none were checked against the companies' own sites.

## What this skill does not claim

- The title is whatever the person's profile says; this skill does not check it against the company's own website, and the earlier build measured 1 wrong title in 10 that way.
- The profile read comes from Clay's own data, so it confirms the start month and history against that data, not against an independent source.
- Verified live on one 10-person page on 2026-09-23; the promotion rate (2 in 10) and the verdict mix are from that page, not a population rate.
- The volume figures (1,662 → 22 → 2) were measured on a different people database on 2026-08-04 and are a sizing guide, not a Clay yield.
- It does not find email addresses, and it does not say whether a move was a step up.
- Company size is filtered on Clay's size buckets, which widen a stated ceiling outward to the bucket edge.

## What good looks like

A good run hands back a table where every `ready` row's line is true in both of its claims — the month
and the kind of move — and every row without a line says why in one word. Promotions read "stepped
into", new hires read "joined", and the split roughly matches the history rather than being all one or
the other. The coverage line names the window and the query so the list can be re-pulled next month.

A thin run looks like: every line says "joined" (the history read was skipped); lines for people whose
titles the installer never asked about (the gate was empty or had no abbreviations); a list of three
people presented without the widening options; or rows with no line and no verdict. The most expensive
failure is invisible in the table: a line written straight from the search row, which is grammatical,
on-brand and wrong for one person in five.

## Rules

- MUST put the start-date filter inside the same `experiences.any(...)` as the title and `is_current = true`; NEVER filter start dates after the pull.
- MUST read each person's work history before writing a line; NEVER derive promotion or new hire from the search row.
- MUST run the title gate on the current title with the installer's abbreviations; NEVER run with an empty gate.
- MUST keep the window at or under 9 months; NEVER write "just started" copy past that.
- NEVER write "promoted", "moved up" or "got promoted".
- NEVER write a line for a row whose verdict is not `ready`.
- NEVER count an enrichment item with an empty result as found.
- MUST say that titles were not independently verified.

## Worked example

Asked: *"New COOs in the US, companies 50 to 2,000 people, I need about 30."*

Declared: titles COO and VP of Operations; gate `chief operating officer, coo, vp of operations, vp
operations`; US; buckets 51-200 through 1,001-5,000 (the 2,000 ceiling widens to 5,000 — said so);
window 3 months (accepted, not chosen — said so); empty line → keep without the clause.

Run on 2026-09-23. The first page was pulled with a numeric headcount filter (50–2,000) before the
bucket rule was adopted: ten rows, all starting 2026-07 to 2026-09. Re-run with the buckets above, the
page held 9 of the same 10 people plus one new one. Enrichment of the first ten: 10 of 10 complete, 0
credits, balance unchanged. Derived: 8 `new_hire`, 2 `promotion`; all 10 `ready` against that gate. One
person held 11 concurrent current roles; flagged in the table. Two of the lines, as written:

- a new hire at a data-centre operator: *you joined Aligned Data Centers as COO in September*
- a promotion at a clinical-research company, prior title General Manager: *you stepped into the COO seat at DaVita Clinical Research in September*

With the gate narrowed to `chief operating officer, coo`, the "Executive Vice President of
Operations" row turns `title_off_target` — the synonym expansion made visible. Gate shown, batch
shown, zero credits, nothing written; asked *run the rest?* and stopped.
