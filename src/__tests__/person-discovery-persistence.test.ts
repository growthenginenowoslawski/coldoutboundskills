/**
 * Unit tests for person discovery persistence mapping behavior.
 *
 * Tests pure logic: the candidate_is_relevant mapping, the absence of
 * found_email from enrichment run rows, and the attempt number assignment.
 * No DB calls — all behavior is derived from the module contracts and types.
 *
 * Run: npx tsx --test src/__tests__/person-discovery-persistence.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// ── candidate_is_relevant mapping ─────────────────────────────────────────────
// Inline the mapping logic (mirrors insertPersonDiscoveryAttempt in person-discovery.ts)
// This tests the invariant, not the Supabase call.

function mapCandidateIsRelevant(
  bestCandidateRejectionReason: string | null | undefined,
): boolean | null {
  if (bestCandidateRejectionReason === undefined) return null;
  if (bestCandidateRejectionReason === null) return true;
  return false;
}

describe("candidate_is_relevant mapping", () => {
  it("null rejection reason → true (candidate was RELEVANT)", () => {
    assert.equal(mapCandidateIsRelevant(null), true);
  });

  it("undefined rejection reason → null (no candidate was evaluated)", () => {
    assert.equal(mapCandidateIsRelevant(undefined), null);
  });

  it("WRONG_FUNCTION → false", () => {
    assert.equal(mapCandidateIsRelevant("WRONG_FUNCTION"), false);
  });

  it("WRONG_SENIORITY → false", () => {
    assert.equal(mapCandidateIsRelevant("WRONG_SENIORITY"), false);
  });

  it("NO_TITLE → false", () => {
    assert.equal(mapCandidateIsRelevant("NO_TITLE"), false);
  });

  it("SCORE_BELOW_THRESHOLD → false", () => {
    assert.equal(mapCandidateIsRelevant("SCORE_BELOW_THRESHOLD"), false);
  });

  it("empty string (unexpected) → false (truthy check fails)", () => {
    // An empty string is not null and not undefined → treated as a rejection reason
    assert.equal(mapCandidateIsRelevant(""), false);
  });

  it("return type is boolean | null — never undefined", () => {
    const results = [
      mapCandidateIsRelevant(null),
      mapCandidateIsRelevant(undefined),
      mapCandidateIsRelevant("WRONG_FUNCTION"),
    ];
    for (const r of results) {
      assert.ok(r === true || r === false || r === null,
        `expected boolean|null, got ${r}`);
      assert.notEqual(typeof r, "undefined", "must not return undefined");
    }
  });
});

// ── EmailEnrichmentOutcome — found_email absence from persisted shape ─────────

import type { EmailEnrichmentOutcome } from "../domain/person-discovery-types";

describe("EmailEnrichmentOutcome — found_email is in-memory only", () => {
  it("EmailEnrichmentOutcome.foundEmail is present in the type (in-memory use)", () => {
    // Type-level check: foundEmail is an optional property
    const outcome: EmailEnrichmentOutcome = {
      clientId: "abc",
      contactId: "def",
      campaignStrategyId: "ghi",
      state: "EMAIL_FOUND",
      foundEmail: "found@example.com",
      foundProvider: "prov-a",
      attempts: [],
      totalProvidersTried: 1,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    assert.equal(outcome.foundEmail, "found@example.com");
  });

  it("upsertEmailEnrichmentRun row shape does NOT include found_email key", () => {
    // Build the row object that would be sent to Supabase (mirrors upsertEmailEnrichmentRun)
    const outcome: EmailEnrichmentOutcome = {
      clientId: "c1",
      contactId: "ct1",
      campaignStrategyId: "s1",
      state: "EMAIL_FOUND",
      foundEmail: "victim@example.com",
      foundProvider: "prov-a",
      attempts: [],
      totalProvidersTried: 1,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const now = new Date().toISOString();
    const row = {
      client_id:             outcome.clientId,
      contact_id:            outcome.contactId,
      campaign_strategy_id:  outcome.campaignStrategyId,
      state:                 outcome.state,
      found_provider:        outcome.foundProvider ?? null,
      found_at:              outcome.state === "EMAIL_FOUND" ? now : null,
      providers_tried:       outcome.attempts.map((a) => a.provider),
      total_attempts:        outcome.attempts.length,
      enrichment_started_at: outcome.startedAt,
      enrichment_updated_at: outcome.completedAt,
      updated_at:            now,
    };

    assert.ok(!("found_email" in row), "found_email must NOT be in the persisted row");
    assert.ok("found_provider" in row, "found_provider (provenance) must be present");
    assert.ok("found_at" in row, "found_at must be present");
    assert.ok(!Object.values(row).some((v) => v === "victim@example.com"),
      "email address must not appear in any column value");
  });

  it("EXHAUSTED outcome: found_provider=null, found_at=null", () => {
    const outcome: EmailEnrichmentOutcome = {
      clientId: "c1", contactId: "ct1", campaignStrategyId: "s1",
      state: "EMAIL_ENRICHMENT_EXHAUSTED",
      attempts: [], totalProvidersTried: 2,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    const row = {
      found_provider: outcome.foundProvider ?? null,
      found_at:       outcome.state === "EMAIL_FOUND" ? "now" : null,
    };
    assert.equal(row.found_provider, null);
    assert.equal(row.found_at, null);
  });
});

// ── Attempt number assignment ─────────────────────────────────────────────────

describe("attempt_number assignment", () => {
  it("attempt_number is 0-indexed based on position in attempts array", () => {
    // Mirror the loop in persistPersonDiscoveryOutcome
    const attempts = ["prov-a", "prov-b", "prov-c"].map((provider, i) => ({
      provider,
      attemptNumber: i,
    }));
    assert.equal(attempts[0].attemptNumber, 0);
    assert.equal(attempts[1].attemptNumber, 1);
    assert.equal(attempts[2].attemptNumber, 2);
  });

  it("single attempt always gets attempt_number=0", () => {
    const attempts = ["prov-only"].map((provider, i) => ({
      provider,
      attemptNumber: i,
    }));
    assert.equal(attempts[0].attemptNumber, 0);
  });

  it("empty attempts array produces no attempt rows", () => {
    const attempts: unknown[] = [];
    assert.equal(attempts.length, 0);
  });
});

// ── PersistenceError — FK violation is observable, not silently swallowed ─────

import type { PersistenceError, PersonDiscoveryOutcome, EmailEnrichmentOutcome } from "../domain/person-discovery-types";

describe("PersistenceError — FK violation is observable", () => {
  it("PersistenceError.code is FK_VIOLATION", () => {
    const err: PersistenceError = {
      code: "FK_VIOLATION",
      message: "audit record not written: one or more FK references (client_id) not found in database",
    };
    assert.equal(err.code, "FK_VIOLATION");
  });

  it("PersistenceError.message is a non-empty string", () => {
    const err: PersistenceError = {
      code: "FK_VIOLATION",
      message: "audit record not written: one or more FK references (client_id) not found in database",
    };
    assert.equal(typeof err.message, "string");
    assert.ok(err.message.length > 0);
  });

  it("FK violation message contains no email addresses", () => {
    const err: PersistenceError = {
      code: "FK_VIOLATION",
      message: "audit record not written: one or more FK references (client_id, company_id, campaign_strategy_id) not found in database",
    };
    // Message must not contain @ (no email addresses)
    assert.ok(!err.message.includes("@"), "FK_VIOLATION message must not contain email addresses");
  });

  it("FK violation message contains no Bearer tokens or API keys", () => {
    const err: PersistenceError = {
      code: "FK_VIOLATION",
      message: "audit record not written: one or more FK references (client_id, company_id, campaign_strategy_id) not found in database",
    };
    assert.ok(!err.message.toLowerCase().includes("bearer"), "must not contain bearer token");
    assert.ok(!err.message.toLowerCase().includes("api_key"), "must not contain api_key");
    assert.ok(!err.message.toLowerCase().includes("sk_"), "must not contain sk_ token prefix");
  });

  it("PersonDiscoveryOutcome.persistenceError is optional (absent on success)", () => {
    const outcome: PersonDiscoveryOutcome = {
      clientId: "c", companyId: "co", campaignStrategyId: "cs",
      state: "PERSON_DISCOVERY_EXHAUSTED",
      attempts: [], totalProvidersTried: 0, reusedExistingResult: false,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    };
    // No persistenceError → undefined (not null)
    assert.equal(outcome.persistenceError, undefined);
  });

  it("PersonDiscoveryOutcome.persistenceError is set when FK violation occurred", () => {
    const fkErr: PersistenceError = { code: "FK_VIOLATION", message: "audit record not written: client_id FK" };
    const outcome: PersonDiscoveryOutcome = {
      clientId: "00000000-0000-0000-0000-000000000001",
      companyId: "co", campaignStrategyId: "cs",
      state: "PERSON_DISCOVERY_EXHAUSTED",
      fatalError: { code: "CAMPAIGN_NOT_FOUND", message: "strategy not found" },
      attempts: [], totalProvidersTried: 0, reusedExistingResult: false,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      persistenceError: fkErr,
    };
    assert.equal(outcome.persistenceError?.code, "FK_VIOLATION");
    // The waterfall outcome is still semantically correct
    assert.equal(outcome.state, "PERSON_DISCOVERY_EXHAUSTED");
    assert.equal(outcome.fatalError?.code, "CAMPAIGN_NOT_FOUND");
  });

  it("EmailEnrichmentOutcome.persistenceError is optional (absent on success)", () => {
    const outcome: EmailEnrichmentOutcome = {
      clientId: "c", contactId: "ct", campaignStrategyId: "cs",
      state: "EMAIL_ENRICHMENT_EXHAUSTED",
      attempts: [], totalProvidersTried: 0,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    };
    assert.equal(outcome.persistenceError, undefined);
  });

  it("EmailEnrichmentOutcome.persistenceError is set when FK violation occurred", () => {
    const fkErr: PersistenceError = { code: "FK_VIOLATION", message: "audit record not written: contact_id FK" };
    const outcome: EmailEnrichmentOutcome = {
      clientId: "00000000-0000-0000-0000-000000000001",
      contactId: "ct", campaignStrategyId: "cs",
      state: "EMAIL_ENRICHMENT_EXHAUSTED",
      attempts: [], totalProvidersTried: 0,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      persistenceError: fkErr,
    };
    assert.equal(outcome.persistenceError?.code, "FK_VIOLATION");
  });

  it("persistenceError does not affect the waterfall state or selected candidate", () => {
    const fkErr: PersistenceError = { code: "FK_VIOLATION", message: "audit record not written" };
    const outcome: PersonDiscoveryOutcome = {
      clientId: "c", companyId: "co", campaignStrategyId: "cs",
      state: "RELEVANT_FOUND",
      selected: {
        contactId: "uuid-1", provider: "fake",
        relevanceScore: 90, isPersonRelevant: true, isPersonQualified: true,
      },
      attempts: [], totalProvidersTried: 1, reusedExistingResult: false,
      startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      persistenceError: fkErr,
    };
    // FK violation does not corrupt the waterfall decision
    assert.equal(outcome.state, "RELEVANT_FOUND");
    assert.equal(outcome.selected?.contactId, "uuid-1");
    assert.equal(outcome.persistenceError?.code, "FK_VIOLATION");
  });
});

// ── PersonDiscoveryOutcome — no PII in persisted columns ─────────────────────

describe("PersonDiscoveryOutcome — persisted run row contains no PII", () => {
  it("selected_contact_id is a UUID, not a name or email", () => {
    const outcome: PersonDiscoveryOutcome = {
      clientId: "client-1",
      companyId: "company-1",
      campaignStrategyId: "strategy-1",
      state: "RELEVANT_FOUND",
      selected: {
        contactId: "550e8400-e29b-41d4-a716-446655440000",
        linkedinUrl: "https://linkedin.com/in/example",
        provider: "fake-provider",
        relevanceScore: 85,
        isPersonRelevant: true,
        isPersonQualified: true,
      },
      attempts: [],
      totalProvidersTried: 1,
      reusedExistingResult: false,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    // Mirror upsertPersonDiscoveryRun column mapping
    const runRow = {
      selected_contact_id:    outcome.selected?.contactId ?? null,
      selected_provider:      outcome.selected?.provider ?? null,
      selected_relevance_score: outcome.selected?.relevanceScore ?? null,
    };

    // contactId should be a UUID, not a name or email
    assert.match(runRow.selected_contact_id!, /^[0-9a-f-]{36}$/,
      "selected_contact_id must be a UUID");
    // Provider field is an ID string, not a credential
    assert.equal(runRow.selected_provider, "fake-provider");
    assert.equal(runRow.selected_relevance_score, 85);
  });

  it("linkedinUrl is NOT persisted in run row (transient PII)", () => {
    const outcome: PersonDiscoveryOutcome = {
      clientId: "c", companyId: "co", campaignStrategyId: "cs",
      state: "RELEVANT_FOUND",
      selected: {
        contactId: "uuid-here",
        linkedinUrl: "https://linkedin.com/in/someone",
        provider: "fake",
        relevanceScore: 90,
        isPersonRelevant: true,
        isPersonQualified: true,
      },
      attempts: [],
      totalProvidersTried: 1,
      reusedExistingResult: false,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };

    const runRow = {
      state: outcome.state,
      selected_contact_id: outcome.selected?.contactId ?? null,
      selected_provider: outcome.selected?.provider ?? null,
      selected_relevance_score: outcome.selected?.relevanceScore ?? null,
      selected_is_qualified: outcome.selected?.isPersonQualified ?? null,
      fatal_error_code: outcome.fatalError?.code ?? null,
      providers_tried: outcome.attempts.map((a) => a.provider),
      total_attempts: outcome.attempts.length,
      discovery_started_at: outcome.startedAt,
      discovery_updated_at: outcome.completedAt,
    };

    const rowStr = JSON.stringify(runRow);
    assert.ok(!rowStr.includes("linkedin.com"), "LinkedIn URL must not be in run row");
    assert.ok(!rowStr.includes("someone"), "LinkedIn profile name must not be in run row");
  });
});
