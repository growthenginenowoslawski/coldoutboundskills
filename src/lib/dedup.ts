/**
 * Deduplication strategy for companies.
 * Identity is DOMAIN first (strongest signal), normalized NAME as fallback.
 * This runs BEFORE enrichment so we never pay to enrich the same company twice.
 */
import type { CompanyRecord } from "../domain/types";
import { normalizeCompanyName, normalizeDomain } from "./normalize";

/** Stable key used to detect duplicates across providers and runs. */
export function dedupKey(company: Pick<CompanyRecord, "name" | "domain" | "website">): string {
  const domain = normalizeDomain(company.domain ?? company.website);
  if (domain) return `domain:${domain}`;
  return `name:${normalizeCompanyName(company.name)}`;
}

export interface DedupResult {
  unique: CompanyRecord[];
  duplicates: number;
}

/**
 * Collapse duplicates, keeping the FIRST occurrence (providers earlier in the
 * waterfall win). Order of `unique` follows first-seen order.
 */
export function dedupeCompanies(companies: CompanyRecord[]): DedupResult {
  const seen = new Map<string, CompanyRecord>();
  let duplicates = 0;
  for (const c of companies) {
    const key = dedupKey(c);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.set(key, c);
  }
  return { unique: [...seen.values()], duplicates };
}
