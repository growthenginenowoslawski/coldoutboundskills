/**
 * Shows campaign strategy ideas for a client.
 * Run: npx tsx src/scripts/show-campaign-strategy.ts <slug>
 */
import { listCampaignStrategies } from "../db/campaign-strategies";

const slug = process.argv[2];
if (!slug) { console.error("usage: show-campaign-strategy.ts <slug>"); process.exit(1); }

const rows = await listCampaignStrategies(slug);
if (rows.length === 0) { console.log(`No campaign strategies found for "${slug}".`); process.exit(0); }

console.log(`\n▸ Campaign strategies for ${slug}  (${rows.length} total)`);
for (const r of rows) {
  const tag = r.status === "approved" ? "✓" : r.status === "active" ? "★" : "·";
  const rankStr = r.rank != null ? ` #${r.rank}` : "";
  const type = r.is_no_ai ? " [no-AI]" : r.is_front_end_offer ? " [front-end offer]" : "";
  console.log(`\n  ${tag}${rankStr} ${r.campaign_name}  (${r.targeting_level ?? "?"})${type}`);
  if (r.value_proposition) console.log(`     Value: ${r.value_proposition}`);
  if (r.list_filters) console.log(`     Filters: ${r.list_filters}`);
}
