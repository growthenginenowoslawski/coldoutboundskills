# Cold Outbound Skills

Open-source [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) for cold email infrastructure, lead sourcing, copywriting, and operations. Built by [GrowthEngineX](https://growthengine-x.com) from patterns across 1,000+ real B2B campaigns.

31 skills that work together. Clone the repo, bring your API keys, point Claude Code at it, go from zero to a running campaign.

**New here?** Invoke `/cold-email-kickoff` — it's the guided entry point that orchestrates ICP + lead magnet + strategy + plan in one flow.

## What's in here

32 skills organized in 5 tracks, plus 19 signal playbooks in Track 6 — each shipping three ways (a Claude skill, a Clay table build, and a Clay CLI workflow).

**New to cold email? Start with `/cold-email-kickoff`.** It orchestrates ICP → lead magnet → campaign strategy → plan in one guided flow.

### Track 1 — Strategy (before you send anything)
- **`cold-email-kickoff`** — single "start here" orchestrator (recommended entry point)
- **`icp-onboarding`** — conversational intake that produces a `client-profile.yaml` (scrapes website first)
- **`lead-magnet-brainstorm`** — figure out what to offer for free in your cold emails
- **`campaign-strategy`** — generates 15-25 campaign ideas with AI strategies + value props
- **`campaign-copywriting`** — stepwise copy writer (direction → subject → body → final YAML)

### Track 2 — Infrastructure
- **`zapmail-domain-setup-public`** — buy `.com`/`.co` domains on Dynadot, provision inboxes on Zapmail
- **`smartlead-inbox-manager`** — warmup settings, signatures (name/title/company/address), active/insurance tagging
- **`email-deliverability-audit`** — diagnostic tool (SPF/DKIM/DMARC, spam placement, the 1% rule)
- **`deliverability-incident-response`** — triage playbook for spam, bounces, blacklists, warmup blocks
- **`inbox-lifecycle-manager`** — the weekly keep/cancel/promote/buy loop: which domains are burned, what replaces them, how many to buy

### Track 3 — List Building
- **`list-builder`** — the meta skill for any list request: one-command lanes that sweep every source, AI-qualify every company, snowball until the market is dry, then pull uncapped contacts and find emails
- **`perfect-company-list`** — the SCULPT 2026 method: learn the industries your customers actually use, pull all of them, judge every row with a cheap model (Jev), then a Claygent lookalike loop until it runs dry. Includes real coverage numbers against the FDIC, SEC and NJ school registries
- **`list-expander`** — turn ~10 known-good seed companies into a full qualified TAM (fingerprint → lookalikes → mined filters → wide pull → AI qualification → live-site verify)
- **`prospeo-full-export`** — title-first lead search (paginated, 25K+)
- **`prospeo-search-api`** — Prospeo filter reference
- **`blitz-list-builder`** — domain-first contact discovery
- **`google-maps-list-builder`** — scrape Google Maps for local SMB lists
- **`disco-like`** — lookalike company discovery (seed domains or NL ICP text)
- **`competitor-engagers`** — find people engaging with competitor LinkedIn posts
- **`icp-prompt-builder`** — required qualification step invoked by every list-building skill
- **`list-quality-scorecard`** — grade a lead CSV across 8 dimensions before uploading
- **`amazon-brand-store-finder`** — confirm a company runs its own Amazon brand storefront (not just reseller listings) and return the store URL — deterministic, no LLM, no paid search API

### Common Outbound Lists (bundled CSVs)

Ready-to-filter company dumps in [`Common Outbound Lists/`](Common%20Outbound%20Lists/). These are **companies, not people** — feed them to `/list-builder` as `extra_candidates`, then run `/icp-prompt-builder` before contact pull.

| List | Rows | What it is |
|---|---|---|
| [Shopify Stores — 259K Active](Common%20Outbound%20Lists/shopify-stores-259k-active.csv.zip) | 259,293 | Shopify stores with ≥1k estimated monthly visits. Columns: `domain`, `merchant_name`, `description`, `company_linkedin` (65% fill). Notes: [shopify-stores-259k-active.md](Common%20Outbound%20Lists/shopify-stores-259k-active.md) |
| [Google Maps Scrape — 12M US Businesses](Common%20Outbound%20Lists/Google%20Maps%20Scrape%20-%2012M%20US%20Businesses/) | ~12.3M | US local businesses (13 zip parts). Grep `category_titles` first |
| [US Software / SaaS companies](Common%20Outbound%20Lists/us-software-saas-companies-cleaned.zip) | ~173K | Cleaned software/SaaS company list |
| [US zip codes](Common%20Outbound%20Lists/us-zip-codes.csv) | 42,734 | Zip / city / state / lat-lng / population — used by `/google-maps-list-builder` |

### Track 4 — Copy & Send
- **`cold-email-starter-kit`** — the 14-step end-to-end tutorial (alternative to `/cold-email-kickoff`)
- **`spam-word-checker`** — scan copy for deliverability-killing phrases
- **`smartlead-spintax`** — add spintax variations to emails
- **`smartlead-api`** — Smartlead API reference
- **`smartlead-campaign-upload-public`** — DRAFT-upload leads.csv + variants.yaml to Smartlead (always DRAFT, you hit Start manually)

### Track 5 — Iterate & Automate
- **`positive-reply-scoring`** — the metric that matters (positive replies / total sent)
- **`experiment-design`** — single-variable experiment framework
- **`auto-research-public`** — autonomous campaign launcher (scrape → ICP → leads → personalize → upload)
- **`personalization-subagent-pattern`** — reusable pattern for per-lead Claude sub-agent personalization
- **`deliverability-test-public`** — compare reply/bounce by inbox type
- **`cold-email-weekly-rhythm`** — Monday/Wednesday/Friday operational playbook — what separates hobbyist from top-1%


### Track 6 — Signal Playbooks

Nineteen playbooks, each turning **one buying signal into one copy-ready sentence**. They live
together in **[`skills/playbooks/`](skills/playbooks/)** — start at
[`clay-playbooks`](skills/playbooks/clay-playbooks/) for the index and the two build harnesses.

Every playbook ships the same three files:

| File | What it is |
|---|---|
| `SKILL.md` | the playbook: source chain, output contract, locked prompt, edge cases |
| `clay-table.md` | the Clay **table** build — columns, formulas, credit gates (browser-driven) |
| `clay-workflow.md` | the Clay **workflow** build via the `clay` CLI (terminal-driven) |

*Tables are browser-driven and workflows are CLI-driven because of a real constraint: the `clay` CLI
is read-only for tables, but can create, edit and publish workflows.*

- **Person signals** — `new-in-role` · `linkedin-engagement` · `social-posts` · `warm-intros`
- **Company signals** — `fundraising` · `hiring-surge` · `job-posting-language` · `ad-library`
- **Website signals** — `pricing-page` · `case-study-page` · `tech-on-website` · `google-site-search`
- **List shaping** — `company-name-cleaning` · `first-name-cleaning` · `social-link-finding` · `lookalikes` · `name-to-other-prospects`
- **Copy generation** — `ai-specificity` · `creative-ideas`

⚠️ Each `SKILL.md` carries a verification line saying what was actually run and on how many rows. The
`clay-table.md` and `clay-workflow.md` files are documented recipes that **have not been built and run
in a live Clay workspace** — written against the real Clay action catalog and CLI surface, but treat
them as specifications: build one, run 5 rows, read the output, fix the file.

## Getting started

### 1. Install Claude Code

This repo is designed for Claude Code. Install from https://claude.com/claude-code.

### 2. Clone and configure

```bash
git clone <this-repo-url> ~/cold-email-ai-skills
cd ~/cold-email-ai-skills
cp .env.example .env
# Edit .env with your API keys (you don't need all of them — only the skills you'll use)
```

### 3. Install dependencies

```bash
npm install -g tsx
cd skills/cold-email-starter-kit
npm install
```

### 4. Verify credentials

```bash
npx tsx skills/cold-email-starter-kit/scripts/verify-credentials.ts
```

### 5. Start with the kickoff orchestrator

If you've never run cold email before, invoke the kickoff skill from Claude Code:

```
/cold-email-kickoff
```

It asks whether you have infrastructure already, then orchestrates ICP + lead magnet + campaign strategy + plan in a single guided flow. Produces a `campaign-plan.md` and hands you off to the right next skill based on your current state.

Alternative: `/cold-email-starter-kit` — the longer manual 14-step tutorial. Use this if you want to learn each piece deeply rather than move fast.

## API keys required (bring your own)

| Service | Env var | What it's for | Skills that use it |
|---|---|---|---|
| Smartlead | `SMARTLEAD_API_KEY` | Send emails, manage inboxes | inbox-manager, starter-kit, auto-research, audit, scoring |
| Prospeo | `PROSPEO_API_KEY` | List building (title-first) | prospeo-*, auto-research |
| Dynadot | `DYNADOT_API_KEY` | Buy domains | zapmail-setup |
| Zapmail | `ZAPMAIL_API_KEY` | Create inboxes | zapmail-setup |
| MillionVerifier | `MILLIONVERIFIER_API_KEY` | Validate emails before sending | waterfall, auto-research |
| Blitz | `BLITZ_API_KEY` | Domain-to-contacts lookup | blitz-list-builder |
| RapidAPI | `RAPIDAPI_KEY` | Google Maps scraping, LinkedIn data | google-maps-*, competitor-engagers |
| Instantly | `INSTANTLY_API_KEY` | Alternative sending platform | starter-kit (09) |
| OpenWebNinja | `OPENWEBNINJA_KEY` | Company news enrichment | starter-kit (07) |
| OpenRouter | `OPENROUTER_API_KEY` | AI company analysis enrichment | starter-kit (07), competitor-engagers |

The minimum viable setup for your first campaign is: **Dynadot + Zapmail + Prospeo + Smartlead**. Start there, add more as you need them.

## Recommended path

**If you've never run cold email:**
1. `/cold-email-kickoff` — one guided flow: ICP → lead magnet → strategy → plan → next-skill menu
2. Follow the menu's recommended next skill (infra setup OR list building, depending on your current state)
3. After campaign launch, wait 21 days, then `/positive-reply-scoring`
4. Add `/cold-email-weekly-rhythm` to your calendar for ongoing ops

**If you have experience but no automation:**
1. `/icp-onboarding` — lock down your ICP
2. `/smartlead-inbox-manager` — configure your existing inboxes properly
3. `/email-deliverability-audit` — fix any domain/inbox issues before scaling
4. `/auto-research-public` — daily automated campaign launches

**If you're debugging a broken campaign:**
1. `/email-deliverability-audit` — find the infrastructure issue
2. `/positive-reply-scoring` — see if replies are positive or hostile
3. `/deliverability-test-public` — compare across inbox types
4. `/spam-word-checker` — scan copy for banned phrases
5. `/inbox-lifecycle-manager` — if a domain is confirmed burned, cancel and replace it safely

**If your inbox bill is too high, or you're under your send goal:**
1. `/inbox-lifecycle-manager` — the plan: what's burned, what to promote, what to buy (read-only)
2. `/email-deliverability-audit` — confirm *why* before cancelling anything
3. `/smartlead-inbox-manager` — execute the approved tag changes
4. `/zapmail-domain-setup-public` — buy the replacements (a month before you need the sends)

## Directory layout

```
cold-email-ai-skills/
  README.md                    # this file
  .env.example                 # template for your API keys
  Common Outbound Lists/       # pre-built company CSVs (Shopify, Maps, SaaS)
  skills/
    <skill-name>/
      SKILL.md                 # the skill definition (required)
      scripts/                 # runnable code
      references/              # deeper docs
  profiles/                    # YOUR client profiles + experiment logs (gitignored)
    <business-slug>/
      client-profile.yaml
      experiments/
      scores/
```

## Cost expectations

First campaign (2,000 leads, 20 domains, 40 inboxes):
- Domains: ~$240 one-time (20 × ~$12 .com). Fall back to .co (~$8-30) if .com is taken.
- Zapmail: ~$60/mo for 40 inboxes
- Prospeo: ~$20 for 2,000-lead export
- Smartlead: ~$39/mo starter plan
- MillionVerifier: ~$5 for 2,000 validations
- **Month 1 total: ~$360. Recurring: ~$130/mo.**

See `skills/cold-email-starter-kit/references/00-getting-started.md` for full breakdown.

## A note on ethics

Cold email is legal when done right, but it's a privilege. Don't spam. Don't email consumers. Honor unsubscribes instantly. Include a real physical address. Be the kind of sender you'd want to receive email from.

The best cold emails are the ones the recipient is glad they got.

## Contributing

This repo is a collection of patterns refined over thousands of real campaigns. Improvements welcome — PRs should include:
- Real-world test results (not theoretical changes)
- Generalizable insight (not hyper-specific to one industry)
- Keep beginner-friendliness as the north star

## License

MIT — use it, fork it, profit from it. Attribution appreciated but not required.
