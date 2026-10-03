import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSearchStrings,
  normalizePlace,
  GOOGLE_MAPS_ACTOR,
  type GoogleMapsPlace,
} from "../providers/apify/google-maps";
import type { SearchQuery } from "../domain/types";

test("buildSearchStrings combines industry + keywords with location", () => {
  const q: SearchQuery = {
    industry: "dentists",
    keywords: ["cosmetic"],
    location: "Austin, TX",
    limit: 10,
  };
  assert.deepEqual(buildSearchStrings(q), [
    "dentists in Austin, TX",
    "cosmetic in Austin, TX",
  ]);
});

test("buildSearchStrings falls back to a generic term when none given", () => {
  assert.deepEqual(buildSearchStrings({ location: "Denver", limit: 5 }), ["business in Denver"]);
  assert.deepEqual(buildSearchStrings({ limit: 5 }), ["business"]);
});

test("normalizePlace maps a Google Maps item into a CompanyRecord", () => {
  const place: GoogleMapsPlace = {
    title: "Acme Dental",
    website: "https://www.acmedental.com/home",
    categoryName: "Dentist",
    city: "Austin",
    state: "Texas",
    countryCode: "US",
    placeId: "abc123",
  };
  const rec = normalizePlace(place, { industry: "dentists", limit: 10 });
  assert.equal(rec.name, "Acme Dental");
  assert.equal(rec.domain, "acmedental.com"); // normalized from website
  assert.equal(rec.industry, "Dentist"); // actor category wins over query
  assert.equal(rec.location, "Austin, Texas, US");
  assert.equal(rec.source, `apify:${GOOGLE_MAPS_ACTOR}`);
  assert.equal(rec.sourceRecordId, "abc123");
  assert.ok(rec.fetchedAt);
});

test("normalizePlace tolerates a place with no website/title", () => {
  const rec = normalizePlace({ address: "1 Main St" }, { industry: "cafes", limit: 5 });
  assert.equal(rec.name, "(unknown)");
  assert.equal(rec.domain, undefined);
  assert.equal(rec.industry, "cafes"); // falls back to query
  assert.equal(rec.location, "1 Main St");
});
