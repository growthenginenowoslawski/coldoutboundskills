/**
 * Proves Supabase connectivity + full CRUD from Node, without Trigger.dev.
 * Run: npx tsx src/scripts/roundtrip.ts
 */
import { runJobRoundtrip } from "../db/roundtrip";

runJobRoundtrip({ cleanup: true, log: (m) => console.log(m) })
  .then((r) => {
    console.log(`\n✅ Supabase round-trip OK — final status "${r.finalStatus}", cleaned up: ${r.cleanedUp}`);
  })
  .catch((e) => {
    console.error(`\n❌ Round-trip failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
