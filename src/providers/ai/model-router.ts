import type { AIProvider } from "../types";
import { makeProvider, type ProviderName } from "./provider-registry";

export type ComplexityHint = "low" | "medium" | "high";

export type TaskType =
  | "icp_qualification"   // Full ICP analysis — structured output + deep reasoning
  | "icp_prefilter"       // High-volume first pass before expensive qualification
  | "personalization"     // Personalised opening lines (line_1)
  | "reply_classify"      // Classify inbound replies: interested / not-interested / auto-reply
  | "text_normalize"      // Name / title cleaning and normalisation
  | "campaign_strategy"   // Deep strategic output — campaign plans, lead magnets
  | "signal_intelligence";// WHY NOW analysis — synthesize signals into timing rationale

// ── Separation of concerns ───────────────────────────────────────────────────
//
// PROVIDER_TIERS  → provider + complexity → model string  (model selection)
// ROUTES          → taskType → provider + defaultComplexity (provider selection)
//
// These are two independent tables that combine in route(). Changing a model
// only requires editing PROVIDER_TIERS. Changing which provider handles a task
// only requires editing ROUTES. Neither table has knowledge of the other's domain.

/**
 * The model each provider offers at each complexity tier.
 *
 * Low    → cheapest capable model  (Haiku / GPT-4o-mini class)
 * Medium → balanced cost/quality   (Sonnet / GPT-4o class)
 * High   → strongest reasoning     (Opus / GPT-4o class with full context)
 *
 * Model names are in each provider's native format:
 *   anthropic-direct → bare model id   (e.g. "claude-opus-4-8")
 *   openrouter       → provider/model  (e.g. "anthropic/claude-opus-4-8")
 */
export const PROVIDER_TIERS: Record<ProviderName, Record<ComplexityHint, string>> = {
  "anthropic-direct": {
    low: "claude-haiku-4-5-20251001",
    medium: "claude-sonnet-4-6",
    high: "claude-opus-4-8",
  },
  openrouter: {
    low: "anthropic/claude-haiku-4.5",   // OpenRouter uses dot notation
    medium: "anthropic/claude-sonnet-4-6",
    high: "anthropic/claude-opus-4-8",
  },
};

export interface RouteConfig {
  /** Primary AI gateway for this task type. */
  provider: ProviderName;
  /**
   * Complexity tier used when the caller passes no complexityHint.
   * Reflects the natural/expected complexity of this task type.
   */
  defaultComplexity: ComplexityHint;
  /**
   * Fallback gateways tried in order when the primary is not configured.
   * The same complexity tier is applied: PROVIDER_TIERS[fallback][tier].
   */
  fallbackProviders: ProviderName[];
}

/**
 * Task type → provider routing table.
 * Model selection is intentionally absent — see PROVIDER_TIERS.
 *
 * Provider assignment rationale:
 *   anthropic-direct → tasks requiring guaranteed structured JSON output
 *     (native output_config.format.json_schema, not prompt injection).
 *   openrouter       → cost-sensitive / high-volume tasks; cross-provider
 *     flexibility worth more than native SDK features.
 */
const ROUTES: Record<TaskType, RouteConfig> = {
  icp_qualification: {
    provider: "anthropic-direct",
    defaultComplexity: "high",         // Opus by default — full reasoning + guaranteed JSON
    fallbackProviders: ["openrouter"],
  },
  campaign_strategy: {
    provider: "anthropic-direct",
    defaultComplexity: "high",         // Opus by default — deep strategic output
    fallbackProviders: ["openrouter"],
  },
  personalization: {
    provider: "openrouter",
    defaultComplexity: "medium",       // Sonnet — creative + structured, not trivial
    fallbackProviders: ["anthropic-direct"],
  },
  icp_prefilter: {
    provider: "openrouter",
    defaultComplexity: "low",          // Haiku — bulk first-pass, volume over precision
    fallbackProviders: ["anthropic-direct"],
  },
  reply_classify: {
    provider: "openrouter",
    defaultComplexity: "low",          // Haiku — binary classification, very high volume
    fallbackProviders: ["anthropic-direct"],
  },
  text_normalize: {
    provider: "openrouter",
    defaultComplexity: "low",          // Haiku — deterministic text transform
    fallbackProviders: ["anthropic-direct"],
  },
  signal_intelligence: {
    provider: "openrouter",
    defaultComplexity: "medium",       // Sonnet — signal synthesis + timing rationale
    fallbackProviders: ["anthropic-direct"],
  },
};

/** What route() actually resolved to — for logging and auditing. */
export interface ResolvedRoute {
  provider: ProviderName;
  model: string;
  complexity: ComplexityHint;
  /** True when the primary provider was not configured and a fallback was used. */
  isFallback: boolean;
}

export class ModelRouter {
  /**
   * Returns the first configured AIProvider for the given task + complexity.
   *
   * Resolution:
   *   1. Determine the tier: complexityHint ?? ROUTES[taskType].defaultComplexity
   *   2. Look up the model: PROVIDER_TIERS[provider][tier]
   *   3. Return the primary provider if configured.
   *   4. Otherwise walk fallbackProviders (same tier) and return the first configured.
   *   5. Throw with an actionable message if nothing is configured.
   *
   * The return type is always AIProvider (the interface), never a concrete class.
   * Callers must not depend on which implementation they receive.
   *
   * @param complexity  Optional override. Omit to use the task's defaultComplexity.
   *                    Pass "low" explicitly to request a lower-cost model.
   */
  static route(taskType: TaskType, complexity?: ComplexityHint): AIProvider {
    const config = ROUTES[taskType];
    const tier = complexity ?? config.defaultComplexity;

    const primaryModel = PROVIDER_TIERS[config.provider][tier];
    const primary = makeProvider(config.provider, primaryModel);
    if (primary.isConfigured()) return primary;

    for (const fbProvider of config.fallbackProviders) {
      const fbModel = PROVIDER_TIERS[fbProvider][tier];
      const candidate = makeProvider(fbProvider, fbModel);
      if (candidate.isConfigured()) return candidate;
    }

    throw new Error(
      `No AI provider configured for task "${taskType}" (complexity: ${tier}). ` +
        `Set ANTHROPIC_API_KEY (primary) or OPENROUTER_API_KEY (fallback) in .env.`,
    );
  }

  /**
   * Resolves the (provider, model, complexity) without creating a provider instance.
   * Returns null if no provider in the chain is configured.
   * Use this for logging, auditing, or cost-estimation before making a call.
   */
  static resolve(taskType: TaskType, complexity?: ComplexityHint): ResolvedRoute | null {
    const config = ROUTES[taskType];
    const tier = complexity ?? config.defaultComplexity;

    const primaryModel = PROVIDER_TIERS[config.provider][tier];
    if (makeProvider(config.provider, primaryModel).isConfigured()) {
      return { provider: config.provider, model: primaryModel, complexity: tier, isFallback: false };
    }

    for (const fbProvider of config.fallbackProviders) {
      const fbModel = PROVIDER_TIERS[fbProvider][tier];
      if (makeProvider(fbProvider, fbModel).isConfigured()) {
        return { provider: fbProvider, model: fbModel, complexity: tier, isFallback: true };
      }
    }

    return null;
  }

  /** Returns the static routing config for a task (no env checks performed). */
  static routeConfig(taskType: TaskType): Readonly<RouteConfig> {
    return ROUTES[taskType];
  }

  /** Returns the model string a given provider uses at a specific complexity tier. */
  static tierModel(provider: ProviderName, complexity: ComplexityHint): string {
    return PROVIDER_TIERS[provider][complexity];
  }
}
