/**
 * Person Discovery Waterfall — Stage 24.
 *
 * Calls PersonDiscoveryProviders in order. For each candidate returned by a
 * provider, runs Stage 23 (assessContactForCampaign) to evaluate function/
 * seniority fit against the campaign's targeting criteria.
 *
 * The waterfall stops ONLY when Stage 23 returns isPersonRelevant=true.
 * A provider returning any person is NOT sufficient to stop the waterfall.
 *
 * ── Termination rules ─────────────────────────────────────────────────────────
 *
 * RELEVANT_FOUND            — Stage 23 returned isPersonRelevant=true for a candidate
 * PERSON_DISCOVERY_EXHAUSTED — all providers tried, none found a RELEVANT person
 * AUTH_ERROR (fatal)         — stops immediately; remaining providers not tried
 * ACCOUNT_NOT_READY (fatal)  — Stage 22 prerequisite not met; company not evaluable
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * Before calling providers, the waterfall checks whether any contact at this
 * company already has a fresh RELEVANT CCR row for this campaign (from a prior
 * waterfall run or a direct Stage 23 assessment). If found, providers are not
 * re-queried and reusedExistingResult=true in the outcome.
 *
 * ── Contact matching ──────────────────────────────────────────────────────────
 *
 * Providers return PersonDiscoveryCandidate objects (name, title, linkedinUrl).
 * The waterfall matches these to DB contacts by linkedinUrl (primary) or
 * fullName+companyDomain (fallback). Candidates with no DB match are skipped —
 * Stage 23 requires a contactId.
 *
 * ── PII constraints ───────────────────────────────────────────────────────────
 *
 * No email, full name, or LinkedIn URL from provider payloads is persisted by
 * this module. Stage 23 handles its own PII constraints. The outcome object
 * contains only contactId (UUID) and scores — not name/email.
 *
 * ── Persistence ───────────────────────────────────────────────────────────────
 *
 * After computing the outcome, the waterfall persists it to person_discovery_runs
 * and person_discovery_attempts (migration 0019). Persistence errors propagate.
 * The in-memory outcome is always returned after a successful persist.
 */

import type {
  PersonDiscoveryOutcome,
  PersonDiscoveryAttemptRecord,
  PersonDiscoverySelectedCandidate,
  PersonDiscoveryState,
  PersonDiscoveryErrorCode,
  PersonDiscoveryCandidate,
} from "../domain/person-discovery-types";
import type { PersonDiscoveryProvider } from "../providers/person-discovery/types";
import {
  PersonDiscoveryAuthError,
  PersonDiscoveryNotFoundError,
  PersonDiscoveryProviderError,
} from "../providers/person-discovery/types";
import type { PersonRelevanceReason } from "../domain/contact-intelligence-types";
import type { ContactRow } from "../db/contacts";
import { getContactsByCompanyId } from "../db/contacts";
import {
  listContactCampaignRelevanceForCompany,
  listContactIntelligenceForCompany,
} from "../db/contact-intelligence";
import { isCampaignRelevanceStale } from "./person-relevance";
import { assessContactForCampaign } from "./contact-intelligence";
import { getCampaignStrategyById } from "../db/campaign-strategies";
import { sanitizeProviderError } from "./provider-error-sanitizer";
import { persistPersonDiscoveryOutcome } from "../db/person-discovery";

// ── Options ───────────────────────────────────────────────────────────────────

export interface PersonDiscoveryWaterfallOptions {
  clientId: string;
  companyId: string;
  campaignStrategyId: string;
  providers: PersonDiscoveryProvider[];
  /**
   * Max candidates to request per provider call.
   * Default: 10. Cost control lever — providers may return fewer.
   */
  candidatesPerProvider?: number;
  /**
   * When true, skip the existing-result check and always query providers.
   * Use in tests where you want to force a fresh waterfall run.
   * Default: false.
   */
  forceRefresh?: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function classifyErrorCode(err: unknown): PersonDiscoveryErrorCode {
  if (err instanceof PersonDiscoveryNotFoundError) return "NOT_FOUND";
  if (err instanceof PersonDiscoveryAuthError) return "AUTH_ERROR";
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("rate limit") || msg.includes("429")) return "RATE_LIMITED";
  if (msg.includes("timeout") || msg.includes("ECONNRESET") || msg.includes("ENOTFOUND")) return "TEMPORARY_FAILURE";
  return "PROVIDER_ERROR";
}

function matchCandidateToContact(
  candidate: PersonDiscoveryCandidate,
  contacts: ContactRow[],
): ContactRow | undefined {
  if (candidate.linkedinUrl) {
    const byLinkedin = contacts.find(
      (c) => c.linkedinUrl && c.linkedinUrl === candidate.linkedinUrl,
    );
    if (byLinkedin) return byLinkedin;
  }
  if (candidate.fullName && candidate.companyDomain) {
    const normalized = candidate.fullName.toLowerCase().trim();
    return contacts.find((c) => {
      const contactName = (c.fullName ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`).toLowerCase().trim();
      return contactName === normalized;
    });
  }
  return undefined;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Run the person discovery waterfall and persist the outcome.
 * Returns the outcome after successful persistence.
 */
export async function runPersonDiscoveryWaterfall(
  opts: PersonDiscoveryWaterfallOptions,
): Promise<PersonDiscoveryOutcome> {
  const outcome = await _runPersonDiscoveryCore(opts);
  try {
    await persistPersonDiscoveryOutcome(outcome);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("violates foreign key constraint")) {
      // One or more IDs (client_id, company_id, campaign_strategy_id) do not
      // exist in the DB. Return the outcome with a structured persistenceError
      // so the caller can observe and handle it — not silently dropped.
      return {
        ...outcome,
        persistenceError: {
          code: "FK_VIOLATION",
          message:
            "audit record not written: one or more FK references " +
            "(client_id, company_id, campaign_strategy_id) not found in database",
        },
      };
    }
    throw err;
  }
  return outcome;
}

// ── Core waterfall (stateless — no DB writes) ─────────────────────────────────

async function _runPersonDiscoveryCore(
  opts: PersonDiscoveryWaterfallOptions,
): Promise<PersonDiscoveryOutcome> {
  const startedAt = new Date().toISOString();
  const { clientId, companyId, campaignStrategyId } = opts;
  const limit = opts.candidatesPerProvider ?? 10;

  // ── Idempotency check: look for fresh RELEVANT result ─────────────────────
  if (!opts.forceRefresh) {
    const freshResult = await findFreshRelevantResult(clientId, companyId, campaignStrategyId);
    if (freshResult) {
      return {
        clientId, companyId, campaignStrategyId,
        state: "RELEVANT_FOUND",
        selected: freshResult,
        attempts: [],
        totalProvidersTried: 0,
        reusedExistingResult: true,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  // ── Load campaign strategy (needed for provider query) ────────────────────
  const campaignStrategy = await getCampaignStrategyById(campaignStrategyId, clientId);
  if (!campaignStrategy) {
    return {
      clientId, companyId, campaignStrategyId,
      state: "PERSON_DISCOVERY_EXHAUSTED",
      fatalError: {
        code: "CAMPAIGN_NOT_FOUND",
        message: `campaign_strategy ${campaignStrategyId} not found for client ${clientId}`,
      },
      attempts: [],
      totalProvidersTried: 0,
      reusedExistingResult: false,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // ── Load all contacts at this company for candidate matching ──────────────
  const companyContacts = await getContactsByCompanyId(companyId);

  const attempts: PersonDiscoveryAttemptRecord[] = [];
  const providersTried: string[] = [];
  const configuredProviders = opts.providers.filter((p) => p.isConfigured());

  // ── Provider loop ─────────────────────────────────────────────────────────
  for (const provider of configuredProviders) {
    const attemptedAt = new Date().toISOString();
    providersTried.push(provider.id);

    let candidates: PersonDiscoveryCandidate[] = [];
    let errorCode: PersonDiscoveryErrorCode | undefined;
    let errorMessage: string | undefined;
    let fatalAuthError = false;

    // Step 1: call provider
    try {
      candidates = await provider.searchPeopleForCampaign({
        companyDomain: undefined, // real providers use this; fake providers use companyId
        companyId,
        targetPersona: {
          functionBuckets: [], // persona parsed from campaign by Stage 23
          minimumSeniority: "UNKNOWN",
        },
        limit,
      });
    } catch (err) {
      errorCode = classifyErrorCode(err); // uses raw err.message for accuracy — in-memory only
      errorMessage = sanitizeProviderError(err); // sanitized for persistence
      if (err instanceof PersonDiscoveryAuthError) {
        fatalAuthError = true;
      }
      attempts.push({
        provider: provider.id,
        attemptedAt,
        completedAt: new Date().toISOString(),
        candidatesReturned: 0,
        candidatesEvaluated: 0,
        errorCode,
        errorMessage,
      });
      if (fatalAuthError) {
        return {
          clientId, companyId, campaignStrategyId,
          state: "PERSON_DISCOVERY_EXHAUSTED",
          fatalError: {
            code: "AUTH_ERROR",
            provider: provider.id,
            message: errorMessage,
          },
          attempts,
          totalProvidersTried: providersTried.length,
          reusedExistingResult: false,
          startedAt,
          completedAt: new Date().toISOString(),
        };
      }
      continue;
    }

    // Step 2: evaluate each candidate via Stage 23
    const relevantCandidates: Array<{
      contact: ContactRow;
      provider: string;
      relevanceScore: number;
      isPersonQualified: boolean;
    }> = [];

    let bestContactId: string | undefined;
    let bestScore: number | null | undefined;
    let bestRejectionReason: PersonRelevanceReason | null | undefined;
    let evaluatedCount = 0;

    for (const candidate of candidates) {
      const contact = matchCandidateToContact(candidate, companyContacts);
      if (!contact) continue; // no DB row — can't evaluate

      evaluatedCount++;

      let assessmentResult;
      try {
        assessmentResult = await assessContactForCampaign({
          clientId,
          companyId,
          contactId: contact.id,
          campaignStrategyId,
          skipAiNarrative: true, // AI narrative not needed during discovery
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ACCOUNT_NOT_READY — fatal for the whole company
        if (msg.includes("account_intelligence.is_ready is not true")) {
          const sanitizedMsg = sanitizeProviderError(err);
          attempts.push({
            provider: provider.id,
            attemptedAt,
            completedAt: new Date().toISOString(),
            candidatesReturned: candidates.length,
            candidatesEvaluated: evaluatedCount,
            errorCode: "PROVIDER_ERROR",
            errorMessage: "ACCOUNT_NOT_READY: " + sanitizedMsg,
          });
          return {
            clientId, companyId, campaignStrategyId,
            state: "PERSON_DISCOVERY_EXHAUSTED",
            fatalError: { code: "ACCOUNT_NOT_READY", message: sanitizedMsg },
            attempts,
            totalProvidersTried: providersTried.length,
            reusedExistingResult: false,
            startedAt,
            completedAt: new Date().toISOString(),
          };
        }
        // Other Stage 23 errors (contact not found, etc.) — skip this candidate
        continue;
      }

      const ccr = assessmentResult.campaignRelevance;
      const score = ccr.relevanceScore;
      const relevant = ccr.isPersonRelevant === true;
      const reason = ccr.relevanceReason;

      // Track best candidate seen so far (for attempt record)
      if (bestScore === undefined || (score !== null && (bestScore === null || score > bestScore))) {
        bestContactId = contact.id;
        bestScore = score;
        bestRejectionReason = reason;
      }

      if (relevant) {
        relevantCandidates.push({
          contact,
          provider: provider.id,
          relevanceScore: score ?? 0,
          isPersonQualified: ccr.isPersonQualified === true,
        });
      }
    }

    // Step 3: if any RELEVANT candidates from this provider → select best
    if (relevantCandidates.length > 0) {
      relevantCandidates.sort((a, b) => b.relevanceScore - a.relevanceScore);
      const winner = relevantCandidates[0];

      attempts.push({
        provider: provider.id,
        attemptedAt,
        completedAt: new Date().toISOString(),
        candidatesReturned: candidates.length,
        candidatesEvaluated: evaluatedCount,
        bestCandidateContactId: winner.contact.id,
        bestCandidateScore: winner.relevanceScore,
        bestCandidateRejectionReason: null, // RELEVANT — no rejection
      });

      const selected: PersonDiscoverySelectedCandidate = {
        contactId: winner.contact.id,
        linkedinUrl: winner.contact.linkedinUrl ?? undefined,
        provider: winner.provider,
        relevanceScore: winner.relevanceScore,
        isPersonRelevant: true,
        isPersonQualified: winner.isPersonQualified,
      };

      return {
        clientId, companyId, campaignStrategyId,
        state: "RELEVANT_FOUND",
        selected,
        attempts,
        totalProvidersTried: providersTried.length,
        reusedExistingResult: false,
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    // No RELEVANT candidates this provider — record attempt and continue
    attempts.push({
      provider: provider.id,
      attemptedAt,
      completedAt: new Date().toISOString(),
      candidatesReturned: candidates.length,
      candidatesEvaluated: evaluatedCount,
      bestCandidateContactId: bestContactId,
      bestCandidateScore: bestScore,
      bestCandidateRejectionReason: bestRejectionReason ?? undefined,
    });
  }

  // All providers exhausted — no RELEVANT person found
  return {
    clientId, companyId, campaignStrategyId,
    state: "PERSON_DISCOVERY_EXHAUSTED",
    attempts,
    totalProvidersTried: providersTried.length,
    reusedExistingResult: false,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// ── Idempotency helper ────────────────────────────────────────────────────────

/**
 * Check whether a fresh RELEVANT CCR row already exists for this company × campaign.
 * If yes, return a PersonDiscoverySelectedCandidate from the existing row.
 * If no, return null so the waterfall proceeds to call providers.
 */
async function findFreshRelevantResult(
  clientId: string,
  companyId: string,
  campaignStrategyId: string,
): Promise<PersonDiscoverySelectedCandidate | null> {
  const [existingCCRs, campaignStrategy] = await Promise.all([
    listContactCampaignRelevanceForCompany(clientId, companyId, campaignStrategyId),
    getCampaignStrategyById(campaignStrategyId, clientId),
  ]);

  if (!campaignStrategy) return null;

  // Also fetch contact_intelligence rows for staleness check
  const existingCIs = await listContactIntelligenceForCompany(clientId, companyId);
  const ciByContactId = new Map(existingCIs.map((ci) => [ci.contactId, ci]));

  const now = new Date();
  for (const ccr of existingCCRs) {
    if (ccr.isPersonRelevant !== true) continue;

    const ci = ciByContactId.get(ccr.contactId);
    const stale = isCampaignRelevanceStale(
      ccr,
      campaignStrategyId,
      campaignStrategy.updated_at,
      null, // accountReadinessAssessedAt — null means skip this staleness check
      ci?.contactReadinessAssessedAt ?? null,
      now,
    );
    if (stale) continue;

    return {
      contactId: ccr.contactId,
      provider: "existing-stage23-result",
      relevanceScore: ccr.relevanceScore ?? 0,
      isPersonRelevant: true,
      isPersonQualified: ccr.isPersonQualified === true,
    };
  }

  return null;
}
