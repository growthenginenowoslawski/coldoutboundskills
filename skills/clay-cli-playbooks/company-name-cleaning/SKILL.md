---
name: company-name-cleaning
description: |
  Turn raw company-name strings into the short name a person would say out loud, so they can
  sit inside email copy ("Noticed Hill Construction is hiring") without reading like a mail
  merge. Routes every row through a free risk check first: rows a free formatter handles are
  taken from it, rows it is known to break (all-caps initialisms, lowercase brands, rare
  legal suffixes, taglines, junk like Self-employed or N/A) are cleaned by the agent under
  fixed rules, and every value is checked before it may ship. Blank is a real answer.
  Use whenever someone asks: clean these company names, strip the LLC and Inc, the company
  names look robotic, company name variable for a campaign, normalize company names, why does
  the email say ACME ROOFING LLC, fix the company column before we send. Do NOT use it to
  clean first names or greetings (first-name-cleaning), to write a personalized offer line
  (ai-specificity), to look up a missing company or its domain, or to decide whether a
  company is in the ICP.
touches: read-only
---

# Company name cleaning (route before you clean: the formatter's mistakes are predictable)

The insight: **a free formatter gets most company names right, and the ones it gets wrong can
be named from the raw string before it runs.** Measured 2026-09-23 on 32 strings: 29 real
names pulled from Clay (20 from a company search, 9 from the managed company-enrichment
function) plus 3 deliberate junk probes. Clay's free `Normalize company name` formatter and the rules below
agreed on **25 of 32**. Every one of the 7 disagreements was a row a free, deterministic risk
check flagged before any cleaning ran, and that check flagged only **9 of 32** rows:

| Raw string | Free formatter | These rules | What went wrong |
|---|---|---|---|
| `EPC` | `Epc` | `EPC` | title-cased an initialism |
| `BPO` | `Bpo` | `BPO` | same |
| `go2work` | `Go 2 Work` | `go2work` | split a brand into words it does not use |
| `TRC Recreation, LP` | `TRC Recreation, LP` | `TRC Recreation` | kept a legal suffix |
| `Colorado Construction & Design® magazine` | `Colorado Construction & Design magazine` | `Colorado Construction & Design` | kept the descriptor |
| `Self-employed` | `Self-employed` | blank | shipped a junk string as a company |
| `N/A` | `N A` | blank | same |

Three consequences follow.

**Route before cleaning, never after.** `Epc` passes every after-the-fact check a machine can
run: its letters are all in the input, it is not a placeholder, it has no stray punctuation.
Casing damage is invisible once it has happened. The only place to catch it is the raw string
(`EPC` is all capitals, so the formatter will title-case it), which is why the risk check runs
first and decides who cleans the row.

**The formatter is safe on the rows it was built for.** It title-cases only when the whole
string is one case, and strips the common suffixes (`LLC`, `Inc.`, `Company`) and
parenthetical asides (`(US)`, `(CEA)`) correctly. On the 23 unflagged rows it matched the
rules every time. So the agent's reading effort goes to the flagged quarter, not to every row.

**Junk must be caught by a list, not by judgment.** A formatter does not abstain at all, and a
small language model asked to abstain on junk strings did so on only **7 of 10** in an earlier
measurement (2026-08-05, a 10-row probe of real junk values; the misses were `Self-Employed
CPA`, `Confidential Jobs` and `Private Practice`). A fixed placeholder list, applied to the raw
string and to the output, is what makes blank reliable.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and where an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The rows** | a CSV, a table export or a pasted list with one raw company-name column, plus a domain column if they have one | no default: there is nothing to clean. If they hold only domains, Step 0 names the free Clay function that returns a company name per domain |
| **Formatter column** | whether their table already carries a `Normalize company name` output, and which column it is | the agent cleans every row itself; slower, same result on the measured sample |
| **The copy sentence** | the sentence the name will sit in, for the read-aloud check | `Noticed {company} is hiring.` is defensible for a first read; say it was borrowed |
| **What happens to blanks and review rows** | exclude them from copy that names the company, route to a person, or keep with the clause removed | **exclude and send to review** is the author's practice; ask, and say which was chosen. Never a generic fill such as "your company" |

**If an answer sheet is present beside this skill, load it and ask only for what it does not
cover.** Say which values came from the sheet before using them. **If there is no sheet, say
nothing about sheets.** At delivery, offer: *"want me to save your answers to a file, so the
next person on your team doesn't have to answer these again?"* (identifiers only, never a token).

## What this skill touches

- **Reads** — the rows you supply; the formatter column in your table if you point at one; and,
  only if you hold domains instead of names, one free Clay company-enrichment call per domain.
- **Writes** — nothing. The cleaned list is handed back to you as a file.
- **Never** — overwrites or clears your raw company column, fills a blank with a generic phrase,
  or sends your company list to any service other than the Clay function named in Step 0.
- **Halts** — Step 4 `sample-review`.
- **Derived from** — the GEX company-name-cleaning playbook (Growth Engine X, 100-row live test
  2026-08-04, abstain probe 2026-08-05), re-measured on Clay for this skill on 2026-09-23.

## Step 0 — Check Clay, and say where the work runs

Run `clay whoami; echo "exit_code=$?"` and `clay --version`. If either fails, say which
component is wrong and the one command that fixes it (the Clay plugin's setup skill), then
stop. Do not install or fetch anything to repair it.

Say this at the start of the run: *this skill reads your list and writes nothing; the cleaning
happens here in the conversation and in a local script, and costs no Clay credits.*

Then confirm the two Clay pieces this skill may lean on, live, never from memory:

| Job | Expected `(packageId, actionKey)` or function | Declared cost | Field read | Confirm with |
|---|---|---|---|---|
| free company-name formatter (only to interpret a column the installer already has, or to spot-check it) | `normalize-company-name` in the **Clay Formatters** package | no credit price (measured: 0 data credits, 1 action execution per call) | `normalized_name`; inputs `companyName`, `titleCase` | `clay workflows actions list` then `clay workflows actions schema <packageId> normalize-company-name` |
| company name from a domain (only if the installer holds domains, not names) | managed function **Enrich Company** | measured `perRun: 0` on 2026-09-23 | `name` (also `description`, `specialties`) | `clay routines list --limit 100`, find it by name, then `clay routines get <id>` for `estimatedCreditCost` |

**If either is absent or its declared cost is above zero, say so and stop that branch.** Never
substitute a paid company-enrichment action for the free function: this is a cosmetic field and
no row is worth a credit. The function's input name has a space in it (`Company Identifier`);
read it from `clay routines get`, and send items as
`{"items":[{"id":"<row id>","inputs":{"Company Identifier":"<domain>"}}]}`, at most 100 per run.

## Step 1 — Collect the inputs

Do not start a step before the steps above it have their answers. If a declared input is
missing, ask for it — never assume a default and continue.

Read the header row of whatever they gave you and **show the mapping you found** (which column
is the raw name, which is the domain, which is the formatter output), then ask only about what
did not match. Never clean a column that has already been cleaned by something unknown: ask for
the rawest company string they have, because the rules need to see the tagline and the `dba`.

Drop rows whose raw string is empty **before** any Clay call: a Clay formatter node with an
empty required input fails the whole run (measured 2026-09-23). Those rows go straight to the
output as blank.

## Step 2 — Route every row (free, deterministic)

```
python3 scripts/company_guards.py risk rows.json > routed.json
```

Each row comes back with a `risk` list. Empty means the formatter may be trusted on it; any
entry means the agent cleans it under the rules in Step 5, whatever the formatter said.

| Risk | Fires on | Why it sends the row to the agent |
|---|---|---|
| `placeholder` | `N/A`, `Self-employed`, `Retired`, `Confidential`, `Stealth` and the rest of the list | the answer is blank, and a formatter never returns blank |
| `all_caps` | the whole string is capitals (`EPC`, `KATERRA`) | the formatter title-cases all of it, initialisms included |
| `all_lower` / `brand_casing` | `go2work`, `adGreetz`, `4medica` | the formatter re-cases or splits deliberate brand spellings |
| `rare_suffix` | `, LP`, `LLP`, `PLC`, `GmbH`, `Pty`, `Sdn Bhd` and similar | measured: `, LP` survived the formatter |
| `separator_or_mark` | a pipe, colon, spaced dash, `®`, `™`, `dba` | taglines, trading names and marks need a judgment about which part is the brand |
| `second_script` | the name repeated in another script | keep the English form only |

## Step 3 — Free before anything else

Nothing in this skill costs Clay credits, so "free first" here means *cheapest effort first*:

- **Formatter column present:** take its value for every row with an empty `risk` list.
  Measured: 23 of 23 such rows matched the rules exactly.
- **No formatter column:** the agent cleans every row in Step 5. Do not build a Clay workflow
  to run the formatter row by row for this: each row is a separate run, and on the measured
  sample the formatter added nothing the rules did not already do.

## Step 4 — Ten rows, then one gate

Clean ten rows, **weighted toward flagged rows** (at least six of the ten flagged, if that many
exist), and run the check:

```
python3 scripts/company_guards.py check batch10.json > checked10.json
```

Then stop and show, in one message: each raw string, the cleaned value, who produced it
(formatter or agent), the verdict, and the value read aloud inside the installer's copy
sentence; the risk counts for the whole list (how many rows the agent will read); the cost,
which is zero Clay credits; and the writes, which are none: *this skill hands you a file and
changes nothing in your table.* Ask whether to continue. Wait.

Stop a second time only if the full run turns up something the ten rows did not show, such as a
flagged share far above the batch's.

## Step 5 — Clean the flagged rows under fixed rules

The agent writes `company_clean` for each flagged row (and every row, when there is no formatter
column), with `confidence` `high` or `low`. Work in batches of about fifty so each batch can be
checked before the next. The rules, measured at 98/100 usable on a 100-row real sample
(2026-08-04, a small model following the same rules; applied by the agent to the 32 rows of
2026-09-23 they produced 0 `quarantine` and 2 `review`):

1. Drop legal suffixes and their punctuation: Inc, LLC, L.L.C., Ltd, Limited, Corp,
   Corporation, Co, Company (only as a legal suffix), PLC, LLP, LP, PC, PA, GmbH, AG, BV, NV,
   SA, SAS, SARL, SRL, SpA, Pty, AB, A/S, Oy, KK, Sdn Bhd, Private Limited.
2. Drop trademark and copyright marks, word or symbol.
3. Drop a tagline or service list after a pipe, a spaced dash, a colon or a comma, when it
   describes the business rather than naming it.
4. Drop parenthetical descriptors (`(Startup)`, `(formerly X)`, `(US)`) and a parenthetical
   acronym of the same name. Keep parentheses that are part of the name: `(319) Auto Body`.
5. With a legal entity and a trading name (`dba`, `d/b/a`, `doing business as`), keep the
   trading name.
6. Drop a trailing city, region or country appended to a brand, unless the place is what
   distinguishes the organization (`AGC Houston` is a chapter; keep it, confidence `low`).
7. With the name repeated in a second language or script, keep the English form.
8. Initialisms of two to six letters that are not ordinary words stay as written (`EPC`,
   `BPO`, `AMTC`). Ordinary words shouted in capitals become Title Case, even next to an
   initialism: `AMTC TECH GROUP LLC` becomes `AMTC Tech Group`. All-lowercase ordinary words
   become Title Case; a one-token brand written in lowercase keeps its spelling (`go2work`).
9. Keep deliberate brand casing, ampersands, digits and dots (`iRobot`, `eBay`, `4medica`).
10. Never invent, translate, expand or abbreviate. Every word in the output is in the input.
11. No trailing period, comma or quotation mark. No em or en dashes. Under 40 characters when
    that is possible without cutting the brand.
12. Blank when the string is empty, a placeholder, or not a company at all. Confidence `low`
    whenever you had to choose which part was the brand.

The test for every value: read it inside the installer's copy sentence. If you would edit it
before sending, it is wrong.

## Step 6 — Verdicts, single-valued

Run `python3 scripts/company_guards.py check cleaned.json`. Four values, no fifth, first match
wins:

1. `quarantine` — the cleaned value contains text that is not in the raw string. Never ship it.
2. `abstain` — the value is blank, or the raw string or the output is a placeholder. A real
   answer: we do not know where this person works.
3. `review` — a check fired (a word that is not a whole word of the input, a format fault, over
   60 characters) or confidence is `low`. A person reads it before it ships.
4. `send` — none of the above.

`ship` carries the value only for `send`; for everything else it is blank, and the installer's
chosen blank-handling from Step 1 applies. Never replace a blank with a generic phrase.

## Step 7 — Deliver

A file with, per row: `raw`, `company_clean`, `source` (formatter or agent), `risk`, `flags`,
`verdict`, `ship`. Then one coverage line and the rows that need a person:

*1,240 rows · 318 flagged and read by the agent · 1,171 send · 41 review · 28 abstain ·
0 quarantine · 0 Clay credits.*

Say which inputs were borrowed defaults (the copy sentence, the blank-handling) rather than the
installer's own.

## Representative output

### Cleaned company list

| Raw | company_clean | Source | Risk | Verdict |
|---|---|---|---|---|
| Northwind Traders, LLC | Northwind Traders | formatter | none | send |
| CONTOSO | Contoso | agent | all_caps | send |
| NWT | NWT | agent | all_caps | send |
| Fabrikam Labs \| AI for Field Service | Fabrikam Labs | agent | separator_or_mark | send |
| Tailspin Toys GmbH (formerly Tailspin) | Tailspin Toys | agent | rare_suffix | review |
| Self-Employed Consultant | | agent | placeholder | abstain |

### Coverage line

6 rows · 5 flagged and read by the agent · 4 send · 1 review · 1 abstain · 0 quarantine ·
0 Clay credits · copy sentence borrowed from the author, not chosen.

## What this skill does not claim

- The formatter-versus-rules comparison is 29 real strings and 3 probes from one Clay workspace on one day, not a benchmark; the 98/100 figure is an earlier 100-row sample of a different list.
- The risk check was written against the 7 formatter failures it then caught, so its perfect recall on that sample is a fit, not an independent result; expect it to miss failure shapes nobody has seen yet.
- It does not judge whether a cleaned name is still the person's current employer, or whether name and domain describe the same company.
- It does not fix misspellings in the source name, because fixing one means inventing a word.
- Non-English lists were not measured.

## What good looks like

A good run reads like a list a person could paste into a campaign without touching: every
`send` value reads naturally in the copy sentence, initialisms are still capitals, brands keep
their own spelling, and there is no `LLC`, `®` or tagline anywhere. The flagged share is visible
up front (typically a quarter to a third of a mixed list), and the blanks are few and
explainable one by one: junk strings, empty fields, a company the string does not name.

A thin run looks finished and is not. The signs: zero rows flagged on a list of more than a few
dozen (the router was skipped and the formatter's output was taken wholesale, so `Epc` and
`Self-employed` are sitting among the `send` rows); blanks filled with "your company"; or a
`review` pile that nobody was told about. The quickest tell is to search the `send` rows for
a value that is all lowercase or has lost the capitals its raw string had.

## Rules

- MUST run the risk check on the raw string before accepting any formatter output; NEVER take a
  formatter value for a flagged row.
- MUST return blank for placeholders and non-companies, and apply the placeholder list to both
  the raw string and the output; NEVER ship `N/A`, `Self-employed` or a generic substitute.
- MUST keep every word of the output inside the input; NEVER invent, expand, translate or
  correct a spelling.
- MUST keep initialisms and deliberate brand casing as written.
- MUST read ten values aloud in the installer's copy sentence and stop for the gate before the
  full run.
- MUST drop empty rows before any Clay formatter call; NEVER send an empty required input to a
  workflow node.
- NEVER overwrite or clear the installer's raw company column; the output is a separate file.
- NEVER call a paid enrichment to recover a missing company name.

## Worked example

Asked: *"clean the company column on this 1,240-row export before we load the campaign."*

Step 1 finds `Company` (raw), `Website` (domain) and `Company Normalized` (a formatter output
already in their table), shows that mapping, and asks the one open question: what happens to
blanks. The installer picks exclude-and-review.

Step 2 flags 318 rows: 131 `all_caps`, 88 `separator_or_mark`, 47 `rare_suffix`, 29
`placeholder`, 23 `all_lower`/`brand_casing`. The other 922 take the formatter value.

Step 4 shows ten rows, seven of them flagged. Two of them are the whole point of the skill:
`ABC MECHANICAL SERVICES` (formatter: `Abc Mechanical Services`; agent: `ABC Mechanical
Services`) and `Retired` (formatter: `Retired`; agent: blank). The installer says continue.

Steps 5 and 6 produce 1,171 `send`, 41 `review` (mostly two brands in one string), 28 `abstain`
and 0 `quarantine`. Delivered with the coverage line, the 41 review rows listed first, and a
note that the copy sentence used for the read-aloud was the author's default, not theirs.
