/**
 * LIVE Apify test — SPENDS APIFY CREDITS. Runs the Google Maps provider for a
 * small search and prints normalized + deduped companies. Does NOT write to
 * Supabase (qualification/storage come in later stages).
 *
 * Run: npx tsx src/scripts/test-apify.ts "coffee shops" "Austin, TX" 5
 */
import "../config/env";
import { ApifyGoogleMapsProvider } from "../providers/apify/google-maps";
import { dedupeCompanies } from "../lib/dedup";

const provider = new ApifyGoogleMapsProvider();
if (!provider.isConfigured()) {
  console.error("APIFY_API_TOKEN is not set in .env — cannot run.");
  process.exit(1);
}

const query = {
  industry: process.argv[2] ?? "coffee shops",
  location: process.argv[3] ?? "Austin, TX",
  limit: Number(process.argv[4] ?? 5),
};

console.log("Searching:", query, "\n(this spends Apify credits)…\n");
const companies = await provider.searchCompanies(query);
const { unique, duplicates } = dedupeCompanies(companies);

console.log(`Got ${companies.length} place(s), ${unique.length} unique (${duplicates} dup):\n`);
for (const c of unique) {
  console.log(`- ${c.name} | ${c.domain ?? "(no website)"} | ${c.location ?? ""} | ${c.industry ?? ""}`);
}
