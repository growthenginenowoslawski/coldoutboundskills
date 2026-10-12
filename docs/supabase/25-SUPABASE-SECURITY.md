# Supabase Security Documentation

This document records the security posture of this Supabase database — what protections are in place, what gaps exist, and what the recommended fixes are. **No security policies have been changed as part of writing this document.** All findings are documentation-only.

> **Critical constraint:** If you discover a security issue, document it here as:
> PROBLEM / WHY IT MATTERS / CURRENT STATE / RECOMMENDED FIX / WHAT COULD BREAK
> Then stop and ask before changing any production security configuration.

---

## Current Authentication Architecture

```
Application code (Trigger.dev tasks, CLI scripts)
  ↓
getSupabaseAdmin() [src/db/supabase.ts]
  ↓ uses SUPABASE_SERVICE_ROLE_KEY
Supabase API (PostgREST)
  ↓ service_role bypasses RLS
PostgreSQL (all tables)
```

**There is no user-facing JWT auth.** This is a pure backend system — no browser clients, no end-user login flow. All database access goes through the service_role key, which bypasses Row-Level Security.

---

## RLS Status by Table

All tables have RLS enabled via `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. However, because all access uses the service_role key, no RLS policies are actively enforced today.

| Table | RLS Enabled | Policies Defined | Effectively Enforced |
|-------|-------------|-----------------|---------------------|
| clients | Yes | service_role grants only | No (service_role bypasses) |
| icp_onboarding | Yes | service_role grants only | No |
| lead_magnets | Yes | service_role grants only | No |
| campaign_strategies | Yes | service_role grants only | No |
| campaign_plans | Yes | service_role grants only | No |
| email_sequences | Yes | service_role grants only | No |
| email_sequence_steps | Yes | service_role grants only | No |
| list_quality_scores | Yes | service_role grants only | No |
| campaign_reviews | Yes | service_role grants only | No |
| account_intelligence | Yes (Migration 0012) | service_role grants only | No |
| contact_suppression | **Yes (Migration 0014)** | None yet | No — policies pending auth/tenant mapping |
| companies | Yes | service_role grants only | No |
| lists | Yes | service_role grants only | No |
| list_members | Yes | service_role grants only | No |
| contacts | Yes | service_role grants only | No |
| signals | **Yes (Migration 0015)** | None yet | No — policies pending auth/tenant mapping |
| enrichment_runs | Yes (0007+) | service_role grants only | No |
| jobs | Yes (in code) | service_role grants only | No |
| campaigns | Unknown (pre-migration) | None | No |
| campaign_leads | **Yes (confirmed live)** | **None (FINDING 6)** | No (service_role bypasses; default-deny for JWT callers) |

### FINDING 1: signals table had no `ENABLE ROW LEVEL SECURITY` — RESOLVED

**PROBLEM:** Migration `0011_signals.sql` did not include `ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY`. Every other table created in migrations 0002–0010 explicitly enables RLS.

**WHY IT MATTERS:** The signals table stores client-specific buying intelligence — which companies a client is targeting, what signals they're watching. If RLS were to be enforced in the future (e.g., if an anon key were used), the signals table would be world-readable.

**CURRENT STATE:** **RESOLVED in Stage 16 (Migration 0015).** RLS was confirmed disabled on `signals` (the only table with `rowsecurity=false`). Supabase flagged this as a critical security issue. RLS has now been enabled. No policies are defined; service_role still has full access.

**FIX APPLIED:**
```sql
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
```

**WHAT BROKE:** Nothing. Service_role bypasses RLS. All existing queries continue to work. The anon/publishable key now correctly cannot read signals (no policies defined = deny by default for non-service-role access).

> **STATUS: RESOLVED.** Migration 0015 applied on 2026-09-04.
>
> **Next step for full tenant isolation:** Once authenticated user flows are implemented, add a policy such as:
> ```sql
> CREATE POLICY "clients see own signals"
>   ON public.signals FOR ALL TO authenticated
>   USING (client_id = auth.jwt()->'app_metadata'->>'client_id');
> ```

---

---

## Campaign Client Scoping

### FINDING 4: campaigns table had no client_id — resolved in Stage 15

**PROBLEM:** The `campaigns` table (created via Supabase Dashboard, no migration) had no `client_id` column. Any campaign could be read or written without client scoping. A query that omitted client filtering would return all campaigns across all clients.

**WHY IT MATTERS:** Campaigns contain platform credentials (`platform_campaign_id`), targeting configuration, and link to contact pools. Cross-client access would expose one client's campaign data to another.

**CURRENT STATE:** **RESOLVED in Stage 15 (Migration 0014).** `client_id NOT NULL FK → clients(id)` has been added to `campaigns`. The `getCampaignsByClientId()` and `getCampaignById()` functions in `src/db/campaigns.ts` both scope reads by `client_id` as defence-in-depth. The DB constraint is the authoritative gate.

`campaign_leads` also has `client_id NOT NULL` added in Stage 15, plus a composite FK `(client_id, campaign_id) → campaigns(client_id, id)` that enforces client consistency at the database level.

**WHAT COULD BREAK:** Existing campaigns rows had 0 rows at the time of migration — NOT NULL without DEFAULT was safe. All future campaign creation must supply `client_id`.

> **STATUS: RESOLVED.** Migration 0014 applied on 2026-09-04.

---

## API Key Security

### FINDING 2: API secrets must NEVER be logged

**PROBLEM:** This system handles several high-value API keys: Smartlead API key, PredictLeads API key + token, Prospeo API key, Supabase service_role key.

**CURRENT STATE:** Code inspection shows no logging of secrets. The `.env` file is gitignored. However, `enrichment_runs.input_data` stores the AI prompt content — if a secret were accidentally included in a prompt, it would be stored in the database.

**RECOMMENDED FIX:**
- API keys are loaded from environment variables, never hardcoded. This is correctly implemented.
- Keep `.env` in `.gitignore`. Confirmed.
- Never include raw API keys in AI prompt content (input_data). Confirmed — prompts contain company data, not credentials.

**WHAT COULD BREAK:** N/A — this is a status check, not a proposed change.

---

## Multi-Tenant Isolation

### FINDING 5: lists and list_members have no client_id — UNRESOLVED

**PROBLEM:** The `lists` and `list_members` tables have no `client_id` column. `campaigns.list_id` can reference any list regardless of which client built it. There is no DB-level guarantee that a campaign's `list_id` references a list built for the same client.

**WHY IT MATTERS:** A campaign for client A could be pointed at a list built for client B. Contacts in that list would then be assessed for enrollment under client A's campaign. The only application-layer mitigation is Gate 1 (account intelligence, which IS `client_id`-scoped): a contact whose company has no account intelligence record for client A fails Gate 1 and is marked ineligible. This is a soft filter, not a hard DB-level block.

**CURRENT STATE:** Actively open. `LeadSupplyReport.listClientWarning` (Stage 19A) documents this gap in every report where `listId` is non-null. The warning text reads:
> "FINDING 5 (25-SUPABASE-SECURITY.md): lists and list_members have no client_id. There is no DB-level guarantee that this list was built for this client. Cross-client contacts fail at Gate 1 (NO_ACCOUNT_INTELLIGENCE) unless the company appears in both clients' account_intelligence. This warning is documentation of the unresolved isolation gap — not a security fix."

**RECOMMENDED FIX (not yet approved):** Add `client_id uuid NOT NULL FK → clients(id)` to `lists` and `list_members`, and add a composite FK `(client_id, list_id) → lists(client_id, id)` on `campaigns`. This would enforce tenant isolation at the DB level.

**WHAT COULD BREAK:** Any existing rows in `lists` or `list_members` would need backfilling. The `campaigns.list_id` FK would become a composite FK, which requires a migration and coordination with any application code that sets `list_id`.

> **STATUS: UNRESOLVED.** Do not apply any fix without explicit user approval and a new migration. FINDING 5 must remain explicitly open until resolved.

---

### FINDING 3: Tenant isolation is code-level, not database-level

**PROBLEM:** All client data (Gramscode, future clients) lives in the same tables. Isolation is enforced by including `client_id` in every query's WHERE clause. There are no database-level policies preventing one client's data from appearing in another client's query if a `client_id` filter is accidentally omitted.

**WHY IT MATTERS:** A missing `.eq("client_id", clientId)` in application code would return all clients' data mixed together.

**CURRENT STATE:** Code review of `src/db/*.ts` shows all queries correctly include `client_id` filters. The integration test (`scripts/signal-ingestion-integration-test.ts`) explicitly tests tenant isolation for the signals table.

**RECOMMENDED FIX:** For high-value tables (signals, enrichment_runs, contacts), consider adding RLS policies even with service_role so that a developer testing with the anon key can't accidentally read across clients. This is a long-term hardening measure.

**WHAT COULD BREAK:** If the anon key were ever used in testing, restricted policies would cause test failures that are currently not caught.

> **STATUS: Do not apply without explicit confirmation.** Document only.

---

## Data Classification

| Category | Tables | Risk Level |
|----------|--------|------------|
| **Client PII/contact data** | contacts (name, email, LinkedIn), campaign_leads | High — contains email addresses and personal data of prospects |
| **Client business intelligence** | signals, enrichment_runs, campaign_strategies | High — proprietary competitive intelligence |
| **Campaign content** | email_sequences, email_sequence_steps | Medium — email copy and targeting data |
| **Internal operational data** | jobs, enrichment_runs | Low — no PII, operational metadata only |
| **Configuration data** | clients, icp_onboarding, lead_magnets | Medium — client business information |

---

---

### FINDING 6: campaign_leads has RLS enabled but zero policies — UNRESOLVED

**PROBLEM:** Live inspection confirms `campaign_leads` has `rls_enabled = true` but zero policies are defined. PostgreSQL's default-deny applies: any non-service-role query returns zero rows.

**WHY IT MATTERS:** Two risks:
1. **Silent data invisibility:** If any future code path authenticates with a JWT (not service_role), all `campaign_leads` queries return empty silently — no error, just no data. This could mask enrollment data and cause incorrect "no leads enrolled" results.
2. **No tenant filter policy:** Even when policies are added in the future, a cross-client SELECT policy must be carefully written. Without it, a permissive `FOR ALL TO authenticated USING (true)` would expose all clients' enrollment data.

**CURRENT STATE:** Currently harmless — all app queries use service_role which bypasses RLS. But the table is effectively unprotected if the authentication model ever changes.

The RLS status table above showed `campaign_leads` as "Unknown (pre-migration)" — the live inspection confirms it is `rls_enabled = true`, `force_rls = false`, zero policies.

**RECOMMENDED FIX (not yet approved):** Add a `client_id`-scoped SELECT policy consistent with other tables, e.g.:
```sql
CREATE POLICY "clients see own campaign_leads"
  ON public.campaign_leads FOR ALL TO authenticated
  USING (client_id = auth.jwt()->'app_metadata'->>'client_id');
```

**WHAT COULD BREAK:** Nothing currently — no JWT-authenticated queries exist. Adding the policy is safe for the current service_role architecture. Required before any user-facing JWT flow touches campaign_leads.

> **STATUS: UNRESOLVED.** Documentation only. Do not apply any policy without explicit user approval.

---

## What Would Break If Service Role Key Leaked

If `SUPABASE_SERVICE_ROLE_KEY` were exposed:

1. **All client data readable** — no RLS to block it
2. **All signals, contacts, emails readable** — including PII
3. **All data writable/deletable** — adversary could delete entire client dataset
4. **RLS cannot protect against this** — service_role always bypasses RLS

**Mitigation:** Keep the service_role key in `.env` (gitignored), rotate it immediately if exposed, use Supabase Dashboard to regenerate.

---

## What to Do If a Security Issue Is Discovered

1. Document it in this file using the format:
   - **PROBLEM:** What the issue is
   - **WHY IT MATTERS:** What could go wrong
   - **CURRENT STATE:** Whether it's actively exploitable now
   - **RECOMMENDED FIX:** The exact SQL or code change
   - **WHAT COULD BREAK:** Impact of the fix
2. Do NOT apply the fix immediately
3. Stop and ask the operator before making any changes to security policies, RLS, or permissions

---

## Summary: Security Posture

| Area | Status |
|------|--------|
| API key handling | Good — env vars, gitignored |
| No anon key in use | Good — backend-only system |
| RLS enabled | Good — all tables have RLS enabled; FINDING 6: campaign_leads has no policies (latent, not actively exploitable) |
| Tenant isolation | Partial — code-level for most tables; FINDING 5: lists/list_members have no client_id (open isolation gap) |
| Data in transit | Good — Supabase API is HTTPS only |
| Secret logging | Good — no logging of credentials found |
| Cascade deletes | Risk — client deletion cascades to all data; no soft-delete |
