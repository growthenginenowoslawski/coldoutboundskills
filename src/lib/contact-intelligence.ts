/**
 * Contact Intelligence orchestrator — Stage 23.
 *
 * Answers: "For an account worth pursuing, who is the right person to contact,
 * and why?"
 *
 * Three-stage pipeline per contact × campaign pair:
 *
 *   1. Contact Intelligence (campaign-agnostic)
 *      a. Evaluate Stage 17 eligibility gates → isContactReady snapshot
 *      b. classifyTitle() → TitleClassification
 *      c. Upsert contact_intelligence row
 *
 *   2. Campaign Relevance (campaign-specific)
 *      a. parseTargetingPersona() from campaign_strategies.targeting_level
 *      b. evaluateHardDisqualifiers() → NO_TITLE / WRONG_FUNCTION / WRONG_SENIORITY
 *      c. computeRelevanceScore() from factor weights + signal alignment bonus
 *      d. Upsert contact_campaign_relevance row (deterministic result)
 *
 *   3. AI Narrative (optional, cost-gated)
 *      Only when: isPersonRelevant = true AND score >= AI_RELEVANCE_MIN_SCORE.
 *      Uses existing executeSignalIntelligence() / ModelRouter infrastructure.
 *      AI failure is non-fatal — deterministic result is always persisted.
 *
 * ── Prerequisite ─────────────────────────────────────────────────────────────
 *
 * account_intelligence.is_ready = true is required before Stage 23 runs.
 * Return early (ACCOUNT_NOT_READY) when this gate is not met.
 * This is enforced by the orchestrator — not by the caller.
 *
 * ── State ownership ───────────────────────────────────────────────────────────
 *
 * Stage 23 produces: isPersonRelevant, isContactReady (snapshot), isPersonQualified.
 * Stage 23 does NOT produce OUTREACH_READY — that requires downstream checks
 * (Why Now currency, personalization, human review, campaign state, rate limits).
 *
 * isContactReady is a DISCOVERY snapshot. The activation stage (Stage 24+) MUST
 * re-run evaluateContactEligibility() live before any enrollment or outreach action.
 *
 * ── PII constraints ───────────────────────────────────────────────────────────
 *
 * - raw job title (contacts.job_title) is passed to the AI prompt but NOT stored
 * - email, full name, linkedin_url are NEVER sent to the AI model
 * - title_classification stores only function/seniority/confidence
 * - All AI prompt building delegates to buildPersonRelevanceAiInput() in person-relevance.ts
 *
 * ── Excluded by design ────────────────────────────────────────────────────────
 *
 * No contact writes. No campaign_leads writes. No outreach. No Smartlead.
 * No enrollment actions. No changes to opportunity_score or priority_score.
 * No changes to existing contact_suppression, campaigns, or campaign_strategies rows.
 */

import type { ContactRow } from "../db/contacts";
import type { AccountIntelligenceRow } from "../db/account-intelligence";
import type { EmailVerificationRow } from "../db/email-verifications";
import type { ContactSuppressionRow } from "../db/contact-suppression";
import type { CampaignStrategyRow } from "../db/campaign-strategies";
import type {
  ContactIntelligenceRow,
  ContactCampaignRelevanceRow,
  ContactGateSnapshot,
  TitleClassification,
  PersonRelevanceReason,
  PersonRelevanceNarrative,
} from "../domain/contact-intelligence-types";
import { getContactById } from "../db/contacts";
import { getAccountIntelligence } from "../db/account-intelligence";
import { getLatestEmailVerification } from "../db/email-verifications";
import { getSuppressionRecords } from "../db/contact-suppression";
import {
  getContactIntelligence,
  upsertContactIntelligence,
  getContactCampaignRelevance,
  upsertContactCampaignRelevance,
} from "../db/contact-intelligence";
import { getSignalsByCompany } from "../db/signals";
import { evaluateContactEligibility } from "./contact-eligibility";
import {
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
  SCORING_VERSION,
  AI_RELEVANCE_MIN_SCORE,
} from "./person-relevance";
import { executeSignalIntelligence } from "../providers/ai/executor";
import { ModelRouter } from "../providers/ai/model-router";
import type { SignalIntelligenceCapable } from "../providers/ai/executor";
import type { ComplexityHint } from "../providers/ai/model-router";
import type { WhyNowSignalSummary } from "../domain/signal-types";
import { buildWhyNowEvidence } from "./why-now";
import { isExpired } from "./signal-freshness";

// ── Result types ──────────────────────────────────────────────────────────────

export type ContactIntelligenceSkip =
  | "ACCOUNT_NOT_READY"
  | "CONTACT_NOT_FOUND"
  | "CAMPAIGN_STRATEGY_NOT_FOUND"
  | "CONTACT_INTELLIGENCE_FRESH"
  | "CAMPAIGN_RELEVANCE_FRESH";

export interface ContactAssessmentResult {
  clientId:            string;
  companyId:            string;
  contactId:            string;
  campaignStrategyId:  string;
  contactIntelligence: ContactIntelligenceRow;
  campaignRelevance:   ContactCampaignRelevanceRow;
  /** True when an AI narrative was generated on this run. */
  aiCallMade:          boolean;
  /** Skipped steps (fresh rows reused). */
  skipped:             ContactIntelligenceSkip[];
}

export interface CompanyContactsAssessmentResult {
  clientId:            string;
  companyId:            string;
  campaignStrategyId:  string;
  assessed:            ContactAssessmentResult[];
  skippedContacts:     Array<{ contactId: string; reason: ContactIntelligenceSkip | "ERROR" }>;
  totalContacts:       number;
  qualifiedCount:      number;
  relevantCount:       number;
}

// ── Input types ───────────────────────────────────────────────────────────────

export interface AssessContactInput {
  clientId:           string;
  companyId:           string;
  contactId:           string;
  campaignStrategyId: string;
  /** ISO 8601 override for deterministic tests. Defaults to new Date(). */
  now?: string;
  skipAiNarrative?: boolean;
  /** Replace ModelRouter (for unit tests). */
  providerFactory?: (complexity: ComplexityHint) => SignalIntelligenceCapable;
}

export interface AssessCompanyContactsInput {
  clientId:           string;
  companyId:           string;
  campaignStrategyId: string;
  now?: string;
  skipAiNarrative?: boolean;
  providerFactory?: (complexity: ComplexityHint) => SignalIntelligenceCapable;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function buildGateSnapshot(
  eligibilityResult: ReturnType<typeof evaluateContactEligibility>,
  evaluatedAt: string,
): ContactGateSnapshot {
  const { eligible, gate, reason, detail } = eligibilityResult;
  return {
    accountGate:     true, // invariant: Stage 22 prerequisite confirmed before this runs
    contactGate:     gate !== "contact" && eligible || gate === null ? true : gate !== "contact",
    emailGate:       gate !== "email" ? (eligible || gate === null ? true : false) : false,
    suppressionGate: gate !== "suppression" ? (eligible || gate === null ? true : false) : false,
    blockingGate:    eligible ? null : (gate ?? null),
    blockingReason:  eligible ? null : detail,
    evaluatedAt,
  };
}

async function generatePersonRelevanceNarrative(
  classification:   TitleClassification,
  targetingPersona: ReturnType<typeof parseTargetingPersona>,
  topSignals:       WhyNowSignalSummary[],
  campaign: {
    campaign_name:      string;
    targeting_level:    string | null;
    value_proposition:  string | null;
  },
  rawJobTitle:      string | null,
  whyNowNarrative:  string | null,
  assessedAt:       string,
  providerFactory?: (complexity: ComplexityHint) => SignalIntelligenceCapable,
): Promise<PersonRelevanceNarrative | null> {
  try {
    const input = buildPersonRelevanceAiInput(
      classification,
      targetingPersona,
      topSignals,
      campaign,
      rawJobTitle,
      whyNowNarrative,
      assessedAt,
    );

    const complexity: ComplexityHint = "medium";
    const provider = providerFactory
      ? providerFactory(complexity)
      : (ModelRouter.route("signal_intelligence", complexity) as unknown as SignalIntelligenceCapable);

    const start = Date.now();
    const result = await executeSignalIntelligence(provider, input);

    return {
      whyThisPerson: result.whyNow,
      confidence:    result.confidence,
      model:         result.model,
      analyzedAt:    assessedAt,
      inputTokens:   result.inputTokens ?? 0,
      outputTokens:  result.outputTokens ?? 0,
      costUsd:       result.costUsd ?? null,
      latencyMs:     Date.now() - start,
    };
  } catch (err) {
    // AI failure is non-fatal — deterministic result is always persisted
    console.error("[contact-intelligence] AI narrative failed (non-fatal):", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ── Main orchestrator: single contact × campaign ──────────────────────────────

/**
 * Assess one contact for one campaign strategy.
 *
 * Steps:
 *   1. Verify Stage 22 prerequisite (account_intelligence.is_ready = true)
 *   2. Load data (contact, eligibility inputs, signals, existing assessments)
 *   3. If contact_intelligence is stale: evaluate gates + classify title → upsert
 *   4. If contact_campaign_relevance is stale: score relevance → upsert
 *   5. Optionally generate AI narrative (non-fatal)
 *
 * Returns the final ContactIntelligenceRow and ContactCampaignRelevanceRow.
 * The rows may have been freshly written or reused from cache (see result.skipped).
 */
export async function assessContactForCampaign(
  input: AssessContactInput,
): Promise<ContactAssessmentResult> {
  const now = input.now ? new Date(input.now) : new Date();
  const assessedAt = now.toISOString();
  const skipped: ContactIntelligenceSkip[] = [];
  let aiCallMade = false;

  // ── Step 1: Load campaign strategy ───────────────────────────────────────────
  const { getCampaignStrategyById } = await import("../db/campaign-strategies");
  const campaignStrategy = await getCampaignStrategyById(input.campaignStrategyId, input.clientId);
  if (!campaignStrategy) {
    throw new Error(
      `assessContactForCampaign: campaign_strategy_id ${input.campaignStrategyId} not found for client ${input.clientId}`,
    );
  }

  // ── Step 2: Verify Stage 22 prerequisite ─────────────────────────────────────
  const accountIntelligence = await getAccountIntelligence(input.clientId, input.companyId);
  if (!accountIntelligence || accountIntelligence.isReady !== true) {
    throw new Error(
      `assessContactForCampaign: account_intelligence.is_ready is not true for ` +
      `client=${input.clientId} company=${input.companyId}. Run Stage 22 first.`,
    );
  }

  // ── Step 3: Load contact ──────────────────────────────────────────────────────
  const contact = await getContactById(input.contactId);
  if (!contact) {
    throw new Error(
      `assessContactForCampaign: contact ${input.contactId} not found`,
    );
  }

  // ── Step 4: Check if contact_intelligence is fresh ──────────────────────────
  const existingCI = await getContactIntelligence(input.clientId, input.companyId, input.contactId);

  // Suppression: load latest suppression record for staleness comparison
  const suppressionRecords = await getSuppressionRecords(input.clientId, input.contactId);
  const lastSuppressionChange = suppressionRecords.length > 0
    ? suppressionRecords.reduce((latest, r) => r.updatedAt > latest ? r.updatedAt : latest, suppressionRecords[0].updatedAt)
    : null;

  let ciRow: ContactIntelligenceRow;

  if (existingCI && !isContactIntelligenceStale(existingCI, lastSuppressionChange, now)) {
    // Fresh — reuse
    ciRow = existingCI;
    skipped.push("CONTACT_INTELLIGENCE_FRESH");
  } else {
    // Stale or missing — re-assess
    const emailVerification = await getLatestEmailVerification(input.contactId);
    const eligibilityResult = evaluateContactEligibility({
      accountIntelligence: { opportunityScore: accountIntelligence.opportunityScore },
      contact:             { companyId: contact.companyId, email: contact.email, emailStatus: contact.emailStatus },
      companyId:           input.companyId,
      emailVerification,
      suppressionRecords:  suppressionRecords.map((r) => ({ expiresAt: r.expiresAt })),
      now,
    });

    const gateSnapshot = buildGateSnapshot(eligibilityResult, assessedAt);
    const titleClassification = classifyTitle(contact.jobTitle);

    ciRow = await upsertContactIntelligence({
      clientId:                   input.clientId,
      companyId:                   input.companyId,
      contactId:                   input.contactId,
      titleClassification,
      gateSnapshot,
      isContactReady:              eligibilityResult.eligible,
      contactReadinessAssessedAt:  assessedAt,
    });
  }

  // ── Step 5: Check if contact_campaign_relevance is fresh ─────────────────────
  const existingCCR = await getContactCampaignRelevance(
    input.clientId,
    input.companyId,
    input.contactId,
    input.campaignStrategyId,
  );

  if (
    existingCCR &&
    !isCampaignRelevanceStale(
      existingCCR,
      input.campaignStrategyId,
      campaignStrategy.updated_at,
      accountIntelligence.readinessAssessedAt,
      ciRow.contactReadinessAssessedAt,
      now,
    )
  ) {
    skipped.push("CAMPAIGN_RELEVANCE_FRESH");
    return {
      clientId:            input.clientId,
      companyId:            input.companyId,
      contactId:            input.contactId,
      campaignStrategyId:  input.campaignStrategyId,
      contactIntelligence: ciRow,
      campaignRelevance:   existingCCR,
      aiCallMade,
      skipped,
    };
  }

  // ── Step 6: Compute campaign relevance ───────────────────────────────────────
  const titleClassification = ciRow.titleClassification ?? classifyTitle(contact.jobTitle);

  // Hard disqualifier: NO_TITLE
  if (!contact.jobTitle || contact.jobTitle.trim() === "") {
    const ccrRow = await upsertContactCampaignRelevance({
      clientId:            input.clientId,
      companyId:            input.companyId,
      contactId:            input.contactId,
      campaignStrategyId:  input.campaignStrategyId,
      relevanceScore:       null,
      isPersonRelevant:     false,
      isPersonQualified:    false,
      relevanceReason:      "NO_TITLE",
      evidence:             null,
      narrative:            null,
      scoringVersion:       SCORING_VERSION,
      relevanceAssessedAt:  assessedAt,
    });
    return { clientId: input.clientId, companyId: input.companyId, contactId: input.contactId, campaignStrategyId: input.campaignStrategyId, contactIntelligence: ciRow, campaignRelevance: ccrRow, aiCallMade, skipped };
  }

  const targetingPersona = parseTargetingPersona(campaignStrategy.targeting_level);
  const hardDisqualifier = evaluateHardDisqualifiers(titleClassification, targetingPersona);

  if (hardDisqualifier) {
    const ccrRow = await upsertContactCampaignRelevance({
      clientId:            input.clientId,
      companyId:            input.companyId,
      contactId:            input.contactId,
      campaignStrategyId:  input.campaignStrategyId,
      relevanceScore:       0,
      isPersonRelevant:     false,
      isPersonQualified:    false,
      relevanceReason:      hardDisqualifier as PersonRelevanceReason,
      evidence:             buildRelevanceEvidence(titleClassification, targetingPersona, [], { functionMatch: 0, seniorityMatch: 0, signalBonus: 0 }, 0, assessedAt),
      narrative:            null,
      scoringVersion:       SCORING_VERSION,
      relevanceAssessedAt:  assessedAt,
    });
    return { clientId: input.clientId, companyId: input.companyId, contactId: input.contactId, campaignStrategyId: input.campaignStrategyId, contactIntelligence: ciRow, campaignRelevance: ccrRow, aiCallMade, skipped };
  }

  // Load top signals for bonus scoring
  const allSignals = await getSignalsByCompany(input.clientId, input.companyId);
  const activeSignals = allSignals.filter((s) => s.status === "active" && !isExpired(s.expiresAt, now));

  const whyNowEvidence = buildWhyNowEvidence(
    allSignals,
    accountIntelligence.opportunityScore,
    accountIntelligence.priorityScore,
    now,
  );
  const topSignals = whyNowEvidence.topSignals;

  const functionScore  = computeFunctionMatchScore(
    titleClassification.function,
    targetingPersona.targetFunctions,
    targetingPersona.hasExplicitFunction,
    titleClassification.confidence,
  );
  const seniorityScore = computeSeniorityMatchScore(
    titleClassification.seniority,
    targetingPersona.minimumSeniority,
    targetingPersona.hasExplicitSeniority,
  );
  const signalBonus    = computeSignalAlignmentBonus(topSignals, titleClassification.function);
  const relevanceScore = computeRelevanceScore(functionScore, seniorityScore, signalBonus);
  const isPersonRelevant = evaluatePersonRelevantGate(relevanceScore);

  const factorScores = { functionMatch: functionScore, seniorityMatch: seniorityScore, signalBonus };
  const evidence = buildRelevanceEvidence(titleClassification, targetingPersona, topSignals, factorScores, relevanceScore, assessedAt);

  const reason: PersonRelevanceReason = isPersonRelevant ? "RELEVANT" : "SCORE_BELOW_THRESHOLD";
  const isPersonQualified = isPersonRelevant && (ciRow.isContactReady === true);

  // ── Step 7: AI narrative (optional, cost-gated, non-fatal) ───────────────────
  let narrative: PersonRelevanceNarrative | null = null;
  if (!input.skipAiNarrative && isPersonRelevant && relevanceScore >= AI_RELEVANCE_MIN_SCORE) {
    const whyNowNarrative = accountIntelligence.whyNow?.narrative?.whyNow ?? null;
    narrative = await generatePersonRelevanceNarrative(
      titleClassification,
      targetingPersona,
      topSignals,
      {
        campaign_name:      campaignStrategy.campaign_name,
        targeting_level:    campaignStrategy.targeting_level,
        value_proposition:  campaignStrategy.value_proposition,
      },
      contact.jobTitle, // rawJobTitle — PII passed to AI, NOT stored
      whyNowNarrative,
      assessedAt,
      input.providerFactory,
    );
    if (narrative) aiCallMade = true;
  }

  // ── Step 8: Persist ───────────────────────────────────────────────────────────
  const ccrRow = await upsertContactCampaignRelevance({
    clientId:            input.clientId,
    companyId:            input.companyId,
    contactId:            input.contactId,
    campaignStrategyId:  input.campaignStrategyId,
    relevanceScore,
    isPersonRelevant,
    isPersonQualified,
    relevanceReason:     reason,
    evidence,
    narrative,
    scoringVersion:      SCORING_VERSION,
    relevanceAssessedAt: assessedAt,
  });

  return {
    clientId:            input.clientId,
    companyId:            input.companyId,
    contactId:            input.contactId,
    campaignStrategyId:  input.campaignStrategyId,
    contactIntelligence: ciRow,
    campaignRelevance:   ccrRow,
    aiCallMade,
    skipped,
  };
}

// ── Batch orchestrator: all contacts at an account ────────────────────────────

/**
 * Assess all contacts at a company for a campaign strategy.
 *
 * Loads all contacts for the company, then calls assessContactForCampaign()
 * per contact. Per-contact errors are caught and surfaced in skippedContacts
 * rather than aborting the batch.
 *
 * Requires account_intelligence.is_ready = true (same as single-contact).
 */
export async function assessCompanyContacts(
  input: AssessCompanyContactsInput,
): Promise<CompanyContactsAssessmentResult> {
  const now = input.now ? new Date(input.now) : new Date();

  // Verify Stage 22 prerequisite once for the whole batch
  const accountIntelligence = await getAccountIntelligence(input.clientId, input.companyId);
  if (!accountIntelligence || accountIntelligence.isReady !== true) {
    throw new Error(
      `assessCompanyContacts: account_intelligence.is_ready is not true for ` +
      `client=${input.clientId} company=${input.companyId}. Run Stage 22 first.`,
    );
  }

  // Load all contacts for the company
  const db = (await import("../db/supabase")).getSupabaseAdmin();
  const { data: contactRows, error } = await db
    .from("contacts")
    .select("id")
    .eq("company_id", input.companyId);
  if (error) throw new Error(`assessCompanyContacts: failed to list contacts: ${error.message}`);

  const contactIds = (contactRows ?? []).map((r: { id: string }) => r.id);

  const assessed: ContactAssessmentResult[] = [];
  const skippedContacts: CompanyContactsAssessmentResult["skippedContacts"] = [];

  for (const contactId of contactIds) {
    try {
      const result = await assessContactForCampaign({
        clientId:           input.clientId,
        companyId:           input.companyId,
        contactId,
        campaignStrategyId: input.campaignStrategyId,
        now:                input.now,
        skipAiNarrative:    input.skipAiNarrative,
        providerFactory:    input.providerFactory,
      });
      assessed.push(result);
    } catch (err) {
      console.error(
        `[contact-intelligence] assessCompanyContacts: error for contact ${contactId}:`,
        err instanceof Error ? err.message : String(err),
      );
      skippedContacts.push({ contactId, reason: "ERROR" });
    }
  }

  return {
    clientId:            input.clientId,
    companyId:            input.companyId,
    campaignStrategyId:  input.campaignStrategyId,
    assessed,
    skippedContacts,
    totalContacts:       contactIds.length,
    qualifiedCount:      assessed.filter((r) => r.campaignRelevance.isPersonQualified === true).length,
    relevantCount:       assessed.filter((r) => r.campaignRelevance.isPersonRelevant === true).length,
  };
}
