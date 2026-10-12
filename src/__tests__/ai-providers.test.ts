/**
 * Offline tests for AI provider contracts.
 *
 * These tests do NOT make real API calls. They verify:
 *   - Both providers implement the AIProvider interface correctly.
 *   - isConfigured() reflects actual env var presence.
 *   - id format and capability values are correct.
 *   - Constructor option defaults are applied.
 *
 * API call tests (Stage 11) run separately and require real keys.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import { AnthropicDirectProvider } from "../providers/ai/anthropic-provider";
import { OpenRouterProvider } from "../providers/ai/openrouter-provider";
import type { AIProvider } from "../providers/types";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Temporarily set an env var for a test, then restore the original value. */
function withEnv(key: string, value: string | undefined, fn: () => void): void {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
}

// Save original env so suite teardown can restore cleanly.
let originalAnthropicKey: string | undefined;
let originalOpenRouterKey: string | undefined;

before(() => {
  originalAnthropicKey = process.env["ANTHROPIC_API_KEY"];
  originalOpenRouterKey = process.env["OPENROUTER_API_KEY"];
});

after(() => {
  if (originalAnthropicKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = originalAnthropicKey;

  if (originalOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
  else process.env["OPENROUTER_API_KEY"] = originalOpenRouterKey;
});

// ── AnthropicDirectProvider ─────────────────────────────────────────────────

test("AnthropicDirectProvider: capability is 'ai'", () => {
  const p = new AnthropicDirectProvider();
  assert.equal(p.capability, "ai");
});

test("AnthropicDirectProvider: default id includes model name", () => {
  const p = new AnthropicDirectProvider();
  assert.match(p.id, /^anthropic-direct:/);
  assert.match(p.id, /claude-opus-4-8/);
});

test("AnthropicDirectProvider: custom model reflected in id", () => {
  const p = new AnthropicDirectProvider({ model: "claude-haiku-4-5-20251001" });
  assert.equal(p.id, "anthropic-direct:claude-haiku-4-5-20251001");
});

test("AnthropicDirectProvider: isConfigured() false when ANTHROPIC_API_KEY absent", () => {
  withEnv("ANTHROPIC_API_KEY", undefined, () => {
    const p = new AnthropicDirectProvider();
    assert.equal(p.isConfigured(), false);
  });
});

test("AnthropicDirectProvider: isConfigured() true when ANTHROPIC_API_KEY present", () => {
  withEnv("ANTHROPIC_API_KEY", "sk-ant-test-key", () => {
    const p = new AnthropicDirectProvider();
    assert.equal(p.isConfigured(), true);
  });
});

test("AnthropicDirectProvider: isConfigured() false when key is empty string", () => {
  withEnv("ANTHROPIC_API_KEY", "", () => {
    const p = new AnthropicDirectProvider();
    assert.equal(p.isConfigured(), false);
  });
});

test("AnthropicDirectProvider: satisfies AIProvider interface (type check via assignment)", () => {
  // This is a compile-time check — if the class doesn't satisfy AIProvider,
  // TypeScript will error here before the test even runs.
  const p: AIProvider = new AnthropicDirectProvider();
  assert.ok(p);
});

// ── OpenRouterProvider ──────────────────────────────────────────────────────

test("OpenRouterProvider: capability is 'ai'", () => {
  const p = new OpenRouterProvider({ model: "anthropic/claude-opus-4-8" });
  assert.equal(p.capability, "ai");
});

test("OpenRouterProvider: id includes 'openrouter:' prefix and model", () => {
  const p = new OpenRouterProvider({ model: "anthropic/claude-haiku-4-5-20251001" });
  assert.equal(p.id, "openrouter:anthropic/claude-haiku-4-5-20251001");
});

test("OpenRouterProvider: isConfigured() false when OPENROUTER_API_KEY absent", () => {
  withEnv("OPENROUTER_API_KEY", undefined, () => {
    const p = new OpenRouterProvider({ model: "openrouter/auto" });
    assert.equal(p.isConfigured(), false);
  });
});

test("OpenRouterProvider: isConfigured() true when OPENROUTER_API_KEY present", () => {
  withEnv("OPENROUTER_API_KEY", "sk-or-test-key", () => {
    const p = new OpenRouterProvider({ model: "openrouter/auto" });
    assert.equal(p.isConfigured(), true);
  });
});

test("OpenRouterProvider: isConfigured() false when key is empty string", () => {
  withEnv("OPENROUTER_API_KEY", "", () => {
    const p = new OpenRouterProvider({ model: "openrouter/auto" });
    assert.equal(p.isConfigured(), false);
  });
});

test("OpenRouterProvider: satisfies AIProvider interface (type check via assignment)", () => {
  const p: AIProvider = new OpenRouterProvider({ model: "anthropic/claude-opus-4-8" });
  assert.ok(p);
});

// ── Cross-provider: both implement same interface ───────────────────────────

test("Both providers share the 'ai' capability", () => {
  const providers: AIProvider[] = [
    new AnthropicDirectProvider(),
    new OpenRouterProvider({ model: "anthropic/claude-opus-4-8" }),
  ];
  for (const p of providers) {
    assert.equal(p.capability, "ai", `${p.id} capability should be 'ai'`);
    assert.ok(typeof p.isConfigured === "function", `${p.id} should have isConfigured()`);
    assert.ok(typeof p.qualifyCompany === "function", `${p.id} should have qualifyCompany()`);
  }
});

test("Both providers have distinct id prefixes", () => {
  const anthropic = new AnthropicDirectProvider();
  const openrouter = new OpenRouterProvider({ model: "anthropic/claude-opus-4-8" });
  assert.notEqual(anthropic.id, openrouter.id);
  assert.ok(anthropic.id.startsWith("anthropic-direct:"));
  assert.ok(openrouter.id.startsWith("openrouter:"));
});
