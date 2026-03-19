# Cold Outbound Skills

Open-source [Claude Code skills](https://docs.anthropic.com/en/docs/claude-code/skills) for cold email infrastructure, lead sourcing, and copywriting. Built by [GrowthEngineX](https://growthengine-x.com) from patterns across 1,000+ real B2B campaigns.

Each skill is a standalone `SKILL.md` file that gives Claude deep expertise in a specific cold outbound workflow. No API keys included — bring your own.

## Skills

| Skill | What It Does | API Keys Needed |
|-------|-------------|-----------------|
| [Cold Email Copy Grader](skills/cold-email-copy-grader/) | Grades your cold email campaigns 0-100. Scores copywriting, targeting, and personalization. Catches the AI personalization trap (71% poor rate). Rewrites bad copy. | None |
| [Domain Setup: Dynadot + Zapmail](skills/domain-setup-dynadot-zapmail/) | End-to-end domain setup — generate short names, check availability, purchase on Dynadot, switch nameservers, connect on Zapmail, create inboxes, export to your sending platform. | Dynadot, Zapmail |
| [Google Maps Scraper](skills/google-maps-scraper/) | Scrape Google Maps for business listings by query + location. Returns name, address, phone, website, rating, reviews, coordinates. Includes 42K US zip code database for state/city-wide scrapes. | RapidAPI |
| [Prospeo Full Export](skills/prospeo-full-export/) | Export your entire Prospeo people search to CSV — even searches over 25K results. Handles pagination, rate limiting, deduplication, and automatic state-by-state splitting. | Prospeo |

## Installation

### Option 1: Install a Single Skill

Copy the skill folder into your Claude Code skills directory:

```bash
# Clone the repo
git clone https://github.com/growthenginenowoslawski/coldoutboundskills.git

# Copy the skill you want
cp -r coldoutboundskills/skills/cold-email-copy-grader ~/.claude/skills/
```

Claude Code will automatically detect skills in `~/.claude/skills/`.

### Option 2: Install All Skills

```bash
git clone https://github.com/growthenginenowoslawski/coldoutboundskills.git
cp -r coldoutboundskills/skills/* ~/.claude/skills/
```

### Option 3: Use as a System Prompt

You can also copy the contents of any `SKILL.md` file directly into a system prompt for any LLM. The scoring methodology, API references, and workflows work independently of Claude Code. Copy the contents of `SKILL.md` into your system prompt and paste your campaign copy.

## Skill Details

### Cold Email Copy Grader

Paste your draft email sequences and targeting details. Get back a score, risk flags, benchmark comparisons, and full copywriting rewrites when your copy needs work.

**What you get:**
- Score (0-100) broken down by copywriting quality (40%), targeting (35%), and personalization (25%)
- Risk flags that catch the 15 most common anti-patterns
- Benchmark comparison against top-performing campaigns
- Full rewrites when your score is below 65
- Quick grade mode for a fast gut check

**The most important finding:** Generic AI personalization — where AI describes what the prospect's company does — has a 71% poor rate and performs 4x worse than no personalization at all. The skill catches this automatically.

**No dependencies.** No API keys, no database, no external tools. Everything runs from patterns baked into the skill.

See [examples/before-and-after.md](skills/cold-email-copy-grader/examples/before-and-after.md) for a full worked example (score: 38 → 66).

---

### Domain Setup: Dynadot + Zapmail

Automates the entire cold email domain lifecycle:

1. **Generate** short domain name candidates using prefix/suffix patterns
2. **Check availability** via Dynadot API (batch 100 at a time)
3. **Purchase** available domains on Dynadot
4. **Switch nameservers** to Zapmail's DNS
5. **Connect** domains on Zapmail
6. **Create inboxes** (2 per domain)
7. **Export** to your email sending platform (Smartlead, Instantly, and 14 others)

**Includes onboarding** for first-time users — walks you through getting API keys, storing them safely, and verifying access.

**Requires your own API keys:**
- Dynadot API key (for domain registration)
- Zapmail API key (for inbox provisioning)

**Covers all the gotchas** we learned from setting up 500+ domains: DNS propagation timing, batch failure retries, comma encoding bugs, provisioning wait times, and more.

---

### Google Maps Scraper

A self-contained tool for scraping business listings from Google Maps. Give it a search query (e.g., "pizza restaurant") and a location (zip code, city, or state), and it returns structured data for every matching business.

**Features:**
- CLI tool and optional web app with CSV export
- Bundled database of 42,734 US zip codes with population data
- Search entire states or filter by minimum population
- Rate limiting, retries, and automatic deduplication
- Deployable to Railway, Render, Fly.io, or any Node.js host

**Requires:** A [RapidAPI](https://rapidapi.com) key with a subscription to the [Maps Data API](https://rapidapi.com/alexanderxbx/api/maps-data).

---

### Prospeo Full Export

Extract your entire Prospeo people search to a CSV file. Build your search in Prospeo's web UI, describe the filters to Claude, and it pulls every single result via the API.

**Features:**
- Automatic pagination through all results
- State-by-state splitting for US searches over 25K results (bypasses the 25K API cap)
- Deduplication by LinkedIn URL across states
- Credit cost estimation before running
- Rate limiting and exponential backoff

**Requires:** A [Prospeo](https://prospeo.io) API key with credits for the Search Person API.

---

## What Are Claude Code Skills?

[Skills](https://docs.anthropic.com/en/docs/claude-code/skills) are markdown files that give Claude specialized knowledge and workflows. When you place a `SKILL.md` file in `~/.claude/skills/`, Claude Code automatically loads it and can use that expertise in conversations.

Think of skills as reusable playbooks — they encode domain knowledge, API references, scoring rubrics, and step-by-step workflows that Claude can execute on demand.

## Contributing

Want to add a skill? Create a folder in `skills/` with a `SKILL.md` file following this format:

```yaml
---
name: skill-name
description: What the skill does and when to use it.
---

# Skill Name

[Instructions, API references, workflows, etc.]
```

Open a PR and we'll review it.

## License

MIT License. See [LICENSE](LICENSE).

## Credits

Built by [GrowthEngineX](https://coldoutbound.com). Data from real campaigns run across dozens of industries.
