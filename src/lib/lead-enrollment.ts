/**
 * Lead enrollment — Stage 19B.
 *
 * Atomically enrolls eligible contacts into a campaign by writing to campaign_leads.
 * Enrollment is the write-side complement to Stage 19A's read-only lead supply assessment.
 *
 * ── Enrollment contract ────────────────────────────────────────────────────────
 *
 * 1. Re-validation: all five eligibility gates (Stage 17) are re-checked at
 *    enrollment time using fresh DB data. A stale Stage 19A report is never
 *    trusted — suppressions, campaign status, or account intelligence may have
 *    changed between assessment and enrollment.
 *
 * 2. Atomicity: the DB UNIQUE (campaign_id, contact_id) constraint is the
 *    authoritative duplicate-prevention mechanism. On conflict, the second INSERT
 *    is silently dropped (ON CONFLICT DO NOTHING). Two concurrent calls for the
 *    same (campaign_id, contact_id) pair will produce exactly one row — no race
 *    condition, no duplicate enrollment.
 *
 * 3. Tenant integrity: the composite FK (client_id, campaign_id) →
 *    campaigns(client_id, id) rejects any attempt to enroll under a mismatched
 *    client_id at the DB level. Application-layer client checks are defence-in-depth.
 *
 * 4. Status: newly enrolled leads always start as 'ready' (the DB column default
 *    and the only valid initial status). updated_at is set explicitly on every row
 *    because campaign_leads has no triggers.
 *
 * 5. Suppression is a hard block: evaluateCampaignEligibility() enforces this.
 *    AI enrichment, scores, or any other signal cannot override a suppression record.
 *
 * ── Activation gate ───────────────────────────────────────────────────────────
 *
 * Enrollment is blocked unless the campaign status is 'draft' or 'running'.
 * Blocked statuses: review, ready, paused, completed, cancelled.
 * This guard is checked BEFORE any per-contact re-validation.
 *
 * ── What this module does NOT do ─────────────────────────────────────────────
 *
 * - No email sends. No provider API calls. No outbound of any kind.
 * - No campaign status mutations.
 * - No account_intelligence writes. No suppression writes.
 * - No RLS policy changes (FINDING 6 remains open).
 * - No resolution of FINDING 5 (list/list_members tenant gap).
 */

import { getCampaignById }             from "../db/campaigns";
import type { CampaignRow }            from "../db/campaigns";
import { getContactsByIds }            from "../db/contacts";
import { insertCampaignLeads }         from "../db/campaign-leads";
import {
  getAccountIntelligenceMap,
  getLatestEmailVerificationMap,
  getSuppressionMap,
} from "../db/list-contacts";
import { evaluateCampaignEligibility } from "./contact-eligibility";
import type { EligibilityReason }      from "./contact-eligibility";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnrollmentInput {
  clientId:    string;
  campaignId:  string;
  /**
   * ContactIds to enroll. Typically the eligible[] from a LeadSupplyReport,
   * but the function re-validates every contact at write time — a stale report
   * is never blindly trusted.
   */
  contactIds:  string[];
  /**
   * When true, all re-validation runs but no rows are written.
   * Useful for confirming what would be enrolled without committing.
   */
  dryRun?:     boolean;
}

/** A contact that was successfully written to campaign_leads. */
export interface EnrolledLead {
  contactId:      string;
  campaignLeadId: string;
  /** Always 'ready' — the only valid initial enrollment status. */
  status:         "ready";
  enrolledAt:     string; // ISO 8601 — the created_at timestamp from DB
}

/** A contact that failed re-validation at enrollment time. */
export interface EnrollmentRejection {
  contactId: string;
  reason:    EligibilityReason;
  detail:    string;
}

export interface EnrollmentResult {
  campaignId:     string;
  clientId:       string;
  enrolledAt:     string; // ISO 8601 — when enrollContacts() was called
  requested:      number; // contactIds.length
  enrolled:       number; // newly written rows
  alreadyEnrolled: number; // submitted but skipped by ON CONFLICT
  rejected:       number; // failed re-validation (not submitted to DB)
  dryRun:         boolean;
  leads:          EnrolledLead[];
  rejections:     EnrollmentRejection[];
}

// ── Pure functions ─────────────────────────────────────────────────────────────

/**
 * Check whether a campaign can accept new enrollments.
 * Pure — no I/O.
 *
 * Called before per-contact re-validation to fail fast when the campaign is
 * inactive, not found, or belongs to a different client.
 */
export function validateEnrollmentPreconditions(
  campaign:  Pick<CampaignRow, "clientId" | "status"> | null,
  clientId:  string,
): { ok: true } | { ok: false; reason: string; detail: string } {
  if (campaign === null) {
    return {
      ok:     false,
      reason: "CAMPAIGN_NOT_FOUND",
      detail: "Campaign not found for this client.",
    };
  }
  if (campaign.clientId !== clientId) {
    return {
      ok:     false,
      reason: "CAMPAIGN_CLIENT_MISMATCH",
      detail: `Campaign belongs to client ${campaign.clientId}, not ${clientId}.`,
    };
  }
  const activatable = ["draft", "running"] as const;
  if (!activatable.includes(campaign.status as "draft" | "running")) {
    return {
      ok:     false,
      reason: "CAMPAIGN_NOT_ACTIVE",
      detail: `Campaign status '${campaign.status}' does not accept new enrollments. Must be 'draft' or 'running'.`,
    };
  }
  return { ok: true };
}

/**
 * Aggregate DB INSERT results and re-validation rejections into an EnrollmentResult.
 * Pure — no I/O.
 *
 * insertedRows contains only the contacts that were actually written (ON CONFLICT
 * skips are absent). The "already enrolled" count is derived from the difference
 * between toEnroll (submitted to DB) and insertedRows (returned from DB).
 */
export function buildEnrollmentResult(opts: {
  campaignId:    string;
  clientId:      string;
  contactIds:    string[];
  toEnroll:      string[];
  insertedRows:  Array<{ id: string; contactId: string; createdAt: string }>;
  rejections:    EnrollmentRejection[];
  enrolledAt:    Date;
  dryRun:        boolean;
}): EnrollmentResult {
  const insertedSet = new Set(opts.insertedRows.map((r) => r.contactId));

  const leads: EnrolledLead[] = opts.insertedRows.map((r) => ({
    contactId:      r.contactId,
    campaignLeadId: r.id,
    status:         "ready" as const,
    enrolledAt:     r.createdAt,
  }));

  const alreadyEnrolled = opts.toEnroll.filter((id) => !insertedSet.has(id)).length;

  return {
    campaignId:      opts.campaignId,
    clientId:        opts.clientId,
    enrolledAt:      opts.enrolledAt.toISOString(),
    requested:       opts.contactIds.length,
    enrolled:        opts.insertedRows.length,
    alreadyEnrolled,
    rejected:        opts.rejections.length,
    dryRun:          opts.dryRun,
    leads,
    rejections:      opts.rejections,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Re-validate and enroll a batch of contacts into a campaign.
 *
 * Data gathering — ~6 DB queries total, no N+1:
 *   [1] getCampaignById         — one query (client-scoped)
 *   [2] getContactsByIds        — one query (IN clause)
 *   [3] getAccountIntelligenceMap — one query (client-scoped IN clause)
 *   [4] getLatestEmailVerificationMap — one query (IN clause)
 *   [5] getSuppressionMap       — one query (client-scoped IN clause)
 *   [6] insertCampaignLeads     — one upsert (ON CONFLICT DO NOTHING)
 *
 * Step [6] is skipped when dryRun = true or all contacts fail re-validation.
 *
 * No emails sent. No provider API calls. No campaign status mutations.
 */
export async function enrollContacts(input: EnrollmentInput): Promise<EnrollmentResult> {
  const enrolledAt = new Date();
  const dryRun     = input.dryRun ?? false;

  // [1] Re-fetch campaign — fresh, client-scoped
  const campaign = await getCampaignById(input.clientId, input.campaignId);

  const precondition = validateEnrollmentPreconditions(campaign, input.clientId);
  if (!precondition.ok) {
    return buildEnrollmentResult({
      campaignId:   input.campaignId,
      clientId:     input.clientId,
      contactIds:   input.contactIds,
      toEnroll:     [],
      insertedRows: [],
      rejections:   input.contactIds.map((contactId) => ({
        contactId,
        reason: precondition.reason as EligibilityReason,
        detail: precondition.detail,
      })),
      enrolledAt,
      dryRun,
    });
  }

  if (input.contactIds.length === 0) {
    return buildEnrollmentResult({
      campaignId:   input.campaignId,
      clientId:     input.clientId,
      contactIds:   [],
      toEnroll:     [],
      insertedRows: [],
      rejections:   [],
      enrolledAt,
      dryRun,
    });
  }

  // [2] Re-fetch contacts by ID (batch)
  const contactMap = await getContactsByIds(input.contactIds);
  const foundContacts  = [...contactMap.values()];
  const companyIds     = [...new Set(foundContacts.map((c) => c.companyId))];

  // [3–5] Batch-fetch supporting data in parallel
  const [aiMap, verificationMap, suppressionMap] = await Promise.all([
    getAccountIntelligenceMap(input.clientId, companyIds),
    getLatestEmailVerificationMap(input.contactIds),
    getSuppressionMap(input.clientId, input.contactIds),
  ]);

  const now = enrolledAt;

  // Per-contact re-validation — pure, uses Stage 17 gates unchanged
  // existingEnrollment is passed as false: the DB UNIQUE constraint is the
  // authoritative duplicate guard. We don't do a SELECT-before-INSERT.
  // Contacts already enrolled appear in toEnroll, are submitted to the DB,
  // and are absent from insertedRows (ON CONFLICT DO NOTHING skips them).
  const toEnroll:   string[]               = [];
  const rejections: EnrollmentRejection[]  = [];

  for (const contactId of input.contactIds) {
    const contact  = contactMap.get(contactId) ?? null;
    const companyId = contact?.companyId ?? "";

    const result = evaluateCampaignEligibility({
      accountIntelligence: contact ? (aiMap.get(contact.companyId) ?? null) : null,
      contact,
      companyId,
      emailVerification:  verificationMap.get(contactId) ?? null,
      suppressionRecords: suppressionMap.get(contactId) ?? [],
      campaign:           campaign!,
      clientId:           input.clientId,
      existingEnrollment: false, // DB handles duplicates atomically
      now,
    });

    if (result.eligible) {
      toEnroll.push(contactId);
    } else {
      rejections.push({
        contactId,
        reason: result.reason!,
        detail: result.detail,
      });
    }
  }

  // [6] Batch INSERT — skipped on dryRun or when nothing to enroll
  let insertedRows: Array<{ id: string; contactId: string; createdAt: string }> = [];

  if (!dryRun && toEnroll.length > 0) {
    const nowStr = now.toISOString();
    insertedRows = await insertCampaignLeads(
      toEnroll.map((contactId) => ({
        campaignId: input.campaignId,
        contactId,
        clientId:   input.clientId,
        now:        nowStr,
      })),
    );
  }

  return buildEnrollmentResult({
    campaignId:   input.campaignId,
    clientId:     input.clientId,
    contactIds:   input.contactIds,
    toEnroll,
    insertedRows,
    rejections,
    enrolledAt,
    dryRun,
  });
}
