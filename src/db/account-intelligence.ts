/**
 * Persistence layer for the `account_intelligence` table — Stage 12.
 *
 * Stores the deterministic opportunity score computed by
 * src/lib/opportunity-scoring.ts for every (client_id, company_id) pair.
 *
 * Conventions match the rest of src/db/:
 *   - Pure row-builder functions exported for testing without a DB.
 *   - Async functions call getSupabaseAdmin() (service-role, bypasses RLS).
 *   - Every read and write is scoped by client_id (defense-in-depth for tenant
 *     isolation — RLS policies are blocked pending auth/tenant-mapping design;
 *     see docs/supabase/25-SUPABASE-SECURITY.md).
 *
 * Two opportunity scores coexist in the system (known naming collision):
 *   account_intelligence.opportunity_score  — THIS module; deterministic
 *   enrichment_runs.output_data.opportunityScore — AI analytical estimate
 * This module does not read or write the AI field.
 */

import type { OpportunityScoreResult } from "../lib/opportunity-scoring";
import type { WhyNowAssessment } from "../domain/signal-types";
import { getSupabaseAdmin } from "./supabase";

const TABLE = "account_intelligence";

// ── Domain type ───────────────────────────────────────────────────────────────

export interface AccountIntelligenceRow {
  id: string;
  clientId: string;
  companyId: string;
  /**
   * 0-100 deterministic opportunity score.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED — formula weights have not been
   * validated against campaign outcome data.
   */
  opportunityScore: number;
  /** ISO timestamp — when opportunityScore was last computed. */
  opportunityScoreUpdatedAt: string;
  /**
   * Full scoring breakdown from computeOpportunityScore().
   * Null only for rows written before score_inputs was implemented.
   * After a successful upsert this should always be non-null.
   */
  scoreInputs: OpportunityScoreResult | null;
  /**
   * Time-decayed priority score. opportunityScore × recency_multiplier.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED — half-life constant not validated.
   * Null until the first Stage 14 prioritisation run touches this row.
   * Zero means the account has been prioritised and has no active signals.
   * Distinct from opportunityScore — decays daily without new signals.
   */
  priorityScore: number | null;
  /**
   * When priorityScore was last calculated.
   * This is the calculation timestamp, NOT a guarantee that the score is current.
   * priorityScore decays continuously with time — the scheduled task recomputes it daily.
   * Null when priorityScore is null.
   */
  prioritizedAt: string | null;
  /**
   * Full Why Now assessment — deterministic evidence + readiness gate + AI narrative.
   * Stage 22. Null until the first assessWhyNow() run for this (client, company) pair.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED — readiness thresholds are unvalidated hypotheses.
   */
  whyNow: WhyNowAssessment | null;
  /**
   * True when the account passes the deterministic readiness gate.
   * Promoted from why_now->ready to enable fast indexed filtering.
   * Null until the first Stage 22 run. False = assessed but not ready.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED.
   */
  isReady: boolean | null;
  /**
   * When the readiness gate was last evaluated.
   * NOT a freshness guarantee — new signals may have changed readiness since.
   * Null when isReady is null (not yet assessed).
   */
  readinessAssessedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Pure row-builders (exported for testing) ──────────────────────────────────

/**
 * Maps scoring inputs → DB row dict for account_intelligence.
 * Pure — no I/O; safe to test without a DB.
 *
 * Excludes `id` (DB generates via gen_random_uuid()) and `created_at`
 * (DB sets via DEFAULT now() on INSERT; must not be touched on UPDATE).
 *
 * `updated_at` is always set to `now` so every upsert refreshes the
 * write timestamp, making staleness detection reliable.
 *
 * `opportunity_score_updated_at` is taken from scoreResult.computedAt
 * so the scoring timestamp and the DB timestamp stay consistent even
 * when the caller passes a fixed `now` for deterministic testing.
 */
export function buildAccountIntelligenceRow(
  clientId: string,
  companyId: string,
  scoreResult: OpportunityScoreResult,
  now: Date = new Date(),
): Record<string, unknown> {
  return {
    client_id:                    clientId,
    company_id:                   companyId,
    opportunity_score:            scoreResult.finalScore,
    opportunity_score_updated_at: scoreResult.computedAt,
    score_inputs:                 scoreResult,
    updated_at:                   now.toISOString(),
  };
}

/**
 * Maps a raw DB row → AccountIntelligenceRow domain object.
 * Pure — no I/O; safe to test without a DB.
 *
 * score_inputs arrives as a parsed JSONB object from Supabase; we cast it
 * to OpportunityScoreResult and accept null for pre-Stage-12 rows.
 */
export function fromAccountIntelligenceRow(
  row: Record<string, unknown>,
): AccountIntelligenceRow {
  return {
    id:                        row.id as string,
    clientId:                  row.client_id as string,
    companyId:                 row.company_id as string,
    opportunityScore:          row.opportunity_score as number,
    opportunityScoreUpdatedAt: row.opportunity_score_updated_at as string,
    scoreInputs:               (row.score_inputs as OpportunityScoreResult | null) ?? null,
    priorityScore:             (row.priority_score as number | null) ?? null,
    prioritizedAt:             (row.prioritized_at as string | null) ?? null,
    whyNow:                    (row.why_now as WhyNowAssessment | null) ?? null,
    isReady:                   (row.is_ready as boolean | null) ?? null,
    readinessAssessedAt:       (row.readiness_assessed_at as string | null) ?? null,
    createdAt:                 row.created_at as string,
    updatedAt:                 row.updated_at as string,
  };
}

// ── Async persistence ─────────────────────────────────────────────────────────

/**
 * Insert or update the account intelligence record for a (client, company) pair.
 *
 * Uses the named unique constraint `account_intelligence_client_company_key`
 * (client_id, company_id) for conflict resolution:
 *   - INSERT on first call for this pair (DB sets `id` and `created_at`).
 *   - UPDATE opportunity_score, opportunity_score_updated_at, score_inputs,
 *     and updated_at on subsequent calls. `created_at` is never touched.
 *
 * Client isolation: the row is scoped to clientId. All reads also scope by
 * client_id so no cross-client access is possible at the application layer.
 *
 * @param now  Override the wall-clock time for the updated_at column.
 *             Defaults to new Date(). Used in integration tests for determinism.
 */
export async function upsertAccountIntelligence(
  clientId: string,
  companyId: string,
  scoreResult: OpportunityScoreResult,
  now: Date = new Date(),
): Promise<AccountIntelligenceRow> {
  const db = getSupabaseAdmin();
  const row = buildAccountIntelligenceRow(clientId, companyId, scoreResult, now);

  const { data, error } = await db
    .from(TABLE)
    .upsert(row, { onConflict: "client_id,company_id" })
    .select()
    .single();

  if (error) {
    throw new Error(`upsertAccountIntelligence failed: ${error.message}`);
  }
  return fromAccountIntelligenceRow(data as Record<string, unknown>);
}

/**
 * Fetch the account intelligence record for a (client, company) pair.
 * Returns null when no record has been computed yet.
 *
 * Always scopes by clientId — no cross-client access.
 */
export async function getAccountIntelligence(
  clientId: string,
  companyId: string,
): Promise<AccountIntelligenceRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    throw new Error(`getAccountIntelligence failed: ${error.message}`);
  }
  if (!data) return null;
  return fromAccountIntelligenceRow(data as Record<string, unknown>);
}

/**
 * Fetch the top N accounts for a client ordered by opportunity_score descending.
 * Uses the account_intelligence_client_score_idx covering index.
 *
 * Always scopes by clientId — no cross-client access.
 *
 * @param opts.limit  Maximum rows to return. Defaults to 50.
 */
export async function getTopAccountsByScore(
  clientId: string,
  opts: { limit?: number } = {},
): Promise<AccountIntelligenceRow[]> {
  const limit = opts.limit ?? 50;

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("opportunity_score", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`getTopAccountsByScore failed: ${error.message}`);
  }
  return (data as Record<string, unknown>[]).map(fromAccountIntelligenceRow);
}

/**
 * Fetch all account intelligence records for a client, ordered by score desc.
 * For large datasets, prefer getTopAccountsByScore with a limit.
 *
 * Always scopes by clientId — no cross-client access.
 */
export async function getAllAccountIntelligence(
  clientId: string,
): Promise<AccountIntelligenceRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("opportunity_score", { ascending: false });

  if (error) {
    throw new Error(`getAllAccountIntelligence failed: ${error.message}`);
  }
  return (data as Record<string, unknown>[]).map(fromAccountIntelligenceRow);
}

// ── Ranked account readout — Stage 12, Step 7 ─────────────────────────────────

/**
 * Company identity subset joined onto each ranked account entry.
 * Exported so callers can construct the companyMap for buildRankedEntries
 * in tests without a DB.
 */
export interface CompanyIdentity {
  name:       string;
  domain:     string | null;
  websiteUrl: string | null;
}

/**
 * One entry in the ranked account list.
 *
 * Combines account_intelligence with company identity fields so callers can
 * answer "which accounts deserve the most attention?" without a second lookup.
 *
 * Score breakdown fields (signalCount, excludedSignalCount, icpScore) are
 * promoted from score_inputs for quick access. The full scoreInputs JSONB
 * is also included for auditability — every contributing signal is traceable
 * by signalId back to the signals table.
 *
 * ── Staleness ─────────────────────────────────────────────────────────────────
 *
 * opportunityScoreUpdatedAt is the canonical staleness indicator.
 * Stage 12 defines NO freshness threshold for the account record itself —
 * individual signals have their own TTL but the aggregate score does not.
 * The caller is responsible for deciding whether the score is acceptably
 * fresh. The account_intelligence_staleness_idx index supports queries of
 * the form "find accounts not scored in the last N hours."
 *
 * A score whose opportunityScoreUpdatedAt predates recent signal ingestion
 * is not wrong, but it does not reflect signals ingested after that time.
 * Use rescoreCompany() (src/lib/score-recompute.ts) to refresh it.
 *
 * ── What is intentionally excluded ───────────────────────────────────────────
 *
 * No Why Now, no contact prioritisation, no readiness, no outbound fields,
 * no AI scoring. This is purely the deterministic signal-based score layer.
 */
export interface RankedAccountEntry {
  // ── Account intelligence identity ─────────────────────────────────────
  /** account_intelligence.id — UUID of the intelligence record itself. */
  id:        string;
  clientId:  string;
  companyId: string;

  // ── Opportunity score ──────────────────────────────────────────────────
  /**
   * 0–100 deterministic score.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED — weights are starting hypotheses,
   * not commercially validated values.
   */
  opportunityScore: number;

  /**
   * When opportunityScore was last computed (ISO 8601).
   *
   * No freshness threshold is defined in Stage 12 — the caller decides
   * whether this score is acceptably recent. Surfaced here explicitly so
   * stale scores are never silently presented as current.
   */
  opportunityScoreUpdatedAt: string;

  // ── Score breakdown (promoted from score_inputs) ───────────────────────
  /**
   * Number of active, non-expired signals that contributed to the score.
   * Null only for rows that pre-date Stage 12 (no score_inputs stored).
   */
  signalCount: number | null;

  /**
   * Count of signals excluded by the two-guard filter at scoring time:
   *   (1) status !== "active"   — DB-authoritative; signal was expired/dismissed
   *   (2) isExpired(expiresAt)  — race-condition guard for signals past TTL
   *       whose status hadn't been updated by expireStaleSignals yet.
   * Null only for pre-Stage-12 rows.
   */
  excludedSignalCount: number | null;

  /**
   * Global companies.icp_score used in this scoring computation (0–100).
   * TEMPORARY COMPROMISE: global across clients — reflects the last
   * qualification run writer when multiple clients target the same company.
   * Null only for pre-Stage-12 rows.
   */
  icpScore: number | null;

  /**
   * Full scoring breakdown — every contributing signal listed by UUID.
   * Null only for pre-Stage-12 rows. Use this for auditability.
   */
  scoreInputs: OpportunityScoreResult | null;

  // ── Company identity (from companies table) ────────────────────────────
  /** Company name. Falls back to "[company:<uuid>]" if company row missing. */
  companyName:       string;
  companyDomain:     string | null;
  companyWebsiteUrl: string | null;
}

/**
 * Build RankedAccountEntry[] from account_intelligence rows and a company map.
 * Pure — no I/O. Exported for testing.
 *
 * Preserves the input order of aiRows — ranking is the DB query's responsibility.
 * When a companyId has no entry in companyMap (unexpected given FK cascade, but
 * guarded defensively), companyName falls back to a diagnostic string so the
 * entry remains inspectable rather than dropping silently.
 */
export function buildRankedEntries(
  aiRows: AccountIntelligenceRow[],
  companyMap: Map<string, CompanyIdentity>,
): RankedAccountEntry[] {
  return aiRows.map((row) => {
    const company = companyMap.get(row.companyId);
    return {
      id:                        row.id,
      clientId:                  row.clientId,
      companyId:                 row.companyId,
      opportunityScore:          row.opportunityScore,
      opportunityScoreUpdatedAt: row.opportunityScoreUpdatedAt,
      signalCount:               row.scoreInputs?.signalCount        ?? null,
      excludedSignalCount:       row.scoreInputs?.excludedSignalCount ?? null,
      icpScore:                  row.scoreInputs?.icpScore            ?? null,
      scoreInputs:               row.scoreInputs,
      companyName:               company?.name       ?? `[company:${row.companyId}]`,
      companyDomain:             company?.domain     ?? null,
      companyWebsiteUrl:         company?.websiteUrl ?? null,
    };
  });
}

/**
 * Fetch ranked account intelligence for a client, enriched with company identity.
 *
 * Ranking:
 *   PRIMARY   — opportunity_score DESC (highest-scoring accounts first)
 *   TIE-BREAK — company_id ASC (deterministic UUID ordering for equal scores)
 *
 * The two-query approach (AI rows → company IN query → merge) avoids N+1 and
 * does not rely on PostgREST embedding syntax.
 *
 * Client isolation: all DB queries scope to clientId.
 *
 * @param opts.limit  Maximum entries returned. Defaults to 50.
 *                    Use a higher limit or getAllAccountIntelligence() for full
 *                    portfolios; the default is sized for a dashboard call.
 */
export async function getRankedAccounts(
  clientId: string,
  opts: { limit?: number } = {},
): Promise<RankedAccountEntry[]> {
  const limit = opts.limit ?? 50;
  const db    = getSupabaseAdmin();

  // Query 1: ranked AI rows, using account_intelligence_client_score_idx.
  // Secondary ordering by company_id ASC provides a stable tie-breaker for
  // accounts with identical opportunity scores.
  const { data: aiData, error: aiErr } = await db
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .order("opportunity_score", { ascending: false })
    .order("company_id",        { ascending: true })
    .limit(limit);

  if (aiErr) throw new Error(`getRankedAccounts failed: ${aiErr.message}`);
  if (!aiData || (aiData as unknown[]).length === 0) return [];

  const aiRows = (aiData as Record<string, unknown>[]).map(fromAccountIntelligenceRow);

  // Query 2: company identity for the returned rows — single IN() to avoid N+1.
  const companyIds = aiRows.map((r) => r.companyId);
  const { data: companyData, error: companyErr } = await db
    .from("companies")
    .select("id, name, domain, website_url")
    .in("id", companyIds);

  if (companyErr) {
    throw new Error(`getRankedAccounts company fetch failed: ${companyErr.message}`);
  }

  type CompanyRow = { id: string; name: string; domain: string | null; website_url: string | null };
  const companyMap = new Map<string, CompanyIdentity>();
  for (const c of (companyData as CompanyRow[] ?? [])) {
    companyMap.set(c.id, {
      name:       c.name,
      domain:     c.domain      ?? null,
      websiteUrl: c.website_url ?? null,
    });
  }

  return buildRankedEntries(aiRows, companyMap);
}

// ── Why Now persistence — Stage 22 ───────────────────────────────────────────

/**
 * Write the Why Now assessment to account_intelligence.
 *
 * Updates three columns atomically:
 *   why_now               — the full WhyNowAssessment JSONB
 *   is_ready              — promoted from assessment.ready for fast filtering
 *   readiness_assessed_at — the calculation timestamp (not a freshness guarantee)
 *
 * This is a targeted UPDATE — it does NOT touch opportunity_score, score_inputs,
 * priority_score, or any other column. The Stage 12/13 and Stage 14 columns are
 * owned by their respective tasks.
 *
 * The row is guaranteed to exist: assessWhyNow() only calls this function when
 * an account_intelligence row was found. Throws if the UPDATE finds no matching row
 * (defensive guard for unexpected state).
 *
 * Client isolation: both .eq('client_id') and .eq('company_id') are required —
 * the WHERE clause always scopes to a single (client, company) pair.
 *
 * @param now  The wall-clock time for readiness_assessed_at and updated_at.
 */
export async function setWhyNow(
  clientId: string,
  companyId: string,
  assessment: WhyNowAssessment,
  now: Date = new Date(),
): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({
      why_now:               assessment,
      is_ready:              assessment.ready,
      readiness_assessed_at: now.toISOString(),
      updated_at:            now.toISOString(),
    })
    .eq("client_id", clientId)
    .eq("company_id", companyId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`setWhyNow failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `setWhyNow found no row for client=${clientId} company=${companyId}. ` +
      "Run signal ingestion first to create the account_intelligence row.",
    );
  }
}

/**
 * Fetch ready accounts for a client, ordered by priority_score DESC.
 *
 * Uses the account_intelligence_ready_priority_idx covering index
 * (partial index on is_ready=true).
 *
 * Returns accounts where is_ready=true. Accounts not yet assessed (is_ready IS NULL)
 * and non-ready accounts (is_ready=false) are excluded.
 *
 * Client isolation: scoped to clientId. No cross-client access.
 *
 * @param opts.limit  Maximum rows to return. Defaults to 50.
 */
export async function getReadyAccounts(
  clientId: string,
  opts: { limit?: number } = {},
): Promise<AccountIntelligenceRow[]> {
  const limit = opts.limit ?? 50;

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("client_id", clientId)
    .eq("is_ready", true)
    .order("priority_score", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(`getReadyAccounts failed: ${error.message}`);
  }
  return (data as Record<string, unknown>[]).map(fromAccountIntelligenceRow);
}

// ── Priority score persistence — Stage 14 ────────────────────────────────────

/**
 * Write priority_score and prioritized_at for a single (client, company) pair.
 *
 * This is a targeted UPDATE — it does NOT touch opportunity_score, score_inputs,
 * or any other column. The two columns are conceptually owned by the Stage 14
 * prioritisation task; the opportunity-score columns are owned by Stage 12/13.
 *
 * The row is guaranteed to exist because rankAccountsForClient() reads from
 * account_intelligence before this function is called. Throws if the update
 * finds no matching row (defensive guard for unexpected state).
 *
 * Client isolation: both .eq('client_id') and .eq('company_id') are required —
 * the WHERE clause always scopes to a single (client, company) pair.
 *
 * @param prioritizedAt  ISO timestamp — the wall-clock time of the prioritisation
 *                       run. Stored for auditability, NOT as a freshness guarantee.
 */
export async function setPriorityScore(
  clientId: string,
  companyId: string,
  priorityScore: number,
  prioritizedAt: string,
): Promise<void> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update({
      priority_score: priorityScore,
      prioritized_at: prioritizedAt,
      updated_at:     prioritizedAt,
    })
    .eq("client_id", clientId)
    .eq("company_id", companyId)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`setPriorityScore failed: ${error.message}`);
  }
  if (!data) {
    throw new Error(
      `setPriorityScore found no row for client=${clientId} company=${companyId}`,
    );
  }
}
