/**
 * Shows campaign review status for a client.
 * Run: npx tsx src/scripts/show-campaign-reviews.ts <slug>
 */
import { listCampaignReviews } from "../db/campaign-reviews";

const slug = process.argv[2];
if (!slug) { console.error("usage: show-campaign-reviews.ts <slug>"); process.exit(1); }

const rows = await listCampaignReviews(slug) as any[];
if (rows.length === 0) { console.log(`No campaign reviews found for "${slug}".`); process.exit(0); }

const statusIcon: Record<string, string> = {
  pending_review:    "⏳",
  scripts_shared:    "📄",
  list_shared:       "📋",
  feedback_received: "💬",
  revisions_made:    "✏️",
  approved:          "✅",
};

console.log(`\n▸ Campaign reviews for ${slug}  (${rows.length} total)`);
for (const r of rows) {
  const icon = statusIcon[r.status] ?? "·";
  console.log(`\n  ${icon} [${r.status}]  created ${r.created_at?.slice(0, 10)}`);
  if (r.scripts_shared_at)  console.log(`     Scripts shared: ${r.scripts_shared_at.slice(0, 10)}${r.scripts_share_url ? `  → ${r.scripts_share_url}` : ""}`);
  if (r.list_shared_at)     console.log(`     List shared:    ${r.list_shared_at.slice(0, 10)}${r.list_share_url ? `  → ${r.list_share_url}` : ""}`);
  if (r.client_feedback)    console.log(`     Feedback: ${r.client_feedback}`);
  if (r.revision_count > 0) console.log(`     Revisions: ${r.revision_count}`);
  if (r.approved_at)        console.log(`     ✅ GREEN LIGHT from ${r.approved_by ?? "client"} on ${r.approved_at.slice(0, 10)}`);
}
