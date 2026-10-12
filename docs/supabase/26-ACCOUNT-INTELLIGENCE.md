# ACCOUNT INTELLIGENCE

## 1. What is this table?

`account_intelligence` stores one row per `(client_id, company_id)` pair. It is the derived-intelligence layer that sits between raw signals and actionable outreach decisions.

- **`opportunity_score`** (Stage 12/13): A 0–100 integer answering "how good is this account as a target?" — ICP fit × signal quality. Time-invariant within a signal's TTL. Set by `rescoreCompany()` whenever new signals arrive or old signals expire.
- **`priority_score`** (Stage 14): A 0–100+ numeric answering "which accounts should we act on **today**?" — `opportunity_score × recency_multiplier`. Decays daily via exponential half-life. Must be recomputed on every prioritization run.
- **`prioritized_at`** (Stage 14): When the priority_score was last calculated. NOT a freshness guarantee — the score decays between runs even without new signals.

Created by migration `0012_account_intelligence.sql` (Stage 12). Extended by `0013_account_priority.sql` (Stage 14).

## 2. Why does this table exist?

Without `account_intelligence`, every "which accounts should I contact?" query would have to re-aggregate all active signals, apply ICP weights, and compute decay inline — O(n×signals) work on every request.

The table caches two computed values so that:
1. **Signal ingestion** triggers a targeted rescore of only the affected company (not a global re-rank).
2. **Prioritization** reads a single row per account with pre-computed scores — no real-time signal joins needed.

It also creates a clean conceptual boundary:

```
Raw signal data  (signals)
  ↓ normalizeBatch + upsertSignal + rescoreCompany
opportunity_score (account_intelligence)    ← "how good is this account?"
  ↓ × 2^(−days/14)                         ← Stage 14 half-life decay
priority_score   (account_intelligence)    ← "how urgent is this account today?"
```

## 3. What data does it store?

| Column | Type | What it means |
|--------|------|---------------|
| `id` | uuid | Row identifier |
| `client_id` | uuid | Tenant scoping — which client this intelligence belongs to (→ clients.id) |
| `company_id` | uuid | Which company (→ companies.id) |
| `opportunity_score` | integer | 0–100 ICP fit × signal quality. Time-invariant within signal TTL. Set by Stage 12/13. INITIAL_HYPOTHESIS_NOT_VALIDATED for weights. |
| `opportunity_score_updated_at` | timestamptz | When opportunity_score was last recomputed. NOT a guarantee of freshness. |
| `score_inputs` | jsonb | Full breakdown: signal list, weights, intermediate values. Used for debugging and auditability. |
| `priority_score` | numeric | NULL if never prioritized; 0 if prioritized with no active signals; >0 if active signals exist. Decays daily. Set by Stage 14. INITIAL_HYPOTHESIS_NOT_VALIDATED. |
| `prioritized_at` | timestamptz | When priority_score was last calculated. NOT a freshness guarantee. |
| `created_at` | timestamptz | Row creation time |
| `updated_at` | timestamptz | Last modification time (set on every rescore and every prioritization write) |

## 4. How is it connected to other tables?

```
clients (client_id)  →  account_intelligence  ←  companies (company_id)
                                 ↑
                    signals (active signals for this company)
                    are read at rescore time; not stored here
```

Both foreign keys use `ON DELETE CASCADE` — deleting a client or company removes their intelligence rows automatically.

## 5. When is it written to?

**opportunity_score is written by:**
- `rescoreCompany(clientId, companyId)` in `src/lib/score-recompute.ts`
- Triggered whenever: (a) a new signal is inserted (upsertSignal returns `created: true`), or (b) a signal expires (expireStaleSignals returns affected company IDs)
- Uses `ON CONFLICT (client_id, company_id) DO UPDATE` — safe to run repeatedly

**priority_score is written by:**
- `setPriorityScore(clientId, companyId, priorityScore, prioritizedAt)` in `src/db/account-intelligence.ts`
- Triggered by `runAccountPrioritization()` in `src/tasks/account-prioritization.ts`
- Intended to run daily (recommended: 06:00 UTC per client, after signal refresh at 02:00 and expiry at 04:00)
- Does NOT touch `opportunity_score` or `score_inputs`

## 6. How is it queried?

**Top accounts by opportunity (signal quality, time-invariant):**
```sql
SELECT * FROM account_intelligence
WHERE client_id = $clientId
ORDER BY opportunity_score DESC
LIMIT 20;
```
Served by index: `account_intelligence_client_score_idx`

**Top accounts by priority (what to act on today):**
```sql
SELECT * FROM account_intelligence
WHERE client_id = $clientId
  AND priority_score IS NOT NULL
ORDER BY priority_score DESC
LIMIT 20;
```
Served by index: `account_intelligence_priority_idx`

**Both queries are scoped to `client_id` first** — no cross-client data access is possible through the indexes.

`rankAccountsForClient()` in `src/lib/account-prioritization.ts` does the priority query using three DB round-trips (account_intelligence → signals → companies), then groups signals client-side.

## 7. Indexes

| Index name | Columns | Purpose |
|------------|---------|---------|
| `account_intelligence_client_score_idx` | `(client_id, opportunity_score DESC)` | "Top N accounts by fit" queries |
| `account_intelligence_client_company_idx` | `(client_id, company_id)` | Point-lookups by (client, company) |
| `account_intelligence_staleness_idx` | `(client_id, opportunity_score_updated_at)` | Find accounts due for rescore |
| `account_intelligence_priority_idx` | `(client_id, priority_score DESC NULLS LAST) WHERE priority_score IS NOT NULL` | "Top N accounts to act on today" queries (Stage 14) |

## 8. Constraints

| Constraint | What it enforces |
|------------|-----------------|
| `account_intelligence_client_company_key` (UNIQUE) | One row per (client_id, company_id) — no duplicates |
| `opportunity_score` CHECK | `0 <= opportunity_score <= 100` |
| `client_id` FK → `clients.id` ON DELETE CASCADE | Deleting a client removes all their intelligence |
| `company_id` FK → `companies.id` ON DELETE CASCADE | Deleting a company removes its intelligence rows |

`priority_score` has no explicit range constraint — it is bounded by the formula (`opportunity_score × recency_multiplier` where `recency_multiplier` ∈ (0, 1]) but the DB does not enforce this.

## 9. The scoring formulas

**opportunity_score** (Stage 12/13):
```
signal_strength_avg × icp_alignment_multiplier × signal_count_bonus
```
All weights are INITIAL_HYPOTHESIS_NOT_VALIDATED — not validated against campaign outcomes.

**priority_score** (Stage 14):
```
priority_score = opportunity_score × recency_multiplier
recency_multiplier = 2^(−daysSinceLastSignal / HALF_LIFE_DAYS)
```
Where:
- `HALF_LIFE_DAYS = 14` (INITIAL_HYPOTHESIS_NOT_VALIDATED — 14 days was the initial guess)
- At `days = 0`: multiplier = 1.0 (no decay for brand-new signals)
- At `days = 14`: multiplier = 0.5 (priority halved — the half-life property)
- At `days = 28`: multiplier = 0.25 (priority quartered)
- At `days = null` (no active signals): `priority_score = 0`

## 10. Security

- **RLS**: Enabled (`ALTER TABLE account_intelligence ENABLE ROW LEVEL SECURITY`) but **no policies defined**. All access is via the `service_role` key in server-side code. Unauthenticated/anon clients cannot access this table. See `25-SUPABASE-SECURITY.md` FINDING 1.
- **Tenant isolation**: Every read and write in application code is scoped to `client_id`. The unique constraint and indexes both use `client_id` as the leading column.
- **No credentials in score_inputs**: The `score_inputs` JSONB column stores signal metadata, not API keys.

## 11. What this table does NOT contain

- Raw signal data — that lives in `signals`. account_intelligence stores only derived scores.
- Contact information — that lives in `contacts`.
- Campaign state — that lives in `campaigns` and `campaign_leads`.
- Outreach readiness — "Why Now" analysis has not been added (Stage 14 explicitly excludes it).
- Priority rank — rank is computed at query time from `ORDER BY priority_score DESC`, never stored.
- Multiple history points — each rescore or reprioritization overwrites the single row in place.

## 12. Remaining limitations (as of Stage 14)

- `opportunity_score` weights are unvalidated — the formula produces plausible scores but has not been calibrated against actual campaign reply rates.
- `priority_score` half-life (14 days) is unvalidated — 14 was chosen as a reasonable starting hypothesis, not derived from data.
- `prioritized_at` does not auto-invalidate stale priority scores — the application must run the prioritization task daily.
- No RLS policies — blocking on auth/tenant-mapping design decision.
- No contact state — there is no signal from "we already sent 5 emails to this company; don't prioritize it again."

## 13. Example row

```json
{
  "id": "a1b2c3d4-...",
  "client_id": "a29f5829-5412-49be-9a77-41c3edf3c14b",
  "company_id": "437a05ca-4443-418b-ba2f-37b53531f339",
  "opportunity_score": 63,
  "opportunity_score_updated_at": "2026-09-03T20:01:52Z",
  "score_inputs": {
    "finalScore": 63,
    "signalCount": 1,
    "signals": [
      { "type": "funding_round", "strength": 70, "freshness": 0.9, "contribution": 63 }
    ]
  },
  "priority_score": 44.55,
  "prioritized_at": "2026-09-03T20:01:59Z",
  "created_at": "2026-09-03T20:01:52Z",
  "updated_at": "2026-09-03T20:01:59Z"
}
```

In this example:
- `opportunity_score = 63` — the account's ICP fit × signal quality
- `priority_score = 44.55` — scored 7 days after the signal arrived; `63 × 2^(−0.5) ≈ 44.55`
- `prioritized_at` — when the 44.55 was calculated; the score continues to decay after this moment
