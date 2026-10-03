import { logger, task } from "@trigger.dev/sdk";
import { storeCompaniesInList } from "../src/db/companies";
import type { CompanyRecord } from "../src/domain/types";

/**
 * Child task: stores ONE batch of companies into a list. The parent
 * (company-research) fans out to N of these so we never process a huge list in
 * a single synchronous run.
 */
export const storeCompaniesBatch = task({
  id: "store-companies-batch",
  run: async (payload: { listId: string; companies: CompanyRecord[]; status?: string }) => {
    const res = await storeCompaniesInList(payload.listId, payload.companies, payload.status ?? "new");
    logger.info("batch stored", {
      inserted: res.inserted.length,
      existing: res.existing.length,
    });
    return res;
  },
});
