---
name: instantly-campaign-prep
description: Prepare a campaign for Instantly without using its API. Takes the variants.yaml from /campaign-copywriting plus a leads.csv and produces a cleaned leads CSV to import in Instantly, the email sequence text to paste into its editor, and a launch checklist. Validates emails, duplicates and merge variables first. Sends nothing and never contacts Instantly. Use after /campaign-copywriting when your sequencer is Instantly.
---

# Instantly Campaign Prep

The Instantly counterpart of `/smartlead-campaign-upload-public`, with one difference: it does **not** call any API. It prepares three files and you do the import and the launch in the Instantly UI.

Why no API: Instantly's API has not been verified against a live account in this repo (see `/instantly-api`). Preparing files carries no risk of a wrong API call, and the import is a few clicks.

## Inputs

- `variants.yaml` from `/campaign-copywriting` (same schema as for Smartlead: `name`, `schedule`, `inbox_selection`, `sequences`).
- `leads.csv` with required columns `email`, `first_name`, `last_name`, `company_name`. Any other column (for example `situation_line`, `value_line`, `title`) is carried through as a custom variable.

## Usage

```bash
npx tsx skills/instantly-campaign-prep/scripts/prep.ts \
  --leads=profiles/<slug>/campaigns/<campaign>/leads.csv \
  --variants=profiles/<slug>/campaigns/<campaign>/variants.yaml
```

Optional: `--out=DIR` (default `<variants dir>/instantly`), `--var-style=camel|snake`.

## What it checks (it refuses to write files if any of these fail)

- Required CSV columns exist, no duplicate headers.
- The copy only uses merge variables that a CSV column can fill. `{{situation_line}}` with no `situation_line` column is an error, not a blank in a live email.
- `variants.yaml` is complete: a name, numbered steps, step 1 with `delay_days: 0` and a subject, variant labels A/B/C, non-empty bodies.

It cleans the leads rather than failing on them: blank, malformed and duplicate emails are dropped and counted, and emails are lowercased.

## Output (in `<variants dir>/instantly/`)

| File | Use |
|---|---|
| `leads-instantly.csv` | Import in Instantly. Map email and the name/company columns; the rest become custom variables. |
| `sequence.md` | Paste each step's subject and body into the sequence editor. |
| `review-checklist.md` | Schedule, inboxes, settings and pre-launch checks, plus how long the first touch takes at your daily limits. |

## Merge variable names (unverified)

Standard fields are written as `{{firstName}}`, `{{lastName}}`, `{{companyName}}` (`--var-style=camel`, the default). Custom columns keep their header name. This is my best understanding of Instantly's syntax and has not been checked against a live account. In the Instantly preview, if you see raw `{{ }}` braces, re-run with `--var-style=snake`.

## After you import

1. Preview a real lead in Instantly and confirm every variable renders.
2. Attach only warmed-up inboxes (about 2 weeks of warmup).
3. Run `/email-deliverability-audit` to confirm SPF, DKIM and DMARC.
4. Launch it yourself. This skill never launches anything.
5. After 21 days run `/positive-reply-scoring`. For an A/B test use two campaigns (see `/experiment-design`).

## Not covered yet

- Creating the campaign, attaching inboxes or controlling warmup through the Instantly API. That waits for a live API key and a read-only check (see `/instantly-api`).
- Pulling Instantly replies into `/positive-reply-scoring`. That skill's fetch script reads Smartlead; export replies from Instantly as CSV in the meantime.

## Related skills

- `/campaign-copywriting` — produces `variants.yaml`
- `/list-quality-scorecard` — grade the list before this step
- `/instantly-api` — API reference (unvalidated)
- `/email-deliverability-audit` — SPF/DKIM/DMARC check before launch
