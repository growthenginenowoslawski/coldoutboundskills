# Supabase Concepts — Progressive Guide

This document explains Supabase from the ground up, starting with the absolute basics and progressing to the specific patterns this codebase uses. Skip to your level.

---

## Level 0: What is Supabase?

Supabase is a hosted PostgreSQL database with a REST API built on top of it. Instead of running your own Postgres server, you:
1. Create a project at supabase.com
2. Define your tables via SQL migrations
3. Connect using the Supabase client library
4. Your application reads/writes data via the API — no raw SQL connections needed

This codebase uses Supabase as its only persistent store. All tables live there. All reads and writes go through the Supabase TypeScript client.

**Key fact:** Supabase IS Postgres. Everything you know about SQL applies. Supabase just adds a REST API layer and auth tools on top.

---

## Level 1: How the Client Works

The Supabase TypeScript client translates method calls into HTTP requests to the PostgREST API (which is what Supabase uses internally to expose Postgres as a REST API).

```typescript
// This TypeScript...
const { data, error } = await supabase
  .from("companies")
  .select("*")
  .eq("client_id", "a29f5829-...")
  .order("created_at", { ascending: false })
  .limit(20);

// ...becomes this HTTP request:
// GET /rest/v1/companies
//   ?client_id=eq.a29f5829-...
//   &order=created_at.desc
//   &limit=20
```

All reads are `select()`. All creates are `insert()`. All modifications are `update()` or `upsert()`. All deletes are `delete()`.

**Pattern in this codebase:** Every table has a corresponding file in `src/db/` (e.g., `src/db/companies.ts`) that wraps the raw Supabase calls in typed functions. You never call `.from("companies")` directly in application code — you call `getCompanies(clientId)` instead.

---

## Level 2: Service Role vs. Anon Key

Supabase has two API keys:

| Key | Who uses it | RLS applies? |
|-----|-------------|-------------|
| `anon` | End users / browser | Yes — RLS controls access |
| `service_role` | Backend / server | No — bypasses RLS entirely |

**This codebase uses ONLY the `service_role` key.** There are no end users — this is an internal backend system. All code runs server-side (Trigger.dev tasks, CLI scripts). The `service_role` key is loaded from environment variables and used in `src/db/supabase.ts` via `getSupabaseAdmin()`.

This means:
- RLS policies are defined on every table (good practice)
- But no actual RLS enforcement happens at the application layer (the service_role bypasses it)
- Multi-tenancy is enforced at the query level — every query includes `client_id` in the WHERE clause

---

## Level 3: Row-Level Security (RLS)

RLS is a Postgres feature that automatically filters rows based on the current database user's identity. In a typical web app:

```sql
-- RLS policy: users can only see their own data
CREATE POLICY "user_sees_own" ON companies
  FOR SELECT USING (auth.uid() = client_id);
```

**In this codebase's situation:** RLS is enabled on every table (for good practice and future-proofing), but no user-facing JWT auth is in use. The service_role key bypasses all RLS. Effective isolation is done at the query level:

```typescript
// Every query scopes by client_id explicitly
supabase.from("companies")
  .select("*")
  .eq("client_id", clientId)  // ← this is our "RLS"
```

**Why enable RLS at all if service_role bypasses it?** Because:
1. It's a safety net if the code ever switches to user-facing auth
2. It prevents accidental reads without a client_id filter
3. It's Supabase best practice

---

## Level 4: Migrations

Migrations are numbered SQL files that are run in order to build the database schema. In this codebase:

```
supabase/migrations/
  0001_grant_service_role.sql   ← grants permissions
  0002_icp_onboarding.sql       ← clients + icp_onboarding tables
  0003_lead_magnets.sql         ← lead_magnets table
  ...
  0011_signals.sql              ← signals table (Stage 10)
```

**Convention:**
- Each file is ADDITIVE ONLY — no existing tables are dropped or columns removed
- Each file has a comment at the top explaining what it does and why
- New columns are added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
- New tables are created with `CREATE TABLE IF NOT EXISTS`

To apply a migration: paste the SQL into the Supabase SQL Editor and run it. That's it — no migration runner command in this repo.

**Schema authority:** The migrations are the source of truth for schema structure. If a table doesn't have a migration, it was created directly in the Supabase Dashboard (the `campaigns` and `campaign_leads` tables appear to be in this category).

---

## Level 5: Indexes and Uniqueness

PostgreSQL indexes speed up queries. This codebase uses them extensively.

**Standard pattern:** Every FK column has an index:
```sql
CREATE INDEX IF NOT EXISTS companies_client_id_idx ON companies (client_id);
CREATE INDEX IF NOT EXISTS signals_client_company_idx ON signals (client_id, company_id);
```

**Partial unique indexes** are used for idempotency:
```sql
-- Only one active job per (job_type, idempotency_key)
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_idempotency_idx
  ON jobs (job_type, idempotency_key)
  WHERE status NOT IN ('failed', 'cancelled');

-- One signal per (client_id, dedup_key) — but null dedup_keys are excluded
CREATE UNIQUE INDEX IF NOT EXISTS signals_client_dedup_idx
  ON signals (client_id, dedup_key)
  WHERE dedup_key IS NOT NULL;
```

**Why partial?** The `WHERE` clause limits which rows participate in the uniqueness constraint. A null dedup_key means "we don't have a fingerprint for this event" — those rows should not block each other.

---

## Level 6: JSONB Columns

Several tables use `jsonb` for flexible structured data:

| Table | Column | What's in it |
|-------|---------|-------------|
| enrichment_runs | input_data / output_data | AI prompt + response |
| jobs | input_data / output_data | Job payload + checkpoints |
| signals | evidence | Raw provider event |
| signals | metadata | Additional signal context |
| email_sequence_steps | variants | A/B email variants |
| campaign_plans | infrastructure_status | Warmup status flags |

**Rule of thumb:** If you know the exact shape upfront and need to filter/index by it → use proper columns. If the shape varies by provider/type or you're storing raw API responses → use `jsonb`.

**Querying jsonb:**
```sql
-- Read a nested key
SELECT output_data->>'icp_fit' FROM enrichment_runs;
SELECT output_data->'_signal_checkpoint'->>'newSignalCount' FROM jobs;

-- Cast to a type
SELECT (output_data->>'fit_score')::int FROM enrichment_runs;

-- Filter on a jsonb key (slower than a proper column)
SELECT * FROM enrichment_runs WHERE output_data->>'icp_fit' = 'true';
```

---

## How This Codebase Wraps Supabase

Every table access goes through a typed helper function:

```
src/db/
  supabase.ts       → getSupabaseAdmin(): the singleton client
  companies.ts      → getCompanies(), upsertCompany(), ...
  signals.ts        → upsertSignal(), expireStaleSignals(), ...
  jobs.ts           → claimJob(), updateJob(), completeJob(), ...
  qualifications.ts → storeQualification(), storeEscalationResult(), ...
```

The pattern:
```typescript
// 1. Get the client
const db = getSupabaseAdmin();

// 2. Run the query
const { data, error } = await db
  .from("companies")
  .select("*")
  .eq("client_id", clientId);

// 3. Handle error or return typed data
if (error) throw new Error(`getCompanies failed: ${error.message}`);
return data as CompanyRow[];
```

Errors are always thrown — never silently swallowed. The caller is responsible for catching.

---

## Common Gotchas

1. **`maybeSingle()` vs `single()`** — `single()` throws if no row. `maybeSingle()` returns null. Use `maybeSingle()` for lookups that might find nothing.

2. **PostgREST URL length limit** — `.in("id", arrayOf3000UUIDs)` generates a ~115KB URL that PostgREST rejects. Max safe `.in()` size is ~50-100 items. For large sets, use count queries or batch the IDs.

3. **`service_role` bypasses RLS** — if you switch to user-facing auth later, you'll need real RLS policies. Don't delete them just because they're not currently enforced.

4. **`jsonb` vs `json`** — always use `jsonb`. It's binary-stored, indexed, and queryable. `json` is text-stored and unqueryable.

5. **Cascade deletes** — most FKs in this codebase use `ON DELETE CASCADE`. Deleting a `client` deletes all their companies, lists, signals, enrichment runs, etc. This is intentional but irreversible.
