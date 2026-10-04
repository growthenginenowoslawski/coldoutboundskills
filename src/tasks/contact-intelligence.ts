/**
 * Contact Intelligence task entry point — Stage 23.
 *
 * This is the task-level adapter over src/lib/contact-intelligence.ts.
 * No Trigger.dev imports — fully testable standalone.
 *
 * ── Modes ─────────────────────────────────────────────────────────────────────
 *
 *   SINGLE_CONTACT — assess one (clientId, companyId, contactId, campaignStrategyId).
 *     Pass contactId in the payload. Errors propagate to the caller.
 *
 *   COMPANY_BATCH  — assess all contacts at a company for a campaign.
 *     Pass companyId and campaignStrategyId. Per-contact errors are caught.
 *
 * ── Prerequisites ─────────────────────────────────────────────────────────────
 *
 * account_intelligence.is_ready = true is required for every (clientId, companyId)
 * before running Stage 23. The orchestrator enforces this and throws if not met.
 *
 * ── What it produces ──────────────────────────────────────────────────────────
 *
 *   isPersonRelevant  — function/seniority fit for this campaign
 *   isContactReady    — Stage 17 gate snapshot (DISCOVERY ONLY, not authorization)
 *   isPersonQualified — isPersonRelevant AND isContactReady
 *
 * Stage 23 does NOT produce OUTREACH_READY. Activation (Stage 24+) MUST
 * re-run evaluateContactEligibility() live before any enrollment action.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * Both contact_intelligence and contact_campaign_relevance rows are upserted.
 * Rerunning with the same inputs produces the same result (fresh rows reused).
 * See staleness predicates in src/lib/person-relevance.ts.
 *
 * ── Excluded by design ────────────────────────────────────────────────────────
 *
 * No campaign_leads writes. No Smartlead. No outreach. No outbound of any kind.
 * No changes to opportunity_score, priority_score, or campaign state.
 * INITIAL_HYPOTHESIS_NOT_VALIDATED: all thresholds are unvalidated hypotheses.
 */

import {
  assessContactForCampaign,
  assessCompanyContacts,
} from "../lib/contact-intelligence";
import type {
  AssessContactInput,
  AssessCompanyContactsInput,
  ContactAssessmentResult,
  CompanyContactsAssessmentResult,
} from "../lib/contact-intelligence";

export type { AssessContactInput, AssessCompanyContactsInput };

// ── Public payload types ───────────────────────────────────────────────────────

export interface ContactIntelligenceTaskPayload {
  clientId:           string;
  companyId:          string;
  campaignStrategyId: string;

  /**
   * When provided: SINGLE_CONTACT mode.
   * When omitted:  COMPANY_BATCH mode — assess all contacts at companyId.
   */
  contactId?: string;

  /**
   * Skip AI narrative generation for this run.
   * Useful for deterministic-only runs (no AI spend).
   * Defaults to false.
   */
  skipAiNarrative?: boolean;

  /**
   * ISO 8601 time override for deterministic tests.
   * Applied to all assessContactForCampaign() calls.
   * Defaults to new Date() at task start.
   */
  now?: string;
}

export interface ContactIntelligenceTaskReport {
  clientId:             string;
  companyId:            string;
  campaignStrategyId:   string;
  mode:                 "single" | "batch";
  startedAt:            string;
  completedAt:          string;
  totalContacts:        number;
  qualifiedCount:       number;
  relevantCount:        number;
  aiCallsMade:          number;
  errorCount:           number;
  outcomes:             ContactOutcome[];
  errors:               { contactId: string; error: string }[];
  skipAiNarrative:      boolean;
}

export interface ContactOutcome {
  contactId:       string;
  isPersonRelevant: boolean | null;
  isContactReady:   boolean | null;
  isPersonQualified: boolean | null;
  relevanceReason:  string | null;
  relevanceScore:   number | null;
  aiCallMade:       boolean;
  skipped:          string[];
  error?:           string;
}

export interface ContactIntelligenceTaskResult {
  clientId: string;
  report:   ContactIntelligenceTaskReport;
}

// ── Task function ──────────────────────────────────────────────────────────────

/**
 * Run a contact intelligence assessment cycle.
 *
 * Single-contact mode: errors propagate to caller.
 * Batch mode:         per-contact errors are caught and added to report.errors.
 */
export async function runContactIntelligence(
  payload: ContactIntelligenceTaskPayload,
): Promise<ContactIntelligenceTaskResult> {
  const startedAt = new Date().toISOString();
  const mode: "single" | "batch" = payload.contactId ? "single" : "batch";

  const outcomes: ContactOutcome[] = [];
  const errors:   { contactId: string; error: string }[] = [];
  let aiCallsMade = 0;

  if (mode === "single") {
    const result = await assessContactForCampaign({
      clientId:           payload.clientId,
      companyId:           payload.companyId,
      contactId:           payload.contactId!,
      campaignStrategyId: payload.campaignStrategyId,
      now:                payload.now,
      skipAiNarrative:    payload.skipAiNarrative,
    });

    if (result.aiCallMade) aiCallsMade++;
    outcomes.push(toContactOutcome(result));

    return {
      clientId: payload.clientId,
      report: {
        clientId:           payload.clientId,
        companyId:           payload.companyId,
        campaignStrategyId: payload.campaignStrategyId,
        mode,
        startedAt,
        completedAt:        new Date().toISOString(),
        totalContacts:      1,
        qualifiedCount:     result.campaignRelevance.isPersonQualified === true ? 1 : 0,
        relevantCount:      result.campaignRelevance.isPersonRelevant === true ? 1 : 0,
        aiCallsMade,
        errorCount:         0,
        outcomes,
        errors,
        skipAiNarrative:    payload.skipAiNarrative ?? false,
      },
    };
  }

  // Batch mode
  const batchResult: CompanyContactsAssessmentResult = await assessCompanyContacts({
    clientId:           payload.clientId,
    companyId:           payload.companyId,
    campaignStrategyId: payload.campaignStrategyId,
    now:                payload.now,
    skipAiNarrative:    payload.skipAiNarrative,
  });

  for (const result of batchResult.assessed) {
    if (result.aiCallMade) aiCallsMade++;
    outcomes.push(toContactOutcome(result));
  }

  for (const skipped of batchResult.skippedContacts) {
    if (skipped.reason === "ERROR") {
      errors.push({ contactId: skipped.contactId, error: "Assessment failed — see logs" });
    }
    outcomes.push({
      contactId:         skipped.contactId,
      isPersonRelevant:  null,
      isContactReady:    null,
      isPersonQualified: null,
      relevanceReason:   null,
      relevanceScore:    null,
      aiCallMade:        false,
      skipped:           [skipped.reason],
      error:             skipped.reason === "ERROR" ? "Assessment failed" : undefined,
    });
  }

  return {
    clientId: payload.clientId,
    report: {
      clientId:           payload.clientId,
      companyId:           payload.companyId,
      campaignStrategyId: payload.campaignStrategyId,
      mode,
      startedAt,
      completedAt:        new Date().toISOString(),
      totalContacts:      batchResult.totalContacts,
      qualifiedCount:     batchResult.qualifiedCount,
      relevantCount:      batchResult.relevantCount,
      aiCallsMade,
      errorCount:         errors.length,
      outcomes,
      errors,
      skipAiNarrative:    payload.skipAiNarrative ?? false,
    },
  };
}

// ── Helper ────────────────────────────────────────────────────────────────────

function toContactOutcome(result: ContactAssessmentResult): ContactOutcome {
  return {
    contactId:         result.contactId,
    isPersonRelevant:  result.campaignRelevance.isPersonRelevant,
    isContactReady:    result.contactIntelligence.isContactReady,
    isPersonQualified: result.campaignRelevance.isPersonQualified,
    relevanceReason:   result.campaignRelevance.relevanceReason,
    relevanceScore:    result.campaignRelevance.relevanceScore,
    aiCallMade:        result.aiCallMade,
    skipped:           result.skipped,
  };
}
