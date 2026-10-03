# /account-research

Generates personalized report prefaces for prospect accounts. Campaign-aware: reads hero report and value prop from the campaign folder, extracts all context automatically, writes prefaces back into the campaign CSV in place. Works for any client, any report asset.

---

## Step 0: Initialization

### 1. Read learnings file

Read `.claude/commands/report-preface-learnings.md`. Extract:
- Para 2 mandatory opening phrase (`What's harder to see, even from within the business, is whether`)
- Quality bar rules (fail conditions, pass conditions)
- Em dash rule (banned in body, correct in references)
- Word count limits (250 ± 70 words, hard cap 320)
- Banned word categories

If file not found: stop. Tell user: "report-preface-learnings.md not found in .claude/commands/. This file is required. Check your project setup."

### 2. List available campaigns

Run `ls campaigns/` relative to project root. Print numbered list.

Ask: "Which campaign? (Enter number or type a new campaign name)"

### 3. Look in `campaigns/[chosen-name]/`

**Hero report** — check in order:
1. `hero-report.md`
2. `hero-report.pdf`
3. `hero-report.txt`
4. Any `.pdf` with "report" or "hero" in filename

**Value prop** — check in order:
1. `value-prop.md`
2. `value-proposition.md`
3. Any `.md` or `.txt` with "value" or "prop" in filename

**CSV** — find all `*.csv` in folder:
- If one: use it
- If multiple: ask which one

**If campaign folder doesn't exist:**
```
Campaign folder "campaigns/[name]/" not found.
Create it and add:
  - hero-report.pdf (or .md, .txt)
  - value-prop.md
  - your-accounts.csv
Then re-invoke /account-research.
```
Stop.

### 4. Ask only for what wasn't found

- Hero report missing: "Couldn't find hero report in campaigns/[name]/. What's the file path?"
- Value prop missing: "Couldn't find value prop in campaigns/[name]/. What's the file path?"
- CSV missing: "Couldn't find a CSV in campaigns/[name]/. What's the file path?"

### 5. Extract campaign variables from files

Read both documents and pull:
- `REPORT_NAME` — name of report/asset (e.g., "IDC InfoBrief")
- `SAMPLE_DESC` — research base description (e.g., "600+ US manufacturing leaders")
- `NARRATIVE_ANGLE` — core problem the report addresses
- `BANNED_WORDS` — product names, competitor names, phrases to exclude from preface body

### 6. Print confirmation

```
Campaign loaded:
  Campaign: [name]
  Report: [REPORT_NAME]
  Sample: [SAMPLE_DESC]
  Angle: [NARRATIVE_ANGLE]
  Banned: [BANNED_WORDS list]
  Para 2 phrase: What's harder to see, even from within the business, is whether
  CSV: [path]
Proceeding...
```

---

## Step 1: Audit the CSV (Python)

Run a Python script to classify every row. Print classification counts before touching anything.

**Classification rules:**

- **Complete** — Research cell has ALL of:
  - Correct Para 2 phrase
  - `**References:**`
  - 3+ lines starting `- ` after the references header
  - `[SALES NAME]` on its own line
  - `[SALES CONTACT DETAILS]` on its own line
  - No em dash in body (text before `---`)
  → Do not touch these rows.

- **Group A** — Research cell is empty, <200 chars, or contains stub text: "Weak fit", "Single-site stable", "Not included", or similar placeholder language.

- **Group B** — Has correct Para 2 phrase and full 4-paragraph structure, but no `**References:**` section.

- **Group C** — Has content but one or more failures: wrong Para 2 opener, broken sentence structure (mid-sentence line breaks), missing/fake references, wrong placeholder format, or em dash in body.

Print: `Complete: N | Group A: N | Group B: N | Group C: N`

---

## Step 2: Research — Group A (batch of 5, parallel)

Process 5 accounts per batch. Research all 5 before drafting any.

For each account, run 2 Exa searches in parallel:
1. `[Company Name] operations expansion investment news 2024 2025`
2. `[Company Name] acquisition restructuring leadership growth 2024 2025`

If results thin after 2 searches, run a third:
`[Company Name] [industry keyword from results] announcement 2024 2025`

If still no usable signals after 3 searches: flag the account, do not invent tension, tell user and ask whether to skip or try a different angle.

**Extract:**
- Expansions, new facilities, investments — dates + dollar amounts
- Acquisitions, divestitures, PE/ownership changes — who, when, stated rationale
- C-suite transitions — role, name, date
- New product lines, patents, launches, certifications
- Regulatory/compliance activity
- Trade/supply chain signals

---

## Step 3: Map Tension

From signals, pick the tension with strongest evidence:

| Signal | Tension to name in Para 2 |
|---|---|
| Multi-site / expansion / new facility | scheduling, inventory, or quality data synchronized across locations |
| Acquisition / brand integration | operational data across legacy and acquired entities telling same story |
| PE / ownership transition | scheduling, financial, and production data surfacing at pace new ownership requires |
| Restructuring / leadership change | production commitments visible as structure and capacity change |
| Rapid hiring / headcount growth | quality and scheduling coherence holding as new capacity comes online |
| Vertical integration / precision product | quality traceability and inventory signals lagging real production state |
| Regulatory / compliance pressure | compliance data visible across operations in real time |

Para 2 must name specific locations, divisions, data types, or timelines from research. Never generic ("data is fragmented" is a fail).

---

## Step 4: Write the Preface

```
[Para 1 — 3-4 sentences. What company has been DOING recently: investing, acquiring, expanding, restructuring. Specific dates, dollar amounts, named locations. NOT a description of what they sell or what market they serve.]

What's harder to see, even from within the business, is whether [specific tension]. [2-3 more sentences naming locations, divisions, data types, or timelines from research.]

This [REPORT_NAME] draws on research with [SAMPLE_DESC] to [3-4 sentences mapping Para 2 tension to what research measures, identifies, quantifies].

[Para 4 — 2 sentences max. Peer-level. No product or vendor names. Confirms this research is relevant to where company is right now. Invites a conversation.]

[SALES NAME]
[SALES CONTACT DETAILS]

---

**References:**
- [Source Title] — [Specific claim used]. [Full URL]
- [Source Title] — [Specific claim used]. [Full URL]
- [Source Title] — [Specific claim used]. [Full URL]
```

### Hard fail conditions — reject before saving

- Para 2 does not open with: `What's harder to see, even from within the business, is whether`
- Para 1 reads like a company description rather than recent actions
- Para 3 uses hardcoded report name or sample size instead of `REPORT_NAME` / `SAMPLE_DESC`
- Em dash (`—`) anywhere in body (text before `---`)
- Any word from `BANNED_WORDS` in body
- Fewer than 3 references
- Fake or pattern-generated URL (`.example`, `company-name.com/about`, `research.example`, `industry.example`)
- `[SALES NAME]` and `[SALES CONTACT DETAILS]` on same line or separated by `/`
- Word count outside 180–320 words (body only)

---

## Step 5: Write to CSV (Python)

Use Python with `csv.DictReader` / `csv.DictWriter` and `quoting=csv.QUOTE_ALL`.

- Write all updates for the batch in a single pass
- Never row-by-row writes
- Never overwrite rows classified as Complete
- Always update the same input CSV file in place — no new file, no `_output.csv`

---

## Step 6: Group B — Add References Only

For rows with correct preface structure but missing references:

1. Read Para 1 to identify specific claims needing sources
2. Run 1 Exa search per account to find URL backing the main Para 1 claim
3. Append after `[SALES CONTACT DETAILS]` (Python):

```

---

**References:**
- [Company LinkedIn] — Company overview and recent updates. [LinkedIn URL]
- [Company website] — Official company page. [Website URL]
- [news/announcement] — [specific claim from Para 1]. [Full URL]
```

Do not invent URLs. If Exa returns nothing usable, use a second company official page (About, History, News).

---

## Step 7: Group C — Repair (Python, in order)

1. **Para 2 opener**: Replace wrong phrase with `What's harder to see, even from within the business, is whether` — preserve tension content that follows
2. **Broken sentence structure**: `re.sub(r'\n\n\s+([a-z,;])', r' \1', text)` — collapses mid-sentence line breaks
3. **Em dashes in body only**: ` — ` → `: ` and lone `—` → `,` — do NOT modify text after `---`
4. **Placeholder format**: Replace `[SALES NAME] / [CONTACT]` or similar → `[SALES NAME]\n[SALES CONTACT DETAILS]`
5. **References**: Add `---\n\n**References:**` block if missing, using Exa to find real URLs

---

## Step 8: Quality Audit (Python)

Run Python audit over every row. Zero failures before reporting done.

```python
CORRECT_PARA2 = "What's harder to see, even from within the business, is whether"
STUB_PHRASES = ["Weak fit", "Single-site stable", "Not included"]

for row in rows:
    research = row["Research"]
    body = research.split("---")[0] if "---" in research else research
    
    ref_idx = research.find("**References:**")
    ref_lines = [l for l in research[ref_idx:].splitlines() if l.startswith("- ")] if ref_idx >= 0 else []

    checks = {
        "Para 2 phrase": CORRECT_PARA2 in research,
        "References header": "**References:**" in research,
        "3+ reference lines": len(ref_lines) >= 3,
        "[SALES NAME]": "[SALES NAME]" in research,
        "[SALES CONTACT DETAILS]": "[SALES CONTACT DETAILS]" in research,
        "No fake URLs": ".example" not in research,
        "No em dash in body": "—" not in body,
        "No banned words": not any(w.lower() in research.lower() for w in BANNED_WORDS),
        "No stub text": not any(p in research for p in STUB_PHRASES),
        "Length > 200": len(research) > 200,
    }
    
    failures = [k for k, v in checks.items() if not v]
    if failures:
        print(f"Row {row_num} ({row['Account Name']}): FAIL — {', '.join(failures)}")
```

Print total rows checked, failure count, each failure with row number + account name. Fix all before done.

---

## Step 9: Final Report

```
=== COMPLETE ===
Campaign: [REPORT_NAME] | [SAMPLE_DESC]
Angle: [NARRATIVE_ANGLE]

Total accounts: [N]
  Complete (untouched): [N]
  Group A (new prefaces): [N]
  Group B (refs added): [N]
  Group C (repaired): [N]

Quality audit: [N]/[N] pass — 0 failures
```
