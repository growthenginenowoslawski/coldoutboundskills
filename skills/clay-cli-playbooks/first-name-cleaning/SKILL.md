---
name: first-name-cleaning
description: |
  Turn the raw first-name field on a lead list into the name the person would actually be
  greeted by, so an email can open "Hi Ruba," instead of "Hi Dr Ruba," "Hi PAUL," or "Hi
  Admin,". The agent cleans each row under fixed rules (drop titles and credentials, emoji and
  taglines, pick the nickname in parentheses, fix shouting and whispering, keep hyphens and
  apostrophes, never invent a letter) and six free deterministic guards decide what may ship.
  Blank is a real answer and a generic greeting never replaces it. Use whenever someone asks:
  clean these first names, first name variable, the greeting says Hi DR MATTHEW, strip the
  titles off the names, the whole name is in the first-name column, normalize first names
  for the campaign, is this first name safe to send. Do NOT use it to clean company names
  (company-name-cleaning), to write a personalized first line or offer line (ai-specificity,
  new-in-role), to find a missing name or email, or to translate or transliterate a name.
touches: read-only
---

# First name cleaning (the greeting is the tell: clean it, guard it, never guess it)

The insight: **the first word of a cold email is the one most likely to be broken, and the
free fix most people reach for breaks it on exactly the rows that matter.** Measured
2026-09-23: Clay's free `Normalize first and last names` formatter, run in a test workflow on
55 name fields (50 real ones from Clay, 5 probes), agreed with the rules below on **45**. Every one of the
other ten was a row a greeting cannot survive: `Prof. Rita O., PhD` became **`Prof.`**,
`Dr.Rakshith M.,PhD,...` became **`Dr.rakshith`**, `👋 James` became **`👋`**, a canary `Dr. MARIE
(Mimi)` became **`Dr.`**, `A F` became `A`, `AAA` (at AAA Upholstery) became `Aaa`, and `Admin`
stayed `Admin`. A formatter that takes the first token and re-cases it cannot tell a title
from a name, a nickname from a note, or a person from a company.

What does work was measured on the build this skill was ported from (2026-08-05, 100 real raw
first names from a lead database, graded "sendable with zero edits"): a fixed rule set applied
by a small model scored **96 of 100**, and all four misses were the same class, a short or
shouted token that could be initials or a business (`TVK`, `KSM`). No wording fixes those,
because the string does not contain the answer. So the design has two halves:

1. **Rules for the judgment** (Step 5), which the agent applies row by row.
2. **Six free guards for everything the rules cannot see** (Step 6). The most important is
   the cheapest: every letter of the output must already be in the input. A cleaner that
   invents a letter has invented a person.

**When the rows come from Clay, the first-name field has already been through a parser, and
the parser fails on exactly the messy rows.** Measured 2026-09-23 on real Clay people-search
records: `Dr.Rakshith M.,PhD,DBA,...` arrived with an **empty** first name and a last name that
was the surname with ten credentials fused onto it (`M...PhDDBAPDFMP...`); `Fajar A. - MBA MCMI CMgr CCMP` arrived with
last name `CCMP`; `Arda U., MSc, MBA, PhD` with last name `MSc`. So carry the full-name
column whenever there is one, clean from it when the first-name field is empty, and never read
a credential in the last-name field as a surname.

Two traps the build hit, both now in the guards. An emptiness test that strips to `a-z`
reads every Chinese, Cyrillic, Arabic and Korean name as blank; it silently dropped **4 of
100** rows as "placeholders" before anyone noticed. And a guard that flags every short
all-caps token also flags `PAUL` and `PHAM`; the vowel test is what separates them from `TVK`.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and where an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The rows** | a CSV, a table export or a pasted list with the raw first-name column; the full-name, last-name and company columns if they have them | no default: nothing to clean. Without last name and company, the person-versus-business call gets weaker (see Step 2); without a full-name column, a row whose first-name field is empty stays blank; say so |
| **Campaign language** | the language the email is written in | English is the author's case; ask. It decides what happens to names written in another script |
| **The greeting** | the exact opening the name sits in | `Hi {first},` is defensible for the read-aloud check; say it was borrowed |
| **What happens to blanks and review rows** | exclude from any copy that opens with the name and send to a person, or something else they choose | **exclude and review** is the author's practice; ask. Never `there`, `friend`, `team` or the company name as a fallback, and never spintax around it |

**If an answer sheet is present beside this skill, load it and ask only for what it does not
cover.** Say which values came from the sheet before using them. **If there is no sheet, say
nothing about sheets.** At delivery, offer: *"want me to save your answers to a file, so the
next person on your team doesn't have to answer these again?"* (identifiers only, never a token).

## What this skill touches

- **Reads** — the rows you supply. Nothing else is needed; Step 0 names one free Clay function
  only for installers who hold profile URLs instead of names.
- **Writes** — nothing. The cleaned list is handed back to you as a file.
- **Never** — overwrites or clears your raw first-name column, looks a person up to "fix" a
  name, transliterates, fills a blank with a generic greeting, or sends names anywhere.
- **Halts** — Step 4 `sample-review`.
- **Derived from** — the GEX first-name-cleaning playbook (Growth Engine X, 100-row live test
  2026-08-05), re-measured on Clay for this skill on 2026-09-23. Insight kept, model and data
  dependencies removed.

## Step 0 — Check Clay, and say where the work runs

Run `clay whoami; echo "exit_code=$?"` and `clay --version`. If either fails, say which
component is wrong and the one command that fixes it (the Clay plugin's setup skill), then
stop. Do not install or fetch anything to repair it.

Say this at the start: *this skill reads your list and writes nothing; the cleaning happens
here in the conversation and in a local script, and costs no Clay credits.*

This skill needs no Clay call when the installer supplies the names. Two Clay pieces are
relevant, and both are confirmed live before use, never from memory:

| Job | Expected function or `(packageId, actionKey)` | Declared cost | Field read | Use |
|---|---|---|---|---|
| raw names from a profile URL (only if the installer holds URLs, not names) | managed function **Enrich Person** | measured `perRun: 0` (2026-09-23) | the first, last and full name fields it returns | `clay routines list --limit 100`, find it by name; `clay routines get <id>` for `estimatedCreditCost` and input names |
| free name formatter | `clay-normalize-first-and-last-names` in the **Clay** utility package | no credit price (measured: 0 data credits, 1 action execution) | `normalizedFirstName` | **never the greeting on its own.** If the installer's table already carries it, run the guards over it (Step 6): measured, all ten of its failures became `abstain` or `review` and none reached `send`, but four real names (`Rita`, `Rakshith`, `James`) were lost that the agent recovers |

If the enrichment function is absent or its declared cost is above zero, say so and stop that
branch. A cosmetic field is not worth a credit.

## Step 1 — Collect the inputs

Do not start a step before the steps above it have their answers. If a declared input is
missing, ask for it — never assume a default and continue.

Read the header row and **show the mapping you found** (raw first name, full name, last name,
company), then ask only about what did not match. Ask for the rawest first-name column they
have: a column somebody already "cleaned" hides the mess the guards need to see.

Where the first-name field is empty and a full name exists, the full name becomes that row's
source string: the agent cleans from it and the guards check the output against it.

## Step 2 — Why last name and company are inputs

They are free and they settle the hardest case in this job. `ATC` alone is undecidable. `ATC`
with last name `Systems` at company `ATC Systems` is a business in the person column, and the
right answer is blank. The same two fields catch a full name typed into the first-name field
(`Robert wilkie` with last name `Wilkie` becomes `Robert`). Pass the raw strings, not cleaned
ones.

## Step 3 — Free checks before the agent reads anything

Run the guards on the raw rows with an empty answer, which sorts out the rows that need no
judgment at all:

```
python3 scripts/name_guards.py raw_rows.json > prechecked.json
```

With no answer written yet every row's verdict reads `abstain`, so read the `flags`, not the
verdict. Rows flagged `G1_placeholder` (the source string is empty, a placeholder such as
`Admin`, `Info`, `Team` or `N/A`, a lone title or a single initial) stay blank and the agent
does not read them. Remember that a row with an empty first-name field and a full name uses
the full name as its source string (Step 1), so it is not pre-blanked. Everything else goes to
Step 5.

## Step 4 — Ten rows, then one gate

Clean ten rows (Step 5), preferring messy ones: titles, parentheses, all capitals, all
lowercase, emoji, a slash. Run the guards (Step 6). Then stop and show, in one message: each
raw string, the cleaned value, the flags, the verdict, and the value read aloud inside the
installer's greeting; the counts so far (how many rows are pre-abstained, how many the agent
will read); the cost, zero Clay credits; and the writes, none: *you get a file; nothing in your
table changes.* Ask whether to continue. Wait.

## Step 5 — Clean the name (the agent applies these rules)

For each row, given `first`, `last` and `company`, return:

```
{"first_name_clean": "...", "changed": true, "confidence": "high|low"}
```

1. Drop honorifics at the front: Dr, Mr, Mrs, Ms, Miss, Prof, Rev, Fr, Capt, Sir, Dame, Lord,
   Sr, Sra, Hr, Ing, Eng, Adv.
2. Drop credentials wherever they appear: MD, DO, DDS, RN, NP, PA-C, PhD, EdD, JD, Esq, CPA,
   CFA, CFP, MBA, MSc, MA, PE, PMP, CISSP and the like, with their punctuation.
3. Drop emoji, stars, arrows, bullets and any other decoration.
4. Fix shouting and whispering LAST, after picking the name out: `PAUL` becomes `Paul`,
   `javonne` becomes `Javonne`. Keep deliberate internal capitals and punctuation: `DeAndrea`,
   `McCurry`, `O'Brien`, `D'Anza`, `Jean-Paul`. Never drop a hyphen or an inner apostrophe.
5. A trailing `'S` or `'s` at the very end of the field is a business-listing possessive:
   `Rosa'S` becomes `Rosa`, confidence `low`. Only at the very end.
6. A nickname in parentheses or quotes after the name is what they go by: `Kathryn (Katie)`
   becomes `Katie`. A parenthetical that is not a short form of the name is dropped:
   `Disa(Xiaobing)` becomes `Disa`.
7. Two names with a slash: the second if it is the everyday English short form (`Mihir/Mike`
   becomes `Mike`), otherwise the first.
8. When the field holds the whole name and its last word repeats the last-name field, drop that
   word. Keep a genuine two-part given name: `Jose Ramon`, `Marie-Laure`.
9. Drop job titles, taglines and hiring notices typed into the field. Keep the given name.
10. A name written in a non-Latin script stays exactly as written. Never transliterate. If the
    field mixes a native-script name with a Latin one, return the Latin one, confidence `low`.
11. Never invent, expand or guess. Every letter you return is already in the first-name field.
12. One all-capitals token that looks like two names run together (`KIRKDELANEY`): do not
    split it; Title Case it as one word, confidence `low`.
13. Return blank when the field is empty, a placeholder or mailbox role, a company rather than
    a person (including when first and last read together as the company), or a single initial
    (`O.`). Multi-letter initials people go by stay: `J.D.`, `K.C.`.
14. No trailing period, comma, quote or space. No em dashes.
15. Confidence is `low` whenever you had to decide whether the string was a person, or which
    part was the given name.

The test for every value: read it inside the installer's greeting. If you would edit it before
sending, it is wrong.

## Step 6 — Guard and verdict, single-valued

```
python3 scripts/name_guards.py cleaned.json > checked.json
```

The six guards, each chosen because a real row slipped past the rules:

| Guard | Catches | Effect |
|---|---|---|
| G1 placeholder | `Admin`, `Info`, `Team`, `N/A`, blank, no letters (`👋`), a title on its own (`Prof.`), a single initial (`A`); whole string only, so `Adminson` and `Drew` are safe | abstain |
| G2 company overlap | first + last read as the company (`AAA` + `Upholstery` at `AAA Upholstery`) | review only: a solo consultant's company is often their own name |
| G3 caps acronym | two to four capitals with no vowel (`TVK`, `KSM`); the vowel test spares `PAUL` | review |
| G4 run-together | one all-capitals token of nine or more letters | review |
| G5 non-Latin | the cleaned value is not in Latin script | its own verdict: kept as written, excluded from an English campaign |
| G6 invented letters | the output, accent- and case-folded, is not inside the input | quarantine |

One more check rides along: `title_left` flags a title still glued to the name (`Dr.rakshith`)
and sends the row to review. Five verdicts, no sixth, first match wins: `quarantine` (G6: never send), `abstain` (blank or
placeholder), `non_latin` (keep the name, route to a campaign in that language or to review),
`review` (any other flag, or confidence `low`), `send`. Only `send` carries a value in `ship`.

## Step 7 — Deliver

A file with, per row: the raw first name, `first_name_clean`, `confidence`, `flags`, `verdict`,
`ship`. Keep the raw column beside it, never replace it: whoever reviews a row needs the source
string. Then one coverage line and the review rows listed first:

*2,000 rows · 1,946 send · 31 review · 17 abstain · 6 non_latin · 0 quarantine · 0 Clay credits.*

Say which inputs were borrowed defaults (the greeting, the blank-handling).

## Representative output

### Cleaned first names

| Raw first | Last | Company | first_name_clean | Flags | Verdict |
|---|---|---|---|---|---|
| Dr. Avery (Ave) | Northwind, MBA | Northwind Clinic | Ave | | send |
| KESTREL | Contoso | Contoso Labs | Kestrel | | send |
| Contoso | Roofing | Contoso Roofing | | G2 | abstain |
| QRT | Fabrikam | Fabrikam Inc | Qrt | G3 | review |
| Admin | Tailspin | Tailspin Toys | | G1 | abstain |

### Coverage line

5 rows · 2 send · 1 review · 2 abstain · 0 non_latin · 0 quarantine · 0 Clay credits ·
greeting borrowed from the author, not chosen.

## What this skill does not claim

- The 96-of-100 figure comes from an earlier build where a small model applied these rules; the agent applying them was run on a smaller real sample (see the evidence file) and is not separately benchmarked at 100 rows.
- The formatter comparison is 50 real name fields and 5 probes on one day, drawn toward credential-heavy names; it shows the failure class, not its rate on an ordinary list.
- Nothing here checks that the person still works where the row says, or that the name and the email belong to the same person.
- Lists written mostly in languages other than English were not measured.
- Short all-capitals tokens (`TVK`) remain undecidable from the string; the skill flags them for a person rather than resolving them.

## What good looks like

A good run is boring to read: every `send` value sounds right after `Hi`, in Title Case unless
the name carries its own capitals, with no title, credential, emoji or tagline left anywhere,
and no letter that was not in the raw field. The review pile is small and each row in it has a
visible reason (a flag or low confidence), the abstains are mailbox roles, companies and single
initials, and names in other scripts are kept exactly as written and routed, not blanked.

A thin run looks complete and is not. The signs: zero review rows on a list of any size (the
guards were skipped); a `send` value that is a title (`Dr.`) or a company word; `Hi there,`
anywhere in the output; or non-Latin names missing entirely, which means an emptiness test
treated them as blank. The quickest tell is to sort the `send` values by length and read the
shortest and longest twenty.

## Rules

- MUST keep every letter of the output inside the raw first-name field; NEVER invent, expand,
  translate or transliterate.
- MUST return blank for placeholders, companies and single initials; NEVER replace a blank with
  `there`, `friend`, `team` or the company name, and never spintax around it.
- MUST run all six guards on every row; NEVER ship a row the guards quarantined, abstained or
  sent to review.
- MUST keep names in non-Latin scripts exactly as written and route them, not blank them.
- MUST keep the raw column next to the cleaned one; NEVER overwrite or clear it.
- MUST read ten greetings aloud and stop at the gate before the full run.
- NEVER use a formatter's first-name output as the greeting without these rules and guards.
- NEVER look a person up to repair a name; a name the field does not contain stays blank.

## Worked example

Asked: *"clean the first names on this 2,000-row export before we launch; the copy opens with
Hi {first},"*.

Step 1 finds `First Name`, `Last Name`, `Company`, shows the mapping, and asks one question,
what happens to blanks (exclude and review). Campaign language: English.

Step 3 pre-abstains 17 rows (`Info`, `Sales Team`, `N/A`, empty) without the agent reading
them.

Step 4 shows ten messy rows. Three of them carry the skill: `Dr. Priya (Pri)` with last name
`Raman, PhD` becomes `Pri`; `ROSA'S` becomes `Rosa` with confidence `low`, so it goes to review;
`AAA` with last name `Upholstery` at `AAA Upholstery` becomes blank. The installer says continue.

Step 6 on the full list: 1,946 `send`, 31 `review` (mostly short capitals and possessives), 17
`abstain`, 6 `non_latin` kept as written for the team's Spanish-and-Mandarin campaign owner,
0 `quarantine`. Delivered with the review rows first and a note that the greeting was theirs,
not borrowed.
