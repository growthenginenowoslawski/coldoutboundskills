---
name: linkedin-engagement
description: |
  Turn the people who reacted to or commented on a source account's recent professional-network posts
  (a competitor, a partner, or one of your own customers) into a short list of real prospects: shortlist
  the posts worth paying for, pull reactors and commenters with a resolvable profile, drop company pages,
  the source company's own staff, agencies and practitioners and anyone outside the ICP you define, and
  hand back one row per surviving person with the post they engaged with as evidence. Expect roughly one
  survivor per eight to ten raw engagers. Use whenever someone asks: who engages with our competitor's
  posts, likers and commenters on this post, build a list from LinkedIn engagement, who is commenting on
  our customer's content, warm audience from competitor posts. Do NOT use it to read what an account
  posted (social-posts), to find alumni of a customer (warm-intros), or to read paid ads
  (ad-library).
---

# LinkedIn engagement (shortlist posts, pull people, drop the source company first)

The insight: **most of the people engaging with a company's post are the company, its vendors, or
selling to its audience, and the source company's own staff are invisible to a naive "current employer"
test.** Measured live on 2026-09-23, one post by a CRM vendor, five reactors and five commenters
requested:

| Raw item | Count | What happens to it |
|---|---|---|
| returned | 9 (5 reactors, the cap exactly, and 4 commenters) | 8 unique people and pages; one person both reacted and commented |
| company pages among commenters | 2 | dropped: no person to contact |
| reactors employed by the post's author | 2 of 5 | dropped: the source company's own staff |
| an implementation partner of the source company, and a creator-advisor | 2 | dropped: selling to the same audience |
| outside the stated ICP on title | 1 | dropped |
| **survivors** | **1 of 8** | kept, headcount unresolved, flagged for review |

The source build (Growth Engine X, 2026-08-04) measured the same shape on 18 engagers of three
competitors' posts: 1 usable prospect of 17 unique people, a second wrongly dropped, so about 10%.

Two consequences:

- **Harvest eight to ten times what you need, and shortlist posts before paying.** The fetch bills per
  engager and per profile read whether or not the person survives, so the lever is which posts you pull,
  not how you filter afterwards. Pull posts with visible engagement from the social-posts fetch, rank by
  reactions plus comments, and pull only as many as the target count needs.
- **Read current employment off the role list the payload actually marks as current.** A current role
  arrives as `endDate: {"text": "Present"}`, not as a missing end date. The source build's rule, "every
  experience with no end date", matches **nothing** on today's payload, which means the source-company
  drop would have passed every employee of the source company straight through with no error.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and if an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **Source accounts** | the company pages or people whose posts to harvest, and why (competitor, partner, customer) | no default; the skill does not choose whose audience you want |
| **Source company identities** | a domain and a company page URL for every source company | stop. Without them the source-company drop cannot run, and it fails silently |
| **The ICP** | titles or functions, countries, company size band | stop and ask. An invented band filters on a guess nobody can see |
| **Target count** | how many survivors they want | ask; it sets how many posts and engagers to pull (×8 to ×10) |
| **Window** | how old a post may be | 1 month is defensible and must be stated |
| **Engagement floor** | minimum reactions plus comments for a post to be worth pulling | 15 is defensible (the source build's floor) and must be stated |
| **Fetch arm and account** | Clay credits, or a connected scraping account, and which one | ask; never pick an account |
| **Customer-lane consent** | when a source is the installer's own customer: is contacting its audience acceptable, and are its employees excluded | ask before the pull; never assume |
| **Write a line?** | yes or no | default no; rows are the deliverable |

**If an answer sheet is present beside this skill, load it and ask only for what it does not cover.**
Say which values came from the sheet before using them. If there is no sheet, say nothing about sheets.
At delivery, offer to save the answers (identifiers only, never a token): *"want me to save your answers
to a file, so the next person on your team doesn't have to answer these again?"*

## What this skill touches

- **Reads** — the source accounts' recent public posts, the public reactors and commenters on the posts
  you approve, and one free company or person enrichment per unresolved row.
- **Writes** — one scratch workflow in your Clay workspace, named so you can delete it, because these
  actions only run inside a workflow. No table, no CRM, no sequence, no suppression list.
- **Never** — contacts anyone, writes to a CRM or do-not-contact list, quotes a person's comment back to
  them, or keeps someone employed by a source company.
- **Halts** — Step 1 other, Step 4 sample-review, Step 4 spend-approval.
- **Vendor-specific** — the connected-account arm runs on a scraping platform account connected to Clay
  (measured on Apify). Without one, the Clay-credit arm runs at 0.5 credits per post per interaction
  type; with neither, the skill does not pull.
- **Derived from** — the GEX LinkedIn-engagement playbook (Growth Engine X, live test 2026-08-04, flow
  approved 2026-08-07), ported to the Clay CLI and re-tested 2026-09-23. Not author-confirmed.

## Step 0 — Check the platform works, and say where the work runs

Say this first: *"This reads public posts and the people engaging with them, and writes one scratch
workflow in your workspace. It contacts nobody and writes to no CRM."*

```
clay whoami; echo "exit_code=$?"
clay --version                       # measured on 1.3.0
clay workflows nodes --help
```

If the check fails, name the component, the required version and the one fixing command, and stop.

Pull live and fail loudly if anything is absent:

| Job | Expected (package, actionKey) | Declared cost | Field read |
|---|---|---|---|
| find posts to shortlist | the social-posts fetch (package "Apify" `apify-run-actor`, or "Professional Posts" `social-posts-get-post-activity-posts-and-shares`) | BYO, or 0.5 per profile | post permalink, reactions and comments counts |
| reactors, Clay-credit arm | "Professional Posts" `social-posts-get-post-interaction-reactions` | 0.5 per post, max 50 | `reactions[].author.url`, `.author.type` |
| commenters, Clay-credit arm | "Professional Posts" `social-posts-get-post-interaction-comments` | 0.5 per post, max 10 | `comments[].author.url`, `.author.title` |
| reactors and commenters, connected arm | "Apify" `apify-run-actor` | none in credits, `Bring Your Own Account` | `actor.currentPosition[]`, `actor.linkedinUrl`, `query.post` |
| employer size for the ICP band | managed **Enrich Company**, found with `clay routines list --limit 100` | `perRun` 0 measured | `employee_count` |
| current employer when the payload lacks it | managed **Enrich Person** | `perRun` 0 measured | `experience[]` with `is_current`, `company_domain` |

**Match on the schema, never the name.** An action in another workspace's catalogue whose name matched
post engagement turned out to be a Hacker News scraper. Confirm the input is a post URL and the output
is a list of people before wiring anything.

Where the work runs: the pulls are per-post credits or per-engager vendor billing; enrichment is free
managed functions; every drop, dedupe and ICP test runs in this conversation at no cost.

## Step 1 — Collect the definition

Ask for every declared input, source identities and the ICP first, because both gate the whole run.
When a source is the installer's customer, ask the consent question before anything is pulled.
**Do not start a step before the steps above it have their answers. If a declared input is missing, ask
for it — never assume a default and continue.**

Resolve each source company to a domain and a company page URL now, with the free Enrich Company
function (input must be a **hostname**; a page URL is rejected). An unresolved source company stops the
run: the drop in Step 5 is a set-membership test and an empty set passes everyone.

## Step 2 — Route the arm, on what the installer has

| The installer has | Arm | What it costs them | What it lacks |
|---|---|---|---|
| a connected scraping account | connected arm | vendor billing per engager and profile read; 0 Clay credits; one action execution per node run | nothing measured |
| credits only | Clay-credit arm | 0.5 × posts × interaction types: 30 posts, both types, is 30 credits | no employer on reactors, so one free person enrichment per engager; comments cap at 10 per post |
| neither | none | — | say so and stop |

One arm per run, so every row carries the same fields.

## Step 3 — Free work before anything bills

1. Fetch the source accounts' recent posts (social-posts skill, same workflow shape) and keep posts
   inside the window, written by the source account, with reactions plus comments at or above the
   floor. Skip reposts; their engagers belong to the original author.
2. Rank by engagement and take posts until expected raw engagers reach 8 to 10 times the target count.
   Say how many posts and why.

What this saves: every low-engagement post you would otherwise pay to pull, and every post from
another author that the fetch can return.

## Step 4 — Ten rows, then one gate

Build the workflow (`references/workflow-recipe.md`; on the connected arm the account id goes on the
tool). Run one shortlisted post with `max_per_post` 5, so about ten raw engagers. Run Steps 5 and 6 on
them and show:

- every raw engager with its drop reason or keep, so the installer sees the survival rate on *their*
  source, not ours;
- the full-run estimate: posts × engagers, and the cost in its unit (credits on the credit arm; "no Clay
  credits, vendor bills per engager and profile read" on the connected arm);
- what is written: the scratch workflow only;
- the ask.

Stop and wait. Stop a second time only if survival on the batch is far below 1 in 10, which usually
means the source's audience is its own industry and the installer should pick another source.

## Step 5 — Pull, dedupe, drop

Run the approved posts. Then, in this order:

1. **Dedupe on the profile URL.** Carry `engagement_count` (posts and interaction types) and whether they
   commented; commenters are the warmer half.
2. **Drop company pages**: `actor.type == "company"`, or a URL containing `/company/`.
3. **Drop the source companies' staff.** For every current role (`currentPosition[]`, or `experience[]`
   with `endDate.text == "Present"`), match against every source company: company page URL or
   `companyUniversalName` first, domain second (resolve the employer with the free enrichment if
   needed), squashed name last. Any match drops the row. On the credit arm, get current roles from the
   free Enrich Person function (`experience[]` where `is_current` is true, `company_domain`).
4. **Drop agencies, implementation partners and practitioners**, judged from the headline and current
   role: someone selling services around the source's product, or selling outreach to the same buyers,
   is a competitor for attention, not a buyer. State the reason in five words.
5. **ICP test** on the installer's definition: title or function, country, company size from the free
   Enrich Company call. Size you could not resolve is `icp_needs_review`, kept and flagged, never passed
   silently and never guessed.

Never quote someone's comment back to them, and never treat a reaction's preview text as something the
person said.

## Step 6 — Verdict per engager, single-valued

Seven values, no eighth, first match wins:

1. `company_page`
2. `source_company_staff`
3. `agency_or_practitioner`
4. `outside_icp` — name the failing clause.
5. `duplicate` — merged into another row; its engagement is counted there.
6. `icp_needs_review` — passed every drop, but a size or country clause could not be resolved.
7. `kept`

If the installer asked for a line, write it for `kept` rows only: *"Noticed you …"*, naming the post's
author possessively and what the post was about as a short noun phrase (`you liked Northwind's post
about cutting freight costs`), under 120 characters, no em dashes, never repeating their comment.

## Step 7 — Deliver

`kept` rows first, sorted by `engagement_count` then commenters first, then `icp_needs_review`, then a
table of every drop with its reason. State the survival rate and the source it was measured on. If any
source is a customer or competitor, remind the installer that excluding that company from future sends
is their decision in their own system; this skill writes no suppression list. Offer to delete the scratch
workflow (`clay workflows delete <id>`), and only the one this run created.

## Representative output

### Surviving prospects

| Person | Current role | Company | Size | Engaged | Post | Verdict |
|---|---|---|---|---|---|---|
| Dana K. | VP Revenue Operations | Northwind Logistics | 340 | commented, reacted (2) | Contoso's post about pipeline reviews | kept |
| Sam R. | Head of Sales | Fabrikam | unresolved | reacted (1) | Contoso's post about pipeline reviews | icp_needs_review |

### Drops

| Engager | Reason |
|---|---|
| Contoso (page) | company_page |
| Lee M. | source_company_staff, current role at Contoso |
| Priya S. | agency_or_practitioner, sells Contoso implementation |
| Tomas B. | outside_icp, engineering title |

### Coverage line

3 posts pulled (of 11 in window, 5 above the floor) · 54 raw engagers · 47 unique · 6 kept ·
3 icp_needs_review · 38 dropped (9 company_page, 12 source_company_staff, 8 agency_or_practitioner,
9 outside_icp). Survival 6/47 on a competitor source.

## What this skill does not claim

- The Clay-credit arm was not live-run: it needs 0.5 credits per post per interaction type (read live
  2026-09-23) and the test workspace held 1.5 credits.
- The 2026-09-23 test pulled one post and nine engagers; a 1-in-8 survival rate on that sample is an
  illustration, not a benchmark. The source build's 1-in-10 came from 17 people.
- Whether the free Enrich Company function accepts a company page URL: it did not; it requires a
  hostname, so an engager's employer needs a domain first.
- The customer-source lane has never been run; its survival rate is unknown.
- Nothing here suppresses future sends to a source company; that is the installer's own system.

## What good looks like

A good run is mostly drops, and every drop has a reason a reader would agree with on sight: a company
page, someone whose current role is at the source company, a consultant selling that product. The few
kept rows each name a person, a current employer that is not a source company, a size inside the band
or an explicit `icp_needs_review`, and the exact post they engaged with. The coverage line adds up and
states survival on this source.

A bad run keeps the source company's own employees (the tell is a current title at the post's author),
passes rows whose size was never checked, reports a 40% "hit rate" because the drops were skipped, pulls
fifty posts to find five people, or quotes someone's comment back to them.

## Rules

- MUST resolve every source company to a domain and page URL before pulling; stop if one will not
  resolve.
- MUST read current employment from roles marked current (`endDate.text == "Present"` or
  `currentPosition[]`), never from a missing end date.
- MUST drop company pages and every source company's staff before the ICP test.
- MUST ask for the ICP and gate on it; unresolved size is `icp_needs_review`, never a pass.
- MUST shortlist posts by engagement and run ten rows before the gate.
- MUST pass the profile mode that returns a public profile URL on the connected arm.
- NEVER quote a person's comment or a reaction's preview text as something they said.
- NEVER contact anyone or write to any suppression list or CRM.
- NEVER pull a post whose author is not the source account.

## Worked example

Asked: *"our client sells a CRM migration service; get me people engaging with a CRM vendor's posts"*.
Source: one CRM vendor, resolved to its domain and company page. ICP (installer's, for the test):
revenue or technology leaders, US, UK or Germany, any size, size flagged if unknown.

The social-posts fetch returned the vendor's three latest posts with 38, 27 and 63 reactions plus
comments. The third cleared the floor and had comments, so it was the one post pulled, at five per
interaction type: 0 Clay credits, one workflow run.

| Engager | Current role (from the payload) | Verdict |
|---|---|---|
| Will J. | Product & GTM at the vendor | source_company_staff |
| Ailish G. | Product Marketing Manager at the vendor | source_company_staff |
| Szymon J. | Senior Software Engineer, Poland | outside_icp (title, country) |
| Sönke V. | GTM advisor and creator, reacted and commented | agency_or_practitioner |
| Felix B. | Head of Technology & Integrations, Germany | icp_needs_review (size unresolved) |
| a GTM agency page | — | company_page |
| a second company page | — | company_page |
| George M. | CEO of an implementation partner of the vendor | agency_or_practitioner |

One of eight kept for review. The delivery said at the top: *survival here is 1 in 8 on a single
competitor post; to reach 25 prospects, pull about 200 engagers across the vendor's top posts, and
decide in your own system whether to exclude the vendor's employees from future sends.*
