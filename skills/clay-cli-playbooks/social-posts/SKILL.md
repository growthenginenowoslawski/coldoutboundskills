---
name: social-posts
description: |
  Fetch the most recent usable professional-network post behind a company page or a person's profile,
  screen it so nothing personal, political, bereavement-related or religiously or geopolitically
  charged ever reaches outreach, check the post was really written by that account, and hand back the
  post text itself with its permalink and age, blank rather than invented when there is nothing usable.
  Optional: one short personalization clause written from the kept post. Use whenever someone asks:
  what did they post about, pull their recent LinkedIn post, what is this founder posting, reference
  their content in the first line, social signal for this account list, have they posted lately.
  Do NOT use it to list the people who liked or commented on a post (linkedin-engagement), to read
  paid ads on Facebook or Instagram (ad-library), or to find alumni and one-hop connections
  (warm-intros).
---

# Recent social post (store the post, screen it, prove the author)

The insight: **a post returned for an account is not necessarily a post by that account, and a page
with no post looks exactly like a page that does not exist.** Measured live on 2026-09-23, one batch of
nine URLs through the posts fetch:

| Input | Returned | What a naive join would have shipped |
|---|---|---|
| five company pages and one person profile | 18 posts, each authored by the account asked about | correct |
| one company page (a sales tool mid-rebrand) | 3 posts, **all three written by other accounts**, no repost flag | a stranger's post attributed to the prospect |
| one 25-person company page | 0 posts, no error | a blank, correctly |
| one slug that does not exist | 0 posts, no error | a blank, indistinguishable from the dormant page above |

Three consequences, each forced by a row above:

- **Keep a post only when its author slug equals the slug you asked about.** The fetch returns the
  asked-about URL on every item (`query.targetUrl`), so the join always succeeds; the identity check is
  the only thing that catches the third row.
- **An empty return is not evidence the page exists.** Resolve the URL from the domain on a free
  enrichment before fetching, and label an empty return `no_recent_post`, never "dormant".
- **Small companies post from people, not pages.** The GEX build this is ported from measured 12 of 17
  high-frequency B2B company pages with a post in a 90-day window (71%, 2026-08-04) and called
  sub-50-person pages a systematic blind spot. The founder's profile URL is the lever for that segment,
  and the same fetch takes it.

The screen is not optional and it fails closed. People post about funerals, elections and wars, and a
cold email that references one costs more than any reply rate can repay. Every fetched post is screened
newest first; a skipped post means take the next one, and only a post you positively judged `business`
is kept.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and if an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The accounts** | company domains, company page URLs, or person profile URLs; a list or a file | no default, there is nothing to fetch |
| **URL kind per row** | company page or person profile, and for small companies whether to use a founder's profile instead | ask; the author's view is that below about 50 employees a person URL is the only one likely to have a post, but that is a targeting choice |
| **Window** | how old a post may be | 3 months is defensible (the measured fill figures used it) and must be stated; never unset, which means any age |
| **Depth** | how many recent posts to fetch per account so the screen has somewhere to fall through to | 3 is defensible; it is the smallest number that survives one skip and one empty post |
| **Fetch arm** | Clay credits, or a scraping account connected to Clay | ask; see Step 2. No connected account and no credits means the skill cannot fetch |
| **Connected account** | which connected scraping account to bill, when there is more than one | ask; never pick one |
| **Skip categories** | the four below, plus any the installer adds | the four are the floor; the installer may add, never remove |
| **Write a line?** | yes or no | default no; the post text is the deliverable |

**If an answer sheet is present beside this skill, load it and ask only for what it does not cover.**
Say which values came from the sheet before using them. If there is no sheet, say nothing about sheets.
At delivery, offer to save the answers (identifiers only, never a token): *"want me to save your answers
to a file, so the next person on your team doesn't have to answer these again?"*

## What this skill touches

- **Reads** — the accounts you supply, one free company enrichment per domain to resolve its page URL,
  and the recent public posts behind each URL.
- **Writes** — one scratch workflow in your Clay workspace, named so you can recognise and delete it,
  because a connected-account action only runs inside a workflow. No table, no CRM, no sequence.
- **Never** — sends anything, writes to a CRM or sequencer, keeps a post it could not screen, or
  attributes a post to an account that did not write it.
- **Halts** — Step 1 other, Step 4 sample-review, Step 4 spend-approval.
- **Vendor-specific** — the connected-account arm runs on a scraping platform account connected to Clay
  (measured on Apify). Without one, the Clay-credit arm runs on person profiles only; with neither, the
  skill does not fetch.
- **Derived from** — the GEX recent-social-post playbook (Growth Engine X, 2026-08-04 and 2026-08-07
  live tests), ported to the Clay CLI and re-tested 2026-09-23. Not author-confirmed.

## Step 0 — Check the platform works, and say where the work runs

Say this to the installer first: *"This reads public posts and writes one scratch workflow in your
workspace; it sends nothing and writes to no CRM."*

```
clay whoami; echo "exit_code=$?"
clay --version                       # measured on 1.3.0
clay workflows nodes --help          # confirm create / update / delete exist on this version
```

If `whoami` fails or the version is below the server minimum, say which component is wrong and the one
command that fixes it (`clay login`, `clay update`), then stop. Do not install or fetch anything to
repair it.

Pull live, never from memory, and fail loudly if any is absent:

| Job | Expected (packageId found in the catalogue, actionKey) | Declared cost | Field read |
|---|---|---|---|
| resolve a domain to its company page URL | managed function **Enrich Company**, found with `clay routines list --limit 100`, cost from `clay routines get` | `perRun` 0 measured | `url`, `employee_count` |
| fetch posts, Clay-credit arm | package "Professional Posts", `social-posts-get-post-activity-posts-and-shares` | 0.5 per profile, `paymentType: Clay Credits` | `posts[].content[].text`, `posts[].created_at`, `posts[].author.url` |
| fetch posts, connected-account arm | package "Apify", `apify-run-actor` | none in credits, `paymentType: Bring Your Own Account` | `results[].content`, `results[].author`, `results[].postedAt.date` |

```
clay workflows actions list > /tmp/actions.json
clay workflows actions schema <packageId> social-posts-get-post-activity-posts-and-shares
clay workflows actions schema <packageId> apify-run-actor
clay routines list --limit 100       # find Enrich Company by name
clay routines get <its id>           # read estimatedCreditCost.perRun
```

Where the work runs, because that is what it costs: URL resolution is a free managed function; the fetch
is either a per-profile credit charge or one action execution per batch on your connected account (the
scraping vendor bills you per post, outside Clay); the screen, the identity gate and the verdict run in
this conversation and cost nothing.

## Step 1 — Collect the definition

Ask for the declared inputs above, front-loading the three that change cost: the accounts, the fetch
arm, and the depth. **Do not guess the URL kind for a small company**; ask whether they want the page or
a named person. **Do not start a step before the steps above it have their answers. If a declared input
is missing, ask for it — never assume a default and continue.** This step halts until the accounts and
the fetch arm are answered.

## Step 2 — Route the fetch arm, on the input the installer holds

| The installer holds | Arm | Why |
|---|---|---|
| person profile URLs, and credits | Clay-credit arm | declared for person profiles; 0.5 credits each |
| company page URLs, or a mix | connected-account arm | the credit arm documents person URLs only; whether it accepts a company page is unverified |
| domains only | resolve first (Step 3), then the connected-account arm | a domain is not a fetchable identifier |
| no credits and no connected scraping account | none | say so and stop; there is no free fetch of post text on this surface |

The two arms return different shapes. Do not mix them inside one cohort: route the whole list one way
so the fields and the author check mean the same thing on every row.

## Step 3 — Free checks before anything paid

1. **Normalise and dedupe** on the URL: lowercase host, strip query strings, one trailing slash. A company
   list becomes one fetch per company page, fanned back out to every contact at that company afterwards.
   A person URL is never fanned out.
2. **Resolve domains to page URLs** with the free Enrich Company function, 100 items per run:

   ```
   clay routines runs start <Enrich Company id> --input '{"items":[{"id":"r1","inputs":{"Company Identifier":"example.com"}}]}'
   clay routines runs get <routineRunId>      # poll until status is not in_progress
   ```

   Read `.data[i].result["Enrich Company"].url`. The input is validated as a **hostname**: a company page
   URL is rejected with "Must be a valid hostname", whatever the description says. Carry
   `employee_count` too; under about 50 it is the cue to ask for a person URL instead (Step 1).
3. **Drop rows that did not resolve** into the coverage line as `no_url`. Never guess a slug.

What this saves: every unresolved row and every duplicate is removed before any fetch bills.

## Step 4 — Ten rows, then one gate

Build the fetch workflow once (`references/workflow-recipe.md` holds the node specs, and on the
connected-account arm the account id goes on the tool, not the node). Run it on **ten real rows** from
the installer's list, then screen and gate them yourself (Steps 5 and 6) and show:

- the ten rows as they would be delivered, including the blanks and why;
- the full-run count after dedupe, and its cost in the unit it bills: credits × profiles on the credit
  arm; on the connected-account arm, "no Clay credits; one action execution per batch; your scraping
  account is billed per post by its vendor, visible in its console";
- what will be written: the scratch workflow only, and that you will delete it at the end if they want;
- the ask.

Then stop and wait. Stop a second time only if the full list turns out far larger than stated.

## Step 5 — Fetch, then screen newest first

Run the batch (one workflow run carries up to about a hundred URLs, which is one action execution).
For each target URL, take its posts newest first and, for each post:

1. **Author gate.** The post's author slug (`author.universalName` for a company, `author.publicIdentifier`
   for a person) must equal the slug in the target URL. If not, discard the post and record
   `author_mismatch`. This is not a screen result; a mismatched post is never screened.
2. **Window gate.** Discard posts older than the declared window.
3. **Screen** against `references/skip-rubric.md`. Keep the first `business` post. Record the category and
   a short reason for every post you screened.

If a post is empty or only a link, it is `unreadable` and you take the next one.

## Step 6 — Verdict per row, single-valued

Six values, no seventh, resolved in this order; the first that applies wins:

1. `no_url` — the row never resolved to a URL (Step 3).
2. `fetch_failed` — the run errored for this URL. A vendor error is a retry, never a blank.
3. `no_recent_post` — zero posts in the window. Say "no post found", never "the page is dormant": a bad
   slug returns the same empty result.
4. `author_mismatch` — posts came back but none was written by the account asked about.
5. `all_skipped` — every post in reach was screened out; list the categories.
6. `kept` — one post kept, with its text, permalink, author type and days ago.

Only `kept` carries post text. Every other row is blank in the text fields, not "N/A".

If the installer asked for a line, write it now, from the kept post only: one clause that completes
*"Noticed …."*, lowercase unless it opens on a proper noun, under 120 characters, no em dashes, no
emoji, third person about the author (never "we" or "our"), and every fact must be in the post text. A
customer-story post is about the customer, so write it that way or leave it blank. No kept post, no
line.

## Step 7 — Deliver

One row per input account, then the coverage line. Offer to delete the scratch workflow
(`clay workflows delete <id>`, present on 1.3.0; confirm with `clay workflows --help`). Delete only the
workflow this run created.

## Representative output

### Post per account

| Account | URL kind | Verdict | Days ago | Post (verbatim, trimmed) | Permalink | Screened |
|---|---|---|---|---|---|---|
| Northwind | company | kept | 2 | "We opened our Denver warehouse this week, cutting delivery to two days across the Mountain West." | linkedin.com/posts/northwind_… | 1 business |
| Contoso (founder) | person | kept | 9 | "Three things I learned shipping our billing rewrite…" | linkedin.com/posts/j-contoso_… | 1 personal, 1 business |
| Fabrikam | company | author_mismatch | — | | | 3 posts by other accounts |
| Tailspin | company | no_recent_post | — | | | 0 posts in 3 months |

### Optional line

| Account | Line |
|---|---|
| Northwind | they opened a Denver warehouse to speed up delivery in the Mountain West |

### Coverage line

40 accounts in · 37 resolved to a URL · 24 kept · 6 no_recent_post · 3 all_skipped (2 political,
1 bereavement) · 2 author_mismatch · 2 fetch_failed, retried once, still failing · 3 no_url.

## What this skill does not claim

- The Clay-credit arm was not live-run: it needs 0.5 credits per profile (read live 2026-09-23) and the
  test workspace held 1.5 credits; its schema was read, its output was not observed.
- Whether the Clay-credit arm accepts a company page URL is unverified; its schema documents person URLs.
- The 71% company-page fill figure is from 17 high-frequency B2B posters in the source build; a long-tail
  list will fill lower, and no person-URL fill rate has been measured.
- The screen was measured 18/18 as a model prompt in the source build; applied by the agent it has been
  exercised on 18 posts that were all business, so the skip branches were not triggered live.
- The scraping vendor's per-post bill is not visible through Clay and was not measured here.

## What good looks like

A good run reads like an audit trail: every kept post is verbatim, dated inside the window, written by
the account it is filed under, and has a screen record next to it; every blank carries one of the six
verdicts, so a reader can tell a skipped political post from a page that returned nothing from a slug
that never resolved. The coverage line adds up to the input count. On a list of active B2B posters most
rows are `kept`; on a small-company list most company rows are `no_recent_post` and the run says to
retry with person URLs rather than presenting the blanks as the answer.

A thin or failed run looks different: blanks with no verdict, "dormant" used for an empty return, a
post filed under an account that did not write it, a line written with no kept post behind it, or a
skip rate near 100% that nobody sampled. That last one means the audience does not fit this signal, not
that the screen should be loosened.

## Rules

- MUST keep a post only when its author slug equals the slug of the URL asked about.
- MUST screen every fetched post, newest first, and keep only a post judged `business`; an error, an
  empty post or a doubtful call means skip.
- MUST resolve domains to page URLs before fetching and label an empty return `no_recent_post`, never
  "dormant".
- MUST route one fetch arm per cohort and carry the author type into the output.
- MUST run ten real rows and hold one gate before the full batch.
- NEVER invent, paraphrase into, or fill a blank: the post text is verbatim or empty.
- NEVER loosen or remove a skip category to raise fill; the installer may add categories, not remove
  them.
- NEVER write a line without a kept post, and never in the first person.
- NEVER fan a person's post out to other contacts at their company.

## Worked example

Asked: *"pull the latest LinkedIn post for these nine accounts so the SDRs can open on it"*, a list of
seven domains, one CEO profile and one page slug someone typed by hand.

Step 3 resolved the seven domains through the free company enrichment (0 credits, `perRun` 0) to seven
company page URLs; one came back with 25 employees, and the skill asked whether to use its founder
instead (the installer said no, keep the page, for the test). The connected-account arm fetched all
nine URLs in one workflow run: one action execution, 0 Clay credits, balance unchanged at 1.5.

| Account | Verdict | Why |
|---|---|---|
| five B2B software pages | kept | newest post by the page itself, all `business`, 1 to 9 days old |
| a CEO profile | kept | newest post by the profile, `business` |
| a sales-tool page | author_mismatch | all three returned posts were written by other accounts |
| a 25-person agency page | no_recent_post | zero posts in 3 months |
| the hand-typed slug | no_recent_post | zero posts; the slug does not exist, which the result cannot show |

Six of nine kept. The delivery said, at the top: *posts are verbatim and by the named account; the
sales-tool page returned other people's posts and was left blank rather than mis-attributed; the two
empty rows are not proof the page is inactive.*
