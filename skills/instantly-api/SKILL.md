---
name: instantly-api
description: Instantly (v2) API reference for the sequencer you run alongside Smartlead. Use when reading Instantly campaign analytics, inbox (account) health, or campaign leads, or when wiring the InstantlyAdapter. UNVALIDATED — endpoints and fields were never checked against a live Instantly account; confirm with read-only calls before any write.
user_invocable: false
---

# Instantly API Reference (UNVALIDATED)

**Status.** Written without access to Instantly's official docs or an API key. Everything below comes from third-party descriptions and recall. Treat it as a hypothesis. Run read-only calls first and correct this file with what you actually see.

Smartlead remains the default sequencer. Instantly is an alternative; `campaigns.platform` decides which adapter handles a campaign.

## Authentication

- Env var: `INSTANTLY_API_KEY` (create under Settings > Integrations > API; API access reportedly needs a Growth plan or above)
- Header: `Authorization: Bearer $INSTANTLY_API_KEY` — the key goes in a header, never in the URL
- Base URL: `https://api.instantly.ai/api/v2`
- Reported rate limit: ~100 req/sec (unconfirmed). Retry 429 and 5xx with backoff.

## Endpoints the adapter uses

| Purpose | Call |
|---|---|
| Campaign status | `GET /campaigns/{id}` |
| Campaign analytics | `GET /campaigns/analytics?id={id}` |
| List inboxes | `GET /accounts?limit=100&starting_after={cursor}` → `{ items, next_starting_after }` |
| One inbox | `GET /accounts/{email}` (inboxes are keyed by email) |
| Add a lead | `POST /leads` body `{ campaign, email, first_name, last_name, company_name, custom_variables, skip_if_in_campaign }` |
| List campaign leads | `POST /leads/list` body `{ campaign, limit, starting_after }` → `{ items, next_starting_after }` |

## Field hypotheses (verify each)

- Campaign `status`: 0 draft, 1 active, 2 paused, 3 completed.
- Account `status`: 1 = connected; negative values = error states. `warmup_status`: 1 active, 0 inactive. `stat_warmup_score`: 0–100.
- Analytics: `emails_sent_count`, `open_count`, `link_click_count`, `reply_count`, `bounced_count`, `unsubscribed_count`.
- Unknown: duplicate-lead response, any "warmup blocked" flag, per-account daily sent count, per-lead sent/reply timestamps.

## Differences from Smartlead

- Inbox ID is the email address, not a numeric ID.
- No `campaign_lead_map_id`; the adapter uses the lead's own `id` as `platform_lead_id`.
- Leads upload one per request (no 100-lead `lead_list` batch call is used).
- Custom variables are `custom_variables`, referenced in copy as `{{variable}}`.

## What is and is not enabled

- `InstantlyAdapter` (`src/providers/outreach/instantly.ts`) implements the shared `OutreachProvider` interface and is tested with mocked `fetch` only.
- `src/lib/lead-upload.ts` still rejects `platform='instantly'` campaigns. Lead upload stays disabled until the upload response is confirmed against a real account.
- There are no Instantly versions of `smartlead-inbox-manager` or `smartlead-campaign-upload-public` yet.

## First live check (read-only, when you have a key)

1. `GET /accounts?limit=1` — confirm auth and the real account fields.
2. `GET /campaigns?limit=1`, then `GET /campaigns/analytics?id=…` — confirm status values and analytics field names.
3. Fix this file and the mappings in `instantly.ts` to match, then re-run `npm test`.
