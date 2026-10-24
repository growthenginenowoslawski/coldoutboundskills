---
name: amazon-brand-store-finder
description: Use when you need to know whether a company runs its own Amazon brand storefront (amazon.com/stores/...) rather than merely having products listed on Amazon by resellers — an ICP filter for DTC/consumer-brand outbound. Triggers on "does this brand sell on Amazon", "check these companies for Amazon stores", "find the Amazon store URL", "validate Amazon presence", "run the next batch of Amazon checks". Deterministic: search, fetch, and string-match only — no LLM judgement and no paid search API. Covers the discovery vectors, the verdict model, running batches concurrently, resuming after an interrupted run, and merging results back into a master list without destroying prior work.
---

# Amazon Brand-Store Finder

Confirms whether a company has a **live, brand-owned Amazon storefront** at
`amazon.com/stores/{slug}/page/{GUID}` — and returns the URL.

This is not the same question as "is this brand on Amazon". A brand can be sold
by third-party resellers with no storefront of its own, which fails most
Amazon-presence ICP filters even though products appear under its name.

**A `/dp/` product listing is never sufficient evidence.** Only a live
`/stores/` page, confirmed to belong to the brand, counts as a Yes. Accepting
`/dp/` hits once inflated a real pass from ~269 true Yes to 679 false Yes.

## The method

Search is unreliable; **verification is exact and cheap**. So: cast a wide net
for *candidate* store URLs, then open each one and judge it on Amazon's own
`brandName` string. Never decide from a search result alone.

### Discovery vectors, in order

1. **Amazon's exact-brand filter** — `/s?k={q}&rh=p_4:{q}` — run over **both**
   the company name and the **domain root**, walking a shortening ladder down
   to the leading token.
2. **Plain search** on the company name, filtered by title tokens.
3. **Plain search on the domain reading.** The `rh=p_4:` filter is exact-match
   and brittle; one apostrophe returns nothing.
4. **Product byline** — open a product and read its "Visit the X Store" link.
   This is the only store link guaranteed to belong to that product's brand.
5. **Search engines** — `site:amazon.com/stores "{term}"` on Bing/DuckDuckGo.
   The only vector that looks for the store *page* rather than for products.
   Note: most datacenter/proxy IPs are blocked by these engines.
6. **Direct slug probe** — `amazon.com/stores/{flattened-brand-or-domain}`
   redirects to the real GUID URL. One request, no search involved; this reaches
   stores whose products never surface in Amazon search at all.

### Search the DOMAIN, not just the brand name

The single highest-value rule in this skill. The domain root predicts the store
slug better than the company name does (measured 15/22 exact vs 12/22 on
hand-confirmed data).

```
simplygum.com   -> query "simply gum" -> /stores/SimplyGum      CORRECT
                -> query "Simply"     -> /stores/SimplyBeverages  WRONG COMPANY
```

Both vectors are required. The domain finds what the name cannot; the name
finds parent brands the domain cannot (a subsidiary's site whose store is the
parent brand's).

**And when the domain query finds products, open THOSE products' bylines
first.** Getting this backwards is subtle and expensive: the domain query can
return the right products while a generic name query's products get their
bylines opened first, so the wrong store wins on a technicality of ordering.

### Brand strings are shorter than company names

Amazon's registered brand routinely drops what the legal name carries:

```
Fromm Family Foods  -> brand "Fromm"
McCormick FONA      -> brand "McCormick"
OLIPOP PBC          -> brand "OLIPOP"
```

Query a shortening ladder — full name, name minus legal suffix, first two
tokens, leading token — and guard the last rung so generic leads ("The",
"Family", "Simply") are never queried alone.

### Verification: judge on Amazon's own brandName

Fetch the candidate store page, read the `brandName` Amazon publishes on it,
and compare against the company name **and its domain**. A subset match in
either direction can be genuine, so equality is the wrong test.

Corroboration must be **brand vs domain**, never company-name vs domain — the
domain is derived from the company name, so that comparison always "matches"
and waves everything through.

## Verdicts — four, not two

| Verdict | Meaning |
|---|---|
| `Yes` | store fetched live AND brandName corroborates |
| `No` | store fetched live AND the brand belongs to someone else, or no candidate exists |
| `Check` | ambiguous — generic one-word brand, weak overlap. Needs a human |
| `Unresolved` | **blocked or unreachable — not measured.** Never fold into `No` |

Collapsing `Unresolved` into `No` is the most common way these pipelines lie.
A blocked fetch is missing data, not evidence of absence.

`Check` is a feature. A store called "Simply" could belong to anyone, and a
wrong-company match is far more expensive than a miss — it puts a real prospect
in front of the wrong pitch. When corroboration fails, say so.

### Activity, if you need it

A store can exist and sell nothing. Count products from a **brand-filtered
search**, never from the store page — that page is a JS shell with no product
IDs in the HTML, which makes every store look dormant.

`0` = exists but sells nothing in that locale. `1-2` = thin. `-1` = could not
measure, which is not zero.

## Running at scale

Serial, this is roughly **1 company/min** (~4-5 requests each, and Amazon is
slow). That is ~42 hours for 2,800 companies — unusable.

Run companies **concurrently**. Measured on a 200-company batch:

| workers | rate | 2,800 companies | block rate | Unresolved |
|---|---|---|---|---|
| 1 | 1.1/min | ~42 h | ~3% | 3% |
| 10 | 8.5/min | ~5.5 h | **32%** | **17%** |
| **4-5** | ~4-5/min | ~10 h | near baseline | low |

**Read that trade-off correctly.** The Yes rate barely moved (27% -> 26%), so
concurrency does **not** corrupt verdicts — it costs *coverage*. More requests
in flight means more blocks, and blocks become `Unresolved`. The failure mode
of too much concurrency is a batch full of holes, not a batch full of lies.

**4-5 workers is the sweet spot.** A high `Unresolved` count is the signal to
lower concurrency, not to re-run at the same setting.

Three things make it safe:

1. **One HTTP session per worker**, each with its own exit IP — this both
   parallelises the work and spreads block risk instead of hammering one
   address.
2. **Atomic cache writes** (`temp` + rename). Workers share a cache directory;
   a half-written file reads back as a corrupt page.
3. **Atomic incremental result writes** after every company.

Concurrency does not change the request count, so it does not change bandwidth
cost. Speed is free here; only the block rate is not.

## Durability — assume the run will be interrupted

Long runs get killed: laptops sleep, sessions end, processes get signalled.
Three rules, each learned by losing data:

1. **Write results after every company**, atomically. Writing only at the end
   means an interruption discards everything, including whatever you paid for.
2. **Support `--resume`** — skip companies already in the output file. With a
   page cache, a relaunch then costs almost nothing.
3. **Never write results to `/tmp`.** OS cleanup purges it and takes the run
   with it. Never wipe the page cache to "start clean" either — it is the only
   thing that makes a re-run free.

## Merging back into a master list

The most dangerous step, because it overwrites. Four rules:

1. **One direction only** — results into the master. Never rebuild the master
   from a source export that has never seen a verdict. Two files both claiming
   to be source of truth is the failure mode.
2. **Timestamped backup before every overwrite**, and write atomically.
3. **Tripwire**: abort if the merge would *reduce* the number of settled
   verdicts. A rebuild that quietly empties columns must fail loudly, not
   "succeed".
4. **Each method owns its own columns.** Keep every method's verdict side by
   side so neither can silently erase the other.

These exist because a rebuild script once destroyed 300 paid verdicts ~90
seconds after they were written — unrecoverable, and paid for twice.

## Hand-check loop

No automated pipeline gets consumer-brand matching right unaided. Ship each
batch as a review sheet: sorted Yes -> Check -> No, clickable store links,
frozen header, blank `YOUR VERDICT` / `YOUR NOTES` columns.

Then **turn every flagged row into a fix plus a regression test.** A matcher
hardened this way — every case drawn from a real false positive — is the only
kind that survives contact with real lists.

## Known limits

- **Brands invisible to Amazon search.** Some stores exist but no query returns
  their products. The slug probe and the search-engine vector are the only ways
  in.
- **Single generic-word brands** (Simply, Neuro, Nourish, True Organic) are
  irreducibly ambiguous. Corroborate via the store page citing the company's
  own domain, or product titles matching the company's category — and when
  neither holds, return `Check` rather than guess.
- **Locale.** A `.ca` or `.co.uk` company may have no amazon.com presence and
  still sell on its local marketplace. Decide which marketplace the ICP means
  before calling anything a No.
