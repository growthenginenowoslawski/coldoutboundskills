/**
 * Lead-source waterfall: run configured providers IN ORDER, dedup after each,
 * and stop as soon as we've collected `limit` unique companies.
 *
 * Why a waterfall: it lets you set a cheap/primary source first and only fall
 * through to costlier sources when needed — the core of your cost-control +
 * "swap providers later" requirements. Adding a provider = add one adapter and
 * drop it into the array; nothing else changes.
 */
import type { CompanyRecord, SearchQuery } from "../domain/types";
import type { LeadSourceProvider } from "./types";
import { dedupKey } from "../lib/dedup";

export interface WaterfallStep {
  provider: string;
  found: number;
  /** New uniques this provider contributed. */
  added: number;
  /** Running unique total after this step. */
  total: number;
  error?: string;
}

export interface WaterfallResult {
  companies: CompanyRecord[];
  steps: WaterfallStep[];
}

export class LeadSourceWaterfall {
  constructor(private readonly providers: LeadSourceProvider[]) {}

  /** Providers whose credentials are present, in configured order. */
  configured(): LeadSourceProvider[] {
    return this.providers.filter((p) => p.isConfigured());
  }

  async run(
    query: SearchQuery,
    opts: { onStep?: (step: WaterfallStep) => void } = {},
  ): Promise<WaterfallResult> {
    const seen = new Map<string, CompanyRecord>();
    const steps: WaterfallStep[] = [];

    for (const provider of this.configured()) {
      if (seen.size >= query.limit) break;

      const remaining = query.limit - seen.size;
      let found: CompanyRecord[] = [];
      let error: string | undefined;
      try {
        found = await provider.searchCompanies({ ...query, limit: remaining });
      } catch (err) {
        // One provider failing must not sink the whole waterfall.
        error = err instanceof Error ? err.message : String(err);
      }

      const before = seen.size;
      for (const c of found) {
        const key = dedupKey(c);
        if (!seen.has(key)) seen.set(key, c);
        if (seen.size >= query.limit) break;
      }

      const step: WaterfallStep = {
        provider: provider.id,
        found: found.length,
        added: seen.size - before,
        total: seen.size,
        error,
      };
      steps.push(step);
      opts.onStep?.(step);
    }

    return { companies: [...seen.values()].slice(0, query.limit), steps };
  }
}
