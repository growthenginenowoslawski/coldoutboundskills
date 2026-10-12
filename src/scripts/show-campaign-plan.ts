/**
 * Shows the latest campaign plan for a client.
 * Run: npx tsx src/scripts/show-campaign-plan.ts <slug>
 */
import { getCampaignPlan } from "../db/campaign-plans";

const slug = process.argv[2];
if (!slug) { console.error("usage: show-campaign-plan.ts <slug>"); process.exit(1); }

const plan = await getCampaignPlan(slug);
if (!plan) { console.log(`No campaign plan found for "${slug}".`); process.exit(0); }

console.log(`\n▸ Campaign plan for ${slug}  [${plan.status}]  generated ${plan.generated_at.slice(0, 10)}`);
if (plan.business_summary) console.log(`\n  Business: ${plan.business_summary}`);
if (plan.icp_summary)      console.log(`  ICP: ${plan.icp_summary}`);
if (plan.offer_summary)    console.log(`  Offer: ${plan.offer_summary}`);
if (plan.top_campaign_names?.length) {
  console.log(`\n  Top campaigns:`);
  plan.top_campaign_names.forEach((n, i) => console.log(`    ${i + 1}. ${n}`));
}
if (plan.infrastructure_status) {
  console.log(`\n  Infrastructure:`, JSON.stringify(plan.infrastructure_status, null, 4));
}
if (plan.next_steps) console.log(`\n  Next steps:\n  ${plan.next_steps.replace(/\n/g, "\n  ")}`);
