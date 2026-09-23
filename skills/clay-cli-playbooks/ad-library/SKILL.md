---
name: ad-library
description: |
  Find out whether a company is running Facebook and Instagram ads right now and what those ads are
  selling, from the public Meta Ad Library, and write one short grounded clause about it for a first
  line. The hard part is identity: the Ad Library is keyed to a Facebook page, your list is keyed to a
  domain, and an unverified page ships a stranger's ads under your prospect's name, so the skill proves
  the page from the company's own homepage or from ads whose landing page is on the company's domain
  before reading anything. Blank rather than guessed. Use whenever someone asks: are they running ads,
  what are they advertising on Facebook or Instagram, pull their Meta ad copy, who in this list spends on
  paid social, meta ad library for these domains. Do NOT use it to read organic posts (social-posts), to
  find people engaging with posts (linkedin-engagement), or to find alumni connections (warm-intros).
---

# Meta ad library (prove the page, then read the ads)

The insight: **a Facebook page you found by searching a company name is usually somebody else's page,
and the only cheap proof of identity is a link that points home.** Eight consumer and B2B domains,
2026-09-23:

| Route to a page | Rows it verified | What it got wrong or missed |
|---|---|---|
| the company's own homepage links to its page | 1 of 8 | 5 of 8 homepages refused the fetch (403, 429, connection refused) |
| web search `site:facebook.com "Company"` behind slug and title gates | 0 of 6 | returned a design tool, an actor, a football club, three hobbyist pages; every one correctly rejected |
| ad-library keyword search, keeping only ads whose landing page is on the company's domain | 3 of 5 | kept 5 of 8, 6 of 8 and 8 of 8 ads for three brands; rejected ads from insulin-pump clinics, a solar installer and an arthritis supplement that matched the keyword |

The source build this is ported from (Growth Engine X, 2026-08-05) learned the same lesson from the
other side: its name search returned a golfer's page for one domain and a pottery studio for another,
and both were paid for before the gate existed.

Three consequences:

- **Gate on the page slug or the landing domain, never on the page title.** A title is whatever the page
  owner typed; a slug that starts with the domain's label, or an ad whose link lands on the domain, is
  evidence.
- **Keyword search plus a landing-domain check is the rescue, not name search.** It bills per ad, so it
  runs only on rows the free homepage route could not settle, and its proof hands you a page id that a
  one-item page read then counts.
- **A brand whose shop lives on another domain abstains unless you declare that domain.** One soda brand
  ran 7 of 8 ads to a `drink…` domain; checked against its corporate domain it verified nothing. Recall
  lost to a strict gate is the right trade: a wrong page costs the same and writes a confident wrong
  sentence to a stranger.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and if an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The companies** | domains, one per row, and the company name for the keyword rescue | no default |
| **Brand domains** | any other domains a company sends ad traffic to (a shop domain, a product domain) | the corporate domain only; say that brands on other domains will abstain |
| **Country** | the ad-library country to search in keyword mode | ask; `US` is defensible for US lists and must be stated |
| **Keyword rescue** | whether to run the per-ad keyword search on rows the homepage could not settle, and on how many | ask; it bills per ad. Off means those rows abstain |
| **Connected account** | which connected scraping account to bill | ask; never pick one |
| **Volume wording** | whether a line may say "a lot of ads", and above what count | defensible: only above 50, only from a page-mode count; never a number |
| **Write a line?** | yes or no | default yes, since the line is the usual deliverable; the evidence table ships either way |

**If an answer sheet is present beside this skill, load it and ask only for what it does not cover.**
Say which values came from the sheet before using them. If there is no sheet, say nothing about sheets.
At delivery, offer to save the answers (identifiers only, never a token): *"want me to save your answers
to a file, so the next person on your team doesn't have to answer these again?"*

## What this skill touches

- **Reads** — each company's public homepage, the public Meta Ad Library for pages this skill has
  verified, and, only when you turn on the rescue, the ad library's keyword search.
- **Writes** — two scratch workflows in your Clay workspace, named so you can delete them, because these
  actions only run inside a workflow. No table, no CRM, no sequence.
- **Never** — reads ads for a page it has not verified, quotes an ad count, names the company back to
  itself in the line, or states anything the ad text does not say.
- **Halts** — Step 1 other, Step 4 sample-review, Step 4 spend-approval.
- **Vendor-specific** — the ad read runs on a scraping platform account connected to Clay (measured on
  Apify). No such account, no ad read: the free page discovery still runs and reports which rows have a
  verified page. Clay's catalogue has one credit-priced advertising-insights action (9 credits, a
  different aggregate); this skill does not use it.
- **Derived from** — the GEX Meta ad-library playbook (Growth Engine X, live tests 2026-08-04 and
  2026-08-05), ported to the Clay CLI and re-tested 2026-09-23. Not author-confirmed.

## Step 0 — Check the platform works, and say where the work runs

Say this first: *"This reads public homepages and the public Meta Ad Library, and writes two scratch
workflows in your workspace. It sends nothing and writes to no CRM."*

```
clay whoami; echo "exit_code=$?"
clay --version                       # measured on 1.3.0
clay workflows nodes --help
```

If the check fails, name the component, the required version and the one fixing command, and stop.

Pull live and fail loudly if anything is absent:

| Job | Expected (package, actionKey) | Declared cost | Field read |
|---|---|---|---|
| fetch a homepage | Clay utility package, `http-api-v2` | none (no credit price, no connected account) | `$.result`, the HTML string |
| read the ad library | "Apify" `apify-run-actor`, actor `apify/facebook-ads-scraper` | none in credits, `Bring Your Own Account` | `totalCount`, `results[].snapshot.body.text`, `.snapshot.linkUrl`, `.pageName`, `.pageId` |

```
clay workflows actions list > /tmp/actions.json
clay workflows actions schema <packageId> http-api-v2
clay workflows actions schema <packageId> apify-run-actor
```

Read `paymentType` before `creditCost`: the ad read has no credit price, so the honest cost line is
"no Clay credits; your scraping account is billed per page, or per ad in keyword mode, by its vendor".
Where the work runs: page discovery is free; the ad read is the only billed step; the identity gates, the
volume phrase and the line are done in this conversation.

## Step 1 — Collect the definition

Ask for the declared inputs. The keyword rescue and the account change cost, so ask them first.
**Do not start a step before the steps above it have their answers. If a declared input is missing, ask
for it — never assume a default and continue.** Dedupe the list on bare domain before anything runs.

## Step 2 — Route each row by what proves its page

| Row state after Step 3 | Route | Cost |
|---|---|---|
| homepage links to a page whose slug starts with the domain label | page read | one item |
| homepage blocked, no link, or a link that fails the slug gate, and rescue is on | keyword search, then keep only ads landing on a declared brand domain; take their page id | one item per ad (8 per row) |
| same, rescue off | abstain `page_not_found` | free |

Do not route through web name search. It was measured at 0 verified of 6 and is not a step in this
skill.

## Step 3 — Free checks before anything bills

Build workflow A (`references/workflow-recipe.md`) and run every domain through it. It fetches the
homepage and applies the slug gate. Record per row: `verified` with the page URL, `unverified` with the
candidate slugs, `no_link`, or `fetch_blocked` with the status code. On a blocked or empty fetch, try
`/contact` and `/about` once before giving up; they are still free.

What this saves: every row the homepage settles never reaches the per-ad keyword search.

## Step 4 — Ten rows, then one gate

Build workflow B. Run up to ten rows through it: page mode for rows verified in Step 3, keyword mode
(if the installer allowed it) for the rest. Apply Steps 5 and 6 and show:

- the ten rows as they would be delivered, with how each page was proven and every abstain reason;
- the full-run count per mode: pages to read (one item each) and keyword rows (about eight items each),
  and the cost line in the vendor's unit, since there is no Clay credit price;
- what is written: the two scratch workflows only;
- the ask.

Stop and wait. Stop again only if keyword mode would cover far more rows than the installer expected.

## Step 5 — Read the ads, then prove them again

1. **Keyword rows.** Keep an ad only when the host of `snapshot.linkUrl` equals a declared brand domain
   (or a subdomain of one). If no ad survives, the row is `page_not_found`: not "no ads", because the
   keyword may simply not match. If ads survive, they all carry one `pageId`; that page is now verified.
2. **Page count.** For every verified page, read it once in page mode, with the page URL or with
   `view_all_page_id=<pageId>` for pages proven by keyword. Keep `totalCount` for the volume rule only.
3. **Usable ads.** Drop ads whose body or title is only a template token (a double-brace product field),
   brand films with no product or offer, and ads with no text. If nothing is left, `template_only`.

A vendor error is a retry, never a verdict.

## Step 6 — Verdict per row, and the line

Seven values, no eighth, first match wins:

1. `fetch_blocked` — homepage refused and rescue off.
2. `page_not_found` — no page proven by either route.
3. `unverified_page` — a candidate page exists but failed the gate; list the slugs for a human.
4. `no_active_ads` — a verified page with `totalCount` 0.
5. `template_only` — active ads, but none with readable copy.
6. `abstain_unclear` — readable ads that do not support a specific true line (slogans, mixed catalog).
7. `line_written`

The line, for `line_written` only, completes *"Noticed …."*:

- lowercase start, 16 words or fewer, no final period, no em or en dash, no emoji, quotes, symbols or
  web addresses, no apostrophes or contractions (write *you are*);
- **never the company's own name or any word of it**; write what the ads sell;
- **one thing**: the offer the ads repeat most, else the first usable ad; never a list, never two
  products joined by *and*;
- every noun and claim must appear in the ad text you kept; check each content word against it before
  keeping the line, and blank the line if one is missing;
- say *a lot of ads* only when `totalCount` is above the installer's threshold (default 50) from a page
  read; otherwise say nothing about volume, and never a number;
- write in English even when the ads are not.

Carry the evidence: the ad id you used, its start date, and the landing URL.

## Step 7 — Deliver

One row per domain with verdict, how the page was proven, page name, the line, and the evidence ad.
Then the coverage line. Offer to delete the two scratch workflows (`clay workflows delete <id>`), and
only those.

## Representative output

### Ad line per company

| Company | Page proven by | Verdict | Line | Evidence ad |
|---|---|---|---|---|
| northwindcoffee.com | homepage link | line_written | you are running a lot of ads for cold brew concentrate you mix at home | ad 1188…, started 2026-08-02, lands on northwindcoffee.com/cold-brew |
| contosoboots.com | keyword, 6 of 8 ads landed home | line_written | you are running ads for waterproof hiking boots with free returns | ad 7731…, lands on contosoboots.com/hiking |
| fabrikam.io | — | page_not_found | | homepage 403, keyword ads all landed elsewhere |
| tailspintoys.com | homepage link | template_only | | 30 ads, every body a catalog token |

### Coverage line

120 domains · 71 pages proven (44 homepage, 27 keyword) · 52 line_written · 9 template_only ·
4 abstain_unclear · 6 no_active_ads · 49 page_not_found (31 homepage blocked, rescue found nothing on
the declared domains) · 0 lines mention a count.

## What this skill does not claim

- The per-page and per-ad vendor prices are the source build's 2026-08-04 console readings; this run's
  vendor bill is not visible through Clay and was not measured.
- Eight domains were tested; the 1-in-8 homepage rate and 3-in-5 keyword rate are illustrations of the
  failure modes, not coverage estimates for any list.
- `totalCount` collates duplicate creatives and overstates distinct ads; it is used only as a threshold,
  never quoted.
- Google, TikTok and LinkedIn ads are not covered.
- The lines in the worked example were written by the agent following this file and graded by eye, not
  against a labelled set.

## What good looks like

A good run is a table where every line has a proven page next to it and an ad id you can open, the
line names a product or offer that appears in that ad's text, never names the company, and never
mentions a number. Abstains outnumber lines on most cold lists, and each abstain says which route
failed. The keyword rescue shows how many of its eight ads landed on the brand's domain.

A bad run has lines for pages found by name search, a page title as the only evidence, a line built from
a catalog template token, "we saw 950 ads", the brand's own name in the clause, a row marked
"no ads" when the real answer was "could not find the page", or keyword mode run on every row before the
free homepage route.

## Rules

- MUST prove a page by its homepage link with a slug that starts with the domain label, or by ads whose
  landing host is a declared brand domain; NEVER by page title or name search.
- MUST run the free homepage route on every row before any keyword search.
- MUST read a page count with `onlyTotal` set, so it bills one item per page.
- MUST keep `page_not_found` distinct from `no_active_ads`.
- NEVER quote an ad count; *a lot of ads* only above the threshold from a page read.
- NEVER name the company, list products, or state a fact absent from the kept ad text.
- NEVER set response metadata on the homepage fetch; it blanks the HTML.

## Worked example

Asked: *"which of these eight brands are running Meta ads and what would we say about it"*, with keyword
rescue allowed on up to ten rows, country US, brand domains = the listed domains only.

Step 3, free: one homepage linked to its page with a matching slug (a rug brand); two homepages loaded
with no page link (a B2B software company, a placeholder domain); five refused the fetch.

Step 5, the rug brand's page read returned `totalCount` 1,213 and 30 ads, several of them catalog
templates. Keyword search on five of the blocked rows:

| Brand | Ads landing on its domain | Verdict |
|---|---|---|
| a cookware brand | 8 of 8 | page proven; page read `totalCount` 1,165 |
| a sock brand | 6 of 8 (two insulin-pump and solar ads rejected) | page proven |
| a wallet brand | 5 of 8 (supplement and tracker ads rejected) | page proven |
| a bone-broth brand | 0 of 8 | page_not_found |
| a soda brand | 0 of 8 on its corporate domain; 7 of 8 on a shop domain nobody declared | page_not_found, flagged: declare the shop domain and re-run |

Lines written from the kept ads:

| Brand | Line |
|---|---|
| rug brand | you are running a lot of ads for washable rugs that are easy to clean |
| cookware brand | you are running a lot of ads for ceramic nonstick cookware |
| sock brand | you are running ads for compression socks that help tired legs |
| wallet brand | you are running ads for slim metal wallets |

Four of eight with a line, two abstains that a declared shop domain or a wider keyword might recover,
and two correct blanks. 0 Clay credits across all runs; the scraping account carried the ad reads.
