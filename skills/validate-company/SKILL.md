---
name: validate-company
description: >-
  Validate / qualify a CSV or list of companies against ANY criteria the user
  cares about — what services they offer, what industry they're in, what tech
  they use, whether they have a given attribute — by reading each company's
  website and tagging it Yes / No / Not Accessible plus the evidence found, then
  writing the answer back to a new CSV. Works for any industry or field: SEO/GEO
  agencies, PPC shops, e-commerce brands on Shopify, SaaS with a demo CTA, clinics
  offering a treatment, manufacturers of X — whatever. Use this skill WHENEVER the
  user hands over a company/lead list (any CSV with a website or domain column) and
  wants to know which ones match something, qualify a prospect list, filter leads
  by an attribute, or "check what these companies do / are" from their sites — even
  if they don't say "skill". It interviews the user first to learn the target and
  keywords, then runs a deterministic, near-zero-token pipeline (free website fetch
  → Exa fallback → keyword classify → merge). This is the cheap, no-sub-agent-fan-out
  way to validate company lists at scale — prefer it over spawning Task sub-agents
  to read sites one by one.
---

# validate-company

Validate a list of companies against **any** criteria — cheaply.

## Why this exists
The naive way — one Claude Code Task sub-agent per company to WebFetch + judge —
burns ~30k+ tokens per handful of rows and stalls at scale (a 463-row run cost
~1M+ tokens). This skill **separates fetching from judging**: pull website text
deterministically (free HTTP, then Exa only where blocked), then classify by
keyword match. Validating a 500-row list costs **~0 tokens and under ~$0.50 of
Exa**. Never fan out sub-agents for this.

The thing being validated is **not hardcoded**. You interview the user, turn their
target into a keyword set, and the same engine validates anything.

## Step 0 — INTAKE (do this first, every time)
Before running anything, ask the user (in one short message) and wait for answers:

1. **The list** — path to the CSV. (Must have a company-name-ish column and a
   website/domain column; both are auto-detected, any headers work.)
2. **What are you validating for?** — the target in plain words. E.g. "agencies that
   offer SEO/GEO services", "brands running their store on Shopify", "SaaS companies
   with a 'book a demo' CTA", "clinics offering dental implants".
3. **Keywords / signals** — the words or phrases that, if found on the site, prove a
   match. Either the user gives them, or **you propose a strong list and let them
   edit**. Include synonyms and other languages when relevant (e.g. French + English
   for FR markets). Think about what actually appears on such a company's website.
4. **Exa key** — for the fallback steps, confirm `EXA_API_KEY` is set (env or a
   `.env` in the working dir). The free fetch + classify steps run without it.

Then write their answers to `<workdir>/.tmp/criteria.json` (schema below). The
scripts read this file — it is what makes the validation about *their* target.

### criteria.json schema
```json
{
  "target": "SEO/GEO agencies",
  "match_column": "SEO Services Found",
  "detail_column": "Services Identified",
  "highlight_query": "SEO référencement GEO SEA Google Ads search marketing netlinking",
  "keywords": [
    ["référencement naturel", "Référencement naturel"],
    ["google ads", "Google Ads"],
    "netlinking",
    [" seo", "SEO"]
  ],
  "service_paths": ["/services", "/prestations", "/referencement", "/seo"]
}
```
- `target` — human label, used only in your report.
- `match_column` / `detail_column` — the two column headers added to the output CSV.
  Name them for the target (e.g. "Uses Shopify" / "Evidence"). Defaults:
  "Match Found" / "Details".
- `highlight_query` — free-text query Exa uses to pull the most relevant sentences.
  Pack it with the target's vocabulary.
- `keywords` — the match list. Each item is either `"needle"` or `["needle","Label"]`.
  Matching is **lowercased substring** over the page text + highlights. Mind word
  boundaries to avoid false hits — prefer `" seo"`/`"seo "` over bare `"seo"`, and
  avoid short fragments that appear inside unrelated words.
- `service_paths` — subpages the multi-page pass fetches for "No" rows (services often
  aren't on the homepage). Tailor to the target/language; defaults are agency-ish.

## Output
A new CSV (original untouched) with two appended columns named by `match_column` /
`detail_column`: a verdict (Yes / No / Not Accessible) and the evidence
(comma-separated matched signals, or None / N/A).

## The tools
Two stdlib Python scripts in `scripts/` next to this file:
- `scripts/seo_qualify.py` — `split` (CSV → batches) and `merge` (results → CSV).
- `scripts/seo_scrape_exa.py` — `--fetch-free`, Exa scrape (default), `--multipage-no`,
  `--classify-kw`.

(Names are historical — the engine is criteria-driven, not SEO-specific.) All paths
resolve against the **current working directory** (`.tmp/`, `.env`, output CSV land
there). Run from the user's project dir, or set `VALIDATE_COMPANY_WORKDIR=/path`.

## Pipeline — run in order, from the dir holding the CSV
```
SKILL=~/.claude/skills/validate-company/scripts

# (intake done; criteria.json written to ./.tmp/criteria.json)

# 1. SPLIT — stable row_id, normalize URLs, write .tmp/seo_batches/.   ($0, 0 tokens)
python3 "$SKILL/seo_qualify.py" split --in "INPUT.csv"

# 2. FREE FETCH — stdlib HTML-to-text, https→http, lenient TLS.        ($0, 0 tokens)
#    Reachable sites cached to .tmp/seo_pages/; blocked ones flagged.
#    Can be slow (blocked sites time out) — run in the background.
python3 "$SKILL/seo_scrape_exa.py" --fetch-free

# 3. EXA FALLBACK — only rows the free fetch couldn't read. Needs EXA_API_KEY.  (~$0.002/row)
python3 "$SKILL/seo_scrape_exa.py"

# 4. CLASSIFY — keyword scan of cached text. Yes/No; blocked+empty → Not Accessible.  ($0, 0 tokens)
python3 "$SKILL/seo_scrape_exa.py" --classify-kw

# 5. MERGE — join to a results CSV.                                    ($0, 0 tokens)
python3 "$SKILL/seo_qualify.py" merge --in "INPUT.csv" --out "INPUT - RESULTS.csv"
```

### Optional step 6 — recover "No" false-negatives (recommended)
Free fetch reads only the homepage; matches often live on subpages. This pass fetches
`service_paths` via Exa for every current "No" row, re-scans, and reclassifies
parked/placeholder homepages as Not Accessible. Run **before** the final merge (it
writes a result file that overrides step 4 for those rows). Cost ≈
`0.002 × len(service_paths) × (# No rows)`, still 0 tokens.
```
python3 "$SKILL/seo_scrape_exa.py" --multipage-no
python3 "$SKILL/seo_qualify.py" merge --in "INPUT.csv" --out "INPUT - RESULTS.csv"
```

## Crash-safety / resume
Every step is incremental and re-runnable. `--fetch-free` skips rows cached `ok`; Exa
skips rows with text; `merge` joins whatever exists and prints which batches to rerun.
For a fresh run on a NEW list, first archive/clear `.tmp/seo_batches`, `.tmp/seo_pages`,
`.tmp/seo_results` (and rewrite `.tmp/criteria.json`) so old results don't leak in.

## Reporting back
After merge, report the verdict distribution (Yes / No / Not Accessible) and output
path. Be honest about confidence: `Yes` = signal literally on the site; `No` after
step 6 is solid; `Not Accessible` = neither free fetch nor Exa could read it. Offer to
spot-check rows by reading cached pages from `.tmp/seo_pages/` (free) — not re-fetching.

## Hard rules
- Always do intake and write `criteria.json` first — never assume the target is SEO.
- Never fan out Task sub-agents to fetch/judge sites one by one — the token-burn this
  skill exists to replace.
- Don't touch the input CSV; always write a new `- RESULTS.csv`.
- Don't spend on Exa for rows the free fetch already read.
