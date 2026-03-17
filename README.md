# Cold Outbound Skills

Open-source [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills) for cold email and outbound sales. Built by [GrowthEngineX](https://growthengine-x.com) from patterns across 1,000+ real B2B campaigns.

Each skill is a self-contained folder with a `SKILL.md` file that teaches Claude how to complete a specific outbound task. No API keys are included — bring your own accounts and credentials.

## Skills

| Skill | What It Does | Accounts Needed |
|-------|-------------|-----------------|
| [Cold Email Copy Grader](./skills/cold-email-copy-grader/) | Grade campaigns 0-100, get risk flags and rewrites | None |
| [Prospeo Full Export](./skills/prospeo-full-export/) | Export entire Prospeo searches to CSV (even 25K+) | [Prospeo](https://prospeo.io) |
| [Google Maps Scraper](./skills/google-maps-scraper/) | Scrape business listings by query + location, export to CSV | [RapidAPI](https://rapidapi.com/alexanderxbx/api/maps-data) |

---

### Cold Email Copy Grader

Grade your cold email campaigns on a 0-100 scale. Paste your draft sequences and targeting details, get back a score, risk flags, benchmark comparisons, and full copywriting rewrites when your copy needs work.

- Score breakdown by copywriting quality, targeting, and personalization
- Risk assessment catching 15 anti-patterns (spam triggers, bump-only follow-ups, weak CTAs)
- Benchmark comparison against top-performing campaigns
- Full rewrites when your score is below 65
- Quick grade mode for a fast gut check

**No external accounts needed.** Everything runs from the patterns baked into the skill.

**Key finding:** Generic AI personalization — where AI describes what the prospect's company does — has a 71% poor rate. It performs 4x worse than no personalization at all.

See the [worked example](./skills/cold-email-copy-grader/examples/before-and-after.md) showing a campaign go from 38 to 66.

---

### Prospeo Full Export

Export your entire [Prospeo](https://prospeo.io) people search to CSV. Build your search in Prospeo's UI, then let Claude pull every single result via the API — even searches over 25,000 results.

- Translates your Prospeo UI filters into API calls automatically
- Paginates through every page and exports to CSV
- Handles rate limiting and retry logic
- Deduplicates contacts by LinkedIn URL
- Automatically splits US-wide searches by state to bypass the 25K result cap

**Requires:** A [Prospeo](https://prospeo.io) account with API credits. The skill walks you through signup and API key setup.

---

### Google Maps Scraper

Scrape Google Maps for business listings by search query and location. Give it "pizza restaurant" and a state, city, or list of zip codes — get back structured data (name, address, phone, website, rating, reviews, coordinates) as a CSV.

- Searches by query + zip code, city, or entire US state
- Bundled with 42,734 US zip codes (filter by state, city, or population)
- Rate limiting (2 req/sec) with automatic retries
- Deduplicates results across overlapping zip code searches
- Run as a local CLI or deploy as a web app
- Export to CSV

**Requires:** A [RapidAPI](https://rapidapi.com) account with a subscription to the [Maps Data API](https://rapidapi.com/alexanderxbx/api/maps-data) (free tier available).

```bash
# Scrape all pizza places in Texas (populated zips only)
npm run scrape -- --query="pizza restaurant" --state=TX --min-pop=5000

# Scrape dentists in specific NYC zip codes
npm run scrape -- --query="dentist" --zips=10014,10013,10012
```

---

## Installation

### Claude Code (Recommended)

Copy any skill folder into your Claude Code skills directory:

```bash
# Clone the repo
git clone https://github.com/growthenginenowoslawski/coldoutboundskills.git

# Copy the skills you want
cp -r coldoutboundskills/skills/cold-email-copy-grader ~/.claude/skills/
cp -r coldoutboundskills/skills/prospeo-full-export ~/.claude/skills/
cp -r coldoutboundskills/skills/google-maps-scraper ~/.claude/skills/
```

Then just mention the task in Claude Code:
- "Grade this cold email" (triggers the copy grader)
- "Export my Prospeo search to CSV" (triggers the Prospeo exporter)
- "Scrape Google Maps for dentists in Texas" (triggers the maps scraper)

### Manual Use (Any LLM)

Each `SKILL.md` file works as a standalone system prompt. Copy the contents into any LLM's system prompt or context window and it will follow the instructions.

## How Skills Work

A skill is just a folder containing a `SKILL.md` file with:
- **YAML frontmatter** (`name` and `description`) so Claude knows when to use it
- **Markdown instructions** that Claude follows when the skill is active

```
skills/
  my-skill/
    SKILL.md          # Instructions and metadata
    examples/         # Optional: worked examples
```

For more on creating skills, see Anthropic's [skill creation guide](https://support.claude.com/en/articles/12512198-creating-custom-skills).

## Contributing

Have a cold outbound workflow that could be a skill? Open a PR. Each skill should be:

- **Self-contained** — no dependencies on other skills or internal tooling
- **API-key-free** — never hardcode credentials; use environment variables
- **Beginner-friendly** — include setup instructions for someone who's never used the platform

## License

MIT License. See [LICENSE](LICENSE).

## Credits

Built by [GrowthEngineX](https://growthengine-x.com). Data from real campaigns run across dozens of industries.
