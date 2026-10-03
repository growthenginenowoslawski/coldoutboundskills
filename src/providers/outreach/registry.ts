/**
 * Outreach provider registry — Stage 16.
 *
 * Resolves the correct OutreachProvider for a given client.
 *
 * ── Multi-tenancy design ──────────────────────────────────────────────────────
 *   Stage 16: credentials are read from environment variables.
 *     client A and client B both use process.env.SMARTLEAD_API_KEY
 *     This is a known limitation — acceptable while Gramscode is the only client.
 *
 *   Stage 18+: credentials should come from a `client_provider_credentials`
 *     table (or equivalent secrets store), keyed by (client_id, provider).
 *     The registry interface below is designed to support that migration:
 *     swap out resolveSmartleadCreds() without changing call sites.
 *
 * ── Safety ────────────────────────────────────────────────────────────────────
 *   Credentials are NEVER logged. The registry logs provider IDs and client IDs
 *   only. Actual key values never appear in any output.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *   const registry = OutreachProviderRegistry.fromEnv();
 *   const provider = registry.getProvider("smartlead", clientId);
 *   const health = await provider.getCampaignHealth("12345");
 */

import { optionalEnv } from "../../config/env.js";
import {
  OutreachCredentialError,
  OutreachProviderError,
} from "./errors.js";
import { SmartleadAdapter } from "./smartlead.js";
import type { OutreachProvider, OutreachProviderId } from "./types.js";

/** Credential resolver: maps (clientId, providerId) → credentials object. */
export type CredentialResolver = (
  providerId: OutreachProviderId,
  clientId: string,
) => Record<string, string> | undefined;

export class OutreachProviderRegistry {
  constructor(private readonly resolveCredentials: CredentialResolver) {}

  /**
   * Registry backed by environment variables.
   * Stage 16 default — works for single-client deployments.
   *
   * Env vars read:
   *   SMARTLEAD_API_KEY — required for the smartlead provider
   */
  static fromEnv(): OutreachProviderRegistry {
    return new OutreachProviderRegistry((_providerId, _clientId) => {
      // All clients share the same env-level credentials for now.
      // Stage 18+: look up per-client credentials here.
      const smartleadKey = optionalEnv("SMARTLEAD_API_KEY");
      if (smartleadKey) return { apiKey: smartleadKey };
      return undefined;
    });
  }

  /**
   * Instantiate the provider adapter for a given platform and client.
   *
   * @param providerId — matches campaigns.platform in the database
   * @param clientId — the client requesting the operation (for future credential isolation)
   * @throws OutreachCredentialError if no credentials are available
   * @throws OutreachProviderError if the provider is unknown
   */
  getProvider(providerId: OutreachProviderId, clientId: string): OutreachProvider {
    const creds = this.resolveCredentials(providerId, clientId);

    switch (providerId) {
      case "smartlead": {
        if (!creds?.apiKey) {
          throw new OutreachCredentialError("smartlead");
        }
        return new SmartleadAdapter({ apiKey: creds.apiKey });
      }

      case "instantly":
        throw new OutreachProviderError(
          "instantly: adapter not yet implemented (Stage 18+)",
          "instantly",
        );

      case "plusvibe":
        throw new OutreachProviderError(
          "plusvibe: adapter not yet implemented (Stage 18+)",
          "plusvibe",
        );

      default: {
        const exhaustive: never = providerId;
        throw new OutreachProviderError(
          `unknown provider: ${exhaustive}`,
          String(exhaustive),
        );
      }
    }
  }
}
