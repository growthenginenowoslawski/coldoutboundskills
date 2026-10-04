/**
 * Persistence layer for Stage 25 campaign readiness tables.
 *
 * Two tables (both defined in supabase/migrations/0020_campaign_readiness.sql,
 * NOT YET APPLIED to production as of Stage 25A):
 *
 *   campaign_readiness_assessments — immutable per-evaluation rows
 *   campaign_readiness_approvals   — immutable per-approval rows (is_stale excepted)
 *
 * ── Immutability model ────────────────────────────────────────────────────────
 *
 * Assessments are fully immutable once written. Never update an assessment row.
 * Approvals are immutable except for (is_stale, stale_reason), which are
 * updated only by the future activation orchestrator via markApprovalStale().
 *
 * ── Security invariants ───────────────────────────────────────────────────────
 *
 * - Assessments store contact UUIDs only (eligible_contact_ids uuid[]).
 * - contact_results JSONB contains contactId/companyId strings only — no emails.
 * - No provider credentials stored.
 *
 * ── Approval guard ───────────────────────────────────────────────────────────
 *
 * insertCampaignReadinessApproval() rejects approvals against HARD_BLOCKED
 * assessments. Hard blocks cannot be bypassed by human approval.
 */

import { getSupabaseAdmin } from "./supabase";
import type {
  CampaignReadinessAssessment,
  CampaignReadinessVerdict,
  ContactSummary,
} from "../domain/campaign-readiness-types";

const ASSESSMENT_TABLE = "campaign_readiness_assessments" as const;
const APPROVAL_TABLE   = "campaign_readiness_approvals"   as const;

// ── Row types ─────────────────────────────────────────────────────────────────

export interface CampaignReadinessAssessmentRow {
  id:                                   string;
  clientId:                             string;
  campaignId:                           string;
  campaignStrategyId:                   string | null;
  verdict:                              CampaignReadinessVerdict;
  campaignStatusAtEvaluation:           string;
  platformCampaignIdAtEvaluation:       string | null;
  hardBlockCodes:                       string[];
  warningCodes:                         string[];
  eligibleContactIds:                   string[];
  qualifiedCount:                       number;
  eligibleCount:                        number;
  blockedCount:                         number;
  enrolledCount:                        number;
  uploadedCount:                        number;
  backfilledCount:                      number;
  smtpHealthyInboxCount:                number;
  contactResults:                       unknown;  // jsonb — CampaignReadinessAssessment.contactResults
  evaluatedAt:                          string;
  createdAt:                            string;
}

export interface CampaignReadinessApprovalRow {
  id:                        string;
  assessmentId:              string;
  clientId:                  string;
  approvedBy:                string;
  approvedAt:                string;
  acknowledgedWarningCodes:  string[];
  notes:                     string | null;
  isStale:                   boolean;
  staleReason:               string | null;
  staleSetAt:                string | null;
  createdAt:                 string;
}

// ── Pure mappers ──────────────────────────────────────────────────────────────

export function fromAssessmentRow(
  row: Record<string, unknown>,
): CampaignReadinessAssessmentRow {
  return {
    id:                              row.id                                       as string,
    clientId:                        row.client_id                                as string,
    campaignId:                      row.campaign_id                              as string,
    campaignStrategyId:              (row.campaign_strategy_id as string | null)  ?? null,
    verdict:                         row.verdict                                  as CampaignReadinessVerdict,
    campaignStatusAtEvaluation:      row.campaign_status_at_evaluation            as string,
    platformCampaignIdAtEvaluation:  (row.platform_campaign_id_at_evaluation as string | null) ?? null,
    hardBlockCodes:                  (row.hard_block_codes as string[])           ?? [],
    warningCodes:                    (row.warning_codes    as string[])           ?? [],
    eligibleContactIds:              (row.eligible_contact_ids as string[])       ?? [],
    qualifiedCount:                  (row.qualified_count  as number)             ?? 0,
    eligibleCount:                   (row.eligible_count   as number)             ?? 0,
    blockedCount:                    (row.blocked_count    as number)             ?? 0,
    enrolledCount:                   (row.enrolled_count   as number)             ?? 0,
    uploadedCount:                   (row.uploaded_count   as number)             ?? 0,
    backfilledCount:                 (row.backfilled_count as number)             ?? 0,
    smtpHealthyInboxCount:           (row.smtp_healthy_inbox_count as number)     ?? 0,
    contactResults:                  row.contact_results,
    evaluatedAt:                     row.evaluated_at                             as string,
    createdAt:                       row.created_at                               as string,
  };
}

export function fromApprovalRow(
  row: Record<string, unknown>,
): CampaignReadinessApprovalRow {
  return {
    id:                       row.id                                          as string,
    assessmentId:             row.assessment_id                               as string,
    clientId:                 row.client_id                                   as string,
    approvedBy:               row.approved_by                                 as string,
    approvedAt:               row.approved_at                                 as string,
    acknowledgedWarningCodes: (row.acknowledged_warning_codes as string[])    ?? [],
    notes:                    (row.notes as string | null)                    ?? null,
    isStale:                  (row.is_stale as boolean)                       ?? false,
    staleReason:              (row.stale_reason as string | null)             ?? null,
    staleSetAt:               (row.stale_set_at as string | null)             ?? null,
    createdAt:                row.created_at                                  as string,
  };
}

// ── Writes ─────────────────────────────────────────────────────────────────────

/**
 * Persist an in-memory CampaignReadinessAssessment as an immutable DB row.
 *
 * Idempotency: UNIQUE(client_id, campaign_id, evaluated_at) — re-inserting
 * the same assessment at the same timestamp is silently skipped (returns null).
 *
 * Security: contact_results JSONB must not contain email addresses.
 * The evaluator enforces this — this layer trusts it.
 */
export async function insertCampaignReadinessAssessment(
  assessment: CampaignReadinessAssessment,
): Promise<CampaignReadinessAssessmentRow | null> {
  const row: Record<string, unknown> = {
    client_id:                           assessment.clientId,
    campaign_id:                         assessment.campaignId,
    campaign_strategy_id:                assessment.campaignStrategyId,
    verdict:                             assessment.verdict,
    campaign_status_at_evaluation:       assessment.campaignStatusAtEvaluation,
    platform_campaign_id_at_evaluation:  assessment.platformCampaignIdAtEvaluation,
    hard_block_codes:                    assessment.hardBlocks.map(b => b.code),
    warning_codes:                       assessment.warnings.map(w => w.code),
    eligible_contact_ids:                assessment.eligibleContactIds,
    qualified_count:                     assessment.qualifiedCount,
    eligible_count:                      assessment.contactSummary.eligibleCount,
    blocked_count:                       assessment.contactSummary.blockedCount,
    enrolled_count:                      assessment.contactSummary.enrolledCount,
    uploaded_count:                      assessment.contactSummary.uploadedCount,
    backfilled_count:                    assessment.contactSummary.backfilledCount,
    smtp_healthy_inbox_count:            assessment.smtpHealthyInboxCount,
    contact_results:                     JSON.stringify(assessment.contactResults),
    evaluated_at:                        assessment.evaluatedAt.toISOString(),
  };

  const { data, error } = await getSupabaseAdmin()
    .from(ASSESSMENT_TABLE)
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    // Unique constraint on (client_id, campaign_id, evaluated_at)
    if (error.code === "23505") return null;
    throw new Error(`insertCampaignReadinessAssessment failed: ${error.message}`);
  }

  if (!data) return null;
  return fromAssessmentRow(data as Record<string, unknown>);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns the most recent assessment for a (client, campaign) pair, or null.
 * Uses evaluated_at DESC to find the latest.
 */
export async function getLatestAssessmentForCampaign(
  clientId:   string,
  campaignId: string,
): Promise<CampaignReadinessAssessmentRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(ASSESSMENT_TABLE)
    .select("*")
    .eq("client_id",   clientId)
    .eq("campaign_id", campaignId)
    .order("evaluated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getLatestAssessmentForCampaign failed: ${error.message}`);
  if (!data) return null;
  return fromAssessmentRow(data as Record<string, unknown>);
}

/** Returns a specific assessment by ID, scoped to client. */
export async function getAssessmentById(
  clientId:     string,
  assessmentId: string,
): Promise<CampaignReadinessAssessmentRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(ASSESSMENT_TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("id",        assessmentId)
    .maybeSingle();

  if (error) throw new Error(`getAssessmentById failed: ${error.message}`);
  if (!data) return null;
  return fromAssessmentRow(data as Record<string, unknown>);
}

// ── Approval writes ───────────────────────────────────────────────────────────

export interface InsertApprovalInput {
  assessmentId:             string;
  clientId:                 string;
  approvedBy:               string;
  approvedAt:               Date;
  acknowledgedWarningCodes: string[];
  notes?:                   string;
}

/**
 * Records a human approval for a specific readiness assessment.
 *
 * Guard: throws if the referenced assessment has verdict = "HARD_BLOCKED".
 * Hard blocks cannot be bypassed by human approval — they require fixing
 * the underlying condition and re-running the assessment.
 *
 * Idempotency: UNIQUE(assessment_id) — one approval per assessment.
 * Re-approving the same assessment returns null (not an error).
 */
export async function insertCampaignReadinessApproval(
  input: InsertApprovalInput,
): Promise<CampaignReadinessApprovalRow | null> {
  // Guard: check verdict of the referenced assessment
  const assessment = await getAssessmentById(input.clientId, input.assessmentId);
  if (!assessment) {
    throw new Error(
      `insertCampaignReadinessApproval: assessment ${input.assessmentId} not found for client ${input.clientId}`,
    );
  }
  if (assessment.verdict === "HARD_BLOCKED") {
    throw new Error(
      `insertCampaignReadinessApproval: cannot approve a HARD_BLOCKED assessment (id=${input.assessmentId}). ` +
      `Fix the underlying hard blocks and re-run the readiness evaluation.`,
    );
  }

  const row: Record<string, unknown> = {
    assessment_id:              input.assessmentId,
    client_id:                  input.clientId,
    approved_by:                input.approvedBy,
    approved_at:                input.approvedAt.toISOString(),
    acknowledged_warning_codes: input.acknowledgedWarningCodes,
    notes:                      input.notes ?? null,
  };

  const { data, error } = await getSupabaseAdmin()
    .from(APPROVAL_TABLE)
    .insert(row)
    .select()
    .maybeSingle();

  if (error) {
    // UNIQUE(assessment_id) — already approved
    if (error.code === "23505") return null;
    throw new Error(`insertCampaignReadinessApproval failed: ${error.message}`);
  }

  if (!data) return null;
  return fromApprovalRow(data as Record<string, unknown>);
}

/**
 * Marks an approval as stale. Only the future activation orchestrator should call this.
 * Called when critical state has changed since the approval was granted.
 *
 * This is the only mutable operation in the readiness layer.
 */
export async function markApprovalStale(
  approvalId:  string,
  staleReason: string,
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(APPROVAL_TABLE)
    .update({ is_stale: true, stale_reason: staleReason, stale_set_at: new Date().toISOString() })
    .eq("id", approvalId);

  if (error) throw new Error(`markApprovalStale failed: ${error.message}`);
}

/** Returns the current approval for an assessment, or null. */
export async function getApprovalForAssessment(
  assessmentId: string,
): Promise<CampaignReadinessApprovalRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(APPROVAL_TABLE)
    .select("*")
    .eq("assessment_id", assessmentId)
    .maybeSingle();

  if (error) throw new Error(`getApprovalForAssessment failed: ${error.message}`);
  if (!data) return null;
  return fromApprovalRow(data as Record<string, unknown>);
}

// ── Pure guard (exported for testing) ────────────────────────────────────────

/**
 * Returns true when an assessment can receive a human approval.
 * Hard-blocked assessments cannot be approved — they require fixing.
 */
export function canApproveAssessment(assessment: { verdict: string }): boolean {
  return assessment.verdict !== "HARD_BLOCKED";
}
