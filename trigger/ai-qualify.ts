/**
 * Stage 10: Trigger.dev orchestration layer for AI qualification — production-hardened.
 *
 * This is the durable execution shell around src/tasks/qualify.ts.
 * It combines the checkpoint pattern (Stage 9) with DB-level operation identity
 * (Stage 10) so every guarantee holds under concurrent requests, retries, and
 * worker restarts.
 *
 * ── Operation identity ────────────────────────────────────────────────────────
 *
 *   Each (jobType, idempotencyKey) pair maps to exactly one active job row.
 *   `claimJob` is an atomic find-or-create: the first caller inserts the row;
 *   concurrent callers get a 23505 unique violation and fall through to a lookup.
 *   Only failed/cancelled jobs are excluded from the unique constraint so retries
 *   can create a fresh row without manual cleanup.
 *
 * ── Retry guarantees ──────────────────────────────────────────────────────────
 *
 *   Retry after completed:          idempotent — returns cached output, zero work.
 *   Retry after enrichment_stored:  skip AI + skip enrichment DB write → completeJob.
 *   Retry after ai_executed:        skip AI (use checkpoint data) → storeEscalationResult
 *                                   → completeJob. storeEscalationResult is now idempotent
 *                                   via unique(job_id, attempt_number): no duplicate rows.
 *   Retry after failed:             failed row excluded from unique index → claimJob
 *                                   creates a fresh row → full re-run.
 *   Concurrent duplicate:           second caller finds existing job (created: false),
 *                                   checks decision, exits gracefully if no checkpoint.
 *
 * ── Extension pattern ─────────────────────────────────────────────────────────
 *
 *   Future task types (personalization, campaign_strategy, reply_classify, etc.)
 *   follow the same shell.  Only the `runAI*()` call and the storage function change.
 *   The job lifecycle, claimJob, checkpoint writes, and idempotency resolution are
 *   identical across all task types.
 */
import { logger, task } from "@trigger.dev/sdk";
import {
  runAIQualify,
  type AIQualifyPayload,
  type AIQualifyResult,
  type AIQualifyOptions,
} from "../src/tasks/qualify";
import { storeEscalationResult } from "../src/db/qualifications";
import { claimJob, updateJob, completeJob } from "../src/db/jobs";
import {
  readCheckpoint,
  buildAIExecutedCheckpoint,
  buildEnrichmentStoredCheckpoint,
  resolveResumeDecision,
  type ResumeDecision,
} from "../src/tasks/checkpoint";
import type { EscalationResult } from "../src/providers/ai/escalation-router";
import type { AIProvider } from "../src/providers/types";
import type { QualificationInput, QualificationResult } from "../src/domain/types";
import type { TaskType, ComplexityHint } from "../src/providers/ai/model-router";

// ── Payload ───────────────────────────────────────────────────────────────────

interface AIQualifyTriggerPayload extends AIQualifyPayload {
  /**
   * When true, uses the deterministic mock provider.
   * No API keys required.  For smoke-testing and CI pipelines only.
   */
  mockMode?: boolean;
  /**
   * When true, skips the enrichment_runs write.
   * Use in dev/test when you don't have a live companyId in the DB.
   */
  skipEnrichmentRuns?: boolean;
}

type TaskOutput = AIQualifyResult & {
  enrichmentRunIds: string[];
  finalEnrichmentRunId: string | null;
};

// ── Task ──────────────────────────────────────────────────────────────────────

export const aiQualify = task({
  id: "ai-qualify",

  run: async (payload: AIQualifyTriggerPayload): Promise<TaskOutput> => {
    logger.info("ai-qualify started", {
      companyId: payload.companyId,
      taskType: payload.taskType,
      idempotencyKey: payload.idempotencyKey,
      clientId: payload.clientId ?? null,
      mockMode: payload.mockMode ?? false,
    });

    // ── 1. Atomic find-or-create ──────────────────────────────────────────────
    //
    // claimJob either inserts a fresh pending row (created: true) or returns an
    // existing active row (created: false).  The DB partial unique index on
    // (job_type, idempotency_key) WHERE status NOT IN ('failed','cancelled')
    // ensures only one active row can exist per logical operation, regardless of
    // how many concurrent callers arrive simultaneously.
    const { job: claimedJob, created } = await claimJob({
      jobType: "ai_qualify",
      idempotencyKey: payload.idempotencyKey,
      provider: payload.mockMode ? "mock" : "ai",
      totalItems: 1,
      inputData: {
        idempotencyKey: payload.idempotencyKey,
        companyId: payload.companyId,
        taskType: payload.taskType,
        clientId: payload.clientId ?? null,
        mockMode: payload.mockMode ?? false,
        skipEnrichmentRuns: payload.skipEnrichmentRuns ?? false,
      },
    });

    // ── 2. Resolve resume decision ────────────────────────────────────────────
    const checkpoint = readCheckpoint(claimedJob.output_data);
    const decision: ResumeDecision = resolveResumeDecision(claimedJob.status, checkpoint);

    logger.info("resume decision", {
      decision,
      jobId: claimedJob.id,
      created,
      checkpointStage: checkpoint?.stage ?? null,
    });

    // ── 3a. DONE — return cached output ───────────────────────────────────────
    if (decision === "done") {
      logger.info("idempotent skip — previously completed", {
        idempotencyKey: payload.idempotencyKey,
        jobId: claimedJob.id,
      });
      return claimedJob.output_data as TaskOutput;
    }

    // ── 3b. COMPLETE_JOB — enrichment already stored ──────────────────────────
    if (decision === "complete_job") {
      logger.info("recovering from enrichment_stored checkpoint", { jobId: claimedJob.id });
      const result = checkpoint!.result as AIQualifyResult;
      const output: TaskOutput = {
        ...result,
        enrichmentRunIds: checkpoint!.enrichmentRunIds ?? [],
        finalEnrichmentRunId: checkpoint!.finalEnrichmentRunId ?? null,
      };
      await completeJob(claimedJob.id, { successfulItems: 1, outputData: output });
      logger.info("ai-qualify completed (from enrichment checkpoint)", { jobId: claimedJob.id });
      return output;
    }

    // ── 3c. Concurrent duplicate guard ────────────────────────────────────────
    //
    // If we did NOT create the job (created: false) and there is no usable
    // checkpoint (decision = "run_all"), another worker claimed this job and has
    // not yet written checkpoint 1.  Exit gracefully — the first worker will
    // complete the job.  Trigger.dev's own idempotency key prevents duplicate
    // invocations at the orchestration layer; this is the defense-in-depth path
    // for direct API calls or manual retriggers.
    if (!created && decision === "run_all") {
      logger.warn("concurrent execution detected — exiting gracefully (job claimed by another worker)", {
        jobId: claimedJob.id,
        idempotencyKey: payload.idempotencyKey,
      });
      // Return current (likely empty) output — caller can poll for completion.
      return (claimedJob.output_data ?? {}) as TaskOutput;
    }

    // ── 3d/3e. STORE_ENRICHMENT or RUN_ALL ───────────────────────────────────
    const jobId = claimedJob.id;
    let result: AIQualifyResult;
    let escalation: EscalationResult;
    let startedAt: string;

    if (decision === "store_enrichment") {
      // Resume from AI-executed checkpoint — NO second AI call.
      result = checkpoint!.result as AIQualifyResult;
      escalation = checkpoint!.escalationData as EscalationResult;
      startedAt = checkpoint!.startedAt;
      logger.info("recovering from ai_executed checkpoint — skipping AI call", {
        jobId,
        totalCostUsd: result.totalCostUsd,
      });

    } else {
      // Fresh execution (created: true, decision: run_all).
      await updateJob(jobId, { status: "running", startedAt: new Date().toISOString() });
      logger.info("job claimed, starting AI execution", { jobId });

      const opts: AIQualifyOptions = {};
      if (payload.mockMode) opts.providerFactory = mockProviderFactory;
      const execution = await runAIQualify(payload, opts);

      result = execution.result;
      escalation = execution.escalation;
      startedAt = execution.startedAt;

      logger.info("ai execution complete", {
        model: result.model,
        gateway: result.gateway,
        escalated: result.escalated,
        attemptCount: result.attemptCount,
        totalCostUsd: result.totalCostUsd,
      });

      // Checkpoint 1: written before enrichment so a retry can skip AI.
      await updateJob(jobId, {
        outputData: buildAIExecutedCheckpoint(result, escalation, startedAt),
      });
    }

    // ── 4. Store enrichment_runs (idempotent via unique(job_id, attempt_number)) ─
    let enrichmentRunIds: string[] = [];
    let finalEnrichmentRunId: string | null = null;

    try {
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
        logger.info("enrichment_runs stored", {
          count: enrichmentRunIds.length,
          finalRunId: finalEnrichmentRunId,
        });
      } else {
        logger.info("enrichment_runs skipped (skipEnrichmentRuns=true)");
      }

      // Checkpoint 2: written before completeJob so a retry can skip enrichment write.
      await updateJob(jobId, {
        outputData: buildEnrichmentStoredCheckpoint(
          result,
          enrichmentRunIds,
          finalEnrichmentRunId,
          startedAt,
        ),
      });

      // ── 5. Complete ───────────────────────────────────────────────────────────
      const output: TaskOutput = { ...result, enrichmentRunIds, finalEnrichmentRunId };
      await completeJob(jobId, { successfulItems: 1, outputData: output });

      logger.info("ai-qualify completed", {
        jobId,
        idempotencyKey: payload.idempotencyKey,
        enrichmentRunCount: enrichmentRunIds.length,
        totalCostUsd: result.totalCostUsd,
      });

      return output;

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error("ai-qualify failed during enrichment/completion", {
        jobId,
        idempotencyKey: payload.idempotencyKey,
        error: errorMessage,
      });
      try {
        await updateJob(jobId, { status: "failed", failedItems: 1, errorMessage });
      } catch {
        // Best-effort — Trigger.dev will retry regardless.
      }
      throw err;
    }
  },
});

// ── Mock provider factory ─────────────────────────────────────────────────────

/**
 * Deterministic mock for development and smoke testing.
 * Returns high-confidence results on every tier → no escalation in the
 * smoke-test path.  Uses Haiku pricing so cost_usd is non-null in output.
 */
function mockProviderFactory(_taskType: TaskType, tier: ComplexityHint): AIProvider {
  return {
    id: "anthropic-direct:claude-haiku-4-5-20251001",
    capability: "ai" as const,
    isConfigured: () => true,
    qualifyCompany: async (_input: QualificationInput): Promise<QualificationResult> => ({
      icpFit: true,
      score: 82,
      industryMatch: true,
      sizeMatch: true,
      locationMatch: true,
      reason: `Smoke-test mock: strong ICP fit (tier=${tier})`,
      signals: ["mock-signal"],
      confidence: 0.90,
      model: "claude-haiku-4-5-20251001",
      qualifiedAt: new Date().toISOString(),
      inputTokens: 350,
      outputTokens: 120,
    }),
  };
}
