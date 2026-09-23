---
name: job-posting-language
description: |
  Find which of your accounts have an open job posting whose full description uses the language
  your offer answers (cold calling, outbound prospecting, a named tool, a compliance regime), and
  write a first line naming that role: gate the whole list free on the posting text with Clay
  search, split the matches by role family, then quote one live posting with its public link and
  date from the company's own job board. Use whenever someone asks: which accounts are hiring for
  X, job descriptions that mention Y, who is hiring SDRs that cold call, postings that mention
  Salesforce, write a line about the role they are hiring for, job posting language, find the
  hiring signal in the job ad. Matching is on whole phrases in the full description, never on a
  title and a summary, and a line is only written from a posting you can link and date. Do NOT
  use it to count open roles, rank accounts by hiring volume or trend (hiring-radar), measure
  department headcount growth (hiring-surge), find the people who just started (new-in-role
  skills), or funding (fundraising).
---

# Job posting language (gate on the full text, quote only what you can link)

The insight: **whether a company is hiring for your problem lives in the body of the posting, and
the free Clay surface that can read every body cannot quote one, while the free surface that can
quote one cannot reach every company.** So the skill uses both, in that order, and never lets
either stand in for the other.

What the author measured:

| Measurement | Result | Date |
|---|---|---|
| Same 8 companies, same 8 phrases: scanning returned titles and summaries vs filtering the full description at the source | **1 of 8** vs **5 of 8** companies matched | 2026-08-04 |
| Phrase matching is by whole token, not substring: `cold call` vs `cold calling` over one job index | 996 vs 2,065 postings | 2026-08-04 |
| Clay company search with a posting-description predicate, 10 sales-tech companies, 60-day window | 4 matched, 0 credits; returns company rows only, no title, link or date | 2026-09-23 |
| Public job boards on the domain stem, same 10 companies | 7 of 10 had one (4 on one board vendor, 2 on another, 1 on a third); 6 re-read through Clay's HTTP action at 0 credits | 2026-09-23 |
| Where both surfaces covered a company, did they agree? | 5 of 5 (2 matched on both, 3 unmatched on both) | 2026-09-23 |
| One company's only in-window match on its board | a customer-success role whose description mentioned "outbound prospecting" | 2026-09-23 |

Three consequences:

**A title and a summary are not the posting.** Any source that returns less than the full
description can gate or confirm, never decide. Clay search filters on the full text server-side;
the public boards return it whole.

**Enumerate your phrases.** Search `contains` matches whole words, so `cold call` misses
`cold calling`. List every form — call, calls, calling — or lose about a third of the matches.

**Language alone picks up the wrong roles.** The description phrase matched a customer-success
role; a line naming it would have told a support leader they are hiring salespeople. So the
installer declares role families too, and the line names a role from a posting that matched both.

Liveness comes free on both surfaces: search carries `job_still_open`, and a company's public
board lists only what it is currently advertising. The author's earlier build, on a source with
neither, quoted a 53-day-old posting that had already been taken down.

Do not start a step before the steps above it have their answers. If a declared input is missing,
ask for it — never assume a default and continue.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and if an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The accounts** | domains, up to 1,000 per search call | no default |
| **Phrases** | the description language that means "they have our problem", every word form listed | no default; this is the signal |
| **Role families** | the kinds of role that make the phrase relevant, as title words (for example sales development, account executive) | ask; without them a support or engineering role can carry the line |
| **Detection window** | days a posting may be old and still count | the author used 60; if they have no view, use it and SAY it is borrowed |
| **Copy window** | days a posting may be old and still be named in copy | the author used 30; same rule |
| **Board locations** | careers page or job-board link per account, if they have them | the skill tries three public boards on the domain stem, and says which it found |
| **Paid quote arm** | whether to buy a quote for matched accounts with no public board | ask at the gate; default is no, and those rows are delivered unquoted |

**If an answer sheet is present beside this skill, load it and ask only for what it does not
cover.** Say which values came from the sheet. If there is no sheet, say nothing about sheets. At
delivery, offer to save the answers (never a token).

## What this skill touches

- **Reads** — the accounts you supply, Clay company search, and the public job boards of the matched companies.
- **Writes** — one workflow in your Clay workspace, named so you can find and delete it, that reads public job boards. Nothing else, and no record in any CRM.
- **Never** — names a role from a posting it cannot link, quotes a posting older than the copy window, or sends your account list anywhere but Clay and the public board addresses of those same companies.
- **Vendor-specific** — the public job-board endpoints of three applicant-tracking vendors, listed in `references/quote-workflow.md`; no account or key is needed. A company not on any of them gets no free quote: it is delivered unquoted, or quoted through the paid arm if approved.
- **Halts** — Step 4 write-approval, Step 5 sample-review, Step 5 spend-approval.

## Step 0 — Check the platform, and say where the work runs

Say to the installer first: *"This searches Clay (search quota, not credits), then reads public job
boards through one small Clay workflow I will ask before creating. Nothing costs credits unless you
choose the paid quote at the gate."*

```
clay whoami; echo "exit_code=$?"
clay --version
clay credits balance
clay searches query-mode --help
clay workflows actions schema 4299091f-3cd3-4d68-b198-0143575f471d http-api-v2
clay workflows actions schema e251a70e-46d7-4f3a-b3ef-a211ad3d8bd2 cpj-find-lists-of-jobs
```

Expected, read live 2026-09-23:

| Job | What runs | Declared cost | What you read |
|---|---|---|---|
| gate and role split | company search, `jobs.exists(...)` | search result quota, 0 credits | the returned `domain` list |
| quote from a public board | `(4299091f-3cd3-4d68-b198-0143575f471d, http-api-v2)` in a workflow | `creditCost` null, 0 credits | the board JSON, matched by `scripts/posting_match.py` |
| quote when there is no board (optional) | `(e251a70e-46d7-4f3a-b3ef-a211ad3d8bd2, cpj-find-lists-of-jobs)` | `creditCost 1` per call | `jobs[].title`, `jobs[].url`, `jobs[].posted_at`; pass `job_description_keywords`, `max_num_days_since_posted`, `limit` explicitly |

If any of these is absent or priced differently, **say so and stop**. If the platform check
fails, name the component, the version required and the one command that fixes it; do not install
or fetch anything to repair it.

Where the work runs: the gate and role split in Clay search; the phrase matching in a Clay code
node; the wording in the agent. None of it bills credits unless the paid arm is approved.

## Step 1 — Collect the definition (interview; do not guess)

Ask for the accounts, the phrases, the role families and the two windows. Read the phrases back
with their missing forms added ("cold call" → "cold call", "cold calls", "cold calling") and ask
them to confirm. If they give a role but no phrase, the job is a title search, and the phrase
filter adds nothing: say so, and run Step 2 with the title predicate only.

## Step 2 — Gate the whole list, free

One company search per 1,000 accounts. Run the coverage control and the gate:

```
clay searches query-mode create --query 'select from companies where clay.include_company_identifiers(("a.com", "b.com"))'
clay searches query-mode create --query 'select from companies where clay.include_company_identifiers(("a.com", "b.com")) and jobs.exists(job_still_open = true and job_posted_date >= today() - interval 60 days and job_description contains ("cold call", "cold calls", "cold calling"))'
clay searches query-mode run <searchId> --limit 500
```

The control tells a company the index does not know (`not_indexed`) from one that is not hiring
(`no_open_match`); without it the two look identical. Match returned rows to your list by
`domain`; where the returned domain differs from the one you sent (seen: a company that moved to
a new domain came back under it), keep the row and flag it `domain_changed` in the output.

Requests to this search timed out (HTTP 504) repeatedly under load on the test day; a retry after
twenty seconds succeeded. Retry a timed-out page, never re-create and re-pay a page that returned
data.

## Step 3 — Split the matches by role family, free

One more search per role family, over the matched accounts only, adding the title words inside the
same `jobs.exists(...)` so the phrase and the title must sit on **one** posting:

```
... and jobs.exists(job_still_open = true and job_posted_date >= today() - interval 30 days
    and job_description contains ("cold call", "cold calls", "cold calling")
    and job_title contains ("sales development", "sdr", "bdr"))
```

Use the **copy window** here, so any account this returns can carry a line by construction. An
account that matched Step 2 but no role family is `off_family`: the language is there, on a role
you did not ask about. Deliver it, never write a line for it.

## Step 4 — Build the quote workflow (asks once)

Ask: *"I'd like to create one workflow in your workspace, called 'job-posting-language quotes
(safe to delete)', to read public job boards. It writes nothing else. OK?"* Stop until they answer.
On yes, build it exactly as `references/quote-workflow.md` shows: a manual trigger, one HTTP node,
one code node carrying `scripts/posting_match.py`.

Pass the phrases as `keywords` and the role family's title words as `title_words` (each joined
by `|`), and the **copy window** as `window_days`: the matcher then only returns a posting whose
title is in the family, whose full text carries a phrase, and which is young enough to name.

For each account in a role family, try its board on the domain stem in the order in that file.
A run that fails with HTTP 404 on the HTTP node means "not on this board"; try the next. After
three misses the account is `no_public_board`.

## Step 5 — Ten real rows, then ONE gate

Run the workflow for ten accounts from Step 3. For each, read the matcher's `verdict`, `best_title`,
`best_url`, `best_date`, and write the line by Step 6. Then show, in one message:

- the ten rows with verdict, title, link, date and line;
- that the workflow run used 0 credits (read `dataCreditsUsed` from `clay workflows runs get`) and
  may count action executions on their plan;
- how many matched accounts have no public board, and what quoting them would cost on the paid
  arm: that count × the declared `creditCost`;
- the ask: *"run the remaining N boards, and buy quotes for the M accounts with no board: yes to
  both, boards only, or stop?"*

Stop and wait. Stop again only for a surprise — for example most boards returning
`no_match_in_window` for accounts search had matched, which would mean the postings live somewhere
the boards do not show.

## Step 6 — Word the line from the posting, and verdict every account

Rewrite `best_title` into words a person says aloud, starting "you're hiring":

- reads inside `Saw <line>.`; lowercase first letter; no trailing period; no dashes; 12 words or
  fewer; plain words;
- one role only, from the posting shown, stripped of codes, locations, pipes and brackets
  (`Enterprise Manager, Sales Development` → `you're hiring a sales development manager`);
- never a role that is not in the posting, never a phrase the posting does not contain.

Blank the line in code when `best_date` is older than the copy window.

Verdicts, first match wins — eight values, no ninth:

1. `not_indexed` 2. `no_open_match` 3. `off_family` 4. `no_public_board` (and no paid quote)
5. `board_disagrees` (search matched, the board shows no in-window match) 6. `stale_quote`
7. `quoted` 8. `quoted_paid` (the line came from the paid arm; say which arm)

## Step 7 — Deliver

One row per account: domain, verdict, role family, title, link, posting date, phrase that matched,
line. Above it, the coverage line and the borrowed-values line. Offer to delete the workflow; it is
theirs, so they decide.

## Representative output

### Job posting lines

| Domain | Verdict | Role family | Posting | Posted | Phrase | Line |
|---|---|---|---|---|---|---|
| northwind.example | quoted | sales development | Sales Development Representative, East | 2026-09-12 | cold calling | you're hiring a sales development rep |
| contoso.example | stale_quote | account executive | Account Executive, Mid-Market | 2026-07-30 | outbound prospecting | |
| fabrikam.example | off_family | — | Customer Success Manager | 2026-09-02 | outbound prospecting | |
| tailspin.example | no_public_board | sales development | — | — | — | |

### Coverage line

400 accounts · 371 indexed · 58 with an open posting using the phrases (60 days, borrowed) · 41 in a declared role family (30 days) · 29 quoted from a public board · 12 without a board, left unquoted.

## What this skill does not claim

- The paid quote arm was not run in the author's test: it declares 1 credit per call and the workspace held 1.5 credits (read live 2026-09-23).
- Board coverage (7 of 10 companies) was measured on sales-software companies, which lean toward the public boards this skill reads; other sectors may have far fewer.
- The agreement between search and boards was checked on five companies only.
- Board slugs are guessed from the domain stem; a company whose board uses another name is reported `no_public_board` unless the installer supplies the link.
- A posting listed on a board is advertised, not proven unfilled.

## What good looks like

In a good run every line points at one posting you can open, dated inside the copy window, whose
text contains a declared phrase and whose title sits in a declared role family — and the line
names that role and nothing else. Most accounts carry no line, and each of those names why: not
indexed, not hiring for it, hiring for it in another kind of role, or unquotable. The windows and
phrase list are shown, marked as chosen or borrowed.

A thin run looks different: lines with no link beside them, a role named that no posting shows,
`not_indexed` and `no_open_match` merged into one "no", or a phrase list with a single word form.
The quiet failure is the off-family match — a support or engineering role carrying a sales line —
which is why Step 3 must find the phrase and the title on the same posting.

## Rules

- MUST match phrases against the full posting description, on Clay search or a whole public board; NEVER decide from titles, summaries or snippets.
- MUST list every word form of each phrase before searching.
- MUST require the phrase and the role family on the same posting (one `jobs.exists(...)`, one board posting).
- MUST name a role in copy only from a posting with a link and a date inside the copy window.
- MUST run the coverage control so an unindexed company is never reported as not hiring.
- MUST ask before creating the workflow, and create nothing else.
- MUST price the paid arm at the declared `creditCost` × accounts and get approval before it runs.
- NEVER invent a role, a phrase or a date; NEVER put the company name in the line.

## Worked example

Asked: *"which of these ten sales-tech companies are hiring people who will cold call, and give me
a line for each."* Phrases: cold call, cold calls, cold calling, outbound prospecting, cold
outreach. Detection window 60 days, copy window 30 (both borrowed).

Step 2, live 2026-09-23, one search, 0 credits: 4 of 10 matched — rippling.com, gong.io, ramp.com,
and outreach.io (returned under its newer domain, flagged `domain_changed`).

Step 3, live: the SDR family (sales development, sdr, bdr) kept rippling.com, ramp.com and
gong.io, and dropped outreach.io.

Step 4, live, 0 credits, one workflow (first pass: phrases only, 60-day window):

| Company | Board found | Matcher verdict | Newest matching posting |
|---|---|---|---|
| ramp.com | yes | matched, 6 postings | Enterprise Manager, Sales Development, 2026-09-18, "outbound prospecting" |
| outreach.io | yes | matched, 1 posting | Senior GTM AI Advisor (Customer Success Manager), 2026-07-29 |
| salesloft.com | yes | no_match_in_window (34 read) | — |
| chilipiper.com | yes | no_match_in_window (2 read) | — |
| clari.com | yes, empty | board_empty | — |
| gong.io | no board at the stem (404) | — | — |

Second pass with the SDR title words and the 30-day copy window: ramp.com still `matched` (2
postings, newest dated 2026-09-18), outreach.io now `no_match_in_window` — board and search agree
the phrase sits on the wrong kind of role.

Delivered: ramp.com `quoted`, line *you're hiring a sales development manager*; outreach.io
`off_family` (a customer-success role) — the case Step 3 exists for; gong.io and rippling.com
`no_public_board`, left unquoted pending the paid arm at 1 credit each; the other six
`no_open_match`, agreeing with their boards where a board exists.
