/**
 * Generic task execution checkpoint — Stage 9.
 *
 * Stores durable progress snapshots in jobs.output_data so that
 * Trigger.dev retries can resume from the last completed step rather than
 * re-running every step from scratch.
 *
 * ── Why generic? ─────────────────────────────────────────────────────────────
 *
 * The same checkpoint pattern applies to every AI GTM task:
 *   icp_qualification, personalization, campaign_strategy,
 *   reply_classify, signal_analysis, enrichment
 *
 * This module has NO imports from AI domain types, DB helpers, or Trigger.dev.
 * The caller (trigger task) is responsible for casting typed data to/from
 * the checkpoint's `result` and `escalationData` (`unknown`) fields.
 *
 * ── Checkpoint lifecycle ──────────────────────────────────────────────────────
 *
 *   pending
 *     → running              (task started)
 *     → ai_executed          (AI call succeeded; checkpoint written BEFORE DB write)
 *     → enrichment_stored    (DB rows written; checkpoint written BEFORE completeJob)
 *     → completed            (job finalized)
 *
 *   Any stage can transition to → failed (trigger task catches and records)
 *
 * ── Retry recovery decision table ────────────────────────────────────────────
 *
 *   Job status  | Checkpoint stage   | Decision
 *   ------------+--------------------+----------------
 *   completed   | (any)              | done
 *   running     | enrichment_stored  | complete_job
 *   running     | ai_executed        | store_enrichment
 *   running     | (none)             | run_all
 *   failed      | (any)              | run_all
 *   cancelled   | (any)              | run_all
 *   pending     | (any)              | run_all
 *   (not found) | -                  | run_all
 *
 * NOTE: The jobs table constraint allows only: pending, running, completed,
 * failed, cancelled.  We do NOT use the status column to track "ai_executed"
 * or "enrichment_stored" — those stages live ONLY in output_data._checkpoint.stage.
 * This avoids a DDL migration while still providing full checkpoint recovery.
 *
 * ── Duplicate prevention guarantees ─────────────────────────────────────────
 *
 *   - AI call:          only happens in "run_all" path.
 *                       "store_enrichment" reuses the escalation data already stored
 *                       in the "ai_executed" checkpoint. Zero extra AI calls.
 *
 *   - enrichment_runs:  only happens in "run_all" and "store_enrichment" paths.
 *                       "complete_job" reuses enrichmentRunIds from the checkpoint.
 *                       Zero extra DB rows.
 *
 *   - Known gap (Stage 12): if the status update to "enrichment_stored" fails
 *     AFTER the enrichment_runs write, a retry re-runs the enrichment_runs write.
 *     Eliminated by a DB-level unique constraint on enrichment_runs (Stage 12).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** The two durable steps between "running" and "completed". */
export type CheckpointStage = "ai_executed" | "enrichment_stored";

/**
 * Snapshot stored in jobs.output_data under the "_checkpoint" key.
 *
 * Fields are optional to keep storage minimal at each stage:
 *   - ai_executed:          result + escalationData present; enrichmentRunIds absent
 *   - enrichment_stored:    result + enrichmentRunIds present; escalationData absent
 */
export interface AITaskCheckpoint {
  stage: CheckpointStage;
  /** AI result as a plain JSON object (typed by the caller). */
  result: unknown;
  /**
   * Serialized escalation data needed for the enrichment_runs write.
   * Present ONLY at the "ai_executed" stage — dropped after enrichment is stored
   * to avoid carrying a large payload in the job row indefinitely.
   */
  escalationData?: unknown;
  /** IDs of enrichment_run rows written. Present from "enrichment_stored" onwards. */
  enrichmentRunIds?: string[];
  /** The final (accepted) enrichment_run row ID. */
  finalEnrichmentRunId?: string | null;
  /** ISO timestamp anchored before the AI call started. */
  startedAt: string;
  /** ISO timestamp of when this checkpoint was persisted. */
  savedAt: string;
}

/** The full jobs.output_data payload for checkpoint-aware tasks. */
export interface CheckpointJobOutput {
  _checkpoint: AITaskCheckpoint;
  [key: string]: unknown;
}

/**
 * What the Trigger.dev task should do when it encounters an existing job row.
 *
 * done             → return the cached output immediately; no DB or AI work
 * complete_job     → enrichment_runs already written; call completeJob and return
 * store_enrichment → AI ran; call storeEscalationResult then completeJob
 * run_all          → no usable checkpoint; run the full AI + DB + complete flow
 */
export type ResumeDecision = "done" | "complete_job" | "store_enrichment" | "run_all";

// ── Checkpoint reads ──────────────────────────────────────────────────────────

/**
 * Extract a checkpoint from jobs.output_data.
 * Returns null when the field is absent, malformed, or missing required keys.
 * Null-safe for legacy job rows that pre-date the checkpoint pattern.
 */
export function readCheckpoint(outputData: unknown): AITaskCheckpoint | null {
  if (!outputData || typeof outputData !== "object" || Array.isArray(outputData)) return null;
  const data = outputData as Record<string, unknown>;
  if (!data._checkpoint || typeof data._checkpoint !== "object" || Array.isArray(data._checkpoint)) return null;
  const cp = data._checkpoint as Partial<AITaskCheckpoint>;
  // Require the two fields that are always present on a valid checkpoint.
  if (typeof cp.stage !== "string" || typeof cp.startedAt !== "string") return null;
  if (cp.stage !== "ai_executed" && cp.stage !== "enrichment_stored") return null;
  return data._checkpoint as AITaskCheckpoint;
}

// ── Checkpoint writes ─────────────────────────────────────────────────────────

/**
 * Build the output_data for the "ai_executed" checkpoint.
 * Called immediately after the AI call succeeds, BEFORE any DB writes.
 *
 * The escalationData field stores everything storeEscalationResult() needs so
 * that a retry can skip the AI call and go straight to the DB write.
 */
export function buildAIExecutedCheckpoint(
  result: unknown,
  escalationData: unknown,
  startedAt: string,
): CheckpointJobOutput {
  return {
    _checkpoint: {
      stage: "ai_executed",
      result,
      escalationData,
      startedAt,
      savedAt: new Date().toISOString(),
    },
  };
}

/**
 * Build the output_data for the "enrichment_stored" checkpoint.
 * Called immediately after enrichment_runs rows are written, BEFORE completeJob.
 *
 * The escalationData is intentionally omitted — it's only needed for the
 * enrichment_runs write, which has now completed.
 */
export function buildEnrichmentStoredCheckpoint(
  result: unknown,
  enrichmentRunIds: string[],
  finalEnrichmentRunId: string | null,
  startedAt: string,
): CheckpointJobOutput {
  return {
    _checkpoint: {
      stage: "enrichment_stored",
      result,
      enrichmentRunIds,
      finalEnrichmentRunId,
      startedAt,
      savedAt: new Date().toISOString(),
    },
  };
}

// ── Decision logic ────────────────────────────────────────────────────────────

/**
 * True if the checkpoint (if any) is at the given stage.
 * Null-safe: returns false when checkpoint is null or undefined.
 */
export function checkpointIs(
  checkpoint: AITaskCheckpoint | null | undefined,
  stage: CheckpointStage,
): boolean {
  return checkpoint?.stage === stage;
}

/**
 * Determine the correct action for the Trigger.dev task given an existing job
 * row found during the idempotency check.
 *
 * Takes both the job's `status` column AND the parsed checkpoint (if any)
 * because:
 *   - The status column is the primary indicator after an atomic updateJob call.
 *   - The checkpoint stage may differ from the status during a crash (e.g., the
 *     updateJob for status succeeded but something else failed afterward).
 *   - Checking both makes recovery resilient to partial failures.
 *
 * @param jobStatus  The `status` column from the jobs table row (or "none"
 *                   when no job was found, which maps to "run_all").
 * @param checkpoint The parsed checkpoint from jobs.output_data, or null.
 */
export function resolveResumeDecision(
  jobStatus: string,
  checkpoint: AITaskCheckpoint | null,
): ResumeDecision {
  // Fully completed — return the cached output; no work needed.
  if (jobStatus === "completed") return "done";

  // Sub-"running" checkpoint stages live in output_data, not in the status column.
  // (The jobs table constraint does not allow custom status values like "ai_executed".)

  // Enrichment rows are already in the DB — just finalize the job row.
  if (checkpointIs(checkpoint, "enrichment_stored")) return "complete_job";

  // AI call is done but enrichment_runs not yet written — skip AI, do DB write.
  if (checkpointIs(checkpoint, "ai_executed")) return "store_enrichment";

  // Everything else (failed, cancelled, pending, running without a checkpoint, not found):
  // re-run the full flow.
  return "run_all";
}
