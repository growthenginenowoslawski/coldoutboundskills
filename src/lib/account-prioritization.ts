/**
 * Account prioritization — Stage 14.
 *
 * Answers "which tracked accounts should we act on today?" by applying a
 * time-based recency decay to each account's opportunity_score.
 *
 *   priority_score = opportunity_score × recency_multiplier
 *   recency_multiplier = 2^(−daysSinceLastSignal / PRIORITY_RECENCY_HALF_LIFE_DAYS)
 *                      = exp(−ln(2) × daysSinceLastSignal / PRIORITY_RECENCY_HALF_LIFE_DAYS)
 *
 * At days = HALF_LIFE: recency_multiplier = 0.5 (priority halves exactly).
 * Returns 0 when there are no active signals (daysSinceLastSignal is null).
 *
 * ── Conceptual separation ─────────────────────────────────────────────────────
 *
 *   Raw signal data (signals table)
 *     ↓ normalizeBatch + upsertSignal + rescoreCompany
 *   opportunity_score (account_intelligence)
 *     = ICP fit × signal quality
 *     = time-invariant within a signal's TTL
 *     = set by Stage 12/13
 *     ↓ × recency_multiplier
 *   priority_score (account_intelligence)
 *     = how actionable is this account RIGHT NOW?
 *     = decays daily as signals age
 *     = must be recomputed on every prioritisation run
 *     = set by Stage 14
 *
 * ── HALF_LIFE constant ────────────────────────────────────────────────────────
 *
 * PRIORITY_RECENCY_HALF_LIFE_DAYS = 14 is INITIAL_HYPOTHESIS_NOT_VALIDATED.
 * At this many days without a new signal, priority_score = opportunity_score × 0.5.
 * This value has not been validated against campaign outcome data.
 * It is a named constant — change it to adjust how aggressively priority decays.
 *
 * ── prioritized_at is not a freshness guarantee ───────────────────────────────
 *
 * prioritized_at records when priority_score was computed. It does NOT mean the
 * score is still current. priority_score changes as time passes even when no
 * new signals arrive, because daysSinceLastSignal increases every day.
 * The scheduled prioritisation task must recompute it daily using current time.
 *
 * ── Excluded by design ────────────────────────────────────────────────────────
 *
 *   No Why Now, no contact discovery, no personalization, no outbound.
 *   No AI, no new signal providers.
 *   No stored rank — rank is computed at query time via ORDER BY priority_score DESC.
 *   No campaign/contact state.
 *   No account cooldown or suppression logic.
 */

import { getSupabaseAdmin } from "../db/supabase";
import { setPriorityScore }  from "../db/account-intelligence";

// ── Named constant ─────────────────────────────────────────────────────────────

/**
 * INITIAL_HYPOTHESIS_NOT_VALIDATED.
 *
 * Number of days after which priority_score decays to 50% of opportunity_score,
 * assuming no new signals arrive. Based on the exponential decay formula:
 *
 *   recency_multiplier = exp(−days / PRIORITY_RECENCY_HALF_LIFE_DAYS)
 *
 * At days = 14: recency_multiplier ≈ 0.5  → priority halved
 * At days = 28 (2× half-life): recency_multiplier = 0.25 exactly
 * At days =  7: recency_multiplier ≈ 0.71 (2^−0.5)
 *
 * Change this constant to adjust decay speed without changing any formula logic.
 * A smaller value = faster decay (more aggressive recency weighting).
 * A larger value  = slower decay (more forgiving of older signals).
 */
export const PRIORITY_RECENCY_HALF_LIFE_DAYS = 14; // INITIAL_HYPOTHESIS_NOT_VALIDATED

// ── Types ──────────────────────────────────────────────────────────────────────

/** Per-account result from a prioritisation run. Rank is 1-indexed and computed at call time — never stored. */
export interface AccountPriorityResult {
  /**
   * 1-based position in the client's ranked account list. 1 = highest priority.
   * Computed at call time from the sorted priority_score values.
   * NOT stored in the database — call rankAccountsForClient() to obtain a rank.
   */
  rank: number;
  companyId: string;
  domain: string | null;
  /**
   * ICP fit × signal quality, from account_intelligence.opportunity_score.
   * Time-invariant within a signal's TTL — set by Stage 12/13.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED.
   */
  opportunityScore: number;
  /**
   * opportunity_score × recency_multiplier.
   * Changes as time passes without new signals — must be recomputed daily.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED.
   */
  priorityScore: number;
  /**
   * exp(−daysSinceLastSignal / halfLifeDays). Range [0, 1].
   * Included for observability — shows how the decay was applied.
   * 0 when there are no active signals.
   */
  recencyMultiplier: number;
  /** ISO timestamp of the most recent active signal for this (client, company). Null if no active signals. */
  lastSignalAt: string | null;
  /**
   * Fractional days between lastSignalAt and the `now` value used for ranking.
   * Null when lastSignalAt is null (no active signals).
   */
  daysSinceLastSignal: number | null;
  /** Count of active signals for this (client, company) pair at ranking time. */
  activeSignalCount: number;
}

/** Input to buildPrioritizationReport — extracted for pure unit-testability. */
export interface PrioritizationReportInput {
  clientId: string;
  startedAt: Date;
  completedAt: Date;
  topN: number;
  halfLifeDays: number;
  accounts: AccountPriorityResult[];
}

/** Structured output of one prioritisation run. Stored in jobs.output_data. */
export interface PrioritizationReport {
  clientId: string;
  startedAt: string;
  completedAt: string;
  /** Total accounts ranked — all tracked accounts for this client, regardless of score. */
  accountsRanked: number;
  /** Accounts where priority_score > 0 (have at least one active signal). */
  accountsWithScore: number;
  /** Accounts where priority_score = 0 (no active signals, or opportunity_score = 0). */
  accountsAtZero: number;
  /**
   * Top N accounts by priority_score.
   * N is determined by the topN option (default 20).
   * All accounts are stored in account_intelligence.priority_score regardless of topN.
   */
  topAccounts: AccountPriorityResult[];
  /**
   * The HALF_LIFE constant used for this run.
   * INITIAL_HYPOTHESIS_NOT_VALIDATED.
   * Stored for auditability: if the constant changes in future runs,
   * historical reports remain interpretable.
   */
  halfLifeDays: number;
}

// ── Pure functions (exported for unit tests) ──────────────────────────────────

/**
 * Compute the fractional days elapsed between a signal timestamp and now.
 * Pure — no I/O.
 */
export function computeDaysSince(lastSignalAt: string, now: Date): number {
  const msElapsed = now.getTime() - new Date(lastSignalAt).getTime();
  return msElapsed / (1000 * 60 * 60 * 24);
}

/**
 * Compute the time-decayed priority score for one account.
 *
 * priority_score = opportunity_score × 2^(−daysSinceLastSignal / halfLifeDays)
 *
 * Returns { priorityScore: 0, recencyMultiplier: 0 } when:
 *   - daysSinceLastSignal is null (no active signals exist), OR
 *   - opportunityScore is 0 (ICP fit or signal quality is zero).
 *
 * Pure — no I/O, deterministic for given inputs.
 *
 * @param opportunityScore  ICP fit × signal quality (0–100). From account_intelligence.
 * @param daysSinceLastSignal  Fractional days since the most recent active signal.
 *                             null means no active signals.
 * @param halfLifeDays  Recency half-life. Defaults to PRIORITY_RECENCY_HALF_LIFE_DAYS (14).
 *                      INITIAL_HYPOTHESIS_NOT_VALIDATED.
 */
export function computePriorityScore(
  opportunityScore: number,
  daysSinceLastSignal: number | null,
  halfLifeDays: number = PRIORITY_RECENCY_HALF_LIFE_DAYS,
): { priorityScore: number; recencyMultiplier: number } {
  if (daysSinceLastSignal === null || opportunityScore === 0) {
    return { priorityScore: 0, recencyMultiplier: 0 };
  }
  // True half-life decay: multiplier = 2^(-days/halfLifeDays) = exp(-ln(2) × days/halfLifeDays).
  // At days = halfLifeDays: multiplier = 0.5 exactly (priority halves at the half-life).
  // At days = 2 × halfLifeDays: multiplier = 0.25 (priority quarters at double the half-life).
  const recencyMultiplier = Math.exp(-Math.LN2 * daysSinceLastSignal / halfLifeDays);
  const priorityScore     = opportunityScore * recencyMultiplier;
  return { priorityScore, recencyMultiplier };
}

/**
 * Build a PrioritizationReport from pre-computed ranked accounts.
 * Pure — no I/O. Exported for unit tests.
 *
 * Slices accounts to topN for the report's topAccounts field. The full
 * accounts array is available to the task function for DB persistence —
 * priority_score is written for ALL accounts, not just the top N.
 */
export function buildPrioritizationReport(
  input: PrioritizationReportInput,
): PrioritizationReport {
  const accountsWithScore = input.accounts.filter((a) => a.priorityScore > 0).length;
  const accountsAtZero    = input.accounts.filter((a) => a.priorityScore === 0).length;

  return {
    clientId:         input.clientId,
    startedAt:        input.startedAt.toISOString(),
    completedAt:      input.completedAt.toISOString(),
    accountsRanked:   input.accounts.length,
    accountsWithScore,
    accountsAtZero,
    topAccounts:      input.accounts.slice(0, input.topN),
    halfLifeDays:     input.halfLifeDays,
  };
}

// ── Coordinator options ────────────────────────────────────────────────────────

export interface RankAccountsOptions {
  /**
   * Override the current time for deterministic tests.
   * Defaults to new Date() at function start.
   * All recency calculations for the run use this single timestamp.
   */
  now?: Date;
  /**
   * Half-life in days for the recency decay.
   * Defaults to PRIORITY_RECENCY_HALF_LIFE_DAYS (14).
   * INITIAL_HYPOTHESIS_NOT_VALIDATED.
   */
  halfLifeDays?: number;
}

// ── Async coordinator ──────────────────────────────────────────────────────────

/**
 * Rank all tracked accounts for a client by their time-decayed priority score.
 *
 * Steps:
 *   1. Read all account_intelligence rows for this client.
 *   2. Read all active signals for those companies (for recency computation).
 *   3. Read company domains (for the result struct).
 *   4. Compute priority_score per account using computePriorityScore().
 *   5. Sort: priority_score DESC, then company_id ASC (tie-break for stability).
 *   6. Assign ranks (1-indexed).
 *
 * Returns an empty array when the client has no tracked accounts.
 *
 * Client isolation: all DB queries scope to clientId. No cross-client data
 * is read or written.
 *
 * Does NOT write to the database — the task function calls setPriorityScore()
 * after this function returns.
 */
export async function rankAccountsForClient(
  clientId: string,
  opts: RankAccountsOptions = {},
): Promise<AccountPriorityResult[]> {
  const db          = getSupabaseAdmin();
  const now         = opts.now ?? new Date();
  const halfLifeDays = opts.halfLifeDays ?? PRIORITY_RECENCY_HALF_LIFE_DAYS;

  // Query 1: all account_intelligence rows for this client.
  const { data: aiData, error: aiErr } = await db
    .from("account_intelligence")
    .select("company_id, opportunity_score")
    .eq("client_id", clientId);

  if (aiErr) throw new Error(`rankAccountsForClient: account_intelligence query failed: ${aiErr.message}`);
  if (!aiData || (aiData as unknown[]).length === 0) return [];

  type AiRow = { company_id: string; opportunity_score: number };
  const aiRows      = aiData as AiRow[];
  const companyIds  = aiRows.map((r) => r.company_id);

  // Query 2: all active signals for these companies, scoped to client.
  // Fetch company_id and detected_at only — no PII, minimal payload.
  const { data: signalData, error: signalErr } = await db
    .from("signals")
    .select("company_id, detected_at")
    .eq("client_id", clientId)
    .eq("status", "active")
    .in("company_id", companyIds);

  if (signalErr) throw new Error(`rankAccountsForClient: signals query failed: ${signalErr.message}`);

  // Group signals by company_id client-side.
  type SignalRow = { company_id: string; detected_at: string };
  type SignalSummary = { maxDetectedAt: string; count: number };
  const signalsByCompany = new Map<string, SignalSummary>();

  for (const s of ((signalData ?? []) as SignalRow[])) {
    const existing = signalsByCompany.get(s.company_id);
    if (!existing) {
      signalsByCompany.set(s.company_id, { maxDetectedAt: s.detected_at, count: 1 });
    } else {
      signalsByCompany.set(s.company_id, {
        maxDetectedAt: s.detected_at > existing.maxDetectedAt
          ? s.detected_at
          : existing.maxDetectedAt,
        count: existing.count + 1,
      });
    }
  }

  // Query 3: company domains for the result struct.
  const { data: companyData, error: companyErr } = await db
    .from("companies")
    .select("id, domain")
    .in("id", companyIds);

  if (companyErr) throw new Error(`rankAccountsForClient: companies query failed: ${companyErr.message}`);

  type CompanyRow = { id: string; domain: string | null };
  const domainByCompany = new Map<string, string | null>();
  for (const c of ((companyData ?? []) as CompanyRow[])) {
    domainByCompany.set(c.id, c.domain ?? null);
  }

  // Compute priority_score for each account.
  const unsorted: Array<AccountPriorityResult & { _companyId: string }> = [];

  for (const ai of aiRows) {
    const signalSummary = signalsByCompany.get(ai.company_id) ?? null;

    const lastSignalAt        = signalSummary?.maxDetectedAt ?? null;
    const daysSinceLastSignal = lastSignalAt !== null
      ? computeDaysSince(lastSignalAt, now)
      : null;
    const activeSignalCount   = signalSummary?.count ?? 0;

    const { priorityScore, recencyMultiplier } = computePriorityScore(
      ai.opportunity_score,
      daysSinceLastSignal,
      halfLifeDays,
    );

    unsorted.push({
      _companyId:          ai.company_id,
      rank:                0, // assigned after sort
      companyId:           ai.company_id,
      domain:              domainByCompany.get(ai.company_id) ?? null,
      opportunityScore:    ai.opportunity_score,
      priorityScore,
      recencyMultiplier,
      lastSignalAt,
      daysSinceLastSignal,
      activeSignalCount,
    });
  }

  // Sort: priority_score DESC, then company_id ASC for deterministic tie-breaking.
  unsorted.sort((a, b) => {
    if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
    return a.companyId < b.companyId ? -1 : a.companyId > b.companyId ? 1 : 0;
  });

  // Assign 1-based ranks.
  return unsorted.map((r, i) => {
    const { _companyId: _, ...rest } = r;
    return { ...rest, rank: i + 1 };
  });
}
