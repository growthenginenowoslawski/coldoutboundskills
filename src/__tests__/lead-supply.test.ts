/**
 * Unit tests for Stage 19A lead supply assessment.
 *
 * All tests are pure — no network, no Supabase, no real data.
 * Tests cover assessContactForCampaign, buildLeadSupplyReport,
 * and all required cross-cutting scenarios from the Stage 19A design.
 *
 * Run: node --import tsx --test "src/__tests__/lead-supply.test.ts"
 * Full regression: node --import tsx --test "src/**\/*.test.ts"
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  assessContactForCampaign,
  buildLeadSupplyReport,
} from "../lib/lead-supply.js";
import type { ContactAssessment } from "../lib/lead-supply.js";
import type { ContactRow } from "../db/contacts.js";
import type { EmailVerificationRow } from "../db/email-verifications.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CLIENT_ID   = "client-aaa";
const CAMPAIGN_ID = "campaign-bbb";
const COMPANY_ID  = "company-ccc";
const CONTACT_ID  = "contact-ddd";
const LIST_ID     = "list-eee";

const NOW = new Date("2026-09-04T12:00:00Z");

// Minimal ContactRow that passes all gates by default
const BASE_CONTACT: ContactRow = {
  id:          CONTACT_ID,
  companyId:   COMPANY_ID,
  firstName:   "Alice",
  lastName:    "Smith",
  fullName:    "Alice Smith",
  jobTitle:    "VP Engineering",
  linkedinUrl: null,
  email:       "alice@example.com",
  emailStatus: "VERIFIED",
  status:      "review",
  source:      "prospeo",
  createdAt:   "2026-08-01T00:00:00Z",
};

const ACCOUNT_OK = { opportunityScore: 50 };
const ACCOUNT_ZERO = { opportunityScore: 0 };

const VERIFY_OK: EmailVerificationRow = {
  id:         "v1",
  contactId:  CONTACT_ID,
  email:      "alice@example.com",
  isValid:    true,
  result:     "ok",
  verifiedAt: "2026-08-15T00:00:00Z", // 20 days before NOW — fresh
  createdAt:  "2026-08-15T00:00:00Z",
};

const VERIFY_INVALID: EmailVerificationRow = {
  ...VERIFY_OK,
  isValid: false,
  result:  "invalid_mailbox",
};

const VERIFY_STALE: EmailVerificationRow = {
  ...VERIFY_OK,
  // 120 days before NOW — exceeds 90-day staleness threshold
  verifiedAt: new Date(NOW.getTime() - 120 * 24 * 60 * 60 * 1000).toISOString(),
};

const SUPPRESSION_PERMANENT = [{ expiresAt: null as string | null }];
const SUPPRESSION_ACTIVE = [{
  expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(), // expires 30 days in future
}];
const SUPPRESSION_EXPIRED = [{
  expiresAt: new Date(NOW.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(), // expired yesterday
}];

const CAMPAIGN_DRAFT   = { clientId: CLIENT_ID, status: "draft"   as const };
const CAMPAIGN_RUNNING = { clientId: CLIENT_ID, status: "running" as const };
const CAMPAIGN_REVIEW  = { clientId: CLIENT_ID, status: "review"  as const };
const CAMPAIGN_READY   = { clientId: CLIENT_ID, status: "ready"   as const };
const CAMPAIGN_PAUSED  = { clientId: CLIENT_ID, status: "paused"  as const };
const CAMPAIGN_COMPLETED  = { clientId: CLIENT_ID, status: "completed"  as const };
const CAMPAIGN_CANCELLED  = { clientId: CLIENT_ID, status: "cancelled"  as const };

// Helper to call assessContactForCampaign with all defaults that produce an eligible contact
function assess(overrides: Partial<Parameters<typeof assessContactForCampaign>[0]> = {}): ReturnType<typeof assessContactForCampaign> {
  return assessContactForCampaign({
    contact:             BASE_CONTACT,
    accountIntelligence: ACCOUNT_OK,
    emailVerification:   VERIFY_OK,
    suppressionRecords:  [],
    campaign:            CAMPAIGN_DRAFT,
    clientId:            CLIENT_ID,
    existingEnrollment:  false,
    now:                 NOW,
    ...overrides,
  });
}

// ── assessContactForCampaign — happy path ─────────────────────────────────────

describe("assessContactForCampaign — happy path", () => {
  test("returns eligible = true when all gates pass", () => {
    const r = assess();
    assert.equal(r.eligible, true);
    assert.equal(r.gate, null);
    assert.equal(r.reason, null);
    assert.ok(r.detail.length > 0);
  });

  test("populates contact identity fields from ContactRow", () => {
    const r = assess();
    assert.equal(r.contactId, CONTACT_ID);
    assert.equal(r.companyId, COMPANY_ID);
    assert.equal(r.email, "alice@example.com");
    assert.equal(r.fullName, "Alice Smith");
    assert.equal(r.jobTitle, "VP Engineering");
  });

  test("eligible with campaign status = running", () => {
    const r = assess({ campaign: CAMPAIGN_RUNNING });
    assert.equal(r.eligible, true);
  });

  test("eligible when email verification is null but emailStatus = VERIFIED (Prospeo soft-pass)", () => {
    const r = assess({ emailVerification: null });
    assert.equal(r.eligible, true);
    assert.equal(r.reason, null);
  });

  test("eligible when suppression record is expired", () => {
    const r = assess({ suppressionRecords: SUPPRESSION_EXPIRED });
    assert.equal(r.eligible, true);
  });
});

// ── assessContactForCampaign — Gate 1: Account ───────────────────────────────

describe("assessContactForCampaign — Gate 1: Account", () => {
  test("blocks with NO_ACCOUNT_INTELLIGENCE when accountIntelligence is null", () => {
    const r = assess({ accountIntelligence: null });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "NO_ACCOUNT_INTELLIGENCE");
    assert.equal(r.gate, "account");
  });

  test("blocks with ACCOUNT_SCORE_ZERO when opportunityScore = 0", () => {
    const r = assess({ accountIntelligence: ACCOUNT_ZERO });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "ACCOUNT_SCORE_ZERO");
    assert.equal(r.gate, "account");
  });

  test("NO_ACCOUNT_INTELLIGENCE short-circuits — does not reach email or campaign gate", () => {
    const r = assess({
      accountIntelligence: null,
      emailVerification:   VERIFY_INVALID,
      campaign:            CAMPAIGN_RUNNING,
    });
    assert.equal(r.reason, "NO_ACCOUNT_INTELLIGENCE");
  });
});

// ── assessContactForCampaign — Gate 2: Contact ───────────────────────────────

describe("assessContactForCampaign — Gate 2: Contact", () => {
  test("blocks with NO_EMAIL when contact has null email", () => {
    const r = assess({ contact: { ...BASE_CONTACT, email: null } });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "NO_EMAIL");
    assert.equal(r.gate, "contact");
  });

  test("blocks with NO_EMAIL when contact has empty-string email", () => {
    const r = assess({ contact: { ...BASE_CONTACT, email: "" } });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "NO_EMAIL");
  });

  test("contact identity fields are populated even when gate fails", () => {
    const r = assess({ contact: { ...BASE_CONTACT, email: null } });
    assert.equal(r.contactId, CONTACT_ID);
    assert.equal(r.companyId, COMPANY_ID);
    assert.equal(r.email, null);
    assert.equal(r.fullName, "Alice Smith");
  });
});

// ── assessContactForCampaign — Gate 3: Email ─────────────────────────────────

describe("assessContactForCampaign — Gate 3: Email", () => {
  test("blocks with EMAIL_INVALID when isValid = false", () => {
    const r = assess({ emailVerification: VERIFY_INVALID });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_INVALID");
    assert.equal(r.gate, "email");
  });

  test("blocks with EMAIL_VERIFICATION_STALE when verification is > 90 days old", () => {
    const r = assess({ emailVerification: VERIFY_STALE });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_VERIFICATION_STALE");
    assert.equal(r.gate, "email");
  });

  test("blocks with EMAIL_NOT_VERIFIED when no verification and emailStatus is null", () => {
    const r = assess({
      contact:           { ...BASE_CONTACT, emailStatus: null },
      emailVerification: null,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_NOT_VERIFIED");
    assert.equal(r.gate, "email");
  });

  test("blocks with EMAIL_NOT_VERIFIED when no verification and emailStatus is 'PENDING'", () => {
    const r = assess({
      contact:           { ...BASE_CONTACT, emailStatus: "PENDING" },
      emailVerification: null,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "EMAIL_NOT_VERIFIED");
  });
});

// ── assessContactForCampaign — Gate 4: Suppression ───────────────────────────

describe("assessContactForCampaign — Gate 4: Suppression", () => {
  test("blocks with CONTACT_SUPPRESSED for permanent suppression (expiresAt = null)", () => {
    const r = assess({ suppressionRecords: SUPPRESSION_PERMANENT });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CONTACT_SUPPRESSED");
    assert.equal(r.gate, "suppression");
  });

  test("blocks with CONTACT_SUPPRESSED for active timed suppression", () => {
    const r = assess({ suppressionRecords: SUPPRESSION_ACTIVE });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CONTACT_SUPPRESSED");
  });

  test("suppression is a HARD BLOCK — cannot be overridden even with high AI score", () => {
    const r = assess({
      accountIntelligence: { opportunityScore: 100 },
      suppressionRecords:  SUPPRESSION_PERMANENT,
    });
    assert.equal(r.reason, "CONTACT_SUPPRESSED");
  });
});

// ── assessContactForCampaign — Gate 5: Campaign ───────────────────────────────

describe("assessContactForCampaign — Gate 5: Campaign", () => {
  test("blocks with CAMPAIGN_NOT_ACTIVE for status = review", () => {
    const r = assess({ campaign: CAMPAIGN_REVIEW });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
    assert.equal(r.gate, "campaign");
  });

  test("blocks with CAMPAIGN_NOT_ACTIVE for status = ready", () => {
    const r = assess({ campaign: CAMPAIGN_READY });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("blocks with CAMPAIGN_NOT_ACTIVE for status = paused", () => {
    const r = assess({ campaign: CAMPAIGN_PAUSED });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("blocks with CAMPAIGN_NOT_ACTIVE for status = completed", () => {
    const r = assess({ campaign: CAMPAIGN_COMPLETED });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("blocks with CAMPAIGN_NOT_ACTIVE for status = cancelled", () => {
    const r = assess({ campaign: CAMPAIGN_CANCELLED });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_ACTIVE");
  });

  test("blocks with ALREADY_ENROLLED when existingEnrollment = true", () => {
    const r = assess({ existingEnrollment: true, campaign: CAMPAIGN_DRAFT });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "ALREADY_ENROLLED");
    assert.equal(r.gate, "campaign");
  });

  test("ALREADY_ENROLLED also blocks for running campaign", () => {
    const r = assess({ existingEnrollment: true, campaign: CAMPAIGN_RUNNING });
    assert.equal(r.reason, "ALREADY_ENROLLED");
  });

  test("blocks with CAMPAIGN_NOT_FOUND when campaign is null", () => {
    const r = assess({ campaign: null });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_NOT_FOUND");
    assert.equal(r.gate, "campaign");
  });
});

// ── buildLeadSupplyReport — counts and aggregation ────────────────────────────

describe("buildLeadSupplyReport — counts and aggregation", () => {
  function makeAssessment(
    eligible: boolean,
    reason?: string,
    gate?: string,
  ): ContactAssessment {
    return {
      contactId: `c-${Math.random()}`,
      companyId: COMPANY_ID,
      email:     "x@example.com",
      fullName:  null,
      jobTitle:  null,
      eligible,
      gate:      eligible ? null : (gate ?? "account") as ContactAssessment["gate"],
      reason:    eligible ? null : (reason ?? "NO_ACCOUNT_INTELLIGENCE") as ContactAssessment["reason"],
      detail:    eligible ? "Contact is eligible for outreach." : "Blocked.",
    };
  }

  test("empty assessments → all counts are 0", () => {
    const r = buildLeadSupplyReport({
      clientId:   CLIENT_ID,
      campaignId: CAMPAIGN_ID,
      campaignStatus: "draft",
      listId:     LIST_ID,
      assessedAt: NOW,
      assessments: [],
    });
    assert.equal(r.totalContacts, 0);
    assert.equal(r.eligibleCount, 0);
    assert.equal(r.ineligibleCount, 0);
    assert.deepEqual(r.eligible, []);
    assert.deepEqual(r.ineligible, []);
    assert.deepEqual(r.breakdownByReason, {});
  });

  test("counts eligible and ineligible correctly", () => {
    const r = buildLeadSupplyReport({
      clientId:   CLIENT_ID,
      campaignId: CAMPAIGN_ID,
      campaignStatus: "draft",
      listId:     LIST_ID,
      assessedAt: NOW,
      assessments: [
        makeAssessment(true),
        makeAssessment(true),
        makeAssessment(false, "NO_ACCOUNT_INTELLIGENCE"),
      ],
    });
    assert.equal(r.totalContacts, 3);
    assert.equal(r.eligibleCount, 2);
    assert.equal(r.ineligibleCount, 1);
    assert.equal(r.eligible.length, 2);
    assert.equal(r.ineligible.length, 1);
  });

  test("breakdownByReason accumulates counts by reason code", () => {
    const r = buildLeadSupplyReport({
      clientId:   CLIENT_ID,
      campaignId: CAMPAIGN_ID,
      campaignStatus: "draft",
      listId:     LIST_ID,
      assessedAt: NOW,
      assessments: [
        makeAssessment(false, "NO_ACCOUNT_INTELLIGENCE"),
        makeAssessment(false, "NO_ACCOUNT_INTELLIGENCE"),
        makeAssessment(false, "CONTACT_SUPPRESSED"),
        makeAssessment(false, "EMAIL_NOT_VERIFIED"),
      ],
    });
    assert.equal(r.breakdownByReason["NO_ACCOUNT_INTELLIGENCE"], 2);
    assert.equal(r.breakdownByReason["CONTACT_SUPPRESSED"], 1);
    assert.equal(r.breakdownByReason["EMAIL_NOT_VERIFIED"], 1);
  });

  test("breakdownByReason does not include eligible contacts", () => {
    const r = buildLeadSupplyReport({
      clientId:   CLIENT_ID,
      campaignId: CAMPAIGN_ID,
      campaignStatus: "draft",
      listId:     LIST_ID,
      assessedAt: NOW,
      assessments: [makeAssessment(true)],
    });
    assert.deepEqual(r.breakdownByReason, {});
  });

  test("totalContacts = eligibleCount + ineligibleCount always", () => {
    const r = buildLeadSupplyReport({
      clientId:   CLIENT_ID,
      campaignId: CAMPAIGN_ID,
      campaignStatus: "running",
      listId:     LIST_ID,
      assessedAt: NOW,
      assessments: [
        makeAssessment(true),
        makeAssessment(false, "EMAIL_INVALID"),
        makeAssessment(false, "CONTACT_SUPPRESSED"),
      ],
    });
    assert.equal(r.totalContacts, r.eligibleCount + r.ineligibleCount);
  });
});

// ── buildLeadSupplyReport — enrollmentOpen ────────────────────────────────────

describe("buildLeadSupplyReport — enrollmentOpen", () => {
  function reportForStatus(status: string) {
    return buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: status, listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
  }

  test("enrollmentOpen = true for draft", () => {
    assert.equal(reportForStatus("draft").enrollmentOpen, true);
  });

  test("enrollmentOpen = true for running", () => {
    assert.equal(reportForStatus("running").enrollmentOpen, true);
  });

  test("enrollmentOpen = false for review", () => {
    assert.equal(reportForStatus("review").enrollmentOpen, false);
  });

  test("enrollmentOpen = false for ready", () => {
    assert.equal(reportForStatus("ready").enrollmentOpen, false);
  });

  test("enrollmentOpen = false for paused", () => {
    assert.equal(reportForStatus("paused").enrollmentOpen, false);
  });

  test("enrollmentOpen = false for completed", () => {
    assert.equal(reportForStatus("completed").enrollmentOpen, false);
  });

  test("enrollmentOpen = false for cancelled", () => {
    assert.equal(reportForStatus("cancelled").enrollmentOpen, false);
  });
});

// ── buildLeadSupplyReport — FINDING 5 listClientWarning ──────────────────────

describe("buildLeadSupplyReport — listClientWarning (FINDING 5)", () => {
  test("listClientWarning is non-null when listId is provided", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
    assert.notEqual(r.listClientWarning, null);
    assert.ok(typeof r.listClientWarning === "string");
    assert.ok(r.listClientWarning.length > 0);
  });

  test("listClientWarning mentions FINDING 5", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
    assert.ok((r.listClientWarning as string).includes("FINDING 5"));
  });

  test("listClientWarning explicitly states this is NOT a security fix", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
    assert.ok(
      (r.listClientWarning as string).toLowerCase().includes("not a security fix") ||
      (r.listClientWarning as string).toLowerCase().includes("documentation"),
      "Warning must clarify this is documentation only, not a security fix",
    );
  });

  test("listClientWarning is null when listId is null (no list configured)", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: null, assessedAt: NOW, assessments: [],
    });
    assert.equal(r.listClientWarning, null);
  });
});

// ── buildLeadSupplyReport — report metadata ───────────────────────────────────

describe("buildLeadSupplyReport — report metadata", () => {
  test("assessedAt is an ISO 8601 string", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
    assert.ok(r.assessedAt.includes("T"));
    assert.ok(r.assessedAt.includes("Z") || r.assessedAt.includes("+"));
    assert.doesNotThrow(() => new Date(r.assessedAt));
  });

  test("notes default to empty array when not provided", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
    assert.deepEqual(r.notes, []);
  });

  test("notes are passed through when provided", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
      notes: ["note one", "note two"],
    });
    assert.equal(r.notes.length, 2);
    assert.equal(r.notes[0], "note one");
  });

  test("health advisories are null when not provided", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
    assert.equal(r.campaignHealthAdvisory, null);
    assert.equal(r.domainHealthAdvisory, null);
  });

  test("health advisories are passed through when provided", () => {
    const healthyEval = { isHealthy: true, concerns: [] };
    const unhealthyEval = {
      isHealthy: false,
      concerns: [{ code: "BOUNCE_RATE_HIGH", message: "Bounce rate 5%" }],
    };
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
      campaignHealthAdvisory: unhealthyEval,
      domainHealthAdvisory:   healthyEval,
    });
    assert.equal(r.campaignHealthAdvisory?.isHealthy, false);
    assert.equal(r.campaignHealthAdvisory?.concerns.length, 1);
    assert.equal(r.domainHealthAdvisory?.isHealthy, true);
  });

  test("report identity fields are echoed correctly", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "running", listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
    assert.equal(r.clientId, CLIENT_ID);
    assert.equal(r.campaignId, CAMPAIGN_ID);
    assert.equal(r.campaignStatus, "running");
    assert.equal(r.listId, LIST_ID);
  });
});

// ── Cross-cutting: mixed membership deduplication ────────────────────────────

describe("assessContactForCampaign — duplicate contacts (mixed membership paths)", () => {
  test("assessContactForCampaign produces one assessment per contact call", () => {
    // Deduplication happens in getContactsForList (Map in DB layer).
    // At the assessContactForCampaign level, each call produces exactly one result.
    const r1 = assess();
    const r2 = assess({ contact: { ...BASE_CONTACT, id: "contact-zzz" } });
    // Two distinct calls = two distinct results (both eligible)
    assert.equal(r1.contactId, CONTACT_ID);
    assert.equal(r2.contactId, "contact-zzz");
    assert.equal(r1.eligible, true);
    assert.equal(r2.eligible, true);
  });

  test("buildLeadSupplyReport preserves assessment order and has no implicit dedup", () => {
    // buildLeadSupplyReport accepts whatever assessments the orchestrator provides.
    // Deduplication is enforced at the getContactsForList() layer before assessment.
    const a1: ContactAssessment = {
      contactId: "c1", companyId: COMPANY_ID, email: "a@x.com", fullName: "A", jobTitle: null,
      eligible: true, gate: null, reason: null, detail: "Eligible.",
    };
    const a2: ContactAssessment = {
      contactId: "c2", companyId: COMPANY_ID, email: "b@x.com", fullName: "B", jobTitle: null,
      eligible: false, gate: "account", reason: "NO_ACCOUNT_INTELLIGENCE", detail: "Blocked.",
    };
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW,
      assessments: [a1, a2],
    });
    assert.equal(r.totalContacts, 2);
    assert.equal(r.eligible[0].contactId, "c1");
    assert.equal(r.ineligible[0].contactId, "c2");
  });
});

// ── Cross-cutting: client isolation ──────────────────────────────────────────

describe("assessContactForCampaign — client isolation", () => {
  test("blocks with CAMPAIGN_CLIENT_MISMATCH when campaign.clientId != clientId", () => {
    const r = assess({
      campaign:  { clientId: "different-client", status: "draft" },
      clientId:  CLIENT_ID,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "CAMPAIGN_CLIENT_MISMATCH");
    assert.equal(r.gate, "campaign");
  });

  test("cross-client contact (no AI for this client) → NO_ACCOUNT_INTELLIGENCE", () => {
    // Simulates a contact from another client's list.
    // No account_intelligence for CLIENT_ID + COMPANY_ID → fails at Gate 1.
    // The account gate provides a soft mitigation for FINDING 5.
    const r = assess({ accountIntelligence: null });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "NO_ACCOUNT_INTELLIGENCE");
    assert.equal(r.gate, "account");
  });
});

// ── Cross-cutting: already enrolled ──────────────────────────────────────────

describe("assessContactForCampaign — already enrolled", () => {
  test("draft campaign + already enrolled → ALREADY_ENROLLED", () => {
    const r = assess({ existingEnrollment: true, campaign: CAMPAIGN_DRAFT });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "ALREADY_ENROLLED");
  });

  test("running campaign + already enrolled → ALREADY_ENROLLED", () => {
    const r = assess({ existingEnrollment: true, campaign: CAMPAIGN_RUNNING });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, "ALREADY_ENROLLED");
  });

  test("not enrolled → does not produce ALREADY_ENROLLED", () => {
    const r = assess({ existingEnrollment: false, campaign: CAMPAIGN_DRAFT });
    assert.notEqual(r.reason, "ALREADY_ENROLLED");
    assert.equal(r.eligible, true);
  });
});

// ── Cross-cutting: missing platform data advisories ───────────────────────────

describe("buildLeadSupplyReport — missing platform / domain data", () => {
  test("campaignHealthAdvisory = null when explicitly passed as null (missing platformCampaignId)", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
      campaignHealthAdvisory: null,
    });
    assert.equal(r.campaignHealthAdvisory, null);
  });

  test("domainHealthAdvisory = null when not provided (missing sendingDomain)", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: [],
    });
    assert.equal(r.domainHealthAdvisory, null);
  });

  test("unhealthy campaign advisory has non-empty concerns", () => {
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "running", listId: LIST_ID, assessedAt: NOW, assessments: [],
      campaignHealthAdvisory: {
        isHealthy: false,
        concerns: [{ code: "BOUNCE_RATE_HIGH", message: "3.5% bounce rate" }],
      },
    });
    assert.equal(r.campaignHealthAdvisory?.isHealthy, false);
    assert.equal(r.campaignHealthAdvisory?.concerns[0].code, "BOUNCE_RATE_HIGH");
  });
});

// ── Cross-cutting: breakdown accuracy ─────────────────────────────────────────

describe("buildLeadSupplyReport — breakdownByReason accuracy", () => {
  test("all-eligible list produces empty breakdownByReason", () => {
    const eligible: ContactAssessment[] = [
      { contactId: "c1", companyId: "co", email: "a@b.com", fullName: null, jobTitle: null,
        eligible: true, gate: null, reason: null, detail: "Eligible." },
      { contactId: "c2", companyId: "co", email: "c@d.com", fullName: null, jobTitle: null,
        eligible: true, gate: null, reason: null, detail: "Eligible." },
    ];
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments: eligible,
    });
    assert.equal(Object.keys(r.breakdownByReason).length, 0);
    assert.equal(r.eligibleCount, 2);
    assert.equal(r.ineligibleCount, 0);
  });

  test("sum of breakdownByReason values equals ineligibleCount", () => {
    const assessments: ContactAssessment[] = [
      { contactId: "c1", companyId: "co", email: "a@b.com", fullName: null, jobTitle: null,
        eligible: false, gate: "account", reason: "NO_ACCOUNT_INTELLIGENCE", detail: "" },
      { contactId: "c2", companyId: "co", email: "b@b.com", fullName: null, jobTitle: null,
        eligible: false, gate: "email", reason: "EMAIL_NOT_VERIFIED", detail: "" },
      { contactId: "c3", companyId: "co", email: "c@b.com", fullName: null, jobTitle: null,
        eligible: false, gate: "suppression", reason: "CONTACT_SUPPRESSED", detail: "" },
    ];
    const r = buildLeadSupplyReport({
      clientId: CLIENT_ID, campaignId: CAMPAIGN_ID,
      campaignStatus: "draft", listId: LIST_ID, assessedAt: NOW, assessments,
    });
    const breakdownTotal = Object.values(r.breakdownByReason).reduce((a, b) => a + b, 0);
    assert.equal(breakdownTotal, r.ineligibleCount);
    assert.equal(r.ineligibleCount, 3);
  });
});
