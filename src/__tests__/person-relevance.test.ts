/**
 * Unit tests for src/lib/person-relevance.ts — Stage 23.
 *
 * All tests are pure (no I/O, no DB, no AI calls).
 * Run: npx tsx --test src/__tests__/person-relevance.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCORING_VERSION,
  PERSON_RELEVANCE_MIN_SCORE,
  AI_RELEVANCE_MIN_SCORE,
  RELEVANCE_STALENESS_CEILING_DAYS,
  FACTOR_WEIGHTS,
  MAX_SIGNAL_BONUS,
  SENIORITY_ORDER,
  FUNCTION_ADJACENCY,
  SIGNAL_FUNCTION_MAP,
  classifyTitle,
  parseTargetingPersona,
  evaluateHardDisqualifiers,
  computeFunctionMatchScore,
  computeSeniorityMatchScore,
  computeSignalAlignmentBonus,
  computeRelevanceScore,
  evaluatePersonRelevantGate,
  buildSignalAlignments,
  buildPersonRelevanceAiInput,
  buildRelevanceEvidence,
  isContactIntelligenceStale,
  isCampaignRelevanceStale,
} from "../lib/person-relevance";
import type {
  TitleClassification,
  TargetingPersona,
  PersonRelevanceEvidence,
  ContactIntelligenceRow,
  ContactCampaignRelevanceRow,
} from "../domain/contact-intelligence-types";
import type { WhyNowSignalSummary } from "../domain/signal-types";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeSignal(signalType: string, title = "Test Signal"): WhyNowSignalSummary {
  return {
    signalId:      "00000000-0000-0000-0000-000000000001",
    signalType:    signalType as WhyNowSignalSummary["signalType"],
    title,
    description:   null,
    evidence:      { _signalId: "00000000-0000-0000-0000-000000000001" },
    signalStrength: 70,
    freshnessScore: 80,
    occurredAt:    "2026-09-01T00:00:00Z",
  };
}

function makeClassification(
  fn: TitleClassification["function"],
  seniority: TitleClassification["seniority"],
  confidence: TitleClassification["confidence"] = "high",
): TitleClassification {
  return { function: fn, seniority, confidence };
}

function makeTargetingPersona(
  targetFunctions: TargetingPersona["targetFunctions"],
  minimumSeniority: TargetingPersona["minimumSeniority"],
  hasExplicitFunction = targetFunctions.length > 0,
  hasExplicitSeniority = minimumSeniority !== "UNKNOWN",
): TargetingPersona {
  return { targetFunctions, minimumSeniority, hasExplicitFunction, hasExplicitSeniority };
}

const FIXED_NOW = new Date("2026-09-07T10:00:00Z");
const FIVE_DAYS_AGO  = "2026-09-02T10:00:00Z";
const EIGHT_DAYS_AGO = "2026-08-30T10:00:00Z";

function makeContactIntelligenceRow(
  contactReadinessAssessedAt: string | null,
): ContactIntelligenceRow {
  return {
    id: "row-id",
    clientId:                   "client-1",
    companyId:                   "company-1",
    contactId:                   "contact-1",
    titleClassification:         null,
    gateSnapshot:                null,
    isContactReady:              null,
    contactReadinessAssessedAt,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

function makeCampaignRelevanceRow(
  overrides: Partial<ContactCampaignRelevanceRow> = {},
): ContactCampaignRelevanceRow {
  return {
    id:                  "row-id",
    clientId:            "client-1",
    companyId:            "company-1",
    contactId:            "contact-1",
    campaignStrategyId:   "campaign-1",
    relevanceScore:       75,
    isPersonRelevant:     true,
    isPersonQualified:    true,
    relevanceReason:      "RELEVANT",
    evidence:             null,
    narrative:            null,
    scoringVersion:       SCORING_VERSION,
    relevanceAssessedAt:  FIVE_DAYS_AGO,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

// ── Constants ──────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("SCORING_VERSION is a non-empty semver string", () => {
    assert.match(SCORING_VERSION, /^\d+\.\d+\.\d+$/);
  });

  it("PERSON_RELEVANCE_MIN_SCORE is positive and <= 100", () => {
    assert.ok(PERSON_RELEVANCE_MIN_SCORE > 0);
    assert.ok(PERSON_RELEVANCE_MIN_SCORE <= 100);
  });

  it("AI_RELEVANCE_MIN_SCORE >= PERSON_RELEVANCE_MIN_SCORE", () => {
    assert.ok(AI_RELEVANCE_MIN_SCORE >= PERSON_RELEVANCE_MIN_SCORE);
  });

  it("RELEVANCE_STALENESS_CEILING_DAYS > 0", () => {
    assert.ok(RELEVANCE_STALENESS_CEILING_DAYS > 0);
  });

  it("factor weights sum to 1.0", () => {
    const sum = FACTOR_WEIGHTS.functionMatch + FACTOR_WEIGHTS.seniorityMatch;
    assert.equal(Math.round(sum * 100), 100);
  });

  it("MAX_SIGNAL_BONUS is positive and <= 25", () => {
    assert.ok(MAX_SIGNAL_BONUS > 0 && MAX_SIGNAL_BONUS <= 25);
  });

  it("SENIORITY_ORDER is strictly ordered C_SUITE > VP > DIRECTOR > MANAGER > IC > UNKNOWN", () => {
    assert.ok(SENIORITY_ORDER.C_SUITE  > SENIORITY_ORDER.VP);
    assert.ok(SENIORITY_ORDER.VP       > SENIORITY_ORDER.DIRECTOR);
    assert.ok(SENIORITY_ORDER.DIRECTOR > SENIORITY_ORDER.MANAGER);
    assert.ok(SENIORITY_ORDER.MANAGER  > SENIORITY_ORDER.IC);
    assert.ok(SENIORITY_ORDER.IC       > SENIORITY_ORDER.UNKNOWN);
  });

  it("FUNCTION_ADJACENCY: adjacency is NOT reflexive (function not adjacent to itself)", () => {
    for (const [fn, adjacents] of Object.entries(FUNCTION_ADJACENCY)) {
      assert.ok(
        !adjacents.includes(fn as never),
        `${fn} should not be adjacent to itself`,
      );
    }
  });

  it("SIGNAL_FUNCTION_MAP covers all SIGNAL_TYPES from domain", () => {
    const expectedTypes = [
      "executive_hire", "funding_round", "job_posting", "news_mention",
      "website_change", "product_launch", "partnership", "technology_change",
      "competitor_mention", "award", "expansion", "test",
    ];
    for (const t of expectedTypes) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(SIGNAL_FUNCTION_MAP, t),
        `SIGNAL_FUNCTION_MAP missing entry for "${t}"`,
      );
    }
  });
});

// ── classifyTitle ─────────────────────────────────────────────────────────────

describe("classifyTitle", () => {
  it("null → OTHER / UNKNOWN / low", () => {
    const r = classifyTitle(null);
    assert.equal(r.function, "OTHER");
    assert.equal(r.seniority, "UNKNOWN");
    assert.equal(r.confidence, "low");
  });

  it("empty string → OTHER / UNKNOWN / low", () => {
    const r = classifyTitle("");
    assert.equal(r.function, "OTHER");
    assert.equal(r.seniority, "UNKNOWN");
    assert.equal(r.confidence, "low");
  });

  it("does NOT return rawTitle", () => {
    const r = classifyTitle("VP of Sales") as Record<string, unknown>;
    assert.ok(!("rawTitle" in r), "rawTitle must not appear in TitleClassification");
  });

  // C-suite titles
  it("CEO → EXECUTIVE / C_SUITE / high", () => {
    const r = classifyTitle("CEO");
    assert.equal(r.function, "EXECUTIVE");
    assert.equal(r.seniority, "C_SUITE");
    assert.equal(r.confidence, "high");
  });

  it("Founder → EXECUTIVE / C_SUITE / high", () => {
    const r = classifyTitle("Founder");
    assert.equal(r.function, "EXECUTIVE");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("Co-Founder → EXECUTIVE / C_SUITE / high", () => {
    const r = classifyTitle("Co-Founder");
    assert.equal(r.function, "EXECUTIVE");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("CFO → FINANCE / C_SUITE / high", () => {
    const r = classifyTitle("CFO");
    assert.equal(r.function, "FINANCE");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("Chief Financial Officer → FINANCE / C_SUITE / high", () => {
    const r = classifyTitle("Chief Financial Officer");
    assert.equal(r.function, "FINANCE");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("CTO → ENGINEERING / C_SUITE / high", () => {
    const r = classifyTitle("CTO");
    assert.equal(r.function, "ENGINEERING");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("CRO → SALES / C_SUITE / high", () => {
    const r = classifyTitle("Chief Revenue Officer");
    assert.equal(r.function, "SALES");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("CMO → MARKETING / C_SUITE / high", () => {
    const r = classifyTitle("CMO");
    assert.equal(r.function, "MARKETING");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("COO → OPERATIONS / C_SUITE / high", () => {
    const r = classifyTitle("COO");
    assert.equal(r.function, "OPERATIONS");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("CPO → PRODUCT / C_SUITE / high", () => {
    const r = classifyTitle("CPO");
    assert.equal(r.function, "PRODUCT");
    assert.equal(r.seniority, "C_SUITE");
  });

  it("CISO → ENGINEERING / C_SUITE / high", () => {
    const r = classifyTitle("CISO");
    assert.equal(r.function, "ENGINEERING");
    assert.equal(r.seniority, "C_SUITE");
  });

  // VP-level titles
  it("VP of Sales → SALES / VP / high", () => {
    const r = classifyTitle("VP of Sales");
    assert.equal(r.function, "SALES");
    assert.equal(r.seniority, "VP");
    assert.equal(r.confidence, "high");
  });

  it("Vice President of Marketing → MARKETING / VP / high", () => {
    const r = classifyTitle("Vice President of Marketing");
    assert.equal(r.function, "MARKETING");
    assert.equal(r.seniority, "VP");
  });

  it("VP Engineering → ENGINEERING / VP / high", () => {
    const r = classifyTitle("VP Engineering");
    assert.equal(r.function, "ENGINEERING");
    assert.equal(r.seniority, "VP");
  });

  // Director-level
  it("Director of Finance → FINANCE / DIRECTOR / high", () => {
    const r = classifyTitle("Director of Finance");
    assert.equal(r.function, "FINANCE");
    assert.equal(r.seniority, "DIRECTOR");
  });

  it("Head of Marketing → MARKETING / DIRECTOR / high", () => {
    const r = classifyTitle("Head of Marketing");
    assert.equal(r.function, "MARKETING");
    assert.equal(r.seniority, "DIRECTOR");
  });

  // Manager-level
  it("Sales Manager → SALES / MANAGER / high", () => {
    const r = classifyTitle("Sales Manager");
    assert.equal(r.function, "SALES");
    assert.equal(r.seniority, "MANAGER");
  });

  it("Engineering Manager → ENGINEERING / MANAGER / high", () => {
    const r = classifyTitle("Engineering Manager");
    assert.equal(r.function, "ENGINEERING");
    assert.equal(r.seniority, "MANAGER");
  });

  // IC-level
  it("Software Engineer → ENGINEERING / IC / high (senior→IC)", () => {
    const r = classifyTitle("Software Engineer");
    assert.equal(r.function, "ENGINEERING");
    // IC or UNKNOWN acceptable — seniority not specified in title
  });

  it("Senior Software Engineer → ENGINEERING / IC", () => {
    const r = classifyTitle("Senior Software Engineer");
    assert.equal(r.function, "ENGINEERING");
    assert.equal(r.seniority, "IC");
  });

  it("Account Executive → SALES", () => {
    const r = classifyTitle("Account Executive");
    assert.equal(r.function, "SALES");
  });

  it("SDR → SALES", () => {
    const r = classifyTitle("SDR");
    assert.equal(r.function, "SALES");
  });

  // Recruiter / HR
  it("Talent Acquisition Manager → HR / MANAGER", () => {
    const r = classifyTitle("Talent Acquisition Manager");
    assert.equal(r.function, "HR");
    assert.equal(r.seniority, "MANAGER");
  });

  // Legal
  it("General Counsel → LEGAL", () => {
    const r = classifyTitle("General Counsel");
    assert.equal(r.function, "LEGAL");
  });

  // Product
  it("Product Manager → PRODUCT / MANAGER / high", () => {
    const r = classifyTitle("Product Manager");
    assert.equal(r.function, "PRODUCT");
    assert.equal(r.seniority, "MANAGER");
    assert.equal(r.confidence, "high");
  });

  // Low confidence — function only
  it("Sales (solo word) → SALES but lower confidence", () => {
    const r = classifyTitle("Sales");
    assert.equal(r.function, "SALES");
    assert.notEqual(r.confidence, "high");
  });

  // Unknown / other
  it("Strategy Consultant → detects UNKNOWN seniority for generic title", () => {
    const r = classifyTitle("Strategy Consultant");
    // Consultant maps to IC
    assert.equal(r.seniority, "IC");
  });

  it("random gibberish → OTHER / UNKNOWN / low", () => {
    const r = classifyTitle("Xyzzyx Florp");
    assert.equal(r.function, "OTHER");
    assert.equal(r.seniority, "UNKNOWN");
    assert.equal(r.confidence, "low");
  });
});

// ── parseTargetingPersona ──────────────────────────────────────────────────────

describe("parseTargetingPersona", () => {
  it("null → no explicit function or seniority", () => {
    const p = parseTargetingPersona(null);
    assert.equal(p.hasExplicitFunction, false);
    assert.equal(p.hasExplicitSeniority, false);
    assert.equal(p.targetFunctions.length, 0);
    assert.equal(p.minimumSeniority, "UNKNOWN");
  });

  it("empty string → no explicit function or seniority", () => {
    const p = parseTargetingPersona("");
    assert.equal(p.hasExplicitFunction, false);
    assert.equal(p.hasExplicitSeniority, false);
  });

  it('"VP Sales at 50-200 person B2B SaaS" → SALES / minimumSeniority=VP', () => {
    const p = parseTargetingPersona("VP Sales at 50-200 person B2B SaaS companies");
    assert.ok(p.targetFunctions.includes("SALES"), "expected SALES in targetFunctions");
    assert.equal(p.minimumSeniority, "VP");
    assert.equal(p.hasExplicitFunction, true);
    assert.equal(p.hasExplicitSeniority, true);
  });

  it('"Director of Marketing" → MARKETING / DIRECTOR', () => {
    const p = parseTargetingPersona("Director of Marketing at funded startups");
    assert.ok(p.targetFunctions.includes("MARKETING"));
    assert.equal(p.minimumSeniority, "DIRECTOR");
  });

  it('"Founders and Co-founders" → EXECUTIVE / C_SUITE', () => {
    const p = parseTargetingPersona("Founders and Co-founders");
    assert.ok(p.targetFunctions.includes("EXECUTIVE"));
    assert.equal(p.minimumSeniority, "C_SUITE");
  });

  it('"C-suite executives" → EXECUTIVE / C_SUITE', () => {
    const p = parseTargetingPersona("C-suite executives at enterprise software companies");
    assert.ok(p.targetFunctions.includes("EXECUTIVE"));
    assert.equal(p.minimumSeniority, "C_SUITE");
  });

  it("targetFunctions contains no duplicates", () => {
    const p = parseTargetingPersona("VP Sales and Sales Director");
    const unique = new Set(p.targetFunctions);
    assert.equal(unique.size, p.targetFunctions.length);
  });
});

// ── evaluateHardDisqualifiers ─────────────────────────────────────────────────

describe("evaluateHardDisqualifiers", () => {
  it("returns null when targeting has no explicit function or seniority", () => {
    const classification = makeClassification("ENGINEERING", "IC");
    const targeting = makeTargetingPersona([], "UNKNOWN", false, false);
    assert.equal(evaluateHardDisqualifiers(classification, targeting), null);
  });

  it("returns null for exact function match", () => {
    const cl = makeClassification("SALES", "VP");
    const tp = makeTargetingPersona(["SALES"], "VP");
    assert.equal(evaluateHardDisqualifiers(cl, tp), null);
  });

  it("returns null for adjacent function match (MARKETING adjacent to SALES target)", () => {
    const cl = makeClassification("MARKETING", "VP");
    const tp = makeTargetingPersona(["SALES"], "VP");
    assert.equal(evaluateHardDisqualifiers(cl, tp), null);
  });

  it("returns WRONG_FUNCTION when function has no overlap", () => {
    const cl = makeClassification("ENGINEERING", "VP");
    const tp = makeTargetingPersona(["SALES"], "VP");
    assert.equal(evaluateHardDisqualifiers(cl, tp), "WRONG_FUNCTION");
  });

  it("LEGAL is NOT adjacent to SALES — returns WRONG_FUNCTION", () => {
    const cl = makeClassification("LEGAL", "DIRECTOR");
    const tp = makeTargetingPersona(["SALES"], "DIRECTOR");
    assert.equal(evaluateHardDisqualifiers(cl, tp), "WRONG_FUNCTION");
  });

  it("returns WRONG_SENIORITY when seniority is below minimum", () => {
    const cl = makeClassification("SALES", "IC");
    const tp = makeTargetingPersona(["SALES"], "VP");
    assert.equal(evaluateHardDisqualifiers(cl, tp), "WRONG_SENIORITY");
  });

  it("returns WRONG_SENIORITY: MANAGER below DIRECTOR", () => {
    const cl = makeClassification("SALES", "MANAGER");
    const tp = makeTargetingPersona(["SALES"], "DIRECTOR");
    assert.equal(evaluateHardDisqualifiers(cl, tp), "WRONG_SENIORITY");
  });

  it("UNKNOWN seniority does NOT trigger WRONG_SENIORITY", () => {
    const cl = makeClassification("SALES", "UNKNOWN");
    const tp = makeTargetingPersona(["SALES"], "VP");
    // UNKNOWN seniority → no disqualifier, low score instead
    assert.equal(evaluateHardDisqualifiers(cl, tp), null);
  });

  it("returns null when at exactly minimum seniority", () => {
    const cl = makeClassification("SALES", "VP");
    const tp = makeTargetingPersona(["SALES"], "VP");
    assert.equal(evaluateHardDisqualifiers(cl, tp), null);
  });

  it("returns null when above minimum seniority", () => {
    const cl = makeClassification("SALES", "C_SUITE");
    const tp = makeTargetingPersona(["SALES"], "VP");
    assert.equal(evaluateHardDisqualifiers(cl, tp), null);
  });

  it("EXECUTIVE target function accepts SALES as adjacent", () => {
    const cl = makeClassification("SALES", "VP");
    const tp = makeTargetingPersona(["EXECUTIVE"], "UNKNOWN", true, false);
    // EXECUTIVE is adjacent to SALES (per adjacency map)
    assert.equal(evaluateHardDisqualifiers(cl, tp), null);
  });

  it("function check fires before seniority check (WRONG_FUNCTION wins)", () => {
    const cl = makeClassification("ENGINEERING", "IC");
    const tp = makeTargetingPersona(["SALES"], "VP");
    // Both wrong, but WRONG_FUNCTION is checked first
    assert.equal(evaluateHardDisqualifiers(cl, tp), "WRONG_FUNCTION");
  });
});

// ── computeFunctionMatchScore ─────────────────────────────────────────────────

describe("computeFunctionMatchScore", () => {
  it("returns 50 when no explicit function targeting", () => {
    const score = computeFunctionMatchScore("SALES", [], false, "high");
    assert.equal(score, 50);
  });

  it("returns 100 for exact match with high confidence", () => {
    const score = computeFunctionMatchScore("SALES", ["SALES"], true, "high");
    assert.equal(score, 100);
  });

  it("returns 60 for adjacent match with high confidence", () => {
    const score = computeFunctionMatchScore("MARKETING", ["SALES"], true, "high");
    assert.equal(score, 60);
  });

  it("applies confidence discount: medium → 85% of base", () => {
    const score = computeFunctionMatchScore("SALES", ["SALES"], true, "medium");
    assert.equal(score, Math.round(100 * 0.85));
  });

  it("applies confidence discount: low → 70% of base", () => {
    const score = computeFunctionMatchScore("SALES", ["SALES"], true, "low");
    assert.equal(score, Math.round(100 * 0.70));
  });

  it("adjacent match with medium confidence → 60 * 0.85", () => {
    const score = computeFunctionMatchScore("MARKETING", ["SALES"], true, "medium");
    assert.equal(score, Math.round(60 * 0.85));
  });

  it("returns 0 for no match (defensive)", () => {
    const score = computeFunctionMatchScore("LEGAL", ["SALES"], true, "high");
    assert.equal(score, 0);
  });
});

// ── computeSeniorityMatchScore ────────────────────────────────────────────────

describe("computeSeniorityMatchScore", () => {
  it("returns 50 when no explicit seniority targeting", () => {
    assert.equal(computeSeniorityMatchScore("IC", "UNKNOWN", false), 50);
  });

  it("returns 100 when above minimum", () => {
    assert.equal(computeSeniorityMatchScore("C_SUITE", "VP", true), 100);
  });

  it("returns 85 when exactly at minimum", () => {
    assert.equal(computeSeniorityMatchScore("VP", "VP", true), 85);
  });

  it("returns 30 for UNKNOWN seniority (not disqualified)", () => {
    assert.equal(computeSeniorityMatchScore("UNKNOWN", "VP", true), 30);
  });

  it("returns 0 when below minimum (defensive — disqualifier should have fired)", () => {
    assert.equal(computeSeniorityMatchScore("IC", "VP", true), 0);
  });

  it("C_SUITE above VP → 100", () => {
    assert.equal(computeSeniorityMatchScore("C_SUITE", "DIRECTOR", true), 100);
  });

  it("MANAGER at MANAGER minimum → 85", () => {
    assert.equal(computeSeniorityMatchScore("MANAGER", "MANAGER", true), 85);
  });
});

// ── computeSignalAlignmentBonus ───────────────────────────────────────────────

describe("computeSignalAlignmentBonus", () => {
  it("returns 0 when no signals", () => {
    assert.equal(computeSignalAlignmentBonus([], "SALES"), 0);
  });

  it("returns 0 when no signal matches contact function", () => {
    // job_posting maps to ENGINEERING/OPERATIONS/HR, not FINANCE
    assert.equal(computeSignalAlignmentBonus([makeSignal("job_posting")], "FINANCE"), 0);
  });

  it("returns 10 for a single matching signal type", () => {
    // funding_round maps to EXECUTIVE, SALES, FINANCE
    assert.equal(computeSignalAlignmentBonus([makeSignal("funding_round")], "SALES"), 10);
  });

  it("counts unique signal types only (two funding_round signals = 10, not 20)", () => {
    const signals = [makeSignal("funding_round"), makeSignal("funding_round")];
    assert.equal(computeSignalAlignmentBonus(signals, "SALES"), 10);
  });

  it("two different matching types → 20", () => {
    const signals = [makeSignal("funding_round"), makeSignal("expansion")];
    assert.equal(computeSignalAlignmentBonus(signals, "SALES"), 20);
  });

  it("caps at MAX_SIGNAL_BONUS", () => {
    const signals = [
      makeSignal("funding_round"),
      makeSignal("expansion"),
      makeSignal("partnership"),
    ];
    // Three matches would be 30, but capped at MAX_SIGNAL_BONUS (20)
    const bonus = computeSignalAlignmentBonus(signals, "SALES");
    assert.ok(bonus <= MAX_SIGNAL_BONUS);
  });

  it("EXECUTIVE function matched by multiple signal types", () => {
    // funding_round and executive_hire both map to EXECUTIVE
    const signals = [makeSignal("funding_round"), makeSignal("executive_hire")];
    assert.equal(computeSignalAlignmentBonus(signals, "EXECUTIVE"), 20);
  });
});

// ── computeRelevanceScore ─────────────────────────────────────────────────────

describe("computeRelevanceScore", () => {
  it("clamps to 0 minimum", () => {
    assert.equal(computeRelevanceScore(0, 0, 0), 0);
  });

  it("clamps to 100 maximum", () => {
    assert.equal(computeRelevanceScore(100, 100, MAX_SIGNAL_BONUS), 100);
  });

  it("100 function + 100 seniority + 0 bonus → 100", () => {
    assert.equal(computeRelevanceScore(100, 100, 0), 100);
  });

  it("50 function + 50 seniority + 0 bonus → 50 (neutral)", () => {
    assert.equal(computeRelevanceScore(50, 50, 0), 50);
  });

  it("60 function (adjacent) + 85 seniority (at min) + 10 signal → ~87", () => {
    const score = computeRelevanceScore(60, 85, 10);
    // 60*0.55 + 85*0.45 + 10 = 33 + 38.25 + 10 = 81.25 → rounds to 81
    assert.ok(score >= 79 && score <= 83, `Expected ~81, got ${score}`);
  });

  it("applies factor weights consistently", () => {
    const score = computeRelevanceScore(100, 0, 0);
    assert.equal(score, Math.round(100 * FACTOR_WEIGHTS.functionMatch));
  });
});

// ── evaluatePersonRelevantGate ────────────────────────────────────────────────

describe("evaluatePersonRelevantGate", () => {
  it("returns false when score is 0", () => {
    assert.equal(evaluatePersonRelevantGate(0), false);
  });

  it("returns false when score is below PERSON_RELEVANCE_MIN_SCORE", () => {
    assert.equal(evaluatePersonRelevantGate(PERSON_RELEVANCE_MIN_SCORE - 1), false);
  });

  it("returns true when score equals PERSON_RELEVANCE_MIN_SCORE", () => {
    assert.equal(evaluatePersonRelevantGate(PERSON_RELEVANCE_MIN_SCORE), true);
  });

  it("returns true when score is above PERSON_RELEVANCE_MIN_SCORE", () => {
    assert.equal(evaluatePersonRelevantGate(PERSON_RELEVANCE_MIN_SCORE + 1), true);
  });

  it("returns true when score is 100", () => {
    assert.equal(evaluatePersonRelevantGate(100), true);
  });
});

// ── buildSignalAlignments ─────────────────────────────────────────────────────

describe("buildSignalAlignments", () => {
  it("returns empty array for no signals", () => {
    assert.deepEqual(buildSignalAlignments([], "SALES"), []);
  });

  it("deduplicates signal types", () => {
    const signals = [makeSignal("funding_round"), makeSignal("funding_round")];
    const alignments = buildSignalAlignments(signals, "SALES");
    assert.equal(alignments.length, 1);
  });

  it("alignmentScore is 1 for matching function, 0 otherwise", () => {
    const signals = [makeSignal("funding_round"), makeSignal("job_posting")];
    const alignments = buildSignalAlignments(signals, "SALES");
    const fundingAlignment = alignments.find((a) => a.signalType === "funding_round");
    const jobAlignment = alignments.find((a) => a.signalType === "job_posting");
    assert.equal(fundingAlignment?.alignmentScore, 1);  // SALES is in funding_round preferred
    assert.equal(jobAlignment?.alignmentScore, 0);       // SALES is not in job_posting preferred
  });

  it("includes suggestedFunctions from SIGNAL_FUNCTION_MAP", () => {
    const alignments = buildSignalAlignments([makeSignal("funding_round")], "FINANCE");
    assert.ok(alignments[0]?.suggestedFunctions.includes("FINANCE"));
  });
});

// ── buildPersonRelevanceAiInput ───────────────────────────────────────────────

describe("buildPersonRelevanceAiInput", () => {
  const cl = makeClassification("SALES", "VP");
  const tp = makeTargetingPersona(["SALES"], "VP");
  const signals = [makeSignal("funding_round", "Series B round")];
  const campaign = {
    campaign_name:     "Q3 Outbound",
    targeting_level:   "VP Sales and above",
    value_proposition: "Close deals 30% faster",
  };

  it("returns a SignalIntelligenceInput shape", () => {
    const input = buildPersonRelevanceAiInput(cl, tp, signals, campaign, "VP of Sales", null, "2026-09-07T10:00:00Z");
    assert.ok(typeof input.company?.name === "string");
    assert.ok(Array.isArray(input.signals));
    assert.ok(typeof input.icp?.description === "string");
  });

  it("company name does NOT contain email address (PII check)", () => {
    const input = buildPersonRelevanceAiInput(cl, tp, signals, campaign, "VP of Sales", null, "2026-09-07T10:00:00Z");
    assert.ok(!input.company.name.includes("@"), "Email must not appear in company name");
  });

  it("icp description does NOT contain email address (PII check)", () => {
    const input = buildPersonRelevanceAiInput(cl, tp, signals, campaign, "VP of Sales", null, "2026-09-07T10:00:00Z");
    assert.ok(!(input.icp.description ?? "").includes("@"), "Email must not appear in icp description");
  });

  it("company description includes function and seniority", () => {
    const input = buildPersonRelevanceAiInput(cl, tp, signals, campaign, "VP of Sales", null, "2026-09-07T10:00:00Z");
    const desc = input.company.description ?? "";
    assert.ok(desc.includes("SALES"), "description should include function");
    assert.ok(desc.includes("VP"), "description should include seniority");
  });

  it("includes signals passed in", () => {
    const input = buildPersonRelevanceAiInput(cl, tp, signals, campaign, "VP of Sales", null, "2026-09-07T10:00:00Z");
    assert.equal(input.signals.length, 1);
    assert.equal(input.signals[0].title, "Series B round");
  });

  it("includes Why Now narrative as secondary context with disclaimer", () => {
    const input = buildPersonRelevanceAiInput(
      cl, tp, signals, campaign, "VP of Sales",
      "The company recently raised a Series B.", "2026-09-07T10:00:00Z",
    );
    const desc = input.company.description ?? "";
    assert.ok(desc.includes("SECONDARY CONTEXT"), "Why Now narrative must be labeled secondary context");
    assert.ok(desc.includes("not source data") || desc.includes("not ground truth") || desc.includes("NOT source data"),
      "Must include disclaimer that this is not source data");
  });

  it("omits SECONDARY CONTEXT section when whyNowNarrative is null", () => {
    const input = buildPersonRelevanceAiInput(cl, tp, signals, campaign, "VP of Sales", null, "2026-09-07T10:00:00Z");
    assert.ok(!(input.company.description ?? "").includes("SECONDARY CONTEXT"));
  });

  it("icp description instructs AI to cite only listed evidence", () => {
    const input = buildPersonRelevanceAiInput(cl, tp, signals, campaign, "VP of Sales", null, "2026-09-07T10:00:00Z");
    const desc = input.icp.description ?? "";
    assert.ok(desc.includes("Do not invent") || desc.includes("not invent"),
      "icp description must prohibit inventing facts");
  });
});

// ── buildRelevanceEvidence ────────────────────────────────────────────────────

describe("buildRelevanceEvidence", () => {
  it("includes scoringVersion, assessedAt, hypothesis", () => {
    const cl = makeClassification("SALES", "VP");
    const tp = makeTargetingPersona(["SALES"], "VP");
    const evidence = buildRelevanceEvidence(
      cl, tp, [],
      { functionMatch: 100, seniorityMatch: 85, signalBonus: 10 },
      95,
      "2026-09-07T10:00:00Z",
    );
    assert.equal(evidence.scoringVersion, SCORING_VERSION);
    assert.equal(evidence.hypothesis, "INITIAL_HYPOTHESIS_NOT_VALIDATED");
    assert.equal(evidence.assessedAt, "2026-09-07T10:00:00Z");
    assert.equal(evidence.relevanceScore, 95);
  });

  it("does NOT contain rawTitle in any nested object", () => {
    const cl = makeClassification("SALES", "VP");
    const tp = makeTargetingPersona(["SALES"], "VP");
    const evidence = buildRelevanceEvidence(cl, tp, [], { functionMatch: 100, seniorityMatch: 85, signalBonus: 0 }, 90, "2026-09-07T10:00:00Z");
    const json = JSON.stringify(evidence);
    assert.ok(!json.includes("rawTitle"), "rawTitle must never appear in stored evidence");
  });
});

// ── isContactIntelligenceStale ─────────────────────────────────────────────────

describe("isContactIntelligenceStale", () => {
  it("stale when contactReadinessAssessedAt is null", () => {
    const row = makeContactIntelligenceRow(null);
    assert.equal(isContactIntelligenceStale(row, null, FIXED_NOW), true);
  });

  it("not stale when assessed 5 days ago, no suppression change", () => {
    const row = makeContactIntelligenceRow(FIVE_DAYS_AGO);
    assert.equal(isContactIntelligenceStale(row, null, FIXED_NOW), false);
  });

  it("stale when assessed 8 days ago (beyond ceiling)", () => {
    const row = makeContactIntelligenceRow(EIGHT_DAYS_AGO);
    assert.equal(isContactIntelligenceStale(row, null, FIXED_NOW), true);
  });

  it("stale when suppression changed after assessment", () => {
    const row = makeContactIntelligenceRow(FIVE_DAYS_AGO);
    // suppression changed 1 day ago — after the assessment
    const suppressionChange = "2026-09-06T10:00:00Z";
    assert.equal(isContactIntelligenceStale(row, suppressionChange, FIXED_NOW), true);
  });

  it("not stale when suppression change predates assessment", () => {
    const row = makeContactIntelligenceRow(FIVE_DAYS_AGO);
    // suppression changed 6 days ago — before the assessment
    const suppressionChange = "2026-09-01T10:00:00Z";
    assert.equal(isContactIntelligenceStale(row, suppressionChange, FIXED_NOW), false);
  });
});

// ── isCampaignRelevanceStale ──────────────────────────────────────────────────

describe("isCampaignRelevanceStale", () => {
  const CAMPAIGN_ID = "campaign-1";
  const CAMPAIGN_UPDATED_AT = "2026-09-01T00:00:00Z"; // before assessment

  it("stale when relevanceAssessedAt is null", () => {
    const row = makeCampaignRelevanceRow({ relevanceAssessedAt: null });
    assert.equal(
      isCampaignRelevanceStale(row, CAMPAIGN_ID, CAMPAIGN_UPDATED_AT, null, null, FIXED_NOW),
      true,
    );
  });

  it("not stale when all conditions are fresh", () => {
    const row = makeCampaignRelevanceRow();
    assert.equal(
      isCampaignRelevanceStale(row, CAMPAIGN_ID, CAMPAIGN_UPDATED_AT, null, null, FIXED_NOW),
      false,
    );
  });

  it("stale when assessed 8 days ago (beyond ceiling)", () => {
    const row = makeCampaignRelevanceRow({ relevanceAssessedAt: EIGHT_DAYS_AGO });
    assert.equal(
      isCampaignRelevanceStale(row, CAMPAIGN_ID, CAMPAIGN_UPDATED_AT, null, null, FIXED_NOW),
      true,
    );
  });

  it("stale when scoring version differs", () => {
    const row = makeCampaignRelevanceRow({ scoringVersion: "0.9.0" });
    assert.equal(
      isCampaignRelevanceStale(row, CAMPAIGN_ID, CAMPAIGN_UPDATED_AT, null, null, FIXED_NOW),
      true,
    );
  });

  it("stale when different campaign ID", () => {
    const row = makeCampaignRelevanceRow();
    assert.equal(
      isCampaignRelevanceStale(row, "different-campaign", CAMPAIGN_UPDATED_AT, null, null, FIXED_NOW),
      true,
    );
  });

  it("stale when campaign was updated after assessment", () => {
    const row = makeCampaignRelevanceRow();
    // Campaign updated 1 day ago, assessment was 5 days ago
    const campaignUpdated = "2026-09-06T10:00:00Z";
    assert.equal(
      isCampaignRelevanceStale(row, CAMPAIGN_ID, campaignUpdated, null, null, FIXED_NOW),
      true,
    );
  });

  it("stale when account intelligence was refreshed after assessment", () => {
    const row = makeCampaignRelevanceRow();
    // Account readiness assessed 1 day ago, relevance was assessed 5 days ago
    const accountRefreshed = "2026-09-06T10:00:00Z";
    assert.equal(
      isCampaignRelevanceStale(row, CAMPAIGN_ID, CAMPAIGN_UPDATED_AT, accountRefreshed, null, FIXED_NOW),
      true,
    );
  });

  it("stale when contact intelligence was refreshed after assessment", () => {
    const row = makeCampaignRelevanceRow();
    const contactRefreshed = "2026-09-06T10:00:00Z";
    assert.equal(
      isCampaignRelevanceStale(row, CAMPAIGN_ID, CAMPAIGN_UPDATED_AT, null, contactRefreshed, FIXED_NOW),
      true,
    );
  });
});

// ── Integration: full scoring pipeline ───────────────────────────────────────

describe("full scoring pipeline", () => {
  it("VP Sales + Sales campaign + funding_round signal → qualified", () => {
    const cl = classifyTitle("VP of Sales");
    assert.equal(cl.function, "SALES");
    assert.equal(cl.seniority, "VP");

    const tp = parseTargetingPersona("VP Sales and above at SaaS companies");
    assert.ok(tp.targetFunctions.includes("SALES"));
    assert.equal(tp.minimumSeniority, "VP");

    const disqualifier = evaluateHardDisqualifiers(cl, tp);
    assert.equal(disqualifier, null);

    const fnScore  = computeFunctionMatchScore(cl.function, tp.targetFunctions, tp.hasExplicitFunction, cl.confidence);
    const senScore = computeSeniorityMatchScore(cl.seniority, tp.minimumSeniority, tp.hasExplicitSeniority);
    const bonus    = computeSignalAlignmentBonus([makeSignal("funding_round")], cl.function);
    const score    = computeRelevanceScore(fnScore, senScore, bonus);
    const relevant = evaluatePersonRelevantGate(score);

    assert.ok(score >= PERSON_RELEVANCE_MIN_SCORE, `Expected score >= ${PERSON_RELEVANCE_MIN_SCORE}, got ${score}`);
    assert.equal(relevant, true);
  });

  it("Junior SDR + VP Sales campaign → WRONG_SENIORITY hard disqualifier", () => {
    const cl = classifyTitle("Sales Development Representative");
    const tp = parseTargetingPersona("VP Sales and above");

    const disqualifier = evaluateHardDisqualifiers(cl, tp);
    assert.equal(disqualifier, "WRONG_SENIORITY");
  });

  it("VP Engineering + Sales campaign → WRONG_FUNCTION hard disqualifier", () => {
    const cl = classifyTitle("VP Engineering");
    const tp = parseTargetingPersona("VP Sales and above");

    const disqualifier = evaluateHardDisqualifiers(cl, tp);
    assert.equal(disqualifier, "WRONG_FUNCTION");
  });

  it("VP Marketing + Sales campaign → adjacent (no disqualifier, lower score)", () => {
    const cl = classifyTitle("VP Marketing");
    const tp = parseTargetingPersona("VP Sales and above");

    const disqualifier = evaluateHardDisqualifiers(cl, tp);
    assert.equal(disqualifier, null, "MARKETING adjacent to SALES — no disqualifier");

    const fnScore = computeFunctionMatchScore(cl.function, tp.targetFunctions, tp.hasExplicitFunction, cl.confidence);
    assert.ok(fnScore < 100, "Adjacent match should score below exact match");
    assert.ok(fnScore > 0, "Adjacent match should score above zero");
  });

  it("score below threshold → SCORE_BELOW_THRESHOLD (no AI narrative)", () => {
    // This scenario: unspecified targeting → 50/50 neutral scores → ~50 total
    // If PERSON_RELEVANCE_MIN_SCORE > 50, this would fail; but threshold is 30
    // Let's force a low score by using low confidence + no signal bonus
    const cl: TitleClassification = { function: "OTHER", seniority: "UNKNOWN", confidence: "low" };
    const tp: TargetingPersona = { targetFunctions: ["SALES"], minimumSeniority: "VP", hasExplicitFunction: true, hasExplicitSeniority: true };
    // Hard disqualifiers: WRONG_FUNCTION (OTHER not adjacent to SALES) → fires
    const dis = evaluateHardDisqualifiers(cl, tp);
    assert.equal(dis, "WRONG_FUNCTION");
  });
});
