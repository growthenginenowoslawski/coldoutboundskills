/**
 * Fake PredictLeads news_events fixtures + provider — Stage 30C.3.
 *
 * Makes NO external API calls, reads NO env, touches NO database. Serves
 * canned JSON:API responses through the pure news-event mapper so the mapping
 * can be exercised end to end offline.
 *
 * Intentionally NOT registered in registry.ts and not wired to production.
 * Fixture content is invented (UK creative-agency flavoured) — not real data.
 */

import type { SignalProvider, FetchOptions } from "./types";
import type { RawEventBatch } from "../../domain/signal-types";
import { mapNewsEventsResponse } from "./news-event-mapper";

export const FAKE_NEWS_EVENTS_FIXTURES: Record<string, unknown> = {
  "northlight-studio.example": {
    data: [
      {
        id: "news-001",
        type: "news_event",
        attributes: {
          category: "acquisition",
          summary: "Northlight Studio acquires Brightside Creative, adding a 12-person design team",
          found_at: "2026-09-20T08:15:00.000Z",
          published_at: "2026-09-19",
          confidence: 0.92,
          url: "https://news.example/northlight-acquires-brightside",
        },
      },
      {
        id: "news-002",
        type: "news_event",
        attributes: {
          category: "receives_award",
          summary: "Northlight Studio wins Gold at the UK Design Awards",
          found_at: "2026-09-22T10:00:00.000Z",
        },
      },
      {
        id: "news-003",
        type: "news_event",
        attributes: {
          category: "hires",
          summary: "Northlight Studio appoints new Managing Director",
          found_at: "2026-09-25T09:00:00.000Z",
        },
      },
    ],
  },
  "quietlane.example": { data: [] },
  "broken.example": { data: "not-an-array" },
};

export interface FakeNewsFetchOptions extends FetchOptions {
  /** Reference "now" so tests are deterministic. */
  now?: string;
}

export class FakeNewsEventsSignalProvider implements SignalProvider {
  readonly id = "fake-news-events";

  isConfigured(): boolean {
    return true;
  }

  async fetchEvents(
    companyIds: string[],
    clientId: string,
    opts: FakeNewsFetchOptions = {},
  ): Promise<RawEventBatch> {
    const events: RawEventBatch["events"] = [];
    const meta: Record<string, unknown> = { source: this.id, companiesRequested: companyIds.length };
    const skipped: Record<string, unknown> = {};

    for (const companyId of companyIds) {
      const domain = opts.companyDomains?.get(companyId);
      if (!domain) continue;
      const result = mapNewsEventsResponse(FAKE_NEWS_EVENTS_FIXTURES[domain] ?? { data: [] }, {
        companyId,
        clientId,
        domain,
        source: this.id,
        since: opts.since ?? null,
        now: opts.now,
      });
      events.push(...result.events);
      if (result.skipped.length || result.responseError) {
        skipped[companyId] = { skipped: result.skipped, responseError: result.responseError };
      }
    }

    meta.eventsReturned = events.length;
    if (Object.keys(skipped).length) meta.skipped = skipped;
    return { events: opts.limit != null ? events.slice(0, opts.limit) : events, meta };
  }
}
