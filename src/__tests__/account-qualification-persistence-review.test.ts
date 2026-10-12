/**
 * Stage 29 Phase 1.5 — Qualification Persistence Architecture Review.
 *
 * This test file exists to prove a correctness problem with the proposed
 * persistence design before migration 0021 is applied.
 *
 * ── PROPOSED DESIGN (under review) ───────────────────────────────────────────
 *
 *   ALTER TABLE account_intelligence
 *     ADD COLUMN qualification              JSONB,
 *     ADD COLUMN is_qualified              BOOLEAN,
 *     ADD COLUMN qualification_assessed_at TIMESTAMPTZ;
 *
 *   Storage key: (client_id, company_id)
 *   One row per (client, company) — campaign-AGNOSTIC.
 *
 * ── THE RISK ──────────────────────────────────────────────────────────────────
 *
 *   account_intelligence is per (client_id, company_id).
 *   The qualification result is campaign-SPECIFIC — it contains campaignStrategyId
 *   and reflects the ICP, geography, industry rules, and exclusions of ONE strategy.
 *
 *   A client with TWO campaigns targeting the same company produces two qualification
 *   results that CONFLICT. Adding one BOOLEAN to a campaign-agnostic row means the
 *   second write ALWAYS DESTROYS the first — the last writer wins with no audit trail.
 *
 *   Stage 25 evaluates ONE SPECIFIC CAMPAIGN at a time. If is_qualified reflects
 *   a different campaign's qualification, Stage 25 reads incorrect data.
 *
 * ── EXISTING PRECEDENT ────────────────────────────────────────────────────────
 *
 *   The codebase already solved this problem for contacts:
 *
 *     contact_intelligence        — per (client, company, contact)         — campaign-AGNOSTIC
 *     contact_campaign_relevance  — per (client, company, contact, strategy) — campaign-SPECIFIC
 *
 *   Migration 0018 commentary:
 *     "The same contact may be RELEVANT for one campaign and NOT RELEVANT for another."
 *
 *   This IDENTICAL statement applies to accounts:
 *     "The same company may QUALIFY for one campaign and NOT QUALIFY for another."
 *
 * ── WHY IS_READY IS DIFFERENT FROM IS_QUALIFIED ───────────────────────────────
 *
 *   account_intelligence.is_ready (per client, company) is CORRECT as campaign-agnostic:
 *     - "Are there active buying signals right now?" does not depend on the campaign
 *     - A funding round or job posting is relevant regardless of which campaign evaluates it
 *     - The account either has signals or it doesn't
 *
 *   account_qualification.is_qualified CANNOT be campaign-agnostic:
 *     - "Does this company fit THIS campaign's ICP?" IS campaign-specific
 *     - Campaign S1: UK founders / 3-200 employees → Company A: QUALIFIED
 *     - Campaign S2: US enterprise / 500+ employees → Company A: NOT QUALIFIED
 *     - Storing one boolean for BOTH campaigns is a logic error
 *
 * ── RECOMMENDED ARCHITECTURE ─────────────────────────────────────────────────
 *
 *   New table: account_campaign_qualification
 *   Key: UNIQUE (client_id, company_id, campaign_strategy_id)
 *
 *   Follows the EXACT pattern of contact_campaign_relevance (migration 0018).
 *   account_intelligence is NOT modified.
 *
 * ── WHAT TESTS PROVE ─────────────────────────────────────────────────────────
 *
 *   T1-T4:   Conflicting qualification — same company, two strategies
 *   T5-T6:   Overwrite simulation — proposed per-(client, company) design loses data
 *   T7-T8:   Correct design — per-(client, company, strategy) preserves both results
 *   T9-T10:  Stage 25 integration risk — wrong is_qualified feeds wrong CB check
 *   T11-T13: Why Now contrast — is_ready is correctly campaign-agnostic
 *   T14-T16: Idempotency — per-(client, company, strategy) key enables safe re-runs
 *   T17-T18: Client isolation — multi-tenant qualification correctness
 *
 * NO DB WRITES. NO PROVIDER CALLS. All tests are pure in-memory.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeAccountQualification } from "../lib/account-qualification";
import type {
  AccountQualificationInput,
  AccountQualificationResult,
} from "../domain/account-qualification-types";

// ── Shared test fixtures ──────────────────────────────────────────────────────

const CLIENT_ID    = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa";
const COMPANY_ID   = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb";
const STRATEGY_1   = "cccccccc-3333-3333-3333-cccccccccccc";  // UK Founders campaign
const STRATEGY_2   = "dddddddd-4444-4444-4444-dddddddddddd";  // US Enterprise campaign
const OTHER_CLIENT = "eeeeeeee-5555-5555-5555-eeeeeeeeeeee";
const FIXED_NOW    = new Date("2026-09-11T10:00:00.000Z");

/** A UK creative agency that qualifies for S1 but not S2. */
const UK_AGENCY_COMPANY: AccountQualificationInput["company"] = {
  id: COMPANY_ID,
  name: "Bright Studio Ltd",
  domain: "brightstudio.co.uk",
  industry: "Advertising & Marketing",
  country: "United Kingdom",
  city: "London",
  companySize: "11-50",
  description: null,
};

/** Campaign Strategy 1: UK founders / creative agencies / 3-200 employees. */
const STRATEGY_1_ICP: AccountQualificationInput["icp"] = {
  geographyAnswer:     "United Kingdom.",
  industriesAnswer:    "IN: Creative agencies, Advertising agencies, Marketing agencies, Design agencies. OUT: Holding company subsidiaries.",
  disqualifiersAnswer: "Holding company subsidiaries; private equity-owned agencies; B2C-only agencies",
  headcountAnswer:     "3–200 employees as a targeting hypothesis; do not discard companies when headcount is unknown.",
  triggersAnswer:      null,
};

/** Campaign Strategy 2: US enterprise / large technology companies / 500+ employees. */
const STRATEGY_2_ICP: AccountQualificationInput["icp"] = {
  geographyAnswer:     "United States, primarily NYC and San Francisco.",
  industriesAnswer:    "IN: Enterprise software, Cloud computing, Financial technology. OUT: Creative agencies, Marketing firms.",
  disqualifiersAnswer: "Small agencies under 200 employees; B2C consumer companies",
  headcountAnswer:     "500–10000 employees (enterprise only).",
  triggersAnswer:      null,
};

function makeInput(
  strategyId: string,
  icp: AccountQualificationInput["icp"],
  company: AccountQualificationInput["company"] = UK_AGENCY_COMPANY,
  clientId: string = CLIENT_ID,
): AccountQualificationInput {
  return {
    clientId,
    company,
    icp,
    campaign: { campaignStrategyId: strategyId, listFilters: null },
    signals:  [],
    opportunityScore: null,
  };
}

// ── Simulated per-(client, company) store — the PROPOSED design ───────────────

/**
 * Simulates what the proposed account_intelligence columns would do:
 * ONE row per (client_id, company_id).
 * The second qualification for the same company OVERWRITES the first.
 */
class ProposedSingleRowStore {
  private rows = new Map<string, { qualified: boolean; campaignStrategyId: string; qualificationScore: number }>();

  private key(clientId: string, companyId: string) { return `${clientId}:${companyId}`; }

  // This is what setQualification() would do if qualification were stored on account_intelligence
  upsert(clientId: string, companyId: string, result: AccountQualificationResult): void {
    this.rows.set(this.key(clientId, companyId), {
      qualified:           result.qualified,
      campaignStrategyId:  result.campaignStrategyId,
      qualificationScore:  result.qualificationScore,
    });
  }

  // This is what getAccountIntelligenceMap() would return
  get(clientId: string, companyId: string) {
    return this.rows.get(this.key(clientId, companyId)) ?? null;
  }
}

// ── Simulated per-(client, company, campaign_strategy) store — CORRECT design ─

/**
 * Simulates the CORRECT architecture: one row per (client, company, campaign_strategy).
 * Follows the contact_campaign_relevance pattern (migration 0018).
 */
class CorrectPerStrategyStore {
  private rows = new Map<string, AccountQualificationResult>();

  private key(clientId: string, companyId: string, strategyId: string) {
    return `${clientId}:${companyId}:${strategyId}`;
  }

  upsert(clientId: string, companyId: string, result: AccountQualificationResult): void {
    this.rows.set(this.key(clientId, companyId, result.campaignStrategyId), result);
  }

  getForStrategy(clientId: string, companyId: string, strategyId: string): AccountQualificationResult | null {
    return this.rows.get(this.key(clientId, companyId, strategyId)) ?? null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// T1-T4: CONFLICTING QUALIFICATION — SAME COMPANY, TWO STRATEGIES
// ══════════════════════════════════════════════════════════════════════════════

describe("conflicting qualification — same company, two strategies", () => {

  it("T1: the same UK company qualifies for the UK-targeting strategy", () => {
    const result = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    assert.equal(result.qualified, true, "UK agency should qualify for UK founders campaign");
    assert.equal(result.geographyVerdict, "PASS");
    assert.equal(result.industryVerdict, "PASS");
    assert.equal(result.campaignStrategyId, STRATEGY_1);
  });

  it("T2: the SAME UK company does NOT qualify for the US enterprise strategy", () => {
    const result = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);
    assert.equal(result.qualified, false, "UK agency should NOT qualify for US enterprise campaign");
    assert.equal(result.geographyVerdict, "FAIL", "UK country is excluded by US geography rule");
    assert.equal(result.qualificationScore, 0, "Geography FAIL zeroes the score");
    assert.equal(result.campaignStrategyId, STRATEGY_2);
  });

  it("T3: the two results have different qualified booleans for the same company — conflict is concrete", () => {
    const r1 = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const r2 = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    assert.notEqual(r1.qualified, r2.qualified,
      "The same company produces conflicting qualified booleans across two strategies. " +
      "Storing a single is_qualified boolean per (client, company) means the last writer wins — " +
      "the other strategy reads incorrect data.");
  });

  it("T4: the campaignStrategyId in the result makes it CAMPAIGN-SPECIFIC by design", () => {
    const r1 = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const r2 = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    assert.equal(r1.campaignStrategyId, STRATEGY_1,
      "Qualification result for S1 names S1 — it is NOT a global fact about the company");
    assert.equal(r2.campaignStrategyId, STRATEGY_2,
      "Qualification result for S2 names S2 — it is NOT a global fact about the company");

    // This proves the result is campaign-specific. The persistence must be too.
    assert.notEqual(r1.campaignStrategyId, r2.campaignStrategyId);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T5-T6: OVERWRITE SIMULATION — PROPOSED PER-(CLIENT, COMPANY) DESIGN
// ══════════════════════════════════════════════════════════════════════════════

describe("overwrite simulation — proposed per-(client, company) store loses data", () => {

  it("T5: S1 qualification written, then S2 qualification OVERWRITES it — last writer wins", () => {
    const store = new ProposedSingleRowStore();

    const r1 = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const r2 = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    // Stage 29 batch for S1 runs first
    store.upsert(CLIENT_ID, COMPANY_ID, r1);
    const afterS1 = store.get(CLIENT_ID, COMPANY_ID);
    assert.equal(afterS1?.qualified, true, "After S1 batch: is_qualified=true (correct for S1)");
    assert.equal(afterS1?.campaignStrategyId, STRATEGY_1);

    // Stage 29 batch for S2 runs second (same client, same company, different strategy)
    store.upsert(CLIENT_ID, COMPANY_ID, r2);
    const afterS2 = store.get(CLIENT_ID, COMPANY_ID);
    assert.equal(afterS2?.qualified, false, "After S2 batch: is_qualified=false (overwrote S1)");
    assert.equal(afterS2?.campaignStrategyId, STRATEGY_2,
      "The stored campaignStrategyId has silently changed from S1 to S2");

    // THE BUG: Stage 25 evaluating S1 would now read is_qualified=false — WRONG
    // (S1's correct answer is is_qualified=true, but S2 clobbered it)
    const storedForCompany = store.get(CLIENT_ID, COMPANY_ID);
    const isCorrectForS1 = storedForCompany?.campaignStrategyId === STRATEGY_1;
    assert.equal(isCorrectForS1, false,
      "Stage 25 evaluating S1 cannot trust the stored is_qualified because it reflects S2");
  });

  it("T6: S2 overwrites S1, then re-running S1 restores it — but S2 is now lost", () => {
    const store = new ProposedSingleRowStore();

    const r1 = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const r2 = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    store.upsert(CLIENT_ID, COMPANY_ID, r1);
    store.upsert(CLIENT_ID, COMPANY_ID, r2);
    store.upsert(CLIENT_ID, COMPANY_ID, r1);  // re-run S1 batch

    const stored = store.get(CLIENT_ID, COMPANY_ID);
    assert.equal(stored?.campaignStrategyId, STRATEGY_1, "S1 re-run restored S1 result");

    // But now S2's qualification is lost — a concurrent S2 evaluation would be wrong again.
    // With two concurrent campaigns, there is NO stable state for a single-row store.
    // Each write for one strategy corrupts the other strategy's qualification.
    const s2StillPresent = stored?.campaignStrategyId === STRATEGY_2;
    assert.equal(s2StillPresent, false,
      "S2 qualification was silently lost when S1 batch ran again — " +
      "there is no stable state for a single-row store with multiple strategies");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T7-T8: CORRECT DESIGN — PER-(CLIENT, COMPANY, STRATEGY) KEY PRESERVES BOTH
// ══════════════════════════════════════════════════════════════════════════════

describe("correct design — per-(client, company, strategy) store preserves independent results", () => {

  it("T7: S1 and S2 qualifications coexist — each strategy reads its own correct result", () => {
    const store = new CorrectPerStrategyStore();

    const r1 = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const r2 = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    store.upsert(CLIENT_ID, COMPANY_ID, r1);
    store.upsert(CLIENT_ID, COMPANY_ID, r2);

    const forS1 = store.getForStrategy(CLIENT_ID, COMPANY_ID, STRATEGY_1);
    const forS2 = store.getForStrategy(CLIENT_ID, COMPANY_ID, STRATEGY_2);

    assert.ok(forS1, "S1 qualification is still present after S2 was written");
    assert.ok(forS2, "S2 qualification is still present");

    assert.equal(forS1?.qualified, true,  "S1 correctly reads qualified=true for UK agency");
    assert.equal(forS2?.qualified, false, "S2 correctly reads qualified=false for UK agency");

    // The two results coexist without clobbering each other
    assert.notEqual(forS1?.qualified, forS2?.qualified,
      "Both correct values are preserved — the compound key prevents overwrites");
  });

  it("T8: running S2 batch N times does NOT corrupt S1 qualification", () => {
    const store = new CorrectPerStrategyStore();
    const r1 = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const r2 = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    store.upsert(CLIENT_ID, COMPANY_ID, r1);

    // S2 batch runs 3 times (e.g., retries, reruns)
    store.upsert(CLIENT_ID, COMPANY_ID, r2);
    store.upsert(CLIENT_ID, COMPANY_ID, r2);
    store.upsert(CLIENT_ID, COMPANY_ID, r2);

    const forS1 = store.getForStrategy(CLIENT_ID, COMPANY_ID, STRATEGY_1);
    assert.ok(forS1, "S1 qualification survived 3 S2 upserts");
    assert.equal(forS1?.qualified, true,
      "S1 qualification is unchanged — per-strategy key provides mutual isolation");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T9-T10: STAGE 25 INTEGRATION RISK
// ══════════════════════════════════════════════════════════════════════════════

describe("Stage 25 integration risk — wrong is_qualified feeds wrong CB check", () => {

  it("T9: Stage 25 evaluating S1 must read S1 qualification, not S2", () => {
    // This test demonstrates the QUERY requirement that is impossible to satisfy
    // with the proposed per-(client, company) design.
    //
    // Stage 25 calls:
    //   evaluateOutreachReadiness(clientId, campaignId)
    // → resolves campaignStrategyId from campaign.campaignStrategyId (= S1)
    // → calls getAccountIntelligenceMap(clientId, companyIds)
    //   → SELECT * FROM account_intelligence WHERE client_id=? AND company_id IN (?)
    //   → returns ONE row per (client, company) — no strategy filter possible
    //
    // If the row was last written by S2 qualification, Stage 25 reads S2's is_qualified.

    const s1Result = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const s2Result = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    // Proposed design: last-writer store
    const proposedStore = new ProposedSingleRowStore();
    proposedStore.upsert(CLIENT_ID, COMPANY_ID, s1Result);
    proposedStore.upsert(CLIENT_ID, COMPANY_ID, s2Result);  // S2 runs after S1

    // Stage 25 evaluating S1 fetches the account_intelligence row
    const fetchedRow = proposedStore.get(CLIENT_ID, COMPANY_ID);

    // The proposed CB-qualified check would be:
    //   if (acctIntel?.isQualified === false) → block with CB-new code
    // But fetchedRow.qualified = false (S2's answer) not true (S1's correct answer)
    const wouldStage25BlockForS1 = fetchedRow?.qualified === false;

    assert.equal(wouldStage25BlockForS1, true,
      "CONFIRMED BUG: Stage 25 evaluating S1 reads is_qualified=false (from S2) " +
      "and would incorrectly block all contacts at Bright Studio Ltd for the S1 campaign. " +
      "The company genuinely qualifies for S1 but the wrong stored value causes a false block.");
  });

  it("T10: correct design — Stage 25 queries by strategy and reads the right value", () => {
    const s1Result = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const s2Result = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    // Correct design: per-strategy store
    const correctStore = new CorrectPerStrategyStore();
    correctStore.upsert(CLIENT_ID, COMPANY_ID, s1Result);
    correctStore.upsert(CLIENT_ID, COMPANY_ID, s2Result);

    // Stage 25 evaluating S1 fetches qualification for (client, company, strategy_1)
    const s1Row = correctStore.getForStrategy(CLIENT_ID, COMPANY_ID, STRATEGY_1);
    assert.equal(s1Row?.qualified, true,
      "Correct design: Stage 25 evaluating S1 reads is_qualified=true for Bright Studio Ltd");

    // Stage 25 evaluating S2 fetches qualification for (client, company, strategy_2)
    const s2Row = correctStore.getForStrategy(CLIENT_ID, COMPANY_ID, STRATEGY_2);
    assert.equal(s2Row?.qualified, false,
      "Correct design: Stage 25 evaluating S2 reads is_qualified=false for Bright Studio Ltd");

    // Each campaign reads its own correct value — no interference
    assert.notEqual(s1Row?.qualified, s2Row?.qualified,
      "Both campaigns read the right value for their own strategy");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T11-T13: WHY NOW CONTRAST — IS_READY IS CORRECTLY CAMPAIGN-AGNOSTIC
// ══════════════════════════════════════════════════════════════════════════════

describe("Why Now contrast — is_ready is campaign-agnostic, is_qualified is not", () => {

  it("T11: is_ready answers a campaign-agnostic question — signals exist or they don't", () => {
    // is_ready = true means "there are active buying signals right now"
    // This fact does not change based on which campaign is evaluating the account.
    // A funding round is a funding round regardless of whether S1 or S2 is the evaluator.
    // Therefore storing is_ready per (client, company) is CORRECT.

    // No assert needed — this is a reasoning test captured in comments.
    // The point: is_ready and is_qualified are semantically different,
    // so they require different storage keys.
    assert.ok(true, "is_ready is campaign-agnostic: ONE value per (client, company) is correct");
  });

  it("T12: is_qualified answers a campaign-specific question — ICP fit for THIS strategy", () => {
    // is_qualified = true means "this company fits the ICP defined in THIS campaign strategy"
    // This fact CHANGES based on which campaign strategy is the evaluator.
    // The same company can qualify for one strategy (UK founders) but not another (US enterprise).
    // Therefore storing is_qualified per (client, company) is WRONG for multi-campaign clients.

    const r1 = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const r2 = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    // The result proves the answer changes with the strategy
    assert.notEqual(r1.qualified, r2.qualified,
      "is_qualified changes with strategy — it is NOT a global fact about the company");
    assert.notEqual(r1.campaignStrategyId, r2.campaignStrategyId,
      "The result explicitly names the strategy it was computed for");
  });

  it("T13: a company can be is_ready=true AND is_qualified=false simultaneously", () => {
    // Scenario: Company has active signals (is_ready=true) but is in the wrong geography.
    // is_ready and is_qualified are orthogonal — neither implies the other.
    // This is an additional reason why qualification belongs in a separate table
    // and should not be co-located with is_ready on account_intelligence.

    const r = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);
    // UK company against a US-targeting strategy: geography FAIL → qualified=false
    assert.equal(r.qualified, false);
    assert.equal(r.geographyVerdict, "FAIL");

    // Conceptually: this same company could have is_ready=true (has active signals)
    // while is_qualified=false for S2. The two facts are independent.
    assert.ok(true, "is_ready and is_qualified are orthogonal — separate concerns");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T14-T16: IDEMPOTENCY — PER-(CLIENT, COMPANY, STRATEGY) KEY
// ══════════════════════════════════════════════════════════════════════════════

describe("idempotency — per-(client, company, strategy) key enables safe re-runs", () => {

  it("T14: running S1 qualification twice produces identical results (pure function)", () => {
    const input = makeInput(STRATEGY_1, STRATEGY_1_ICP);
    const r1    = computeAccountQualification(input, FIXED_NOW);
    const r2    = computeAccountQualification(input, FIXED_NOW);

    assert.equal(r1.qualified,          r2.qualified);
    assert.equal(r1.qualificationScore, r2.qualificationScore);
    assert.equal(r1.campaignStrategyId, r2.campaignStrategyId);
    assert.deepEqual(r1.exclusionReasons, r2.exclusionReasons);
  });

  it("T15: per-(client, company, strategy) upsert is idempotent — same inputs, same stored row", () => {
    const store = new CorrectPerStrategyStore();
    const input = makeInput(STRATEGY_1, STRATEGY_1_ICP);

    // Run and upsert 3 times — should not create duplicate rows
    for (let i = 0; i < 3; i++) {
      store.upsert(CLIENT_ID, COMPANY_ID, computeAccountQualification(input, FIXED_NOW));
    }

    const stored = store.getForStrategy(CLIENT_ID, COMPANY_ID, STRATEGY_1);
    assert.ok(stored, "Exactly one result stored despite 3 upserts");
    assert.equal(stored?.qualified, true);
    assert.equal(stored?.campaignStrategyId, STRATEGY_1,
      "The UNIQUE(client, company, strategy) constraint ensures only one row exists per triple");
  });

  it("T16: the UNIQUE key for idempotency must be (client, company, strategy) — not (client, company)", () => {
    const proposedStore = new ProposedSingleRowStore();
    const correctStore  = new CorrectPerStrategyStore();

    const r1 = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);
    const r2 = computeAccountQualification(makeInput(STRATEGY_2, STRATEGY_2_ICP), FIXED_NOW);

    proposedStore.upsert(CLIENT_ID, COMPANY_ID, r1);
    proposedStore.upsert(CLIENT_ID, COMPANY_ID, r2);
    // Proposed: only 1 row — last writer wins, previous result gone
    const proposedCount = proposedStore.get(CLIENT_ID, COMPANY_ID) ? 1 : 0;
    assert.equal(proposedCount, 1, "Proposed design: only 1 row stored, S1 qualification lost");

    correctStore.upsert(CLIENT_ID, COMPANY_ID, r1);
    correctStore.upsert(CLIENT_ID, COMPANY_ID, r2);
    // Correct: 2 rows — one per strategy, both preserved
    const s1 = correctStore.getForStrategy(CLIENT_ID, COMPANY_ID, STRATEGY_1);
    const s2 = correctStore.getForStrategy(CLIENT_ID, COMPANY_ID, STRATEGY_2);
    assert.ok(s1, "Correct design: S1 row exists");
    assert.ok(s2, "Correct design: S2 row exists");
    assert.notEqual(s1?.qualified, s2?.qualified,
      "Both results are preserved with correct independent values");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// T17-T18: CLIENT ISOLATION
// ══════════════════════════════════════════════════════════════════════════════

describe("client isolation — multi-tenant qualification correctness", () => {

  it("T17: two different clients can have different qualifications for the same company", () => {
    // Same company ID, same strategy ID, different clients → potentially different ICPs
    const clientAInput: AccountQualificationInput = {
      ...makeInput(STRATEGY_1, STRATEGY_1_ICP),
      clientId: CLIENT_ID,
    };
    const clientBInput: AccountQualificationInput = {
      ...makeInput(STRATEGY_1, STRATEGY_2_ICP),  // Client B uses a US-targeting ICP
      clientId: OTHER_CLIENT,
    };

    const rA = computeAccountQualification(clientAInput, FIXED_NOW);
    const rB = computeAccountQualification(clientBInput, FIXED_NOW);

    assert.equal(rA.qualified, true,  "Client A (UK ICP) qualifies UK agency");
    assert.equal(rB.qualified, false, "Client B (US ICP) does not qualify UK agency");

    // Per-(client, company, strategy) table enforces this isolation automatically —
    // CLIENT_ID and OTHER_CLIENT are different keys, no interference possible
    const store = new CorrectPerStrategyStore();
    store.upsert(CLIENT_ID,    COMPANY_ID, rA);
    store.upsert(OTHER_CLIENT, COMPANY_ID, rB);

    assert.equal(store.getForStrategy(CLIENT_ID,    COMPANY_ID, STRATEGY_1)?.qualified, true);
    assert.equal(store.getForStrategy(OTHER_CLIENT, COMPANY_ID, STRATEGY_1)?.qualified, false);
  });

  it("T18: the per-(client, company, strategy) key includes clientId — cross-client reads are impossible", () => {
    const store = new CorrectPerStrategyStore();
    const result = computeAccountQualification(makeInput(STRATEGY_1, STRATEGY_1_ICP), FIXED_NOW);

    store.upsert(CLIENT_ID, COMPANY_ID, result);

    // OTHER_CLIENT cannot read CLIENT_ID's qualification for the same company
    const crossClientRead = store.getForStrategy(OTHER_CLIENT, COMPANY_ID, STRATEGY_1);
    assert.equal(crossClientRead, null,
      "Client isolation: OTHER_CLIENT cannot see CLIENT_ID's qualification record");
  });
});
