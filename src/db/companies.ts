/**
 * Storage helpers for the existing `companies`, `lists`, and `list_members`
 * tables. App-level idempotency (find-then-insert by domain, else name+city)
 * because there's no unique constraint to rely on — and we must not change the
 * schema. Aligned to the LIVE columns inspected via PostgREST.
 */
import type { CompanyRecord } from "../domain/types";
import { normalizeDomain } from "../lib/normalize";
import { getSupabaseAdmin } from "./supabase";

/**
 * Initial status for freshly sourced companies. The companies.status CHECK
 * constraint allows: review, approved, rejected (Master Plan review flow).
 * New leads start in "review" — nothing is auto-approved.
 */
export const DEFAULT_COMPANY_STATUS = "review";

export interface ListRow {
  id: string;
  name: string;
  environment: string;
  status: string;
}

export async function createList(input: {
  name: string;
  environment: string;
  status?: string;
  description?: string;
}): Promise<ListRow> {
  const { data, error } = await getSupabaseAdmin()
    .from("lists")
    .insert({
      name: input.name,
      environment: input.environment,
      status: input.status ?? "active",
      description: input.description ?? null,
    })
    .select("id,name,environment,status")
    .single();
  if (error) throw new Error(`createList failed: ${error.message}`);
  return data as ListRow;
}

/** Pure mapping: provider-agnostic CompanyRecord -> a `companies` table row. */
export function toCompanyRow(rec: CompanyRecord, status: string = DEFAULT_COMPANY_STATUS) {
  return {
    name: rec.name,
    domain: rec.domain ?? null,
    website_url: rec.website ?? null,
    industry: rec.industry ?? null,
    company_size: rec.employeeCount != null ? String(rec.employeeCount) : null,
    country: rec.country ?? null,
    city: rec.city ?? null,
    region: rec.region ?? null,
    status,
    source: rec.source ?? null,
  };
}

/** Returns the id of an existing company matching this record, or null. */
export async function findExistingCompanyId(rec: CompanyRecord): Promise<string | null> {
  const db = getSupabaseAdmin();
  const domain = normalizeDomain(rec.domain ?? rec.website);
  if (domain) {
    const { data, error } = await db
      .from("companies")
      .select("id")
      .eq("domain", domain)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`findExistingCompanyId(domain) failed: ${error.message}`);
    return (data as { id: string } | null)?.id ?? null;
  }
  // No domain — fall back to name (+ city when available) to reduce collisions.
  let q = db.from("companies").select("id").eq("name", rec.name);
  q = rec.city ? q.eq("city", rec.city) : q;
  const { data, error } = await q.limit(1).maybeSingle();
  if (error) throw new Error(`findExistingCompanyId(name) failed: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

export interface StoredCompany {
  id: string;
  name: string;
  domain: string | null;
}

export interface StoreResult {
  inserted: StoredCompany[];
  existing: StoredCompany[];
}

/**
 * Insert new companies (or reuse existing) and link each to `listId`.
 * Assumes a fresh list per run, so list_members are not deduped.
 */
export async function storeCompaniesInList(
  listId: string,
  companies: CompanyRecord[],
  status: string = DEFAULT_COMPANY_STATUS,
): Promise<StoreResult> {
  const db = getSupabaseAdmin();
  const inserted: StoredCompany[] = [];
  const existing: StoredCompany[] = [];

  for (const rec of companies) {
    let companyId = await findExistingCompanyId(rec);
    if (companyId) {
      existing.push({ id: companyId, name: rec.name, domain: rec.domain ?? null });
    } else {
      const { data, error } = await db
        .from("companies")
        .insert(toCompanyRow(rec, status))
        .select("id,name,domain")
        .single();
      if (error) throw new Error(`insert company "${rec.name}" failed: ${error.message}`);
      const row = data as StoredCompany;
      companyId = row.id;
      inserted.push(row);
    }

    const { error: lmErr } = await db
      .from("list_members")
      .insert({ list_id: listId, company_id: companyId });
    if (lmErr) throw new Error(`list_members insert failed: ${lmErr.message}`);
  }

  return { inserted, existing };
}

/**
 * Fetch the icp_score for a company.
 * Returns 0 when the company has not been qualified yet (null column value),
 * matching the scoring engine's treatment of an unset ICP score.
 *
 * icp_score is global — shared across all clients targeting the same company.
 * See the TEMPORARY COMPROMISE note in src/lib/opportunity-scoring.ts and
 * the account_intelligence migration (0012_account_intelligence.sql).
 */
export async function getCompanyIcpScore(companyId: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("companies")
    .select("icp_score")
    .eq("id", companyId)
    .single();
  if (error) throw new Error(`getCompanyIcpScore failed: ${error.message}`);
  return (data as { icp_score: number | null }).icp_score ?? 0;
}

/** Minimal company shape needed for provider payload construction. */
export interface CompanyNameRow {
  id:   string;
  name: string;
}

/**
 * Batch-fetch company names by a set of IDs.
 * Returns a Map<companyId, CompanyNameRow>.
 * IDs with no matching row are absent from the map.
 *
 * Used by Stage 20 lead upload to populate company_name in provider payloads.
 */
export async function getCompaniesByIds(
  companyIds: string[],
): Promise<Map<string, CompanyNameRow>> {
  if (companyIds.length === 0) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from("companies")
    .select("id, name")
    .in("id", companyIds);

  if (error) throw new Error(`getCompaniesByIds failed: ${error.message}`);

  const result = new Map<string, CompanyNameRow>();
  for (const row of (data as CompanyNameRow[] ?? [])) {
    result.set(row.id, row);
  }
  return result;
}
