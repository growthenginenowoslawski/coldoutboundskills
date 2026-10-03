/**
 * Fake signal provider for offline testing and Supabase integration tests.
 *
 * Makes NO external API calls.
 * Modifies NO production data.
 * Sends NOTHING externally.
 *
 * Generates deterministic events from a named scenario catalogue. Each
 * scenario represents a realistic business event with realistic evidence.
 *
 * Usage:
 *   const provider = new FakeSignalProvider();
 *   const batch = await provider.fetchEvents([companyId], clientId, {
 *     scenarios: ["executive_hire_vp_sales", "funding_series_a"],
 *   });
 */

import type { SignalProvider, FetchOptions } from "./types";
import type { RawSignalEvent, RawEventBatch, SignalType } from "../../domain/signal-types";

// ── Scenario catalogue ────────────────────────────────────────────────────────

export interface FakeScenario {
  signalType: SignalType;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  /** How many days before `asOf` the event occurred. */
  daysAgo: number;
  /** Simulates a provider-supplied stable ID — enables tier-1 dedup. */
  providerEventId?: string;
  sourceUrl?: string;
}

export const FAKE_SCENARIOS: Record<string, FakeScenario> = {
  executive_hire_vp_sales: {
    signalType: "executive_hire",
    title: "New VP of Sales hired",
    description:
      "Company hired a VP of Sales — new leadership often resets the vendor stack within 90 days.",
    evidence: {
      event: "new_executive_hire",
      role: "VP Sales",
      seniority: "VP",
      function: "Sales",
      name: "Jordan Rivera",
    },
    daysAgo: 5,
    providerEventId: "li-event-vp-sales-hire-001",
    sourceUrl: "https://linkedin.com/posts/example-vp-sales-hire",
  },
  executive_hire_vp_engineering: {
    signalType: "executive_hire",
    title: "New VP of Engineering hired",
    description:
      "Company hired a VP of Engineering — technical leadership change can shift build-vs-buy decisions.",
    evidence: {
      event: "new_executive_hire",
      role: "VP Engineering",
      seniority: "VP",
      function: "Engineering",
      name: "Sam Okafor",
    },
    daysAgo: 5,
    providerEventId: "li-event-vp-eng-hire-001",
    sourceUrl: "https://linkedin.com/posts/example-vp-eng-hire",
  },
  funding_series_a: {
    signalType: "funding_round",
    title: "Series A funding round closed",
    description:
      "Company raised a Series A — new capital typically unlocks SaaS tooling budget within 60 days.",
    evidence: {
      event: "funding_round",
      round: "Series A",
      amount_usd: 8_000_000,
      investors: ["Accel", "Sequoia"],
    },
    daysAgo: 10,
    providerEventId: "cb-funding-series-a-001",
    sourceUrl: "https://crunchbase.com/funding-round/example",
  },
  job_posting_head_of_sales: {
    signalType: "job_posting",
    title: "Hiring: Head of Sales",
    description:
      "Active job posting for Head of Sales — budget allocated and growth intent confirmed.",
    evidence: {
      event: "job_posting",
      title: "Head of Sales",
      department: "Sales",
      location: "Remote",
    },
    daysAgo: 3,
  },
  product_launch_analytics: {
    signalType: "product_launch",
    title: "Analytics Dashboard launched",
    description:
      "Company shipped a new analytics product — build-vs-buy inflection point for adjacent tools.",
    evidence: {
      event: "product_launch",
      product: "Analytics Dashboard",
      type: "feature",
      channel: "Product Hunt",
    },
    daysAgo: 7,
  },
  technology_change_crm: {
    signalType: "technology_change",
    title: "CRM switch detected: Salesforce → HubSpot",
    description:
      "Company switched CRM — actively reconsidering their stack, switching costs are low.",
    evidence: {
      event: "tech_change",
      category: "CRM",
      from: "Salesforce",
      to: "HubSpot",
    },
    daysAgo: 14,
  },
  test_signal_with_provider_id: {
    signalType: "test",
    title: "Test signal: provider ID (tier-1 dedup)",
    description: "Smoke-test signal with a provider-assigned event ID.",
    evidence: { event: "test_event", scenario: "with_provider_id", version: 1 },
    daysAgo: 1,
    providerEventId: "test-event-provider-id-001",
  },
  test_signal_fingerprint_only: {
    signalType: "test",
    title: "Test signal: content fingerprint (tier-2 dedup)",
    description: "Smoke-test signal with no provider ID — uses content fingerprint.",
    evidence: { event: "test_event", scenario: "fingerprint_only", version: 2 },
    daysAgo: 2,
  },
  test_signal_no_evidence: {
    signalType: "test",
    title: "Test signal: no evidence (tier-3, no dedup)",
    description: "Smoke-test signal with empty evidence — dedup key will be null.",
    evidence: {},
    daysAgo: 1,
  },
  test_signal_stale: {
    signalType: "test",
    title: "Test signal: stale (9 days ago, TTL=7d)",
    description:
      "Test signal that is already past its 7-day TTL — expires_at is in the past.",
    evidence: { event: "test_event", scenario: "stale", version: 3 },
    daysAgo: 9,
    providerEventId: "test-event-stale-001",
  },
  market_expansion: {
    signalType: "website_change",
    title: "New market expansion page detected",
    description:
      "Company added a new /enterprise or /industries page — indicates active expansion into a new segment.",
    evidence: {
      event: "website_change",
      change_type: "new_page",
      page: "/enterprise",
      detected_change: "Added enterprise pricing tier and case studies",
    },
    daysAgo: 4,
    providerEventId: "web-change-enterprise-page-001",
    sourceUrl: "https://example-acme.com/enterprise",
  },
};

// ── Fake provider ─────────────────────────────────────────────────────────────

export interface FakeFetchOptions extends FetchOptions {
  /**
   * Scenario names to generate events for.
   * Defaults to ["test_signal_with_provider_id"].
   */
  scenarios?: string[];
  /**
   * Override "now" for occurred_at calculation — pass in tests for determinism.
   * Defaults to the real current time.
   */
  asOf?: Date;
  /**
   * Appended to each scenario's providerEventId (e.g., a runId).
   * Use this in integration tests to prevent dedup collisions between runs.
   */
  eventIdSuffix?: string;
}

export class FakeSignalProvider implements SignalProvider {
  readonly id = "test";

  isConfigured(): boolean {
    return true;
  }

  async fetchEvents(
    companyIds: string[],
    clientId: string,
    opts: FakeFetchOptions = {},
  ): Promise<RawEventBatch> {
    const scenarioNames = opts.scenarios ?? ["test_signal_with_provider_id"];
    const asOf = opts.asOf ?? new Date();
    const limit = opts.limit ?? Infinity;
    const eventIdSuffix = opts.eventIdSuffix;

    const events: RawEventBatch["events"] = [];

    outer: for (const companyId of companyIds) {
      for (const name of scenarioNames) {
        if (events.length >= limit) break outer;

        const scenario = FAKE_SCENARIOS[name];
        if (!scenario) {
          throw new Error(
            `Unknown fake scenario: "${name}". ` +
              `Available: ${Object.keys(FAKE_SCENARIOS).join(", ")}`,
          );
        }

        events.push({
          companyId,
          clientId,
          rawEvent: buildRawEvent(scenario, asOf, eventIdSuffix),
        });
      }
    }

    return { events, meta: { source: "fake", generatedAt: new Date().toISOString() } };
  }

  static availableScenarios(): string[] {
    return Object.keys(FAKE_SCENARIOS);
  }
}

function buildRawEvent(scenario: FakeScenario, asOf: Date, eventIdSuffix?: string): RawSignalEvent {
  const occurredAt = new Date(
    asOf.getTime() - scenario.daysAgo * 24 * 60 * 60 * 1000,
  ).toISOString();
  const providerEventId = scenario.providerEventId != null && eventIdSuffix != null
    ? `${scenario.providerEventId}-${eventIdSuffix}`
    : scenario.providerEventId;
  return {
    providerEventId,
    source: "test",
    signalType: scenario.signalType,
    title: scenario.title,
    description: scenario.description,
    evidence: { ...scenario.evidence },
    occurredAt,
    sourceUrl: scenario.sourceUrl,
  };
}
