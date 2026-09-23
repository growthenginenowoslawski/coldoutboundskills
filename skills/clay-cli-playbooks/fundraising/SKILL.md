---
name: fundraising
description: |
  Build a list of companies that have raised money, and write a first line about a company's
  latest funding round that survives a founder reading it: select the list on the free funding
  total, then price and run one funding lookup only on the rows that will carry copy, pass every
  payload through a deterministic stage-and-window check, and emit the finished sentence as one
  self-erasing variable. Use whenever someone asks: companies that raised, recently funded,
  VC-backed list, Series A list, who just raised, write a line about their round, post-funding
  outreach, did this account raise, how much have they raised. The free funding figure is a
  total that folds in debt and secondary sales, so it filters lists and never reaches copy;
  secondary sales, private-equity stakes, debt and grants are not raises and never become one.
  Do NOT use it for open roles or job counts (hiring-radar), a posting's wording
  (job-posting-language), department headcount growth (hiring-surge), general company news or
  executive changes (monitor-buying-signals), or research on investors and funds.
---

# Fundraising (filter on the total, write only the round you can date)

The insight: **the funding figure Clay gives you free is a total, not a round, so it can choose a
list and it can never write a sentence.** Read live on 2026-09-23 on twelve real companies:

| Surface | Cost | What it returned for huggingface.co | What it cannot tell you |
|---|---|---|---|
| Company search, output column | search quota, 0 credits | `235000000` | stage, date, round amount |
| "Enrich Company" managed function | 0 credits | `"$100M - $250M"` | stage, date, round amount |
| Company search, as a filter | n/a | `validation_error: Unknown field` | you cannot filter on it at all |

Two free surfaces, one fact, two shapes, and neither carries a round. Four consequences, each
measured by the author's own builds:

**A total is not a round.** In an earlier build over ten companies (2026-08-04), a data provider's
total for one fintech read $550.9M while the press reported $452M, because totals fold in debt
facilities and secondary sales. Quoting a total tells a founder you did not look.

**Half of "latest rounds" are not raises.** In the same ten, three of six latest events were a
secondary sale ($300M of existing shareholders selling), a private-equity minority stake, or a
bucket label like `Series E-J`. Filter to equity stages *before* picking the newest event, or the
newest event is the wrong one.

**Round dates run early.** Recorded dates were off by 15 days to two months against the
announcement. So the copy never names a month, a season, a year or a date, and the window check
is done in whole months.

**A domain lookup can land on a different company.** One lookup for ramp.com returned a vendor
that lists Ramp as a customer, with no warning. Every paid payload is checked for the domain it
says it describes before it is used.

What follows: the free total builds and sizes the list (Step 2); the paid round lookup runs only
on rows that will carry copy, after one gate (Step 4); a fixed script decides eligibility, never
the model (Step 5); the model only words a clause from facts it was handed (Step 6).

Do not start a step before the steps above it have their answers. If a declared input is missing,
ask for it — never assume a default and continue.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and if an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The job** | a list (companies that raised), a line (a sentence per account), or both | ask; it decides whether anything paid runs at all |
| **The accounts or the ICP** | a domain list, or the company filters to search on (industry, size, location) | no default; there is nothing to look up |
| **Funding floor** | the smallest total that counts as "funded" for the list | ask; "any funding on record" is a legitimate answer and must be stated as such |
| **Window** | months since the round for "recent" | the author used 12; if they have no view, use it and SAY it is borrowed |
| **Stage policy** | which round types count as a raise | the author's equity set is in `scripts/funding_eligibility.py` and excludes private equity by choice; show it, and let them add or remove |
| **Copy frame** | the sentence the line slots into | the author used a whole-sentence variable, `Saw you raised $52M in the Series B.`; ask before changing it (see Rules) |
| **Funding lookup** | which paid arm to use, from Step 0's live read | ask at the gate; no arm is chosen silently |

**If an answer sheet is present beside this skill, load it and ask only for what it does not
cover.** Say which values came from the sheet before using them. If there is no sheet, say
nothing about sheets. At delivery, offer to save the answers (identifiers and thresholds only,
never a token): *"want me to save your answers to a file, so the next run doesn't ask again?"*

## What this skill touches

- **Reads** — the accounts you supply, Clay's company search, the free "Enrich Company" function, and, only after you approve it, one paid funding lookup per row you choose.
- **Writes** — nothing by default; the list and the lines are handed back to you as a table. If you choose the cheaper action arm at the gate, it runs inside one workflow created in your workspace, named so you can delete it — that creation is a write, and it is asked for.
- **Never** — puts a total, a valuation, an investor or a date into copy; calls a secondary sale, a private-equity stake, debt or a grant a raise; runs a paid lookup on a row that will not carry copy.
- **Halts** — Step 4 sample-review, Step 4 spend-approval, Step 4 write-approval.

## Step 0 — Check the platform, and say where the work runs

Say to the installer, before anything runs: *"This reads Clay search and one free Clay function,
and writes nothing. The only thing that costs credits is the round lookup, and I will show you the
price and ten real rows before it runs."*

```
clay whoami; echo "exit_code=$?"
clay --version
clay credits balance
clay routines list --limit 100          # find "Enrich Company" and "Company Latest Funding" by name
clay routines get <id>                  # cost lives here, not on list
clay workflows actions schema 629c6643-1766-41cf-aaf8-cdc5894c85a3 enrich-crm-enrich-company-latest-funding
```

Expected on the author's read (2026-09-23), recorded in `references/funding-arms.md`:

| Job | Expected | Declared cost | Field you will read |
|---|---|---|---|
| total funding, per row | "Enrich Company" managed function | `perRun 0` | `total_funding_amount_range_usd` |
| round, per row, option A | "Company Latest Funding" managed function | `perRun 6.4`, variable pricing | stage, amount, date (names only knowable from a payload: its `outputSchema` is null) |
| round, per row, option B | latest-funding action above | `creditCost 4` | `lastFundingType`, `latestFundingDate`, `lastFundingAmountUsd`, `companyDomain`; an action runs only as a workflow tool node, so this option creates one workflow |

If a named function or action is absent, or its cost differs, **say so and stop**. Never swap in
the nearest-sounding enrichment: a general company enrichment fills every row and carries no round.

If the platform check fails, say which component is wrong, which version is required, and the one
command that fixes it. Do not install, upgrade or fetch anything to repair it.

Where the work runs: search and the free function run in Clay at 0 credits; the eligibility check
and the wording run in the agent, free. Only the round lookup bills.

## Step 1 — Collect the definition (interview; do not guess)

Ask for the job, the accounts or ICP, and — only if the job includes lines — the window and the
stage policy. Show the stage set from `scripts/funding_eligibility.py` as a short list and ask them
to strike or add. Ask the funding floor only if the job includes a list.

Stop if they want "raised in the last 30 days" as a list filter: no free surface carries a round
date, so that list is a per-row paid lookup on every candidate, not a filter. Say so and price it
in Step 4 like any other paid run.

## Step 2 — Build or size the list on the free total

For an ICP, search and read the total off the output column:

```
clay searches query-mode create --query 'select from companies where industry = "Software Development" and company_size = "51-200" limit 200'
clay searches query-mode run <searchId> --limit 200
```

Keep rows whose `total_funding_amount_range_usd` is a number at or above the floor; drop `null`.
The funding field cannot go in the `where` clause, so every dropped row still spends search quota:
widen the query rather than tighten the floor if the list comes back thin.

For a supplied domain list, run the free function in batches of at most 100 items:

```
clay routines runs start <Enrich Company id> --input '{"items":[{"id":"r1","inputs":{"Company Identifier":"example.com"}}]}'
clay routines runs get <routineRunId>      # poll until status is not in_progress
```

Classify each row from `result["Enrich Company"]`, first match wins:

1. `unresolved` — no `domain` came back (seen on a domain that does not exist, and on whatsapp.com, an acquired company that search still shows with pre-acquisition funding; the run reports `complete` either way).
2. `identity_mismatch` — the returned `domain` is not the one you asked for.
3. `funding_unknown` — `"Funding unknown"`. **Not "never raised"**: a bootstrapped company and an unindexed one look identical here.
4. `funded_total_only` — a bucket such as `"$25M - $50M"`. Keep it if it clears the floor.

If the job is a list, stop here and deliver (Step 7). Nothing paid has run.

## Step 3 — Free checks before anything paid

For the rows that will carry a line, remove before pricing:

- every `unresolved`, `identity_mismatch` and `funding_unknown` row: a round lookup is still
  possible on `funding_unknown`, but ask, because it is the class most likely to return nothing and
  still bill;
- duplicate domains after lower-casing and stripping `www.`.

Say what this saved: *"42 of 200 rows left before anything paid — 158 lookups not bought."*

## Step 4 — Ten real rows, then ONE gate

Ask which arm: the function (no build, higher declared cost) or the action (lower cost, needs one
workflow created in their workspace — ask before creating it). Run the chosen round lookup on
**ten** of the surviving rows only — reversible, read-only, so a
real batch rather than a dry run. Pass each payload through Step 5, and write the ten lines by
Step 6. Then show, in one message:

- the ten rows: domain, returned domain, stage, date, amount, verdict, line;
- the cost of the ten, read from the run, and the price of the rest: rows × the declared cost,
  with "variable pricing" said aloud if the arm declares it;
- that nothing is written anywhere;
- if the action arm was chosen, that it needed one workflow created in their workspace (name it);
- the ask: *"run the remaining N rows at about X credits?"*

Stop and wait. Stop a second time only if the batch shows something nobody anticipated — for
example most payloads missing a date, which would make every row `undated`.

## Step 5 — Decide eligibility in code, never in the model

For every payload, first check identity: the payload's own returned domain must equal the
requested domain after lower-casing and stripping `www.`; otherwise the verdict is
`identity_mismatch` and the payload is not read further.

Then run the fixed script, one JSON object per row:

```
echo '{"domain":"example.com","stage":"Series B","round_date":"2026-05-01","amount_usd":52000000,"today":"2026-09-23","window_months":12}' \
  | python3 scripts/funding_eligibility.py
```

It normalises the stage (`Series B` and `series_b` become one key), drops anything outside the
equity set, requires a full `YYYY-MM-DD` date, measures age in whole months, and rounds the amount
**down** (`$1,345,000,000` becomes `$1.3B`; never up, because overstating a round is a lie).
Bucket labels a founder would not use — `series_unknown`, `corporate_round`, `convertible_note`,
`angel` — are blanked so the line says "round".

## Step 6 — Word the line, and only the line

Write one clause per `eligible_flag = yes` row, from the script's `stage_label` and `amount_label`
only:

- it reads correctly inside the declared frame (by default `Saw <clause>.`);
- lowercase first letter, no trailing period, no dashes, under 80 characters, plain words;
- the amount exactly as the script wrote it; the stage if `stage_label` is non-empty, otherwise the
  word "round";
- never a month, season, year, date, "recently", total, valuation or investor.

Then assemble the delivered field in code, not by hand: `funding_line = "Saw " + clause + "."`,
and `""` for every row that is not eligible. An empty variable renders as nothing, so an abstaining
row loses one sentence and the rest of the email stands.

## Step 7 — Deliver, and say what was covered

Per row: domain, verdict, `funding_total` (list jobs), stage, date, amount, `funding_line`, and the
arm that supplied the round. Above the table, one coverage line and one borrowed-values line.

Verdicts, one per row, first match wins — eight values, no ninth:

1. `unresolved` 2. `identity_mismatch` 3. `funding_unknown` 4. `no_round_on_record`
5. `excluded_stage` 6. `undated` 7. `outside_window` 8. `eligible`

(`funded_total_only` is the list-job label for a row that cleared the floor and was never sent to a
round lookup.)

## Representative output

### Funding lines

| Domain | Verdict | Stage | Round date | Amount | funding_line |
|---|---|---|---|---|---|
| northwind.example | eligible | Series B | 2026-05-12 | $52M | Saw you raised $52M in the Series B. |
| contoso.example | eligible | (blank) | 2026-02-03 | $1.3B | Saw you closed a $1.3B round. |
| fabrikam.example | excluded_stage | secondary_market | 2026-04-01 | — | |
| tailspin.example | outside_window | Series C | 2025-05-20 | — | |

### Funded-company list

| Domain | Total on record | Kept? |
|---|---|---|
| northwind.example | $25M - $50M | yes, clears the $5M floor |
| wingtip.example | Funding unknown | no, unknown is not zero and not proof |

### Coverage line

200 searched · 64 cleared the floor · 12 sent to a round lookup (48 credits) · 5 eligible · 4 excluded as not a raise · 3 outside the 12-month window (borrowed default).

## What this skill does not claim

- The paid round lookups were not run in the author's test: the workspace had 1.5 credits, and each lookup declares 4 to 6.4 credits (read live 2026-09-23).
- The field names of the "Company Latest Funding" function are not known until its first payload, because it publishes no output schema.
- The copy rules and stage policy come from a ten-company build graded against press releases, not from a large sample.
- "Funding unknown" cannot separate a bootstrapped company from one the index has never seen.
- There is no free source of round dates on Clay, so "raised in the last 30 days" is always a paid, per-row question here.

## What good looks like

A good run delivers a table where every non-empty line can be traced to one payload whose
returned domain matched, whose stage is in the declared equity set, and whose date sits inside the
declared window — and the line carries nothing but that stage and that rounded-down amount. The
empty rows outnumber the full ones on most lists and each carries a named reason, so the reader can
see *why* a company got no line. The borrowed window and stage policy are named above the table.

A thin or failed run looks different in ways you can check: lines that quote a total or a range
("raised $100M-$250M"), lines on rows marked `funding_unknown`, a month in the copy, a "raise" on a
secondary sale, or a spend figure with no ten-row batch shown before it. The commonest failure is
quiet: an arm returns stage names in a new spelling, the script drops every row as
`excluded_stage`, and the run "succeeds" with no lines — which is why Step 4 shows ten real
verdicts before the rest is bought.

## Rules

- MUST filter and size lists on the free total, and MUST NOT put a total, a bucket, a valuation or an investor into copy.
- MUST run the paid round lookup only on rows that will carry copy, after the ten-row batch and one approval.
- MUST check the payload's returned domain against the requested domain before reading anything else from it.
- MUST decide eligibility with `scripts/funding_eligibility.py`; the model never decides whether a round counts.
- MUST exclude secondary sales, private-equity stakes, debt, grants and post-IPO events unless the installer explicitly adds them, and say so in the output when they do.
- MUST round amounts down and state no date in copy.
- MUST emit the whole sentence as one variable that is empty when the row abstains; NEVER rely on random-choice text variation (spintax) to hide an empty variable — it picks a branch at random and renders "Saw ." on about half the empty rows.
- NEVER treat "Funding unknown" as "never raised".
- NEVER substitute a general company enrichment for a missing round lookup.

## Worked example

Asked: *"find growing software companies that have raised, and write me a line on anyone who
raised in the last year."*

Step 2, live (2026-09-23): a company search on `industry = "Software Development"`,
`company_size = "51-200"`, `employee_growth_6mo >= 1.15` returned ten rows; the free "Enrich
Company" function then ran on those ten plus two controls, 0 credits, balance unchanged at 1.5:

| Domain | Total on record | Verdict |
|---|---|---|
| n8n.io | $250M+ | funded_total_only |
| micro1.ai | $25M - $50M | funded_total_only |
| lovable.dev | $100M - $250M | funded_total_only |
| huzzle.com | $1M - $5M | funded_total_only |
| a known bootstrapped company (control) | Funding unknown | funding_unknown |
| whatsapp.com | (nothing returned) | unresolved |
| a domain that does not exist (control) | (nothing returned) | unresolved |

With a $5M floor the list is n8n.io, micro1.ai and lovable.dev plus the other funded rows; nothing
has billed. The line job then goes to Step 4 with those rows only, priced at 4 credits each on the
action arm — not run here, because the workspace held 1.5 credits.

Step 5 was exercised on the published facts of one real round (Ramp's Series F, $750M, June
2026) and on the three traps the author's earlier build recorded, all through the same script in
a Clay code node at 0 credits:

| Input | Verdict | Line |
|---|---|---|
| Series F, 2026-06-01, 750000000 | eligible, 3 months | Saw you raised $750M in the Series F. |
| Secondary Market, 2026-02-04, 300000000 | excluded_stage | |
| Series C, 2025-06-01, 100000000 | outside_window, 15 months | |
| no stage, no date | no_round_on_record | |

Stated at the top of the delivery: *the window (12 months) and the stage policy are the author's,
borrowed; totals chose the list and appear in no line; three rows are unresolved, not unfunded.*
