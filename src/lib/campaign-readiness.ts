/**
 * Stage 25 — Outreach Readiness Evaluator.
 *
 * READ → EVALUATE → REPORT only. This module:
 *   - Reads outputs of Stages 17–24 (never writes to their tables)
 *   - Does NOT call Stage 19B (enrollment), Stage 20 (upload), or Stage 21A (backfill)
 *   - Does NOT send emails or activate campaigns
 *   - Produces an in-memory CampaignReadinessAssessment
 *
 * ── Two-layer design ─────────────────────────────────────────────────────────
 *
 * assessReadinessFromData() — pure function, takes all pre-fetched data.
 *   Testable without a database.
 *
 * evaluateOutreachReadiness() — async shell; fetches data then calls the pure fn.
 *
 * ── Security invariants ───────────────────────────────────────────────────────
 *
 * - No email addresses appear in any output field
 * - No provider credentials appear in any output field
 * - No PII beyond UUIDs in contactResults or eligibleContactIds
 * - Smartlead API keys are in URLs — never log the URL
 *
 * ── CB-09 pre-check ───────────────────────────────────────────────────────────
 *
 * account_intelligence.is_ready = false is NOT checked by Stage 17's
 * evaluateAccountGate() (which only checks opportunityScore > 0). Stage 25
 * checks it separately before delegating to evaluateContactEligibility().
 */

import type { CampaignRow } from "../db/campaigns";
import type { ContactRow } from "../db/contacts";
import type { AccountIntelligenceRow } from "../db/account-intelligence";
import type { EmailVerificationRow } from "../db/email-verifications";
import type { ContactSuppressionRow } from "../db/contact-suppression";
import type { CampaignLeadRow } from "../db/campaign-leads";
import type { DomainHealthSnapshot } from "../lib/health-snapshots";
import type { ContactCampaignRelevanceRow } from "../domain/contact-intelligence-types";
import type {
  CampaignReadinessAssessment,
  CampaignReadinessVerdict,
  ContactReadinessResult,
  ContactSummary,
  HardBlock,
  HardBlockCode,
  Warning,
} from "../domain/campaign-readiness-types";
import {
  evaluateContactEligibility,
  EMAIL_VERIFICATION_STALENESS_DAYS,
} from "./contact-eligibility";
import type { EligibilityReason } from "./contact-eligibility";
import { getCampaignById } from "../db/campaigns";
import {
  getContactsForList,
  getAccountIntelligenceMap,
  getLatestEmailVerificationMap,
  getSuppressionMap,
  getEnrolledContactIds,
} from "../db/list-contacts";
import { listContactCampaignRelevance } from "../db/contact-intelligence";
import { getCampaignLeadsByContactIds } from "../db/campaign-leads";
import { getLatestDomainSnapshotsByProvider } from "../db/health-snapshots";
import { optionalEnv } from "../config/env";

// ── Thresholds (all INITIAL_HYPOTHESIS_NOT_VALIDATED) ────────────────────────

/** W-01: warn when email verification is older than this many days (< STALENESS threshold). */
const APPROACHING_STALENESS_DAYS = 80;

/** W-03: warn when opportunityScore is positive but below this. */
const LOW_OPPORTUNITY_SCORE_THRESHOLD = 20;

/** W-09: warn when total healthy inboxes across all domains is below this. */
const LOW_INBOX_COUNT_THRESHOLD = 3;

/** W-11: warn when backfilled count is positive but below this. */
const LOW_BACKFILLED_THRESHOLD = 5;

// ── EligibilityReason → HardBlockCode mapping ────────────────────────────────

function reasonToBlockCode(reason: EligibilityReason): HardBlockCode {
  switch (reason) {
    case "CONTACT_NOT_FOUND":        return "CB-01";
    case "NO_EMAIL":                 return "CB-02";
    case "CONTACT_COMPANY_MISMATCH": return "CB-03";
    case "EMAIL_INVALID":            return "CB-04";
    case "EMAIL_NOT_VERIFIED":       return "CB-05";
    case "EMAIL_VERIFICATION_STALE": return "CB-06";
    case "CONTACT_SUPPRESSED":       return "CB-07";
    case "ACCOUNT_SCORE_ZERO":       return "CB-08";
    case "NO_ACCOUNT_INTELLIGENCE":  return "CB-10";
    // Campaign gate reasons should not appear here — Stage 25 checks campaign separately
    default:                         return "CB-10";
  }
}

// ── Input type for the pure evaluator ────────────────────────────────────────

export interface ReadinessEvaluationInput {
  clientId: string;
  campaignId: string;
  /** Effective strategy ID (caller resolves: opts.campaignStrategyId ?? campaign.campaignStrategyId). */
  campaignStrategyId: string | null;
  /**
   * The fetched campaign row, or null when not found / client mismatch.
   * When null, assessment returns immediately with XB-01.
   */
  campaign: CampaignRow | null;
  /**
   * True when provider credentials are available.
   * Caller resolves this from environment before calling the pure function.
   */
  providerCredentialed: boolean;
  /** All contacts found in the campaign list. Empty when list is absent or empty. */
  contacts: ContactRow[];
  /**
   * All contact_campaign_relevance rows for the strategy (not filtered to qualifiedOnly).
   * Empty when no strategy is set.
   */
  relevanceRows: ContactCampaignRelevanceRow[];
  accountIntelMap: Map<string, AccountIntelligenceRow>;
  emailVerMap: Map<string, EmailVerificationRow>;
  suppressionMap: Map<string, Pick<ContactSuppressionRow, "expiresAt">[]>;
  campaignLeadsMap: Map<string, CampaignLeadRow>;
  /** Latest domain health snapshot per domain for the campaign's provider. */
  domainSnapshots: DomainHealthSnapshot[];
  now: Date;
}

// ── Pure evaluator ────────────────────────────────────────────────────────────

/**
 * Pure, synchronous readiness evaluation. Takes all pre-fetched data and
 * returns a complete CampaignReadinessAssessment.
 *
 * No I/O. Suitable for unit testing without a database.
 */
export function assessReadinessFromData(
  input: ReadinessEvaluationInput,
): CampaignReadinessAssessment {
  const {
    clientId,
    campaignId,
    campaignStrategyId,
    campaign,
    providerCredentialed,
    contacts,
    relevanceRows,
    accountIntelMap,
    emailVerMap,
    suppressionMap,
    campaignLeadsMap,
    domainSnapshots,
    now,
  } = input;

  // ── XB-01: campaign not found ─────────────────────────────────────────────
  if (!campaign) {
    return makeAssessment({
      clientId,
      campaignId,
      campaignStrategyId: null,
      campaignStatus: "unknown",
      platformCampaignId: null,
      hardBlocks: [{ code: "XB-01", detail: "Campaign not found or does not belong to this client." }],
      warnings: [],
      qualifiedCount: 0,
      contactSummary: emptySummary(),
      smtpHealthyInboxCount: 0,
      eligibleContactIds: [],
      contactResults: [],
      now,
    });
  }

  const hardBlocks: HardBlock[] = [];
  const campaignWarnings: Warning[] = [];

  // ── XB-02: terminal status ────────────────────────────────────────────────
  if (campaign.status === "completed" || campaign.status === "cancelled") {
    hardBlocks.push({
      code: "XB-02",
      detail: `Campaign is in a terminal state: "${campaign.status}". Cannot activate.`,
    });
  }

  // ── XB-04: no strategy ───────────────────────────────────────────────────
  if (!campaignStrategyId) {
    hardBlocks.push({
      code: "XB-04",
      detail: "No campaign strategy assigned. Assign a campaign_strategy before evaluating readiness.",
    });
  }

  // ── XB-05: provider credentials ──────────────────────────────────────────
  if (!providerCredentialed) {
    hardBlocks.push({
      code: "XB-05",
      detail: `Provider "${campaign.platform}" credentials are not configured.`,
    });
  }

  // ── W-08: draft status ────────────────────────────────────────────────────
  if (campaign.status === "draft") {
    campaignWarnings.push({
      code: "W-08",
      detail: 'Campaign is in "draft" status. Move to "review" or "ready" before activation.',
    });
  }

  // ── XB-03: no list ────────────────────────────────────────────────────────
  if (!campaign.listId) {
    hardBlocks.push({ code: "XB-03", detail: "No list assigned to campaign." });
    return makeAssessment({
      clientId,
      campaignId,
      campaignStrategyId,
      campaignStatus: campaign.status,
      platformCampaignId: campaign.platformCampaignId,
      hardBlocks,
      warnings: campaignWarnings,
      qualifiedCount: 0,
      contactSummary: emptySummary(),
      smtpHealthyInboxCount: 0,
      eligibleContactIds: [],
      contactResults: [],
      now,
    });
  }

  // ── XB-08: no contacts ────────────────────────────────────────────────────
  if (contacts.length === 0) {
    hardBlocks.push({ code: "XB-08", detail: "No contacts found in the campaign list." });
    return makeAssessment({
      clientId,
      campaignId,
      campaignStrategyId,
      campaignStatus: campaign.status,
      platformCampaignId: campaign.platformCampaignId,
      hardBlocks,
      warnings: campaignWarnings,
      qualifiedCount: 0,
      contactSummary: emptySummary(),
      smtpHealthyInboxCount: 0,
      eligibleContactIds: [],
      contactResults: [],
      now,
    });
  }

  // ── Qualification filtering ───────────────────────────────────────────────
  // Use contact_campaign_relevance to determine evaluation population.
  // Contacts with isPersonQualified=true are evaluated.
  // Contacts with no row at all → W-07 (Stage 23 not run for them).
  let qualifiedContacts: ContactRow[];
  if (campaignStrategyId) {
    const relevanceByContactId = new Map(relevanceRows.map(r => [r.contactId, r]));

    qualifiedContacts = contacts.filter(c => {
      const row = relevanceByContactId.get(c.id);
      return row?.isPersonQualified === true;
    });

    const unassessedCount = contacts.filter(c => !relevanceByContactId.has(c.id)).length;
    if (unassessedCount > 0) {
      campaignWarnings.push({
        code: "W-07",
        detail: `${unassessedCount} list contact(s) have no contact_campaign_relevance record. Run Stage 23 assessment for them.`,
      });
    }
  } else {
    // No strategy — evaluate all contacts, but XB-04 already fired above
    qualifiedContacts = contacts;
  }

  if (qualifiedContacts.length === 0) {
    hardBlocks.push({
      code: "XB-08",
      detail: "No qualified contacts found. None passed Stage 23 relevance check (isPersonQualified = true).",
    });
    return makeAssessment({
      clientId,
      campaignId,
      campaignStrategyId,
      campaignStatus: campaign.status,
      platformCampaignId: campaign.platformCampaignId,
      hardBlocks,
      warnings: campaignWarnings,
      qualifiedCount: 0,
      contactSummary: emptySummary(),
      smtpHealthyInboxCount: 0,
      eligibleContactIds: [],
      contactResults: [],
      now,
    });
  }

  // ── Domain health (XB-06, W-09) ──────────────────────────────────────────
  const smtpHealthyInboxCount = domainSnapshots.reduce(
    (sum, s) => sum + s.healthyInboxCount,
    0,
  );

  if (domainSnapshots.length > 0 && smtpHealthyInboxCount === 0) {
    hardBlocks.push({
      code: "XB-06",
      detail: `Zero healthy inboxes across ${domainSnapshots.length} domain(s) for provider "${campaign.platform}".`,
    });
  } else if (domainSnapshots.length === 0) {
    campaignWarnings.push({
      code: "W-09",
      detail: `No domain health snapshots found for provider "${campaign.platform}". Run health collection before activation.`,
    });
  } else if (smtpHealthyInboxCount < LOW_INBOX_COUNT_THRESHOLD) {
    campaignWarnings.push({
      code: "W-09",
      detail: `Only ${smtpHealthyInboxCount} healthy inbox(es) across all domains (recommended minimum: ${LOW_INBOX_COUNT_THRESHOLD}). INITIAL_HYPOTHESIS_NOT_VALIDATED`,
    });
  }

  // ── Per-contact evaluation ────────────────────────────────────────────────
  const contactResults: ContactReadinessResult[] = [];

  for (const contact of qualifiedContacts) {
    const acctIntel = accountIntelMap.get(contact.companyId) ?? null;
    const emailVer  = emailVerMap.get(contact.id) ?? null;
    const suppRecs  = suppressionMap.get(contact.id) ?? [];
    const leadRow   = campaignLeadsMap.get(contact.id) ?? null;

    const contactWarnings: Warning[] = [];

    // ── CB-09: Stage 25 pre-check (is_ready = false) ─────────────────────
    // evaluateContactEligibility() does NOT check is_ready — it only checks opportunityScore.
    if (acctIntel?.isReady === false) {
      contactResults.push({
        contactId: contact.id,
        companyId: contact.companyId,
        verdict: "CONTACT_BLOCKED",
        blockCode: "CB-09",
        blockDetail: "Account intelligence readiness gate failed (is_ready = false). Re-run Stage 22 Why Now assessment.",
        eligibilityReason: null,
        enrollmentStatus: leadRow?.status ?? "NOT_ENROLLED",
        platformLeadId: leadRow?.platformLeadId ?? null,
        warnings: [],
      });
      continue;
    }

    // ── W-02: readiness not yet assessed ────────────────────────────────
    if (acctIntel !== null && acctIntel.isReady === null) {
      contactWarnings.push({
        code: "W-02",
        detail: "Account readiness has not been assessed (is_ready = null). Run Stage 22 Why Now assessment.",
      });
    }

    // ── W-03: low opportunity score ──────────────────────────────────────
    if (
      acctIntel !== null &&
      acctIntel.opportunityScore > 0 &&
      acctIntel.opportunityScore < LOW_OPPORTUNITY_SCORE_THRESHOLD
    ) {
      contactWarnings.push({
        code: "W-03",
        detail: `Opportunity score is low: ${acctIntel.opportunityScore} (flag threshold: ${LOW_OPPORTUNITY_SCORE_THRESHOLD}). INITIAL_HYPOTHESIS_NOT_VALIDATED`,
      });
    }

    // ── W-01: email verification approaching staleness ───────────────────
    if (emailVer?.isValid === true && emailVer.verifiedAt !== null) {
      const ageDays =
        (now.getTime() - new Date(emailVer.verifiedAt).getTime()) /
        (24 * 60 * 60 * 1000);
      if (ageDays >= APPROACHING_STALENESS_DAYS && ageDays < EMAIL_VERIFICATION_STALENESS_DAYS) {
        contactWarnings.push({
          code: "W-01",
          detail: `Email verification is ${Math.floor(ageDays)} days old (will become stale at ${EMAIL_VERIFICATION_STALENESS_DAYS} days).`,
        });
      }
    }

    // ── Stage 17 eligibility gates ───────────────────────────────────────
    const eligibility = evaluateContactEligibility({
      accountIntelligence: acctIntel,
      contact,
      companyId: contact.companyId,
      emailVerification: emailVer,
      suppressionRecords: suppRecs,
      now,
    });

    if (!eligibility.eligible) {
      contactResults.push({
        contactId: contact.id,
        companyId: contact.companyId,
        verdict: "CONTACT_BLOCKED",
        blockCode: reasonToBlockCode(eligibility.reason!),
        blockDetail: eligibility.detail,
        eligibilityReason: eligibility.reason,
        enrollmentStatus: leadRow?.status ?? "NOT_ENROLLED",
        platformLeadId: leadRow?.platformLeadId ?? null,
        warnings: contactWarnings,
      });
    } else {
      contactResults.push({
        contactId: contact.id,
        companyId: contact.companyId,
        verdict: "CONTACT_UPLOAD_READY",
        blockCode: null,
        blockDetail: null,
        eligibilityReason: null,
        enrollmentStatus: leadRow?.status ?? "NOT_ENROLLED",
        platformLeadId: leadRow?.platformLeadId ?? null,
        warnings: contactWarnings,
      });
    }
  }

  // ── Aggregate counts ──────────────────────────────────────────────────────
  const eligibleResults = contactResults.filter(r => r.verdict === "CONTACT_UPLOAD_READY");
  const blockedResults  = contactResults.filter(r => r.verdict === "CONTACT_BLOCKED");

  const enrolledCount    = contactResults.filter(r => r.enrollmentStatus !== "NOT_ENROLLED").length;
  const uploadedCount    = contactResults.filter(r => r.enrollmentStatus === "uploaded").length;
  const backfilledCount  = contactResults.filter(r => r.platformLeadId !== null).length;

  const eligibleContactIds = eligibleResults.map(r => r.contactId);

  // ── XB-07: all contacts blocked ───────────────────────────────────────────
  if (eligibleResults.length === 0) {
    hardBlocks.push({
      code: "XB-07",
      detail: `All ${qualifiedContacts.length} qualified contact(s) are hard-blocked. No eligible contacts remain.`,
    });
  }

  // ── XB-09: no backfilled leads ────────────────────────────────────────────
  if (backfilledCount === 0) {
    hardBlocks.push({
      code: "XB-09",
      detail: "No leads have a platform_lead_id. Stage 21A backfill has not run for this campaign.",
    });
  } else if (backfilledCount < LOW_BACKFILLED_THRESHOLD) {
    campaignWarnings.push({
      code: "W-11",
      detail: `Only ${backfilledCount} lead(s) have been backfilled with platform_lead_id (low count). INITIAL_HYPOTHESIS_NOT_VALIDATED`,
    });
  }

  // ── W-06: partial block ───────────────────────────────────────────────────
  if (blockedResults.length > 0 && eligibleResults.length > 0) {
    campaignWarnings.push({
      code: "W-06",
      detail: `${blockedResults.length} of ${qualifiedContacts.length} qualified contact(s) are blocked; ${eligibleResults.length} remain eligible.`,
    });
  }

  // Aggregate unique contact-level warning codes to campaign level
  const seenWarnCodes = new Set<string>(campaignWarnings.map(w => w.code));
  for (const r of contactResults) {
    for (const w of r.warnings) {
      if (!seenWarnCodes.has(w.code)) {
        seenWarnCodes.add(w.code);
        campaignWarnings.push({ code: w.code, detail: `[contact-level] ${w.detail}` });
      }
    }
  }

  const contactSummary: ContactSummary = {
    eligibleCount:   eligibleResults.length,
    blockedCount:    blockedResults.length,
    enrolledCount,
    uploadedCount,
    backfilledCount,
  };

  return makeAssessment({
    clientId,
    campaignId,
    campaignStrategyId,
    campaignStatus: campaign.status,
    platformCampaignId: campaign.platformCampaignId,
    hardBlocks,
    warnings: campaignWarnings,
    qualifiedCount: qualifiedContacts.length,
    contactSummary,
    smtpHealthyInboxCount,
    eligibleContactIds,
    contactResults,
    now,
  });
}

// ── Async shell ───────────────────────────────────────────────────────────────

/**
 * Fetches all required data and delegates to the pure assessReadinessFromData().
 *
 * @param clientId           Tenant performing the evaluation.
 * @param campaignId         Campaign to evaluate.
 * @param opts.campaignStrategyId  Override the strategy ID (defaults to campaign.campaignStrategyId).
 * @param opts.now           Override the evaluation timestamp (for deterministic tests).
 */
export async function evaluateOutreachReadiness(
  clientId:   string,
  campaignId: string,
  opts: { campaignStrategyId?: string; now?: Date } = {},
): Promise<CampaignReadinessAssessment> {
  const now      = opts.now ?? new Date();
  const campaign = await getCampaignById(clientId, campaignId);

  if (!campaign) {
    return assessReadinessFromData({
      clientId,
      campaignId,
      campaignStrategyId: null,
      campaign: null,
      providerCredentialed: false,
      contacts: [],
      relevanceRows: [],
      accountIntelMap: new Map(),
      emailVerMap: new Map(),
      suppressionMap: new Map(),
      campaignLeadsMap: new Map(),
      domainSnapshots: [],
      now,
    });
  }

  const effectiveStrategyId =
    opts.campaignStrategyId ?? campaign.campaignStrategyId ?? null;

  const providerCredentialed = resolveCredentials(campaign.platform);

  if (!campaign.listId) {
    return assessReadinessFromData({
      clientId,
      campaignId,
      campaignStrategyId: effectiveStrategyId,
      campaign,
      providerCredentialed,
      contacts: [],
      relevanceRows: [],
      accountIntelMap: new Map(),
      emailVerMap: new Map(),
      suppressionMap: new Map(),
      campaignLeadsMap: new Map(),
      domainSnapshots: [],
      now,
    });
  }

  // Fetch contacts and domain snapshots in parallel (no contact IDs needed yet)
  const [contacts, domainSnapshots] = await Promise.all([
    getContactsForList(campaign.listId),
    getLatestDomainSnapshotsByProvider(clientId, campaign.platform),
  ]);

  if (contacts.length === 0) {
    return assessReadinessFromData({
      clientId,
      campaignId,
      campaignStrategyId: effectiveStrategyId,
      campaign,
      providerCredentialed,
      contacts: [],
      relevanceRows: [],
      accountIntelMap: new Map(),
      emailVerMap: new Map(),
      suppressionMap: new Map(),
      campaignLeadsMap: new Map(),
      domainSnapshots,
      now,
    });
  }

  const contactIds = contacts.map(c => c.id);
  const companyIds = [...new Set(contacts.map(c => c.companyId))];

  // All supporting data in parallel
  const [
    relevanceRows,
    accountIntelMap,
    emailVerMap,
    suppressionMap,
    campaignLeadsMap,
  ] = await Promise.all([
    effectiveStrategyId
      ? listContactCampaignRelevance(clientId, effectiveStrategyId)
      : Promise.resolve([] as ContactCampaignRelevanceRow[]),
    getAccountIntelligenceMap(clientId, companyIds),
    getLatestEmailVerificationMap(contactIds),
    getSuppressionMap(clientId, contactIds),
    getCampaignLeadsByContactIds(campaignId, clientId, contactIds),
  ]);

  return assessReadinessFromData({
    clientId,
    campaignId,
    campaignStrategyId: effectiveStrategyId,
    campaign,
    providerCredentialed,
    contacts,
    relevanceRows,
    accountIntelMap,
    emailVerMap,
    suppressionMap,
    campaignLeadsMap,
    domainSnapshots,
    now,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveCredentials(platform: string): boolean {
  if (platform === "smartlead") {
    return Boolean(optionalEnv("SMARTLEAD_API_KEY"));
  }
  // Other platforms (plusvibe, instantly) — no adapter implemented yet
  return false;
}

interface MakeAssessmentArgs {
  clientId: string;
  campaignId: string;
  campaignStrategyId: string | null;
  campaignStatus: string;
  platformCampaignId: string | null;
  hardBlocks: HardBlock[];
  warnings: Warning[];
  qualifiedCount: number;
  contactSummary: ContactSummary;
  smtpHealthyInboxCount: number;
  eligibleContactIds: string[];
  contactResults: ContactReadinessResult[];
  now: Date;
}

function makeAssessment(args: MakeAssessmentArgs): CampaignReadinessAssessment {
  const verdict: CampaignReadinessVerdict =
    args.hardBlocks.length > 0
      ? "HARD_BLOCKED"
      : args.warnings.length > 0
        ? "OUTREACH_READY_WITH_WARNINGS"
        : "OUTREACH_READY";

  return {
    clientId:                       args.clientId,
    campaignId:                     args.campaignId,
    campaignStrategyId:             args.campaignStrategyId,
    campaignStatusAtEvaluation:     args.campaignStatus,
    platformCampaignIdAtEvaluation: args.platformCampaignId,
    verdict,
    hardBlocks:                     args.hardBlocks,
    warnings:                       args.warnings,
    qualifiedCount:                 args.qualifiedCount,
    contactSummary:                 args.contactSummary,
    smtpHealthyInboxCount:          args.smtpHealthyInboxCount,
    eligibleContactIds:             args.eligibleContactIds,
    contactResults:                 args.contactResults,
    evaluatedAt:                    args.now,
  };
}

function emptySummary(): ContactSummary {
  return {
    eligibleCount:   0,
    blockedCount:    0,
    enrolledCount:   0,
    uploadedCount:   0,
    backfilledCount: 0,
  };
}
