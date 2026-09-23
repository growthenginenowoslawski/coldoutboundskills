---
name: pricing-page
description: |
  Decide whether a company publishes real self-serve pricing on its own website and, when it does,
  extract the plan tiers, the price points, the lowest paid price and what changes between tiers,
  with every plan name and price asserted back against the fetched page. Free Clay URL probes find
  the pricing page (five conventional paths on the canonical host, then the sitemap), one page
  fetch reads it, the agent writes the structured record, and a script rejects any price that is
  not printed on the page. Built for filtering first: split a list into product-led and sales-led,
  or quote-only, companies. Use whenever someone asks: do they have a pricing page, is their
  pricing public, filter out enterprise quote-only companies, what do they charge, find their plans,
  self-serve vs sales-led, what is their cheapest plan. Do NOT use it to find a customer to name-drop
  (case-study-page), to write the email body (creative-ideas), or to guess what a company pays
  after negotiation.
---

# Pricing page (prove the page exists, then prove every price)

The insight: **"is there a pricing page" and "what does it cost" fail in two different ways, and
both failures look like success.** Measured live on 2026-09-23:

- **Existence lies at the status code.** Clay's URL checker follows redirects and reports the final
  status, so `palantir.com/pricing` reads **200** while landing on `/404`, and `anaplan.com/pricing`
  reads **200** while landing on `/contact/`. On three of eight real software companies `/pricing`
  read 200 and landed on the homepage or an unrelated page. Worse, `gingrapp.com/pricing` landed on
  `www.gingrapp.com/` — the bare host dropped the path on its redirect — while
  `www.gingrapp.com/pricing` was a real priced page. Only the final URL, on the canonical host,
  answers "does it exist".
- **The headline price is not always the price.** One real page showed `$179*/month` for its top
  plan with a footnote: *"Pricing shown with active Integrated Payments. $209/mo without."* Another
  put four tiers inside one comparison-table cell. A reader that takes the big number reports a
  conditional discount as the list price.

What follows: existence is decided on the final URL with free probes, the page is read once, and
every price in the record is string-matched back to the page by `scripts/pricing_verify.py`.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and if an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The accounts** | a list of company domains, or a Clay company search whose rows carry `domain` | no default — there is nothing to check |
| **Page-fetch arm** | Clay's static scrape action (Clay credits), or an actor-runner on their own connected scraping account (no Clay credits, their vendor bills) | ask; with neither, Steps 1 to 3 still deliver `pricing_url` and existence only |
| **What a finding does to a row** | filter (remove), route (send to another list), or report only | default **report only**. Never remove a row on `unreadable` or `no_pricing_page_found`, whatever they choose |
| **Copy clause wanted?** | whether they want a one-line price mention for an email | default **no**. The record is the deliverable; a clause is opt-in and uses only verified, high-confidence rows |

If an answer sheet is present beside this skill, load it, **say which values came from it**, and ask
only for what it does not cover. If there is no sheet, say nothing about sheets. At delivery, offer:
*"want me to save your answers to a file, so the next person on your team doesn't have to answer
these again?"* — identifiers only, never a token.

## What this skill touches

- **Reads** — the domains you supply, the public pricing pages at those domains (through Clay URL
  and sitemap actions and one page fetch per found page), and the Clay action catalogue.
- **Writes** — nothing to any system of yours. It creates one labelled test workflow in your Clay
  workspace for the free probes, and hands the records back as a file.
- **Never** — removes a row from any list itself, writes to a CRM or sequencer, or reports a price
  it could not find printed on the fetched page.
- **Halts** — Step 4 `sample-review`, Step 4 `spend-approval`.

## Step 0 — Check the platform, and say where the work runs

Run `clay whoami; clay --version`. If it fails, say which component is wrong and the one command
that fixes it, and stop. Do not install or upgrade anything to repair it.

Confirm each named action live, free, never from memory
(`clay workflows actions list`, then `clay workflows actions schema <packageId> <actionKey>`):

| Job | Expected `(package, actionKey)` | Declared cost (read live 2026-09-23) | Field read |
|---|---|---|---|
| final status of a URL | Clay utilities `check-url` | no `creditCost`; one action execution | `result.statusCode` |
| final URL after redirects | Clay Scrapers `get-page-redirect` | no `creditCost` | `result.redirectLink` |
| sitemap discovery | Clay utilities `get-sitemap` | no `creditCost` | `result.links[]` |
| page text, Clay-billed arm | Clay utilities `scrape-website` | `creditCost` 1 per page | `bodyText` |
| page text, own-account arm | an actor-runner whose `paymentType` is Bring Your Own Account | no Clay credits; their vendor bills | the actor's text and final-URL fields |

Match on `(packageId, actionKey)`. **If a named action is absent, say so and stop that step**; never
substitute the nearest-looking one. Do not use the generic HTTP action to read pages: it parses JSON
only, so an HTML page comes back as `body: {}`, and it returned `400` from bot-protected origins
where the URL checker saw `200`.

Tell the installer before anything runs: *"The probes run in one test workflow in your Clay
workspace at zero Clay credits. Reading a found page is the only billed step, once per page, on the
arm you chose. Extracting the plans happens here in the conversation, free. Nothing is written to
your systems and no row is removed."*

Do not start a step before the steps above it have their answers. If a declared input is missing,
ask for it — never assume a default and continue.

## Step 1 — Collect the inputs

Ask for the accounts, the fetch arm, and what a finding does to a row. Normalise every domain to a
bare lowercase host. Rows from a Clay company search already carry a bare `domain`.

## Step 2 — Build the probe workflow once

One labelled workflow with a manual `domain` trigger and a strictly linear chain (a two-input node
is a join and deadlocks). Shapes: `references/workflow-build.md`.

1. **Canonical host**: `get-page-redirect` on the bare domain, then a code node that keeps the
   redirect's host when it is the same site (bare ↔ `www.`) and emits `base`.
2. **Five paths on `{{base}}`**, each `check-url` then `get-page-redirect`: `/pricing`, `/plans`,
   `/pricing-plans`, `/price`, `/plans-pricing`.

One test run per domain; read `clay workflows runs steps`, never the run status alone.

## Step 3 — Decide the page, free, first match wins

A path is the pricing page when its status is 2xx, its final URL's path is not `/`, and that final
path still contains `pric` or `plan`. A redirect to `/plans/` passes (measured on one CDN company);
a redirect to `/404`, `/contact/` or a product page does not. Record a redirect to a contact page as
evidence (`pricing redirects to contact`), not as `quote_only` — nothing was read.

If no path passes: `get-sitemap` with `keywords` as a **JSON array**, `["pricing","plans"]` (a
comma string returned 0 links on sites with hundreds of matches). Drop `/blog/`, `/press`, help and
locale-duplicate URLs; prefer the shortest path ending in `pricing` or `plans`. A timeout is
`sitemap_timeout`, not a miss.

## Step 4 — Ten rows, then ONE gate: the batch, the cost, the writes, the ask

Run Steps 2 to 6 on ten rows and show, in one message: the ten records with their verification
result, how many pages were found, what the full run bills (found pages × the arm's per-page cost),
and that nothing is written and no row removed — the installer applies filters in their own system
from the file. Ask, and wait.

## Step 5 — Read the page once, and check what was served

Fetch the page with the chosen arm. If the arm's final URL is the site root or a non-pricing path,
or the request failed, or the text is under about 800 characters with fewer than two currency
amounts, the row is `unreadable` — measured, a sitemap URL for a pricing page redirected to the
homepage at fetch time. `unreadable` is a failed read, never a finding.

## Step 6 — Write the record, then verify it mechanically

You, the agent, read the page and write one record:

`pricing_public`, `pricing_model` (`per_seat` | `usage` | `flat` | `credits` | `quote_only` |
`unknown`), `plans` (at most 6, `{name, price, period}` in page order), `lowest_paid_price`,
`has_free_tier`, `enterprise_quote_only`, `feature_diff_axis` (6 words max), `confidence`.

Reading rules that carry the measured traps:

- `pricing_public` is true only when at least one plan shows a real currency amount. Every tier
  saying contact sales is `quote_only`.
- Take a price only from its plan card, never from body copy, a footnote or an ROI calculator.
- **A price with an asterisk or a condition ("with integrated payments", "for 12 months", "first
  year") is not the list price.** Use the unconditional price the page states; if none is stated,
  keep the conditional one and set `confidence: low`.
- A free trial is not a free tier. "Starting at" is a floor: keep it, and say so.
- When the page does not say whether a price is per user or per account, do not choose: use
  `flat` and `confidence: low`.

Then run `python3 scripts/pricing_verify.py records.json`, where each record carries `page_file`
(the saved page text). Any plan price or `lowest_paid_price` not printed on the page fails the
record and drops it to `confidence: low`. Fix the record from the page, never by loosening the check.

Verdicts, first match wins: `sitemap_timeout`, `no_pricing_page_found`, `unreadable`,
`quote_only`, `public_pricing`. Only `quote_only` and `public_pricing` at `confidence: high` may
filter or route a row.

## Step 7 — Deliver

One row per domain with `pricing_url`, the verdict, the record, `verified`, and any problems. A
coverage line, the Clay spend each run reported (`dataCreditsUsed`), and a plain statement of what
was defaulted.

## Representative output

### Pricing records

| domain | verdict | pricing_url | pricing_model | plans | lowest_paid_price | enterprise_quote_only | confidence |
|---|---|---|---|---|---|---|---|
| northwind.example | public_pricing | https://www.northwind.example/pricing | per_seat | Starter $12/mo · Team $29/mo · Enterprise (contact) | $12 | true | high |
| contoso.example | quote_only | https://contoso.example/plans/ | quote_only | Growth (contact) · Scale (contact) | | true | high |
| fabrikam.example | no_pricing_page_found | | unknown | | | | |
| adatum.example | unreadable | https://adatum.example/pricing | unknown | | | | low |

### Coverage line

60 domains · 22 pricing pages found (19 by path, 3 by sitemap) · 20 read · 17 public, 3 quote-only ·
38 no page found (not a finding) · 2 unreadable · 0 Clay credits on probes · 22 page reads billed.

## What this skill does not claim

- Tested live on 11 real domains on 2026-09-23; a mechanism test, not a coverage rate for any segment.
- `no_pricing_page_found` means five paths and the sitemap missed, not that the company has no public pricing.
- The plan-name check is a substring match, so a generic plan name ("Basic") can pass on a page that uses the word elsewhere; the price check is what catches invented numbers.
- The Clay-billed page arm (`scrape-website`, 1 credit per page) was not live-run because the test workspace had no credits; its schema and cost were read live.
- JavaScript-only price tables that the fetch arm does not render will read as `unreadable`; no rendering arm was tested.
- Prices are what the page printed on the day it was fetched; nothing here is cached or re-checked.

## What good looks like

A good run is one a sceptic can audit in minutes: every `public_pricing` row names a URL whose
final path is a pricing page, every price in it can be found on that page with Ctrl-F, conditional
and promotional prices are either resolved to the list price or flagged `low`, and the rows with no
record say which of `no_pricing_page_found`, `unreadable` or `sitemap_timeout` stopped them. On B2B
software, expect well under half to have a findable public page; that is the market, not a miss.

A thin run looks like: `pricing_url` values that are homepages or `/404` pages, many
`no_pricing_page_found` on sites that obviously have pricing (the canonical host or the sitemap
array was skipped), `quote_only` on rows that were never read, or a `lowest_paid_price` that
appears in no plan.

## Rules

- MUST decide existence on the final URL on the canonical host; NEVER on a 200 alone.
- MUST pass `get-sitemap` keywords as a JSON array.
- MUST run `scripts/pricing_verify.py` on every record; NEVER report a price that fails it.
- NEVER treat `unreadable` or `no_pricing_page_found` as a finding, and NEVER let either remove a row.
- NEVER record a conditional or promotional price as the list price without `confidence: low`.
- NEVER remove, route or edit rows in the installer's systems; hand back the file.
- NEVER write a copy clause unless asked, and then only from verified `high` rows.

## Worked example

Asked: *"which of these 11 software accounts publish pricing, and what's their entry price?"* The
installer picks the own-account fetch arm and "report only".

The probe workflow runs per domain. Three rows find a page on the first path. One CDN company's
`/pricing` lands on `/plans/` and passes. Two enterprise vendors read 200 on `/pricing` but land on
`/404` and `/contact/` — both rejected at Step 3, recorded as `no_pricing_page_found` with the
redirect as evidence. A pet-care software company's bare host drops the path; the canonical-host
step probes `www.` and finds `/pricing`.

The batch gate shows the records, "5 pages read on your account, zero Clay credits, nothing
written", and the installer approves.

On the pet-care page the agent reads Spa `$109/month`, Play `$169/month`, and Stay `$179*/month`
with the footnote "$209/mo ($179/mo annual) without" integrated payments, so it records Stay at
`$209` and notes the condition. `pricing_verify.py` finds `$109`, `$169` and `$209` on the page and
passes the record. A deliberately invented `$39` plan on another record fails with
`price not on page: $39` and drops to `low` — tried on purpose in the test.
