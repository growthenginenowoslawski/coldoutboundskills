/**
 * Triggers the `company-research` parent task and polls to completion, then
 * prints the PREVIEW (records written) + the insert/dedup report.
 * Requires a dev worker (`npm run trigger:dev`). Runs a LIVE Apify search.
 *
 * Run: npx tsx src/scripts/run-company-research.ts "coffee shops" "Austin, TX" 5
 */
import "../config/env";
import { runs } from "@trigger.dev/sdk";
import { companyResearch } from "../../trigger/company-research";

const TERMINAL = new Set([
  "COMPLETED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
  "INTERRUPTED",
]);

const query = {
  industry: process.argv[2] ?? "coffee shops",
  location: process.argv[3] ?? "Austin, TX",
  limit: Number(process.argv[4] ?? 5),
};

console.log("Triggering company-research:", query, "\n");
const handle = await companyResearch.trigger({ query });
console.log(`run: ${handle.id}`);

let final: Awaited<ReturnType<typeof runs.retrieve>> | undefined;
for (let i = 0; i < 90; i++) {
  const r = await runs.retrieve(handle.id);
  if (TERMINAL.has(r.status)) {
    final = r;
    break;
  }
  await new Promise((res) => setTimeout(res, 2000));
}

if (!final) {
  console.error("❌ run did not finish in time");
  process.exit(1);
}
if (final.status !== "COMPLETED") {
  console.error(`❌ run ${final.status}:`, JSON.stringify(final.output ?? final.error));
  process.exit(1);
}

const out = final.output as {
  jobId: string;
  listId: string | null;
  environment: string;
  scraped: number;
  unique: number;
  withinRunDuplicates: number;
  insertedCount: number;
  existingCount: number;
  preview: Record<string, unknown>[];
  inserted: { id: string; name: string; domain: string | null }[];
  existing: { id: string; name: string; domain: string | null }[];
  stepErrors?: string[];
  failedBatches?: number;
  batchErrors?: string[];
};

if (out.stepErrors && out.stepErrors.length > 0) {
  console.error("\n⚠️  provider step errors:");
  for (const e of out.stepErrors) console.error(`   - ${e}`);
}

console.log("\n================ PREVIEW (records written) ================");
for (const p of out.preview) {
  console.log(`- ${p.name} | ${p.domain ?? "(no website)"} | ${[p.city, p.region, p.country].filter(Boolean).join(", ")}`);
}

console.log("\n================ REPORT ================");
console.log(`environment:          ${out.environment}`);
console.log(`scraped (raw):        ${out.scraped}`);
console.log(`unique (post-dedup):  ${out.unique}  (within-run duplicates removed: ${out.withinRunDuplicates})`);
console.log(`inserted (new):       ${out.insertedCount}`);
console.log(`existing (DB dedup):  ${out.existingCount}`);
console.log(`failed batches:       ${out.failedBatches ?? 0}`);
if (out.batchErrors && out.batchErrors.length) {
  for (const e of out.batchErrors) console.log(`   ! ${e}`);
}
console.log(`jobId:                ${out.jobId}`);
console.log(`listId:               ${out.listId}`);
console.log("\n✅ company-research completed");
