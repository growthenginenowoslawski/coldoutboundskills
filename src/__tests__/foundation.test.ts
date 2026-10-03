import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeDomain, normalizeCompanyName } from "../lib/normalize";
import { dedupeCompanies, dedupKey } from "../lib/dedup";
import { LeadSourceWaterfall } from "../providers/registry";
import type { LeadSourceProvider } from "../providers/types";
import type { CompanyRecord, SearchQuery } from "../domain/types";

const co = (name: string, domain?: string): CompanyRecord => ({
  name,
  domain,
  source: "test",
  fetchedAt: new Date().toISOString(),
});

test("normalizeDomain strips scheme, www, path and query", () => {
  assert.equal(normalizeDomain("https://WWW.Acme.com/pricing?x=1"), "acme.com");
  assert.equal(normalizeDomain("Acme.com"), "acme.com");
  assert.equal(normalizeDomain(""), undefined);
  assert.equal(normalizeDomain(undefined), undefined);
});

test("normalizeCompanyName drops punctuation and legal suffixes", () => {
  assert.equal(normalizeCompanyName("Acme, Inc."), "acme");
  assert.equal(normalizeCompanyName("ACME Incorporated"), "acme incorporated"); // only known suffixes dropped
  assert.equal(normalizeCompanyName("Foo & Bar LLC"), "foo and bar");
  assert.equal(normalizeCompanyName("Café Ltd"), "cafe");
});

test("dedupKey prefers domain over name", () => {
  assert.equal(dedupKey(co("Acme Inc", "acme.com")), "domain:acme.com");
  assert.equal(dedupKey(co("Acme Inc")), "name:acme");
});

test("dedupeCompanies collapses by domain and name, keeps first", () => {
  const { unique, duplicates } = dedupeCompanies([
    co("Acme Inc", "acme.com"),
    co("ACME", "https://www.acme.com"), // dup by domain
    co("Beta LLC"),
    co("Beta"), // dup by normalized name
    co("Gamma", "gamma.io"),
  ]);
  assert.equal(unique.length, 3);
  assert.equal(duplicates, 2);
  assert.equal(unique[0].name, "Acme Inc"); // first-seen wins
});

// --- Waterfall -------------------------------------------------------------

class FakeProvider implements LeadSourceProvider {
  readonly capability = "lead-source" as const;
  constructor(
    readonly id: string,
    private readonly rows: CompanyRecord[],
    private readonly configured = true,
  ) {}
  isConfigured() {
    return this.configured;
  }
  async searchCompanies(query: SearchQuery) {
    return this.rows.slice(0, query.limit);
  }
}

class ThrowingProvider implements LeadSourceProvider {
  readonly capability = "lead-source" as const;
  readonly id = "boom";
  isConfigured() {
    return true;
  }
  async searchCompanies(): Promise<CompanyRecord[]> {
    throw new Error("provider exploded");
  }
}

test("waterfall skips unconfigured providers", async () => {
  const wf = new LeadSourceWaterfall([
    new FakeProvider("off", [co("X", "x.com")], false),
    new FakeProvider("on", [co("Y", "y.com")]),
  ]);
  const { companies, steps } = await wf.run({ limit: 10 });
  assert.deepEqual(steps.map((s) => s.provider), ["on"]);
  assert.equal(companies.length, 1);
});

test("waterfall dedups across providers", async () => {
  const wf = new LeadSourceWaterfall([
    new FakeProvider("a", [co("Acme", "acme.com"), co("Beta", "beta.com")]),
    new FakeProvider("b", [co("ACME", "www.acme.com"), co("Gamma", "gamma.com")]),
  ]);
  const { companies, steps } = await wf.run({ limit: 10 });
  assert.equal(companies.length, 3); // acme, beta, gamma (acme dup dropped)
  assert.equal(steps[0].added, 2);
  assert.equal(steps[1].added, 1); // only gamma is new; ACME is a dup
});

test("waterfall respects limit and only requests what's remaining", async () => {
  const seenLimits: number[] = [];
  class RecordingProvider extends FakeProvider {
    async searchCompanies(query: SearchQuery) {
      seenLimits.push(query.limit);
      return super.searchCompanies(query);
    }
  }
  const wf = new LeadSourceWaterfall([
    new RecordingProvider("a", [co("A", "a.com"), co("B", "b.com")]),
    new RecordingProvider("b", [co("C", "c.com"), co("D", "d.com")]),
  ]);
  const { companies } = await wf.run({ limit: 3 });
  assert.equal(companies.length, 3); // capped at limit
  assert.deepEqual(seenLimits, [3, 1]); // 2nd provider asked for only the remaining 1
});

test("waterfall isolates a failing provider and continues", async () => {
  const wf = new LeadSourceWaterfall([
    new ThrowingProvider(),
    new FakeProvider("ok", [co("Z", "z.com")]),
  ]);
  const { companies, steps } = await wf.run({ limit: 5 });
  assert.equal(steps[0].error, "provider exploded");
  assert.equal(steps[0].added, 0);
  assert.equal(companies.length, 1);
  assert.equal(companies[0].domain, "z.com");
});
