---
name: acc-lvl-personalized-opener-writer
description: >
  Account-level interactive skill for writing tight 1-2 sentence personalized cold email
  openers from a research column or signal data tied to specific target companies/accounts.
  Interviews the user first about the product/service being sold, the target industry, today's
  date, banned words for the campaign, and the email body the opener bridges into — then
  generates research-anchored, timeline-aware, single-event openers that pass a strict audit
  (no em dashes, no flattery, no banned terms, empathy phrase required, 25-35 words). Use
  whenever the user wants to "write personalized snippets", "personalize this list", "write
  opener lines from research", has a CSV with a research/signals column and wants per-account
  opener copy, or wants to generate the personalized first line that bridges into a cold email
  body. Trigger on phrases like "write me personalized openers", "personalize this CSV",
  "write the first line for these accounts", "turn this research into snippets", "personalize
  the opener for these companies", "account-level personalization".
---

# Account-Level Personalized Opener Writer

Writes tight, peer-to-peer cold email opener lines that bridge into the email body. Each output is the personalized first 1-2 sentences a sender drops in front of a templated email — research-anchored, single-event, timeline-aware, ~25-35 words.

This skill applies to **any** cold email campaign in any industry. The universal rules are baked in. The campaign-specific bits (product, industry, banned words, the email body) are collected from the user upfront in an interactive interview.

## Why this exists

Most personalized openers fail because they sound like briefing notes ("Saw your team won X award and you also expanded to Y...") rather than a colleague observing something at an industry event ("Saw you closed Series B back in October. I'm guessing the pressure on hiring and pipeline coverage is already starting to build."). The difference is small in word count but huge in how the reader receives it.

Three failure modes this skill prevents:

1. **Stacking events** — a real person notices one thing, not three. Cramming an acquisition + an award + a hire into one opener reads as a report, not an observation.
2. **Stale framing** — saying "the pressure is just starting to build" about an event from 18 months ago is obviously wrong. The reader notices and dismisses the email.
3. **Data-speak implications** — "real-time visibility into the floor" sounds like a vendor pitch. "Keeping inventory and scheduling tight across both sites" sounds like a peer.

## When to use this skill

- User has a CSV with a `Research` column (or similar named column with per-lead signal data) and wants per-lead opener copy
- User pastes research about one or more companies and asks for personalized first lines
- User says "write me opener snippets / personalized first lines / opening lines for these"
- User says "personalize this list" in a cold email context

If the user only has lead names without research, this skill is the wrong tool — they need a research/enrichment step first.

## Step 1 — Interactive intake (do this BEFORE writing anything)

Ask these six questions one at a time. Wait for each answer. Do not batch. Use answers from earlier questions to pre-fill or refine later ones where it helps.

### Q1: What product or service is being sold?

> "What product or service is the campaign for? One sentence is fine — I just need enough context to know what tension to land the opener on."

Why it matters: the implication needs to land on a tension the product naturally addresses. Manufacturing ERP → multi-site coordination, job costing. Sales platform → pipeline coverage, rep ramp. Recruiting tool → time-to-hire, candidate quality. Without this, the implications are generic.

### Q2: What industry or type of company are the targets in?

> "What industry are the targets in? E.g. 'mid-market SaaS', 'US precision manufacturers', 'fintech compliance teams', 'healthcare staffing agencies'."

Why it matters: the **tangible nouns** in the implication are industry-specific. Manufacturing: inventory, scheduling, traceability, job costing. SaaS: churn, activation, NPS, pipeline coverage, rep ramp. Healthcare: scheduling, compliance, patient throughput, credentialing. Get this wrong and the snippet feels generic.

After getting the answer, propose a starter list of tangible nouns based on the industry and ask the user to confirm or edit:

> "For [industry], I'd lean on [noun, noun, noun] as the typical pressure points. Sound right, or do you want me to swap any of those?"

### Q3: What's today's date, or when do these go out?

> "What's today's date (or your send window)? I use this to phrase the timing of events accurately — saying something is 'just starting to build' when it happened 18 months ago is the #1 way to make a snippet feel off."

Why it matters: timeline-aware phrasing is the most fragile part of the methodology. See the timeline-phrasing section below for the full mapping.

### Q4: Any campaign-specific banned words?

> "Any words I should avoid? Common cases: the product name itself (so the opener doesn't pre-pitch), category words (e.g. 'ERP', 'CRM', 'platform') because the email body carries those, regulated terms in healthcare/finance/crypto. Universal banned list applies on top of whatever you give me — em dashes, flattery openers, and data-speak are always out."

If the user passes nothing, fine. The universal banned list still applies.

### Q5: Tangible nouns — confirm or replace

If Q2 already produced a starter list, this is just confirmation. If not, ask:

> "Give me 4-6 tangible nouns the implication can land on for this industry. Things people inside the business actually deal with on a Monday morning — not abstract concepts."

### Q6: Paste the email body

> "Paste the email body the opener will sit in front of. The opener has to bridge naturally into the first line of the body, so I need to see the body to match the tone and the tension."

This is the most important question. The opener and the body must read as one continuous voice. If the body is formal, the opener can't be casual. If the body talks about cost overruns, the opener should land on a related tension, not on something unrelated like talent retention.

## Step 2 — Collect the research input

After intake, ask:

> "How are you giving me the research? Three options:
>  1. **CSV path** — I'll read it, find the research column, and write a `Personalized Snippet` column back.
>  2. **Paste inline** — paste 1-3 research entries and I'll generate openers in chat for you to copy.
>  3. **Single company** — paste one block, I write one opener."

For CSV: confirm the path, the research column name (default: `Research`), and the account name column (default: `Account Name` or first column).

## Step 3 — Sample first, then batch

Generate **one** sample opener first. Show it to the user. Get feedback. Iterate until tone is locked. Then batch the rest.

Mirrors the `personalization-subagent-pattern` approval loop. Don't write 200 openers and discover the tone is wrong. Lock the tone on lead #1.

## Universal rules (apply to every opener)

These are non-negotiable. They were validated across 5 iteration rounds on a real campaign before being captured here.

### Length and shape

- 1-2 sentences, **25-35 words target**, 40 hard cap
- First-person observation opener: `Saw...`, `Saw you've...`, `Noticed...`, `Saw [company/person]...`
- Observation, then implication. Don't explain the implication — one short clause.

### One event per opener

- **One** primary event/observation per opener. Don't stack a physical expansion + an equipment investment + a personnel change. Three signals = too heavy.
- Compounding two **related** events that roll into one tension is OK (e.g. "extended distribution deal while absorbing two acquisitions" — all about scale/integration).
- Compounding **unrelated** event types is not (a leadership change + a product launch + a retirement).
- The implication can mention multi-site context as setup ("across both sites", "across all four") — that's framing the single observation, not stacking.

### Empathy phrase (required, varied)

Every opener must contain at least one of these four phrases. Vary across a batch — don't default all to one.

| Phrase | When it fits |
|---|---|
| **I'm guessing** | Internal pressure they're already experiencing |
| **I imagine** | Mindset / what people inside are focused on |
| **I'd expect** | Logical consequence of the trigger |
| **if it hasn't already** | Softer tail; suggests pressure is coming or here |

Aim for rough balance across a batch. Don't go all-in on one phrase even if it fits every snippet. The repetition is the giveaway that a human didn't write these.

### Timeline-aware phrasing (critical)

Match the implication tense to the event's age relative to today's date (collected in Q3).

| Event age | Phrasing for the implication |
|---|---|
| **0-4 months old (recent)** | "is already starting to build" / "is already starting to build pressure" |
| **5-10 months (Q4-Q3 of prior year)** | "back in [Month]" + "has been building since" / "has been front of mind since" |
| **11-16 months (early prior year)** | "last spring/summer/year" + "has been the running theme" / "has been building through [year]" |
| **17+ months / undated / stale** | NEVER claim "starting to build". Reframe as ongoing reality: "is the daily reality" / "is the steady-state operating rhythm" / "has compounded into the daily reality" / "has fully baked into the weekly rhythm by now" |

Two specific failure modes to avoid:

- Saying "the pressure is just starting to build" about a Dec 2024 event from a May 2026 send date. The reader will notice and dismiss.
- Saying "earlier in the year" about a Feb 2025 event from May 2026. That's "last year" or "back in February of last year", not "earlier in the year".

If the research only contains stale events (everything pre-2025 from a 2026 send date, for example), do **not** invent a fresh event. Reframe as a timeless ongoing-reality opener about the operating dynamic instead.

### Pronouns and proper nouns

- Use **"you" / "your"** instead of company name where natural. Keeps tone personal.
- Keep proper nouns (people, sites, partners) when they make the opener feel observed rather than generic. "Saw Jeff stepped into the President seat" reads as observed; "Saw the company has new leadership" reads as a vague claim.

### Banned content

**No em dashes** (`—`) or en dashes (`–`). Use commas, "and", "while", "with", "so", or split sentences. The em dash is a tell — humans on quick emails rarely use them.

**Universal banned phrases** (always, regardless of campaign):

- Flattery openers: "I hope this finds you well", "I came across", "I was impressed by", "Congratulations on", "It is clear that", "This is a testament to", "This positions you as"
- Data-speak: "the floor" (factory-floor reference; sounds like vendor jargon), "real-time view", "live data", "live view", "visibility into", "data room"

**Campaign banned words** (from intake Q4) — checked with `\b` word boundaries. Note: substring matching false-positives on words like "Caterpillar" containing "erp"; the audit script handles this correctly.

**No questions, no CTA, no pitch, no product mention.** Pure observation + implication. The body carries the pitch.

### Cold-read test

Prefix the opener with "Hi [Name]," and read aloud. If it sounds like a news summary, a LinkedIn post, or a briefing note — rewrite. It should sound like something said to a colleague at an industry event.

### Source restriction

Use only what the research/signal data states. Don't infer beyond it. No fabricated dates, no LinkedIn lookups mid-skill, no website fetches. If the research is thin, the opener is timeless or short — don't invent.

## Step 4 — Run the audit (mandatory)

Before showing any output to the user, run `scripts/audit.py` against the snippet(s):

```bash
python3 scripts/audit.py \
  --snippets <path-to-json-or-csv> \
  --campaign-banned "ERP,Epicor,Kinetic" \
  --target-words 25-35
```

The audit checks:

- Em-dash / en-dash presence (any → fail)
- Universal banned words/phrases (any → fail)
- Campaign banned words from intake (any → fail), with `\b` word boundaries
- Empathy phrase presence (missing → fail)
- Length cap (40 words → fail)
- Empathy phrase distribution across the batch (all-same → warn)

If any snippet fails, rewrite it before showing. Never output a failing snippet with a "but I know it's borderline" caveat — the user will trust the audit, not the caveat.

## Step 5 — Output

For CSV input: append/overwrite a `Personalized Snippet` column on the same CSV. Use `scripts/csv_writer.py` (which handles `csv.QUOTE_ALL` to preserve multi-line research cells). Do not touch any other column.

For inline input: print the snippets in chat with the company name above each.

## Examples

### Good (single event, timeline-aware, tight implication, empathy phrase)

> Saw Jeff stepped into the President seat back in October. I'd expect cost-to-complete and schedule across your nuclear and defense jobs has been front of mind for new leadership since.

- One event (Jeff promotion)
- "back in October" — Oct 2025 from May 2026 send = ~7 months, accurate
- Tangible nouns (cost-to-complete, schedule, nuclear/defense jobs)
- "I'd expect" empathy phrase
- 31 words

### Good (compounding two related events into one tension)

> Saw you've extended the Arkwin distribution deal while also absorbing HAECO Americas and ADI into the mix. I'm guessing keeping inventory, kitting, and warranty processes aligned across that many moving parts is already creating some pressure.

- Two events (deal + absorptions) but they roll into one scale/integration tension
- "I'm guessing" empathy phrase
- Tangible nouns (inventory, kitting, warranty)

### Bad (stacking unrelated events — three signals)

> Saw the new 70,000 square foot building came online with the Mazak tube laser arriving in June and your long-tenured Quality Manager retiring earlier in the year. I'd expect the pressure on quality data, scheduling, and capturing institutional knowledge has been building through 2025.

- Three unrelated events stacked (building + equipment + retirement)
- "earlier in the year" is wrong if the retirement was in a previous calendar year
- Implication is over-explained (three sub-points)

### Bad (data-speak implication)

> Saw you closed Series B in October. I'd expect real-time visibility into the floor and live data on pipeline coverage is already a priority.

- "real-time visibility into the floor" — banned data-speak
- "live data" — banned
- Sounds like vendor pitch, not peer observation

### Bad (stale event framed as fresh)

> Saw you completed the Tennessee plant expansion back in December 2024. I'm guessing the pressure on multi-site cost tracking is just starting to build.

- Event is 17 months old by May 2026 send
- "just starting to build" reads as obviously wrong

Reframe instead:

> Saw the Tennessee plant has been your primary anchor over a couple of years now. I'm guessing the pressure on multi-site cost tracking and inventory is the daily operating rhythm by now.

## Distribution and balance across a batch

When generating 10+ openers in a batch, after generating, audit the empathy-phrase distribution:

- If one phrase appears in >50% of snippets, force variety on the next batch
- Aim for rough balance across all four phrases
- One or two `if it hasn't already` per batch is enough — overusing makes it sound like a tic

## What this skill does NOT do

- It does not enrich research. If the research column is empty or thin, the snippet will be thin or timeless.
- It does not write the email body. It only writes the opener that bridges into the body.
- It does not generate variants (A/B/C). For variant generation, layer this skill with `personalization-subagent-pattern` after the base opener tone is locked.
- It does not score deliverability. Pair with `spam-word-checker` for full pre-send QA.
