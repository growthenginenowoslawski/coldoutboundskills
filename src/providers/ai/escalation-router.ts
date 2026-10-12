import type { AIProvider } from "../types";
import type { QualificationInput, QualificationResult } from "../../domain/types";
import { ModelRouter, type TaskType, type ComplexityHint } from "./model-router";
import { executeQualification } from "./executor";

/** Fixed progression — escalation always moves left to right. */
const TIER_ORDER: readonly ComplexityHint[] = ["low", "medium", "high"] as const;

// ── Configuration ─────────────────────────────────────────────────────────────

export interface EscalationConfig {
  taskType: TaskType;
  /** Tier to attempt first. */
  startTier: ComplexityHint;
  /**
   * Minimum acceptable confidence (0–1).
   * If result.confidence < this, escalate to the next tier (if one is available).
   * An invalid confidence value (NaN, infinite, out of range) is treated as
   * below threshold — escalation proceeds unless maxTier is already reached.
   */
  confidenceThreshold: number;
  /** Never escalate beyond this tier. The result at this tier is always accepted. */
  maxTier: ComplexityHint;
}

/**
 * Sensible escalation defaults per task type.
 * Override specific fields by spreading into a custom EscalationConfig.
 *
 * Design rationale:
 *   icp_qualification  — starts low (Haiku), full range to high (Opus), threshold 0.75
 *   campaign_strategy  — starts medium (Sonnet) because strategy is never trivial
 *   personalization    — capped at medium (Opus is overkill for a one-liner)
 *   icp_prefilter      — lower threshold (0.60) because full qualification follows
 *   reply_classify     — high threshold (0.80) because misclassification is costly
 *   text_normalize     — capped at low; if Haiku can't do it, log and continue
 */
export const ESCALATION_DEFAULTS: Record<TaskType, EscalationConfig> = {
  icp_qualification: {
    taskType: "icp_qualification",
    startTier: "low",
    confidenceThreshold: 0.75,
    maxTier: "high",
  },
  campaign_strategy: {
    taskType: "campaign_strategy",
    startTier: "medium",
    confidenceThreshold: 0.80,
    maxTier: "high",
  },
  personalization: {
    taskType: "personalization",
    startTier: "low",
    confidenceThreshold: 0.70,
    maxTier: "medium",
  },
  icp_prefilter: {
    taskType: "icp_prefilter",
    startTier: "low",
    confidenceThreshold: 0.60,
    maxTier: "medium",
  },
  reply_classify: {
    taskType: "reply_classify",
    startTier: "low",
    confidenceThreshold: 0.80,
    maxTier: "medium",
  },
  text_normalize: {
    taskType: "text_normalize",
    startTier: "low",
    confidenceThreshold: 0.90,
    maxTier: "low",   // single tier — never escalate text normalisation
  },
  signal_intelligence: {
    taskType: "signal_intelligence",
    startTier: "medium",
    confidenceThreshold: 0.70,
    maxTier: "medium", // single tier — synthesis tasks don't benefit from escalation
  },
};

// ── Result types ──────────────────────────────────────────────────────────────

export interface EscalationAttempt {
  /** Complexity tier used for this attempt. */
  tier: ComplexityHint;
  /** Provider id (e.g. "anthropic-direct:claude-haiku-4-5-20251001"). */
  providerId: string;
  /** Actual model string returned in the response. */
  model: string;
  /**
   * Sanitised confidence from the result.
   * null when the raw value was missing, NaN, infinite, or outside [0, 1].
   * A null confidence is treated as below threshold.
   */
  confidence: number | null;
  inputTokens: number;
  outputTokens: number;
  /** True if this attempt triggered escalation to the next tier. */
  escalated: boolean;
  // Stage 6 — execution-time cost and timing (set by the executor, not the caller):
  /** Wall-clock milliseconds for this attempt only. */
  latencyMs: number;
  /** Computed USD cost for this attempt. Null when model is not in pricing registry. */
  costUsd: number | null;
  /** Pricing registry key used ("gateway:model"), or null when gateway unresolvable. */
  priceKey: string | null;
}

export interface EscalationResult {
  /** Final qualification result (from the last — accepted — attempt). */
  result: QualificationResult;
  /** Ordered log of every attempt, including intermediate escalations. */
  attempts: EscalationAttempt[];
  /** Sum of inputTokens across ALL attempts (for full cost accounting). */
  totalInputTokens: number;
  /** Sum of outputTokens across ALL attempts. */
  totalOutputTokens: number;
  /** Complexity tier of the final accepted attempt. */
  finalTier: ComplexityHint;
  /** Provider id of the final accepted attempt. */
  finalProviderId: string;
  /** True if at least one escalation occurred (attempts.length > 1). */
  escalated: boolean;
  /**
   * Total USD cost across ALL attempts.
   * Null when ANY attempt has an unknown model (cost incomplete — not zero).
   */
  totalCostUsd: number | null;
}

// ── Internal ──────────────────────────────────────────────────────────────────

/**
 * Validates a raw confidence value from an AI response.
 * Returns the value only if it is a finite number strictly within [0, 1].
 * Everything else (NaN, Infinity, -0.1, 1.01, non-number) returns null.
 */
function sanitizeConfidence(raw: unknown): number | null {
  if (typeof raw !== "number") return null;
  if (!isFinite(raw)) return null;
  if (raw < 0 || raw > 1) return null;
  return raw;
}

/**
 * Options accepted only by unit tests.
 * Inject a providerFactory to control which AIProvider is returned per tier
 * without setting real env vars or making real API calls.
 * Not part of the public production API.
 */
export interface _EscalationTestOptions {
  providerFactory?: (taskType: TaskType, tier: ComplexityHint) => AIProvider;
}

// ── EscalationRouter ──────────────────────────────────────────────────────────

export class EscalationRouter {
  /**
   * Qualifies a company with automatic tier escalation.
   *
   * Flow for each attempt:
   *   1. Route to provider at current tier via ModelRouter.route(taskType, tier).
   *   2. Call provider.qualifyCompany(input).
   *   3. Sanitise result.confidence.
   *   4. If confidence >= threshold  →  accept, return EscalationResult.
   *   5. If confidence < threshold AND current tier < maxTier  →  escalate.
   *   6. If current tier === maxTier  →  accept regardless of confidence.
   *   7. A null confidence is treated as below threshold (conservative).
   *
   * Tokens from ALL attempts are summed in totalInputTokens / totalOutputTokens.
   * The full escalation path is recorded in attempts[].
   *
   * @param _testOpts  Internal — inject a providerFactory for offline unit tests.
   */
  static async qualify(
    input: QualificationInput,
    config: EscalationConfig,
    _testOpts: _EscalationTestOptions = {},
  ): Promise<EscalationResult> {
    const providerFactory =
      _testOpts.providerFactory ??
      ((taskType: TaskType, tier: ComplexityHint) => ModelRouter.route(taskType, tier));

    const startIdx = TIER_ORDER.indexOf(config.startTier);
    const maxIdx = TIER_ORDER.indexOf(config.maxTier);

    if (startIdx < 0) throw new Error(`EscalationRouter: unknown startTier "${config.startTier}"`);
    if (maxIdx < 0) throw new Error(`EscalationRouter: unknown maxTier "${config.maxTier}"`);
    if (startIdx > maxIdx) {
      throw new Error(
        `EscalationRouter: startTier "${config.startTier}" is above maxTier "${config.maxTier}"`,
      );
    }

    const attempts: EscalationAttempt[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd: number | null = 0;

    for (let i = startIdx; i <= maxIdx; i++) {
      const tier = TIER_ORDER[i];
      const isMaxTier = i === maxIdx;

      const provider = providerFactory(config.taskType, tier);
      const execution = await executeQualification(provider, input);

      const confidence = sanitizeConfidence(execution.result.confidence);
      const inputTokens = execution.inputTokens;
      const outputTokens = execution.outputTokens;

      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      // Accumulate total cost — null as soon as any attempt has unknown pricing.
      if (execution.costUsd !== null && totalCostUsd !== null) {
        totalCostUsd += execution.costUsd;
      } else {
        totalCostUsd = null;
      }

      const meetsThreshold = confidence !== null && confidence >= config.confidenceThreshold;
      const willEscalate = !meetsThreshold && !isMaxTier;

      attempts.push({
        tier,
        providerId: provider.id,
        model: execution.result.model,
        confidence,
        inputTokens,
        outputTokens,
        escalated: willEscalate,
        latencyMs: execution.latencyMs,
        costUsd: execution.costUsd,
        priceKey: execution.priceKey,
      });

      if (!willEscalate) {
        return {
          result: execution.result,
          attempts,
          totalInputTokens,
          totalOutputTokens,
          finalTier: tier,
          finalProviderId: provider.id,
          escalated: attempts.length > 1,
          totalCostUsd,
        };
      }
      // Loop continues to next tier.
    }

    // Unreachable — the loop always returns inside via the !willEscalate branch.
    // (When isMaxTier is true, willEscalate is always false.)
    throw new Error("EscalationRouter: unexpected exit from escalation loop");
  }

  /**
   * Convenience wrapper using ESCALATION_DEFAULTS for the given task type.
   * Pass overrides to change specific config fields without replacing the whole config.
   *
   * Example — raise the threshold for a specific client run:
   *   EscalationRouter.qualifyWithDefaults(input, "icp_qualification", { confidenceThreshold: 0.85 })
   */
  static async qualifyWithDefaults(
    input: QualificationInput,
    taskType: TaskType,
    overrides: Partial<Omit<EscalationConfig, "taskType">> = {},
    _testOpts: _EscalationTestOptions = {},
  ): Promise<EscalationResult> {
    const config: EscalationConfig = { ...ESCALATION_DEFAULTS[taskType], ...overrides };
    return EscalationRouter.qualify(input, config, _testOpts);
  }
}
