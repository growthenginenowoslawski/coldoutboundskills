---
name: case-study-page
description: |
  Find a prospect company's own case-study, customer-stories or testimonials page on its website,
  pick ONE named customer off it, prove that customer is printed on the page, and hand back a short
  clause that finishes "Saw ..." (for example "your work with Wabtec on model-based digital
  thread"). Free Clay URL probes find the page (ten conventional paths on the canonical host, then
  the sitemap), one page fetch reads it, the agent picks the customer, and a deterministic script
  gates and assembles the line so the model never writes the sentence. Use whenever someone asks:
  who are their customers, do they have a case studies page, name-drop one of their clients, saw
  your work with X, what logos are on their site, find a customer story for my first line. Do NOT
  use it to read their pricing or plans (pricing-page), to write a three-idea email body
  (creative-ideas), or to detect the software a site runs (a tech-stack skill).
---

# Case-study page name-drop (find the page free, prove the name, let code write the line)

The insight: **a 200 response is not a page, and a name on the page is not a customer.** Both
halves were measured live on 2026-09-23.

- **Status codes lie about existence.** Clay's URL checker follows redirects and reports the
  *final* status, so a path that redirects to a 404 page or to the homepage reads `200`. Measured:
  `palantir.com/pricing` → 200 at `/404`; `anaplan.com/pricing` → 200 at `/contact/`; on two of
  eight real software companies, four or five of five probed paths read 200 and landed on `/`. Only the final URL tells
  you. And **a bare host that redirects to `www.` can drop the path entirely**: `gingrapp.com/pricing`
  landed on `www.gingrapp.com/` while `www.gingrapp.com/pricing` was a real page. Resolving the
  canonical host first fixed that class.
- **The page names companies that are not customers.** A live customers page opened with a keynote
  banner naming three speaker companies; a testimonials page quoted a customer bragging about *its
  own* clients ("including big names like TikTok"). The verbatim gates prove a string is on the
  page, never that it is a customer. So the agent picks, and a script refuses anything it cannot
  prove.

What follows: the page is found with free probes that read the final URL, the text is fetched once
per found page, and the line is assembled by `scripts/case_study_gates.py`, not written by a model.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it,
never substitute a plausible default, and if an answer does not exist say which step becomes
unavailable rather than guessing. Where a default IS defensible it is named below, and using it
means saying so in the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The accounts** | a list of company domains, or a Clay company search whose rows carry `domain` | no default — there is nothing to look up |
| **Page-fetch arm** | which action reads the found page: Clay's static scrape action (Clay credits), or an actor-runner on their own connected scraping account (no Clay credits, their vendor bills) | ask; with neither available, Steps 1 to 3 still run and deliver URLs only, no lines |
| **Low-confidence policy** | whether a bare logo with no story may ship | default **hold**: `confidence = low` rows are returned with `ship_ready = false`. Say the default was used |
| **Where results go** | a file or table the installer names | default is a CSV handed back in the conversation; this skill writes nowhere else |

If an answer sheet is present beside this skill, load it, **say which values came from it**, and ask
only for what it does not cover. If there is no sheet, say nothing about sheets. At delivery, offer:
*"want me to save your answers to a file, so the next person on your team doesn't have to answer
these again?"* — identifiers only, never a token.

## What this skill touches

- **Reads** — the domains you supply, the public web pages at those domains (through Clay URL and
  sitemap actions and one page fetch per found page), and the Clay action catalogue.
- **Writes** — nothing to any system of yours. It creates one clearly labelled test workflow in
  your Clay workspace to run the free probes, and hands results back as a file. You can delete the
  workflow after.
- **Never** — writes to a CRM or sequencer, sends an email, clears a field, or lets a model write
  the finished sentence. Your list's domains go only to Clay and to the page-fetch arm you chose.
- **Halts** — Step 4 `sample-review`, Step 4 `spend-approval`.

## Step 0 — Check the platform, and say where the work runs

Run `clay whoami; clay --version`. If it fails, say which component is wrong and the one command
that fixes it, and stop. Do not install or upgrade anything to repair it.

Then confirm every action this skill names against the live catalogue, free, and never from memory:

```
clay workflows actions list > actions.json
clay workflows actions schema <packageId> <actionKey>
```

| Job | Expected `(package, actionKey)` | Declared cost (read live 2026-09-23) | Field read |
|---|---|---|---|
| final status of a URL | Clay utilities `check-url` | no `creditCost`; one action execution | `result.statusCode` |
| final URL after redirects | Clay Scrapers `get-page-redirect` | no `creditCost` | `result.redirectLink` (empty `result` = no redirect) |
| sitemap discovery | Clay utilities `get-sitemap` | no `creditCost` | `result.links[]` |
| page text, Clay-billed arm | Clay utilities `scrape-website` | `creditCost` 1 per page | `bodyText` |
| page text, own-account arm | an actor-runner whose `paymentType` is Bring Your Own Account | no Clay credits; the installer's vendor bills | the actor's text field and its own final-URL field |

Match on the pair `(packageId, actionKey)` and record the `packageId` you resolved. **If a named
action is absent, say so and stop that step.** Never substitute the nearest-looking action.

Tell the installer before anything runs: *"The probes and the sitemap run inside one test workflow
in your Clay workspace and cost no Clay credits. The page read is the only step that bills, once
per found page, on the arm you chose. Picking the customer and building the line happen here in
the conversation, free. Nothing is written to your systems."*

Do not start a step before the steps above it have their answers. If a declared input is missing,
ask for it — never assume a default and continue.

## Step 1 — Collect the inputs

Ask for the accounts and the page-fetch arm. Normalise each domain to a bare lowercase host (no
scheme, no path, no trailing slash); a scheme left in gets doubled when the path is appended and
every probe misses. If the rows came from a Clay company search, the `domain` field is already bare, but
**check the search row's name against the domain** — one real search row paired a manufacturer
with a link-in-bio domain, and everything downstream would have described the wrong company.

## Step 2 — Build the probe workflow once

Create one labelled workflow (`clay workflows create --name "case-study probe (safe to delete)"`)
with a manual trigger taking `domain`, then a strictly linear chain (a node with two incoming edges
is a join and deadlocks). Node shapes and pins are in `references/workflow-build.md`.

1. **Canonical host.** `get-page-redirect` on the bare domain (it accepts one), then a code node that
   keeps the redirect's host only when it is the same site (bare ↔ `www.`), else the bare domain,
   and emits `base` = scheme plus that host.
2. **Ten candidate paths on `{{base}}`**, in this order, each as `check-url` followed by
   `get-page-redirect`: `/customers`, `/case-studies`, `/customer-stories`, `/success-stories`,
   `/case-study`, `/clients`, `/our-work`, `/portfolio`, `/testimonials`, `/stories`. All ten: one
   real hit in the test came from `/testimonials`, the ninth.

Run one test run per domain (`clay workflows runs test <wf> --inputs '{"domain":"…"}'`), then read
`clay workflows runs steps <wf> <runId>`. Completion status is not data: read each node's
`stepOutputs`.

## Step 3 — Decide the page, free, in a stated order

For each domain, walk the ten paths in order; the first that passes all three wins:

1. `statusCode` is 2xx.
2. The final URL (`redirectLink` if present, else the probed URL) has a path other than `/`.
3. That final path still looks like a customer page (`customer`, `case-stud`, `success`, `client`,
   `our-work`, `portfolio`, `testimonial`, `stor`).

If no path passes, run the sitemap fallback: `get-sitemap` with `keywords` as a **JSON array**
(`["customers","case-stud","customer-stor","success-stor","testimonial"]`). Measured: the same
keywords as one comma-separated string returned **0 links** on a site whose sitemap held 300
matches; the array returned them. From the links, drop `/blog/`, `/news/`, `/press`, form and
author pages, prefer a listing page (`/case-studies`, `/customer-stories`) over a single story, and
take the shortest. **On a giant sitemap the action times out** (`ERROR_TIMEOUT` after about 110 s,
measured) — record `sitemap_timeout`, which is not a miss.

Verdict for this step, first match wins: `page_found`, `sitemap_timeout`, `no_page_found`.

## Step 4 — Ten rows, then ONE gate: the batch, the cost, the writes, the ask

Run Steps 2 to 6 on ten rows first, on the arm the installer chose, and show all of it in one
message: the ten lines or abstains with their evidence quotes, the found-page rate, what the full
run will cost (pages found × the arm's per-page cost; `scrape-website` reads 1 credit per page,
an own-account actor bills the installer's vendor and zero Clay credits), and that nothing is
written anywhere except the file handed back. Then ask, and wait. Stop again only if the batch
shows something nobody anticipated.

## Step 5 — Read the page, once, and gate what was served

Fetch each found page with the chosen arm. **Check what was served before reading it:** if the
arm reports a final URL at the site root or on a different path class, or a failed request, the
row becomes `unreadable` — measured, a sitemap URL that looked right redirected to the homepage at
fetch time, and a request to a dead domain came back as run status "completed" with an empty body.
`scrape-website` is documented to swallow HTTP status and serve a soft-404 as data, so on that arm
the Step 3 probe is the only status you have. Keep image alt text as `[logo: Name]`; under about
200 characters of text is `unreadable`.

## Step 6 — Pick one customer, then let the script decide

You, the agent, read the page and return exactly this JSON, nothing else:

```
{"client_name": "...", "evidence_quote": "...", "detail_phrase": "...", "confidence": "high|low"}
```

- `client_name` — ONE customer company, spelled as the page spells it. Never the page owner, a
  partner, an investor, a press outlet, an event speaker, a person's name, or **a company another
  customer names as its own client** (on a testimonial, "we converted TikTok" makes TikTok the
  testimonial-giver's customer, not the page owner's). Prefer the customer with the clearest story.
- `evidence_quote` — 4 to 20 words copied character for character from the page, containing
  `client_name`. A title/company attribution line (`CEO, Leadbird`) is valid evidence.
- `detail_phrase` — 2 to 5 words naming the topic, every word inside the quote; a noun phrase,
  never a sentence fragment ("time back"), never the customer's name. Empty is a good answer.
- `confidence` — `high` when the page presents a story or a quote from that customer, `low` for a
  bare logo.
- If the page names no customer company (anonymised stories like "Fortune 500 Bank"), return all
  fields empty. That is a correct abstain, not a failure.

Save the page text and the pick, then run
`python3 scripts/case_study_gates.py --domain <domain> --page page.txt --pick pick.json`. It
enforces five gates — name on page, full quote on page, quote contains name, not a placeholder or
generic noun, not only in investor/press/partner/event wording — drops an ungrounded detail, and
builds `your work with <Name>[ on <detail>]`, 16 words max. A failed gate is an abstain with a
`reject_reason`; retry the pick once with a different customer, never loosen the gate.

Row verdicts, five values, first match wins: `sitemap_timeout`, `no_page_found`, `unreadable`,
`abstain` (page read, no provable customer), `line`.

## Step 7 — Deliver

One row per domain: `domain`, `case_study_url`, `verdict`, `case_study_line`, `client_name`,
`evidence_quote`, `confidence`, `ship_ready`, `reject_reason`. Then a coverage line and the spend
actually reported by the runs (`dataCreditsUsed` per run; the own-account arm's vendor charge is
theirs to read). State that low-confidence rows were held under the default, if it was used.

## Representative output

### Case-study lines

| domain | case_study_url | verdict | case_study_line | evidence_quote | confidence | ship_ready |
|---|---|---|---|---|---|---|
| northwind.example | https://www.northwind.example/customers | line | your work with Contoso on fleet maintenance | How Contoso cut fleet maintenance costs with Northwind | high | true |
| fabrikam.example | https://fabrikam.example/testimonials | line | your work with Tailspin Toys | Priya Raman, COO, Tailspin Toys | high | true |
| adatum.example | https://adatum.example/case-studies | abstain | | | | false |
| litware.example | | no_page_found | | | | false |

### Coverage line

40 domains · 31 pages found (27 by path, 4 by sitemap) · 1 sitemap timeout · 24 lines, 21 ship-ready,
3 held at low confidence · 5 abstains with reasons · 0 Clay credits on probes, 31 page reads billed.

## What this skill does not claim

- Tested live on 12 real domains on 2026-09-23; that is a smoke test of the mechanism, not a coverage benchmark for any segment.
- The gates prove a name is printed on the page, not that the company is a customer; the placeholder and non-customer-context checks are heuristics that reject, they cannot confirm.
- The Clay-billed page arm (`scrape-website`, 1 credit per page) was not live-run for this skill because the test workspace had no credits; its schema and cost were read live and its soft-404 behaviour is taken from the Clay skill kit's own measurement.
- The canonical-host step was verified on the domains in the test, not on sites that redirect by geography or language.
- Customer picks were made by the agent that ran the test; a different agent may pick a different, equally valid customer from the same page.

## What good looks like

A good run reads like evidence: every shipped line has a URL you can open and a quote you can
find on that page with Ctrl-F, the customer is plainly a customer (a story, a quote, a named case
study), and the rows without a line each say why — `no_page_found`, `sitemap_timeout`,
`unreadable`, or an abstain with a gate name. Coverage near two thirds on B2B software is normal;
it is lower on trades and consumer brands, and that is the page not existing, not the skill
failing.

A thin or broken run looks different: many `page_found` rows whose URL is the homepage (the
final-URL check was skipped), sitemap misses on sites that obviously have customer pages (keywords
passed as one string), lines naming a speaker, investor or integration partner, or lines whose
detail is a sentence fragment. Any of those means a step was bypassed, not that the web is noisy.

## Rules

- MUST decide existence on the final URL, never on a status code alone; a path whose final URL is
  `/` or no longer customer-shaped is not a page.
- MUST resolve the canonical host before probing paths.
- MUST pass `get-sitemap` keywords as a JSON array; a comma string silently returns nothing.
- MUST record a sitemap timeout as `sitemap_timeout`, never as a miss.
- MUST check what the fetch actually served (final URL, request status, length) before reading it.
- MUST run every pick through `scripts/case_study_gates.py`; NEVER let a model write the finished
  sentence, and NEVER ship a line the script rejected.
- NEVER name a company that appears only as an investor, press outlet, partner, event speaker, or
  another customer's client.
- NEVER ship `confidence = low` rows unless the installer chose to.
- NEVER write to a CRM, sequencer or any system of the installer's; the output is a file.

## Worked example

Asked: *"find me a customer name-drop for these 40 software accounts."* The installer chooses the
own-account fetch arm and keeps the low-confidence hold.

Step 0 confirms `check-url`, `get-page-redirect`, `get-sitemap` and the actor-runner in the live
catalogue. The probe workflow runs once per domain. For one account the ten paths return 404
except `/testimonials`, which is 200 with a final URL on `www.` — `page_found`. For another, all
ten return 200 but every final URL is `/`: soft-404s, so the sitemap runs with the keyword array
and finds `/blog-category/case-studies`. A third account's sitemap times out at about 110 s:
`sitemap_timeout`.

The ten-row batch goes to the gate with its lines, "31 pages to read, billed on your own account,
zero Clay credits, nothing written but the file", and the installer says go.

On the sitemap-found page the agent reads the headline "Ascend Analytics Helps Austin Energy Gain
Approval for 2035 Resource Plan" and picks Austin Energy, with that headline as the quote and
`2035 resource plan` as the detail. The script passes all five gates and returns
`your work with Austin Energy on 2035 resource plan`, `ship_ready: true`.

On another account's customers page a keynote banner names three speaker companies above the real
stories. Picking a banner speaker returns `non-customer-context` from gate 5 — tried on purpose in
the test — so the agent picks the story instead ("A Google sales team got hours of time back") and
ships `your work with Google`, with no detail because "time back" is a fragment.
