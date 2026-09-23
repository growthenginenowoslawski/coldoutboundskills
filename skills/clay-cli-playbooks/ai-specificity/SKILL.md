---
name: ai-specificity
description: |
  Write the one short line that makes a generic offer read as if it were written for this
  company: the tail of "I think we can help you ___", built from the prospect's own product
  nouns and one capability the sender really offers. Clay supplies the company description
  (a free company-enrichment function), the agent writes the line under fixed rules, and a
  deterministic guard plus a reading-level gate decide what may ship; a company that does not
  fit, or has no usable description, gets a blank rather than a guess. Use whenever someone
  asks: specificity line, make the offer feel specific to them, the specifically sentence,
  why would they think this is for them, personalize the offer not the intro, one line per
  account on what we would do for them, custom value prop per company. Do NOT use it to write
  a first line about a person or an event such as a new job, a funding round or a post
  (new-in-role, fundraising, linkedin-engagement), to clean company or first names
  (company-name-cleaning, first-name-cleaning), or to decide whether a company is in the ICP.
touches: read-only
---

# AI specificity line (say the sender's offer back in the prospect's own nouns)

The insight: **left to itself, a writer fills every row with the same true-but-empty line, and
only a mechanical check against the prospect's own words stops it.** The build that this
skill ports measured it on real rows (2026-08-04): the first rules-only version wrote *"track
product margins by channel"* for four different companies out of nine and wrote a confident
bookkeeping line for a 100,000-student school district. Two live campaigns already shipping a
variable like this showed the same collapse: 4 of 5 sampled values opened with *"streamline
... communication"*. What fixed it was not better wording but three checks a machine can run:

1. **The anchor is copied from the company's own description** (`pool liner`, `ski vest`,
   `cast iron cookware`), and its head noun must appear in both the description and the line.
   A line built on `product` or `revenue` fails.
2. **The capability is copied word for word from the sender's offer list.** A line that
   promises something the sender does not do fails. When one client's example lines were
   reused for a second client's offer, 2 of 2 lines promised the first client's service; this
   check caught both.
3. **The line is gated on reading level, and the gate is on the line, not the sentence.** The
   fixed frame *"Specifically, I think we can help you."* scores Flesch-Kincaid grade **5.7 on
   its own**, so any 6-to-14-word line renders at 7.0 to 9.8 however plain it is. Gate what you
   generate. Dropping the word "Specifically" from the frame took the worst sampled render from
   9.1 to 6.3 in the original build; on this skill's 2026-09-23 run it moved all eight shipped
   lines down by 2.6 to 3.2 grades.

Rerun on 2026-09-23 as this skill, on the same ten companies, with Clay supplying the
descriptions and the agent writing: **8 of 10 lines shipped** (one after its single rewrite for
reading level), the school district correctly returned `no_fit`, and the one company Clay had
no description for correctly returned `no_data`. Same yield as the original, no model key.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and where an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The accounts** | company domains (a CSV, a table export or a pasted list); a company-name column if they have one | no default: nothing to write about |
| **The offer block** | who the sender is, who they sell to, five to seven capability lines in words a customer would use, and a "what we do NOT do" line | **gate: no default, stop and ask.** Every line promises one of these capabilities; an invented offer is a false promise in someone else's name. Step 1 shows the shape |
| **The frame sentence** | the fixed words the line completes, kept in the email copy, never inside the variable | `I think we can help you {line}.` is defensible: measured 2026-09-23, it rendered 7 of 8 passing lines at grade 7 or below (worst 7.3), where the same lines behind "Specifically," all rendered above 7 (7.3 to 9.9). Say it was borrowed |
| **Fit exclusions** | kinds of organization the offer never serves | schools, government bodies, hospitals, churches and charities are the author's default; ask whether they apply |
| **What happens to blanks** | send those accounts to a campaign whose copy does not need the line, or pre-render the sentence as one field that can be empty | **route them elsewhere** is the author's practice; ask. Never spintax around a blank: spintax picks at random and cannot test whether a field is empty |
| **Paid page fetch** | yes or no to a per-row paid page read for accounts with no usable description | no: those rows stay `no_data` |

**If an answer sheet is present beside this skill, load it and ask only for what it does not
cover.** Say which values came from the sheet before using them. **If there is no sheet, say
nothing about sheets.** At delivery, offer: *"want me to save your answers to a file, so the
next person on your team doesn't have to answer these again?"* (identifiers only, never a token).

## What this skill touches

- **Reads** — the accounts you supply, one free Clay company-enrichment call per domain, and,
  only if you approve it at the gate, one paid Clay page read per account without a description.
- **Writes** — nothing. The lines are handed back to you as a file.
- **Never** — puts the frame sentence inside the variable, writes the company's name into the
  line, promises a capability that is not in your offer block, or sends a line that failed the
  guard twice.
- **Halts** — Step 4 `sample-review`, Step 4 `spend-approval`.
- **Derived from** — the GEX AI-specificity playbook (Growth Engine X, live test 2026-08-04 and
  re-run 2026-08-05 on the same ten domains), re-run on Clay for this skill on 2026-09-23.

## Step 0 — Check Clay, and say where the work runs

Run `clay whoami; echo "exit_code=$?"` and `clay --version`. If either fails, say which
component is wrong and the one command that fixes it (the Clay plugin's setup skill), then
stop. Do not install or fetch anything to repair it.

Say this at the start: *Clay supplies each company's description; the line is written here in
the conversation and checked by a local script; nothing is written back to your systems.*

Confirm the pieces live, never from memory:

| Job | Expected function or `(packageId, actionKey)` | Declared cost | Field read | Confirm with |
|---|---|---|---|---|
| company description by domain | managed function **Enrich Company** | measured `perRun: 0` (2026-09-23) | `description`, `specialties`, `name`, `industry` | `clay routines list --limit 100`, find it by name; `clay routines get <id>` for `estimatedCreditCost` and the input name |
| page text for accounts with no description (optional, gated) | `scrape-website` in the **Clay** utility package | measured catalogue `creditCost: 1` per row | `description`, `bodyText` | `clay workflows actions schema <packageId> scrape-website` |

**If the company-enrichment function is absent, or its declared cost is above zero, say so and
stop.** Do not substitute a paid enrichment action for it without asking: the run was priced at
zero. The input name has a space in it (`Company Identifier`); read it from `clay routines get`
and send `{"items":[{"id":"<domain>","inputs":{"Company Identifier":"<domain>"}}]}`, at most 100
items per run, then poll `clay routines runs get <runId>` until `status` is not `in_progress`.
Results are at `.data[i].result["Enrich Company"]`.

## Step 1 — Collect the offer block and the frame

Do not start a step before the steps above it have their answers. If a declared input is
missing, ask for it — never assume a default and continue.

Show the shape, then ask the installer to fill it. Never draft capability lines for them from
their website: the whole value of the line is that it names what they really do.

```
Sender: one line on what kind of company they are (not the brand name)
Sells to: who they serve, and roughly what size
What they actually do:
- capability 1, the words a customer would use
- capability 2
- ... five to seven lines
What they do NOT do: the four or five nearby things people assume
```

Two rules for the block, both learned on real rows. Each capability line is copied verbatim
into the answer as `offer_item`, so write them as short quotable phrases, not categories. And
the "do NOT do" line is load-bearing: without it the writer borrows the nearest adjacent promise.

## Step 2 — Get each company's description (free)

Run the company-enrichment function over the domains. Normalize first (lowercase, no scheme,
no `www.`, no path). Build each row's **source text** as `description` plus the `specialties`
list: on the measured run one company's description was a mission statement with no product in
it, and its specialties (`Mobile Phone Accessories`, `iPhone`) were the only product words.

A row is `no_data` when the source text is under 150 characters. Measured: 1 of 10 real
domains came back empty (a brand whose list domain was not the domain it trades on), plus the
deliberate nonexistent-domain probe. A cluster of `no_data` rows in one segment usually means
the domains in the list are wrong, not that the companies have no business.

## Step 3 — Page text for the `no_data` rows (optional, paid, gated)

There is a free way to read a homepage on Clay, and it mostly does not work for this job.
Measured 2026-09-23 with the free HTTP action (`http-api-v2`) run from a test workflow: **none
of four consumer-brand homepages** returned text (two 403s, one 429, one refused connection), a
fifth large brand returned only a bot-check page, and a dead domain failed DNS. Two small-business sites did
return usable text. Two traps if you build it anyway: with `returnResponseMetadata` on, an HTML
body comes back as an empty object, so leave it off; and with it off, any non-2xx response
fails the node and the whole workflow run.

So the default is to leave `no_data` rows blank. If the installer said yes to the paid page
read, price it at the gate: one `scrape-website` call per `no_data` row, at the catalogue's
declared 1 credit each (read it live), with JavaScript rendering on. This path was **not run**
for this skill; its hit rate is unknown.

## Step 4 — Ten rows, then one gate

Write ten rows (Step 5), judge them (Step 6), and stop. Show, in one message: each company, its
anchor, the offer line it chose, the line rendered inside the installer's frame, and its
verdict; the `offer_item` spread across the ten (if one capability wins seven or more, say so:
the offer block or the descriptions are too thin); the cost so far (zero credits) and the cost
of the full run, which is zero unless the paid page read was approved, in which case state the
row count and the credits; and the writes, which are none. Ask whether to continue. Wait.

## Step 5 — Write the line (the agent is the writer)

For each row with source text, produce this JSON, following the four steps in order:

```
{"fits": "yes|no", "anchor": "...", "offer_item": "...", "line": "...", "confidence": "high|low"}
```

1. **Fit.** Does the offer plainly serve how THIS company makes money? `no` for the installer's
   fit exclusions and for any company whose business the source text does not reveal. If `no`,
   leave the other three fields empty and stop.
2. **Anchor.** One word or short phrase for the thing this company makes, sells or counts,
   copied from the source text word for word. A real thing (`ski vest`, `washable rug`,
   `organic coffee`), never a business word (`product`, `margin`, `channel`, `SKU`, `revenue`,
   `customer`).
3. **Offer item.** The ONE capability line from the offer block that fits this company best on
   the evidence, copied verbatim. Not the first line by default.
4. **Line.** Say what that capability does for this anchor, in this company's words:
   - 6 to 14 words, one idea, grade 5 words; starts with a plain lowercase verb (`see`, `know`,
     `track`, `cut`, `build`); no period at the end.
   - Contains the anchor. Never the company's name, never "help you", never "specifically".
   - No em or en dashes. Never "channel", "platform" or "across"; name the real place they
     sell (their own stores, online, dealers) if the source text names one.
   - Never a fact that is not in the source text. Never promise sales, growth or customers
     unless the offer block says the sender does that.
   - Never the phrases that fit any company: "product margins", "gross margin", "your
     business", "your products", "boost margins", "improve efficiency", "grow sales", "more
     sales", "drive demand", "increase sales".
   - `fits: yes` means you MUST write an anchor and a line; low confidence is fine.

Two more rules. The worked example below is one bookkeeping sender's; for any other offer,
write from that offer and never imitate the example's lines. And a line is judged on a batch,
not alone: rerun the same row and you will get a different, equally valid line.

## Step 6 — Judge every line (free, deterministic)

```
python3 scripts/line_guard.py batch.json > judged.json
```

`batch.json` carries the offer block verbatim and, per row, the source text, the company name
and your JSON answer with `attempt: 1`. The script strips a frame fragment a rewrite glued back
on (`help you see ...`), runs the guard (anchor head noun in source and line, offer item
verbatim, company name, banned words, dashes, frame words, length, capitals) and the reading
gate (grade 7 on the line), and returns one verdict per row:

1. `no_data` — under 150 characters of source text. Nothing may be written.
2. `no_fit` — `fits: no` with an empty line. A real answer.
3. `send` — the guard passed and the line reads at grade 7 or below.
4. `rewrite` — the first attempt failed. You get exactly one rewrite, with the failure reasons
   in front of you; keep `fits` as it was and do not return an empty line. Judge it again with
   `attempt: 2`.
5. `blank` — the second attempt failed, or `fits: yes` came with no line. Never ship it.

Only `send` carries a value in `ship`. A rewrite that fails is not evidence the first line was
wrong; it is still a blank, because the first line failed too.

## Step 7 — Deliver

A file with, per account: `domain`, `company_name`, `fits`, `anchor`, `offer_item`, `line`,
`grade`, `verdict`, `ship`, plus the line rendered inside the frame for reading. Then:

- the coverage line: accounts in, `send`, `no_fit`, `no_data`, `blank`, credits spent;
- the `offer_item` spread;
- a warning when blanks exceed 30 percent of a segment: at that rate the list is wrong for this
  campaign, not the writing.

## Representative output

### Specificity lines

| Company | Anchor | Offer item | Rendered line | Verdict |
|---|---|---|---|---|
| Northwind Outdoor | hard cooler | inventory and cost tracking per product | I think we can help you see what each hard cooler really costs to build. | send |
| Contoso Linens | washable rug | margin reporting by product and by sales outlet | I think we can help you see which washable rug sizes still pay after returns. | send |
| Fabrikam Unified School District | | | | no_fit |
| Tailspin Beverage | | | | no_data |

### Coverage line

4 accounts · 2 send · 1 no_fit · 1 no_data · 0 blank · offer items: 2 different in 2 lines ·
0 Clay credits · frame borrowed from the author, not chosen.

## What this skill does not claim

- The 8-of-10 yield is ten consumer-product companies with one bookkeeping offer; other offers and B2B lists were not measured on this skill.
- The lines were graded by the same agent that wrote them, against the guard; no prospect has read them and no reply rate is claimed.
- The paid page read was not live-run (it needs about 1 credit per row, read live 2026-09-23), so its hit rate on no-description accounts is unknown.
- The free homepage fetch was measured on eight sites from Clay's servers on one day; blocking changes by site and by week.
- A line is only as true as the company's own description; the skill does not verify the description against the live website.

## What good looks like

A good batch reads like eight different people wrote to eight different companies: every
`send` line names a thing that company actually sells (`ski vest`, `organic coffee blend`,
`pool liner`), the offer items are spread across at least three capabilities, the school
district and the charity are `no_fit` rather than forced, and the blanks are few and each has
a reason in the file. Read the rendered sentences in a row; none should be swappable between
companies.

A thin batch is uniform. The same capability on nearly every row, lines that would be true of
any company in the segment ("see which products make the most money"), a line for an
organization the offer cannot serve, or zero blanks on a mixed list. The quickest tell: swap two
companies' lines. If neither reads wrong, the anchors were not doing their job.

## Rules

- MUST get the offer block from the installer; NEVER write capability lines for them or reuse
  another sender's.
- MUST copy the anchor from the source text and the offer item from the offer block, verbatim.
- MUST run the guard and the reading gate on every line; NEVER ship a line that failed twice.
- MUST allow exactly one rewrite, keeping `fits` unchanged; NEVER flip a fitting company to
  `no` to escape the guard.
- MUST keep the frame in the copy and only the tail in the variable.
- MUST return blank for non-fits and for accounts without a usable description; NEVER write
  from the company name alone or from general knowledge of the brand.
- NEVER write the company's name, "help you", "specifically", or a dash into the line.
- NEVER run the paid page read without a yes at the Step 4 gate that names the row count and
  the credits.
- NEVER spintax around a blank line.

## Worked example

Asked: *"write specificity lines for these ten brands; we are a bookkeeping and fractional CFO
firm for consumer product brands."*

Step 1 collects the offer block: monthly close in QuickBooks or Xero; inventory and cost of
goods sold tracking per product (per SKU landed cost); margin reporting by product, by channel,
and by sales platform; cash flow forecasting ahead of inventory buys; sales tax filing across
states; getting books ready for a lender, a bank line, or an investor. Not: raising money, ads,
software, supply chain, hiring. Frame: the author's default, `I think we can help you {line}.`,
flagged as borrowed.

Step 2 returns descriptions for 9 of 10 domains at 0 credits; one beverage brand's list domain
returns nothing and is `no_data`. A pool-products manufacturer's description reads *"the
largest manufacturer of swimming pool liners, toys, games and maintenance equipment"*.

Step 5, for that row: `fits: yes`, `anchor: pool liners`, `offer_item: cash flow forecasting
ahead of inventory buys`, `line: know how much cash you need before each big pool liner buy`.
Guard passes, grade 2.9: `send`.

For a coffee brand in 40,000 stores, the first line (*"know the true cost of every organic
coffee blend before it ships to stores"*) passes the guard but reads at grade 7.6, so the verdict
is `rewrite`. The rewrite, *"know what each organic coffee blend costs you before it hits the
shelf"*, reads at 4.9: `send`.

The school district is `no_fit`. Delivered: 8 `send`, 1 `no_fit`, 1 `no_data`, three different
offer items across the eight lines, 0 credits, and a note that the frame was borrowed.
