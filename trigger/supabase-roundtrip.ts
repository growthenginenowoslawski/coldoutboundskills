import { logger, task } from "@trigger.dev/sdk";
import { runJobRoundtrip } from "../src/db/roundtrip";

/**
 * Proves the Trigger.dev → Supabase path: this task creates, reads, updates,
 * and completes a row in the `jobs` table (then deletes it by default).
 *
 * Run it: `npm run trigger:dev`, then in the dashboard → Test, run
 * `supabase-roundtrip` with payload `{}` (or `{ "cleanup": false }` to leave
 * the row so you can see it in the table).
 */
export const supabaseRoundtrip = task({
  id: "supabase-roundtrip",
  run: async (payload: { cleanup?: boolean }) => {
    const result = await runJobRoundtrip({
      cleanup: payload.cleanup ?? true,
      log: (msg) => logger.info(msg),
    });
    logger.info("round-trip complete", { ...result });
    return result;
  },
});
