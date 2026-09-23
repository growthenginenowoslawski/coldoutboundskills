# Funding arms, as read live on 2026-09-23

Read from one workspace with `clay workflows actions schema`, `clay routines get` and
`clay searches query-mode run`. Re-read them at Step 0 every run; if the live catalogue
disagrees with this file, the live catalogue wins. Costs are what the catalogue declared on that
day, not anyone's price.

## Free surfaces

| Surface | How it is called | Funding field it returns | Shape observed | Filterable? |
|---|---|---|---|---|
| Company search | `clay searches query-mode create --query 'select from companies where ...'` then `run` | `total_funding_amount_range_usd` | a number, e.g. `235000000`, or `null` | **No.** `total_funding_amount_range_usd > 1000000` and `... is_not_null` both return `validation_error: Unknown field 'total_funding_amount_range_usd' for entity 'companies'` |
| Managed function "Enrich Company" (`clay routines list --limit 100`, find it by name) | `clay routines runs start <id> --input '{"items":[{"id":"a","inputs":{"Company Identifier":"example.com"}}]}'` | `total_funding_amount_range_usd` inside the result | a bucket string: `"$100M - $250M"`, `"$250M+"`, `"$1M - $5M"`, or `"Funding unknown"` | n/a (per row) |

Same company, same day, two shapes: search returned `235000000` for huggingface.co while the
function returned `"$100M - $250M"`. Parse both; never compare one against the other as if they
were one field.

Neither free surface returns a round stage, a round date, or a round amount.

## Paid surfaces (not run in the test; read live)

| Arm | Identify it by | Declared cost | Fields a line needs | Notes |
|---|---|---|---|---|
| Latest-funding action | `(629c6643-1766-41cf-aaf8-cdc5894c85a3, enrich-crm-enrich-company-latest-funding)` | `creditCost 4` per call | `lastFundingType`, `latestFundingDate`, `lastFundingAmountUsd`, `companyDomain` (identity check), `totalFundingUsd` (never copy) | an action: runs in a workflow tool node. Input `domain`. |
| Managed function "Company Latest Funding" | `clay routines list --limit 100`, find it by name, then `clay routines get <id>` | `perRun 6.4`, `containsVariablePricing: true` | stage, amount, date, investors per its description; `outputSchema` is `null`, so field names are only knowable from the first payload | runs with `clay routines runs start`, no workflow needed. Input `Company Domain`. Variable pricing means the 6.4 is an estimate, not a ceiling. |
| Company-insights action (bring your own account) | `(3886cce5-91b9-4d64-bec5-03bc15eb6a5e, crunchbase-enrich-company-insights)` | 0 Clay credits, bills the connected account | growth insights with `funding_raised`, press references | needs the installer's own connected account; no account, no arm |

## One public source that Clay's HTTP action cannot reach

SEC Form D filings are the freshest public record of a US private raise we found: ramp.com's
June 2026 round appears as a Form D filed 2026-06-17, `totalAmountSold` 781,998,720, first sale
2026-06-01 (announced as $750M, so the filing figure is +4% on the headline). The full-text
search endpoint is public and needs no key.

**It does not work from Clay.** Called through the `http-api-v2` action in a test workflow, both
a generic and an SEC-format declared User-Agent got HTTP 403, "Your Request Originates from an
Undeclared Automated Tool" (2026-09-23, two attempts). This skill therefore does not route
through it, and does not tell the installer to.
