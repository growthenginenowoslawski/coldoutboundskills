---
name: social-link-finding
description: |
  Resolve a company domain to its own official social profile URLs (LinkedIn company page, X,
  Facebook, Instagram, YouTube, TikTok), one canonical URL per platform or an empty value, never a
  guessed handle. LinkedIn comes from Clay's free company-enrichment function with a domain echo check;
  every platform comes from reading the company's own homepage, best match not first match; a
  site-restricted search fills a gap only after the agent verifies ownership, and never for X. Use
  whenever someone asks: find their LinkedIn, get the company LinkedIn URL for this list, find their
  Instagram, social handles for these accounts, which of these brands have a TikTok, company socials
  for the TAM. The page reader's default settings strip the footer where social icons live and found no
  LinkedIn on five of five homepages until one setting changed, so this skill checks that setting
  before it trusts an empty cell. Do NOT use it to find a person's profile (people search), to pull
  posts, followers or engagement, to check what software a site runs (tech-on-website), or to check
  whether a site mentions a phrase (google-search-site-filter).
---

# Social link finding (the company's own page is the evidence; everything else must earn it)

The insight: **a wrong social URL is worse than an empty cell, and an empty cell is only honest if
the page was actually read.** Downstream work scrapes whatever is behind the URL and writes copy from
it; a similarly named company's page produces confident, specific, false personalization, while an
empty cell degrades gracefully. Three measurements from 2026-09-23 set the order of this skill:

| Source | Rows | What happened |
|---|---|---|
| Clay's company-enrichment function (LinkedIn) | 8 food-and-drink domains + 1 invented domain | 8 of 8 hits echoed the input domain; the invented domain came back `complete` with an empty result; 0 credits |
| Homepage read, reader defaults | 5 of the same domains | LinkedIn found on **0 of 5**; two pages (3.5 KB and 95 KB) with no social link at all |
| Homepage read, footer kept | the same 5 | LinkedIn on **5 of 5**, all agreeing with the enrichment URL; 5 of 5 had Facebook or Instagram; one had all six platforms but X |
| Site-restricted search for a missing platform | 2 platform gaps | 10 results, **0 profiles**: tag pages, discover pages, a stranger's post, review videos |

Three consequences. **An empty result means nothing until you know the page was read in full**, so
the reader setting is checked in Step 3 and a thin page is its own status. **Two independent sources
agreeing is the check that found this build's only extraction bug**: the homepage pattern cut a
LinkedIn slug at an apostrophe (`honey-mama's` became `honey-mama`) and the enrichment URL disagreed;
the pattern is fixed and a disagreement is now reported, not resolved silently. **Search is a last
resort that must be verified**, because on the rows tried it returned nothing usable, and the source
playbook measured search returning a different company's page at position three.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and if an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The list** | company domains, with company names if they have them (a CSV, table, or pasted) | no default — there is nothing to resolve |
| **Platforms** | which of LinkedIn, X, Facebook, Instagram, YouTube, TikTok they need | ask; LinkedIn-only runs need no page read and cost nothing |
| **Page-read arm** | Clay's page scraper (credits) or a page reader on their own connected account | ask at Step 4 with both priced; without either, only LinkedIn is resolved |
| **Search fill** | whether to search for platforms the homepage did not link | default no; empty stays empty |
| **Empty-LinkedIn policy** | for a LinkedIn-dependent campaign: exclude rows with no LinkedIn, or keep them | ask; it is their campaign's call. Exclude is the source playbook's default and using it must be stated |

If an answer sheet sits beside this skill, load it and ask only for what it does not cover, and say
which values came from it. With no sheet, say nothing about sheets. At delivery, offer to save the
answers (identifiers only, never a token), private and never published.

## What this skill touches

- **Reads** — your list; Clay's company-enrichment records for those domains; each company's public
  homepage; public search results when search fill is on; the Clay action catalogue and routine costs.
- **Writes** — one draft workflow in your Clay workspace, named `social-link-finding page read (safe to
  delete)`, created only when the installer approves a page read; never published; holds run logs only. Nothing to
  a CRM or a table.
- **Never** — builds a handle from the domain name, takes an X account from search, checks a profile
  by fetching it, overwrites a URL you already hold, publishes or deletes a workflow.
- **Halts** — Step 4 write-approval, Step 4 spend-approval, Step 5 sample-review, Step 5 spend-approval.

## Step 0 — Check the platform, and say where the work runs

Run `clay whoami` and `clay --version`. If either fails, report which one, the version required, and
the one command that fixes it, and stop. Do not install or upgrade anything.

Pull the live facts, free, never from memory:

```
clay routines list --limit 100 | jq '.data[] | select(.name=="Enrich Company") | .id'
clay routines get ROUTINE_ID          # inputSchema property names; estimatedCreditCost.perRun
clay workflows actions list > actions.json
jq '.data[] | select(.actionKey=="scrape-website" or .actionKey=="apify-run-actor") | {actionKey, packageId, creditCost, paymentType, accounts: (.availableAppAccounts|length)}' actions.json
clay workflows actions schema PACKAGE_ID scrape-website --include-options    # outputFields must list socialLinks
```

| Job | Expected (read live 2026-09-23) | Cost read then | Output used |
|---|---|---|---|
| company LinkedIn by domain | managed function "Enrich Company", input `Company Identifier` | `perRun: 0` | `url`, echo `domain` and `website` |
| read the homepage (Clay arm) | `scrape-website`, Clay utility package, `outputFields: socialLinks, links` | 1 credit per page | social links, anchors |
| read the homepage (own-account arm) | `apify-run-actor` (bring your own account), page-reader actor | 0 Clay credits; their account bills | markdown with inline links |
| fill a gap by search (optional) | the same bring-your-own action, a Google search actor | 0 Clay credits; their account bills | organic results |

**If "Enrich Company" is missing from the routine list or its cost is not 0, say so and ask before
using any paid LinkedIn arm; never substitute silently.** A LinkedIn lookup arm in the catalogue costs
1 to 10 credits and several need a name rather than a domain.

Where the work runs: LinkedIn resolves through a managed Clay function; a page read runs in a Clay
workflow; pattern matching and canonical URLs are deterministic Python inside it; you, the agent,
compare sources and judge search candidates. Say this, with the Writes line, in one sentence.

Do not start a step before the steps above it have their answers. If a declared input is missing, ask
for it — never assume a default and continue.

## Step 1 — Collect the definition

Ask which platforms they need and whether search fill is wanted. If they need LinkedIn only, say that
Steps 3 to 6 reduce to one free function call per domain.

## Step 2 — Decide what each cell can say

Per platform per row, one source label, no sixth, first match wins:

1. `site` — the homepage linked it (best match on a fully read page).
2. `enrichment` — LinkedIn only, from the enrichment function, echo matched. When `site` also found a
   LinkedIn URL and the two differ, the cell is `conflict`: both URLs are reported, neither is used.
3. `search_verified` — found by search and passed `references/ownership-rules.md`. Never X.
4. `empty` — the page was read in full, the enrichment had nothing (LinkedIn), search (if on) had no
   owned profile. A real answer.
5. `not_looked` — the page was `thin`, `blocked` or `unreadable` and no other source answered. Not an
   answer; never shown as "no account".

## Step 3 — Free checks first

- Normalize and dedupe the domains; drop anything that is not a bare host and say how many.
- Run the enrichment function on every domain in batches of up to 100 items (`clay routines runs
  start ROUTINE_ID --input '{"items":[{"id":"r1","inputs":{"Company Identifier":"northwind-example.com"}}]}'`,
  then poll `clay routines runs get RUN_ID` until `.status` is not `in_progress`; results sit at
  `.data[i].result["Enrich Company"]`). Apply the echo check. This alone answers LinkedIn, free.
- If the installer already holds URLs for some rows, keep them; this skill fills blanks and reports
  disagreements, it does not overwrite.
- **Check the page-reader setting before any page read.** A reader that returns readable content
  strips nav and footer by default; `scripts/build_page_read_node.py` overrides it. If the installer
  uses a different reader, confirm it returns footer links, on one row you can see, before the batch.

## Step 4 — Build the page read, then a 10-row batch

Ask once, with the free enrichment result for the whole list already in hand: *"LinkedIn is resolved
for N of M rows at no cost. To find the other platforms I'll create one draft workflow in your
workspace called `social-link-finding page read (safe to delete)` and read ten homepages through it,
which costs PRICE on the arm you chose. OK?"* Wait for the answer; it is the write and the batch
spend in one question.

Build the workflow from `references/page-read-workflow.md` (code in
`scripts/build_page_read_node.py` and `scripts/extract_socials_node.py`) and run ten rows. Compare
every `site` LinkedIn with the enrichment URL. For any row that came back `empty` on every platform,
read its page output yourself to confirm the footer is there.

## Step 5 — ONE gate: the batch, the cost, the writes, the ask

One message: the ten rows as the table below, the count per source label, every `conflict` and every
`thin` page; the price of the full page read (per page on the chosen arm, times the rows still missing
a wanted platform) and of search fill if they want it (one search per missing platform per row, X
excluded); what gets written (nothing beyond the draft workflow); and the ask: run the rest, switch
arm, or stop. Then wait.

## Step 6 — Run, compare, fill

Run the remaining rows at a modest concurrency (six at once was clean in the build). For each empty
wanted platform, if search fill is on: query `site:PLATFORM_HOST "Company Name"` with the company's
real name (never the domain as a name), keep only results matching the platform's profile pattern
(the same patterns as the Extract code), and judge each survivor with
`references/ownership-rules.md`. X is never filled by search.

## Step 7 — Deliver

One row per domain: six URL columns (canonical form, or empty), a source label per cell, the page
status, and any conflict with both URLs. Then the coverage line per platform. Apply the empty-LinkedIn
policy the installer chose. Offer to save the answers.

## Representative output

### Resolved profiles

| Domain | LinkedIn | Instagram | Facebook | TikTok | X | YouTube | Page |
|---|---|---|---|---|---|---|---|
| northwind-coffee.com | linkedin.com/company/northwind-coffee (site + enrichment) | instagram.com/drinknorthwind (site) | facebook.com/northwindcoffee (site) | tiktok.com/@drinknorthwind (site) | — (empty) | youtube.com/@northwindcoffee (site) | read |
| contoso-seafood.com | linkedin.com/company/contososeafood (site + enrichment) | instagram.com/contososeafood (site) | facebook.com/wearecontoso (site) | — (empty) | x.com/contososeafood (site) | — (empty) | read |
| fabrikam-foods.com | linkedin.com/company/fabrikam (enrichment) | — (not_looked) | — (not_looked) | — (not_looked) | — (not_looked) | — (not_looked) | blocked |

### Coverage line

120 domains · LinkedIn 111 (104 site + enrichment agreeing, 7 enrichment only) plus 1 conflict held back · Instagram 71 · Facebook 66 · TikTok 19 · X 23 · YouTube 30 · 9 pages not read (6 blocked, 3 thin) · 0 search fills accepted.

## What this skill does not claim

- Nine domains through the enrichment function and six through the page read were run live on one day; the coverage above is that sample, not a benchmark.
- Clay's own page scraper (1 credit per page, read live 2026-09-23) was not run in this build; only the own-account page reader was, and its per-page price was not read.
- An `empty` platform means the company's homepage does not link one and nothing verified was found; it does not prove the company has no account.
- The ownership judgment on search candidates was exercised on 10 candidates across two platforms, all correctly rejected; no search candidate was accepted in this build.
- Profile URLs are not checked for liveness, because the networks answer anonymous requests identically for real and missing pages.
- The enrichment function's LinkedIn is the company record's claim; it is used alone only when the homepage could not be read or did not link one.

## What good looks like

A good run is a sheet another job can scrape without a human re-checking it. Every URL is canonical,
every cell says where it came from, most LinkedIn cells read "site + enrichment agreeing", and
the rows that could not be read are labelled `not_looked` rather than blank. Conflicts are few, named,
and held back. Search contributed little or nothing, and that is normal.

A thin or failed run is easy to spot. Whole columns empty across rows whose pages are tens of
kilobytes long (the reader stripped the footer). LinkedIn URLs that differ from the enrichment record
with no conflict flag. Handles that look like the domain name with no source. An X account that came
from search. Or a profile URL pointing at a post, a tag page or a video instead of a profile.

## Rules

- MUST read the company's own page before calling any platform empty; a thin, blocked or unreadable page is `not_looked`.
- MUST keep the reader's nav and footer; NEVER trust an empty result from a reader on default content-extraction settings.
- MUST take the best match on the page (count plus footer position), never the first.
- MUST compare the page's LinkedIn with the enrichment record and hold back a disagreement as `conflict`.
- MUST apply the enrichment echo check; NEVER use an enrichment URL whose domain does not match.
- MUST verify every search candidate for ownership; NEVER take X from search.
- MUST build canonical URLs in code; NEVER retype or "clean up" a URL by hand.
- NEVER construct a handle from the domain name, and never fetch a profile to test it.
- NEVER overwrite a URL the installer already holds; report the difference instead.

## Worked example

Asked: *"Get me LinkedIn, Instagram and TikTok for these eight food brands; we're running a LinkedIn
engagement play, so drop anyone without a LinkedIn page."*

Declared: platforms LinkedIn, Instagram, TikTok; page read on their own reader account; search fill
off; empty-LinkedIn policy **exclude**.

Step 3, free: the enrichment function returned a LinkedIn URL for 8 of 8, each echoing the input
domain (0 credits). Step 4 batch, page read with the footer kept, five rows:

| Brand (as returned) | LinkedIn | Instagram | TikTok | Label |
|---|---|---|---|---|
| a truffle-bar maker | `/company/honey-mama's` | site | — | site + enrichment agree (after the apostrophe fix; before it, `conflict`) |
| a seafood brand | `/company/oshiseafood` | site | — | site + enrichment agree |
| a coffee brand | `/company/we-are-happy-products` | site | site | site + enrichment agree |
| a cultivated-seafood startup | `/company/bluenalu` | site | — | site + enrichment agree |
| a farm brand | `/company/earthsidefarms` | site | — | site + enrichment agree |

Delivered all eight with LinkedIn (none excluded), Instagram on the five read pages, TikTok on one;
the three unread pages are `not_looked` for Instagram and TikTok, stated at the top: *three rows were
not page-read in the batch; their Instagram and TikTok cells are unknown, not absent.*
