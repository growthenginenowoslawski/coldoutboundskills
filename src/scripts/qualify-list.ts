/**
 * Stage 5 test: qualify the companies in a TEST list against an ICP with Claude.
 *
 * DEFAULT IS DRY RUN — prints structured results, writes NOTHING to Supabase.
 * Pass --store to persist qualifications (enrichment_runs + companies.icp_score).
 * NEVER changes companies.status (no auto-promotion review→approved).
 *
 * Run: npx tsx src/scripts/qualify-list.ts <listId> [--store]
 */
import "../config/env";
import { getSupabaseAdmin } from "../db/supabase";
import { storeQualification } from "../db/qualifications";
import { ModelRouter } from "../providers/ai/model-router";
import type { CompanyRecord, QualificationInput } from "../domain/types";

const listId = process.argv[2];
const doStore = process.argv.includes("--store");
if (!listId) {
  console.error("usage: qualify-list.ts <listId> [--store]");
  process.exit(1);
}

// Sample ICP for the first test. Real campaigns will pass their own ICP.
const ICP: QualificationInput["icp"] = {
  industry: "specialty coffee shop / independent café",
  location: "Austin, TX, USA",
  keywords: ["coffee", "café", "espresso"],
  description:
    "Independent, single-location specialty coffee shops in the Austin metro. Chains and franchises are a weaker fit.",
};

const provider = ModelRouter.route("icp_qualification");
if (!provider.isConfigured()) {
  console.error("OPENROUTER_API_KEY is not set in .env — cannot run qualification.");
  process.exit(1);
}

const db = getSupabaseAdmin();
const { data: members, error } = await db
  .from("list_members")
  .select("company_id, companies(id, name, domain, website_url, industry, city, region, country, company_size)")
  .eq("list_id", listId);
if (error) throw new Error(error.message);

console.log(`ICP:\n${JSON.stringify(ICP, null, 2)}\n`);
console.log(`Qualifying ${members?.length ?? 0} companies (dry-run=${!doStore})…\n`);

for (const m of members ?? []) {
  const co = (m as { companies: Record<string, string | null> }).companies;
  const company: CompanyRecord = {
    name: co.name ?? "(unknown)",
    domain: co.domain ?? undefined,
    website: co.website_url ?? undefined,
    industry: co.industry ?? undefined,
    city: co.city ?? undefined,
    region: co.region ?? undefined,
    country: co.country ?? undefined,
    source: "supabase",
    fetchedAt: new Date().toISOString(),
  };
  const input: QualificationInput = { company, icp: ICP };

  const startedAt = new Date().toISOString();
  const result = await provider.qualifyCompany(input);

  console.log(`— ${company.name} (${company.domain ?? "no domain"})`);
  console.log(`  fit=${result.icpFit} score=${result.score} confidence=${result.confidence}`);
  console.log(`  industry=${result.industryMatch} size=${result.sizeMatch} location=${result.locationMatch}`);
  console.log(`  reason: ${result.reason}`);
  if (result.signals.length) console.log(`  signals: ${result.signals.join("; ")}`);

  if (doStore && co.id) {
    const { enrichmentRunId } = await storeQualification(co.id, input, result, startedAt, {
      updateIcpScore: true,
    });
    console.log(`  stored → enrichment_runs ${enrichmentRunId}, companies.icp_score=${result.score} (status unchanged)`);
  }
  console.log("");
}

console.log(doStore ? "✅ qualified + stored" : "✅ qualified (dry run — nothing written)");
