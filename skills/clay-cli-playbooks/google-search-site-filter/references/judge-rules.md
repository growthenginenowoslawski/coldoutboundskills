# Judging a candidate, and writing the line

You, the agent running this skill, are the judge. Nothing here is sent to a model endpoint: the
candidates come out of the `Literal filter` node and you decide from them. The rules below are the
source playbook's locked judge prompt, which took five measured rounds on the same ten rows to reach
zero corrections, restated as instructions to you. Apply them in order, one row at a time, reading
only that row's candidates (up to five: url, title, snippet, date).

## Decide `mentions`

- **true** only when a candidate is a page the company published about itself and the keyword
  describes that company, its product, its service, its customers, or its own credential.
- **false** when the keyword appears only because the page is a directory listing, an integration or
  partner page about a different company, a user forum post, a job post, a customer logo wall, a press
  roundup, a prompt or email template, or a generic blog post not about this company.
- **false** when the only match is an unrelated word containing the keyword's letters.

Measured instance of the template trap: a sales-software company had seven on-domain pages literally
containing "SOC 2", all of them example cold emails in its own template library. A naive filter marks
it a match; the judge must not.

## Set `status`

- `has` — the page shows the company already does or holds the thing.
- `planned` — roadmap, in progress, requested, coming soon, audit window open.
- `discusses` — the company writes about the topic but the page does not show it holds or plans it.
- `none` — `mentions` is false.

## Set `confidence`

- `high` — the snippet itself contains the keyword and the page is clearly the company's own.
- `low` — you inferred it, or the page could belong to someone else.

## `campaign_usable`, computed before any copy

`campaign_usable` is true only when `status` is `has` **and** `confidence` is `high`. Compute it first.
Every copy field below is empty unless it is true, including on rows where `mentions` is true.

## Write the line (only when `campaign_usable`)

- It completes "Noticed LINE." with correct grammar. Never start it with "Noticed", "I noticed",
  "that", or "you have" (the frame supplies "Noticed"; starting with it renders "Noticed Noticed").
- A fact about the company, never about the page: "you hold SOC 2 Type II certification", never "SOC 2
  is mentioned on your security page".
- Lowercase first letter unless the first word is an acronym, a brand name, or the company's own name.
  Keep acronyms and brands in their real casing everywhere.
- No trailing period, no em or en dashes, no quotes, under 90 characters, plain language.
- State only what the snippet proves; never add a date, number or scope the snippet does not carry.
- `site_keyword_sentence` is the whole sentence with its period and one trailing space
  (`Noticed you hold SOC 2 Type II certification. `), or empty. It exists because a blank line inside
  a fixed frame renders "Noticed ." and spintax cannot branch on emptiness.

## Examples (from the source playbook, invented companies)

| Candidates | mentions | status | confidence | line |
|---|---|---|---|---|
| security page: "undergoes regular SOC 2 Type II audits" | true | has | high | `you run SOC 2 Type II audits` |
| roadmap page: "SOC 2 certification, planned" | true | planned | high | (empty, not usable) |
| trust page: "in the middle of our SOC 2 Type 2 audit window" | true | planned | high | (empty, not usable) |
| blog: "We ranked 20 chess apps" (keyword chess) | false | none | low | (empty) |
| no candidates | false | none | high | (empty) |

## Two defects the playbook measured after the gate, still possible here

About 1 in 6 lines that cleared the gate needed a human edit: one missing article ("you have SOC 2 Type
2 attestation") and one lowercased brand. Nothing downstream catches either. That is why Step 7 of
the skill requires a read of 20 rendered sentences before the variable goes into a live campaign.
