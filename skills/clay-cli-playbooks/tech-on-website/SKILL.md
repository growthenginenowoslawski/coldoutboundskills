---
name: tech-on-website
description: |
  Decide which companies actually run a named technology on their website today, verified against the
  live site rather than read from a technographic database, and return one verdict per domain with the
  evidence that decided it. Finds candidates with the free technographics filter in Clay search (or
  takes your list), then checks each homepage's response headers and the technology's own JSON endpoint
  in a free Clay workflow. Use whenever someone asks: find companies using Shopify, which of these
  domains run WordPress, are they on HubSpot, who uses Klaviyo, technographic targeting, tech stack
  filter for a list, verify the tech on their site, is this store still on Shopify. Measured on one day,
  one of six readable stores that the search filter returned as Shopify users confirmed on the live
  site, so the filter is a candidate list and the live check is the answer. Do NOT use it to find the
  software a company sells (that is a company-search or keyword job), to check whether a site mentions
  a phrase (google-search-site-filter), to find a company's social profiles (social-link-finding), or to
  detect back-office systems that never reach a public page.
---

# Tech on website (a database says installed; only the live site says running)

The insight: **a technographic record is a claim about the past, and it is wrong often enough that it
cannot gate a list on its own.** Measured 2026-09-23 on Clay search, one workspace:

| Candidate source | Rows gated | Confirmed live | Not detected | Could not look |
|---|---|---|---|---|
| `technographics.any(vendor = "Shopify")`, US, 11-200 staff, no industry filter | 5 | **0** | 4 (all media and publishing sites) | 1 (HTTP 413) |
| same filter plus `industry = "Retail Apparel and Fashion"` | 8 | **1** (vendor header) | 1 | 6 (five 403s, one 403 challenge) |

One of six stores that could be read is running the technology the filter promised. The source
playbook measured the same shape on a different vendor's database a month earlier: 6 of 10 claimed
Shopify stores were real, and two of the misses were not shops at all. Different database, same
lesson: **the filter decides who to check, the live site decides the answer.**

Three consequences, each of which changed a step below.

**On Clay the free live check reads headers and JSON, not HTML.** The HTTP action returns the status
code and response headers when asked to, but returned an empty body for every non-JSON page probed (a
200 HTML homepage and a plain-text file among them). So the free gate confirms a technology only when
the vendor sets a header (Shopify's `powered-by`, WordPress's `api.w.org` link) or exposes a JSON
endpoint (the store's `products.json` path, the `wp-json` index). A technology that lives only in a `<script>` tag (most
martech) comes back `unconfirmed` on the free path, and confirming it is a paid page read.

**"Could not look" is common, and it is never "no".** Six of eight apparel storefronts answered Clay's
fetcher with a 403. A grader that reads an empty result as a negative reports six confident "not on
Shopify" verdicts for stores that may well be on Shopify. `blocked` is its own verdict and is excluded
from every negative count.

**The header outranks the oracle.** A storefront on Shopify's headless stack returned the Shopify
`powered-by` header and a **404** on its `products.json` path. An oracle-first grader calls that store a
non-customer. The grade order below puts headers first for that reason.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and if an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **Target technology** | the exact product name (Shopify, WordPress, Klaviyo) | no default — there is nothing to check |
| **Direction** | discover (find companies) or verify (check a list they hold) | ask; it decides whether Step 3 runs a search |
| **The list** (verify direction) | domains in a CSV, a table, or pasted | no default in verify direction |
| **Search scope** (discover direction) | geography, headcount band, industry for the search filter | ask; an unscoped technographic search returns publishers and media sites first (measured) |
| **Row policy** | when the verdict is not `confirmed`: exclude the row, or keep it and drop the tech-specific line | ask; it is a judgment about their campaign. Exclude is the safer default when the whole offer is the technology, and using it must be stated |
| **Paid page read** | yes or no, for `unconfirmed` and `blocked` rows | default no; the free verdict stands and those rows are reported as such |
| **Copy line** | whether they want a short line naming the verified stack | default no; the verdict is the deliverable |

If an answer sheet sits beside this skill, load it and ask only for what it does not cover, and say
which values came from it. With no sheet, say nothing about sheets. At delivery, offer to save the
answers (identifiers only, never a token), private and never published: *"want me to save these
answers so the next run doesn't ask again?"*

## What this skill touches

- **Reads** — your list (or Clay search results), each domain's public homepage headers and one public
  JSON endpoint per domain, and the Clay action catalogue and routine costs.
- **Writes** — one draft workflow in your Clay workspace, named `tech-on-website gate (safe to delete)`,
  never published, holding only run logs. Nothing to a CRM, a table or a sequence.
- **Never** — publishes the workflow, deletes anything, writes to a CRM, calls a paid action without
  the Step 5 approval, or reports a `blocked` row as a negative.
- **Halts** — Step 4 write-approval, Step 5 sample-review, Step 5 spend-approval.

## Step 0 — Check the platform, and say where the work runs

Run `clay whoami` and `clay --version`. If either fails, report which one, the version required, and
the one command that fixes it, and stop. Do not install or upgrade anything.

Pull the live facts this run depends on, free, never from memory:

```
clay workflows actions list > actions.json
jq '.data[] | select(.actionKey=="http-api-v2") | {packageId, creditCost, paymentType}' actions.json
clay workflows actions schema PACKAGE_ID http-api-v2          # must list returnResponseMetadata
jq '.data[] | select(.actionKey=="scrape-website") | {packageId, creditCost}' actions.json
clay workflows actions schema PACKAGE_ID scrape-website --include-options   # outputFields enum, customRegex
clay routines list --limit 100 | jq '.data[] | select(.name=="Website Technology Stack")'
clay routines get ROUTINE_ID                                   # estimatedCreditCost.perRun
```

| Job | Expected (read live 2026-09-23) | Cost read then | Output used |
|---|---|---|---|
| fetch homepage headers and a JSON endpoint | `http-api-v2`, Clay utility package | no `creditCost` (free utility); 1 to 2 action executions per row | `result.statusCode`, `result.headers`, `result.body` (JSON only) |
| read raw page HTML (optional, paid) | `scrape-website`, Clay utility package | 1 credit per page | `bodyText` with `keepNonText: true`, or `customRegex` matches |
| archive technology list (optional prior, paid) | managed function "Website Technology Stack" | 2 credits per run | one flat technology list |

**If `http-api-v2` is missing, or its schema has no `returnResponseMetadata` parameter, stop and say
so.** The free gate cannot run without headers, and substituting a page scraper changes the price and
the evidence class. If a paid arm is missing, say which, and continue on the free path.

Where the work runs: search runs on Clay's search quota (not credits); the gate runs as a Clay
workflow on free actions; grading is deterministic Python inside the workflow; any copy line is written
by you, the agent, from the verdict. Say this to the installer in one sentence, together with the
Writes line above.

Do not start a step before the steps above it have their answers. If a declared input is missing, ask
for it — never assume a default and continue.

## Step 1 — Collect the definition

Ask for the declared inputs that change scope or cost first: target technology, direction, and (for
discover) the search scope. Ask the row policy, the paid-read choice and the copy-line choice at the
steps that need them.

Then check the target against `references/fingerprints.md`. If it has **no header and no oracle** in
that file, tell the installer now, before anything is built: *on the free path every row will come
back `unconfirmed` for this technology; confirming it needs a page read at the price in Step 0.* Ask
whether to continue free (a candidate list with honest labels), approve the page read, or stop. A
technology whose only evidence would be its name in body text is not detectable from a website; say so
and stop.

## Step 2 — Decide what a verdict means for this target

Five verdicts, no sixth, resolved in this order. The first that applies wins.

1. `input_invalid` — the domain does not normalize to a bare host (no dot, spaces, an email). Decided
   in Step 3, before any call.
2. `confirmed` — a vendor header for the target fired on a readable homepage, **or** the oracle
   returned the expected JSON shape.
3. `not_detected` — the oracle returned 404 (or a 200 page without the JSON shape) and no target
   header fired. Only possible for a target that has an oracle.
4. `blocked` — the homepage returned 401/403/405/413/429/503, another 4xx/5xx, a challenge header, or
   no response, and the oracle was also inconclusive. **Never a negative.** The reason travels with it.
5. `unconfirmed` — the homepage was readable, no target header fired, and the target has no free
   oracle. The free path cannot answer; it is not a negative either.

`not_detected` is the only negative. Report the other two non-positives separately and never fold
them into it.

## Step 3 — Free checks before anything else

- **Normalize** every domain (lowercase, strip scheme, `www.`, path and query) and **dedupe**. Mark
  anything that does not normalize `input_invalid` and drop it from the run. Name how many.
- **Discover direction:** write the Clay search query from the installer's scope with the
  technographics filter, per the search grammar (`clay searches query-mode reference`):
  `select from companies where technographics.any(vendor = "Shopify") and ... limit N`. Create it with
  `clay searches query-mode create --query '...'`, page it with `clay searches query-mode run
  SEARCH_ID`. It bills search quota, not credits. On `rate_limited` wait the stated `retryAfter` and
  retry; on `server_error` retry once. Add an industry filter wherever the offer allows it: unscoped,
  the first page was five media brands.
- **Size the pull.** The live check will confirm a fraction of what the search returns; plan from the
  measured rates in the insight above, not from the search count, and say which rate you used.

## Step 4 — Build the gate, then a 10-row batch

Ask once before building: *"I'll create one draft workflow in your workspace called `tech-on-website
gate (safe to delete)`. It is never published and I won't delete it without you. OK?"* That is the
write-approval halt; wait for the answer.

Build it exactly as `references/gate-workflow.md` lays out (four nodes, the code bodies in
`scripts/clean_node.py` and `scripts/grade_node.py`). Then run ten rows through it with
`clay workflows runs test`, read each run's `.status` and the Grade node's outputs from
`clay workflows runs steps`, and check the run record's `dataCreditsUsed` is 0.

Read the first result before starting the other nine. If it errors, fix the wiring before running
more; a run that starts proves nothing about inputs being understood.

## Step 5 — ONE gate: the batch, the cost, the writes, the ask

One message, carrying all of it:

- the ten verdicts as a table (Representative output below), with the count per verdict;
- what the full run costs: **0 credits** on the free path, about 1 to 2 action executions per row, and
  run time at the concurrency you will use;
- the paid options for the non-answers, priced from Step 0: a raw page read at the per-page price for
  each `unconfirmed` and `blocked` row, stating that a platform found only in HTML still stays
  `unconfirmed`; the archive technology list at its per-run price, stating that it is a prior and never
  confirms anything;
- what gets written: nothing beyond the draft workflow already created;
- the ask: run the rest free, add the paid read for N rows, or stop.

Then stop and wait. Stop a second time only if the batch shows something they could not have
expected, such as most rows `blocked`; say what it means for the list size.

## Step 6 — Run and grade

Loop the remaining rows through the workflow, capping concurrency (13 at once was clean in the build;
more was not measured). Record `verdict`, `evidence`, `header_stack`, `blocked_reason` per row. Retry a
run that did not reach `completed` once; a second failure is reported as a failed run, not a verdict.

If the paid page read was approved, run it only on the approved rows. Search its raw HTML for the
target's patterns in `references/fingerprints.md`. A martech or widget pattern moves the row to
`confirmed` with the pattern as evidence. A platform pattern alone does not: a platform stays
`unconfirmed` without a header or oracle, because agency and Buy-Button pages carry the same strings.
If the returned HTML contains no `<script` tags at all, the reader stripped them and the row stays
where it was.

## Step 7 — Deliver

Per row: domain, target, verdict, evidence, the other technologies seen in headers, and the blocked
reason where there is one. Then the coverage line: rows in, `input_invalid` dropped, and the count per
verdict, with `blocked` and `unconfirmed` stated as not-looked and not-answerable respectively.

Apply the row policy the installer chose. If they asked for a copy line, write it yourself, only for
`confirmed` rows, only naming technologies in the verified evidence (never `infra`), second person,
under 110 characters, no product named twice, completing the sentence "Noticed LINE." Example:
`your storefront runs on Shopify`. Any non-`confirmed` row gets an empty line, not a softened one.

## Representative output

### Verdict table

| Domain | Target | Verdict | Evidence | Also in headers | Blocked reason |
|---|---|---|---|---|---|
| northwind-outfitters.com | Shopify | confirmed | header powered-by: Shopify | — | — |
| contoso-journal.com | Shopify | not_detected | oracle 404, no vendor header | WordPress | — |
| fabrikam-apparel.com | Shopify | blocked | homepage 403, oracle 403 | — | http_403 |
| tailspin-goods.com | Klaviyo | unconfirmed | no header or oracle for this target | Shopify | — |

### Coverage line

40 domains in · 1 input_invalid dropped · 39 checked: 6 confirmed, 11 not_detected, 19 blocked (not a negative), 3 unconfirmed (free path cannot answer) · 0 credits.

## What this skill does not claim

- Thirteen search rows and six hand-picked rows were gated live on one day; the confirmed rates are that sample, not a benchmark.
- Only the Shopify header set carries prior validation; every other header pattern is plausible and untested against known negatives.
- The paid page read was not live-run for this port (the workspace had 1.5 credits); its price was read live on 2026-09-23 as 1 credit per page, and the managed archive list as 2 credits per run.
- The blocked rate was measured from Clay's own fetcher; another egress may be blocked more or less often.
- A `confirmed` verdict means the technology answered on the day it was checked, not that it will stay.
- Nothing here detects Shopify Plus versus Shopify, back-office software, or anything behind a login.

## What good looks like

A good run is a list the installer can gate a campaign on without reading the method: every row has
exactly one verdict from the five, every `confirmed` row names the header or oracle that decided it,
and the coverage line makes the non-answers visible at a glance. On a DTC list a large `blocked` share
is normal and correct; what matters is that it is labelled and nobody reads it as "not on Shopify".

A thin or failed run looks different, and the tells are specific. Negatives with no evidence string.
A `not_detected` count that swallowed the 403s. `confirmed` rows whose only evidence is a CDN URL in
HTML. A copy line on a row that is not `confirmed`. Or a run that went straight from the search result
to the list, so every verdict is the database's claim under a new heading.

## Rules

- MUST check every candidate on the live site; NEVER ship a technographic filter result as the answer.
- MUST treat `blocked` and `unconfirmed` as non-answers; NEVER count either as a negative.
- MUST let a vendor header outrank the oracle; NEVER call a headless store a non-customer on an oracle 404 alone.
- MUST treat any oracle status other than 404 or a well-shaped 200 as inconclusive.
- MUST require a header or oracle for a platform claim; NEVER confirm a platform from an HTML string alone.
- MUST match the target by exact name, never by substring ("Shopify Buy Button" is not "Shopify").
- MUST read action cost and routine cost live in Step 0; NEVER price from this file.
- MUST ask before creating the workflow and before any paid call; NEVER publish or delete a workflow.
- NEVER name `infra` (CDN, host) in a copy line, and never write a line for a non-`confirmed` row.

## Worked example

Asked: *"Find US apparel brands with 11-200 staff that are on Shopify; I sell a Shopify app, so drop
anyone who isn't."*

Declared: target Shopify, discover direction, scope US + 11-200 + Retail Apparel and Fashion, row
policy **exclude** (the offer is the technology), no paid read, no copy line. Shopify has a header set
and an oracle, so the free path can answer.

Step 3 search: `select from companies where technographics.any(vendor = "Shopify") and industry in
("Retail Apparel and Fashion") and locations.any(is_headquarters = true and country_name = "United
States") and company_size in ("11-50","51-200") limit 8` returned eight brands. Step 4 built the gate;
the batch ran all eight at 0 credits, 2 action executions each.

| Brand (as returned) | Verdict | Evidence |
|---|---|---|
| a shapewear brand | confirmed | `powered-by: Shopify, Oxygen, Hydrogen` (oracle 404, headless) |
| a luxury marketplace | not_detected | oracle 404, no vendor header |
| six other brands | blocked | five `http_403`, one `http_403_challenge` |

Step 5 told the installer: one confirmed, one real negative, six not looked at; free run of the rest
costs 0 credits; a page read for the six would cost 6 credits and would still leave any HTML-only
Shopify hit `unconfirmed`. Under the exclude policy the deliverable is one row plus a named list of six
to re-check another way, stated at the top: *six of eight could not be read from Clay's fetcher; they
are unknowns, not non-customers.*
