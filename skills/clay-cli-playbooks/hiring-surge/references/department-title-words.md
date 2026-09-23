# Department title words (the author's sets — borrowed, show them and let the installer edit)

Clay's people search has no department field in query mode, so a department is the set of current
titles that contain one of these words. `contains` matches whole words, case-insensitively: "sales"
matches "Head of Sales" and "Sales Manager", not "Salesforce Admin". Put all of one department's
words in one list:

```
experiences.any(is_current = true and job_title contains ("sales", "account executive", "business development", "sales development", "account manager"))
```

To exclude a class of titles found at review, either filter the saved page with the gate
script's `--exclude` (free, no second search) or add a clause to later searches inside the same
`experiences.any(...)`: `and not job_title contains ("trainer", "ai training")`.

## Sets used in the test (2026-09-23)

| Department | Words |
|---|---|
| Sales | sales, account executive, business development, sales development, account manager |
| Marketing | marketing, demand generation, growth marketing, content marketing, brand manager |

## Further sets from the author's earlier build (not tested on Clay search)

| Department | Words |
|---|---|
| Engineering | engineer, engineering, developer, software, devops, site reliability |
| Product | product manager, product owner, head of product, product lead |
| Revenue operations | revenue operations, revops, sales operations, marketing operations, sales enablement, gtm operations |
| Customer success | customer success, account manager, client success, onboarding, implementation |
| Finance | finance, accounting, controller, fp&a, accounts payable, accounts receivable |

## Known traps, each seen on real data

- **Contractor pools with a department word in the title.** One account's "sales" team was half
  "AI Trainer - Sales Expert"-style contract roles (2026-09-23). Exclude at review.
- **Client-service "account" roles at agencies.** At marketing and creative agencies,
  "Account Executive" and "Account Manager" are usually client service, not sales (author's
  earlier build). Drop those two words for agency accounts, or exclude them at review.
- **Sellers without "sales" in the title.** In financial and professional services the sellers
  are often "Principal", "Business Development" or "Client Relationship"; the author's earlier
  build missed one such team. Add "client relationship" and "partnerships" for those ICPs.
- **"account manager" sits in both sales and customer success.** Put it in one department only,
  or the same person counts twice.
