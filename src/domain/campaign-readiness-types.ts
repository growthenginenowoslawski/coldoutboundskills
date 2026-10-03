/**
 * Domain types for Stage 25 outreach readiness evaluation.
 *
 * Readiness is evaluated at two levels:
 *   - Contact level: CONTACT_UPLOAD_READY | CONTACT_BLOCKED
 *   - Campaign level: OUTREACH_READY | OUTREACH_READY_WITH_WARNINGS | HARD_BLOCKED
 *
 * Hard blocks (CB-* and XB-*) cannot be bypassed by human approval.
 * Warnings (W-*) are informational — human approval may acknowledge them.
 *
 * OUTREACH_READY and APPROVED_FOR_OUTREACH are distinct states:
 *   OUTREACH_READY        = all deterministic automated prerequisites pass
 *   APPROVED_FOR_OUTREACH = a human explicitly approved a specific readiness assessment
 *   (APPROVED_FOR_OUTREACH is managed by campaign_readiness_approvals, not this assessment)
 */

/** Campaign-level readiness verdict produced by evaluateOutreachReadiness(). */
export type CampaignReadinessVerdict =
  | "OUTREACH_READY"
  | "OUTREACH_READY_WITH_WARNINGS"
  | "HARD_BLOCKED";

/** Per-contact verdict within a readiness assessment. */
export type ContactReadinessVerdict =
  | "CONTACT_UPLOAD_READY"
  | "CONTACT_BLOCKED";

/**
 * Hard block codes — cannot be cleared by human approval.
 *
 * CB-* codes: contact-level blocks (one per blocked contact).
 * XB-* codes: campaign-level blocks.
 */
export type HardBlockCode =
  // ── Contact-level (CB) ────────────────────────────────────────────────────
  | "CB-01"  // Contact record not found in DB
  | "CB-02"  // Contact has no email address
  | "CB-03"  // Contact company does not match campaign list member
  | "CB-04"  // Email address is invalid (EMAIL_INVALID from email gate)
  | "CB-05"  // Email not verified (EMAIL_NOT_VERIFIED from email gate)
  | "CB-06"  // Email verification stale >90 days (EMAIL_VERIFICATION_STALE)
  | "CB-07"  // Contact is suppressed for this client
  | "CB-08"  // Opportunity score is zero (ACCOUNT_SCORE_ZERO from account gate)
  | "CB-09"  // Account intelligence not ready (is_ready = false — Stage 25 pre-check,
             //   NOT checked by Stage 17's evaluateAccountGate which only checks opportunityScore)
  | "CB-10"  // No account intelligence row (NO_ACCOUNT_INTELLIGENCE from account gate)
  // ── Campaign-level (XB) ───────────────────────────────────────────────────
  | "XB-01"  // Campaign not found or client mismatch
  | "XB-02"  // Campaign is in a terminal state (completed or cancelled)
  | "XB-03"  // No list assigned to campaign
  | "XB-04"  // No campaign strategy assigned
  | "XB-05"  // Provider credentials not configured
  | "XB-06"  // Zero healthy sending inboxes (SMTP)
  | "XB-07"  // All qualified contacts are hard-blocked (no eligible contacts remain)
  | "XB-08"  // No qualified contacts found in campaign list
  | "XB-09"  // No leads have a platform_lead_id (Stage 21A backfill not run)
  ;

/**
 * Warning codes — informational; do not block outreach.
 * Human approval may acknowledge warnings in campaign_readiness_approvals.
 *
 * Per-contact warnings appear in ContactReadinessResult.warnings.
 * Campaign-level warnings appear in CampaignReadinessAssessment.warnings.
 */
export type WarningCode =
  | "W-01"  // Email verification approaching staleness (>80 days, <90 days)
  | "W-02"  // Account readiness not yet assessed (is_ready = null)
  | "W-03"  // Opportunity score is low but positive (>0, <20) INITIAL_HYPOTHESIS_NOT_VALIDATED
  | "W-06"  // Some qualified contacts are blocked; ≥1 is still eligible
  | "W-07"  // Some list contacts have no contact_campaign_relevance record (Stage 23 not run)
  | "W-08"  // Campaign is in draft status (not yet in review/ready)
  | "W-09"  // Low healthy inbox count (>0 but below recommended minimum) INITIAL_HYPOTHESIS_NOT_VALIDATED
  | "W-11"  // Low backfilled lead count INITIAL_HYPOTHESIS_NOT_VALIDATED
  ;

export interface HardBlock {
  code: HardBlockCode;
  detail: string;
}

export interface Warning {
  code: WarningCode;
  detail: string;
}

/**
 * Per-contact result within a readiness assessment.
 *
 * Security invariants:
 *   - No email addresses (only contactId and companyId UUIDs)
 *   - No PII beyond UUIDs
 */
export interface ContactReadinessResult {
  contactId: string;
  companyId: string;
  verdict: ContactReadinessVerdict;
  /** Null when verdict is CONTACT_UPLOAD_READY. */
  blockCode: HardBlockCode | null;
  /** Human-readable block explanation. Null when verdict is CONTACT_UPLOAD_READY. */
  blockDetail: string | null;
  /**
   * Machine-readable reason from Stage 17's EligibilityResult.reason.
   * Null when blocked by CB-09 (Stage 25 pre-check) or when verdict is CONTACT_UPLOAD_READY.
   */
  eligibilityReason: string | null;
  /** Status in campaign_leads, or "NOT_ENROLLED" when no row exists. */
  enrollmentStatus: string;
  /** Provider-assigned lead ID, set when Stage 21A backfill has run. Null otherwise. */
  platformLeadId: string | null;
  /** Per-contact warnings — informational, do not block outreach. */
  warnings: Warning[];
}

/** Aggregate contact counts for a readiness assessment. */
export interface ContactSummary {
  /** Contacts that passed all eligibility gates and are ready for upload. */
  eligibleCount: number;
  /** Contacts that failed at least one gate. */
  blockedCount: number;
  /** Contacts currently enrolled (campaign_leads row exists). */
  enrolledCount: number;
  /** Contacts with status "uploaded". */
  uploadedCount: number;
  /** Contacts with a non-null platform_lead_id (Stage 21A backfill done). */
  backfilledCount: number;
}

/**
 * Complete in-memory readiness assessment produced by evaluateOutreachReadiness().
 *
 * This is the in-memory result. For persistence, use insertCampaignReadinessAssessment()
 * in src/db/campaign-readiness.ts.
 *
 * Security invariants (enforced by the evaluator):
 *   - No email addresses in any field (only contactId/companyId UUIDs)
 *   - No provider credentials in any field
 *   - No PII beyond UUIDs
 */
export interface CampaignReadinessAssessment {
  clientId: string;
  campaignId: string;
  /** Effective strategy used for qualification filtering. Null when no strategy is assigned. */
  campaignStrategyId: string | null;
  /** campaign.status at the moment of evaluation. */
  campaignStatusAtEvaluation: string;
  /** campaign.platformCampaignId at the moment of evaluation. */
  platformCampaignIdAtEvaluation: string | null;

  verdict: CampaignReadinessVerdict;
  /** Campaign-level hard blocks. Empty when verdict is not HARD_BLOCKED. */
  hardBlocks: HardBlock[];
  /** Campaign-level warnings (includes aggregated contact-level warning codes). */
  warnings: Warning[];

  /** Contacts that passed Stage 23 qualification (isPersonQualified = true). */
  qualifiedCount: number;
  contactSummary: ContactSummary;
  smtpHealthyInboxCount: number;

  /** UUIDs of contacts that passed all gates. No email addresses. */
  eligibleContactIds: string[];
  /** Per-contact detail. No email addresses, no PII beyond UUIDs. */
  contactResults: ContactReadinessResult[];

  evaluatedAt: Date;
}
