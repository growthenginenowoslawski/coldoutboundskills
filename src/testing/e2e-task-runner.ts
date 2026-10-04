/**
 * E2E task runner — direct port of trigger/ai-qualify.ts without Trigger.dev SDK.
 *
 * Replicates the exact production pipeline so integration tests exercise:
 *   claimJob → checkpoint resolution → runAIQualify → Supabase checkpoints
 *   → storeEscalationResult → completeJob
 *
 * Only the AI provider is injected (via providerFactory).  All other components
 * (EscalationRouter, Executor, pricing engine, Supabase writes) are real.
 *
 * Use `stopAfterAI: true` to simulate a crash between checkpoint-1 and the
 * enrichment write — the job stays `running` with stage `ai_executed`, ready
 * for scenario-8 retry testing.
 */
import {
  claimJob,
  updateJob,
  completeJob,
  getJob,
  type JobRow,
} from "../db/jobs.ts";
import {
  readCheckpoint,
  buildAIExecutedCheckpoint,
  buildEnrichmentStoredCheckpoint,
  resolveResumeDecision,
  type ResumeDecision,
  type AITaskCheckpoint,
} from "../tasks/checkpoint.ts";
import {
  runAIQualify,
  type AIQualifyPayload,
  type AIQualifyResult,
} from "../tasks/qualify.ts";
import { storeEscalationResult } from "../db/qualifications.ts";
import type { EscalationResult } from "../providers/ai/escalation-router.ts";
import type { TaskType, ComplexityHint } from "../providers/ai/model-router.ts";
import type { AIProvider } from "../providers/types.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderFactory = (taskType: TaskType, tier: ComplexityHint) => AIProvider;

export interface E2ETaskPayload extends AIQualifyPayload {
  skipEnrichmentRuns?: boolean;
}

export interface E2ETaskOptions {
  providerFactory: ProviderFactory;
  /** When true: stop after writing checkpoint-1 (ai_executed).  For scenario 8. */
  stopAfterAI?: boolean;
}

export interface E2ETaskResult {
  job: JobRow;
  created: boolean;
  decision: ResumeDecision;
  /** Present when the task completed normally. */
  output?: TaskOutput;
  /** Set when stopAfterAI caused an early return. */
  stoppedAt?: "ai_executed";
  /** Set when the task threw and marked the job failed. */
  failureReason?: string;
}

type TaskOutput = AIQualifyResult & {
  enrichmentRunIds: string[];
  finalEnrichmentRunId: string | null;
};

// ── Core runner ───────────────────────────────────────────────────────────────

/**
 * Run the full AI-qualify pipeline without Trigger.dev.
 *
 * Mirrors trigger/ai-qualify.ts step-for-step.  The only differences:
 *   - console.log replaces logger
 *   - providerFactory is required (no production fallback)
 *   - stopAfterAI for checkpoint-1 testing
 *   - both AI and enrichment failures are caught and mark the job failed
 */
export async function runE2ETask(
  payload: E2ETaskPayload,
  opts: E2ETaskOptions,
): Promise<E2ETaskResult> {
  const tag = `[e2e s${(payload as E2ETaskPayload & { _scenarioId?: number })._scenarioId ?? "?"}]`;

  // ── Step 1: Atomic find-or-create ─────────────────────────────────────────

  const { job: claimedJob, created } = await claimJob({
    jobType: "ai_qualify",
    idempotencyKey: payload.idempotencyKey,
    provider: "mock",
    totalItems: 1,
    inputData: {
      idempotencyKey: payload.idempotencyKey,
      companyId: payload.companyId,
      taskType: payload.taskType,
      clientId: payload.clientId ?? null,
    },
  });

  // ── Step 2: Checkpoint resolution ─────────────────────────────────────────

  const checkpoint = readCheckpoint(claimedJob.output_data);
  const decision: ResumeDecision = resolveResumeDecision(claimedJob.status, checkpoint);

  console.log(`${tag} claimJob → created=${created}, decision=${decision}, jobId=${claimedJob.id}`);

  // ── Step 3a: Already completed (idempotent return) ────────────────────────

  if (decision === "done") {
    console.log(`${tag} idempotent skip — returning cached output`);
    return { job: claimedJob, created, decision, output: claimedJob.output_data as TaskOutput };
  }

  // ── Step 3b: Enrichment checkpoint — just complete the job ────────────────

  if (decision === "complete_job") {
    console.log(`${tag} recovering from enrichment_stored checkpoint`);
    const cp = checkpoint as AITaskCheckpoint;
    const result = cp.result as AIQualifyResult;
    const output: TaskOutput = {
      ...result,
      enrichmentRunIds: cp.enrichmentRunIds ?? [],
      finalEnrichmentRunId: cp.finalEnrichmentRunId ?? null,
    };
    const finalJob = await completeJob(claimedJob.id, { successfulItems: 1, outputData: output });
    return { job: finalJob, created, decision, output };
  }

  // ── Step 3c: Concurrent duplicate guard ───────────────────────────────────

  if (!created && decision === "run_all") {
    console.log(`${tag} concurrent duplicate detected — exiting (job claimed by another worker)`);
    return { job: claimedJob, created, decision };
  }

  // ── Step 3d/3e: Run AI (fresh) or resume from AI checkpoint ──────────────

  const jobId = claimedJob.id;
  let result: AIQualifyResult;
  let escalation: EscalationResult;
  let startedAt: string;

  try {
    if (decision === "store_enrichment") {
      // Resume from ai_executed checkpoint — skip AI call
      const cp = checkpoint as AITaskCheckpoint;
      result = cp.result as AIQualifyResult;
      escalation = cp.escalationData as EscalationResult;
      startedAt = cp.startedAt;
      console.log(`${tag} resuming from ai_executed checkpoint, totalCostUsd=${result.totalCostUsd}`);
    } else {
      // Fresh execution
      await updateJob(jobId, { status: "running", startedAt: new Date().toISOString() });
      console.log(`${tag} starting AI execution...`);

      const execution = await runAIQualify(payload, { providerFactory: opts.providerFactory });
      result = execution.result;
      escalation = execution.escalation;
      startedAt = execution.startedAt;

      console.log(
        `${tag} AI done — model=${result.model}, attempts=${result.attemptCount}, ` +
        `escalated=${result.escalated}, costUsd=${result.totalCostUsd?.toFixed(6)}`,
      );

      // Write checkpoint 1 (before enrichment)
      await updateJob(jobId, {
        outputData: buildAIExecutedCheckpoint(result, escalation, startedAt),
      });
      console.log(`${tag} checkpoint-1 written (ai_executed)`);

      if (opts.stopAfterAI) {
        console.log(`${tag} stopAfterAI=true — returning early (job stays running)`);
        // Re-fetch to get the updated row
        const updatedJob = (await getJob(jobId))!;
        return { job: updatedJob, created, decision, stoppedAt: "ai_executed" };
      }
    }

    // ── Step 4: Store enrichment_runs ────────────────────────────────────────

    let enrichmentRunIds: string[] = [];
    let finalEnrichmentRunId: string | null = null;

    if (!payload.skipEnrichmentRuns) {
      const stored = await storeEscalationResult(
        payload.companyId,
        payload.input,
        escalation,
        payload.taskType,
        startedAt,
        { clientId: payload.clientId, jobId },
      );
      enrichmentRunIds = stored.runIds;
      finalEnrichmentRunId = stored.finalRunId;
      console.log(`${tag} enrichment_runs stored: count=${enrichmentRunIds.length}, finalRunId=${finalEnrichmentRunId}`);
    } else {
      console.log(`${tag} enrichment_runs skipped (skipEnrichmentRuns=true)`);
    }

    // Write checkpoint 2 (before completeJob)
    await updateJob(jobId, {
      outputData: buildEnrichmentStoredCheckpoint(result, enrichmentRunIds, finalEnrichmentRunId, startedAt),
    });
    console.log(`${tag} checkpoint-2 written (enrichment_stored)`);

    // ── Step 5: Complete ──────────────────────────────────────────────────────

    const output: TaskOutput = { ...result, enrichmentRunIds, finalEnrichmentRunId };
    const finalJob = await completeJob(jobId, { successfulItems: 1, outputData: output });

    console.log(`${tag} job completed ✓`);
    return { job: finalJob, created, decision, output };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} task FAILED: ${msg}`);

    let failedJob = claimedJob;
    try {
      failedJob = await updateJob(jobId, { status: "failed", failedItems: 1, errorMessage: msg });
    } catch {
      // Best-effort mark — don't obscure the original error
    }

    return { job: failedJob, created, decision, failureReason: msg };
  }
}
