/**
 * Persistence helpers for the `account_campaign_qualification` table — Stage 29.
 *
 * Stores the deterministic qualification result computed by
 * src/lib/account-qualification.ts for every (client_id, company_id,
 * campaign_strategy_id) triple.
 *
 * ── ARCHITECTURAL BOUNDARY ───────────────────────────────────────────────────
 *
 * Qualification is CAMPAIGN-SPECIFIC. The same company may qualify for one
 * campaign strategy and not another. This table is intentionally separate from
 * account_intelligence (per client/company), which stores campaign-agnostic
 * facts like Why Now readiness.
 *
 * Do NOT use account_intelligence for qualification storage.
 * See: Stage 29 Phase 1.5 architecture review.
 *
 * ── CONVENTIONS ──────────────────────────────────────────────────────────────
 *
 * - Pure row-builder and mapper functions are exported for testing without a DB.
 * - Async functions call getSupabaseAdmin() (service-role, bypasses RLS).
 * - Every read and write is scoped by client_id AND campaign_strategy_id —
 *   never just company_id alone. Defense-in-depth for tenant isolation.
 * - Upserts use the named constraint account_campaign_qualification_key on
 *   (client_id, company_id, campaign_strategy_id).
 * - DB trigger enforces that campaign_strategy_id belongs to client_id.
 *
 * ── ALL THRESHOLDS INITIAL_HYPOTHESIS_NOT_VALIDATED ──────────────────────────
 *
 * qualification_score weights and the qualified gate threshold are starting
 * hypotheses, not validated against campaign outcome data.
 * Preserve the hypothesis label — do not remove it from stored JSONB.
 */

import type { AccountQualificationResult } from "../domain/account-qualification-types";
import { getSupabaseAdmin } from "./supabase";

const TABLE = "account_campaign_qualification";

// ── Domain row type ───────────────────────────────────────────────────────────

/**
 * One row from account_campaign_qualification.
 * One row per (client_id, company_id, campaign_strategy_id).
 */
export interface AccountCampaignQualificationRow {
  id: string;
  clientId: string;
  companyId: string;
  campaignStrategyId: string;
  /**
   * True when no hard exclusion applies and qualificationScore >= threshold.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED — threshold is a starting hypothesis.
   * Distinct from account_intelligence.isReady (Why Now — campaign-agnostic).
   */
  qualified: boolean;
  /**
   * 0–100 evidence score.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED — dimension weights are starting hypotheses.
   * 0 when a hard exclusion applies.
   */
  qualificationScore: number;
  /**
   * Full AccountQualificationResult JSONB.
   * Contains: hypothesis (always "INITIAL_HYPOTHESIS_NOT_VALIDATED"), qualified,
   * qualificationScore, campaignStrategyId, exclusionReasons, geographyVerdict,
   * industryVerdict, sizeVerdict, hiringEvidenceVerdict, positiveEvidence,
   * negativeEvidence, missingInfo, warnings, assessedAt.
   */
  qualification: AccountQualificationResult;
  /** When computeAccountQualification() was last called. */
  qualificationAssessedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ── Pure row builders (exported for testing without a DB) ─────────────────────

/**
 * Maps an AccountQualificationResult into the DB column dict for an upsert.
 * Pure — no I/O; safe to test without a DB connection.
 *
 * Excludes `id` (DB generates via gen_random_uuid()) and `created_at`
 * (DB sets via DEFAULT now() on INSERT; must not be touched on UPDATE).
 *
 * `updated_at` is always set to `now` so every upsert refreshes the
 * write timestamp, making staleness detection reliable.
 *
 * `qualification_assessed_at` is taken from result.assessedAt so the
 * computation timestamp and the DB timestamp stay consistent even when
 * the caller passes a fixed `now` for deterministic testing.
 */
export function buildAccountQualificationRow(
  clientId: string,
  companyId: string,
  result: AccountQualificationResult,
  now: Date = new Date(),
): Record<string, unknown> {
  return {
    client_id:                 clientId,
    company_id:                companyId,
    campaign_strategy_id:      result.campaignStrategyId,
    qualified:                 result.qualified,
    qualification_score:       result.qualificationScore,
    qualification:             result,
    qualification_assessed_at: result.assessedAt,
    updated_at:                now.toISOString(),
  };
}

/**
 * Maps a raw DB row → AccountCampaignQualificationRow domain object.
 * Pure — no I/O; safe to test without a DB connection.
 *
 * qualification arrives as a parsed JSONB object from Supabase.
 * qualification_score arrives as integer — cast to number defensively.
 */
export function fromAccountCampaignQualificationRow(
  row: Record<string, unknown>,
): AccountCampaignQualificationRow {
  return {
    id:                      row.id as string,
    clientId:                row.client_id as string,
    companyId:               row.company_id as string,
    campaignStrategyId:      row.campaign_strategy_id as string,
    qualified:               row.qualified as boolean,
    qualificationScore:      Number(row.qualification_score),
    qualification:           row.qualification as AccountQualificationResult,
    qualificationAssessedAt: row.qualification_assessed_at as string,
    createdAt:               row.created_at as string,
    updatedAt:               row.updated_at as string,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Insert or update the qualification record for a (client, company,
 * campaign_strategy) triple.
 *
 * Uses the named unique constraint account_campaign_qualification_key on
 * (client_id, company_id, campaign_strategy_id):
 *   - INSERT on first call for this triple (DB sets `id` and `created_at`).
 *   - UPDATE qualified, qualification_score, qualification,
 *     qualification_assessed_at, and updated_at on subsequent calls.
 *     `created_at` is never touched.
 *
 * The DB trigger check_account_qualification_strategy_client enforces that
 * campaign_strategy_id belongs to the same client_id — cross-client inserts
 * will throw a DB-level exception which propagates as an Error here.
 *
 * Idempotent: calling twice with identical inputs produces one row.
 *
 * Client isolation: the triple is scoped to (clientId, companyId,
 * result.campaignStrategyId). All reads also scope by client_id so
 * no cross-client access is possible at the application layer.
 *
 * @param now  Override the wall-clock time for `updated_at`.
 *             Defaults to new Date(). Used in integration tests for determinism.
 */
export async function upsertAccountQualification(
  clientId: string,
  companyId: string,
  result: AccountQualificationResult,
  now: Date = new Date(),
): Promise<AccountCampaignQualificationRow> {
  const db  = getSupabaseAdmin();
  const row = buildAccountQualificationRow(clientId, companyId, result, now);

  const { data, error } = await db
    .from(TABLE)
    .upsert(row, {
      onConflict:       "client_id,company_id,campaign_strategy_id",
      ignoreDuplicates: false,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`upsertAccountQualification failed: ${error.message}`);
  }
  return fromAccountCampaignQualificationRow(data as Record<string, unknown>);
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the qualification record for a specific (client, company,
 * campaign_strategy) triple.
 *
 * Returns null when the company has not been qualified for this strategy yet.
 *
 * CRITICAL SCOPING: ALL THREE key columns are required in the WHERE clause.
 * A read for Strategy S1 must NEVER return the qualification for Strategy S2.
 * This function does not accept a compound key — callers must pass all three IDs.
 *
 * Client isolation: query is scoped to clientId. Cross-client reads return null.
 */
export async function getAccountQualificationForStrategy(
  clientId:           string,
  companyId:          string,
  campaignStrategyId: string,
): Promise<AccountCampaignQualificationRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id",           clientId)
    .eq("company_id",          companyId)
    .eq("campaign_strategy_id", campaignStrategyId)
    .maybeSingle();

  if (error) {
    throw new Error(`getAccountQualificationForStrategy failed: ${error.message}`);
  }
  if (!data) return null;
  return fromAccountCampaignQualificationRow(data as Record<string, unknown>);
}

/**
 * Fetch all qualification records for a campaign strategy.
 *
 * Used by Stage 25 to determine which companies in a list are qualified
 * for the campaign being evaluated.
 *
 * Optionally filter to qualified-only companies using the
 * account_campaign_qualification_qualified_idx partial index.
 *
 * Client isolation: query is scoped to clientId.
 * Campaign isolation: query is scoped to campaignStrategyId.
 *
 * @param opts.qualifiedOnly  When true, returns only rows where qualified=true.
 *                            Uses the partial index for efficient filtering.
 */
export async function listQualificationsForStrategy(
  clientId:           string,
  campaignStrategyId: string,
  opts: { qualifiedOnly?: boolean } = {},
): Promise<AccountCampaignQualificationRow[]> {
  let q = getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id",            clientId)
    .eq("campaign_strategy_id", campaignStrategyId);

  if (opts.qualifiedOnly) {
    q = q.eq("qualified", true);
  }

  const { data, error } = await q;
  if (error) {
    throw new Error(`listQualificationsForStrategy failed: ${error.message}`);
  }
  return (data ?? []).map((r) =>
    fromAccountCampaignQualificationRow(r as Record<string, unknown>),
  );
}

/**
 * Fetch all qualification records for a company across all strategies
 * for a given client.
 *
 * Used for auditing or reporting: "what campaigns has this company been
 * assessed for, and what were the results?"
 *
 * Client isolation: query is scoped to clientId.
 */
export async function listQualificationsForCompany(
  clientId:  string,
  companyId: string,
): Promise<AccountCampaignQualificationRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id",  clientId)
    .eq("company_id", companyId);

  if (error) {
    throw new Error(`listQualificationsForCompany failed: ${error.message}`);
  }
  return (data ?? []).map((r) =>
    fromAccountCampaignQualificationRow(r as Record<string, unknown>),
  );
}
