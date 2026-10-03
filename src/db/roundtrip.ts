/**
 * The create → read → update → complete round-trip, as a reusable function so
 * BOTH the standalone script and the Trigger.dev task run identical code.
 */
import { completeJob, createJob, deleteJob, getJob, updateJob } from "./jobs";

export interface RoundtripResult {
  jobId: string;
  steps: string[];
  finalStatus: string;
  cleanedUp: boolean;
}

/**
 * @param cleanup delete the test row at the end (default true) so the business
 *   `jobs` table isn't polluted by connectivity checks.
 * @param log optional line logger (console.log or Trigger.dev logger).
 */
export async function runJobRoundtrip(opts: {
  cleanup?: boolean;
  log?: (msg: string) => void;
} = {}): Promise<RoundtripResult> {
  const cleanup = opts.cleanup ?? true;
  const log = opts.log ?? (() => {});
  const steps: string[] = [];

  log("1) CREATE test job…");
  const created = await createJob({
    jobType: "connectivity_test",
    provider: "trigger.dev",
    totalItems: 1,
    inputData: { note: "Stage 2 Supabase round-trip", at: new Date().toISOString() },
  });
  steps.push(`created ${created.id} (status=${created.status})`);
  log(`   id=${created.id} status=${created.status}`);

  log("2) READ it back…");
  const read = await getJob(created.id);
  if (!read) throw new Error("READ returned null right after insert");
  steps.push(`read (status=${read.status})`);
  log(`   status=${read.status}`);

  log("3) UPDATE → running…");
  const running = await updateJob(created.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    processedItems: 1,
  });
  steps.push(`updated (status=${running.status}, processed=${running.processed_items})`);
  log(`   status=${running.status} processed=${running.processed_items}`);

  log("4) COMPLETE…");
  const done = await completeJob(created.id, { successfulItems: 1, outputData: { ok: true } });
  if (done.status !== "completed" || !done.completed_at) {
    throw new Error(`COMPLETE did not persist (status=${done.status})`);
  }
  steps.push(`completed (completed_at=${done.completed_at})`);
  log(`   status=${done.status} completed_at=${done.completed_at}`);

  let cleanedUp = false;
  if (cleanup) {
    log("5) CLEANUP (delete test row)…");
    await deleteJob(created.id);
    const gone = await getJob(created.id);
    if (gone !== null) throw new Error("cleanup failed — test row still present");
    cleanedUp = true;
    steps.push("deleted test row");
    log("   deleted ✓");
  }

  return { jobId: created.id, steps, finalStatus: done.status, cleanedUp };
}
