import { logger, task } from "@trigger.dev/sdk";
import type { CompanyRecord, SearchQuery } from "../src/domain/types";
import { ApifyGoogleMapsProvider } from "../src/providers/apify/google-maps";
import { LeadSourceWaterfall } from "../src/providers/registry";
import { dedupeCompanies } from "../src/lib/dedup";
import { chunk } from "../src/lib/chunk";
import { completeJob, createJob, updateJob } from "../src/db/jobs";
import { createList, DEFAULT_COMPANY_STATUS, type StoredCompany } from "../src/db/companies";
import { storeCompaniesBatch } from "./store-companies-batch";

const BATCH_SIZE = 25;

/**
 * Parent research task: source → dedup → PREVIEW → create TEST list → fan out to
 * child storage tasks → aggregate → record on the `jobs` row. Writes only into
 * the TEST environment. Never calls Anthropic (qualification is a later stage).
 */
export const companyResearch = task({
  id: "company-research",
  run: async (payload: { query: SearchQuery; environment?: string; status?: string }) => {
    const environment = payload.environment ?? "test";
    const companyStatus = payload.status ?? DEFAULT_COMPANY_STATUS;
    const waterfall = new LeadSourceWaterfall([new ApifyGoogleMapsProvider()]);

    const job = await createJob({
      jobType: "company_research",
      provider: "apify",
      totalItems: payload.query.limit,
      inputData: { query: payload.query, environment },
    });
    logger.info("job created", { jobId: job.id });

    try {
      // SOURCE
      const { companies: sourced, steps } = await waterfall.run(payload.query);
      const stepErrors = steps
        .filter((s) => s.error)
        .map((s) => `${s.provider}: ${s.error}`);
      logger.info("sourced", { scraped: sourced.length, steps });

      // DEDUP (within this run)
      const { unique, duplicates } = dedupeCompanies(sourced);

      // PREVIEW — logged BEFORE any insert
      const preview = unique.map((c) => ({
        name: c.name,
        domain: c.domain ?? null,
        website: c.website ?? null,
        industry: c.industry ?? null,
        city: c.city ?? null,
        region: c.region ?? null,
        country: c.country ?? null,
        source: c.source,
      }));
      logger.info("PREVIEW — records to be written (pre-insert)", {
        count: preview.length,
        preview,
      });

      // Nothing to store — fail the job with the provider errors surfaced.
      // (batchTriggerAndWait requires >= 1 item, so we must not fan out on empty.)
      if (unique.length === 0) {
        const reason = stepErrors.length
          ? stepErrors.join("; ")
          : "no companies returned by any source";
        logger.error("no companies sourced", { stepErrors });
        await updateJob(job.id, { status: "failed", errorMessage: reason });
        return {
          jobId: job.id,
          listId: null,
          environment,
          scraped: sourced.length,
          unique: 0,
          withinRunDuplicates: duplicates,
          insertedCount: 0,
          existingCount: 0,
          preview,
          inserted: [] as StoredCompany[],
          existing: [] as StoredCompany[],
          stepErrors,
        };
      }

      // TEST list
      const list = await createList({
        name: `Apify GMaps — ${payload.query.industry ?? "search"} — ${payload.query.location ?? ""} — ${new Date().toISOString().slice(0, 10)}`,
        environment,
        status: "active",
        description: `Auto-sourced ${environment} list (${sourced.length} scraped, ${unique.length} unique)`,
      });
      logger.info("list created", { listId: list.id, environment });

      // FAN OUT — strip raw payload before sending to children, then batch.
      const lean: CompanyRecord[] = unique.map(({ raw, ...rest }) => rest);
      const batches = chunk(lean, BATCH_SIZE);
      const batchResults = await storeCompaniesBatch.batchTriggerAndWait(
        batches.map((b) => ({ payload: { listId: list.id, companies: b, status: companyStatus } })),
      );

      // AGGREGATE
      const inserted: StoredCompany[] = [];
      const existing: StoredCompany[] = [];
      let failedBatches = 0;
      const batchErrors: string[] = [];
      for (const r of batchResults.runs) {
        if (r.ok) {
          inserted.push(...r.output.inserted);
          existing.push(...r.output.existing);
        } else {
          failedBatches++;
          const msg = r.error instanceof Error ? r.error.message : String(r.error);
          batchErrors.push(msg);
          logger.error("batch failed", { error: msg });
        }
      }
      // A storage failure must not masquerade as success.
      if (failedBatches > 0 && inserted.length === 0 && existing.length === 0) {
        await updateJob(job.id, {
          status: "failed",
          errorMessage: batchErrors.join("; ") || "all storage batches failed",
        });
        throw new Error(`all ${failedBatches} storage batch(es) failed: ${batchErrors.join("; ")}`);
      }

      await completeJob(job.id, {
        successfulItems: inserted.length + existing.length,
        failedItems: failedBatches,
        outputData: {
          listId: list.id,
          environment,
          scraped: sourced.length,
          unique: unique.length,
          withinRunDuplicates: duplicates,
          inserted: inserted.length,
          existing: existing.length,
        },
      });

      return {
        jobId: job.id,
        listId: list.id,
        environment,
        scraped: sourced.length,
        unique: unique.length,
        withinRunDuplicates: duplicates,
        insertedCount: inserted.length,
        existingCount: existing.length,
        failedBatches,
        batchErrors,
        preview,
        inserted,
        existing,
        stepErrors,
      };
    } catch (err) {
      await updateJob(job.id, {
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});
