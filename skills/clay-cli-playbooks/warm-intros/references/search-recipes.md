# Search recipes for the alumni pull

Grammar source: `clay searches query-mode reference` (read it live; the notes below are what CLI 1.3.0
accepted on 2026-09-23). Searches spend the workspace's search-result quota, not credits: read
`periodQuota` on every page (`limit`, `used`, `remaining`, `resetsAt`).

## The shapes

Former employees of the named customers, US, with non-employment roles excluded:

```
select from people
where experiences.any(is_current = false
        and company.domain in ("customer-one.com", "customer-two.com")
        and not job_title contains ("advisor", "advisory", "council", "fellow", "board", "investor", "intern"))
  and location_country = "United States"
```

Add the installer's ICP as a **separate** current-role arm, because it describes a different experience:

```
  and experiences.any(is_current = true and seniority in ("VP", "Director", "Head")
        and job_title is_similar_to ("Sales", "Revenue"))
```

Add the in-query still-employed exclusion when the search surface is not overloaded:

```
  and not experiences.any(is_current = true and company.domain in ("customer-one.com", "customer-two.com"))
```

Same metro as the installer's reps (optional): `and location_city in ("Denver", "Boulder") and
location_state = "Colorado"`. City values are exact, not `contains`.

Rules the reference states and the pull depends on:

- **Former employer is `company.domain` inside `experiences.any(is_current = false …)`**, never
  `clay.filter_to_companies`, which means *current* employer.
- One `experiences.any(...)` per role. The customer arm and the ICP arm are two roles, so two arms; the
  conditions of one role stay inside one arm.
- `contains` is whole-word. `"advisor"` does not match `"advisory"`, so list both.
- A company whose domain you are not sure of: use `company_name contains "…"` inside the arm rather than
  guess a domain. A wrong domain returns zero, not an error.

## Run and page

```
clay searches query-mode create --query '<query>'          # -> searchId
clay searches query-mode run <searchId> --limit 10          # first page; hasMore tells you if there is more
```

Per row the search returns `first_name`, `last_name`, `linkedin_url`, `location {name, city,
state_or_province}` and `matched_experiences[] {company, title, location, start_date, end_date}`. **It
does not return the person's current employer or title.** Get those from the free Enrich Person
function: `experience[]` entries with `is_current: true`, each with `company`, `company_domain`,
`title`, plus `org` and `title` at the top level.

## Operational notes measured 2026-09-23

- The workspace-wide concurrent-request limit (`rate_limited`, "Too many concurrent requests in your
  workspace") hit repeatedly while other sessions were searching. Retry with a 20 to 30 second wait; do not
  hammer.
- Under that load, every query with more than the bare former-employer arm (a second arm, a
  `not experiences.any(...)` clause, or a `not job_title contains` exclusion inside the arm) was created
  without a validation error but its pages returned `server_error` (HTTP 504) or stayed rate-limited
  across 12 retries, while the one-arm former-employer query completed. Whether that is load or query
  cost was not separable on the day. When the heavy form times out, run the
  one-arm form and apply the still-employed check and the ICP from Enrich Person in the agent. The
  answer is the same; only where the filtering runs changes.
- `matched_experiences` can hold several entries for one person (promotions inside the customer); the
  earliest `start_date` and latest `end_date` give the tenure.
- Dates come back as `YYYY` on some rows and `YYYY-MM` on others. Never print a month that was not given.
