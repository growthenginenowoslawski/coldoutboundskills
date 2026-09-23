---
name: lookalikes
description: |
  Turn one customer case study, flagship logo or happy customer into the list of companies that would
  read that story and see themselves. Reads the seed company with the free company-enrichment
  function, decomposes WHY the story lands into two to five attributes a company database can filter
  on, searches Clay company search on literal product phrases in the company description, judges
  every returned company against the attribute card, checks the site still responds, and labels each
  survivor with a brand-free descriptor for copy ("a marketing platform about your size"). Use
  whenever someone asks: find more companies like our best customer, lookalikes of X, companies like
  our happiest client, who would this case study land with, build a list around this case study,
  similar companies to this domain, expand this list, it is too small. Clay company search has no
  similar-to-this-domain filter, so the attributes and the per-row judgment carry all of the
  precision. Do NOT use it to size a whole market from an ICP sentence with no anchor customer
  (tam-sizing), to find people at companies you already have (find-contacts-at-account), or to name a
  customer from the prospect's own case-study page.
---

# Lookalikes (decompose why the story lands, then search on the reasons — there is no lookalike filter)

The insight: **"companies like X" is not a query Clay can run, and the two obvious substitutes — the
seed's industry label and a semantic description of the seed — return companies that share X's topic,
not X's story.** Clay's own search reference says direct similarity by domain or name is unavailable
and maps "like X" to an industry proxy. Measured on 2026-09-23 with an SMS and email marketing
platform as the seed, judging every returned row against the same attribute card:

| Query shape (same size and HQ filters) | Real lookalikes in the first 10 |
|---|---|
| seed's industry + one semantic phrase mixing product and buyer ("SMS and email marketing platform for ecommerce brands") | **1** |
| "Software Development" + semantic `products_and_services is_similar_to ("SMS marketing platform", "email marketing automation")` | **1** |
| the seed's own tag "Advertising Services" + the same semantic phrases | **0** (the whole result set was 5 rows: marketplaces and shells) |
| three industries + literal `description contains ("SMS marketing", "text message marketing", "SMS and email")` | **4** |

The semantic operator matched the generic words: "automation" pulled manufacturing-automation
vendors, "platform" pulled marketplaces, "for ecommerce brands" pulled ecommerce storefronts. Literal
product phrases in the description quadrupled precision, and the misses left were an agency, a
meetings tool, a salon booking tool — the kind of error a reader catches in a second.

Two more things the same run showed:

- **The seed's own industry tag is its customers' category.** The free company enrichment tags the
  seed "Advertising Services" — a software vendor filed by who it sells to. Filtering on that label
  returned 5 companies in total and none of them a software vendor.
- **A numeric headcount filter does not bind the row.** A 50–2,000 employee filter returned a company
  whose own size band on the same row read 10,001+. Post-validate size on the row.

What was measured before this port (2026-08-04, a different company database that does have a
lookalike anchor): raw lookalike alone **4 of 10** usable, decomposed attributes without the anchor
**7 of 10**, attributes intersected with the anchor **10 of 10**. On Clay the anchor does not exist,
so precision comes from two places only: literal phrases that name **what the product is**, and a
judgment on **every** returned row. Four in ten is the raw rate; the judgment is what makes the list
shippable.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and where an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **Seed company** | the domain of the customer the story is about | no default — there is nothing to be like |
| **The story** | the case study text, or two or three sentences on why that customer bought and what changed | ask; without it the attributes describe the seed, not why the story lands — say that the run is description-only |
| **What they sell** | three to six lines on the installer's own offer | ask; it decides which seed attributes matter |
| **Geography** | countries where the list must be headquartered | no default — ask |
| **Size** | the headcount bands their buyers sit in | no default — ask; if they say "about the seed's size", read the seed's band at Step 2 and say so |
| **Exclusions** | domains to leave out: current customers, open deals, do-not-contact | ask every time; the seed itself is always excluded |
| **List size** | how many companies they need | ask — it decides how far Step 6 widens |
| **Brand in copy** | whether copy may name the seed's brand | the author's default was **no**: the label is a generic descriptor, which carries the same recognition without a permissions question |

**If an answer sheet is present beside this skill, load it and ask only for what it does not cover.**
Say which values came from the sheet before using them. If there is no sheet, say nothing about
sheets. At delivery, offer to save the answers (identifiers only, never a token or a password),
private and never published: *"want me to save your answers to a file, so the next person on your team
doesn't have to answer these again?"*

## What this skill touches

- **Reads** — the seed and story you supply, the free company-enrichment function (seed only), Clay
  company search (search-result quota, not credits), and a free Clay check that each candidate's
  website responds, run in a workflow created for the purpose.
- **Writes** — nothing to your data. The one thing created in the workspace is a test workflow
  holding the website check; it is named so it can be found and deleted, and the skill says so.
- **Never** — writes to a CRM or a table, names the seed's brand in the descriptor unless told to, or
  sends the story text anywhere except your own agent.
- **Halts** — Step 3 sample-review.

## Step 0 — Verify Clay and pull the live surfaces

Say this to the installer as the run starts: *this reads Clay company search and a free company
enrichment, creates one test workflow for a website check, writes nothing to your data, and hands you
a table.* Then:

```
clay whoami; echo "exit_code=$?"
clay --version
clay searches query-mode reference | jq -r '.reference' > /tmp/clay-search-reference.md
clay routines list --limit 100 | jq '.data[] | select(.name == "Enrich Company")'
clay routines get <the id that returned>
clay workflows actions list | jq '.. | objects | select(.actionKey? == "check-url")'
clay workflows actions schema <packageId> check-url
```

| Check | Expect | If not |
|---|---|---|
| search reference | `description contains (...)`, `industry`, `company_size` buckets, `locations.any(is_headquarters = true ...)`, `clay.exclude_company_identifiers(...)`; a similarity section saying direct similarity is unavailable | if a similarity-by-domain filter HAS appeared, read it and tell the installer the author's measurements predate it |
| `Enrich Company` | present, `perRun` **0**, input `Company Identifier` | fall back to a company search on the seed with `clay.include_company_identifiers(("seed.com"))`, which returns industry, size and description at search quota; say so |
| `check-url` | the Clay utility package, no `creditCost`; inputs `url`, `tryVariants`, `enableProxyFallback` (which "costs 1 credit only if the fallback needs to be used") | skip the website step and mark every row `unchecked` |

Where the work runs: seed enrichment, search and the website check on Clay; the attribute card, the
page reading and every per-row judgment by you, the agent reading this skill. **No Clay AI column and
no outside model key.**

If the platform check fails, say which component is wrong and the one command that fixes it. Do not
install, upgrade or fetch anything to repair it.

## Step 1 — Collect the definition (do not guess)

Do not start a step before the steps above it have their answers. If a declared input is missing, ask
for it — never assume a default and continue.

Front-load seed, story, geography and size. Ask about exclusions before the first full pull, and
about list size before Step 6.

## Step 2 — Fingerprint the seed, then write the attribute card

```
clay routines runs start <Enrich Company id> --input '{"items":[{"id":"seed","inputs":{"Company Identifier":"seed.com"}}]}'
clay routines runs get <routineRunId> --wait 120
```

The result is under `.data[0].result`, keyed by the routine's name. Read `industry`, `size`,
`employee_count`, `specialties`, `description` and the primary location. A miss comes back
`status: complete` with an **empty result** (`{}`), not an error — measured on an invented domain. If
the result is empty, stop and ask for the seed's LinkedIn company URL, which the function documents as
its most accurate identifier.

Then write the attribute card yourself, from the story and the seed record:

| Field | Rule |
|---|---|
| **Reasons** | 2–5 reasons the story would land, each testable against a company description. "Sells software to marketers" is testable; "is innovative" is not — drop it |
| **Product phrases** | 3–6 two- or three-word phrases a vendor of this kind writes **about its own product** ("SMS marketing", "text message marketing"). Never the buyer ("for ecommerce brands"), never a word every company in the category uses ("platform", "automation") |
| **Industry labels** | 2–3 labels: the one that names what the seed IS, the database's own tag for the seed only if Step 3 shows it earns its place, and one adjacent. `industry in` is a union |
| **Size and geography** | the installer's bands as `company_size` buckets; HQ country |
| **Descriptor** | 4–10 words, lowercase, no brand, reads inside "We did this for ___." |

Show the card. It is the definition the whole list is built on.

## Step 3 — First page, judged, then ONE gate

```
select from companies
where industry in ("Software Development", "Technology, Information and Internet")
  and description contains ("SMS marketing", "text message marketing", "SMS and email")
  and company_size in ("51-200", "201-500", "501-1,000", "1,001-5,000")
  and locations.any(is_headquarters = true and country_name = "United States")
  and clay.exclude_company_identifiers(("seed.com", "customer1.com"))
```

`clay searches query-mode create --query '...'`, then `run <searchId> --limit 10`. `description contains`
is whole-word and case-insensitive, and a parenthesised list is an OR. Count mode is not supported, so
the page is read, not counted.

Judge the 10 rows (Step 5 rules). If fewer than half qualify, change **one** thing and re-read a page:
drop an industry label that brought only misses, or replace a product phrase that matched generic text.
Report each variant you tried with its hit count — that one line saves the next person the same loop.
`products_and_services is_similar_to (...)` is available as a recall arm, but measured it matched
generic words (1 in 10 twice); use it only if literal phrases return too few rows, and never without
the judgment.

Then stop with one message: the card, the query, the 10 rows with verdicts and reasons, the variants
tried, what the full pull costs (search quota; 0 credits), that the one workspace object created will
be a test workflow, and the ask: *build the list on this?* Wait.

## Step 4 — Pull

Page the chosen query with `run <searchId> --limit 100` until `hasMore` is false or the list size is
reached. Save every page as it arrives — the iterator is forward-only and cannot be replayed. Retry a
`server_error` or `rate_limited` only when no data came back; both were frequent when measured.

## Step 5 — Judge every row (you are the judge)

On each row's `name`, `industry`, `size`, `description` and `domain`:

- `qualified` only if the company satisfies **every** reason on the card. A company in the right industry
  with the wrong product does not qualify. A services firm, agency, publisher, marketplace or community
  does not qualify for a software-product story.
- Size: check the row's own `size` band against the installer's bands. Outside them is `off_size`,
  whatever the filter said.
- A thin or empty description is `unjudgeable`, never qualified.
- Write a one-line reason quoting the words in the description that decided it. Never infer a fact the
  description does not state.

## Step 6 — Check the site responds, then widen if short

For qualified rows, create one workflow named so it is obviously disposable (`… (safe to delete)`):

```
clay workflows create --name "<run name> website check (safe to delete)"
clay workflows triggers create <wf> --input '{"triggerType":"manual","inputSchema":{"type":"object","properties":{"domain":{"type":"string"}},"required":["domain"]}}'
clay workflows graph get <wf> --mode summary          # the trigger node id
clay workflows nodes create <wf> --input node.json     # one tool node, below
clay workflows runs test <wf> --inputs '{"domain":"northwind.com"}'
clay workflows runs steps <wf> <runId>                 # result.valid, result.statusCode
```

The tool node calls `check-url` with `url` mapped to `{{domain}}` from the trigger, `tryVariants` true
and `enableProxyFallback` **false** (the fallback is the only part that bills). `valid: false` →
`dead`. `valid: true` with a 403 is a site blocking bots, not a dead one (measured on a large vendor).
**This catches dead domains, not parked ones**: a parked page answers 200. Tell the installer the
workflow's name and that they can delete it.

Short of the list size: add one product phrase taken from the qualified rows' own descriptions, or
widen size or geography, and re-run Steps 3–5 on the new query. Say what was widened. Never drop the
product phrases to get volume — that is a market-sizing job, not a lookalike list.

## Step 7 — Verdicts, single-valued, first match wins, then deliver

1. `dead` — the website check returned `valid: false`.
2. `off_size` — the row's own size band is outside the declared bands.
3. `unjudgeable` — no usable description.
4. `not_a_match` — fails at least one reason on the card.
5. `qualified` — carries the descriptor and the case-study reference.
6. `unchecked` — qualified, but the website check did not run.

Deliver the card, the query as run with the variants tried, the table, and a coverage line.

## Representative output

### Attribute card

| Field | Value |
|---|---|
| Reasons | sells marketing messaging software as a product · buyers are marketing teams at consumer brands · large enough for a lifecycle team |
| Product phrases | SMS marketing · text message marketing · SMS and email |
| Industry | Software Development · Technology, Information and Internet (seed's own tag, Advertising Services, not used) |
| Size, geography | 51–5,000 employees (buckets) · HQ United States |
| Descriptor | a marketing platform about your size |

### Lookalike list

| Company | Domain | Size band | Verdict | Descriptor | Why |
|---|---|---|---|---|---|
| Northwind Messaging | northwindmsg.com | 201-500 | qualified | a marketing platform about your size | "SMS and email platform for retail marketing teams" |
| Contoso Growth | contosogrowth.com | 51-200 | not_a_match | — | "a growth agency specializing in retention": services, not software |
| Fabrikam Cloud | fabrikamcloud.com | 10,001+ | off_size | — | row band outside 51–5,000 despite the filter |

### Coverage line

2 query variants read · 1 kept · 180 pulled · 74 qualified · 88 not_a_match · 9 off_size · 5 unjudgeable ·
4 dead. Seed tagged "Advertising Services" by the database; not used as the filter.

## What this skill does not claim

- Clay company search has no similar-to-this-company filter; every row qualifies on attributes and one agent reading, not on measured similarity to the seed.
- The 1, 1, 0 and 4 figures are four first pages for one seed on 2026-09-23; the 4/7/10-of-10 comparison was measured on a different database with a lookalike anchor on 2026-08-04.
- The website check finds dead domains; a parked or for-sale page answers 200 and passes.
- The judgment reads the database description, which can be out of date; it does not read the company's current website.
- It does not find contacts, and it does not claim the story's result will repeat at a lookalike.
- Size filters use Clay's buckets, which widen a stated ceiling outward, and the row's own band is what the verdict trusts.

## What good looks like

A good run hands back an attribute card a stranger could re-run, a query whose phrases were chosen by
reading pages rather than written once, and a list where every qualified row quotes the words in its
description that made it qualify. The qualified rows are recognisably the same kind of company as the
seed — same product type, same buyer — and the rejected rows are rejected for a stated reason.

A thin run looks like: a list filtered on the seed's own industry tag (full of its customers' category);
a semantic phrase that describes the seed's market instead of its product; qualified rows with no
reason; a size ceiling nobody checked on the row; or "lookalikes" delivered without the judgment step,
which on this seed would have shipped six wrong companies in every ten.

## Rules

- MUST write product phrases that name what the product is; NEVER put the seed's buyers or category-generic words into the phrases.
- MUST read and judge a first page before pulling; NEVER filter on the seed's own industry tag without checking what it brings back.
- MUST judge every returned row against every reason on the card; NEVER ship search rows unjudged.
- MUST check size on the row's own band.
- MUST exclude the seed and the installer's exclusions in the query.
- NEVER enable the website check's paid proxy fallback without asking.
- NEVER name the seed's brand in the descriptor unless the installer said to.
- MUST tell the installer the name of the test workflow the run created.

## Worked example

Asked: *"Our case study is Attentive. Find me companies that would read it and see themselves. US,
roughly their size or smaller."*

Run on 2026-09-23. Seed enrichment (0 credits): industry "Advertising Services", 1,001–5,000 band,
specialties marketing automation, growth marketing, retention marketing; description "unify customer
profiles… across SMS, email, RCS, and push". Size declared as 51–5,000 in buckets ("roughly their size
or smaller" became four buckets — said so).

Card reasons: sells marketing messaging software; buyers are marketing teams at consumer brands; US.
Four first pages read and every row judged:

- seed's tag plus a mixed semantic phrase: 1 qualified; the rest ecommerce platforms, a commerce
  agency whose row band read 10,001+, marketplaces, an IT services firm;
- seed's own tag alone with semantic product phrases: 5 rows in total, 0 qualified;
- semantic product phrases: 1 qualified (an SMS marketing vendor); the rest manufacturing software,
  marketplaces, a resale platform;
- literal description phrases: 4 qualified — an email marketing platform, a customer-engagement
  platform, an ecommerce retention-marketing platform, an email marketing tool for small businesses.
  Dropped: a retention agency, a multifamily marketing-data tool, a meetings assistant, a CRM, a salon
  booking tool, a restaurant ordering platform.

Website check workflow "… lookalikes (safe to delete)", 0 credits: the four qualified sites and the SMS
vendor answered `valid: true` (one with 403, a bot block); an invented domain returned `Domain not
found` → `dead`. Card, query and page shown; asked *build the list on this?* and stopped.
