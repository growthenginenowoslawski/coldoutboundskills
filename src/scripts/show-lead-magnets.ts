/**
 * Shows lead magnet brainstorm results for a client.
 * Run: npx tsx src/scripts/show-lead-magnets.ts <slug>
 */
import { listLeadMagnets } from "../db/lead-magnets";

const slug = process.argv[2];
if (!slug) { console.error("usage: show-lead-magnets.ts <slug>"); process.exit(1); }

const rows = await listLeadMagnets(slug);
if (rows.length === 0) {
  console.log(`No lead magnets found for "${slug}".`);
  process.exit(0);
}

const selected = rows.find(r => r.status === "selected");
console.log(`\n▸ Lead magnets for ${slug}  (${rows.length} total)`);
if (selected) console.log(`  ★ Selected: ${selected.name} [${selected.archetype_key}]`);

for (const r of rows) {
  const tag = r.status === "selected" ? "★" : r.status === "rejected" ? "✗" : "·";
  const rankStr = r.rank != null ? ` #${r.rank}` : "";
  const scoreStr = r.score != null ? ` score=${r.score}/20` : "";
  console.log(`\n  ${tag}${rankStr} [${r.archetype_key}] ${r.name}${scoreStr}`);
  if (r.description) console.log(`     ${r.description}`);
  if (r.cta_example) console.log(`     CTA: "${r.cta_example}"`);
  if (r.delivery_notes) console.log(`     Delivery: ${r.delivery_notes}`);
}
