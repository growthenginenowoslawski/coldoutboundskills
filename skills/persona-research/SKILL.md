---
name: persona-research
description: >
  Individual/persona-level research skill. Searches for what a specific named person said,
  wrote, spoke about, was appointed to, or won — within a rolling 8-month window. Runs 10
  parallel Exa searches per batch, qualifies each signal against a 4-gate logic (named
  individual + individual verb + no account-level patterns + in-window date), and writes
  Individual Research + Source back to the Individual CSV. Shows all 4 fields (Source,
  Research, draft snippet, Epicor Relevance) to user before writing. Use when: "run persona
  research", "find individual signals", "search for what [person] said", or after setting up
  an Individual CSV and wanting to populate the research columns. Companion to
  persona-lvl-personalized-opener-writer (which writes the snippet from this research).
---

# Persona Research

Finds individual-level signals for named prospects — what THIS person said, wrote, spoke about, or was appointed to — and writes the raw research back to the Individual CSV. Snippet writing is handled separately by `persona-lvl-personalized-opener-writer`.

## Why individual signals beat company signals

Account-level openers reference company events (expansion, acquisition, award). They work. Persona-level openers reference what THIS person specifically said or did. They hit harder because:
- The reader knows you read something they wrote or said, not just a press release about their company
- Harder to fake — you can't produce a real quote without having actually found it
- Opens at a personal level before the company-level pitch lands

## When to use this skill

- Individual CSV is set up (columns: `Firstname`, `Lastname`, `Account Name`, `Job Title`, `Individual Research`, `Source`, `Individual Snippet`, `Epicor Relevance`)
- User says "run persona research", "find what [name] said", "search individuals", "populate research column"
- Always run BEFORE `persona-lvl-personalized-opener-writer` — this skill writes the research; the opener writer consumes it

---

## Step 0 — Init

**Read campaign folder** (same pattern as `account-research`):
1. `ls campaigns/` and print numbered list
2. Ask: "Which campaign? (Enter number)"
3. In `campaigns/[name]/`: find the Individual CSV — look for a file with "Individual" in the name, or ask user to specify
4. Calculate cutoff date: `today - 8 months` (default). User can override with `--cutoff YYYY-MM-DD`.
5. Read total row count from CSV

Print confirmation:
```
Persona Research: [campaign name]
CSV: [path]
Total rows: [N]
Cutoff date: [YYYY-MM-DD] (signals before this date = fail)
```

---

## Step 1 — Pre-flight check

```python
import csv
from collections import Counter
from datetime import date, timedelta

with open(csv_path, newline='', encoding='utf-8') as f:
    rows = list(csv.DictReader(f))

# Count rows already researched vs blank
researched = sum(1 for r in rows if r.get('Individual Research', '').strip())
blank = len(rows) - researched
print(f"Already researched: {researched} | Blank (pending): {blank}")

# Flag duplicate Firstname+Lastname (same person under multiple accounts — not an error)
names = [(r['Firstname'].strip(), r['Lastname'].strip()) for r in rows]
dupes = [f"{f} {l}" for (f, l), c in Counter(names).items() if c > 1]
if dupes:
    print(f"Note: {len(dupes)} name(s) appear in multiple rows (dual-account people).")
    print(f"Writes will land on ALL matching rows: {', '.join(dupes)}")
    print("This is expected — not an error.")
```

Do NOT stop if duplicates found. Just note them — dual-account people (e.g. John Hancock appears under both "Burdens (Wolseley)" and "Wolseley") get written to both rows by design.

---

## Step 2 — Select batch

Ask user: "Which rows to research? (e.g. '1–10', '51–60', or 'all blank')"

Default: next 10 blank rows (where `Individual Research` is empty).

Pull the selected rows and extract per person:
- `Firstname`, `Lastname`, `Account Name`, `Job Title`

---

## Step 3 — Run parallel Exa searches (1 message, 10 tool calls)

For each person in the batch, fire one search:

```
Query: "[Firstname Lastname]" "[Account Name]" interview OR said OR quote OR appointed OR spoke OR published OR wrote
startPublishedDate: [cutoff]
numResults: 3
```

All 10 searches in a single message (parallel tool calls). Do not search sequentially.

If Account Name contains common words that would pollute results (e.g. "Wolseley", which is a large well-known brand), also run a secondary search:
```
Query: "[Firstname Lastname]" site:linkedin.com OR site:businesswire.com OR "[Account Name]" [job-title-keyword]
startPublishedDate: [cutoff]
numResults: 3
```

---

## Step 4 — Qualify each result

Apply all 4 gates. All must pass. One fail = skip the person, log as "nothing found".

### Gate 1: Named individual

The person must be referenced by Firstname + Lastname (or at minimum a clear combination that unambiguously identifies them). A reference to "the Managing Director of BEW" without the name = FAIL.

### Gate 2: Individual verb present

At least one of these verbs must apply to the person — not to their company:

> said, says, told, stated, commented, added, noted, wrote, authored, published, posted, shared, announced, spoke, presented, keynoted, appeared, interviewed, won, awarded, recognised, recognized, named, joined, appointed, promoted, left, stepped down, launched, founded, co-founded

### Gate 3: No account-level patterns

Auto-fail any signal where the substance is company news, not personal action:

- Annual / full-year results
- `FY{XX}` performance
- Operating margin, revenue growth/decline
- Acquisition announcement (company level)
- Share dealings, dividend, market cap
- Synergies

**Swap test:** Mentally replace the person's name with "the MD of [Company]". If the signal still reads identically as company news → FAIL. A real individual signal requires the person's name to be load-bearing.

### Gate 4: Within date window

Published date must be ≥ cutoff date. No exceptions — not even 1 day outside.

Near-misses (0–30 days outside window): log separately for future reference. Do not include in current batch output.

---

## Step 5 — Show all 4 fields before writing (mandatory)

For every qualifying signal, display the following BEFORE writing to CSV:

```
## [Firstname Lastname] — [Account Name], [Job Title]

Source: [URL]

Research: [2–4 sentences. Quote directly where possible. State publication name and date explicitly.]

Connection Strength: [Strong / Medium / Weak]
Reason: [One line — e.g. "person quoted describing ops challenge at their own company" or "external board role, requires 3-step reasoning to reach Epicor"]

Individual Snippet (draft): [≤40 words. Empathy phrase required. No em dash. No banned words.]

Epicor Relevance: [1 plain sentence. No em dash. Pattern: "[Person] described [X], which is exactly [Epicor argument]."]
```

**Connection Strength definitions:**
- **Strong**: person directly described an operational challenge at their own company, or was quoted on a decision that creates an immediate operational question
- **Medium**: signal implies an operational challenge exists but person didn't describe it directly
- **Weak**: connection requires 3+ reasoning steps; e.g. external role → infer internal concern → connect to Epicor. Note: `"Consider leaving blank — weak signals rarely yield strong snippets."`

If Weak: surface it to the user at this step so they can decide before committing to the CSV write.

Do NOT write to CSV before displaying. Wait for user to review. If user requests changes to the draft snippet or relevance, update before writing.

The draft snippet here is a preview only — `persona-lvl-personalized-opener-writer` will write the final version in its own pass. But showing a draft lets the user validate signal quality before committing.

---

## Step 6 — Write to Individual CSV

After user confirms (or no corrections needed), write:

```python
import csv

WRITE_COLS = ['Individual Research', 'Source']
# Individual Snippet and Epicor Relevance written by persona-lvl-personalized-opener-writer

with open(csv_path, newline='', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    headers = list(reader.fieldnames)
    rows = list(reader)

updates = {
    # Key: (Firstname.strip().lower(), Lastname.strip().lower())
    # Value: {'Individual Research': '...', 'Source': '...'}
}

written = 0
for row in rows:
    key = (row['Firstname'].strip().lower(), row['Lastname'].strip().lower())
    if key in updates:
        for col in WRITE_COLS:
            row[col] = updates[key][col]
        written += 1

with open(csv_path, 'w', newline='', encoding='utf-8') as f:
    writer = csv.DictWriter(f, fieldnames=headers, quoting=csv.QUOTE_ALL)
    writer.writeheader()
    writer.writerows(rows)

print(f"Written: {written} rows | Total rows: {len(rows)} (unchanged)")
assert len(rows) == input_row_count, "ROW COUNT MISMATCH — investigate before continuing"
```

Match by `(Firstname.lower(), Lastname.lower())` — writes to ALL matching rows (dual-account people handled automatically).

Never modify: `Firstname`, `Lastname`, `Account Name`, `Job Title`, `Individual Snippet`, `Epicor Relevance` — those are read-only for this skill.

---

## Step 7 — Batch report

```
Batch [rows N–N+9] complete: X/10 qualifying

  ✓ Craig Stanford   — APP Wholesale    (Podfather case study, Nov 2025)
  ✓ Darren Locker    — BEW Electrical   (Stories of Essex podcast, Oct 2025)
  –  James Platt      — Caswells         (nothing found in window)
  –  Graham Eccles    — BSS Industrial   (nothing found in window)

Near-misses (signal found but outside window):
  ! Bryan Main — Certas Energy — award acceptance Oct 10 2025 (7 days outside)
  ! Josie Crowe — BSS Industrial — appointment Jul 2025 (outside window)

Hit rate this batch: X/10 (X%)
Running total: X/[N] (X%)

Continue to next batch? (y/n)
```

---

## Qualifier logic (self-contained — do not import from project)

```python
import re
from datetime import date, timedelta

INDIVIDUAL_VERBS = [
    "said", "says", "told", "stated", "commented", "added", "noted",
    "wrote", "authored", "published", "posted", "shared", "announced",
    "spoke", "presented", "keynoted", "appeared", "interviewed",
    "won", "awarded", "recognised", "recognized", "named",
    "joined", "appointed", "promoted", "left", "stepped down",
    "launched", "founded", "co-founded",
]

ACCOUNT_LEVEL_PATTERNS = [
    r"\bfull[- ]year results?\b",
    r"\bannual results?\b",
    r"\bfy\d{2}\b",
    r"\bquarterly results?\b",
    r"\brevenue (grew|fell|rose|declined)\b",
    r"\boperating margin\b",
    r"\bacquisition of\b",
    r"\bshare (price|buyback|dealing)\b",
    r"\bdividend\b",
    r"\bmarket cap\b",
    r"\bsynerg(y|ies)\b",
]

def qualify(signal_text, first_name, last_name, published_date_str, cutoff_date):
    """
    Returns (pass: bool, reason: str)
    """
    text_lower = signal_text.lower()
    full_name = f"{first_name} {last_name}".lower()

    # Gate 1: named individual
    if full_name not in text_lower:
        return False, f"name '{full_name}' not found in signal"

    # Gate 2: individual verb
    if not any(v in text_lower for v in INDIVIDUAL_VERBS):
        return False, "no individual verb (said/spoke/wrote/appointed/won/...)"

    # Gate 3: no account-level patterns
    for pat in ACCOUNT_LEVEL_PATTERNS:
        if re.search(pat, text_lower):
            return False, f"account-level pattern matched: {pat}"

    # Gate 4: within date window
    try:
        pub = date.fromisoformat(published_date_str[:10])
    except (ValueError, TypeError):
        return False, f"unparseable date: {published_date_str}"
    if pub < cutoff_date:
        days_outside = (cutoff_date - pub).days
        return False, f"outside window by {days_outside} days (published {pub}, cutoff {cutoff_date})"

    return True, "pass"
```

---

## Key rules summary

| Rule | Detail |
|------|--------|
| Cutoff | today − 8 months, no exceptions |
| Blank row = correct | No signal found → leave row blank, never invent |
| Dual-account people | Write to ALL matching rows (match by name, not account) |
| Show before write | All 4 fields displayed to user before any CSV write |
| Near-miss log | 0–30 days outside window → log for follow-up, don't include |
| Row count | Input count must equal output count after write |
| Qualifier self-contained | Logic embedded in skill, not imported from project files |
