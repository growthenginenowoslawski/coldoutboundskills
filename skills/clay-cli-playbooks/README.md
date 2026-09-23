# Clay CLI playbooks (tested)

The 19 signal playbooks from [`skills/playbooks/`](../playbooks/), rebuilt to run on the
**Clay CLI alone** and tested live in a real Clay workspace on 2026-09-23 (CLI 1.3.0,
`@claypi/cli`). Each folder is a self-contained skill in the format Clay's marketplace uses,
and all 19 pass Clay's own validator
([clay-skill-creator](https://github.com/sungwanjo-clay/clay-skill-creator)) with 0 blocking and
0 report findings.

## What you need

- The Clay CLI, signed in: `npm i -g @claypi/cli`, then `clay login` (use `clay login --device` on a
  headless machine). Install `@claypi/cli`, not `@clayhq/clay-cli`: that one is an unrelated package.
- An AI agent to run the skill (Claude Code, Codex or Cursor).
- No other API keys. Two skills rely on one outside service each, and both say so up front:
  `google-search-site-filter` (an Apify Google-search actor on your own connected Apify account) and
  `job-posting-language` (companies' public job-board APIs, no key needed).

## How they work

- **Clay supplies the facts; your agent does the judgment.** Clay search, workflow nodes and Clay's
  managed functions fetch the data. The agent reading the skill writes the copy line or the
  verdict, so you don't need a Clay AI column or an OpenAI key.
- **Free before paid.** Clay search, code nodes, Clay's utility actions, and the zero-credit
  managed Enrich Company and Enrich Person functions run first. Every paid step is named by its
  exact action, priced from your live catalogue, and asked about before it runs.
- **One approval gate.** Each skill runs a 10-row batch, then shows you the output, the cost and
  anything it would write in one message, and waits for your yes.
- **Nothing is written to your CRM or sequencer.** Every skill hands its results back to you.

## Status

PASS means every step ran end to end on Clay. PARTIAL means the free path ran end to end, and one
named paid Clay step was priced from its live schema but not run, because the test workspace had no
spare credits. Each skill lists exactly what was not run in its `## What this skill does not claim`
section.

| Skill | Replaces | Status | Measured in the live test |
|---|---|---|---|
| `ad-library` | `playbook-ad-library` | PASS | 8 domains → 4 lines; a keyword ad search found 3 of 5 brands where the name search found 0 |
| `ai-specificity` | `playbook-ai-specificity` | PARTIAL | 11 → 8 send, 1 no-fit, 2 no-data; the paid page read (~1 credit) was not run |
| `case-study-page` | `playbook-case-study-page` | PASS | 12 → 10 lines, 1 correct abstain, 1 true negative |
| `company-name-cleaning` | `playbook-company-name-cleaning` | PASS | 32 → 27 send; a raw-string check catches all 7 formatter misses |
| `creative-ideas` | `playbook-creative-ideas` | PASS | 10 enriched → 7 ready; the identity check caught 2 wrong-company returns |
| `first-name-cleaning` | `playbook-first-name-cleaning` | PASS | 55 → 46 send; Clay's formatter alone got 10 of 55 wrong |
| `fundraising` | `playbook-fundraising` | PARTIAL | free list and eligibility path ran on 12; the round lookup (~4–6.4 credits/row) was not run |
| `google-search-site-filter` | `playbook-google-site-search` | PARTIAL | 6 → 4 usable; search runs on Apify through Clay |
| `hiring-surge` | `playbook-hiring-surge` | PASS | 6 department verdicts; title review cut 10 "starts" to 2 at one account |
| `job-posting-language` | `playbook-job-posting-language` | PASS | 10 → 4 matched, 3 in the role family, 1 quoted line with link and date |
| `linkedin-engagement` | `playbook-linkedin-engagement` | PASS | 1 post → 9 engagers → 8 unique → 1 for review |
| `lookalikes` | `playbook-lookalikes` | PASS | 35 judged; literal product phrases beat semantic search 4/10 to 1/10 |
| `name-2-other-prospects` | `playbook-name-to-other-prospects` | PASS | 6 → 6 phrases; caught 4 of 85 "current" staff who had left |
| `new-in-role` | `playbook-new-in-role` | PASS | 10 → 10 lines; job history caught 2 promotions |
| `pricing-page` | `playbook-pricing-page` | PASS | 11 → 5 verified pricing records; an invented price is rejected |
| `social-link-finding` | `playbook-social-link-finding` | PARTIAL | LinkedIn 8 of 9 free; other platforms from 5 homepage reads on Apify |
| `social-posts` | `playbook-social-posts` | PASS | 9 → 6 kept; an author check rejected posts written by other accounts |
| `tech-on-website` | `playbook-tech-on-website` | PARTIAL | 13 → 13 verdicts; the free check sees response headers and JSON only |
| `warm-intros` | `playbook-warm-intros` | PASS* | 10 → 0 (correct for that ICP); heavier multi-filter searches timed out and are untested |

The numbers above come from one workspace on one day. They show that each mechanism works and where
it breaks, not how much any segment will yield.

## Install

Point your agent at a folder, or copy the ones you want into your skills directory:

```bash
cp -R skills/clay-cli-playbooks/pricing-page ~/.claude/skills/
```

## Validate and package for Clay's marketplace

```bash
git clone https://github.com/sungwanjo-clay/clay-skill-creator /tmp/clay-skill-creator
skills/clay-cli-playbooks/package.sh /tmp/clay-skill-creator    # -> skills/clay-cli-playbooks/dist/<skill>.zip
```

The script copies each skill to a clean temporary folder, runs Clay's validator on it, and writes a
ZIP only when the validator reports no blocking findings.
