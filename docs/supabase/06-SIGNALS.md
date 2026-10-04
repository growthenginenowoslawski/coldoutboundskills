# SIGNALS

## 1. What is this table?

The `signals` table stores normalized buying signals at target companies. A signal is a business event that indicates a company might be ready to buy — a new job posting for a VP of Sales, a recent funding round, an executive hire. Each event is one row.

This is the heart of the GTM Signal Engine built in Stage 10/11.

## 2. Why does this table exist?

Cold outreach without signals is spray-and-pray. Signals answer the question: **"Why are we reaching out to THIS company RIGHT NOW?"** By detecting that Stripe is hiring 20 enterprise sales reps or that a startup just raised a Series B, you can write personalized "why now" copy that dramatically improves reply rates.

The table is designed to be:
- **Multi-tenant**: every signal is scoped to `(client_id, company_id)`
- **Deduplicated**: the same event from PredictLeads won't be inserted twice
- **Time-aware**: signals expire (job postings go stale after 14 days; funding rounds after 90 days)
- **Deterministically scored**: strength and freshness are computed without AI

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Unique identifier for this signal |
| `client_id` | uuid | Which client's data this is (→ clients.id) |
| `company_id` | uuid | Which company this signal is about (→ companies.id) |
| `signal_type` | text | Category of event (see types below) |
| `signal_source` | text | Which provider found this: "predictleads", "test" |
| `signal_title` | text | Short human-readable title, e.g., "Hiring: Senior Account Executive" |
| `signal_description` | text | Longer description (optional) |
| `evidence` | jsonb | Raw payload from the provider — kept verbatim for audit and AI reasoning |
| `signal_strength` | int | Base strength 0-100 for this signal type (deterministic, not AI) |
| `confidence` | numeric(4,3) | How certain we are this event is real (0.000 to 1.000) |
| `occurred_at` | timestamptz | When the business event actually happened |
| `detected_at` | timestamptz | When the system ingested this signal |
| `expires_at` | timestamptz | When this signal goes stale (occurred_at + TTL) |
| `source_url` | text | URL to the original source page |
| `status` | text | `active`, `expired`, or `dismissed` |
| `metadata` | jsonb | Provider-specific extras |
| `dedup_key` | text | SHA-256 fingerprint preventing duplicate inserts |
| `created_at` | timestamptz | When this row was created in the DB |

**Signal types:**

| Type | TTL | Meaning |
|------|-----|---------|
| `executive_hire` | 30 days | New executive joined the company |
| `funding_round` | 90 days | Company raised money |
| `job_posting` | 14 days | Company is hiring for a relevant role |
| `news_mention` | 7 days | Company appeared in the news |
| `website_change` | 60 days | Company's website changed significantly |
| `product_launch` | 60 days | Company launched a new product |
| `partnership` | 90 days | Company announced a partnership |
| `technology_change` | 90 days | Company changed their tech stack |
| `competitor_mention` | 14 days | Company mentioned a competitor |
| `award` | 180 days | Company won an award |
| `expansion` | 90 days | Company expanded to new markets |
| `test` | 7 days | Used in automated tests only |

**Confidence levels:**
- `0.800` — Tier 1 dedup: backed by a stable provider event ID (most reliable)
- `0.600` — Tier 2 dedup: content fingerprint match
- `0.500` — Tier 3: no fingerprint available (accept duplicates)

## 4. Primary Key

`id` — UUID, auto-generated.

## 5. Foreign Keys

- `client_id → clients(id)` ON DELETE CASCADE — if client deleted, all their signals deleted
- `company_id → companies(id)` ON DELETE CASCADE — if company deleted, its signals deleted

## 6. What comes before it?

- `clients` must exist (for client_id)
- `companies` must exist (for company_id)
- The PredictLeads API credentials must be configured
- The Trigger.dev signal-ingestion task must run

## 7. What comes after it?

The signals table is currently a destination (signals flow INTO it). Downstream consumers are being built:
- **WHY NOW AI analysis** — `enrichment_runs` with `task_type='signal_intelligence'` reads signals and produces a `whyNow` assessment
- **Personalization** — the `whyNow` text feeds into personalized email copy
- **Contact selection** — strong signals for a company bubble it to the top of the outreach queue

## 8. Who writes to this table?

- **Trigger.dev `signal-ingestion` task** — the primary writer. Calls `upsertSignal()` in `src/db/signals.ts`.
- **Integration test** (`scripts/signal-ingestion-integration-test.ts`) — wrote 3,202 rows for Stripe, OpenAI, Notion, Anthropic as part of Stage 11 testing.

**How upsert works:**
1. Try INSERT the signal row
2. If PostgreSQL error 23505 (unique constraint on `client_id + dedup_key`) → look up the existing row
3. Return `{ row, created: true/false }`

## 9. Who reads from this table?

- `getSignalsByCompany(companyId, clientId)` in `src/db/signals.ts` — used by the WHY NOW layer
- `getSignalsByClient(clientId)` — used for client-level reporting
- `expireStaleSignals(clientId)` — marks signals past their `expires_at` as 'expired'
- Integration test — reads signals to verify tenant isolation

## 10. Real example

A job posting signal for Stripe ingested from PredictLeads:
```
id:               (uuid)
client_id:        a29f5829-5412-49be-9a77-41c3edf3c14b  (Gramscode)
company_id:       cac84e2a-caf5-4248-9190-17227de64af8  (Stripe)
signal_type:      job_posting
signal_source:    predictleads
signal_title:     Hiring: Senior Enterprise Account Executive
signal_strength:  65
confidence:       0.800
occurred_at:      2026-08-25T12:54:28Z
expires_at:       2026-09-08T12:54:28Z  (14 days later)
status:           active
dedup_key:        (sha256 hash of "pid:predictleads:uuid-from-api")
```

After Stage 11 integration test: 3,202 signals for Stripe + Notion are in the database.

## 11. How this table participates in a campaign

Signals power the "why now" layer of personalization. The flow:

1. Signal ingestion runs → `signals` table populated for target companies
2. Before writing an email for Company X, the system queries: *"what signals exist for Company X that are still active?"*
3. Active signals are ranked by `signal_strength × freshness_score` (freshness decays over the TTL window)
4. Top signals feed into the WHY NOW AI task → `enrichment_runs` records the AI call
5. The AI produces a `whyNow` sentence like: *"Stripe is hiring 20 enterprise reps — they're scaling their outbound motion right now."*
6. That sentence becomes the personalized opening of the cold email

## 12. Simple mental model

"signals = things happening around a target company that tell you why you should reach out right now."

## 13. SQL to inspect it

```sql
-- All active signals for Stripe
SELECT signal_type, signal_title, signal_strength, confidence,
       occurred_at, expires_at, status
FROM signals
WHERE company_id = 'cac84e2a-caf5-4248-9190-17227de64af8'
  AND status = 'active'
ORDER BY occurred_at DESC;

-- Signal count by type across all companies (for a client)
SELECT signal_type, COUNT(*) AS count,
       ROUND(AVG(signal_strength)) AS avg_strength
FROM signals
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
  AND status = 'active'
GROUP BY signal_type
ORDER BY count DESC;

-- Signals expiring in the next 3 days (act on these urgently)
SELECT s.signal_title, s.signal_type, s.expires_at,
       co.name AS company
FROM signals s
JOIN companies co ON co.id = s.company_id
WHERE s.client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
  AND s.status = 'active'
  AND s.expires_at < now() + interval '3 days'
ORDER BY s.expires_at;

-- How many new signals were ingested today?
SELECT COUNT(*) AS new_today
FROM signals
WHERE client_id = 'a29f5829-5412-49be-9a77-41c3edf3c14b'
  AND detected_at >= now() - interval '24 hours';

-- Dedup check: verify no duplicates for a client
SELECT client_id, dedup_key, COUNT(*)
FROM signals
WHERE dedup_key IS NOT NULL
GROUP BY client_id, dedup_key
HAVING COUNT(*) > 1;
```
