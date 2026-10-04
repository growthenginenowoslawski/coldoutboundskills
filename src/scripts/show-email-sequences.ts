/**
 * Shows email sequences for a client.
 * Run: npx tsx src/scripts/show-email-sequences.ts <slug>
 */
import { listEmailSequences } from "../db/email-sequences";

const slug = process.argv[2];
if (!slug) { console.error("usage: show-email-sequences.ts <slug>"); process.exit(1); }

const rows = await listEmailSequences(slug) as any[];
if (rows.length === 0) { console.log(`No email sequences found for "${slug}".`); process.exit(0); }

console.log(`\n▸ Email sequences for ${slug}  (${rows.length} total)`);
for (const r of rows) {
  const tag = r.status === "active" ? "★" : r.status === "approved" ? "✓" : "·";
  const score = r.overall_score != null ? `  score=${r.overall_score}/100` : "";
  console.log(`\n  ${tag} ${r.name}${score}  [${r.status}]`);
  if (r.campaign_angle) console.log(`     Angle: ${r.campaign_angle}`);
  const steps = (r.email_sequence_steps ?? []).sort((a: any, b: any) => a.step - b.step);
  for (const s of steps) {
    const thread = s.is_new_thread ? " (new thread)" : " (threaded)";
    console.log(`     Step ${s.step} — Day ${s.delay_days}${thread}  [${s.strategy_type ?? "?"}]  ${s.variants?.length ?? 0} variant(s)`);
  }
}
