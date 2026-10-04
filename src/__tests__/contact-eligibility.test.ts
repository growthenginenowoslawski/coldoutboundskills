/**
 * Unit tests for Stage 17 contact eligibility evaluator.
 *
 * All tests are pure — no network, no Supabase, no real data.
 * Each gate is tested in isolation, then the orchestrated evaluators are tested.
 *
 * Run: node --import tsx --test "src/__tests__/contact-eligibility.test.ts"
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  EMAIL_VERIFICATION_STALENESS_DAYS,
  evaluateAccountGate,
  evaluateContactGate,
  evaluateEmailGate,
  evaluateSuppressionGate,
  evaluateCampaignGate,
  evaluateContactEligibility,
  evaluateCampaignEligibility,
} from "../lib/contact-eligibility.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMPANY_ID  = "company-aaa";
const CLIENT_ID   = "client-bbb";
const CONTACT_ID  = "contact-ccc";
const CAMPAIGN_ID = "campaign-ddd";

const NOW = new Date("2026-09-04T12:00:00Z");

// A contact that passes the contact gate
const CONTACT_OK = {
  companyId:   COMPANY_ID,
  email:       "sarah@example.com",
  emailStatus: null as string | null,
};

// Account intelligence with a positive score
const ACCOUNT_OK = { opportunityScore: 42 };

// Email verification: valid and fresh
const VERIFY_OK = {
  id:         "v1",
  contactId:  CONTACT_ID,
  email:      "sarah@example.com",
  isValid:    true  as boolean | null,
  result:     "ok" as string | null,
  verifiedAt: "2026-08-01T00:00:00Z" as string | null, // ~34 days before NOW — fresh
  createdAt:  "2026-08-01T00:00:00Z",
};

// Campaign: draft, client matches
const CAMPAIGN_OK = { clientId: CLIENT_ID, status: "draft" as const };

function daysAgoIso(days: number, from = NOW): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ── Gate 1: Account ───────────────────────────────────────────────────────────

describe("evaluateAccountGate", () => {
  test("passes when opportunityScore > 0", () => {
    const r = evaluateAccountGate({ opportunityScore: 1 });
    assert.equal(r.eligible, true);
    assert.equal(r.reason, null);
    assert.equal(r.gate, null);
  });

  test("passes when opportunityScore = 100", () => {
    assert.equal(evaluateAccountGate({ opportunityScore: 100 }).eligible, true);
  });

  test("blocks with NO_ACCOUNT_INTELLIGENCE when null", () => {
    const r = evaluateAccountGate(null);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "NO_ACCOUNT_INTELLIGENCE");
    assert.equal(r.gate, "account");
    assert.ok(r.detail.length > 0);
  });

  test("blocks with ACCOUNT_SCORE_ZERO when score = 0", () => {
    const r = evaluateAccountGate({ opportunityScore: 0 });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "ACCOUNT_SCORE_ZERO");
    assert.equal(r.gate, "account");
  });
});

// ── Gate 2: Contact ───────────────────────────────────────────────────────────

describe("evaluateContactGate", () => {
  test("passes when contact has email and correct companyId", () => {
    const r = evaluateContactGate(CONTACT_OK, COMPANY_ID);
    assert.equal(r.eligible, true);
  });

  test("blocks with CONTACT_NOT_FOUND when contact is null", () => {
    const r = evaluateContactGate(null, COMPANY_ID);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CONTACT_NOT_FOUND");
    assert.equal(r.gate, "contact");
  });

  test("blocks with NO_EMAIL when email is null", () => {
    const r = evaluateContactGate({ ...CONTACT_OK, email: null }, COMPANY_ID);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "NO_EMAIL");
  });

  test("blocks with NO_EMAIL when email is empty string", () => {
    const r = evaluateContactGate({ ...CONTACT_OK, email: "" }, COMPANY_ID);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "NO_EMAIL");
  });

  test("blocks with NO_EMAIL when email is whitespace-only", () => {
    const r = evaluateContactGate({ ...CONTACT_OK, email: "   " }, COMPANY_ID);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "NO_EMAIL");
  });

  test("blocks with CONTACT_COMPANY_MISMATCH when companyId differs", () => {
    const r = evaluateContactGate({ ...CONTACT_OK, companyId: "different-company" }, COMPANY_ID);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CONTACT_COMPANY_MISMATCH");
    assert.equal(r.gate, "contact");
  });

  test("CONTACT_COMPANY_MISMATCH detail includes both IDs", () => {
    const r = evaluateContactGate({ ...CONTACT_OK, companyId: "other" }, COMPANY_ID);
    assert.ok(r.detail.includes("other"));
    assert.ok(r.detail.includes(COMPANY_ID));
  });
});

// ── Gate 3: Email verification ────────────────────────────────────────────────

describe("evaluateEmailGate", () => {
  // ── No verification row ──────────────────────────────────────────────────────

  test("passes via Prospeo soft-pass when no row and emailStatus=VERIFIED", () => {
    const r = evaluateEmailGate({ emailStatus: "VERIFIED" }, null, NOW);
    assert.equal(r.eligible, true);
  });

  test("blocks EMAIL_NOT_VERIFIED when no row and emailStatus=null", () => {
    const r = evaluateEmailGate({ emailStatus: null }, null, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_NOT_VERIFIED");
    assert.equal(r.gate, "email");
  });

  test("blocks EMAIL_NOT_VERIFIED when no row and emailStatus=INVALID", () => {
    const r = evaluateEmailGate({ emailStatus: "INVALID" }, null, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_NOT_VERIFIED");
  });

  // ── Row exists: isValid = false ──────────────────────────────────────────────

  test("blocks EMAIL_INVALID when isValid=false (hard block)", () => {
    const r = evaluateEmailGate(
      { emailStatus: "VERIFIED" }, // emailStatus should NOT override a hard invalid
      { ...VERIFY_OK, isValid: false },
      NOW,
    );
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_INVALID");
    assert.equal(r.gate, "email");
  });

  test("EMAIL_INVALID detail includes provider result when available", () => {
    const r = evaluateEmailGate(
      { emailStatus: null },
      { ...VERIFY_OK, isValid: false, result: "role_address" },
      NOW,
    );
    assert.ok(r.detail.includes("role_address"));
  });

  // ── Row exists: isValid = true ───────────────────────────────────────────────

  test("passes when isValid=true and verification is fresh", () => {
    const r = evaluateEmailGate({ emailStatus: null }, VERIFY_OK, NOW);
    assert.equal(r.eligible, true);
  });

  test("blocks EMAIL_VERIFICATION_STALE when verifiedAt is older than threshold", () => {
    const staleRow = {
      ...VERIFY_OK,
      verifiedAt: daysAgoIso(EMAIL_VERIFICATION_STALENESS_DAYS + 1),
    };
    const r = evaluateEmailGate({ emailStatus: null }, staleRow, NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_VERIFICATION_STALE");
    assert.equal(r.gate, "email");
  });

  test("passes when verifiedAt is exactly at the staleness boundary", () => {
    // exactly STALENESS_DAYS ago (not yet stale — must be strictly greater)
    const boundaryRow = {
      ...VERIFY_OK,
      verifiedAt: daysAgoIso(EMAIL_VERIFICATION_STALENESS_DAYS),
    };
    const r = evaluateEmailGate({ emailStatus: null }, boundaryRow, NOW);
    assert.equal(r.eligible, true);
  });

  test("passes when isValid=true but verifiedAt=null (no staleness data)", () => {
    const r = evaluateEmailGate(
      { emailStatus: null },
      { ...VERIFY_OK, verifiedAt: null },
      NOW,
    );
    assert.equal(r.eligible, true);
  });

  // ── Row exists: isValid = null ───────────────────────────────────────────────

  test("passes via Prospeo soft-pass when isValid=null and emailStatus=VERIFIED", () => {
    const r = evaluateEmailGate(
      { emailStatus: "VERIFIED" },
      { ...VERIFY_OK, isValid: null },
      NOW,
    );
    assert.equal(r.eligible, true);
  });

  test("blocks EMAIL_NOT_VERIFIED when isValid=null and emailStatus=null", () => {
    const r = evaluateEmailGate(
      { emailStatus: null },
      { ...VERIFY_OK, isValid: null },
      NOW,
    );
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_NOT_VERIFIED");
  });
});

// ── Gate 4: Suppression ───────────────────────────────────────────────────────

describe("evaluateSuppressionGate", () => {
  test("passes when suppressionRecords is empty", () => {
    const r = evaluateSuppressionGate([], NOW);
    assert.equal(r.eligible, true);
  });

  test("blocks CONTACT_SUPPRESSED for permanent suppression (expiresAt=null)", () => {
    const r = evaluateSuppressionGate([{ expiresAt: null }], NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CONTACT_SUPPRESSED");
    assert.equal(r.gate, "suppression");
  });

  test("blocks CONTACT_SUPPRESSED for active timed suppression", () => {
    const futureExpiry = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const r = evaluateSuppressionGate([{ expiresAt: futureExpiry }], NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CONTACT_SUPPRESSED");
  });

  test("passes when suppression has expired", () => {
    const pastExpiry = new Date(NOW.getTime() - 1000).toISOString();
    const r = evaluateSuppressionGate([{ expiresAt: pastExpiry }], NOW);
    assert.equal(r.eligible, true);
  });

  test("blocks when mix of expired + active suppressions (at least one active)", () => {
    const past   = new Date(NOW.getTime() - 1000).toISOString();
    const future = new Date(NOW.getTime() + 1000).toISOString();
    const r = evaluateSuppressionGate([{ expiresAt: past }, { expiresAt: future }], NOW);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CONTACT_SUPPRESSED");
  });

  test("passes when all suppressions have expired", () => {
    const past1 = new Date(NOW.getTime() - 2000).toISOString();
    const past2 = new Date(NOW.getTime() - 1000).toISOString();
    const r = evaluateSuppressionGate([{ expiresAt: past1 }, { expiresAt: past2 }], NOW);
    assert.equal(r.eligible, true);
  });
});

// ── Gate 5: Campaign ──────────────────────────────────────────────────────────

describe("evaluateCampaignGate", () => {
  test("passes when campaign is draft and not yet enrolled", () => {
    const r = evaluateCampaignGate(CAMPAIGN_OK, CLIENT_ID, false);
    assert.equal(r.eligible, true);
  });

  test("passes when campaign is running and not yet enrolled", () => {
    const r = evaluateCampaignGate({ ...CAMPAIGN_OK, status: "running" }, CLIENT_ID, false);
    assert.equal(r.eligible, true);
  });

  test("blocks CAMPAIGN_NOT_FOUND when campaign is null", () => {
    const r = evaluateCampaignGate(null, CLIENT_ID, false);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_FOUND");
    assert.equal(r.gate, "campaign");
  });

  test("blocks CAMPAIGN_CLIENT_MISMATCH when clientId differs", () => {
    const r = evaluateCampaignGate({ ...CAMPAIGN_OK, clientId: "other-client" }, CLIENT_ID, false);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_CLIENT_MISMATCH");
    assert.equal(r.gate, "campaign");
  });

  test("blocks CAMPAIGN_NOT_ACTIVE when status=paused", () => {
    const r = evaluateCampaignGate({ ...CAMPAIGN_OK, status: "paused" }, CLIENT_ID, false);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("blocks CAMPAIGN_NOT_ACTIVE when status=completed", () => {
    const r = evaluateCampaignGate({ ...CAMPAIGN_OK, status: "completed" }, CLIENT_ID, false);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("blocks CAMPAIGN_NOT_ACTIVE when status=cancelled", () => {
    const r = evaluateCampaignGate({ ...CAMPAIGN_OK, status: "cancelled" }, CLIENT_ID, false);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("blocks ALREADY_ENROLLED when existingEnrollment=true", () => {
    const r = evaluateCampaignGate(CAMPAIGN_OK, CLIENT_ID, true);
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "ALREADY_ENROLLED");
    assert.equal(r.gate, "campaign");
  });

  test("CAMPAIGN_CLIENT_MISMATCH checked before ALREADY_ENROLLED", () => {
    // Even if contact is enrolled, wrong client is caught first
    const r = evaluateCampaignGate({ ...CAMPAIGN_OK, clientId: "wrong" }, CLIENT_ID, true);
    assert.equal(r.reason, "CAMPAIGN_CLIENT_MISMATCH");
  });
});

// ── Orchestrated: evaluateContactEligibility ──────────────────────────────────

describe("evaluateContactEligibility", () => {
  const base = {
    accountIntelligence: ACCOUNT_OK,
    contact:             CONTACT_OK,
    companyId:           COMPANY_ID,
    emailVerification:   VERIFY_OK as typeof VERIFY_OK | null,
    suppressionRecords:  [] as { expiresAt: string | null }[],
    now:                 NOW,
  };

  test("eligible when all four gates pass", () => {
    const r = evaluateContactEligibility(base);
    assert.equal(r.eligible, true);
  });

  test("stops at account gate when account intelligence is missing", () => {
    const r = evaluateContactEligibility({ ...base, accountIntelligence: null });
    assert.equal(r.gate, "account");
    assert.equal(r.reason, "NO_ACCOUNT_INTELLIGENCE");
  });

  test("stops at account gate when score is zero (does not proceed to contact gate)", () => {
    const r = evaluateContactEligibility({
      ...base,
      accountIntelligence: { opportunityScore: 0 },
      contact:             null, // would fail contact gate, but account gate fires first
    });
    assert.equal(r.gate, "account");
    assert.equal(r.reason, "ACCOUNT_SCORE_ZERO");
  });

  test("stops at contact gate when contact is missing", () => {
    const r = evaluateContactEligibility({ ...base, contact: null });
    assert.equal(r.gate, "contact");
    assert.equal(r.reason, "CONTACT_NOT_FOUND");
  });

  test("stops at email gate when email is not verified", () => {
    const r = evaluateContactEligibility({
      ...base,
      emailVerification: null,
      contact:           { ...CONTACT_OK, emailStatus: null },
    });
    assert.equal(r.gate, "email");
    assert.equal(r.reason, "EMAIL_NOT_VERIFIED");
  });

  test("stops at suppression gate when contact is suppressed", () => {
    const r = evaluateContactEligibility({
      ...base,
      suppressionRecords: [{ expiresAt: null }], // permanent suppression
    });
    assert.equal(r.gate, "suppression");
    assert.equal(r.reason, "CONTACT_SUPPRESSED");
  });
});

// ── Orchestrated: evaluateCampaignEligibility ─────────────────────────────────

describe("evaluateCampaignEligibility", () => {
  const base = {
    accountIntelligence: ACCOUNT_OK,
    contact:             CONTACT_OK,
    companyId:           COMPANY_ID,
    emailVerification:   VERIFY_OK as typeof VERIFY_OK | null,
    suppressionRecords:  [] as { expiresAt: string | null }[],
    campaign:            CAMPAIGN_OK as typeof CAMPAIGN_OK | null,
    clientId:            CLIENT_ID,
    existingEnrollment:  false,
    now:                 NOW,
  };

  test("eligible when all five gates pass", () => {
    const r = evaluateCampaignEligibility(base);
    assert.equal(r.eligible, true);
  });

  test("stops at campaign gate when contact is 4-gate eligible but campaign is paused", () => {
    const r = evaluateCampaignEligibility({
      ...base,
      campaign: { ...CAMPAIGN_OK, status: "paused" },
    });
    assert.equal(r.gate, "campaign");
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("stops at campaign gate when already enrolled", () => {
    const r = evaluateCampaignEligibility({ ...base, existingEnrollment: true });
    assert.equal(r.gate, "campaign");
    assert.equal(r.reason, "ALREADY_ENROLLED");
  });

  test("stops at account gate (before campaign) when account intelligence missing", () => {
    const r = evaluateCampaignEligibility({
      ...base,
      accountIntelligence: null,
      campaign:            null, // campaign would also fail, but account fires first
    });
    assert.equal(r.gate, "account");
    assert.equal(r.reason, "NO_ACCOUNT_INTELLIGENCE");
  });

  test("stops at suppression gate before campaign gate", () => {
    const r = evaluateCampaignEligibility({
      ...base,
      suppressionRecords:  [{ expiresAt: null }],
      campaign:            null, // campaign would fail too
    });
    assert.equal(r.gate, "suppression");
    assert.equal(r.reason, "CONTACT_SUPPRESSED");
  });
});
