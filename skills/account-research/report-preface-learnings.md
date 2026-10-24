---
name: report-preface-learnings
description: Patterns and lessons from Epicor Manufacturing Tier 2 prefaces (140 accounts, through 2026-05-14). Guides tension mapping, Para 2 framing, reference documentation, and quality audit logic for all future batches.
metadata:
  type: feedback
---

# Report Preface Learnings — Epicor Manufacturing Tier 2

**Pilot Date:** 2026-05-13 (10 accounts) | **Run 2 completed:** 2026-05-14 (140 accounts total, 0 failures)  
**Accounts covered:** ABI Tape, Agri-Fab, Allied High Tech, Anagram International, Aqua-Chem, Armor Metal Group, Almaco, Abec + 132 additional Tier 2 accounts  
**Key Lesson:** References MUST be included in every preface. Research is not complete without traceable sources.

---

## Run 2 Completion Record (2026-05-14)

- 140 accounts total — final quality audit: 0 failures
- 15 stub rows (Group A) completed with full 4-paragraph prefaces + 3 real references each
- 5 Group C rows repaired: wrong Para 2 opener fixed (Maverick Boats, Sperry Rail, Titan Trailer, Vogt Power, Vornado Air)
- 46 em dashes removed from preface bodies across the batch
- 2 rows had only 2 references — both fixed by appending a third real URL

---

## Tension Mapping Patterns

**P3_MULTISITE variant strongest indicators:**
- Multiple manufacturing locations (2+) across geographies
- Recent expansion/consolidation activity ("adding site," "moving HQ," "post-acquisition integration")
- Explicit mention of trade/supply volatility OR staffing/operational changes
- Language suggesting coordination challenge ("global footprint," "across regions," "distributed," "multiple sites")

**P3_QUALITY_INVENTORY variant strongest indicators:**
- Vertical integration or quality-focused positioning
- Recent facility moves, consolidations, or process investments
- Product precision/complexity emphasis (metallographic, sample prep, etc.)
- Innovation velocity creating process variability

**P3_SCHEDULING_FINANCE variant strongest indicators:**
- Post-bankruptcy, restructuring, or major leadership transition
- Recent acquisitions or divestitures (data reconciliation implied)
- Finance-visible changes (CFO appointment, rate case activity, capital spend announcements)

---

## Para 2 ("Harder Question") Framing Rules

**Opening phrase is mandatory:** "What's harder to see, even from within the business, is whether..."

**Tension language patterns that work:**
- "...[specific data] are actually synchronized in real time"
- "...visibility across [locations/divisions] tell the same story"
- "...quality issues surface early [at point of production] or late [when expensive]"
- "...scheduling adapts as conditions actually change"
- "...margin is hidden in [supply delays/hidden costs/integration friction]"

**Avoid generic statements.** Don't write "data is fragmented." Write "inventory from Knoxville and the planned China operation will tell the same story in real time."

**Bridge from Para 1 to Para 3:** Para 2 names the tension. Para 3 explains why the report specifically addresses it. The logic must be visible.

---

## Reference Documentation Standard

**Every preface must have a References section.** Format:

```
**References:**
- [Source Title] — [Specific claim used]. [Full URL]
- [Source Title] — [Specific claim used]. [Full URL]
- [Source Title] — [Specific claim used]. [Full URL]
```

**Minimum 3 references per preface.** Traceability is credibility.

**Source types that work best:**
- Company press releases / news announcements (recent, dated)
- Management statements / CEO letters (for language/positioning)
- Company official pages (About, History, Footprint)
- Business news coverage (Business Journal, Inc.com, Reuters, etc.)
- Government/regulatory filings (rate cases, acquisitions, investments)

**What to reference:**
- Para 1 facts (sites, revenue, expansions, leadership changes) — cite the announcement
- Para 2 tension (trade policy, restructuring, complexity) — cite the source that revealed it
- Para 3 research sample description ("600+ US manufacturing leaders") — cite the hero report directly

---

## Account Selection: Weak vs Strong Fit

**Skip these profiles (weak fit for visibility gap narrative):**
- Small, stable, niche companies without multi-site complexity
- Companies in crisis unrelated to data fragmentation (e.g., commodity price pressure, demand collapse)
- Companies where innovation/product is the dominant narrative (unless also dealing with manufacturing scaling complexity)
- Biopharmaceutical equipment manufacturers (outside discrete manufacturing scope)

**Prioritize these profiles (strong fit):**
- Multi-site operators dealing with expansion, consolidation, or integration
- Recent post-acquisition or post-restructuring (data reconciliation implied)
- Companies explicitly dealing with supply/trade/operational volatility
- Growth-phase manufacturers adding capacity or sites
- Vertical integrators consolidating facilities

---

## Local Single-Pass Workflow (Token Efficiency)

This pilot used a single local pass for all drafting: no sub-agent spawning, no parallel agents. This approach:
- Researches all 10 accounts upfront (batch web searches)
- Drafts all 10 prefaces locally in one session
- Updates CSV + creates learnings file in the same pass
- Outputs prefaces for review/edit without additional passes

**Token cost:** ~1 research phase + 1 draft phase + 1 file write. Single-digit web searches, no re-research.

**Scale:** Effective for batches of 10. For 143 accounts, divide into 14-15 batches of 10, run sequentially.

---

## CSV Research Column Standard

Research column should contain:
- 1–2 sentence summary of company's current state
- Specific signals/tensions identified (multi-site complexity, trade volatility, restructuring, scaling, etc.)
- P3 variant assigned
- Short reference notation (e.g., "Press release 2025," "Management letter Q2")

Example (ABI Tape):
> Pressure-sensitive tapes, protective films. 7-site global ops (NJ, MA, Belgium, Italy, Singapore, South Korea). Mgmt Q2 2025 signals: trade policy uncertainty, supply volatility. New CFO Oct 2024. Tension: multi-site inventory/scheduling sync, margin hidden in supply delays. P3_MULTISITE variant.

This allows future reviews to quickly understand research direction + which variant was chosen + why.

---

## Preface Quality Bar

**Fail conditions (reject before edit):**
- Para 2 doesn't start with "What's harder to see, even from within the business, is whether..."
- References section missing or incomplete (fewer than 3 sources)
- Preface mentions Epicor product by name
- Em dash (`—`) appears in preface body (text before `---` separator) — see em dash rule below
- Para 1 describes the company instead of listing what it has been doing
- Para 4 reads like sales pitch instead of peer-level invitation

**Pass conditions (ready for dev edit):**
- 250 ± 70 words (hard cap 320)
- Tension is specific to the account, not generic industry pressure
- Para 3 variant matches Para 2 tension
- All 4 placeholders present ([SALES NAME], [SALES CONTACT DETAILS], etc.)
- References are traceable URLs with publication info + claim

---

## Critical Em Dash Rule (learned from Run 2 audit)

Em dash (`—`) is BANNED in the preface body (text before the `---` separator).

Em dash IS CORRECT in the references section as separator:
```
- Source Title — Specific claim used. https://full-url.com
```

**Quality audit logic:** Split on `---`, check em dashes only in the first part (body text). Checking the whole Research cell will produce false failures on every correctly-formatted row.

```python
body = research.split('---')[0] if '---' in research else research
assert '—' not in body  # only check body, never references
```

**Group C em dash repair:** Replace in body only.
- ` — ` (space-emdash-space) → `: `
- lone `—` → `,`
Do NOT touch text after the `---` separator.

---

## Group C Repair Patterns (confirmed from Run 2)

Wrong Para 2 openers seen in the wild — all incorrect, all repaired:
- `"What's harder to see is how boat manufacturing--..."`
- `"The hidden difficulty:"`
- `"What's harder to manage, even within the company, is whether..."`
- `"The challenge in power sector operations is that..."`
- `"What's invisible during restructuring is whether..."`

Fix: Replace opener with exact mandatory phrase, preserve tension content that follows.

Broken sentence structure: words split mid-sentence across line breaks.
Fix: `re.sub(r'\n\n\s+([a-z,;])', r' \1', text)`

---

## Next Batch Guidance

When running Batch 2+ (accounts 11–143):
1. Use this learnings file to quality-check Para 2 framing before finalizing
2. Ensure every preface has references section with 3+ sources
3. Research each account using the same two-search pattern: (a) company-specific signals, (b) sub-sector dynamics
4. Skip accounts where tension narrative is weak (use quality bar above)
5. Map Para 3 variants before drafting to ensure consistency
6. Update CSV Research column with assignment rationale + variant choice
7. Run dev-edit on completed batch prefaces before returning to user

**Token efficiency note:** Single local pass per 10 accounts scales well. No sub-agent spawning required.
