/**
 * Why Now task entry point — Stage 22.
 *
 * This is the task-level adapter over src/lib/why-now.ts.
 * It has NO Trigger.dev imports and is fully testable without the Trigger.dev SDK.
 * The Trigger.dev task wrapper (deployed externally) calls runWhyNow() and stores
 * the result in jobs.output_data.
 *
 * ── Modes ─────────────────────────────────────────────────────────────────────
 *
 *   SINGLE — assess one (clientId, companyId) pair.
 *     Pass companyId in the payload. The task calls assessWhyNow() once.
 *
 *   BATCH  — assess all account_intelligence rows for a client.
 *     Omit companyId. The task reads account_intelligence and calls assessWhyNow()
 *     for every company that has a record. Errors on individual companies are
 *     caught and reported — they do not abort the batch.
 *
 * ── What it does ──────────────────────────────────────────────────────────────
 *
 *   For each (client, company) pair:
 *
 *   1. assessWhyNow() — builds deterministic evidence from stored signals, evaluates
 *      readiness against configurable thresholds, and optionally generates an AI
 *      narrative grounded in actual signal evidence.
 *
 *   2. Results are persisted to account_intelligence by assessWhyNow() — the task
 *      does NOT write to DB directly.
 *
 *   3. Returns WhyNowTaskReport — accounts assessed, ready count, AI calls made,
 *      narratives reused, and any per-account errors.
 *
 * ── Error handling ────────────────────────────────────────────────────────────
 *
 * Per-company errors (signal fetch failure, AI failure, persist failure) are caught
 * in batch mode and added to report.errors. The batch continues even when individual
 * accounts fail. In single mode, errors propagate to the caller.
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * The task is safe to rerun: assessWhyNow() is idempotent at the deterministic layer.
 * The AI narrative is gated by a 23-hour rerun window — redundant AI calls are skipped
 * when an existing narrative is fresh. Running the task more often than once per day
 * is harmless but wastes AI spend beyond the first run if narratives are already fresh.
 *
 * ── Scheduling ────────────────────────────────────────────────────────────────
 *
 * Scheduling is the Trigger.dev deployment's responsibility.
 * Recommended: daily at 08:00 UTC per client (after signal refresh + expiry + account
 * prioritization complete). The 23-hour narrative rerun window means daily reruns
 * will always refresh AI narratives for new/changed accounts.
 *
 * ── Excluded by design ────────────────────────────────────────────────────────
 *
 *   No contact discovery, no lead enrollment, no Smartlead, no outbound.
 *   No changes to opportunity_score, score_inputs, or priority_score.
 *   No Stage 21B interaction.
 *   No modification of the Stage 17 contact eligibility gate.
 *   INITIAL_HYPOTHESIS_NOT_VALIDATED: all readiness and AI thresholds are hypotheses.
 */

import { assessWhyNow } from "../lib/why-now";
import type { WhyNowPayload, WhyNowOptions, WhyNowResult } from "../lib/why-now";
import { getAllAccountIntelligence } from "../db/account-intelligence";

// Re-export types used by callers that import the task module.
export type { WhyNowPayload, WhyNowOptions, WhyNowResult };

// ── Public types ───────────────────────────────────────────────────────────────

export interface WhyNowTaskPayload {
  clientId: string;
  /**
   * When provided: single-company mode — assess this company only.
   * When omitted:  batch mode — assess all account_intelligence rows for clientId.
   */
  companyId?: string;
  /**
   * Skip AI narrative generation for this run.
   * Useful for dry-run / readiness-only runs (no AI spend).
   * Defaults to false.
   */
  skipAiNarrative?: boolean;
  /**
   * Override threshold values for this run.
   * Unspecified fields fall back to DEFAULT_WHY_NOW_THRESHOLDS.
   * All values are INITIAL_HYPOTHESIS_NOT_VALIDATED.
   */
  thresholds?: WhyNowPayload["thresholds"];
  /**
   * Company profile passed to assessWhyNow for the AI narrative prompt.
   * Ignored in batch mode (each company uses the data available in account_intelligence).
   * Optional — the AI uses a placeholder when absent.
   */
  company?: WhyNowPayload["company"];
  /**
   * ICP context passed to assessWhyNow for the AI narrative prompt.
   * Applied to all companies in batch mode.
   */
  icpContext?: WhyNowPayload["icpContext"];
  /**
   * ISO 8601 time override for deterministic tests.
   * Applied to all assessWhyNow() calls in this run.
   * Defaults to new Date() at task start.
   */
  now?: string;
  /**
   * Maximum companies to assess in batch mode.
   * Does NOT limit which companies have their readiness updated — all
   * account_intelligence rows are eligible. This is a cost/time cap.
   * Defaults to 500.
   */
  batchLimit?: number;
}

export interface WhyNowCompanyOutcome {
  companyId:       string;
  persisted:       boolean;
  ready:           boolean;
  readinessReason: string;
  aiCallMade:      boolean;
  narrativeReused: boolean;
  error?:          string;
}

export interface WhyNowTaskReport {
  clientId:             string;
  mode:                 "single" | "batch";
  startedAt:            string;
  completedAt:          string;
  accountsAssessed:     number;
  readyCount:           number;
  aiCallsMade:          number;
  narrativesReused:     number;
  errorCount:           number;
  outcomes:             WhyNowCompanyOutcome[];
  errors:               { companyId: string; error: string }[];
  /** Whether any thresholds were overridden from DEFAULT_WHY_NOW_THRESHOLDS. */
  thresholdsOverridden: boolean;
  skipAiNarrative:      boolean;
}

export interface WhyNowTaskResult {
  clientId: string;
  report:   WhyNowTaskReport;
}

// ── Task function ──────────────────────────────────────────────────────────────

/**
 * Run a Why Now assessment cycle.
 *
 * Single-company mode: Pass companyId. Errors propagate to the caller.
 * Batch mode: Omit companyId. Per-company errors are caught and added to report.errors.
 *
 * Client isolation: all assessWhyNow() calls are scoped to clientId.
 */
export async function runWhyNow(
  payload: WhyNowTaskPayload,
  opts: WhyNowOptions = {},
): Promise<WhyNowTaskResult> {
  const startedAt = new Date().toISOString();
  const mode: "single" | "batch" = payload.companyId ? "single" : "batch";

  const outcomes:  WhyNowCompanyOutcome[]           = [];
  const errors:    { companyId: string; error: string }[] = [];

  let accountsAssessed = 0;
  let readyCount       = 0;
  let aiCallsMade      = 0;
  let narrativesReused = 0;

  // Collect company IDs to assess
  let companyIds: string[];
  if (mode === "single") {
    companyIds = [payload.companyId!];
  } else {
    const limit = payload.batchLimit ?? 500;
    const aiRows = await getAllAccountIntelligence(payload.clientId);
    companyIds = aiRows.slice(0, limit).map((r) => r.companyId);
  }

  for (const companyId of companyIds) {
    const whyNowPayload: WhyNowPayload = {
      clientId:        payload.clientId,
      companyId,
      skipAiNarrative: payload.skipAiNarrative,
      thresholds:      payload.thresholds,
      company:         mode === "single" ? payload.company : undefined,
      icpContext:      payload.icpContext,
      now:             payload.now,
    };

    try {
      const result: WhyNowResult = await assessWhyNow(whyNowPayload, opts);

      accountsAssessed++;
      if (result.assessment.ready) readyCount++;
      if (result.aiCallMade)       aiCallsMade++;
      if (result.narrativeReused)  narrativesReused++;

      outcomes.push({
        companyId,
        persisted:       result.persisted,
        ready:           result.assessment.ready,
        readinessReason: result.assessment.readinessReason,
        aiCallMade:      result.aiCallMade,
        narrativeReused: result.narrativeReused,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (mode === "single") {
        // In single mode, propagate — the caller needs the full error
        throw err;
      }

      // Batch mode: record the error and continue
      errors.push({ companyId, error: msg });
      outcomes.push({
        companyId,
        persisted:       false,
        ready:           false,
        readinessReason: "NO_ACCOUNT_INTELLIGENCE",
        aiCallMade:      false,
        narrativeReused: false,
        error:           msg,
      });
    }
  }

  const report: WhyNowTaskReport = {
    clientId:             payload.clientId,
    mode,
    startedAt,
    completedAt:          new Date().toISOString(),
    accountsAssessed,
    readyCount,
    aiCallsMade,
    narrativesReused,
    errorCount:           errors.length,
    outcomes,
    errors,
    thresholdsOverridden: payload.thresholds !== undefined,
    skipAiNarrative:      payload.skipAiNarrative ?? false,
  };

  return { clientId: payload.clientId, report };
}
