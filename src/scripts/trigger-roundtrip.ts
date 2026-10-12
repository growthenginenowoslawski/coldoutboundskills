/**
 * Triggers the `supabase-roundtrip` Trigger.dev task and polls until it
 * finishes, proving the Trigger.dev → Supabase path end-to-end. Requires a dev
 * worker to be running (`npm run trigger:dev`).
 *
 * Run: npx tsx src/scripts/trigger-roundtrip.ts
 */
import "../config/env"; // loads .env so TRIGGER_SECRET_KEY is available
import { runs } from "@trigger.dev/sdk";
import { supabaseRoundtrip } from "../../trigger/supabase-roundtrip";

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

const handle = await supabaseRoundtrip.trigger({ cleanup: true });
console.log(`triggered run: ${handle.id}`);

let final: Awaited<ReturnType<typeof runs.retrieve>> | undefined;
for (let i = 0; i < 60; i++) {
  const r = await runs.retrieve(handle.id);
  console.log(`  [${i}] status=${r.status}`);
  if (TERMINAL.has(r.status)) {
    final = r;
    break;
  }
  await new Promise((res) => setTimeout(res, 2000));
}

if (!final) {
  console.error("❌ run did not reach a terminal state in time");
  process.exit(1);
}

console.log(`\nfinal status: ${final.status}`);
console.log(`output: ${JSON.stringify(final.output)}`);
if (final.status !== "COMPLETED") {
  console.error("❌ Trigger.dev → Supabase round-trip FAILED");
  process.exit(1);
}
console.log("\n✅ Trigger.dev → Supabase round-trip OK");
