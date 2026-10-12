/**
 * Signal refresh task — Stage 13.
 *
 * Discovers tracked companies for a client, computes per-provider since cursors,
 * and calls runIngestionCoordinator to run the full signal refresh pipeline.
 *
 * This is the entry point for a scheduled Trigger.dev task. The Trigger.dev task
 * wrapper (deployed externally) calls runSignalRefresh and stores the result in
 * jobs.output_data. This module has NO Trigger.dev imports and is fully testable
 * without the Trigger.dev SDK.
 *
 * ── Scheduling ────────────────────────────────────────────────────────────────
 *
 * Scheduling is the Trigger.dev deployment's responsibility — this function is
 * agnostic about when it runs. Recommended: daily at 02:00 UTC per client.
 *
 * ── Client isolation ─────────────────────────────────────────────────────────
 *
 * One task invocation = one client. Cross-client isolation is guaranteed because
 * every helper (getTrackedCompanyDomains, getSinceCursor, runIngestionCoordinator)
 * scopes all DB queries to clientId.
 *
 * ── Provider injection ────────────────────────────────────────────────────────
 *
 * payload.providerOverride replaces getConfiguredSignalProviders() for tests.
 * Pass new FakeSignalProvider() (or a subclass with specific scenarios) to run
 * without real API credentials.
 *
 * ── Excluded by design ────────────────────────────────────────────────────────
 *
 *   No Why Now / personalization / outbound.
 *   No new providers.
 *   No changes to the Stage 12 scoring formula or documented limitations.
 */

import { getConfiguredSignalProviders } from "../providers/signals/registry";
import type { SignalProvider } from "../providers/signals/types";
import { getTrackedCompanyDomains } from "../lib/tracked-companies";
import { getSinceCursor } from "../lib/since-cursor";
import { runIngestionCoordinator } from "../lib/signal-ingestion";
import type { IngestionReport } from "../lib/signal-ingestion";

// Re-export for callers that import the task module.
export type { IngestionReport };

// ── Public types ───────────────────────────────────────────────────────────────

export interface SignalRefreshPayload {
  clientId: string;
  /**
   * Override the provider list for offline tests.
   * When provided, replaces getConfiguredSignalProviders() entirely.
   * Pass new FakeSignalProvider() to run without real API credentials.
   */
  providerOverride?: SignalProvider;
  /**
   * Override the current time for deterministic scoring in tests.
   * ISO 8601 string. Defaults to new Date() at task start.
   */
  now?: string;
}

export interface SignalRefreshResult {
  clientId: string;
  /** Number of companies discovered via getTrackedCompanyDomains. */
  companiesTracked: number;
  /** Provider IDs that were run (in order). Never contains credentials. */
  providers: string[];
  /** One report per provider. Empty when no providers are configured. */
  reports: IngestionReport[];
  startedAt: string;
  completedAt: string;
}

// ── Task function ──────────────────────────────────────────────────────────────

/**
 * Run a complete signal refresh cycle for one client.
 *
 * Steps:
 *   1. Discover tracked companies from account_intelligence (getTrackedCompanyDomains).
 *   2. For each configured provider:
 *      a. Compute since cursor (getSinceCursor) — MAX(detected_at) for this client/companies/provider.
 *      b. Run ingestion coordinator (runIngestionCoordinator).
 *   3. Return SignalRefreshResult containing all IngestionReports.
 *
 * Returns an empty reports[] when no providers are configured (e.g. credentials
 * not set in environment). Does not throw in that case.
 */
export async function runSignalRefresh(
  payload: SignalRefreshPayload,
): Promise<SignalRefreshResult> {
  const { clientId } = payload;
  const now       = payload.now ? new Date(payload.now) : new Date();
  const startedAt = new Date();

  const companyDomains = await getTrackedCompanyDomains(clientId);
  const companyIds     = Array.from(companyDomains.keys());

  const providers: SignalProvider[] = payload.providerOverride
    ? [payload.providerOverride]
    : getConfiguredSignalProviders();

  const reports: IngestionReport[] = [];

  for (const provider of providers) {
    const since  = await getSinceCursor(clientId, companyIds, provider.id);
    const report = await runIngestionCoordinator(clientId, companyIds, provider, {
      companyDomains,
      since,
      now,
    });
    reports.push(report);
  }

  return {
    clientId,
    companiesTracked: companyIds.length,
    providers:        providers.map((p) => p.id),
    reports,
    startedAt:        startedAt.toISOString(),
    completedAt:      new Date().toISOString(),
  };
}
