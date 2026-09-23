---
name: name-2-other-prospects
description: |
  Name up to two other right-fit people at the prospect's own company, so an email can ask "is this
  you, or would Dana Kowalski or Marcus Lee own it?" without ever naming the person being emailed. Finds
  senior people per company domain in Clay people search, removes the recipient in code before
  anything else sees the list, re-reads every candidate's profile with the free person-enrichment
  function to prove they still work there, then judges and cleans the names. Outputs a ready-to-drop
  phrase with a fixed fallback. Use whenever someone asks: name two other people at the company, who
  else works there, should I be talking to someone else, colleague name variable, other prospects
  line, wrong-person CTA, referral ask, "not sure if this is you or" line. The search index lists
  people who have left and community members who tag the company as their employer, so the
  still-there read is the step that makes this safe. Do NOT use it to build the buying committee as
  separate leads (find-contacts-at-account), to find people new in their seat (new-in-role), or to
  enrich the recipient themselves.
---

# Name two other prospects (exclude the recipient in code, then prove each colleague still works there)

The insight: **the search index says who has worked there, not who works there now — so a colleague
list is only as good as its staleness check, and the check has to be a fresh profile read, not the
search row.** Measured on 2026-09-23 against Clay people search for one company domain: 15 senior
people returned as current at that company. A free profile read of all 15 showed **1 had no current
role anywhere** (the index still listed them as a department head there), and **2 more were community
roles** — a "creator and club lead" and an "angel investor, creator and community" — who list the
company as an employer without working for it. Three of 15, a fifth of the pool, are names that make
the email wrong, and all three looked senior and current in the search row. Across all five companies
that returned people the same day, **4 of 85 "current" senior people had left** — at one company the
index still listed the chief executive, whose profile now shows them at another company in the same industry. The
failure is not evenly spread, which is why it cannot be sampled away: 0 of 25 at one company, 2 of 18
at another.

The same failure was measured before this port (2026-08-04, other providers, 8 companies): a
provider-only chain named someone who had left for another company, and kept a video editor whose
profile listed the target as employer. **A provider-only chain scored 5–6 of 8 usable; adding a
staleness check lifted it to 7 of 8.** Only 3 of 8 companies produced two names, so a campaign that
makes two names mandatory loses about 60% of its rows.

And one rule sits above all of it: **never name the person being emailed.** "Hey Jane, should I talk to
Jane?" is the worst outcome this skill can produce, so the recipient is removed from the candidate
list by code, before any judgment, and the code refuses to run without the recipient's name.

## Declared inputs

**Nothing here ships with a value.** Each one is the installer's, not the author's: ask for it, never
substitute a plausible default, and where an answer does not exist say which step becomes unavailable
rather than guessing. Where a default IS defensible it is named below, and using it means saying so in
the output.

| Input | What the installer supplies | If it is missing |
|---|---|---|
| **The rows** | per lead: the company domain and the **recipient's full name**; the recipient's profile URL if they have it | no default — a row without the recipient's name is not runnable, and is skipped with that reason |
| **Who counts as a colleague** | the persona: seniority levels and, optionally, title words (e.g. VP and above in sales or marketing) | ask; if they have no view, offer founder/owner/C-suite/VP/head/director and SAY it is borrowed |
| **Same-campaign exclusion** | whether other recipients at the same company may be named | ask; the author's default was **allowed**, because excluding them costs coverage at every company with 3+ recipients. If on, they supply the full lead list |
| **Fallback phrase** | what renders when no colleague survives | `someone else at the company` is defensible and must be stated |
| **Two names mandatory?** | whether rows with fewer than two names are dropped | ask — measured, it drops about 60% of rows |

**If an answer sheet is present beside this skill, load it and ask only for what it does not cover.**
Say which values came from the sheet before using them. If there is no sheet, say nothing about
sheets. At delivery, offer to save the answers (identifiers only, never a token or a password),
private and never published: *"want me to save your answers to a file, so the next person on your team
doesn't have to answer these again?"*

## What this skill touches

- **Reads** — the rows you supply, Clay people search (search-result quota, not credits), and the free
  person-enrichment function for each candidate.
- **Writes** — nothing. The deliverable is a table handed back to you.
- **Never** — names the recipient, names a candidate whose fresh profile does not show a current role
  at the target domain, contacts or enrolls anyone, or sends the recipient's name anywhere but the
  local screening script.
- **Halts** — Step 4 sample-review.

## Step 0 — Verify Clay and pull the live surfaces

Say this to the installer as the run starts: *this reads Clay people search and a free person
enrichment, writes nothing, and hands you a table.* Then:

```
clay whoami; echo "exit_code=$?"
clay --version
clay searches query-mode reference | jq -r '.reference' > /tmp/clay-search-reference.md
clay routines list --limit 100 | jq '.data[] | select(.name == "Enrich Person")'
clay routines get <the id that returned>
```

| Check | Expect | If not |
|---|---|---|
| `whoami` | exit 0 | stop; run the Clay plugin's `setup` skill |
| search reference | `clay.filter_to_companies((...))` documented for people at a current employer, and a `seniority` enum inside `experiences.any(...)` | stop and say which is missing |
| `Enrich Person` | present (find it by name; ids differ per workspace) | stop — without it there is no still-there check, and the skill does not run without one |
| `routines get` | `estimatedCreditCost.perRun` of **0**, input `Professional Profile URL` | if above 0, price it per candidate at Step 4 and add `spend-approval` to that gate |

Where the work runs: search and enrichment on Clay; exclusion, the still-there test and the support-title
filter locally in `scripts/screen_colleagues.py` (free, no network); the final pick and name cleaning by
you, the agent reading this skill. **No Clay AI column and no outside model key.**

If the platform check fails, say which component is wrong and the one command that fixes it. Do not
install, upgrade or fetch anything to repair it.

## Step 1 — Collect the definition (do not guess)

Do not start a step before the steps above it have their answers. If a declared input is missing, ask
for it — never assume a default and continue.

Read their lead list and show the mapping you found: which column is the domain, which is the
recipient's full name, which (if any) is the profile URL. Ask only about what you could not match.
Normalise every domain to bare lowercase (no scheme, no `www.`): a scheme on the domain column
silently turns the whole campaign into the fallback.

## Step 2 — One search per company, never one search for the list

```
select from people
where clay.filter_to_companies(("northwind.com"))
  and experiences.any(is_current = true
        and seniority in ("Founder", "Owner", "C-suite", "VP", "Head", "Director"))
```

Add `and job_title is_similar_to (...)` inside the same `experiences.any(...)` only when the persona
names title words. Run it with `clay searches query-mode run <searchId> --limit 25`.

**Why one per company:** a single search over many domains returns people in the index's order, so a
large company fills the page and small ones get nothing. The grammar has a per-employer cap (`limit N
by clay_company_id`) but the reference's own policy says never to write `limit` clauses, so cap per
company by running per company. 25 is enough: the output names two.

An empty page (`data: []`, `exhaustionReason: "no_more_results"`) is a real answer — the fallback. A
`server_error` or `rate_limited` is **not** an answer: retry, and if it persists mark the row `error`,
never the fallback. A provider error rendered as "someone else at the company" hides the failure.

## Step 3 — Free checks: remove the recipient, then everyone else you can rule out in code

Before any enrichment, drop the recipient from each company's page by normalised name (lowercase,
accents and punctuation stripped) and by normalised profile URL. When same-campaign exclusion is on,
drop every other recipient at that domain too. This happens in `scripts/screen_colleagues.py`, which
exits non-zero if the exclusion list is empty — an empty set means nobody built it, not that nobody
needs excluding. **Never hand this to the judgment step.** A filter you can prove beats an instruction
you have to trust.

## Step 4 — Ten companies, then ONE gate

For the first 10 companies, enrich every remaining candidate's profile URL — **one enrichment run per
company**, item ids `c0`, `c1`… in that company's page order (the script joins on them; a run shared
across companies would collide ids):

```
clay routines runs start <Enrich Person id> --input '{"items":[{"id":"c0","inputs":{"Professional Profile URL":"..."}}]}'
clay routines runs get <routineRunId> --limit 100 --wait 120
python3 scripts/screen_colleagues.py --domain northwind.com --search page.json --enrich run.json \
  --exclude-name "Recipient Fullname" --exclude-url "<recipient profile URL, if known>"
```

The script marks each candidate `excluded_recipient`, `unverified_no_profile`, `not_current_at_target`
(the fresh profile has no current role whose company domain is the target), `support_title`
(assistant, coordinator, intern, product owner and similar), `duplicate_person` (the index held two
rows for one person — measured once in 18), or `candidate`, and sorts candidates most
senior first. Two traps it guards: a person the enrichment cannot find comes back `status: complete`
with an **empty result**, not an error — the script treats that as unverified, never as present; and
`runs get` returns **20 items per page by default**, so a 25-candidate run fetched without
`--limit 100` silently loses five people (measured) — the script refuses to run when a run's item
count and the items read disagree.

**Percent-encode each profile URL before it goes in the run body.** Profile slugs can carry non-Latin
characters, and one such URL rejects the **whole** run with `validation_error` ("Must be a valid URI
including protocol"), not just that item (measured). In Python: `urllib.parse.quote(url, safe=":/%")`.

Then judge (Step 5), and stop with one message: the 10 companies with their phrases and the dropped
candidates with reasons; the rows you expect in the full run and the search pages and enrichment items
that means; the cost — search quota plus 0 credits for enrichment as read at Step 0; that nothing is
written anywhere; and the ask: *run the rest?* Wait.

## Step 5 — Judge and clean (you are the judge)

On `candidate` rows only, per company, pick **up to two**, most senior first, who fit the persona:

- Drop a title that is a community, creator, ambassador, investor, advisor, "club" or program role
  rather than employment — they tag the company without working there.
- Drop a person whose headline names a different company or a different line of work than the title.
- Drop anyone with only one name token.
- Prefer people with no other current roles over people holding several.
- Clean the name: first and last name from the profile, no credentials, emoji, pronouns, nicknames or
  text after a comma, pipe or bracket; fix ALL CAPS; keep accents, hyphens and two-word surnames; drop
  middle names.
- Never invent or complete a name.

## Step 6 — Verdicts, single-valued, first match wins

1. `error` — the search or the enrichment failed for this company. No phrase; say why.
2. `two_names` — two survivors: `First Last or First Last`.
3. `one_name` — one survivor: `First Last`.
4. `fallback` — none survived: the declared fallback phrase.

The phrase uses `or`, never `and`; full first and last names; no titles, no quotes, no trailing
punctuation. It must read inside *"Not sure if this is you or ___."* and *"If ___ owns this instead,
happy to send it their way."*

## Step 7 — Deliver

One table, one row per lead, then a coverage line: companies searched, candidates found, how many were
removed by each check (recipient, not current, support title, judgment), and the verdict counts. Say
whether same-campaign exclusion was on and whether the persona was chosen or borrowed.

## Representative output

### Other-prospects phrases

| Company | Recipient | Phrase | Count | Verdict | Dropped |
|---|---|---|---|---|---|
| northwind.com | (excluded) | Dana Kowalski or Marcus Lee | 2 | two_names | 1 not_current_at_target, 1 community role |
| contoso.com | (excluded) | Priya Shah | 1 | one_name | 2 support_title |
| fabrikam.com | (excluded) | someone else at the company | 0 | fallback | search returned no senior people |
| tailspin.com | (excluded) | — | — | error | search timed out twice; not rendered as fallback |

### Coverage line

40 companies · 612 candidates · 40 recipients removed · 71 not current at the company · 19 support
titles · 88 dropped at judgment · 14 two_names, 17 one_name, 8 fallback, 1 error. Same-campaign
exclusion off (chosen). Persona borrowed: founder to director.

## What this skill does not claim

- The still-there read comes from Clay's own profile data, so it catches people the index already knows have left; someone who left last week and has not updated their profile still passes.
- Verified live on six companies on 2026-09-23 (4 two-name, 1 one-name, 1 fallback); the 4-of-85 departed rate and the community-role share come from those pages, not from a population.
- The 5-of-8 and 7-of-8 figures were measured with other providers on 2026-08-04 and are a guide, not a Clay yield.
- It does not check that the named colleagues are reachable or that they own the problem the email is about.
- The persona judgment is the agent's reading of a title and headline; it is not checked against an org chart.

## What good looks like

A good run hands back one phrase per lead where every name belongs to someone whose fresh profile
shows a current role at that exact domain, the recipient appears nowhere, and every dropped candidate
has a one-word reason. Most companies land on one or two names; small companies and one-person shops
land on the fallback, and say so. Errors are listed as errors.

A thin run looks like: every row on the fallback (the domain column carried `https://` or `www.`); a
colleague named who the profile shows now works elsewhere (the enrichment step was skipped); two
people at one company naming each other with exclusion on (the lead list was not grouped by domain);
or a batch that "finished clean" with many fallbacks and no errors, which usually means provider
failures were swallowed.

## Rules

- NEVER name the recipient; MUST remove them by normalised name and profile URL in code before any judgment, and MUST refuse a row without the recipient's full name.
- MUST re-read every candidate's profile and keep only people with a current role at the target domain.
- MUST search one company at a time.
- NEVER render a provider error as the fallback phrase.
- NEVER print a title next to a name, or a first name alone.
- MUST use `or` between two names.
- NEVER invent a name, and never fill a slot with a candidate who failed a check to reach two.

## Worked example

Asked: *"For these leads, give me an 'is this you or…' variable. The recipient is the person each row is addressed to."*

Declared: persona founder, owner, C-suite, VP, head, director (borrowed, said so); same-campaign
exclusion off (default accepted, said so); fallback `someone else at the company`; two names not
mandatory.

Run on 2026-09-23 for clay.com, with one of the company's heads of sales development standing in as
the recipient. The search returned 15 senior people. Screening: the recipient removed by name and URL;
1 person `not_current_at_target` — the index listed them as a head of department, the fresh profile
shows no current role; 12 `candidate`. Judgment dropped 2 community roles ("creator, coach and club
lead"; "angel investor, creator and community") and 1 events lead outside the persona. Picked the
co-founder and the head of sales, most senior first. Phrase delivered with two full names — shown
here as initials: *V. A. or B. L.*, verdict `two_names`.

A one-person consultancy domain, run the same way, returned an empty page: verdict `fallback`,
phrase `someone else at the company`.
