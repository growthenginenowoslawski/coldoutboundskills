/**
 * Stage 29 — Account Qualification tests.
 *
 * Tests the pure computation layer in src/lib/account-qualification.ts.
 * No DB, no AI, no network. All inputs are synthetic fixtures.
 *
 * Coverage:
 *   1. ICP parser unit tests (geography, industry, headcount, disqualifiers)
 *   2. Dimension check unit tests (geography, industry, size, hiring)
 *   3. Score computation unit tests
 *   4. Full computeAccountQualification() integration scenarios
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkDisqualifiers,
  checkGeography,
  checkHiringEvidence,
  checkCompanySize,
  checkIndustry,
  computeAccountQualification,
  computeQualificationScore,
  extractTargetCountries,
  extractTechHiringEvidence,
  parseDisqualifiers,
  parseHeadcountRange,
  parseIndustryRules,
} from "../lib/account-qualification";

import type {
  AccountQualificationInput,
  QualificationSignal,
} from "../domain/account-qualification-types";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-09-10T12:00:00.000Z");
const CAMPAIGN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CLIENT_ID   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const COMPANY_ID  = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const UK_ICP_GEO  = "United Kingdom. London is primary market (approx 40% of first test pool). Bristol, Manchester, Leeds also represented.";
const AGENCY_INDUSTRIES = "IN: Creative agencies, Advertising agencies, Marketing agencies, Design agencies, Digital agencies, Branding agencies. OUT: Holding company subsidiaries, private equity roll-ups.";
const HEADCOUNT_ANSWER  = "3–200 employees as a targeting hypothesis; do not discard companies when headcount is unknown.";
const DISQUALIFIERS_ANS = "Holding company subsidiaries or network agency divisions; private equity-owned agencies with corporate procurement; B2C-only agencies with no B2B client base; solo practitioners and freelancers";

function makeCampaign(overrides: Partial<AccountQualificationInput["campaign"]> = {}): AccountQualificationInput["campaign"] {
  return { campaignStrategyId: CAMPAIGN_ID, listFilters: null, ...overrides };
}

function makeCompany(overrides: Partial<AccountQualificationInput["company"]> = {}): AccountQualificationInput["company"] {
  return {
    id: COMPANY_ID, name: "Test Company Ltd", domain: "testcompany.co.uk",
    industry: "Advertising & Marketing", country: "United Kingdom",
    city: "London", companySize: "11-50", description: null,
    ...overrides,
  };
}

function makeIcp(overrides: Partial<AccountQualificationInput["icp"]> = {}): AccountQualificationInput["icp"] {
  return {
    geographyAnswer:     UK_ICP_GEO,
    industriesAnswer:    AGENCY_INDUSTRIES,
    disqualifiersAnswer: DISQUALIFIERS_ANS,
    headcountAnswer:     HEADCOUNT_ANSWER,
    triggersAnswer:      null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<AccountQualificationInput> = {}): AccountQualificationInput {
  return {
    clientId:         CLIENT_ID,
    company:          makeCompany(),
    icp:              makeIcp(),
    campaign:         makeCampaign(),
    signals:          [],
    opportunityScore: null,
    ...overrides,
  };
}

function makeJobPosting(title: string): QualificationSignal {
  return {
    signalType: "job_posting", title, description: null,
    evidence: {}, occurredAt: "2026-09-01T00:00:00Z", status: "active",
  };
}

function makeFundingSignal(): QualificationSignal {
  return {
    signalType: "funding_round", title: "Series A funding round",
    description: "£2M Series A", evidence: {},
    occurredAt: "2026-09-01T00:00:00Z", status: "active",
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. ICP PARSER UNIT TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe("extractTargetCountries", () => {
  it("extracts United Kingdom from the ICP geography answer", () => {
    const result = extractTargetCountries(UK_ICP_GEO);
    assert.ok(result.includes("United Kingdom"), `Expected 'United Kingdom' in ${JSON.stringify(result)}`);
  });

  it("returns [] for null input", () => {
    assert.deepEqual(extractTargetCountries(null), []);
  });

  it("returns [] when no known country is mentioned", () => {
    assert.deepEqual(extractTargetCountries("Focus on major metropolitan areas with high agency density."), []);
  });

  it("extracts 'United States' from US-focused geography", () => {
    const result = extractTargetCountries("United States, primarily NYC, San Francisco, and Chicago.");
    assert.ok(result.includes("United States"));
  });

  it("matches 'UK' abbreviation", () => {
    const result = extractTargetCountries("Focus: UK agencies only.");
    assert.ok(result.includes("United Kingdom"));
  });

  it("handles multiple countries in one answer", () => {
    const result = extractTargetCountries("United Kingdom and Ireland.");
    assert.ok(result.includes("United Kingdom"));
    assert.ok(result.includes("Ireland"));
  });
});

describe("parseIndustryRules", () => {
  it("parses IN and OUT sections correctly", () => {
    const result = parseIndustryRules(AGENCY_INDUSTRIES);
    assert.ok(result.include.some((s) => s.includes("advertising")));
    assert.ok(result.include.some((s) => s.includes("marketing")));
    assert.ok(result.exclude.some((s) => s.includes("holding company")));
  });

  it("returns empty arrays for null input", () => {
    assert.deepEqual(parseIndustryRules(null), { include: [], exclude: [] });
  });

  it("strips parenthetical notes from OUT list", () => {
    const result = parseIndustryRules("IN: Software. OUT: Holding company subsidiaries (WPP, Publicis etc.).");
    const hasParens = result.exclude.some((s) => s.includes("("));
    assert.equal(hasParens, false, "Parenthetical notes should be stripped");
  });

  it("parses tech industry rules for recruitment use case", () => {
    const techICP = "IN: Software companies, Technology firms, Financial services, Healthcare technology. OUT: Consumer retail, Government.";
    const result = parseIndustryRules(techICP);
    assert.ok(result.include.some((s) => s.includes("software")));
    assert.ok(result.include.some((s) => s.includes("technology")));
    assert.ok(result.exclude.some((s) => s.includes("consumer retail")));
  });
});

describe("parseHeadcountRange", () => {
  it("parses em-dash range (3–200)", () => {
    const result = parseHeadcountRange(HEADCOUNT_ANSWER);
    assert.deepEqual(result, { min: 3, max: 200 });
  });

  it("parses hyphen range (10-500)", () => {
    assert.deepEqual(parseHeadcountRange("10-500 employees"), { min: 10, max: 500 });
  });

  it("returns null for null input", () => {
    assert.equal(parseHeadcountRange(null), null);
  });

  it("returns null when no numeric range is found", () => {
    assert.equal(parseHeadcountRange("Unknown headcount; do not filter."), null);
  });

  it("parses range from longer descriptive text", () => {
    const result = parseHeadcountRange("We target companies with 50–5000 employees in the technology sector.");
    assert.deepEqual(result, { min: 50, max: 5000 });
  });
});

describe("parseDisqualifiers", () => {
  it("splits on semicolons and lowercases", () => {
    const result = parseDisqualifiers(DISQUALIFIERS_ANS);
    assert.ok(result.length >= 3);
    assert.ok(result.every((s) => s === s.toLowerCase()));
  });

  it("returns [] for null input", () => {
    assert.deepEqual(parseDisqualifiers(null), []);
  });

  it("strips parenthetical notes", () => {
    const result = parseDisqualifiers("Holding company subsidiaries (WPP etc.); Solo freelancers (under 3 people)");
    const hasParens = result.some((s) => s.includes("("));
    assert.equal(hasParens, false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. DIMENSION CHECK UNIT TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe("checkGeography", () => {
  it("PASS for exact 'United Kingdom' match", () => {
    assert.equal(checkGeography("United Kingdom", ["United Kingdom"]), "PASS");
  });

  it("PASS for 'UK' when United Kingdom is a target", () => {
    assert.equal(checkGeography("UK", ["United Kingdom"]), "PASS");
  });

  it("PASS for 'England' when United Kingdom is a target", () => {
    assert.equal(checkGeography("England", ["United Kingdom"]), "PASS");
  });

  it("FAIL for non-target country", () => {
    assert.equal(checkGeography("United States", ["United Kingdom"]), "FAIL");
  });

  it("FAIL for Germany when only UK targeted", () => {
    assert.equal(checkGeography("Germany", ["United Kingdom"]), "FAIL");
  });

  it("UNKNOWN for null country", () => {
    assert.equal(checkGeography(null, ["United Kingdom"]), "UNKNOWN");
  });

  it("UNKNOWN for empty string country", () => {
    assert.equal(checkGeography("", ["United Kingdom"]), "UNKNOWN");
  });

  it("UNKNOWN when no target countries parsed", () => {
    assert.equal(checkGeography("United Kingdom", []), "UNKNOWN");
  });

  it("PASS for case-insensitive match", () => {
    assert.equal(checkGeography("united kingdom", ["United Kingdom"]), "PASS");
  });
});

describe("checkIndustry", () => {
  const rules = parseIndustryRules(AGENCY_INDUSTRIES);

  it("PASS when industry matches include list", () => {
    assert.equal(checkIndustry("Advertising & Marketing", rules), "PASS");
  });

  it("PASS for marketing agency", () => {
    assert.equal(checkIndustry("Marketing and Advertising", rules), "PASS");
  });

  it("PASS for design industry", () => {
    assert.equal(checkIndustry("Graphic Design", rules), "PASS");
  });

  it("FAIL when industry matches exclude list", () => {
    assert.equal(checkIndustry("Holding company for digital agencies", rules), "FAIL");
  });

  it("UNKNOWN for null industry", () => {
    assert.equal(checkIndustry(null, rules), "UNKNOWN");
  });

  it("UNKNOWN when industry doesn't match either list", () => {
    assert.equal(checkIndustry("Construction", rules), "UNKNOWN");
  });

  it("UNKNOWN for empty rules", () => {
    assert.equal(checkIndustry("Advertising", { include: [], exclude: [] }), "UNKNOWN");
  });

  it("FAIL takes precedence over PASS when industry matches both lists", () => {
    const mixedRules = { include: ["advertising"], exclude: ["advertising holding"] };
    assert.equal(checkIndustry("Advertising Holding Company", mixedRules), "FAIL");
  });
});

describe("checkCompanySize", () => {
  const range = parseHeadcountRange(HEADCOUNT_ANSWER)!;

  it("PASS for size within range", () => {
    assert.equal(checkCompanySize("11-50", range), "PASS");
  });

  it("PASS for size at lower bound", () => {
    assert.equal(checkCompanySize("1-3", range), "PASS");
  });

  it("PASS for size at upper bound", () => {
    assert.equal(checkCompanySize("201-500", { min: 100, max: 500 }), "PASS");
  });

  it("FAIL for size clearly above range", () => {
    assert.equal(checkCompanySize("5001-10000", range), "FAIL");
  });

  it("FAIL for size clearly below range", () => {
    assert.equal(checkCompanySize("1001-5000", { min: 1, max: 50 }), "FAIL");
  });

  it("UNKNOWN for null size — never FAIL on missing data", () => {
    assert.equal(checkCompanySize(null, range), "UNKNOWN");
  });

  it("UNKNOWN when ICP range is null", () => {
    assert.equal(checkCompanySize("11-50", null), "UNKNOWN");
  });

  it("UNKNOWN for unparseable size string", () => {
    assert.equal(checkCompanySize("unknown", range), "UNKNOWN");
  });
});

describe("checkHiringEvidence", () => {
  it("PRESENT when active job_posting signals exist", () => {
    const signals = [makeJobPosting("Software Engineer")];
    assert.equal(checkHiringEvidence(signals), "PRESENT");
  });

  it("UNKNOWN for empty signals array — not ABSENT", () => {
    assert.equal(checkHiringEvidence([]), "UNKNOWN");
  });

  it("UNKNOWN when signals exist but none are job_posting", () => {
    const signals = [makeFundingSignal()];
    assert.equal(checkHiringEvidence(signals), "UNKNOWN");
  });

  it("UNKNOWN when all job_posting signals are expired", () => {
    const expiredSig: QualificationSignal = {
      signalType: "job_posting", title: "Old Role", description: null,
      evidence: {}, occurredAt: "2025-01-01T00:00:00Z", status: "expired",
    };
    assert.equal(checkHiringEvidence([expiredSig]), "UNKNOWN");
  });
});

describe("extractTechHiringEvidence", () => {
  it("detects 'software engineer' keyword", () => {
    const signals = [makeJobPosting("Senior Software Engineer — TypeScript")];
    const ev = extractTechHiringEvidence(signals);
    assert.ok(ev.length > 0, "Should detect tech hiring evidence");
    assert.ok(ev[0].includes("Software Engineer") || ev[0].includes("software engineer"));
  });

  it("returns [] when no tech keywords found", () => {
    const signals = [makeJobPosting("Office Manager")];
    assert.deepEqual(extractTechHiringEvidence(signals), []);
  });

  it("returns [] for empty signals", () => {
    assert.deepEqual(extractTechHiringEvidence([]), []);
  });

  it("ignores expired signals", () => {
    const expiredTechSig: QualificationSignal = {
      signalType: "job_posting", title: "Python Developer",
      description: null, evidence: {}, occurredAt: "2025-01-01T00:00:00Z", status: "expired",
    };
    assert.deepEqual(extractTechHiringEvidence([expiredTechSig]), []);
  });
});

describe("checkDisqualifiers", () => {
  const disqs = parseDisqualifiers(DISQUALIFIERS_ANS);

  it("returns exclusion reason when company name matches a disqualifier phrase", () => {
    const result = checkDisqualifiers(
      { name: "A B2C-Only Agencies with no B2B client base Ltd", industry: "Retail", description: null },
      disqs,
    );
    assert.ok(result.length > 0, "Should detect B2C-only disqualifier");
  });

  it("returns [] for a clearly qualifying company", () => {
    const result = checkDisqualifiers(
      { name: "Bright Studio Ltd", industry: "Marketing and Advertising", description: "Full-service creative agency" },
      disqs,
    );
    assert.deepEqual(result, []);
  });

  it("returns [] for empty disqualifiers list", () => {
    assert.deepEqual(
      checkDisqualifiers({ name: "Any Company", industry: null, description: null }, []),
      [],
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. SCORE COMPUTATION UNIT TESTS
// ══════════════════════════════════════════════════════════════════════════════

describe("computeQualificationScore", () => {
  it("returns 0 when hard exclusions exist", () => {
    const score = computeQualificationScore({
      hasExclusions: true, geographyVerdict: "PASS", industryVerdict: "PASS",
      sizeVerdict: "PASS", hiringEvidenceVerdict: "PRESENT", opportunityScore: 80,
    });
    assert.equal(score, 0);
  });

  it("returns 0 when geography is FAIL", () => {
    const score = computeQualificationScore({
      hasExclusions: false, geographyVerdict: "FAIL", industryVerdict: "PASS",
      sizeVerdict: "PASS", hiringEvidenceVerdict: "PRESENT", opportunityScore: 80,
    });
    assert.equal(score, 0);
  });

  it("returns high score for all PASS dimensions", () => {
    const score = computeQualificationScore({
      hasExclusions: false, geographyVerdict: "PASS", industryVerdict: "PASS",
      sizeVerdict: "PASS", hiringEvidenceVerdict: "PRESENT", opportunityScore: 50,
    });
    assert.ok(score >= 80, `Expected score >= 80, got ${score}`);
  });

  it("does not exceed 100", () => {
    const score = computeQualificationScore({
      hasExclusions: false, geographyVerdict: "PASS", industryVerdict: "PASS",
      sizeVerdict: "PASS", hiringEvidenceVerdict: "PRESENT", opportunityScore: 100,
    });
    assert.ok(score <= 100, `Expected score <= 100, got ${score}`);
  });

  it("scores lower when all verdicts are UNKNOWN", () => {
    const score = computeQualificationScore({
      hasExclusions: false, geographyVerdict: "UNKNOWN", industryVerdict: "UNKNOWN",
      sizeVerdict: "UNKNOWN", hiringEvidenceVerdict: "UNKNOWN", opportunityScore: null,
    });
    assert.ok(score < 20, `Expected score < 20 for all-UNKNOWN, got ${score}`);
  });

  it("geography PASS adds more weight than geography UNKNOWN", () => {
    const withPass = computeQualificationScore({
      hasExclusions: false, geographyVerdict: "PASS", industryVerdict: "UNKNOWN",
      sizeVerdict: "UNKNOWN", hiringEvidenceVerdict: "UNKNOWN", opportunityScore: null,
    });
    const withUnknown = computeQualificationScore({
      hasExclusions: false, geographyVerdict: "UNKNOWN", industryVerdict: "UNKNOWN",
      sizeVerdict: "UNKNOWN", hiringEvidenceVerdict: "UNKNOWN", opportunityScore: null,
    });
    assert.ok(withPass > withUnknown, `PASS (${withPass}) should score higher than UNKNOWN (${withUnknown})`);
  });

  it("opportunity score adds bonus points", () => {
    const withBonus = computeQualificationScore({
      hasExclusions: false, geographyVerdict: "PASS", industryVerdict: "UNKNOWN",
      sizeVerdict: "UNKNOWN", hiringEvidenceVerdict: "UNKNOWN", opportunityScore: 100,
    });
    const withoutBonus = computeQualificationScore({
      hasExclusions: false, geographyVerdict: "PASS", industryVerdict: "UNKNOWN",
      sizeVerdict: "UNKNOWN", hiringEvidenceVerdict: "UNKNOWN", opportunityScore: null,
    });
    assert.ok(withBonus > withoutBonus, "Non-null opportunity score should add bonus points");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. FULL computeAccountQualification() SCENARIOS
// ══════════════════════════════════════════════════════════════════════════════

describe("computeAccountQualification — clearly qualified account", () => {
  it("qualifies a UK creative agency with matching industry and signals", () => {
    const result = computeAccountQualification(makeInput({
      company:  makeCompany({ country: "United Kingdom", industry: "Advertising & Marketing", companySize: "11-50" }),
      signals:  [makeJobPosting("New Business Director")],
      opportunityScore: 55,
    }), FIXED_NOW);

    assert.equal(result.qualified, true, "Should be qualified");
    assert.ok(result.qualificationScore >= 50, `Expected score >= 50, got ${result.qualificationScore}`);
    assert.equal(result.exclusionReasons.length, 0, "No exclusions expected");
    assert.equal(result.geographyVerdict, "PASS");
    assert.equal(result.industryVerdict, "PASS");
    assert.equal(result.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
    assert.ok(result.positiveEvidence.some((e) => e.toLowerCase().includes("united kingdom")));
    assert.ok(result.positiveEvidence.some((e) => e.toLowerCase().includes("advertis")));
  });
});

describe("computeAccountQualification — non-UK company (hard exclusion)", () => {
  it("excludes a US company via geography FAIL", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "United States", industry: "Advertising & Marketing" }),
    }), FIXED_NOW);

    assert.equal(result.qualified, false);
    assert.equal(result.qualificationScore, 0);
    assert.equal(result.geographyVerdict, "FAIL");
    assert.ok(result.exclusionReasons.length > 0, "Geography FAIL should add exclusion reason");
    assert.ok(result.exclusionReasons[0].toLowerCase().includes("geography"));
  });
});

describe("computeAccountQualification — industry in OUT list (hard exclusion)", () => {
  it("excludes a holding company via industry FAIL", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ industry: "Holding company group of digital agencies" }),
    }), FIXED_NOW);

    assert.equal(result.qualified, false);
    assert.equal(result.qualificationScore, 0);
    assert.ok(result.exclusionReasons.length > 0);
    assert.ok(result.exclusionReasons.some((r) => r.toLowerCase().includes("industry")));
  });
});

describe("computeAccountQualification — missing country (UNKNOWN, not excluded)", () => {
  it("does not exclude a company with null country", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: null, industry: "Advertising & Marketing" }),
    }), FIXED_NOW);

    assert.equal(result.geographyVerdict, "UNKNOWN", "Missing country must be UNKNOWN not FAIL");
    assert.equal(result.exclusionReasons.length, 0, "Missing country must not be an exclusion");
    assert.ok(result.missingInfo.some((m) => m.toLowerCase().includes("country")));
  });
});

describe("computeAccountQualification — UK company, no signals (still qualifies)", () => {
  it("qualifies a UK agency with good industry match even with no signals", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "United Kingdom", industry: "Marketing and Advertising", companySize: "11-50" }),
      signals: [],
    }), FIXED_NOW);

    assert.equal(result.qualified, true, "UK agency with matching industry should be qualified even without signals");
    assert.equal(result.hiringEvidenceVerdict, "UNKNOWN");
    assert.ok(result.missingInfo.some((m) => m.toLowerCase().includes("signal")));
  });
});

describe("computeAccountQualification — technology hiring evidence detected", () => {
  it("detects tech hiring signals for recruitment use case", () => {
    const result = computeAccountQualification(makeInput({
      company:  makeCompany({ industry: "Computer Software", country: "United Kingdom" }),
      icp:      makeIcp({
        industriesAnswer: "IN: Software companies, Technology firms, SaaS. OUT: Consumer retail.",
        geographyAnswer:  UK_ICP_GEO,
      }),
      signals:  [makeJobPosting("Senior TypeScript Engineer"), makeJobPosting("DevOps Lead")],
    }), FIXED_NOW);

    assert.equal(result.hiringEvidenceVerdict, "PRESENT");
    assert.ok(result.positiveEvidence.some((e) => e.toLowerCase().includes("typescript") || e.toLowerCase().includes("tech")));
  });
});

describe("computeAccountQualification — non-tech company with hiring signals", () => {
  it("detects hiring signals even for a non-tech company by industry", () => {
    const result = computeAccountQualification(makeInput({
      company:  makeCompany({ industry: "Healthcare", country: "United Kingdom" }),
      icp:      makeIcp({
        industriesAnswer: "IN: Healthcare, Financial Services, Technology. OUT: Retail.",
        geographyAnswer:  UK_ICP_GEO,
      }),
      signals:  [makeJobPosting("Software Engineer — Patient Data Platform")],
    }), FIXED_NOW);

    assert.equal(result.hiringEvidenceVerdict, "PRESENT");
    assert.ok(result.positiveEvidence.some((e) => e.toLowerCase().includes("software")));
  });
});

describe("computeAccountQualification — missing company size (UNKNOWN, not FAIL)", () => {
  it("does not fail qualification on missing company size", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ companySize: null }),
    }), FIXED_NOW);

    assert.equal(result.sizeVerdict, "UNKNOWN", "Null company size must be UNKNOWN not FAIL");
    assert.equal(result.exclusionReasons.length, 0, "Null size must not be an exclusion");
    assert.ok(result.missingInfo.some((m) => m.toLowerCase().includes("size")));
  });
});

describe("computeAccountQualification — company size out of range (warning not exclusion)", () => {
  it("adds a warning for out-of-range size but does not hard-exclude", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ companySize: "5001-10000" }),
    }), FIXED_NOW);

    assert.equal(result.sizeVerdict, "FAIL");
    assert.equal(result.exclusionReasons.length, 0, "Out-of-range size must not be a hard exclusion");
    assert.ok(result.warnings.some((w) => w.toLowerCase().includes("size")), "Should warn about size");
    assert.ok(result.negativeEvidence.some((e) => e.toLowerCase().includes("size")));
  });
});

describe("computeAccountQualification — all UNKNOWN data produces low score", () => {
  it("does not qualify a company with no data at all", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: null, industry: null, companySize: null, description: null }),
      signals: [],
      opportunityScore: null,
    }), FIXED_NOW);

    assert.ok(result.qualificationScore < 20, `Expected score < 20 for all-null company, got ${result.qualificationScore}`);
    assert.equal(result.qualified, false, "Company with no data should not be qualified");
    assert.equal(result.exclusionReasons.length, 0, "Missing data must not produce exclusions");
  });
});

describe("computeAccountQualification — idempotency", () => {
  it("produces identical results when called twice with identical inputs", () => {
    const input = makeInput({ company: makeCompany(), signals: [makeJobPosting("Account Manager")] });
    const r1    = computeAccountQualification(input, FIXED_NOW);
    const r2    = computeAccountQualification(input, FIXED_NOW);

    assert.equal(r1.qualified,          r2.qualified);
    assert.equal(r1.qualificationScore, r2.qualificationScore);
    assert.equal(r1.geographyVerdict,   r2.geographyVerdict);
    assert.equal(r1.industryVerdict,    r2.industryVerdict);
    assert.equal(r1.sizeVerdict,        r2.sizeVerdict);
    assert.equal(r1.hiringEvidenceVerdict, r2.hiringEvidenceVerdict);
    assert.deepEqual(r1.exclusionReasons, r2.exclusionReasons);
  });
});

describe("computeAccountQualification — score and qualification are distinct", () => {
  it("can produce qualified=true with a moderate score (sparse but valid data)", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({
        country: "United Kingdom", industry: "Advertising & Marketing",
        companySize: null, description: null,
      }),
      signals: [],
      opportunityScore: null,
    }), FIXED_NOW);

    // UK + matching industry = 35+25=60 → qualified, but no signals or size = moderate score
    assert.equal(result.qualified, true, "UK + matching industry should be qualified");
    assert.ok(result.qualificationScore >= 20 && result.qualificationScore <= 70,
      `Expected moderate score, got ${result.qualificationScore}`);
  });

  it("qualified=false when score is below threshold despite no hard exclusions", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: null, industry: null, companySize: null }),
      signals: [],
      opportunityScore: null,
    }), FIXED_NOW);

    assert.equal(result.qualified, false);
    assert.equal(result.exclusionReasons.length, 0, "Score-based non-qualification should not add exclusionReasons");
    assert.ok(result.warnings.some((w) => w.includes("threshold")), "Should warn about threshold");
  });
});

describe("computeAccountQualification — no invented facts", () => {
  it("does not add positive evidence for fields that are null", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ industry: null, companySize: null, description: null }),
      signals: [],
      opportunityScore: null,
    }), FIXED_NOW);

    const hasIndustryEvidence  = result.positiveEvidence.some((e) => e.toLowerCase().includes("industry"));
    const hasOpportunityEvidence = result.positiveEvidence.some((e) => e.toLowerCase().includes("opportunity score"));
    assert.equal(hasIndustryEvidence, false, "No positive industry evidence for null industry");
    assert.equal(hasOpportunityEvidence, false, "No opportunity score evidence for null opportunityScore");
  });

  it("positive evidence references actual values from input, not placeholder text", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "United Kingdom", industry: "Design" }),
    }), FIXED_NOW);

    const geoEvidence = result.positiveEvidence.find((e) => e.toLowerCase().includes("geography") || e.toLowerCase().includes("united kingdom"));
    assert.ok(geoEvidence, "Geography evidence should reference the actual country");
    assert.ok(geoEvidence!.includes("United Kingdom"), `Geography evidence should say 'United Kingdom', got: ${geoEvidence}`);
  });
});

describe("computeAccountQualification — geography FAIL beats all positive evidence", () => {
  it("produces score=0 even when industry, signals, and size all PASS", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "Germany", industry: "Advertising & Marketing", companySize: "11-50" }),
      signals: [makeJobPosting("Account Director"), makeFundingSignal()],
      opportunityScore: 85,
    }), FIXED_NOW);

    assert.equal(result.geographyVerdict, "FAIL");
    assert.equal(result.qualified, false);
    assert.equal(result.qualificationScore, 0, "Geography FAIL must zero out the score");
  });
});

describe("computeAccountQualification — conflicting evidence (exclude wins)", () => {
  it("hard-excludes when geography PASS but industry is in OUT list", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "United Kingdom", industry: "Holding company subsidiaries" }),
    }), FIXED_NOW);

    assert.equal(result.qualified, false);
    assert.equal(result.qualificationScore, 0);
    assert.ok(result.exclusionReasons.length > 0);
    assert.equal(result.geographyVerdict, "PASS");
    assert.equal(result.industryVerdict, "FAIL");
  });
});

describe("computeAccountQualification — result structure integrity", () => {
  it("always includes hypothesis field set to INITIAL_HYPOTHESIS_NOT_VALIDATED", () => {
    const result = computeAccountQualification(makeInput(), FIXED_NOW);
    assert.equal(result.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
  });

  it("preserves the campaignStrategyId in the result", () => {
    const result = computeAccountQualification(makeInput({ campaign: makeCampaign({ campaignStrategyId: CAMPAIGN_ID }) }), FIXED_NOW);
    assert.equal(result.campaignStrategyId, CAMPAIGN_ID);
  });

  it("assessedAt matches the provided now timestamp", () => {
    const result = computeAccountQualification(makeInput(), FIXED_NOW);
    assert.equal(result.assessedAt, FIXED_NOW.toISOString());
  });

  it("qualified=true companies have non-empty positiveEvidence", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "United Kingdom", industry: "Marketing and Advertising" }),
    }), FIXED_NOW);
    if (result.qualified) {
      assert.ok(result.positiveEvidence.length > 0, "Qualified accounts must have positive evidence");
    }
  });
});

describe("computeAccountQualification — explainable qualification reasons", () => {
  it("provides specific reasons for exclusion (not generic messages)", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "France", industry: "Advertising & Marketing" }),
    }), FIXED_NOW);

    assert.equal(result.qualified, false);
    assert.ok(result.exclusionReasons.length > 0);
    assert.ok(
      result.exclusionReasons[0].includes("France"),
      `Exclusion reason should mention the actual country, got: ${result.exclusionReasons[0]}`,
    );
  });

  it("provides specific evidence for positive qualification dimensions", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "United Kingdom", industry: "Branding Agency", companySize: "11-50" }),
    }), FIXED_NOW);

    const hasGeoEvidence  = result.positiveEvidence.some((e) => e.includes("United Kingdom"));
    const hasIndEvidence  = result.positiveEvidence.some((e) => e.toLowerCase().includes("brand") || e.toLowerCase().includes("industr"));
    const hasSizeEvidence = result.positiveEvidence.some((e) => e.includes("11-50"));

    assert.ok(hasGeoEvidence,  "Should have geo evidence citing actual country");
    assert.ok(hasIndEvidence,  "Should have industry evidence citing actual industry");
    assert.ok(hasSizeEvidence, "Should have size evidence citing actual size range");
  });
});

describe("computeAccountQualification — multi-tenant: clientId preserved in input", () => {
  it("does not cross-contaminate when called with different clientIds", () => {
    const clientA = "aaaaaaaa-0000-0000-0000-000000000000";
    const clientB = "bbbbbbbb-0000-0000-0000-000000000000";

    const rA = computeAccountQualification(makeInput({
      clientId: clientA, company: makeCompany({ country: "United Kingdom" }),
    }), FIXED_NOW);

    const rB = computeAccountQualification(makeInput({
      clientId: clientB, company: makeCompany({ country: "Germany" }),
    }), FIXED_NOW);

    assert.equal(rA.geographyVerdict, "PASS");
    assert.equal(rB.geographyVerdict, "FAIL");
    // The pure function doesn't leak state between calls
    assert.equal(rA.qualified, true);
    assert.equal(rB.qualified, false);
  });
});

describe("computeAccountQualification — hiring evidence absence is UNKNOWN not ABSENT", () => {
  it("hiringEvidenceVerdict is UNKNOWN when there are no signals, never ABSENT", () => {
    const result = computeAccountQualification(makeInput({ signals: [] }), FIXED_NOW);
    assert.notEqual(result.hiringEvidenceVerdict, "ABSENT" as unknown as string,
      "ABSENT should never be returned — absence of signals ≠ absence of hiring activity");
    assert.equal(result.hiringEvidenceVerdict, "UNKNOWN");
  });
});

describe("computeAccountQualification — opportunity score as supporting evidence only", () => {
  it("does not determine qualification on its own — a 0 opportunity score does not exclude", () => {
    const result = computeAccountQualification(makeInput({
      company: makeCompany({ country: "United Kingdom", industry: "Design" }),
      opportunityScore: 0,
    }), FIXED_NOW);

    // UK + matching industry = qualified regardless of zero opportunity score
    assert.equal(result.qualified, true, "Zero opportunity score should not hard-exclude");
  });

  it("non-null opportunity score adds to qualificationScore but does not override verdicts", () => {
    const withScore    = computeAccountQualification(makeInput({ opportunityScore: 100 }), FIXED_NOW);
    const withoutScore = computeAccountQualification(makeInput({ opportunityScore: null }), FIXED_NOW);

    assert.ok(
      withScore.qualificationScore >= withoutScore.qualificationScore,
      "Non-null opportunity score should not decrease qualificationScore",
    );
  });
});
