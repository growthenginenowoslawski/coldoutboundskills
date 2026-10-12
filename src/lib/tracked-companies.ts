/**
 * Tracked-company resolver for the scheduled signal refresh — Stage 13.
 *
 * "Tracked companies" for a client = companies that already have an
 * account_intelligence row for that client. These are the companies the
 * daily refresh cycle must keep current.
 *
 * ── Why account_intelligence, not lists ──────────────────────────────────────
 *
 * The lists table does not have a client_id column. The relationship between
 * clients and lists is indirect (via list_quality_scores). Using
 * account_intelligence as the source of truth is correct because:
 *   1. Every company that has been through signal ingestion has an
 *      account_intelligence row (upsertAccountIntelligence is called by
 *      rescoreCompany on every ingest and expiry event).
 *   2. account_intelligence is the authoritative "what we're scoring" ledger.
 *   3. No new schema is required — it uses existing tables.
 *
 * ── Initial onboarding ───────────────────────────────────────────────────────
 *
 * A brand-new company (never ingested) is NOT in account_intelligence, so
 * getTrackedCompanyDomains would miss it. Initial onboarding is handled by
 * calling the ingestion coordinator directly with companyIds and since=null.
 * After the first successful rescore, the company appears in account_intelligence
 * and the daily refresh picks it up automatically.
 *
 * ── Domain filter ─────────────────────────────────────────────────────────────
 *
 * PredictLeads identifies companies by domain. Companies with no domain in the
 * companies table are excluded from the returned Map — they cannot be queried.
 * They still appear in account_intelligence (their scores are valid from prior
 * runs), but they will not be refreshed until a domain is added.
 */

import { getSupabaseAdmin } from "../db/supabase";

/**
 * Returns a Map<companyId, domain> for all companies being tracked by a client.
 *
 * Query 1: DISTINCT company_id from account_intelligence WHERE client_id = clientId
 * Query 2: id + domain from companies WHERE id IN (companyIds) AND domain IS NOT NULL
 *
 * Returns an empty Map when the client has no tracked companies.
 * Always scopes to clientId — no cross-client data access.
 */
export async function getTrackedCompanyDomains(
  clientId: string,
): Promise<Map<string, string>> {
  const db = getSupabaseAdmin();

  const { data: aiData, error: aiErr } = await db
    .from("account_intelligence")
    .select("company_id")
    .eq("client_id", clientId);

  if (aiErr) throw new Error(`getTrackedCompanyDomains(ai) failed: ${aiErr.message}`);

  const rawIds = (aiData as { company_id: string }[] ?? []).map((r) => r.company_id);
  const companyIds = [...new Set(rawIds)];
  if (companyIds.length === 0) return new Map();

  const { data: companyData, error: companyErr } = await db
    .from("companies")
    .select("id, domain")
    .in("id", companyIds);

  if (companyErr) throw new Error(`getTrackedCompanyDomains(companies) failed: ${companyErr.message}`);

  const result = new Map<string, string>();
  for (const c of (companyData as { id: string; domain: string | null }[] ?? [])) {
    if (c.domain) result.set(c.id, c.domain);
  }
  return result;
}
