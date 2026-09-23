# Deciding whether a candidate URL belongs to the company

You, the agent running this skill, make this call. Nothing is sent to a model endpoint. The rules are
the source playbook's locked verifier prompt, restated as instructions to you; the canonical URL is
always the one the Extract code or `canonical()` below produced, never one you retype.

## When you judge, and when you do not

| Where the candidate came from | Judge it? | Why |
|---|---|---|
| the company's own homepage (page read) | only for the red flags below | self-attested; best-match already chose it |
| the company-enrichment function (LinkedIn only) | no, but its echo must match (next section) | a structured record keyed on the domain |
| a site-restricted web search | **always** | search candidates were wrong on every live row checked |

Red flags on a homepage candidate: the handle names a different brand (an agency, a platform, a parent
company), or the same platform shows two strong candidates of similar score. Report the second as a
note; do not choose silently.

## The enrichment echo check (LinkedIn)

The company-enrichment function returns the company's `domain` and `website` beside its LinkedIn `url`.
Normalize both (lowercase, strip scheme, `www.`, path) and require one of them to equal the input
domain. A mismatch means the record is a different company: do not use its URL. A miss comes back as
`status: complete` with an empty `result` (`{}`), which is "no record", not an error and not a zero.

Measured 2026-09-23 on 8 food-and-drink domains: 8 of 8 echoed the input domain, and on the 5 rows
where the homepage also linked a LinkedIn page, all 5 agreed with the enrichment URL once the
apostrophe fix was in. Before that fix, one row disagreed because the page pattern had cut the slug.
**When the two disagree, report both and take neither until one is explained**; a disagreement found
the only extraction bug in this build.

## Rules for a search candidate

- `owned` only when the profile is the official account of this company. A similarly named company,
  a fan page, a reseller, a news account, a hashtag or discovery page, a single video, or an
  employee's personal profile is not owned.
- Search evidence is weak. Require the profile title, the handle, or the URL slug to match the
  company name or its domain root.
- A title naming a different entity is not owned, even when the handle looks right.
- A post, photo, video, playlist, jobs, tag, discover or search URL is not a profile. It never reaches
  you if the profile patterns ran first; if it does, reject it.
- A YouTube `/channel/UC...` id can never contain the brand; judge it on the result title alone.
- **X is never taken from search.** Handles are short, recycled and squatted: the source playbook
  measured a brand-matching X handle titled "Bug Poc" for a company whose site links no X account.
  X comes from the company's own page or stays empty.
- `confidence: high` only when the handle or slug contains the company name or domain root, or the
  title is exactly the company name.

Measured 2026-09-23: two platform searches for companies whose pages had no link on that platform
returned 7 and 3 results. Every one was a tag page, a discover page, another person's post, or a
third-party review video. All rejected; both platforms stayed empty, which was correct.

## Never validate a URL by fetching it

The source playbook measured that the big social networks return the same error page to an anonymous
request whether a profile exists or not (HTTP 400, identical 1,542-byte body, for a page that certainly
exists and for one that does not). A liveness check deletes good data. Corroborate with a second
source instead.

## canonical(), for URLs you did not get from the Extract code

Apply, in order: `http:` to `https:`; LinkedIn country subdomain to `www`; `twitter.com` and
`www.x.com` to `x.com`; Facebook `web.`, `m.` and locale subdomains to `www`; bare
`instagram.com`, `youtube.com`, `tiktok.com`, `facebook.com`, `linkedin.com` to `www.`; drop query and
fragment; drop a trailing `/about`, `/posts`, `/jobs`, `/photos`, `/videos`, `/life`, `/featured`;
drop the trailing slash; lowercase the handle except a LinkedIn slug or a YouTube channel id.
