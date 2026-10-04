/**
 * Unit tests for Stage 25 campaign readiness evaluation.
 *
 * All tests are pure — no network, no Supabase, no real data.
 * Tests exercise assessReadinessFromData() directly using crafted fixtures.
 *
 * Coverage:
 *   - Email gate truth table (8 cases via evaluateEmailGate)
 *   - CB-09 pre-check (is_ready = false fires before Stage 17 gates)
 *   - Partial-block scenario: ≥1 eligible → OUTREACH_READY_WITH_WARNINGS + W-06
 *   - All-blocked scenario: 0 eligible → HARD_BLOCKED + XB-07
 *   - W-01 approaching-staleness fires at 80 days, not at 50
 *   - W-11 low backfilled count warning
 *   - XB-01 when campaign is null
 *   - XB-03 when no list assigned
 *   - XB-09 when no leads have platform_lead_id
 *   - PII invariant: no email addresses in contactResults or eligibleContactIds
 *   - Security invariant: no credential-shaped strings in assessment output
 *   - canApproveAssessment rejects HARD_BLOCKED assessments
 *   - Idempotency: same inputs → same verdict
 *
 * Run: node --import tsx --test "src/__tests__/campaign-readiness.test.ts"
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  assessReadinessFromData,
} from "../lib/campaign-readiness.js";
import type { ReadinessEvaluationInput } from "../lib/campaign-readiness.js";
import {
  evaluateEmailGate,
  EMAIL_VERIFICATION_STALENESS_DAYS,
} from "../lib/contact-eligibility.js";
import { canApproveAssessment } from "../db/campaign-readiness.js";
import type { CampaignReadinessAssessment } from "../domain/campaign-readiness-types.js";
import type { CampaignRow } from "../db/campaigns.js";
import type { ContactRow } from "../db/contacts.js";
import type { AccountIntelligenceRow } from "../db/account-intelligence.js";
import type { EmailVerificationRow } from "../db/email-verifications.js";
import type { ContactSuppressionRow } from "../db/contact-suppression.js";
import type { CampaignLeadRow } from "../db/campaign-leads.js";
import type { DomainHealthSnapshot } from "../lib/health-snapshots.js";
import type { ContactCampaignRelevanceRow } from "../domain/contact-intelligence-types.js";

// ── Fixture builders ──────────────────────────────────────────────────────────

const CLIENT_ID   = "aaaaaaaa-0000-0000-0000-000000000001";
const CAMPAIGN_ID = "bbbbbbbb-0000-0000-0000-000000000001";
const STRATEGY_ID = "cccccccc-0000-0000-0000-000000000001";
const LIST_ID     = "dddddddd-0000-0000-0000-000000000001";
const COMPANY_ID  = "eeeeeeee-0000-0000-0000-000000000001";

function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id:                 CAMPAIGN_ID,
    clientId:           CLIENT_ID,
    name:               "Test Campaign",
    description:        null,
    platform:           "smartlead",
    platformCampaignId: "12345",
    campaignStrategyId: STRATEGY_ID,
    listId:             LIST_ID,
    status:             "ready",
    dailySendLimit:     null,
    startDate:          null,
    endDate:            null,
    createdAt:          "2026-01-01T00:00:00Z",
    updatedAt:          "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeContact(id: string, overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id,
    companyId:   COMPANY_ID,
    firstName:   null,
    lastName:    null,
    fullName:    null,
    jobTitle:    "VP of Sales",
    linkedinUrl: null,
    email:       null,   // Set in tests; never stored here in a way that leaks to output
    emailStatus: "VERIFIED",
    createdAt:   "2026-01-01T00:00:00Z",
    updatedAt:   "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeAccountIntel(companyId: string, overrides: Partial<AccountIntelligenceRow> = {}): AccountIntelligenceRow {
  return {
    id:                        "acct-" + companyId,
    clientId:                  CLIENT_ID,
    companyId,
    opportunityScore:          75,
    opportunityScoreUpdatedAt: "2026-01-01T00:00:00Z",
    scoreInputs:               null,
    priorityScore:             null,
    prioritizedAt:             null,
    whyNow:                    null,
    isReady:                   true,
    readinessAssessedAt:       "2026-01-01T00:00:00Z",
    createdAt:                 "2026-01-01T00:00:00Z",
    updatedAt:                 "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeEmailVer(contactId: string, overrides: Partial<EmailVerificationRow> = {}): EmailVerificationRow {
  return {
    id:         "ev-" + contactId,
    contactId,
    isValid:    true,
    verifiedAt: "2026-08-01T00:00:00Z",   // recent
    provider:   "millionverifier",
    createdAt:  "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeRelevanceRow(contactId: string, overrides: Partial<ContactCampaignRelevanceRow> = {}): ContactCampaignRelevanceRow {
  return {
    id:                 "rel-" + contactId,
    clientId:           CLIENT_ID,
    companyId:          COMPANY_ID,
    contactId,
    campaignStrategyId: STRATEGY_ID,
    isPersonRelevant:   true,
    isContactReady:     true,
    isPersonQualified:  true,
    relevanceScore:     80,
    relevanceReason:    "STRONG_MATCH",
    relevanceNarrative: null,
    scoringVersion:     "1.0.0",
    assessedAt:         "2026-01-01T00:00:00Z",
    createdAt:          "2026-01-01T00:00:00Z",
    updatedAt:          "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeCampaignLead(contactId: string, overrides: Partial<CampaignLeadRow> = {}): CampaignLeadRow {
  return {
    id:             "lead-" + contactId,
    campaignId:     CAMPAIGN_ID,
    contactId,
    clientId:       CLIENT_ID,
    status:         "uploaded",
    platformLeadId: "plat-" + contactId,
    sentAt:         null,
    repliedAt:      null,
    replyType:      null,
    createdAt:      "2026-01-01T00:00:00Z",
    updatedAt:      "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDomainSnapshot(domain: string, healthyInboxCount = 5): DomainHealthSnapshot {
  return {
    id:                domain + "-snap",
    clientId:          CLIENT_ID,
    provider:          "smartlead",
    domain,
    takenAt:           "2026-09-01T00:00:00Z",
    isBaseline:        false,
    inboxCount:        healthyInboxCount + 1,
    healthyInboxCount,
    blockedInboxCount: 1,
  };
}

/** Build a minimal valid ReadinessEvaluationInput with one eligible contact. */
function makeBaseInput(
  contactId = "contact-001",
  overrides: Partial<ReadinessEvaluationInput> = {},
): ReadinessEvaluationInput {
  const contact = makeContact(contactId, { email: "test@example.com" });
  const acctIntel = makeAccountIntel(COMPANY_ID);
  const emailVer  = makeEmailVer(contactId);
  const lead      = makeCampaignLead(contactId);
  const rel       = makeRelevanceRow(contactId);

  return {
    clientId:            CLIENT_ID,
    campaignId:          CAMPAIGN_ID,
    campaignStrategyId:  STRATEGY_ID,
    campaign:            makeCampaign(),
    providerCredentialed: true,
    contacts:            [contact],
    relevanceRows:       [rel],
    accountIntelMap:     new Map([[COMPANY_ID, acctIntel]]),
    emailVerMap:         new Map([[contactId, emailVer]]),
    suppressionMap:      new Map(),
    campaignLeadsMap:    new Map([[contactId, lead]]),
    domainSnapshots:     [makeDomainSnapshot("sending.example.com")],
    now:                 new Date("2026-09-09T00:00:00Z"),
    ...overrides,
  };
}

// ── Email gate truth table ────────────────────────────────────────────────────

describe("evaluateEmailGate truth table", () => {
  const NOW = new Date("2026-09-09T00:00:00Z");
  const STALE_DATE = new Date(NOW.getTime() - (EMAIL_VERIFICATION_STALENESS_DAYS + 1) * 86_400_000);
  const RECENT_DATE = new Date(NOW.getTime() - 30 * 86_400_000);

  test("isValid=false → EMAIL_INVALID (hard block)", () => {
    const result = evaluateEmailGate(
      { emailStatus: "VERIFIED" },
      { id: "ev1", contactId: "c1", isValid: false, verifiedAt: RECENT_DATE.toISOString(), provider: "mv", createdAt: "" },
      NOW,
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "EMAIL_INVALID");
  });

  test("isValid=true, recent verifiedAt → PASS", () => {
    const result = evaluateEmailGate(
      { emailStatus: "VERIFIED" },
      { id: "ev2", contactId: "c2", isValid: true, verifiedAt: RECENT_DATE.toISOString(), provider: "mv", createdAt: "" },
      NOW,
    );
    assert.equal(result.eligible, true);
  });

  test("isValid=true, stale verifiedAt (>90d) → EMAIL_VERIFICATION_STALE (hard block)", () => {
    const result = evaluateEmailGate(
      { emailStatus: "VERIFIED" },
      { id: "ev3", contactId: "c3", isValid: true, verifiedAt: STALE_DATE.toISOString(), provider: "mv", createdAt: "" },
      NOW,
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "EMAIL_VERIFICATION_STALE");
  });

  test("isValid=true, verifiedAt=null → PASS (benefit of the doubt, not stale)", () => {
    const result = evaluateEmailGate(
      { emailStatus: "VERIFIED" },
      { id: "ev4", contactId: "c4", isValid: true, verifiedAt: null, provider: "mv", createdAt: "" },
      NOW,
    );
    assert.equal(result.eligible, true, "null verifiedAt must not be treated as stale");
  });

  test("isValid=null, emailStatus='VERIFIED' → PASS (Prospeo soft-pass)", () => {
    const result = evaluateEmailGate(
      { emailStatus: "VERIFIED" },
      { id: "ev5", contactId: "c5", isValid: null, verifiedAt: null, provider: "mv", createdAt: "" },
      NOW,
    );
    assert.equal(result.eligible, true);
  });

  test("isValid=null, emailStatus=null → EMAIL_NOT_VERIFIED (hard block)", () => {
    const result = evaluateEmailGate(
      { emailStatus: null },
      { id: "ev6", contactId: "c6", isValid: null, verifiedAt: null, provider: "mv", createdAt: "" },
      NOW,
    );
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "EMAIL_NOT_VERIFIED");
  });

  test("no email_verifications row, emailStatus='VERIFIED' → PASS", () => {
    const result = evaluateEmailGate({ emailStatus: "VERIFIED" }, null, NOW);
    assert.equal(result.eligible, true);
  });

  test("no email_verifications row, emailStatus=null → EMAIL_NOT_VERIFIED (hard block)", () => {
    const result = evaluateEmailGate({ emailStatus: null }, null, NOW);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "EMAIL_NOT_VERIFIED");
  });
});

// ── XB-01: no campaign ────────────────────────────────────────────────────────

describe("XB-01: campaign not found", () => {
  test("null campaign → HARD_BLOCKED with XB-01", () => {
    const input = makeBaseInput("c1", { campaign: null });
    const result = assessReadinessFromData(input);
    assert.equal(result.verdict, "HARD_BLOCKED");
    assert.ok(result.hardBlocks.some(b => b.code === "XB-01"), "XB-01 must be present");
  });
});

// ── XB-03: no list ────────────────────────────────────────────────────────────

describe("XB-03: no list assigned", () => {
  test("campaign.listId=null → HARD_BLOCKED with XB-03", () => {
    const input = makeBaseInput("c1", {
      campaign: makeCampaign({ listId: null }),
      contacts: [],
    });
    const result = assessReadinessFromData(input);
    assert.equal(result.verdict, "HARD_BLOCKED");
    assert.ok(result.hardBlocks.some(b => b.code === "XB-03"), "XB-03 must be present");
  });
});

// ── CB-09 pre-check ───────────────────────────────────────────────────────────

describe("CB-09: account intelligence not ready", () => {
  test("is_ready=false → CONTACT_BLOCKED with CB-09 (before Stage 17 gates run)", () => {
    const contactId = "contact-cb09";
    const contact   = makeContact(contactId, { email: "cb09@example.com" });
    const acctIntel = makeAccountIntel(COMPANY_ID, { isReady: false });
    const emailVer  = makeEmailVer(contactId);
    const rel       = makeRelevanceRow(contactId);
    const lead      = makeCampaignLead(contactId, { platformLeadId: "p1" });

    const input = makeBaseInput(contactId, {
      contacts:         [contact],
      relevanceRows:    [rel],
      accountIntelMap:  new Map([[COMPANY_ID, acctIntel]]),
      emailVerMap:      new Map([[contactId, emailVer]]),
      campaignLeadsMap: new Map([[contactId, lead]]),
    });
    const result = assessReadinessFromData(input);

    const cr = result.contactResults[0];
    assert.ok(cr, "must have a contact result");
    assert.equal(cr.verdict, "CONTACT_BLOCKED");
    assert.equal(cr.blockCode, "CB-09");
    assert.equal(cr.eligibilityReason, null, "CB-09 bypasses Stage 17 — no eligibilityReason");
  });

  test("is_ready=null → NOT blocked (W-02 warning only, Stage 17 gates run)", () => {
    const contactId = "contact-isnull";
    const contact   = makeContact(contactId, { email: "null@example.com" });
    const acctIntel = makeAccountIntel(COMPANY_ID, { isReady: null, readinessAssessedAt: null });
    const emailVer  = makeEmailVer(contactId);
    const rel       = makeRelevanceRow(contactId);
    const lead      = makeCampaignLead(contactId, { platformLeadId: "p2" });

    const input = makeBaseInput(contactId, {
      contacts:         [contact],
      relevanceRows:    [rel],
      accountIntelMap:  new Map([[COMPANY_ID, acctIntel]]),
      emailVerMap:      new Map([[contactId, emailVer]]),
      campaignLeadsMap: new Map([[contactId, lead]]),
    });
    const result = assessReadinessFromData(input);

    const cr = result.contactResults[0];
    assert.ok(cr, "must have a contact result");
    assert.notEqual(cr.blockCode, "CB-09", "is_ready=null must not fire CB-09");
    // W-02 should appear in contact-level warnings
    assert.ok(cr.warnings.some(w => w.code === "W-02"), "W-02 must fire for is_ready=null");
  });
});

// ── Partial block scenario ────────────────────────────────────────────────────

describe("Partial block: some contacts eligible, some blocked", () => {
  test("1 eligible + 2 blocked → OUTREACH_READY_WITH_WARNINGS + W-06", () => {
    const NOW = new Date("2026-09-09T00:00:00Z");
    const c1 = "contact-pass";
    const c2 = "contact-fail-noscore";
    const c3 = "contact-fail-suppressed";

    const contacts = [
      makeContact(c1, { email: "pass@example.com" }),
      makeContact(c2, { email: "noscore@example.com" }),
      makeContact(c3, { email: "supp@example.com" }),
    ];

    const acctIntelGood = makeAccountIntel(COMPANY_ID, { opportunityScore: 75, isReady: true });
    const acctIntelZero = makeAccountIntel(COMPANY_ID + "-b", { opportunityScore: 0 });

    const company2 = COMPANY_ID + "-b";
    contacts[1] = { ...contacts[1], companyId: company2 };

    const relevanceRows = [
      makeRelevanceRow(c1),
      makeRelevanceRow(c2, { contactId: c2, companyId: company2 }),
      makeRelevanceRow(c3),
    ];

    const suppressionMap = new Map<string, Pick<ContactSuppressionRow, "expiresAt">[]>([
      [c3, [{ expiresAt: null }]],   // permanent suppression
    ]);

    const emailVerMap = new Map([
      [c1, makeEmailVer(c1)],
      [c2, makeEmailVer(c2)],
      [c3, makeEmailVer(c3)],
    ]);

    const accountIntelMap = new Map([
      [COMPANY_ID,      acctIntelGood],
      [company2,        acctIntelZero],
    ]);

    const lead1 = makeCampaignLead(c1, { platformLeadId: "pl-1" });

    const campaignLeadsMap = new Map([[c1, lead1]]);

    const input: ReadinessEvaluationInput = {
      clientId:            CLIENT_ID,
      campaignId:          CAMPAIGN_ID,
      campaignStrategyId:  STRATEGY_ID,
      campaign:            makeCampaign(),
      providerCredentialed: true,
      contacts,
      relevanceRows,
      accountIntelMap,
      emailVerMap,
      suppressionMap,
      campaignLeadsMap,
      domainSnapshots: [makeDomainSnapshot("sending.example.com")],
      now: NOW,
    };

    const result = assessReadinessFromData(input);

    assert.notEqual(result.verdict, "HARD_BLOCKED", "campaign must not be HARD_BLOCKED when ≥1 contact is eligible");
    assert.equal(result.contactSummary.eligibleCount, 1);
    assert.equal(result.contactSummary.blockedCount, 2);
    assert.ok(result.warnings.some(w => w.code === "W-06"), "W-06 must fire for partial block");
    assert.ok(result.hardBlocks.every(b => b.code !== "XB-07"), "XB-07 must NOT fire when ≥1 contact is eligible");
    assert.deepEqual(result.eligibleContactIds, [c1]);
  });
});

// ── All-blocked: XB-07 ────────────────────────────────────────────────────────

describe("XB-07: all qualified contacts blocked", () => {
  test("all contacts blocked → HARD_BLOCKED with XB-07", () => {
    const c1 = "contact-blocked-1";
    const c2 = "contact-blocked-2";

    // Both contacts have zero opportunity score → CB-08
    const acctIntelZero = makeAccountIntel(COMPANY_ID, { opportunityScore: 0 });

    const input: ReadinessEvaluationInput = {
      ...makeBaseInput(c1),
      contacts: [
        makeContact(c1, { email: "b1@example.com" }),
        makeContact(c2, { email: "b2@example.com" }),
      ],
      relevanceRows: [makeRelevanceRow(c1), makeRelevanceRow(c2)],
      accountIntelMap: new Map([[COMPANY_ID, acctIntelZero]]),
      emailVerMap: new Map([
        [c1, makeEmailVer(c1)],
        [c2, makeEmailVer(c2)],
      ]),
      suppressionMap: new Map(),
      campaignLeadsMap: new Map([
        [c1, makeCampaignLead(c1, { platformLeadId: "p1" })],
        [c2, makeCampaignLead(c2, { platformLeadId: "p2" })],
      ]),
    };

    const result = assessReadinessFromData(input);

    assert.equal(result.verdict, "HARD_BLOCKED");
    assert.ok(result.hardBlocks.some(b => b.code === "XB-07"), "XB-07 must fire when all contacts blocked");
    assert.equal(result.contactSummary.eligibleCount, 0);
    assert.equal(result.eligibleContactIds.length, 0);
  });
});

// ── W-01: approaching staleness ───────────────────────────────────────────────

describe("W-01: email verification approaching staleness", () => {
  const NOW = new Date("2026-09-09T00:00:00Z");

  test("verifiedAt 80 days ago → W-01 fires", () => {
    const contactId = "contact-w01";
    const verifiedAt = new Date(NOW.getTime() - 80 * 86_400_000).toISOString();
    const emailVer = makeEmailVer(contactId, { verifiedAt });
    const lead = makeCampaignLead(contactId, { platformLeadId: "p1" });

    const input = makeBaseInput(contactId, {
      emailVerMap:      new Map([[contactId, emailVer]]),
      campaignLeadsMap: new Map([[contactId, lead]]),
      now:              NOW,
    });
    const result = assessReadinessFromData(input);

    const cr = result.contactResults[0];
    assert.ok(cr?.warnings.some(w => w.code === "W-01"), "W-01 must fire at 80 days");
    // Campaign level should also aggregate W-01
    assert.ok(result.warnings.some(w => w.code === "W-01"), "W-01 aggregated to campaign warnings");
  });

  test("verifiedAt 50 days ago → W-01 does NOT fire", () => {
    const contactId = "contact-w01-no";
    const verifiedAt = new Date(NOW.getTime() - 50 * 86_400_000).toISOString();
    const emailVer = makeEmailVer(contactId, { verifiedAt });
    const lead = makeCampaignLead(contactId, { platformLeadId: "p1" });

    const input = makeBaseInput(contactId, {
      emailVerMap:      new Map([[contactId, emailVer]]),
      campaignLeadsMap: new Map([[contactId, lead]]),
      now:              NOW,
    });
    const result = assessReadinessFromData(input);

    const cr = result.contactResults[0];
    assert.ok(!cr?.warnings.some(w => w.code === "W-01"), "W-01 must NOT fire at 50 days");
  });
});

// ── XB-09: no backfilled leads ────────────────────────────────────────────────

describe("XB-09: no platform_lead_id", () => {
  test("0 leads with platformLeadId → HARD_BLOCKED with XB-09", () => {
    const contactId = "contact-noid";
    const lead = makeCampaignLead(contactId, { platformLeadId: null });

    const input = makeBaseInput(contactId, {
      campaignLeadsMap: new Map([[contactId, lead]]),
    });
    const result = assessReadinessFromData(input);

    assert.equal(result.verdict, "HARD_BLOCKED");
    assert.ok(result.hardBlocks.some(b => b.code === "XB-09"), "XB-09 must fire when backfilledCount=0");
    assert.equal(result.contactSummary.backfilledCount, 0);
  });
});

// ── W-11: low backfilled count ────────────────────────────────────────────────

describe("W-11: low backfilled lead count", () => {
  test("2 backfilled < threshold (5) → W-11 warning, not XB-09", () => {
    // Need multiple eligible contacts; use 2 leads with platformLeadId
    const c1 = "contact-w11-a";
    const c2 = "contact-w11-b";
    const contacts = [
      makeContact(c1, { email: "a@example.com" }),
      makeContact(c2, { email: "b@example.com" }),
    ];
    const acctIntel = makeAccountIntel(COMPANY_ID);
    const emailVerMap = new Map([
      [c1, makeEmailVer(c1)],
      [c2, makeEmailVer(c2)],
    ]);
    const campaignLeadsMap = new Map([
      [c1, makeCampaignLead(c1, { platformLeadId: "pl-a" })],
      [c2, makeCampaignLead(c2, { platformLeadId: "pl-b" })],
    ]);

    const input: ReadinessEvaluationInput = {
      ...makeBaseInput(c1),
      contacts,
      relevanceRows: [makeRelevanceRow(c1), makeRelevanceRow(c2)],
      accountIntelMap: new Map([[COMPANY_ID, acctIntel]]),
      emailVerMap,
      suppressionMap: new Map(),
      campaignLeadsMap,
    };

    const result = assessReadinessFromData(input);

    assert.ok(!result.hardBlocks.some(b => b.code === "XB-09"), "XB-09 must NOT fire when backfilledCount > 0");
    assert.ok(result.warnings.some(w => w.code === "W-11"), "W-11 must fire when backfilledCount < threshold");
    assert.equal(result.contactSummary.backfilledCount, 2);
  });
});

// ── PII invariant ─────────────────────────────────────────────────────────────

describe("PII invariant: no email addresses in assessment output", () => {
  test("contactResults and eligibleContactIds contain only UUIDs — no email addresses", () => {
    const contactId = "contact-pii";
    const contact   = makeContact(contactId, { email: "secret@victim.example.com" });
    const lead      = makeCampaignLead(contactId, { platformLeadId: "pl-1" });

    const input = makeBaseInput(contactId, {
      contacts:         [contact],
      campaignLeadsMap: new Map([[contactId, lead]]),
    });
    const result = assessReadinessFromData(input);

    // Serialize the whole assessment to JSON and scan for email
    const serialized = JSON.stringify(result);
    assert.ok(
      !serialized.includes("secret@victim.example.com"),
      "email address must not appear anywhere in the assessment output",
    );

    // eligibleContactIds must only contain UUIDs (no @ symbol)
    for (const id of result.eligibleContactIds) {
      assert.ok(!id.includes("@"), `eligibleContactIds must not contain email: ${id}`);
    }

    // contactResults must not contain email addresses
    for (const cr of result.contactResults) {
      const crStr = JSON.stringify(cr);
      assert.ok(!crStr.includes("@"), `contactResult must not contain email address: ${crStr}`);
    }
  });
});

// ── Security invariant ────────────────────────────────────────────────────────

describe("Security invariant: no credentials in assessment output", () => {
  test("assessment output contains no credential-shaped strings", () => {
    const contactId = "contact-sec";
    const lead      = makeCampaignLead(contactId, { platformLeadId: "pl-1" });

    const input = makeBaseInput(contactId, {
      campaignLeadsMap: new Map([[contactId, lead]]),
    });
    const result = assessReadinessFromData(input);

    const serialized = JSON.stringify(result);
    // Check for common API key patterns
    assert.ok(
      !serialized.match(/sk_test_[A-Za-z0-9]+/),
      "no Stripe-style test key must appear in output",
    );
    assert.ok(
      !serialized.match(/sb_secret_[A-Za-z0-9]+/),
      "no Smartlead secret key must appear in output",
    );
    assert.ok(
      !serialized.match(/Bearer\s+[A-Za-z0-9+/]{20,}/),
      "no Bearer token must appear in output",
    );
  });
});

// ── canApproveAssessment guard ────────────────────────────────────────────────

describe("canApproveAssessment: approval guard", () => {
  test("HARD_BLOCKED assessment → canApprove returns false", () => {
    assert.equal(canApproveAssessment({ verdict: "HARD_BLOCKED" }), false);
  });

  test("OUTREACH_READY assessment → canApprove returns true", () => {
    assert.equal(canApproveAssessment({ verdict: "OUTREACH_READY" }), true);
  });

  test("OUTREACH_READY_WITH_WARNINGS assessment → canApprove returns true", () => {
    assert.equal(canApproveAssessment({ verdict: "OUTREACH_READY_WITH_WARNINGS" }), true);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────────

describe("Idempotency: same inputs produce same verdict", () => {
  test("calling assessReadinessFromData twice with same input returns same verdict", () => {
    const contactId = "contact-idem";
    const lead = makeCampaignLead(contactId, { platformLeadId: "pl-1" });
    const input = makeBaseInput(contactId, {
      campaignLeadsMap: new Map([[contactId, lead]]),
    });

    const r1 = assessReadinessFromData(input);
    const r2 = assessReadinessFromData(input);

    assert.equal(r1.verdict, r2.verdict);
    assert.deepEqual(r1.hardBlocks.map(b => b.code), r2.hardBlocks.map(b => b.code));
    assert.deepEqual(r1.eligibleContactIds, r2.eligibleContactIds);
  });
});
