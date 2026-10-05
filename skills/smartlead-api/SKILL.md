---
name: smartlead-api
description: Smartlead API endpoint reference and patterns. Use for any Smartlead campaign, lead, email account, analytics, or inbox operation. Covers auth, rate limiting, and all commonly used endpoints.
user_invocable: false
---

# Smartlead API Reference

## Authentication

All requests use query parameter auth: `?api_key={SMARTLEAD_API_KEY}`

Environment variable: `$SMARTLEAD_API_KEY`

Base URL: `https://server.smartlead.ai/api/v1`

## Rate Limiting

- **Standard plan:** 2,000 req/min (33 req/sec)
- **Higher plans:** 3,000 req/min (50 req/sec)
- Retry on 429 and 5xx with exponential backoff
- For bulk operations, use `p-limit` or `PQueue` with 8-15 concurrency

## CLI Quick Reference

The `smartlead` CLI (`@smartlead/cli`) wraps all API endpoints. Use it for quick lookups:

```bash
# Campaigns
smartlead campaigns list
smartlead campaigns get <id>
smartlead campaigns create --name "Campaign Name"

# Leads
smartlead leads list --campaign-id <id>
smartlead leads add --campaign-id <id> --file leads.csv

# Email accounts
smartlead email-accounts list
smartlead email-accounts get <id>

# Analytics
smartlead analytics campaign <id>
smartlead analytics overall

# Master inbox
smartlead inbox replies
```

## API Endpoints

### Campaigns

```
GET  /campaigns/{id}                    — Fetch campaign by ID
POST /campaigns/create                  — Create new campaign
POST /campaigns/{id}/status             — Update status (START, PAUSED, STOP)
     Body: { "status": "START" }
```

### Campaign Email Accounts

```
GET    /campaigns/{id}/email-accounts   — List accounts assigned to campaign
POST   /campaigns/{id}/email-accounts   — Add accounts to campaign
       Body: { "email_account_ids": [1, 2, 3] }
DELETE /campaigns/{id}/email-accounts   — Remove accounts from campaign
```

### Campaign Sequences

```
GET  /campaigns/{id}/sequences          — Fetch sequences
POST /campaigns/{id}/sequences          — Save/update sequences
     Body: { "sequences": [{ "seq_number": 1, "seq_delay_details": { "delay_in_days": 0 }, "subject": "...", "email_body": "..." }] }
```

**A/B/C Variants** — use `seq_variants` array inside each sequence:
```json
{
  "sequences": [{
    "seq_number": 1,
    "seq_delay_details": { "delay_in_days": 0 },
    "seq_variants": [
      { "variant_label": "A", "subject": "Subject A", "email_body": "<div>Body A</div>" },
      { "variant_label": "B", "subject": "Subject B", "email_body": "<div>Body B</div>" },
      { "variant_label": "C", "subject": "Subject C", "email_body": "<div>Body C</div>" }
    ]
  }]
}
```
Note: Do NOT include `distribution` field — SmartLead splits evenly automatically.

**Email body order:** content → PS unsub line → `%signature%` (signature always last)

### Campaign Settings & Schedule

```
POST /campaigns/{id}/settings           — Update settings
     Body: { "track_settings": [...], "stop_lead_settings": "..." }

POST /campaigns/{id}/schedule           — Update schedule
     Body: { "timezone": "US/Eastern", "days_of_the_week": [1,2,3,4,5], "start_hour": "08:00", "end_hour": "17:00", "min_time_btw_emails": 8, "max_new_leads_per_day": 30 }
```

### Leads

```
GET  /leads/?api_key={key}&email={email}
     — Lookup lead by email address

POST /campaigns/{id}/leads
     — Add leads to campaign (batch up to 100)
     Body: { "lead_list": [{ "email": "...", "first_name": "...", "last_name": "...", "company_name": "...", "custom_fields": { "field1": "value1" } }] }
```

### Analytics

```
GET /analytics/day-wise-overall-stats
    ?api_key={key}&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
    — Day-by-day metrics (sent, opened, clicked, replied, bounced)

GET /analytics/day-wise-positive-reply-stats
    ?api_key={key}&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
    — Day-by-day positive reply counts

GET /analytics/overall-stats-v2
    ?api_key={key}&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
    — Overall campaign metrics for date range

GET /analytics/campaign/list
    ?api_key={key}
    — List all campaigns with summary stats

GET /campaigns/{id}/analytics
    ?api_key={key}
    — Analytics for specific campaign

GET /campaigns/{id}/analytics-by-date
    ?api_key={key}&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
    — Campaign analytics for specific date range (sent_count, reply_count)
```

### Email Accounts (Global)

```
GET  /email-accounts
     ?api_key={key}&offset=0&limit=100
     — List all email accounts (paginated)

GET  /email-accounts/{id}
     ?api_key={key}
     — Get specific email account

POST /email-accounts/save
     — Create/update email account (SMTP details, warmup, etc.)
```

Note: the list endpoint returns each account's tags as `tags: [{ tag_id, tag_name, tag_color }]`.
The single-account `GET /email-accounts/{id}` does **not** include tags — always read tags from the list.

### Email Account Tags (undocumented)

None of these appear in Smartlead's public docs or `llms.txt`, but all are verified working.

```
GET    /email-accounts/tags
       ?api_key={key}
       — List all email-account tags: [{ id, name, color }]

POST   /tags
       — CREATE a tag (note: root-level path, not under /email-accounts)
       Body: { "name": "Batch 1", "color": "#B6FCB1" }
       Returns: { ok, data: { id, name, color, ... } }

POST   /email-accounts/tag-manager
       — UPDATE an existing tag only; `id` is required and it cannot create
       Body: { "id": 42, "name": "...", "color": "#..." }

POST   /email-accounts/tag-mapping
       — ASSIGN tags to accounts (max 25 accounts per call)
       Body: { "email_account_ids": [1, 2, 3], "tag_ids": [42] }
       Returns per-account results plus { total_processed, added, skipped, failed }
       — already-tagged accounts come back as `skipped`, so calls are idempotent

DELETE /email-accounts/tag-mapping
       — UNASSIGN tags, same body shape
```

**Gotchas:**

- `tag-mapping` takes `email_account_ids`, **not** `emails`. The `bcharleson/smartlead-cli`
  source documents `emails` — that shape returns a 400.
- Creation is `POST /tags`, assignment is `POST /email-accounts/tag-mapping`. Easy to swap.
- Any unrecognized single-segment `POST /email-accounts/<anything>` falls through to the
  update-account route and returns `"account_id" must be a number`. That reads like a bad
  payload but actually means **the path doesn't exist** — don't chase the validation message.
  Likewise `DELETE /email-accounts/<x>` hits the *delete account* route. Probe carefully.
- Tag names are not unique — creating the same name twice yields two distinct ids. Always
  `GET /email-accounts/tags` first and reuse the existing id.

**Bulk tagging pattern** — chunk to 25, and verify by re-reading rather than trusting the response:

```bash
# assign a tag to a chunk of accounts (max 25)
curl -s -X POST "https://server.smartlead.ai/api/v1/email-accounts/tag-mapping?api_key=$SMARTLEAD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email_account_ids":[1001,1002],"tag_ids":[42]}'
```

After a bulk run, re-paginate `/email-accounts` and recompute the sets from that fresh
snapshot — confirm counts, that intended groups are disjoint, that no pre-existing tag was
dropped, and that no out-of-scope account was touched.

### Master Inbox

```
POST /master-inbox/inbox-replies
     Body: { "api_key": "...", "offset": 0, "limit": 50, "message_type": "RECEIVED" }
     — Fetch inbox replies with filtering and pagination
```

## Sub-Client / Custom API Key Pattern

- **Normal sub-clients:** Pass `?api_key={MAIN_KEY}&client_id={CLIENT_ID}` on all requests
- **Custom API key clients:** Use the client's own API key directly, no `client_id` param

## TypeScript Pattern

```typescript
const SMARTLEAD_API = "https://server.smartlead.ai/api/v1";
const API_KEY = process.env.SMARTLEAD_API_KEY;

// GET example
const res = await fetch(`${SMARTLEAD_API}/campaigns/${campaignId}?api_key=${API_KEY}`);
const campaign = await res.json();

// POST example (add leads)
const res = await fetch(`${SMARTLEAD_API}/campaigns/${campaignId}/leads?api_key=${API_KEY}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ lead_list: leads.slice(0, 100) }),
});
```

## Performance tip: cache the email-accounts list

If you hit `/email-accounts` more than a few times per script, paginate once at the start and keep the result in memory. Smartlead's pagination returns 100 per page — for accounts with thousands of inboxes, a full walk takes 30+ seconds.

For persistent caching across scripts, write the list to a local JSON file and refresh on a timer (e.g. every hour). The `/smartlead-inbox-manager` skill has scripts that implement this pattern.

---

## What to do next

This is a reference skill — no direct next step. Used by all skills that interact with Smartlead (`/smartlead-inbox-manager`, `/smartlead-campaign-upload-public`, `/email-deliverability-audit`, `/positive-reply-scoring`, `/deliverability-incident-response`, etc.).

Return to the skill that sent you here.

## Related skills

- Every skill that touches Smartlead uses this reference.
