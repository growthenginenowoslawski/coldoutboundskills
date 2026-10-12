import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildQualificationPrompt,
  QUALIFICATION_SCHEMA,
} from "../providers/ai/qualification-prompt";
import type { QualificationInput } from "../domain/types";

const input: QualificationInput = {
  company: {
    name: "Godsent Coffee",
    domain: "godsentcoffee.com",
    industry: "Coffee shop",
    city: "Austin",
    region: "Texas",
    country: "US",
    source: "supabase",
    fetchedAt: new Date().toISOString(),
  },
  icp: { industry: "specialty coffee shop", location: "Austin, TX", keywords: ["coffee"] },
};

test("buildQualificationPrompt includes known company fields and ICP", () => {
  const p = buildQualificationPrompt(input);
  assert.match(p, /Godsent Coffee/);
  assert.match(p, /godsentcoffee\.com/);
  assert.match(p, /Austin/);
  assert.match(p, /ICP DEFINITION/);
  assert.match(p, /specialty coffee shop/);
});

test("buildQualificationPrompt omits missing fields (no employeeCount line)", () => {
  const p = buildQualificationPrompt(input);
  assert.doesNotMatch(p, /employeeCount/);
});

test("qualification schema is strict and lists all required fields", () => {
  assert.equal(QUALIFICATION_SCHEMA.additionalProperties, false);
  for (const key of [
    "icpFit",
    "score",
    "industryMatch",
    "sizeMatch",
    "locationMatch",
    "reason",
    "signals",
    "confidence",
  ]) {
    assert.ok(key in QUALIFICATION_SCHEMA.properties, `missing property ${key}`);
    assert.ok(
      (QUALIFICATION_SCHEMA.required as readonly string[]).includes(key),
      `missing required ${key}`,
    );
  }
});
