/**
 * Offline tests for ProviderRegistry + ModelRouter (Stages 2 & 3).
 *
 * No real API calls. Tests verify:
 *   - makeProvider() creates the correct concrete type.
 *   - ModelRouter.route() returns AIProvider (interface, not concrete class).
 *   - Primary provider is selected when its key is configured.
 *   - Fallback provider is selected when primary key is missing.
 *   - An error is thrown when no provider in the chain is configured.
 *   - routeConfig() exposes the routing table without side effects.
 *   - complexityHint selects the correct model tier.
 *   - defaultComplexity is used when no hint is passed.
 *   - resolve() reports the resolved (provider, model, complexity, isFallback).
 *   - tierModel() exposes the model string for any provider + tier combination.
 *   - PROVIDER_TIERS has complete entries for every provider + tier.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { makeProvider } from "../providers/ai/provider-registry";
import { ModelRouter, PROVIDER_TIERS } from "../providers/ai/model-router";
import type { TaskType, ComplexityHint } from "../providers/ai/model-router";
import { AnthropicDirectProvider } from "../providers/ai/anthropic-provider";
import { OpenRouterProvider } from "../providers/ai/openrouter-provider";
import type { AIProvider } from "../providers/types";

// ── Env helpers ─────────────────────────────────────────────────────────────

type EnvSnapshot = Record<string, string | undefined>;

function saveEnv(...keys: string[]): EnvSnapshot {
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [k, v] of Object.entries(snapshot)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const ALL_TASK_TYPES: TaskType[] = [
  "icp_qualification",
  "icp_prefilter",
  "personalization",
  "reply_classify",
  "text_normalize",
  "campaign_strategy",
];

const ALL_COMPLEXITIES: ComplexityHint[] = ["low", "medium", "high"];

let snapshot: EnvSnapshot;

before(() => {
  snapshot = saveEnv("ANTHROPIC_API_KEY", "OPENROUTER_API_KEY");
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: undefined });
});

after(() => {
  restoreEnv(snapshot);
});

// ── makeProvider (ProviderRegistry) ─────────────────────────────────────────

test("makeProvider: anthropic-direct creates AnthropicDirectProvider", () => {
  const p = makeProvider("anthropic-direct", "claude-opus-4-8");
  assert.ok(p instanceof AnthropicDirectProvider);
  assert.equal(p.id, "anthropic-direct:claude-opus-4-8");
});

test("makeProvider: openrouter creates OpenRouterProvider", () => {
  const p = makeProvider("openrouter", "anthropic/claude-haiku-4-5-20251001");
  assert.ok(p instanceof OpenRouterProvider);
  assert.equal(p.id, "openrouter:anthropic/claude-haiku-4-5-20251001");
});

test("makeProvider: both results satisfy AIProvider interface", () => {
  const providers: AIProvider[] = [
    makeProvider("anthropic-direct", "claude-opus-4-8"),
    makeProvider("openrouter", "openrouter/auto"),
  ];
  for (const p of providers) {
    assert.ok(typeof p.qualifyCompany === "function");
    assert.ok(typeof p.isConfigured === "function");
    assert.equal(p.capability, "ai");
  }
});

// ── PROVIDER_TIERS completeness ──────────────────────────────────────────────

test("PROVIDER_TIERS: anthropic-direct has all three complexity tiers", () => {
  for (const tier of ALL_COMPLEXITIES) {
    const model = PROVIDER_TIERS["anthropic-direct"][tier];
    assert.ok(typeof model === "string" && model.length > 0,
      `anthropic-direct missing model for tier "${tier}"`);
  }
});

test("PROVIDER_TIERS: openrouter has all three complexity tiers", () => {
  for (const tier of ALL_COMPLEXITIES) {
    const model = PROVIDER_TIERS["openrouter"][tier];
    assert.ok(typeof model === "string" && model.length > 0,
      `openrouter missing model for tier "${tier}"`);
  }
});

test("PROVIDER_TIERS: anthropic-direct low tier is Haiku", () => {
  assert.match(PROVIDER_TIERS["anthropic-direct"].low, /haiku/i);
});

test("PROVIDER_TIERS: anthropic-direct medium tier is Sonnet", () => {
  assert.match(PROVIDER_TIERS["anthropic-direct"].medium, /sonnet/i);
});

test("PROVIDER_TIERS: anthropic-direct high tier is Opus", () => {
  assert.match(PROVIDER_TIERS["anthropic-direct"].high, /opus/i);
});

test("PROVIDER_TIERS: openrouter models use provider/model format", () => {
  for (const tier of ALL_COMPLEXITIES) {
    const model = PROVIDER_TIERS["openrouter"][tier];
    assert.match(model, /^[a-z]+\//,
      `openrouter model "${model}" should be in "provider/model" format`);
  }
});

test("PROVIDER_TIERS: tiers are distinct (low ≠ medium ≠ high) for each provider", () => {
  for (const provider of ["anthropic-direct", "openrouter"] as const) {
    const { low, medium, high } = PROVIDER_TIERS[provider];
    assert.notEqual(low, medium, `${provider}: low and medium should be different models`);
    assert.notEqual(medium, high, `${provider}: medium and high should be different models`);
    assert.notEqual(low, high, `${provider}: low and high should be different models`);
  }
});

// ── tierModel() ──────────────────────────────────────────────────────────────

test("tierModel: returns correct model for anthropic-direct at each tier", () => {
  assert.equal(
    ModelRouter.tierModel("anthropic-direct", "low"),
    PROVIDER_TIERS["anthropic-direct"].low,
  );
  assert.equal(
    ModelRouter.tierModel("anthropic-direct", "medium"),
    PROVIDER_TIERS["anthropic-direct"].medium,
  );
  assert.equal(
    ModelRouter.tierModel("anthropic-direct", "high"),
    PROVIDER_TIERS["anthropic-direct"].high,
  );
});

test("tierModel: returns correct model for openrouter at each tier", () => {
  assert.equal(
    ModelRouter.tierModel("openrouter", "low"),
    PROVIDER_TIERS["openrouter"].low,
  );
  assert.equal(
    ModelRouter.tierModel("openrouter", "medium"),
    PROVIDER_TIERS["openrouter"].medium,
  );
  assert.equal(
    ModelRouter.tierModel("openrouter", "high"),
    PROVIDER_TIERS["openrouter"].high,
  );
});

// ── routeConfig() ────────────────────────────────────────────────────────────

test("routeConfig: icp_qualification uses anthropic-direct with high default", () => {
  const config = ModelRouter.routeConfig("icp_qualification");
  assert.equal(config.provider, "anthropic-direct");
  assert.equal(config.defaultComplexity, "high");
  assert.ok(Array.isArray(config.fallbackProviders));
  assert.ok(config.fallbackProviders.length > 0);
});

test("routeConfig: icp_qualification fallbackProviders includes openrouter", () => {
  const config = ModelRouter.routeConfig("icp_qualification");
  assert.ok(
    config.fallbackProviders.includes("openrouter"),
    "icp_qualification should fall back to openrouter",
  );
});

test("routeConfig: all task types have at least one fallback provider", () => {
  for (const taskType of ALL_TASK_TYPES) {
    const config = ModelRouter.routeConfig(taskType);
    assert.ok(
      config.fallbackProviders.length > 0,
      `Task "${taskType}" should have at least one fallbackProvider`,
    );
  }
});

test("routeConfig: openrouter tasks have low or medium defaultComplexity", () => {
  const openrouterTasks: TaskType[] = [
    "icp_prefilter",
    "personalization",
    "reply_classify",
    "text_normalize",
  ];
  for (const taskType of openrouterTasks) {
    const config = ModelRouter.routeConfig(taskType);
    assert.equal(config.provider, "openrouter");
    assert.ok(
      config.defaultComplexity === "low" || config.defaultComplexity === "medium",
      `${taskType} (openrouter) should default to low or medium, got "${config.defaultComplexity}"`,
    );
  }
});

test("routeConfig: anthropic-direct tasks default to high complexity", () => {
  const anthropicTasks: TaskType[] = ["icp_qualification", "campaign_strategy"];
  for (const taskType of anthropicTasks) {
    const config = ModelRouter.routeConfig(taskType);
    assert.equal(config.provider, "anthropic-direct");
    assert.equal(config.defaultComplexity, "high",
      `${taskType} should default to high complexity`);
  }
});

// ── ModelRouter.route() — primary selection ──────────────────────────────────

test("route icp_qualification: returns AnthropicDirectProvider when ANTHROPIC_API_KEY set", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: undefined });
  const provider = ModelRouter.route("icp_qualification");
  assert.ok(provider instanceof AnthropicDirectProvider,
    `Expected AnthropicDirectProvider, got ${provider.constructor.name}`);
});

test("route campaign_strategy: returns AnthropicDirectProvider when ANTHROPIC_API_KEY set", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: undefined });
  const provider = ModelRouter.route("campaign_strategy");
  assert.ok(provider instanceof AnthropicDirectProvider);
});

test("route reply_classify: returns OpenRouterProvider when OPENROUTER_API_KEY set", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const provider = ModelRouter.route("reply_classify");
  assert.ok(provider instanceof OpenRouterProvider);
});

test("route personalization: returns OpenRouterProvider when OPENROUTER_API_KEY set", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const provider = ModelRouter.route("personalization");
  assert.ok(provider instanceof OpenRouterProvider);
});

// ── ModelRouter.route() — fallback selection ─────────────────────────────────

test("route icp_qualification: falls back to OpenRouterProvider when only OPENROUTER_API_KEY set", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const provider = ModelRouter.route("icp_qualification");
  assert.ok(provider instanceof OpenRouterProvider,
    `Expected OpenRouterProvider fallback, got ${provider.constructor.name}`);
});

test("route campaign_strategy: falls back to OpenRouterProvider when Anthropic key missing", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const provider = ModelRouter.route("campaign_strategy");
  assert.ok(provider instanceof OpenRouterProvider);
});

// ── ModelRouter.route() — both keys present ───────────────────────────────────

test("route icp_qualification: prefers Anthropic direct when both keys present", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "sk-or-test" });
  const provider = ModelRouter.route("icp_qualification");
  assert.ok(provider instanceof AnthropicDirectProvider,
    "Primary should win when both providers are configured");
});

// ── ModelRouter.route() — no provider configured ────────────────────────────

test("route throws when neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: undefined });
  assert.throws(
    () => ModelRouter.route("icp_qualification"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /No AI provider configured/);
      assert.match(err.message, /ANTHROPIC_API_KEY/);
      return true;
    },
  );
});

test("route throws for every task type when no keys are set", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: undefined });
  for (const taskType of ALL_TASK_TYPES) {
    assert.throws(
      () => ModelRouter.route(taskType),
      Error,
      `Expected throw for unconfigured task "${taskType}"`,
    );
  }
});

// ── ComplexityHint: model selection ─────────────────────────────────────────

test("complexity low: icp_qualification routes to Haiku model (anthropic-direct)", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: undefined });
  const resolved = ModelRouter.resolve("icp_qualification", "low");
  assert.ok(resolved !== null);
  assert.equal(resolved.complexity, "low");
  assert.equal(resolved.model, PROVIDER_TIERS["anthropic-direct"].low);
  assert.match(resolved.model, /haiku/i);
});

test("complexity medium: icp_qualification routes to Sonnet model (anthropic-direct)", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: undefined });
  const resolved = ModelRouter.resolve("icp_qualification", "medium");
  assert.ok(resolved !== null);
  assert.equal(resolved.complexity, "medium");
  assert.equal(resolved.model, PROVIDER_TIERS["anthropic-direct"].medium);
  assert.match(resolved.model, /sonnet/i);
});

test("complexity high: icp_qualification routes to Opus model (anthropic-direct)", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: undefined });
  const resolved = ModelRouter.resolve("icp_qualification", "high");
  assert.ok(resolved !== null);
  assert.equal(resolved.complexity, "high");
  assert.equal(resolved.model, PROVIDER_TIERS["anthropic-direct"].high);
  assert.match(resolved.model, /opus/i);
});

test("complexity low: reply_classify routes to Haiku via openrouter", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("reply_classify", "low");
  assert.ok(resolved !== null);
  assert.equal(resolved.provider, "openrouter");
  assert.match(resolved.model, /haiku/i);
});

test("complexity medium: reply_classify routes to Sonnet via openrouter", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("reply_classify", "medium");
  assert.ok(resolved !== null);
  assert.equal(resolved.provider, "openrouter");
  assert.match(resolved.model, /sonnet/i);
});

test("complexity high: reply_classify routes to Opus via openrouter", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("reply_classify", "high");
  assert.ok(resolved !== null);
  assert.equal(resolved.provider, "openrouter");
  assert.match(resolved.model, /opus/i);
});

test("complexity low: personalization routes to Haiku (overriding medium default)", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("personalization", "low");
  assert.ok(resolved !== null);
  assert.match(resolved.model, /haiku/i);
  assert.equal(resolved.complexity, "low");
});

test("complexity high: text_normalize routes to Opus (overriding low default)", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("text_normalize", "high");
  assert.ok(resolved !== null);
  assert.match(resolved.model, /opus/i);
  assert.equal(resolved.complexity, "high");
});

// ── ComplexityHint: default complexity used when no hint given ───────────────

test("no hint: icp_qualification defaults to high (Opus)", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: undefined });
  const resolved = ModelRouter.resolve("icp_qualification");
  assert.ok(resolved !== null);
  assert.equal(resolved.complexity, "high");
  assert.match(resolved.model, /opus/i);
});

test("no hint: reply_classify defaults to low (Haiku)", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("reply_classify");
  assert.ok(resolved !== null);
  assert.equal(resolved.complexity, "low");
  assert.match(resolved.model, /haiku/i);
});

test("no hint: personalization defaults to medium (Sonnet)", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("personalization");
  assert.ok(resolved !== null);
  assert.equal(resolved.complexity, "medium");
  assert.match(resolved.model, /sonnet/i);
});

// ── resolve() ────────────────────────────────────────────────────────────────

test("resolve: returns null when no provider is configured", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: undefined });
  const resolved = ModelRouter.resolve("icp_qualification");
  assert.equal(resolved, null);
});

test("resolve: isFallback=false when primary is used", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("icp_qualification");
  assert.ok(resolved !== null);
  assert.equal(resolved.isFallback, false);
  assert.equal(resolved.provider, "anthropic-direct");
});

test("resolve: isFallback=true when primary is not configured", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  const resolved = ModelRouter.resolve("icp_qualification");
  assert.ok(resolved !== null);
  assert.equal(resolved.isFallback, true);
  assert.equal(resolved.provider, "openrouter");
});

test("resolve: all task types return non-null when both keys are set", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "sk-or-test" });
  for (const taskType of ALL_TASK_TYPES) {
    for (const complexity of ALL_COMPLEXITIES) {
      const resolved = ModelRouter.resolve(taskType, complexity);
      assert.ok(
        resolved !== null,
        `resolve("${taskType}", "${complexity}") should return non-null when both keys set`,
      );
      assert.ok(resolved.model.length > 0);
      assert.equal(resolved.complexity, complexity);
    }
  }
});

// ── Return type contract ─────────────────────────────────────────────────────

test("route always returns AIProvider at every complexity level (both keys set)", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: "sk-or-test" });
  for (const taskType of ALL_TASK_TYPES) {
    for (const complexity of ALL_COMPLEXITIES) {
      const provider: AIProvider = ModelRouter.route(taskType, complexity);
      assert.equal(provider.capability, "ai",
        `${taskType}/${complexity}: capability should be 'ai'`);
      assert.ok(typeof provider.qualifyCompany === "function");
    }
  }
});

// ── Provider identity per complexity ─────────────────────────────────────────

test("all complexities for icp_qualification use anthropic-direct when key is set", () => {
  setEnv({ ANTHROPIC_API_KEY: "sk-ant-test", OPENROUTER_API_KEY: undefined });
  for (const complexity of ALL_COMPLEXITIES) {
    const provider = ModelRouter.route("icp_qualification", complexity);
    assert.ok(provider instanceof AnthropicDirectProvider,
      `icp_qualification/${complexity} should use anthropic-direct`);
  }
});

test("all complexities for reply_classify use OpenRouterProvider when openrouter key is set", () => {
  setEnv({ ANTHROPIC_API_KEY: undefined, OPENROUTER_API_KEY: "sk-or-test" });
  for (const complexity of ALL_COMPLEXITIES) {
    const provider = ModelRouter.route("reply_classify", complexity);
    assert.ok(provider instanceof OpenRouterProvider,
      `reply_classify/${complexity} should use openrouter`);
  }
});
