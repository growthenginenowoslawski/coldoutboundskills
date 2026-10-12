/**
 * Signal provider capability interface.
 *
 * Every signal source (LinkedIn, Crunchbase, test, etc.) implements this
 * interface. The engine never imports a vendor SDK directly — it depends only
 * on this contract.
 *
 * Mirrors the LeadSourceProvider / EnrichmentProvider / AIProvider pattern
 * in src/providers/types.ts so the signal layer fits the existing architecture.
 */

import type { RawEventBatch } from "../../domain/signal-types";

export type { RawEventBatch };

export interface FetchOptions {
  /** Cap on events returned — for testing and cost control. */
  limit?: number;
  /** Only return events after this ISO timestamp. */
  since?: string;
  /**
   * Map of companyId (our UUID) → bare domain.
   * Required by PredictLeads; ignored by providers that identify by ID.
   * Declared here so the coordinator can pass it through FetchOptions
   * without a type cast — PredictLeadsFetchOptions overrides this as required.
   */
  companyDomains?: Map<string, string>;
}

export interface SignalProvider {
  /** Stable provider name: "linkedin", "crunchbase", "builtwith", "test". */
  readonly id: string;
  /** Whether this provider is usable (credentials present, etc.). */
  isConfigured(): boolean;
  /**
   * Fetch raw events for a set of companies under a client.
   * Must not call external APIs during offline / test runs.
   * Must not modify any production data.
   */
  fetchEvents(
    companyIds: string[],
    clientId: string,
    opts?: FetchOptions,
  ): Promise<RawEventBatch>;
}
