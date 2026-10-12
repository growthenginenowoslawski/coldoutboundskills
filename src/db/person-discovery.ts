/**
 * Persistence helpers for Stage 24 person discovery tables.
 *
 * Migration 0019 is applied. Tables are live.
 *
 * ── Design intent ──────────────────────────────────────────────────────────────
 *
 * These functions are called by runPersonDiscoveryWaterfall() after computing
 * the outcome. Persistence is always attempted; failures propagate to the caller.
 *
 * ── Security invariants ────────────────────────────────────────────────────────
 *
 * Provider credentials are NEVER stored in any column.
 * Raw provider payloads (full name, linkedin URLs of candidates) are not stored —
 * only contactId (UUID), scores, and sanitized error codes are persisted.
 */

import { getSupabaseAdmin } from "./supabase";
import type {
  PersonDiscoveryOutcome,
  PersonDiscoveryAttemptRecord,
} from "../domain/person-discovery-types";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PersonDiscoveryRunRow {
  id: string;
  clientId: string;
  companyId: string;
  campaignStrategyId: string;
  state: string;
  selectedContactId: string | null;
  selectedProvider: string | null;
  selectedRelevanceScore: number | null;
  selectedIsQualified: boolean | null;
  selectedAt: string | null;
  fatalErrorCode: string | null;
  fatalErrorMessage: string | null;
  providersTried: string[];
  totalAttempts: number;
  discoveryStartedAt: string;
  discoveryUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ── Writes (requires migration 0019) ─────────────────────────────────────────

/**
 * Upsert a person_discovery_runs row from a waterfall outcome.
 *
 * Idempotent: UNIQUE (client_id, company_id, campaign_strategy_id).
 * Re-running with the same inputs updates the existing row.
 *
 * REQUIRES migration 0019. Throws if tables do not exist.
 */
export async function upsertPersonDiscoveryRun(
  outcome: PersonDiscoveryOutcome,
): Promise<{ runId: string }> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("person_discovery_runs")
    .upsert(
      {
        client_id:              outcome.clientId,
        company_id:              outcome.companyId,
        campaign_strategy_id:   outcome.campaignStrategyId,
        state:                  outcome.state,
        selected_contact_id:    outcome.selected?.contactId ?? null,
        selected_provider:      outcome.selected?.provider ?? null,
        selected_relevance_score: outcome.selected?.relevanceScore ?? null,
        selected_is_qualified:  outcome.selected?.isPersonQualified ?? null,
        selected_at:            outcome.selected ? now : null,
        fatal_error_code:       outcome.fatalError?.code ?? null,
        fatal_error_message:    outcome.fatalError?.message ?? null,
        providers_tried:        outcome.attempts.map((a) => a.provider),
        total_attempts:         outcome.attempts.length,
        discovery_started_at:   outcome.startedAt,
        discovery_updated_at:   outcome.completedAt,
        updated_at:             now,
      },
      {
        onConflict: "client_id,company_id,campaign_strategy_id",
        ignoreDuplicates: false,
      },
    )
    .select("id")
    .single();

  if (error) throw new Error(`upsertPersonDiscoveryRun failed: ${error.message}`);
  return { runId: (data as { id: string }).id };
}

/**
 * Upsert a person_discovery_attempts row for one provider attempt.
 *
 * Idempotent: UNIQUE (run_id, provider_id, attempt_number) — first write wins.
 * Re-running the same waterfall produces the same attempt_number for the same
 * provider; the second upsert is a no-op (ignoreDuplicates: true).
 */
export async function insertPersonDiscoveryAttempt(
  runId: string,
  attempt: PersonDiscoveryAttemptRecord & {
    clientId: string;
    companyId: string;
    campaignStrategyId: string;
    attemptNumber: number;
  },
): Promise<void> {
  // candidate_is_relevant: null when no candidate was evaluated (undefined rejection reason);
  // true when best candidate was RELEVANT (null rejection reason means "not rejected");
  // false when best candidate was rejected for a specific reason.
  const candidateIsRelevant =
    attempt.bestCandidateRejectionReason === undefined ? null :
    attempt.bestCandidateRejectionReason === null ? true : false;

  const { error } = await getSupabaseAdmin()
    .from("person_discovery_attempts")
    .upsert(
      {
        run_id:                    runId,
        client_id:                 attempt.clientId,
        company_id:                attempt.companyId,
        campaign_strategy_id:      attempt.campaignStrategyId,
        provider_id:               attempt.provider,
        attempt_number:            attempt.attemptNumber,
        candidates_returned:       attempt.candidatesReturned,
        candidates_evaluated:      attempt.candidatesEvaluated,
        candidate_contact_id:      attempt.bestCandidateContactId ?? null,
        candidate_is_relevant:     candidateIsRelevant,
        candidate_relevance_score: attempt.bestCandidateScore ?? null,
        candidate_rejection_reason: attempt.bestCandidateRejectionReason ?? null,
        error_code:                attempt.errorCode ?? null,
        error_message:             attempt.errorMessage ?? null,
        attempted_at:              attempt.attemptedAt,
        completed_at:              attempt.completedAt,
      },
      {
        onConflict: "run_id,provider_id,attempt_number",
        ignoreDuplicates: true,
      },
    );

  if (error) throw new Error(`insertPersonDiscoveryAttempt failed: ${error.message}`);
}

/**
 * Persist a complete PersonDiscoveryOutcome to both tables.
 * Upserts the run row, then inserts all attempt rows.
 *
 * REQUIRES migration 0019.
 */
export async function persistPersonDiscoveryOutcome(
  outcome: PersonDiscoveryOutcome,
): Promise<{ runId: string }> {
  const { runId } = await upsertPersonDiscoveryRun(outcome);

  for (let i = 0; i < outcome.attempts.length; i++) {
    await insertPersonDiscoveryAttempt(runId, {
      ...outcome.attempts[i],
      clientId: outcome.clientId,
      companyId: outcome.companyId,
      campaignStrategyId: outcome.campaignStrategyId,
      attemptNumber: i,
    });
  }

  return { runId };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listPersonDiscoveryAttempts(
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await getSupabaseAdmin()
    .from("person_discovery_attempts")
    .select("*")
    .eq("run_id", runId)
    .order("attempt_number", { ascending: true });

  if (error) throw new Error(`listPersonDiscoveryAttempts failed: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function getPersonDiscoveryRun(
  clientId: string,
  companyId: string,
  campaignStrategyId: string,
): Promise<PersonDiscoveryRunRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("person_discovery_runs")
    .select("*")
    .eq("client_id", clientId)
    .eq("company_id", companyId)
    .eq("campaign_strategy_id", campaignStrategyId)
    .maybeSingle();

  if (error) throw new Error(`getPersonDiscoveryRun failed: ${error.message}`);
  if (!data) return null;

  const r = data as Record<string, unknown>;
  return {
    id: r.id as string,
    clientId: r.client_id as string,
    companyId: r.company_id as string,
    campaignStrategyId: r.campaign_strategy_id as string,
    state: r.state as string,
    selectedContactId: (r.selected_contact_id as string | null) ?? null,
    selectedProvider: (r.selected_provider as string | null) ?? null,
    selectedRelevanceScore: (r.selected_relevance_score as number | null) ?? null,
    selectedIsQualified: (r.selected_is_qualified as boolean | null) ?? null,
    selectedAt: (r.selected_at as string | null) ?? null,
    fatalErrorCode: (r.fatal_error_code as string | null) ?? null,
    fatalErrorMessage: (r.fatal_error_message as string | null) ?? null,
    providersTried: (r.providers_tried as string[]) ?? [],
    totalAttempts: r.total_attempts as number,
    discoveryStartedAt: r.discovery_started_at as string,
    discoveryUpdatedAt: r.discovery_updated_at as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
