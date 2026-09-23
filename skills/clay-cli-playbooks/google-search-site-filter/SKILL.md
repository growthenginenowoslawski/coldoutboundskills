---
name: google-search-site-filter
description: |
  Check whether each company's own website says a specific phrase (a certification, a program, a
  service line, a location), one site-restricted web search per domain and phrase, keep only results
  on the company's own pages that literally contain the phrase, and judge whether the company is
  claiming it about itself. Returns a filter flag, a status (has, planned, discusses, none), an
  evidence URL, and an optional pre-rendered sentence that is blank unless the claim is solid. Use
  whenever someone asks: does their site mention X, site: search, find which of these companies say
  SOC 2 on their website, filter my list by a keyword on their site, do they talk about HIPAA, check
  if they offer X, google search enrichment. The same query returned nothing and then ten results
  minutes apart, and Google ignored the quotes on another row, so every empty answer is retried once
  and every hit must contain the phrase literally. Do NOT use it to find new companies (company
  search), to confirm what software a site runs (tech-on-website), to find social profiles
  (social-link-finding), or for anything time-sensitive like a funding date.
---

# Google site filter (one phrase, one query, and the phrase must be on the page)

The insight: **a site-restricted search result is not evidence until the phrase is literally in it,
the page is the company's own, and the company is talking about itself.** Each of those three failed
on real rows, and the search itself is not stable enough to trust one empty answer. Measured
2026-09-23 through Clay, `site:DOMAIN "SOC 2"`, one result page per call:

| What happened | Rows | Consequence |
|---|---|---|
| Same query, minutes apart, **empty then full** | 1 SaaS domain returned 0, 0, 10, 10 on four runs; another returned 0 then 10 | one empty answer is not a negative; retry once, and even two empties mean "not found", never "does not" |
| **Quotes ignored** | one domain returned 10 on-domain pages, none containing the phrase | the raw hit count is never the filter; the literal check is |
| On-domain but **not the company speaking** | one domain's only matches were two job posts on its jobs subdomain; another returned a staging copy of its site | forum, status, job and staging hosts are dropped before judging |
| Off-domain result inside a site-restricted search | 1 of 10 results on another row | host is checked, not assumed |

The source playbook measured the rest a month earlier on another search provider and it transfers
unchanged: an OR-chain of seven phrases cut precision from 100% to 40% on one row and from 80% to 20%
on another, and destroyed attribution; a sales-software company had seven on-domain pages literally
saying "SOC 2", every one an example cold email in its own template library, which produced a
fabricated compliance claim about that company until the usable gate below existed.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and if an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The list** | company domains (CSV, table, or pasted), with company names if they have them | no default — there is nothing to check |
| **The phrase** | one exact phrase for the whole run | no default. Two phrases are two runs, never one query |
| **Web search account** | a hosted search scraper connected to Clay as a bring-your-own account | no default and no equivalent free Clay action; the reduced mode in Step 3 is the only fallback |
| **Row policy** | segment (only usable rows go to the campaign) or keep all rows with a blank sentence where unusable | ask; segmenting is the safer default when the phrase is the campaign premise, and using it must be stated |
| **Copy wanted** | whether to write the line and sentence at all | default no; the filter flag and evidence URL are the deliverable |

If an answer sheet sits beside this skill, load it and ask only for what it does not cover, and say
which values came from it. With no sheet, say nothing about sheets. At delivery, offer to save the
answers (identifiers only, never a token), private and never published.

## What this skill touches

- **Reads** — your list, one web search per domain per attempt on your connected search account, and
  the Clay action catalogue.
- **Writes** — one draft workflow in your Clay workspace, named `site-keyword search (safe to delete)`,
  never published, holding only run logs. Nothing to a CRM, a table or a sequence.
- **Never** — sends an OR-chained query, publishes or deletes a workflow, writes a line for a row that
  is not usable, or reports an empty search as proof that a company does not do something.
- **Halts** — Step 4 write-approval, Step 4 spend-approval, Step 5 sample-review, Step 5 spend-approval.
- **Vendor-specific** — a hosted web-search scraper on the installer's own account, run through Clay's
  bring-your-own-account action (measured with Apify's Google search actor). Clay's catalogue has no
  web-search action of its own; without an account only the reduced mode in Step 3 runs.

## Step 0 — Check the platform, and say where the work runs

Run `clay whoami` and `clay --version`. If either fails, report which one, the version required, and
the one command that fixes it, and stop. Do not install or upgrade anything.

Pull the live facts, free, never from memory:

```
clay workflows actions list > actions.json
jq '.data[] | select(.actionKey=="apify-run-actor") | {packageId, paymentType, creditCost, n: (.availableAppAccounts|length)}' actions.json
clay workflows actions schema PACKAGE_ID apify-run-actor
jq '.data[] | select(.actionKey=="get-sitemap" or .actionKey=="scrape-website") | {actionKey, packageId, creditCost}' actions.json
jq -r '.data[] | select((.actionKey // "") | test("google|serp|search"; "i")) | [.actionKey, .creditCost] | @tsv' actions.json
```

| Job | Expected (read live 2026-09-23) | Cost | Output used |
|---|---|---|---|
| run one site-restricted web search | `apify-run-actor` (bring your own account), actor `apify/google-search-scraper` | 0 Clay credits; the search account bills per search at its own rate, which this build did not read | `result.results[0].organicResults[]` |
| list sitemap pages by path word (reduced mode) | `get-sitemap`, Clay utility package | free | `result.links[]` |
| read a page's text (reduced mode) | `scrape-website`, Clay utility package | 1 credit per page | `bodyText` |

**If the bring-your-own search action is missing or has no connected account, say so and offer the
reduced mode; never substitute a news search or any other search that is not site-restricted.** The
catalogue's search-shaped actions on the day of the build were a news search (1 credit), a
contact search, an email search, an AI-search-visibility report, and two social-profile searches;
none of them runs a `site:` query.

Where the work runs: the search runs on the installer's scraper account through a Clay workflow; the
literal and host checks are deterministic Python inside it; you, the agent, judge the candidates and
write any line. Say this, with the Writes line, in one sentence.

Do not start a step before the steps above it have their answers. If a declared input is missing, ask
for it — never assume a default and continue.

## Step 1 — Collect the definition

Ask for the list and the phrase. If the installer gives more than one phrase, say plainly that each
is its own run and its own column, because one query for several phrases measured at 40% precision and
cannot say which phrase matched. If the phrase is a date, a launch or a funding event, stop: search
snippets can be months old and this skill carries no date check.

## Step 2 — Decide what an answer is

Per row, five values, no sixth, first match wins:

1. `input_invalid` — the domain does not normalize to a bare host, or the phrase contains OR, AND or
   a pipe. Decided before any search.
2. `search_error` — the search node errored or returned an error page. Re-run; never an answer.
3. `usable` — a candidate survives the literal and host checks and your judgment gives `status: has`
   and `confidence: high` (rules in `references/judge-rules.md`).
4. `mentioned_not_usable` — the company mentions it, but as planned, discussed, or with low
   confidence. A fine filter answer; never copy.
5. `not_found` — after one retry, no candidate survived (`no_results` twice, `no_literal_match`, or
   `no_company_pages`). Means "not found in the index today", never "does not".

## Step 3 — Free checks before anything is billed

Normalize and dedupe domains, and dedupe on `(domain, phrase)`. Mark `input_invalid` rows and drop
them. Read five to ten of the domains yourself and say which you expect to hit and which to miss; if
you expect every row to hit, the phrase is too generic to filter on, and say so now.

**Reduced mode, when there is no search account:** for each domain run `get-sitemap` with a path word
that fits the phrase (`security` for a certification), then read the listed pages with the paid page
scraper and apply the same literal check to `bodyText`. It finds only what the sitemap exposes;
measured, one of two domains had no sitemap pages at all. Price it per page before the gate.

## Step 4 — Build the workflow, then a 10-row batch

Ask once: *"I'll create one draft workflow in your workspace called `site-keyword search (safe to
delete)`, and run ten rows through it, which is ten to twenty searches on your connected search
account. OK?"* Wait for the answer.

Build it exactly as `references/search-workflow.md` lays out, with the code in
`scripts/build_query_node.py` and `scripts/literal_filter_node.py`. Run ten rows with
`clay workflows runs test`, read the first result before the rest, and re-run every `no_results` row
once. Then judge each row's candidates yourself with `references/judge-rules.md`.

## Step 5 — ONE gate: the batch, the cost, the writes, the ask

One message: the ten rows as the verdict table below, with the count per value and the retries that
changed an answer; the cost of the full run (0 Clay credits; about 1.3 searches per row on their
account, counting retries, at their account's rate); what gets written (nothing beyond the draft
workflow); and the ask: run the rest, change the phrase, or stop. If more than half the batch came
back `usable`, say the phrase may be too generic to filter on. Then stop and wait.

## Step 6 — Run and judge

Loop the remaining rows at a modest concurrency (six at once ran clean in the build). Re-run each
`no_results` and `search_error` row once. Judge every row with candidates. Keep the evidence URL for
every `usable` and `mentioned_not_usable` row, so any claim a prospect challenges can be checked in one
click.

## Step 7 — Deliver

Per row: domain, phrase, value, status, confidence, evidence URL, and, only when copy was requested
and the row is `usable`, the line and the pre-rendered sentence. Then the coverage line. Apply the row
policy: segmenting means only `usable` rows go forward; keep-all means the sentence field is the one
placed in the email, alone, so blanks render as nothing.

**Before any sentence goes into a live campaign, read 20 rendered samples** (or all of them, if fewer)
in the real frame. If more than one needs an edit, do not ship: fix the lines and read a fresh set.
The source playbook measured about 1 in 6 gate-passing lines needing a human edit.

## Representative output

### Row verdicts

| Domain | Phrase | Value | Status | Evidence | Sentence |
|---|---|---|---|---|---|
| northwind-analytics.com | SOC 2 | usable | has / high | trust.northwind-analytics.com | `Noticed you hold a SOC 2 Type II report. ` |
| contoso-cloud.io | SOC 2 | mentioned_not_usable | planned / high | contoso-cloud.io/roadmap | (blank) |
| fabrikam-labs.com | SOC 2 | not_found | none | — (empty twice) | (blank) |
| tailspin-hr.com | SOC 2 | not_found | none | — (10 results, none with the phrase) | (blank) |

### Coverage line

60 domains in · 2 input_invalid dropped · 58 searched (76 searches with retries) · 21 usable, 6 mentioned_not_usable, 31 not_found (not proof of absence) · 0 search_error · 0 Clay credits.

## What this skill does not claim

- Six real rows from Clay search plus four spot rows were run live on one day; the rates above are that sample.
- The search account's per-search price was not read; this skill reports search counts, and the installer's account turns them into money.
- A `not_found` row is not evidence that the company lacks the thing; the index is incomplete and was measured unstable between identical calls.
- The reduced mode's page-reading step was not live-run (it needs 1 credit per page, read live 2026-09-23); only its sitemap step was.
- Search snippets can be stale, so a `usable` claim describes what the company's page said when it was indexed.
- Line quality was judged on four usable rows in this build; the 1-in-6 edit rate is the source playbook's measurement, not a new one.

## What good looks like

A good run reads like an audit trail. Every `usable` row carries an evidence URL on the company's own
host, a snippet containing the phrase, and a line that states only what that snippet says. Every
`not_found` row says whether it was empty twice, had no literal match, or had only non-company pages,
and nobody reading the output mistakes it for "no". The count of `usable` rows is well under the count
of rows searched: most companies do not mention most phrases.

A thin or failed run looks like a column of hit counts. The tells: `usable` rows whose evidence is a
blog roundup, a template page or a job post; lines on rows that are `planned` or low-confidence; a row
marked `not_found` after a single empty search; the whole batch `usable` (the phrase is too generic);
or several phrases folded into one query to save searches.

## Rules

- MUST send one phrase per query, quoted; NEVER an OR chain or a multi-phrase query.
- MUST require the phrase literally in the title or snippet, after collapsing spaces and hyphens and also accepting the space-free form (`SOC 2`, `soc-2`, `SOC2`).
- MUST drop results off the company's host and on forum, status, help, job, careers and staging hosts before judging.
- MUST retry an empty search once; NEVER report `not_found` as "does not".
- MUST compute `usable` (has and high) before writing any copy; NEVER write a line or sentence for any other row.
- MUST ship the whole pre-rendered sentence or a blank; NEVER rely on spintax to hide an empty variable.
- MUST read 20 rendered sentences before a live campaign uses them.
- MUST treat a search error as a re-run, never as an answer.
- NEVER substitute a news or people search for the site-restricted search.

## Worked example

Asked: *"Which of these AI software companies say they're SOC 2 on their site? I only want to email
the ones that do."*

Declared: phrase `SOC 2`, row policy **segment** (the phrase is the premise), copy requested. Six
domains from a Clay company search (US software, 51-200 staff, description mentions compliance).

Batch through the workflow, 0 Clay credits, 9 searches with retries:

| Row | Search status | Judgment | Value |
|---|---|---|---|
| an AI banking assistant vendor | 7 candidates; one on a staging host (dropped by the host rule after this run) | "our assurance is acknowledged by the SOC 2 Attestation" on its data-compliance page: has / high | usable: `you hold a SOC 2 attestation` |
| an enterprise AI agent vendor | 10 candidates, trust-center pages | "Compliance Reports. SOC 2 Type II" on its trust center: has / high | usable: `you hold a SOC 2 Type II report` |
| a trade-compliance data vendor | 4 candidates | "We are SOC 2 Compliant and GDPR Ready": has / high | usable: `you are SOC 2 compliant` |
| an employee-monitoring vendor | empty, then 10 on the retry | "has achieved ISO 27001:2022 and SOC 2 Type II compliance" in its own knowledge base: has / high | usable: `you achieved SOC 2 Type II compliance` |
| an AI talent marketplace | first run: two job posts only; second run: ten pages, none with the phrase | nothing on a company page | not_found (no_literal_match) |
| a recruiting firm | empty twice | — | not_found (empty twice) |

Delivered four `usable` rows to the campaign, with the statement at the top: *two rows are
not-found-today, not confirmed absent; one flipped from empty to ten results on retry, which is why
every empty row is searched twice.*
