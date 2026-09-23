---
name: creative-ideas
description: |
  Write the three-bullet "I had a few ideas for you" cold email block: three per-company bullets,
  each filling a slot the seller defined up front, grounded in facts Clay returns about the
  prospect (the company search row's description, then the free managed company enrichment, then
  the company's own homepage), with every bullet tied to an exact evidence phrase and linted by a
  script. The installer writes three example sets by hand before any bullet is drafted, and a row
  with any empty bullet is excluded rather than padded. Use whenever someone asks: creative ideas
  campaign, three ideas email, I had a few ideas for you, 3 bullets per company, use cases for their
  business, what could they build with us, personalised idea bullets. Do NOT use it for a single
  personalised first line (a first-line skill), to name-drop one of their customers
  (case-study-page), to read their pricing (pricing-page), or to decide who to target.
---

# Creative ideas (the seller fixes the slots, Clay supplies the facts, the agent only fills in)

The insight: **the model must never choose what a bullet is about.** Measured on real sent
campaigns graded on 2026-08-04: bullets written free-form ("give me three ideas for this company")
were usable **2 of 5** times; bullets written into three slots the seller had named in advance were
usable **21 of 23**. Every free-form failure was the same failure — three restatements of the
seller's product with the prospect's noun sprinkled in. A campaign that sent one identical set of
three bullets to about 6,000 leads replied at the bottom of the sample. So the seller names the
three slots, the per-company part is a concrete noun from the prospect's own description, and an
empty slot is an honest answer.

The second insight is about the input, measured live on 2026-09-23: **the evidence can describe
the wrong company and still look perfect.** Of ten Clay company rows, one carried a link-in-bio
domain, and the free company enrichment on that domain returned the link-in-bio company, not the
manufacturer. Another returned a European sister entity with a 120-character description where the
search row held 739 characters about the US business. Evidence is checked for identity before a
bullet is written from it.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and if an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **Seller** | who is sending, and what they actually build, sell or run | no default — the bullets describe work only the seller can deliver |
| **Three slots** | what bullet 1, 2 and 3 are each about, in the seller's words, plus the prospect detail each must name | no default — if they cannot name three, this is the wrong skill; say so |
| **Hand-written examples** | three complete bullet sets for three real companies from their list, written by a person | no default and no workaround: no bullet is drafted until these exist |
| **Never-say list** | what must never appear (competitors, prices, their customers, anything the seller does not do) | the standard list in Step 1 is defensible; say it was used |
| **The accounts** | a Clay company search, or a list of domains with company names | no default |
| **Homepage fetch arm** | for rows whose Clay evidence is thin: Clay's static scrape action (credits) or an actor-runner on their own connected account | ask; without one, thin rows are excluded instead of fetched |
| **Lead-in sentence** | the exact sentence the three bullets hang under | ask; the bullets must read after it |

If an answer sheet is present beside this skill, load it, **say which values came from it**, and
ask only for what it does not cover. If there is no sheet, say nothing about sheets. At delivery,
offer: *"want me to save your answers to a file, so the next person on your team doesn't have to
answer these again?"* — identifiers and slot text only, never a token.

## What this skill touches

- **Reads** — the accounts you supply, Clay's company index (search rows and the free managed
  company enrichment), the prospect's public homepage when Clay's text is thin, and the Clay
  catalogue.
- **Writes** — nothing. The bullets are drafts handed back to you as a file.
- **Never** — sends an email, uploads a lead, writes to a CRM or sequencer, drafts the example
  bullets for you, or fills an empty slot with a generic line.
- **Halts** — Step 1 `other`, Step 4 `sample-review`, Step 4 `spend-approval`.

## Step 0 — Check the platform, and say where the work runs

Run `clay whoami; clay --version`. If it fails, name the component, the version needed and the one
fixing command, and stop.

Confirm the evidence sources live, free:

| Job | Expected surface | Declared cost (read live 2026-09-23) | Field read |
|---|---|---|---|
| company rows with a description | `clay searches query-mode create` / `run` | search-result quota, not credits | `description`, `name`, `domain`, `industry` |
| company enrichment | the managed routine named **Enrich Company** — find it with `clay routines list --limit 100`, price it with `clay routines get <id>` | `estimatedCreditCost.perRun` read **0** | `result["Enrich Company"].description`, `.name`, `.domain`, `.specialties` |
| homepage text, Clay-billed arm | Clay utilities `scrape-website` | `creditCost` 1 per page | `bodyText`, `description` |
| homepage text, own-account arm | an actor-runner whose `paymentType` is Bring Your Own Account | no Clay credits; their vendor bills | the actor's text and meta-description fields |

**If Enrich Company prices above 0 on `routines get`, stop and ask** before running it — some
workspaces route it through a paid source. If it is absent, say so and skip that rung; never
substitute another enrichment.

Tell the installer: *"Evidence comes from Clay's search and the free company enrichment at zero
Clay credits; only thin rows need a homepage read, billed on the arm you chose. The bullets are
written here in the conversation and linted by a script. Nothing is sent or uploaded."*

Do not start a step before the steps above it have their answers. If a declared input is missing,
ask for it — never assume a default and continue.

## Step 1 — The slot interview, and the hand-written gate

Ask, in order, and write the answers down in the seller's words:

1. What is bullet 1 about? A thing they build, sell or run — not a benefit.
2. What is bullet 2 about? A different thing. A rephrase of bullet 1 means two slots, not three.
3. What is bullet 3 about?
4. For each slot, which prospect detail must appear — push until it is a noun class ("the product
   line they make", "the kind of buyer they sell to").
5. What must never appear? Read out: a competitor's name, a dollar figure, headcount or date not in
   the evidence, a named customer of theirs, anything the seller does not do, a claim about their
   internal problems.
6. **Hand-write three complete sets for three real companies from their list.** Pull those three
   companies' evidence first (Step 2) so they write against what the agent will see. You may give
   them existing bullets from a campaign that worked to adapt; you may not draft the sets. **This
   is a halt:** no bullet is written for any row until nine hand-written bullets exist. If they
   cannot write slot 3 by hand for three companies, slot 3 is static copy — move it into the email
   body and drop the slot.
7. What is the lead-in sentence, exactly?

Check the examples with `scripts/ideas_lint.py` before using them: every example `evidence_N` must
be an exact phrase from its own company's text. An example that paraphrases teaches paraphrase.

## Step 2 — Gather evidence, cheapest first, and check identity

Per company, first source with at least 200 characters of the company's own description wins:

1. **The search row's `description`** — free when the list came from Clay search. Measured: 12 of
   12 manufacturing rows carried 513 to 1,968 characters.
2. **Enrich Company** — `clay routines runs start <id> --input '{"items":[{"id":"r1","inputs":{"Company Identifier":"northwind.example"}}]}'`,
   up to 100 items per run, then poll `clay routines runs get <runId>` until `status` is not
   `in_progress`. The input name has a space; read it from `routines get`.
3. **The homepage**, fetched on the chosen arm. Use the page's meta description plus visible text.
   A region-selector or splash page is not evidence (measured: one global manufacturer's homepage
   was a list of 19 country links).

**Identity check before writing:** the evidence's company name must match the row's company name
(ignore legal suffixes and a parent/subsidiary relation you can name). Measured failures, both
free to catch: a link-in-bio domain returned the link-in-bio company; a crane maker's domain
returned its European entity. On a mismatch, use the rung that matched, or exclude the row with
`identity_mismatch`. A dead domain returns an enrichment item with `status: complete` and an empty
result — completion is not data.

Verdict for this step: `evidence_ok`, `evidence_thin`, `identity_mismatch`.

## Step 3 — Write the bullets (you are the writer)

For each `evidence_ok` row, write exactly this JSON from the evidence text only:

```
{"bullet_1": "...", "bullet_2": "...", "bullet_3": "...", "evidence_1": "...", "evidence_2": "...", "evidence_3": "...", "confidence": "high|low"}
```

Rules, carried from the graded prompt:

1. Each bullet is something the seller would build or run FOR this company — never a description
   of the company or a compliment.
2. Each bullet names a concrete noun from the evidence: the product they make, the service they
   sell, the buyer they serve, or the place they operate. If it would read the same for any other
   company in the industry, it is wrong.
3. Never invent a fact: no customers, tools, figures, headcounts or dates not in the evidence.
4. Lower-case first letter unless a proper noun, no trailing period, no bullet character.
5. Plain words; none of: leverage, utilize, streamline, robust, seamless, empower, synergy,
   cutting-edge, best-in-class. No em or en dashes.
6. One clause, 8 to 22 words, and the three bullets start the same way (parallel).
7. `evidence_N` is the exact phrase copied from the evidence that justifies bullet N.
8. **If the evidence does not support a specific bullet for a slot, return `""` for it.** An empty
   bullet is correct. A vague one is a failure.

Match the voice of the three hand-written sets; they are the target, not a suggestion.

## Step 4 — Ten rows, then ONE gate: the batch, the cost, the writes, the ask

Run Steps 2 and 3 on ten rows, lint them, and show in one message: the ten bullet sets with their
evidence phrases and QC result, the rows excluded and why, what the full run costs (zero Clay
credits for search rows and Enrich Company as read at Step 0; one billed page read per thin row on
the chosen arm), and that nothing is sent or uploaded. Ask, and wait.

## Step 5 — Lint, and exclude rather than pad

Run `python3 scripts/ideas_lint.py rows.json`. It fails a row on any empty bullet, an evidence
phrase not found in the evidence text (normalised both sides), a word count outside 8 to 22, a
dash, a trailing period, a leading capital, a banned word, `a` before a vowel, or non-parallel
openings. A row that fails is fixed from the evidence once, or excluded. **Any empty bullet
excludes the row from the ideas email**: two bullets under a lead-in that promised three reads
worse than a generic email.

Row verdicts, first match wins: `identity_mismatch`, `evidence_thin`, `excluded_empty_slot`,
`lint_fail`, `ready`.

## Step 6 — Deliver

One row per company: `domain`, `company_name`, `evidence_source` (search row, enrichment, or
homepage), the three bullets, the three evidence phrases, `verdict`, and `creative_ideas_block`
(the three bullets joined, one per line, each after `- `) for `ready` rows only. Then a coverage
line, which rows were excluded and why, and the Clay spend. The installer routes excluded rows to a
non-ideas email in their own tool; this skill does not.

## Representative output

### Idea bullets

| domain | verdict | bullet_1 | bullet_2 | bullet_3 | evidence_1 |
|---|---|---|---|---|---|
| northwind-tanks.example | ready | a production scheduler that plans custom tank builds against fabrication shop capacity | an order desk that takes emailed repair requests through the ERP without rekeying | a data mining agent that finds smaller chemical plants in public permit records | custom-engineered tanks |
| contoso-films.example | excluded_empty_slot | a production scheduler that plans thin film runs against plant capacity | an order desk that takes emailed metallized film orders through the ERP without rekeying | | thin film line |
| fabrikam-tools.example | identity_mismatch | | | | |

### Coverage line

50 companies · 44 evidence from search rows, 3 from enrichment, 1 from homepage · 2 identity
mismatches · 41 ready · 6 excluded for an empty slot · 1 lint failure fixed · 0 Clay credits spent.

## What this skill does not claim

- The 2 of 5 versus 21 of 23 slot result was graded on past sent campaigns in one agency's corpus, not re-measured for this package.
- Tested live on 2026-09-23: the evidence chain on 10 real company rows and bullets on 8 of them, with one slot set; the bullets were written by the testing agent against slot examples a person had written earlier, so the hand-written gate itself was not re-run.
- No reply-rate or conversion claim is made for any bullet.
- The Clay-billed homepage arm (`scrape-website`, 1 credit per page) was not live-run because the test workspace had no credits; its schema and cost were read live.
- The identity check compares names; a rebrand or holding-company name can fail it on a correct row.

## What good looks like

In a good run you can take any `ready` row, read its three evidence phrases, find each one in the
company's own description, and see that the bullet could not have been written about a
neighbouring company — the product line, the buyer or the place is theirs. The three bullets in a
row sit in the three slots the seller named, in the same order, and read aloud like the
hand-written examples. Some rows are excluded, each with a reason; an exclusion rate of a tenth or
more on small manufacturers is normal and means the skill declined to guess.

A thin run looks like bullets that restate the seller's product with the company name swapped in,
the same bullet 3 on every row (that slot was static copy), evidence phrases that paraphrase rather
than quote, zero exclusions on a long list, or bullets about a parent or sister company.

## Rules

- MUST have three seller-named slots and nine hand-written example bullets before drafting any
  row; NEVER draft the examples for the installer.
- MUST check the evidence's company identity against the row before writing from it.
- MUST take evidence from the search row, then Enrich Company, then the homepage, in that order,
  and stop at the first with 200 or more characters of the company's own text.
- MUST quote every `evidence_N` exactly from the evidence and run `scripts/ideas_lint.py`.
- NEVER invent a customer, figure, tool, date or headcount; NEVER choose a bullet's subject.
- NEVER pad an empty slot; a row with an empty bullet is excluded.
- NEVER send, upload or enrol anything; the output is a file of drafts.

## Worked example

A seller of custom operations software names three slots: (1) a production scheduler, must name the
product line they make; (2) an order desk that takes emailed orders through the ERP, must name what
is ordered; (3) a data mining agent that finds smaller buyers, must name the buyer type and a public
source. The operations lead hand-writes three sets for three companies on the list.

The list comes from a Clay company search for US industrial machinery and plastics makers of 51 to
200 people. Every row carries a description. Enrich Company runs free on the ten rows for a second
read and flags two identity problems: one row's domain is a link-in-bio page, another resolves to
the European entity. The first row keeps its search description, whose name matches; the second
keeps the search row's US text.

For a tank fabricator whose description reads "premier manufacturer of custom-engineered tanks,
heat exchangers, and pressure vessels for the chemical, petroleum, and process manufacturing
industries", the agent writes "a production scheduler that plans custom tank and pressure vessel
builds against fabrication shop capacity", "an order-to-fulfillment desk that takes emailed repair
and fabrication requests through the ERP without rekeying", and "a data mining agent that finds
smaller chemical and petroleum plants in public EPA facility records", each with its quoted phrase.
The lint passes. For a film maker whose text is corporate history with no buyer named, slot 3 is
left empty and the row is excluded — a correct answer, not a gap to fill.
