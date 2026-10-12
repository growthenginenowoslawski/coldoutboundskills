/**
 * Lead supply assessment — Stage 19A.
 *
 * Answers: "Of all contacts reachable via this campaign's list, how many pass
 * all five eligibility gates right now, and why do the others fail?"
 *
 * The output is a LeadSupplyReport — a deterministic, read-only assessment.
 * No writes. No emails. No campaign modifications. No provider API calls.
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 * Pure functions (assessContactForCampaign, buildLeadSupplyReport) hold all
 * classification logic with no I/O. The orchestrator (assessCampaignLeadSupply)
 * gathers data in ~10 queries, then delegates to the pure functions.
 *
 * ── FINDING 5: lists have no client_id ───────────────────────────────────────
 *
 * The lists and list_members tables have no client_id column. There is no
 * DB-level guarantee that a campaign's list_id was built for the same client.
 * This is an active multi-tenant isolation gap documented in
 * docs/supabase/25-SUPABASE-SECURITY.md as FINDING 5.
 *
 * LeadSupplyReport.listClientWarning documents this gap whenever listId is
 * non-null. It is NOT a security fix — it is visibility only. FINDING 5 is
 * not resolved in Stage 19A. The account gate provides a soft mitigation:
 * contacts for companies with no account_intelligence for this client fail
 * at Gate 1 (NO_ACCOUNT_INTELLIGENCE), but contacts in shared companies
 * may still pass. See 25-SUPABASE-SECURITY.md FINDING 5 for full risk analysis.
 *
 * ── Campaign status and enrollment ───────────────────────────────────────────
 *
 * Stage 19A assesses contacts regardless of campaign status. The campaign gate
 * (Stage 17, unchanged) returns CAMPAIGN_NOT_ACTIVE for statuses outside
 * {draft, running}. The enrollmentOpen field surfaces this directly.
 *
 *   Enrollment-open statuses:    draft, running
 *   Enrollment-blocked statuses: review, ready, paused, completed, cancelled
 *
 * Stage 19B will only write campaign_leads when enrollmentOpen = true.
 *
 * ── Domain health advisory ───────────────────────────────────────────────────
 *
 * The sending domain is a provider-side concept with no DB representation.
 * domainHealthAdvisory is null unless the caller passes sendingDomain. When
 * provided, the latest Stage 18 domain snapshot is used — no live API call.
 *
 * ── Thresholds ───────────────────────────────────────────────────────────────
 *
 * No new thresholds are introduced. All thresholds come from Stage 17 (email
 * staleness) and Stage 18 (bounce/reply/block rates), all labelled
 * INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */

import { getCampaignById } from "../db/campaigns";
import type { CampaignRow } from "../db/campaigns";
import type { ContactRow } from "../db/contacts";
import type { AccountIntelligenceRow } from "../db/account-intelligence";
import type { EmailVerificationRow } from "../db/email-verifications";
import type { ContactSuppressionRow } from "../db/contact-suppression";
import {
  getContactsForList,
  getAccountIntelligenceMap,
  getLatestEmailVerificationMap,
  getSuppressionMap,
  getEnrolledContactIds,
} from "../db/list-contacts";
import {
  getLatestCampaignSnapshot,
  getBaselineCampaignSnapshot,
  getLatestDomainSnapshot,
} from "../db/health-snapshots";
import { evaluateCampaignEligibility } from "./contact-eligibility";
import type { EligibilityGate, EligibilityReason } from "./contact-eligibility";
import {
  computeCampaignHealthDelta,
  evaluateCampaignHealth,
  evaluateDomainHealth,
} from "./health-snapshots";
import type { HealthEvaluation } from "./health-snapshots";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Per-contact assessment result.
 *
 * Contains contact identity fields for readability (avoids requiring a
 * second lookup to display the report) and the full five-gate outcome.
 */
export interface ContactAssessment {
  contactId:  string;
  companyId:  string;
  email:      string | null;
  fullName:   string | null;
  jobTitle:   string | null;
  eligible:   boolean;
  /** Gate that blocked this contact. Null when eligible = true. */
  gate:       EligibilityGate | null;
  /** Machine-readable reason code. Null when eligible = true. */
  reason:     EligibilityReason | null;
  /** Human-readable explanation. Always set. */
  detail:     string;
}

/**
 * Complete lead supply report for a campaign.
 *
 * Produced by assessCampaignLeadSupply(). Read-only — no writes occur during
 * or after assessment. Assessment is exhaustive: every contact reachable via
 * the campaign's list is checked.
 */
export interface LeadSupplyReport {
  clientId:         string;
  campaignId:       string;
  /** Live campaign status at time of assessment. */
  campaignStatus:   string;
  /**
   * True when the campaign currently accepts new enrollment.
   *
   * Enrollment-open statuses: 'draft' | 'running'.
   * Stage 19B only writes campaign_leads when this is true.
   * This field does NOT change Stage 17 gate semantics — evaluateCampaignGate()
   * is the authoritative source for CAMPAIGN_NOT_ACTIVE decisions.
   */
  enrollmentOpen:    boolean;
  listId:            string | null;
  /** ISO 8601 timestamp of when assessCampaignLeadSupply() was called. */
  assessedAt:        string;
  totalContacts:     number;
  eligibleCount:     number;
  ineligibleCount:   number;
  eligible:          ContactAssessment[];
  ineligible:        ContactAssessment[];
  /** Ineligible contacts grouped by reason code. Useful for bulk triage. */
  breakdownByReason: Record<string, number>;
  /**
   * Campaign health advisory from Stage 18 snapshots.
   * Null when no platformCampaignId on the campaign, or no snapshot found.
   * No live provider API call is made.
   */
  campaignHealthAdvisory: HealthEvaluation | null;
  /**
   * Domain inbox health advisory from Stage 18 snapshots.
   * Null when sendingDomain was not provided to assessCampaignLeadSupply().
   * The sending domain has no DB representation — it must be provided explicitly.
   * No live provider API call is made.
   */
  domainHealthAdvisory: HealthEvaluation | null;
  /**
   * Human-readable advisory notes (health concerns, missing data, assessment
   * limitations). Does not include listClientWarning text — that is a separate field.
   */
  notes: string[];
  /**
   * FINDING 5 documentation field.
   *
   * Set to a non-null warning string whenever listId is non-null.
   * Absent (null) only when listId is null (no list configured).
   *
   * This is documentation of the unresolved multi-tenant isolation gap — NOT
   * a security fix. The account gate (Gate 1) provides a soft mitigation:
   * contacts for companies with no account_intelligence for this client fail
   * with NO_ACCOUNT_INTELLIGENCE. However, contacts in companies shared across
   * clients may pass Gate 1. See 25-SUPABASE-SECURITY.md FINDING 5.
   *
   * FINDING 5 is not resolved in Stage 19A. Do not remove this warning or
   * interpret its presence as a resolution.
   */
  listClientWarning: string | null;
}

/** Input to the lead supply orchestrator. */
export interface LeadSupplyInput {
  clientId:   string;
  campaignId: string;
  /**
   * Optional sending domain for domain health advisory.
   * When omitted, domainHealthAdvisory = null. No live API call is made.
   * The sending domain is a provider-side concept with no DB representation.
   */
  sendingDomain?: string;
  /**
   * Assessment is capped at this many contacts. Default: 500.
   * A note is added to the report when the list exceeds 1000 contacts.
   * Pagination is not yet implemented.
   */
  limit?: number;
}

// ── Pure functions ─────────────────────────────────────────────────────────────

/**
 * Assess one contact for enrollment in a campaign — pure, no I/O.
 *
 * Wraps evaluateCampaignEligibility() (Stage 17, unchanged) and maps the
 * result to a ContactAssessment with contact identity fields populated.
 *
 * companyId is always contact.companyId. For Path A (company member) contacts
 * this is the company's own ID; for Path B (direct member) contacts this is
 * whatever company the contact belongs to. Both cases use contact.companyId
 * consistently — the contact gate check (companyId mismatch) thus always
 * passes for correctly fetched contacts, as expected.
 */
export function assessContactForCampaign(opts: {
  contact:             ContactRow;
  accountIntelligence: Pick<AccountIntelligenceRow, "opportunityScore"> | null;
  emailVerification:   EmailVerificationRow | null;
  suppressionRecords:  Pick<ContactSuppressionRow, "expiresAt">[];
  campaign:            Pick<CampaignRow, "clientId" | "status"> | null;
  clientId:            string;
  existingEnrollment:  boolean;
  now?:                Date;
}): ContactAssessment {
  const result = evaluateCampaignEligibility({
    accountIntelligence: opts.accountIntelligence,
    contact:             opts.contact,
    companyId:           opts.contact.companyId,
    emailVerification:   opts.emailVerification,
    suppressionRecords:  opts.suppressionRecords,
    campaign:            opts.campaign,
    clientId:            opts.clientId,
    existingEnrollment:  opts.existingEnrollment,
    now:                 opts.now,
  });

  return {
    contactId:  opts.contact.id,
    companyId:  opts.contact.companyId,
    email:      opts.contact.email,
    fullName:   opts.contact.fullName,
    jobTitle:   opts.contact.jobTitle,
    eligible:   result.eligible,
    gate:       result.gate,
    reason:     result.reason,
    detail:     result.detail,
  };
}

/**
 * Aggregate per-contact assessments into a LeadSupplyReport — pure, no I/O.
 *
 * breakdownByReason counts ineligible contacts grouped by reason code.
 * enrollmentOpen is derived from campaignStatus.
 * listClientWarning is set whenever listId is non-null (FINDING 5 visibility).
 */
export function buildLeadSupplyReport(opts: {
  clientId:       string;
  campaignId:     string;
  campaignStatus: string;
  listId:         string | null;
  assessedAt:     Date;
  assessments:    ContactAssessment[];
  campaignHealthAdvisory?: HealthEvaluation | null;
  domainHealthAdvisory?:   HealthEvaluation | null;
  notes?:         string[];
}): LeadSupplyReport {
  const eligible   = opts.assessments.filter((a) => a.eligible);
  const ineligible = opts.assessments.filter((a) => !a.eligible);

  const breakdownByReason: Record<string, number> = {};
  for (const a of ineligible) {
    const key = a.reason ?? "UNKNOWN";
    breakdownByReason[key] = (breakdownByReason[key] ?? 0) + 1;
  }

  const enrollmentOpen =
    opts.campaignStatus === "draft" || opts.campaignStatus === "running";

  const listClientWarning: string | null =
    opts.listId !== null
      ? "FINDING 5 (25-SUPABASE-SECURITY.md): lists and list_members have no client_id. " +
        "There is no DB-level guarantee that this list was built for this client. " +
        "Cross-client contacts fail at Gate 1 (NO_ACCOUNT_INTELLIGENCE) unless the " +
        "company appears in both clients' account_intelligence. " +
        "This warning is documentation of the unresolved isolation gap — not a security fix."
      : null;

  return {
    clientId:               opts.clientId,
    campaignId:             opts.campaignId,
    campaignStatus:         opts.campaignStatus,
    enrollmentOpen,
    listId:                 opts.listId,
    assessedAt:             opts.assessedAt.toISOString(),
    totalContacts:          opts.assessments.length,
    eligibleCount:          eligible.length,
    ineligibleCount:        ineligible.length,
    eligible,
    ineligible,
    breakdownByReason,
    campaignHealthAdvisory: opts.campaignHealthAdvisory ?? null,
    domainHealthAdvisory:   opts.domainHealthAdvisory   ?? null,
    notes:                  opts.notes ?? [],
    listClientWarning,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Full lead supply assessment for a campaign.
 *
 * Data gathering strategy — ~10 DB queries total, no N+1:
 *   [1] getCampaignById            — one query (client-scoped)
 *   [2] getContactsForList         — 3 queries: list_members + path-A contacts + path-B contacts
 *   [3] getAccountIntelligenceMap  — one query (client-scoped, IN clause)
 *   [4] getLatestEmailVerificationMap — one query (IN clause, dedup in memory)
 *   [5] getSuppressionMap          — one query (client-scoped, IN clause)
 *   [6] getEnrolledContactIds      — one query (IN clause)
 *   [7] getLatestCampaignSnapshot  — one query (conditional on platformCampaignId)
 *   [8] getBaselineCampaignSnapshot — one query (conditional)
 *   [9] getLatestDomainSnapshot    — one query (conditional on sendingDomain)
 *
 * Does NOT write to campaign_leads. Does NOT send emails. Does NOT call live
 * provider APIs. Health advisories use Stage 18 DB snapshots exclusively.
 */
export async function assessCampaignLeadSupply(
  input: LeadSupplyInput,
): Promise<LeadSupplyReport> {
  const { clientId, campaignId, sendingDomain } = input;
  const limit = input.limit ?? 500;
  const assessedAt = new Date();
  const notes: string[] = [];

  // [1] Campaign lookup — client-scoped
  const campaign = await getCampaignById(clientId, campaignId);
  if (!campaign) {
    return buildLeadSupplyReport({
      clientId, campaignId,
      campaignStatus: "unknown",
      listId:      null,
      assessedAt,
      assessments: [],
      notes:       [`Campaign ${campaignId} not found for client ${clientId}.`],
    });
  }

  // [2] List gate — no list = no contacts to assess
  if (!campaign.listId) {
    return buildLeadSupplyReport({
      clientId, campaignId,
      campaignStatus: campaign.status,
      listId:      null,
      assessedAt,
      assessments: [],
      notes:       [
        "No list is configured on this campaign. " +
        "Assign a list (campaign.list_id) before running lead supply assessment.",
      ],
    });
  }

  // [2] Fetch contacts via Path A (company members) + Path B (direct members), deduped
  const allContacts = await getContactsForList(campaign.listId);

  if (allContacts.length === 0) {
    return buildLeadSupplyReport({
      clientId, campaignId,
      campaignStatus: campaign.status,
      listId:      campaign.listId,
      assessedAt,
      assessments: [],
      notes:       [
        "List has no contacts reachable via company membership or direct contact membership.",
      ],
    });
  }

  if (allContacts.length > 1000) {
    notes.push(
      `List has ${allContacts.length} contacts total. Assessment capped at ${limit}. ` +
      "Pagination is not yet implemented in Stage 19A.",
    );
  }

  const contacts   = allContacts.slice(0, limit);
  const contactIds = contacts.map((c) => c.id);
  const companyIds = [...new Set(contacts.map((c) => c.companyId))];

  // [3–6] Batch-fetch supporting data in parallel (independent queries)
  const [aiMap, verificationMap, suppressionMap, enrolledIds] = await Promise.all([
    getAccountIntelligenceMap(clientId, companyIds),
    getLatestEmailVerificationMap(contactIds),
    getSuppressionMap(clientId, contactIds),
    getEnrolledContactIds(campaignId, contactIds),
  ]);

  // [7–8] Campaign health advisory (uses Stage 18 snapshots, no live API)
  let campaignHealthAdvisory: HealthEvaluation | null = null;
  if (campaign.platformCampaignId) {
    const [latestSnap, baselineSnap] = await Promise.all([
      getLatestCampaignSnapshot(clientId, campaignId),
      getBaselineCampaignSnapshot(clientId, campaignId),
    ]);
    if (latestSnap) {
      const delta = baselineSnap
        ? computeCampaignHealthDelta(baselineSnap, latestSnap)
        : undefined;
      campaignHealthAdvisory = evaluateCampaignHealth(latestSnap, delta);
      if (!campaignHealthAdvisory.isHealthy) {
        notes.push(
          "Campaign health concerns: " +
          campaignHealthAdvisory.concerns.map((c) => c.code).join(", ") + ".",
        );
      }
    } else {
      notes.push(
        "Campaign has a platformCampaignId but no health snapshots yet. " +
        "Run the health snapshot job (Stage 18) to populate campaign health data.",
      );
    }
  } else {
    notes.push(
      "Campaign has no platform_campaign_id; campaign health advisory unavailable. " +
      "Link this campaign to the provider to enable health monitoring.",
    );
  }

  // [9] Domain health advisory (uses Stage 18 snapshots, no live API)
  let domainHealthAdvisory: HealthEvaluation | null = null;
  if (sendingDomain) {
    const domainSnap = await getLatestDomainSnapshot(
      clientId,
      campaign.platform,
      sendingDomain,
    );
    if (domainSnap) {
      domainHealthAdvisory = evaluateDomainHealth(domainSnap);
      if (!domainHealthAdvisory.isHealthy) {
        notes.push(
          `Domain health concerns for ${sendingDomain}: ` +
          domainHealthAdvisory.concerns.map((c) => c.code).join(", ") + ".",
        );
      }
    } else {
      notes.push(
        `No domain health snapshot found for ${sendingDomain} ` +
        `(provider: ${campaign.platform}). ` +
        "Run the domain health snapshot job (Stage 18) to populate domain health data.",
      );
    }
  } else {
    notes.push(
      "No sending domain provided; domain health advisory unavailable. " +
      "The sending domain is a provider-side concept with no DB representation. " +
      "Pass sendingDomain to assessCampaignLeadSupply() to enable domain health advisory.",
    );
  }

  // Per-contact assessment — pure, no I/O
  const now = assessedAt;
  const assessments: ContactAssessment[] = contacts.map((contact) =>
    assessContactForCampaign({
      contact,
      accountIntelligence: aiMap.get(contact.companyId) ?? null,
      emailVerification:   verificationMap.get(contact.id) ?? null,
      suppressionRecords:  suppressionMap.get(contact.id) ?? [],
      campaign,
      clientId,
      existingEnrollment:  enrolledIds.has(contact.id),
      now,
    }),
  );

  return buildLeadSupplyReport({
    clientId, campaignId,
    campaignStatus: campaign.status,
    listId:      campaign.listId,
    assessedAt,
    assessments,
    campaignHealthAdvisory,
    domainHealthAdvisory,
    notes,
  });
}
