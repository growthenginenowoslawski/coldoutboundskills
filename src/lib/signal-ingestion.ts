/**
 * Signal ingestion coordinator — Stage 13.
 *
 * Orchestrates the full per-(client, company[]) signal refresh pipeline:
 *
 *   provider.fetchEvents
 *   → normalizeBatch         (errors captured per-signal, batch continues)
 *   → upsertSignal           (dedup authoritative; created=true → schedule rescore)
 *   → rescoreCompany         (errors captured per-company, batch continues)
 *   → IngestionReport        (structured output; stored in jobs.output_data)
 *
 * ── Design principles ─────────────────────────────────────────────────────────
 *
 *   IDEMPOTENT  — Running twice for the same (client, companies, provider) gives
 *                 the same DB state. Duplicate upserts return created=false and
 *                 do not trigger rescores.
 *
 *   FAULT-TOLERANT — Per-company provider errors, per-signal normalization
 *                    failures, per-signal upsert errors, and per-company rescore
 *                    failures are all captured in the report without aborting the
 *                    batch. The coordinator only throws on fatal errors (e.g. DB
 *                    connection lost at startup) that make the entire run impossible.
 *
 *   TESTABLE — Provider and DB dependencies are injectable. Unit tests use
 *              FakeSignalProvider. Integration tests use FakeSignalProvider +
 *              real Supabase. No Trigger.dev imports.
 *
 *   CREDENTIAL-SAFE — provider.id (e.g. "predictleads") appears in reports;
 *                     API keys never appear in any report field.
 *
 * ── Rescore timing ────────────────────────────────────────────────────────────
 *
 * Rescores run AFTER all upserts for all companies complete, not interleaved
 * per-company. This reduces DB round-trips when multiple companies have new
 * signals, and ensures the rescore sees the latest DB state.
 *
 * ── Rate limiting ─────────────────────────────────────────────────────────────
 *
 * PredictLeads rate limiting is handled inside PredictLeadsSignalProvider
 * (429 → read Retry-After → sleep → retry once). No additional throttle is
 * applied at the coordinator level.
 *
 * ── Excluded by design ────────────────────────────────────────────────────────
 *
 *   No Why Now / AI analysis / personalization / outbound.
 *   No new signal providers.
 *   No changes to the Stage 12 scoring formula.
 *   No changes to the Stage 12 documented limitations.
 */

import type { SignalProvider } from "../providers/signals/types";
import type { NormalizedSignal } from "../domain/signal-types";
import { normalizeBatch } from "../providers/signals/normalizer";
import { upsertSignal } from "../db/signals";
import { rescoreCompany } from "./score-recompute";

// ── Public types ───────────────────────────────────────────────────────────────

/** Per-company breakdown within an IngestionReport. */
export interface CompanyIngestionResult {
  companyId: string;
  /** Raw events returned by the provider for this company. */
  signalsFetched: number;
  /** Signals successfully stored (upsertSignal returned created: true). */
  signalsInserted: number;
  /** Signals already in DB (upsertSignal returned created: false). */
  signalsDuplicated: number;
  /** Events that failed normalization (bad timestamps, missing required fields). */
  normalizationErrors: number;
  /** Signals that failed upsertSignal for a non-dedup reason (network/DB error). */
  upsertErrors: number;
  /**
   * Rescore result for this company.
   * null  — no new signals inserted for this company (rescore not triggered).
   * score — rescore succeeded; value is the new opportunity_score.
   * error — rescore threw; the company's score was not updated this run.
   */
  rescore: { score: number } | { error: string } | null;
}

/** Structured output of one coordinator run. Stored in jobs.output_data. */
export interface IngestionReport {
  clientId: string;
  /** Provider identifier (e.g. "predictleads", "test"). Never contains credentials. */
  provider: string;
  /** The since cursor passed to the provider, or null for a full-history fetch. */
  since: string | null;
  startedAt: string;
  completedAt: string;
  /** Total company IDs passed to the coordinator. */
  companiesRequested: number;
  /** Companies in companiesRequested that had a domain (others silently skipped). */
  companiesWithDomain: number;
  /** companiesWithDomain minus companiesFailed. */
  companiesSucceeded: number;
  /** Companies with a per-company provider error. */
  companiesFailed: number;
  totalSignalsFetched: number;
  totalSignalsInserted: number;
  totalSignalsDuplicated: number;
  totalNormalizationErrors: number;
  totalUpsertErrors: number;
  /** One entry per company in companiesWithDomain. */
  companies: CompanyIngestionResult[];
  /** companyId → error message for companies that failed at the provider level. */
  providerErrors: Record<string, string>;
}

/** Input to buildIngestionReport. Extracted for pure unit-testability. */
export interface IngestionReportInput {
  clientId: string;
  provider: string;
  since: string | null;
  startedAt: Date;
  completedAt: Date;
  companiesRequested: number;
  companiesWithDomain: number;
  companies: CompanyIngestionResult[];
  providerErrors: Record<string, string>;
}

// ── Pure report builder (exported for unit tests) ─────────────────────────────

/**
 * Construct an IngestionReport from accumulated per-company results.
 * Pure — no I/O. Aggregates totals from the companies array.
 */
export function buildIngestionReport(input: IngestionReportInput): IngestionReport {
  const totalSignalsFetched       = input.companies.reduce((s, r) => s + r.signalsFetched, 0);
  const totalSignalsInserted      = input.companies.reduce((s, r) => s + r.signalsInserted, 0);
  const totalSignalsDuplicated    = input.companies.reduce((s, r) => s + r.signalsDuplicated, 0);
  const totalNormalizationErrors  = input.companies.reduce((s, r) => s + r.normalizationErrors, 0);
  const totalUpsertErrors         = input.companies.reduce((s, r) => s + r.upsertErrors, 0);
  const companiesFailed           = Object.keys(input.providerErrors).length;
  const companiesSucceeded        = input.companiesWithDomain - companiesFailed;

  return {
    clientId:                input.clientId,
    provider:                input.provider,
    since:                   input.since,
    startedAt:               input.startedAt.toISOString(),
    completedAt:             input.completedAt.toISOString(),
    companiesRequested:      input.companiesRequested,
    companiesWithDomain:     input.companiesWithDomain,
    companiesSucceeded:      Math.max(0, companiesSucceeded),
    companiesFailed,
    totalSignalsFetched,
    totalSignalsInserted,
    totalSignalsDuplicated,
    totalNormalizationErrors,
    totalUpsertErrors,
    companies:               input.companies,
    providerErrors:          input.providerErrors,
  };
}

// ── Coordinator options ────────────────────────────────────────────────────────

export interface IngestionCoordinatorOptions {
  /** companyId → bare domain (e.g. "stripe.com"). Required by PredictLeads. */
  companyDomains: Map<string, string>;
  /** ISO since-cursor — passed to provider.fetchEvents. null = full history fetch. */
  since?: string | null;
  /**
   * Override the current time used for scoring.
   * Defaults to new Date() at coordinator start.
   * Pass in tests for deterministic scores and timestamps.
   */
  now?: Date;
}

// ── Coordinator ────────────────────────────────────────────────────────────────

/**
 * Run one complete signal ingestion cycle for a set of companies under a client.
 *
 * Provider is injected — callers pass FakeSignalProvider in tests and
 * PredictLeadsSignalProvider (or any getConfiguredSignalProviders() result) in
 * production.
 *
 * The coordinator never throws on per-company or per-signal failures; these are
 * captured in the returned IngestionReport. It throws only on failures that
 * prevent the entire run (e.g. DB connection lost before fetching).
 *
 * Client isolation: every DB write is scoped to clientId via the NormalizedSignal
 * fields (clientId flows from provider → normalizer → upsertSignal). Rescores are
 * also scoped to clientId via rescoreCompany.
 */
export async function runIngestionCoordinator(
  clientId: string,
  companyIds: string[],
  provider: SignalProvider,
  opts: IngestionCoordinatorOptions,
): Promise<IngestionReport> {
  const startedAt   = new Date();
  const now         = opts.now ?? startedAt;
  const detectedAt  = startedAt.toISOString();
  const since       = opts.since ?? null;

  // Companies without a domain cannot be queried by PredictLeads.
  const companyIdsWithDomain = companyIds.filter((id) => opts.companyDomains.has(id));

  // Fetch all events in one provider call.
  const batch = await provider.fetchEvents(companyIds, clientId, {
    companyDomains: opts.companyDomains,
    since:          since ?? undefined,
  });

  const providerErrors: Record<string, string> =
    (batch.meta?.perCompanyErrors as Record<string, string> | undefined) ?? {};

  // Group events by companyId for per-company processing.
  const eventsByCompany = new Map<string, typeof batch.events>();
  for (const event of batch.events) {
    const bucket = eventsByCompany.get(event.companyId);
    if (bucket) {
      bucket.push(event);
    } else {
      eventsByCompany.set(event.companyId, [event]);
    }
  }

  // Per-company: normalize → upsert; track which companies received new signals.
  const companyResults: CompanyIngestionResult[] = [];
  const rescoreSet = new Set<string>();

  for (const companyId of companyIdsWithDomain) {
    const companyEvents = eventsByCompany.get(companyId) ?? [];
    const result: CompanyIngestionResult = {
      companyId,
      signalsFetched:        companyEvents.length,
      signalsInserted:       0,
      signalsDuplicated:     0,
      normalizationErrors:   0,
      upsertErrors:          0,
      rescore:               null,
    };

    const outcomes = normalizeBatch(companyEvents, detectedAt);

    for (const outcome of outcomes) {
      if (!outcome.ok) {
        result.normalizationErrors++;
        continue;
      }
      try {
        const { created } = await upsertSignal(outcome.signal as NormalizedSignal);
        if (created) {
          result.signalsInserted++;
          rescoreSet.add(companyId);
        } else {
          result.signalsDuplicated++;
        }
      } catch {
        result.upsertErrors++;
      }
    }

    companyResults.push(result);
  }

  // Rescore all companies that received at least one new signal.
  for (const companyId of rescoreSet) {
    const result = companyResults.find((r) => r.companyId === companyId);
    if (!result) continue;
    try {
      const row = await rescoreCompany(clientId, companyId, now);
      result.rescore = { score: row.opportunityScore };
    } catch (err) {
      result.rescore = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return buildIngestionReport({
    clientId,
    provider:            provider.id,
    since,
    startedAt,
    completedAt:         new Date(),
    companiesRequested:  companyIds.length,
    companiesWithDomain: companyIdsWithDomain.length,
    companies:           companyResults,
    providerErrors,
  });
}
