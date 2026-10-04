/**
 * Email Enrichment Waterfall — Stage 24.
 *
 * Calls EmailEnrichmentProviders in order for a KNOWN person (identified by
 * contactId in the DB) until one returns an email address.
 *
 * This waterfall runs ONLY after PersonDiscoveryWaterfall returns RELEVANT_FOUND.
 * It does NOT discover new people — it finds email for an already-identified person.
 *
 * ── Termination rules ─────────────────────────────────────────────────────────
 *
 * EMAIL_FOUND               — a provider returned a non-null email
 * EMAIL_ENRICHMENT_EXHAUSTED — all providers tried, none found an email
 * AUTH_ERROR (fatal)         — stops immediately; remaining providers not tried
 *
 * ── When to run ───────────────────────────────────────────────────────────────
 *
 * Run this waterfall when the selected contact has email=null (no email in DB).
 * If the contact already has an email, skip enrichment — it's already available.
 *
 * ── PII constraints ───────────────────────────────────────────────────────────
 *
 * The found email is NEVER logged by this module. It appears in the outcome's
 * foundEmail field, which callers must treat as PII (never log, never expose
 * without encryption). The email_enrichment_runs DB table also marks found_email
 * as a PII-sensitive column.
 *
 * ── Persistence ───────────────────────────────────────────────────────────────
 *
 * After computing the outcome, the waterfall persists it to email_enrichment_runs
 * and email_enrichment_attempts (migration 0019). The found email is NEVER
 * included in the persisted record — only provenance metadata is stored.
 */

import type {
  EmailEnrichmentOutcome,
  EmailEnrichmentAttemptRecord,
  EmailEnrichmentErrorCode,
  EmailEnrichmentQuery,
} from "../domain/person-discovery-types";
import type { EmailEnrichmentProvider } from "../providers/email-enrichment/types";
import { EmailEnrichmentAuthError } from "../providers/email-enrichment/types";
import { getContactById } from "../db/contacts";
import { sanitizeProviderError } from "./provider-error-sanitizer";
import { persistEmailEnrichmentOutcome } from "../db/email-enrichment";

// ── Options ───────────────────────────────────────────────────────────────────

export interface EmailEnrichmentWaterfallOptions {
  clientId: string;
  contactId: string;
  campaignStrategyId: string;
  providers: EmailEnrichmentProvider[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function classifyEmailErrorCode(err: unknown): EmailEnrichmentErrorCode {
  if (err instanceof EmailEnrichmentAuthError) return "AUTH_ERROR";
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("rate limit") || msg.includes("429")) return "RATE_LIMITED";
  if (msg.includes("timeout") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND")) return "TEMPORARY_FAILURE";
  return "PROVIDER_ERROR";
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the email enrichment waterfall and persist the outcome.
 * The found email address is returned in-memory but never persisted.
 */
export async function runEmailEnrichmentWaterfall(
  opts: EmailEnrichmentWaterfallOptions,
): Promise<EmailEnrichmentOutcome> {
  const outcome = await _runEmailEnrichmentCore(opts);
  try {
    await persistEmailEnrichmentOutcome(outcome);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("violates foreign key constraint")) {
      // One or more IDs (client_id, contact_id, campaign_strategy_id) do not
      // exist in the DB. Return the outcome with a structured persistenceError
      // so the caller can observe and handle it — not silently dropped.
      return {
        ...outcome,
        persistenceError: {
          code: "FK_VIOLATION",
          message:
            "audit record not written: one or more FK references " +
            "(client_id, contact_id, campaign_strategy_id) not found in database",
        },
      };
    }
    throw err;
  }
  return outcome;
}

// ── Core waterfall (stateless — no DB writes) ─────────────────────────────────

async function _runEmailEnrichmentCore(
  opts: EmailEnrichmentWaterfallOptions,
): Promise<EmailEnrichmentOutcome> {
  const startedAt = new Date().toISOString();
  const { clientId, contactId, campaignStrategyId } = opts;

  // Load contact to build the enrichment query
  const contact = await getContactById(contactId);
  if (!contact) {
    return {
      clientId, contactId, campaignStrategyId,
      state: "EMAIL_ENRICHMENT_EXHAUSTED",
      attempts: [],
      totalProvidersTried: 0,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // Build the query for providers (no email or linkedin_url from contacts — just name + domain)
  const query: EmailEnrichmentQuery = {
    fullName: contact.fullName ?? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim(),
    companyDomain: undefined, // enriched from company table if needed by real providers
    linkedinUrl: contact.linkedinUrl ?? undefined,
    source: "stage24-email-enrichment",
  };

  const attempts: EmailEnrichmentAttemptRecord[] = [];
  const providersTried: string[] = [];
  const configuredProviders = opts.providers.filter((p) => p.isConfigured());

  for (const provider of configuredProviders) {
    const attemptedAt = new Date().toISOString();
    providersTried.push(provider.id);

    let emailFound = false;
    let foundEmail: string | undefined;
    let errorCode: EmailEnrichmentErrorCode | undefined;
    let errorMessage: string | undefined;

    try {
      const result = await provider.findEmailForPerson(query);
      if (result !== null) {
        emailFound = true;
        foundEmail = result.email;
      }
    } catch (err) {
      errorCode = classifyEmailErrorCode(err); // uses raw err.message for accuracy — in-memory only
      errorMessage = sanitizeProviderError(err); // sanitized for persistence

      attempts.push({
        provider: provider.id,
        attemptedAt,
        completedAt: new Date().toISOString(),
        emailFound: false,
        errorCode,
        errorMessage,
      });

      if (err instanceof EmailEnrichmentAuthError) {
        // Fatal — stop the waterfall
        return {
          clientId, contactId, campaignStrategyId,
          state: "EMAIL_ENRICHMENT_EXHAUSTED",
          attempts,
          totalProvidersTried: providersTried.length,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }
      continue;
    }

    attempts.push({
      provider: provider.id,
      attemptedAt,
      completedAt: new Date().toISOString(),
      emailFound,
    });

    if (emailFound && foundEmail) {
      return {
        clientId, contactId, campaignStrategyId,
        state: "EMAIL_FOUND",
        foundEmail, // PII — never log this
        foundProvider: provider.id,
        attempts,
        totalProvidersTried: providersTried.length,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  return {
    clientId, contactId, campaignStrategyId,
    state: "EMAIL_ENRICHMENT_EXHAUSTED",
    attempts,
    totalProvidersTried: providersTried.length,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
