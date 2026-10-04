/**
 * Persistence helpers for Stage 24 email enrichment tables.
 *
 * Migration 0019 is applied. Tables are live.
 *
 * ── Security invariants ────────────────────────────────────────────────────────
 *
 * found_email is NOT stored in any column — intentional PII policy.
 * The email address is returned in-memory by the waterfall and written to
 * contacts.email + email_verifications by the caller.
 * Provider credentials are never stored.
 */

import { getSupabaseAdmin } from "./supabase";
import type {
  EmailEnrichmentOutcome,
  EmailEnrichmentAttemptRecord,
} from "../domain/person-discovery-types";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EmailEnrichmentRunRow {
  id: string;
  clientId: string;
  contactId: string;
  campaignStrategyId: string;
  state: string;
  /** Which provider found the email. Email address itself is NOT stored here. */
  foundProvider: string | null;
  foundAt: string | null;
  providersTried: string[];
  totalAttempts: number;
  enrichmentStartedAt: string;
  enrichmentUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ── Writes (requires migration 0019) ─────────────────────────────────────────

/**
 * Upsert an email_enrichment_runs row from a waterfall outcome.
 *
 * Idempotent: UNIQUE (client_id, contact_id, campaign_strategy_id).
 *
 * Note: found_email is intentionally NOT persisted. The email address is
 * returned in-memory by the waterfall and written to contacts.email +
 * email_verifications by the caller. This table stores only provenance:
 * which provider found it, when, and the terminal state.
 *
 * REQUIRES migration 0019. Throws if tables do not exist.
 */
export async function upsertEmailEnrichmentRun(
  outcome: EmailEnrichmentOutcome,
): Promise<{ runId: string }> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("email_enrichment_runs")
    .upsert(
      {
        client_id:             outcome.clientId,
        contact_id:            outcome.contactId,
        campaign_strategy_id:  outcome.campaignStrategyId,
        state:                 outcome.state,
        found_provider:        outcome.foundProvider ?? null,
        found_at:              outcome.state === "EMAIL_FOUND" ? now : null,
        providers_tried:       outcome.attempts.map((a) => a.provider),
        total_attempts:        outcome.attempts.length,
        enrichment_started_at: outcome.startedAt,
        enrichment_updated_at: outcome.completedAt,
        updated_at:            now,
      },
      {
        onConflict: "client_id,contact_id,campaign_strategy_id",
        ignoreDuplicates: false,
      },
    )
    .select("id")
    .single();

  if (error) throw new Error(`upsertEmailEnrichmentRun failed: ${error.message}`);
  return { runId: (data as { id: string }).id };
}

/**
 * Upsert an email_enrichment_attempts row.
 *
 * Idempotent: UNIQUE (run_id, provider_id, attempt_number) — first write wins.
 */
export async function insertEmailEnrichmentAttempt(
  runId: string,
  attempt: EmailEnrichmentAttemptRecord & {
    clientId: string;
    contactId: string;
    campaignStrategyId: string;
    attemptNumber: number;
  },
): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("email_enrichment_attempts")
    .upsert(
      {
        run_id:               runId,
        client_id:            attempt.clientId,
        contact_id:           attempt.contactId,
        campaign_strategy_id: attempt.campaignStrategyId,
        provider_id:          attempt.provider,
        attempt_number:       attempt.attemptNumber,
        email_found:          attempt.emailFound,
        error_code:           attempt.errorCode ?? null,
        error_message:        attempt.errorMessage ?? null,
        attempted_at:         attempt.attemptedAt,
        completed_at:         attempt.completedAt,
      },
      {
        onConflict: "run_id,provider_id,attempt_number",
        ignoreDuplicates: true,
      },
    );

  if (error) throw new Error(`insertEmailEnrichmentAttempt failed: ${error.message}`);
}

/**
 * Persist a complete EmailEnrichmentOutcome to both tables.
 *
 * REQUIRES migration 0019.
 */
export async function persistEmailEnrichmentOutcome(
  outcome: EmailEnrichmentOutcome,
): Promise<{ runId: string }> {
  const { runId } = await upsertEmailEnrichmentRun(outcome);

  for (let i = 0; i < outcome.attempts.length; i++) {
    await insertEmailEnrichmentAttempt(runId, {
      ...outcome.attempts[i],
      clientId: outcome.clientId,
      contactId: outcome.contactId,
      campaignStrategyId: outcome.campaignStrategyId,
      attemptNumber: i,
    });
  }

  return { runId };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export async function listEmailEnrichmentAttempts(
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await getSupabaseAdmin()
    .from("email_enrichment_attempts")
    .select("*")
    .eq("run_id", runId)
    .order("attempt_number", { ascending: true });

  if (error) throw new Error(`listEmailEnrichmentAttempts failed: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function getEmailEnrichmentRun(
  clientId: string,
  contactId: string,
  campaignStrategyId: string,
): Promise<EmailEnrichmentRunRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("email_enrichment_runs")
    .select("*")
    .eq("client_id", clientId)
    .eq("contact_id", contactId)
    .eq("campaign_strategy_id", campaignStrategyId)
    .maybeSingle();

  if (error) throw new Error(`getEmailEnrichmentRun failed: ${error.message}`);
  if (!data) return null;

  const r = data as Record<string, unknown>;
  return {
    id: r.id as string,
    clientId: r.client_id as string,
    contactId: r.contact_id as string,
    campaignStrategyId: r.campaign_strategy_id as string,
    state: r.state as string,
    foundProvider: (r.found_provider as string | null) ?? null,
    foundAt: (r.found_at as string | null) ?? null,
    providersTried: (r.providers_tried as string[]) ?? [],
    totalAttempts: r.total_attempts as number,
    enrichmentStartedAt: r.enrichment_started_at as string,
    enrichmentUpdatedAt: r.enrichment_updated_at as string,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
