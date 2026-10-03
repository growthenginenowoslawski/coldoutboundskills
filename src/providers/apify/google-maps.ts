/**
 * First LeadSourceProvider: Apify Google Maps scraper (compass/crawler-google-places).
 * Good for local/SMB discovery by industry + location. Swap the Actor by
 * implementing another LeadSourceProvider — nothing else changes.
 *
 * The mapping helpers (buildSearchStrings / normalizePlace) are PURE so they can
 * be tested offline without spending Apify credits.
 */
import type { CompanyRecord, SearchQuery } from "../../domain/types";
import type { LeadSourceProvider } from "../types";
import { normalizeDomain } from "../../lib/normalize";
import { getDatasetItems, isApifyConfigured, runActor } from "./client";

export const GOOGLE_MAPS_ACTOR = "compass/crawler-google-places";

/** Subset of the Actor's output item we actually use. */
export interface GoogleMapsPlace {
  title?: string;
  website?: string;
  phone?: string;
  address?: string;
  city?: string;
  state?: string;
  countryCode?: string;
  categoryName?: string;
  placeId?: string;
  url?: string;
}

/** "<industry/keyword> in <location>" — one search string per term. */
export function buildSearchStrings(query: SearchQuery): string[] {
  const terms = [query.industry, ...(query.keywords ?? [])].filter(
    (t): t is string => Boolean(t && t.trim()),
  );
  const base = terms.length ? terms : ["business"];
  return base.map((t) => (query.location ? `${t} in ${query.location}` : t));
}

/** Map one Google Maps place into our provider-agnostic CompanyRecord. */
export function normalizePlace(item: GoogleMapsPlace, query: SearchQuery): CompanyRecord {
  const location =
    [item.city, item.state, item.countryCode].filter(Boolean).join(", ") ||
    item.address ||
    query.location;
  return {
    name: item.title?.trim() || "(unknown)",
    domain: normalizeDomain(item.website),
    website: item.website,
    industry: item.categoryName ?? query.industry,
    location,
    city: item.city,
    region: item.state,
    country: item.countryCode,
    source: `apify:${GOOGLE_MAPS_ACTOR}`,
    sourceRecordId: item.placeId,
    raw: item,
    fetchedAt: new Date().toISOString(),
  };
}

export class ApifyGoogleMapsProvider implements LeadSourceProvider {
  readonly id = "apify-google-maps";
  readonly capability = "lead-source" as const;

  isConfigured(): boolean {
    return isApifyConfigured();
  }

  async searchCompanies(query: SearchQuery): Promise<CompanyRecord[]> {
    const input = {
      searchStringsArray: buildSearchStrings(query),
      locationQuery: query.location,
      maxCrawledPlacesPerSearch: query.limit,
      language: "en",
      // Cost control: we only need business identity, not reviews/images.
      maxReviews: 0,
      maxImages: 0,
      skipClosedPlaces: true,
      scrapeContacts: false,
    };
    const run = await runActor(GOOGLE_MAPS_ACTOR, input);
    const items = await getDatasetItems<GoogleMapsPlace>(run.defaultDatasetId, query.limit);
    return items.map((item) => normalizePlace(item, query));
  }
}
