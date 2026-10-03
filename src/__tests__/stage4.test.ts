import { test } from "node:test";
import assert from "node:assert/strict";

import { chunk } from "../lib/chunk";
import { toCompanyRow } from "../db/companies";
import type { CompanyRecord } from "../domain/types";

test("chunk splits into batches of at most size", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2, 3], 25), [[1, 2, 3]]);
  assert.deepEqual(chunk([], 3), []);
  assert.throws(() => chunk([1], 0));
});

test("toCompanyRow maps CompanyRecord to the live companies columns", () => {
  const rec: CompanyRecord = {
    name: "Godsent Coffee",
    domain: "godsentcoffee.com",
    website: "https://godsentcoffee.com",
    industry: "Coffee shop",
    city: "Austin",
    region: "Texas",
    country: "US",
    source: "apify:compass/crawler-google-places",
    fetchedAt: new Date().toISOString(),
  };
  const row = toCompanyRow(rec);
  assert.equal(row.name, "Godsent Coffee");
  assert.equal(row.domain, "godsentcoffee.com");
  assert.equal(row.website_url, "https://godsentcoffee.com");
  assert.equal(row.industry, "Coffee shop");
  assert.equal(row.city, "Austin");
  assert.equal(row.region, "Texas");
  assert.equal(row.country, "US");
  assert.equal(row.status, "review"); // default: new leads await review
  assert.equal(row.company_size, null);
  assert.equal(row.source, "apify:compass/crawler-google-places");
});

test("toCompanyRow nulls missing optionals and stringifies employeeCount", () => {
  const rec: CompanyRecord = {
    name: "No Site Cafe",
    employeeCount: 12,
    source: "apify:x",
    fetchedAt: new Date().toISOString(),
  };
  const row = toCompanyRow(rec, "approved");
  assert.equal(row.domain, null);
  assert.equal(row.website_url, null);
  assert.equal(row.city, null);
  assert.equal(row.company_size, "12");
  assert.equal(row.status, "approved");
});
