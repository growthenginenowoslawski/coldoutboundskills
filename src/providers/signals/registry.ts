/**
 * Signal provider registry — Stage 11.
 *
 * Returns the ordered list of signal providers for this system.
 * Mirrors the lead-source registry pattern (src/providers/registry.ts).
 *
 * Stage 11 contains exactly one real provider: PredictLeads.
 * Future providers are added here — the ingestion task does not need to change.
 *
 * Usage:
 *   import { getConfiguredSignalProviders } from "./registry";
 *   const providers = getConfiguredSignalProviders();
 *   // providers contains only those with valid credentials
 */

import { PredictLeadsSignalProvider } from "./predictleads-provider";
import type { SignalProvider } from "./types";

/** All registered signal providers, in priority order. */
export function getSignalProviders(): SignalProvider[] {
  return [
    new PredictLeadsSignalProvider(),
    // Stage 12+: add additional providers here
  ];
}

/** Subset of providers whose credentials are present and ready to call. */
export function getConfiguredSignalProviders(): SignalProvider[] {
  return getSignalProviders().filter((p) => p.isConfigured());
}
