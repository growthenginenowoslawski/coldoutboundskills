/**
 * Shows list quality scorecard runs for a client.
 * Run: npx tsx src/scripts/show-list-quality.ts <slug>
 */
import { listQualityScores } from "../db/list-quality-scores";

const slug = process.argv[2];
if (!slug) { console.error("usage: show-list-quality.ts <slug>"); process.exit(1); }

const rows = await listQualityScores(slug) as any[];
if (rows.length === 0) { console.log(`No list quality scores found for "${slug}".`); process.exit(0); }

console.log(`\n▸ List quality scores for ${slug}  (${rows.length} runs)`);
for (const r of rows) {
  console.log(`\n  ${r.grade}  ${r.overall_score}/100  —  ${r.list_name ?? "unnamed list"}  (${r.total_rows ?? "?"} rows)  scored ${r.scored_at?.slice(0, 10)}`);
  const dims = [
    ["Email verification",  r.email_verification_score],
    ["Duplicate emails",    r.duplicate_email_score],
    ["Duplicate domains",   r.duplicate_domain_score],
    ["Title relevance",     r.title_relevance_score],
    ["Bad titles",          r.bad_title_score],
    ["Catch-all density",   r.catchall_density_score],
    ["ICP fit",             r.icp_fit_score],
    ["Name quality",        r.name_quality_score],
  ];
  for (const [label, score] of dims) {
    if (score != null) console.log(`     ${String(label).padEnd(22)} ${score}/100`);
  }
  if (r.top_issues?.length) {
    console.log(`     Issues:`);
    r.top_issues.forEach((issue: string, i: number) => console.log(`       ${i + 1}. ${issue}`));
  }
}
