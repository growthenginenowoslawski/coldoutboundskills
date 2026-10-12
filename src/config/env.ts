/**
 * Central, server-side environment access.
 *
 * - Loads the repo-root `.env` (if present) so standalone scripts, tests, and
 *   the API see the same variables Trigger.dev injects for tasks. In production
 *   there is no `.env` file and real env vars are used as-is.
 * - Never logs secret VALUES. Only names are ever surfaced.
 * - Nothing here is imported by any frontend — secrets stay server-side.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function loadDotEnv(): void {
  // Node >= 20.12 / 24 ships process.loadEnvFile(). Guarded so it is a no-op
  // when the file or the API is unavailable.
  const candidate = resolve(process.cwd(), ".env");
  if (typeof process.loadEnvFile === "function" && existsSync(candidate)) {
    try {
      process.loadEnvFile(candidate);
    } catch {
      /* ignore malformed/locked .env — real env vars still apply */
    }
  }
}
loadDotEnv();

/** Canonical env var NAMES for each capability (values live only in the env). */
export const ENV_KEYS = {
  // Database — Supabase NEW API-key model (sb_secret_… / sb_publishable_…)
  supabaseUrl: "SUPABASE_URL",
  /** Server-side full-access key (sb_secret_…). Replaces legacy service_role. */
  supabaseSecretKey: "SUPABASE_SECRET_KEY",
  /** Public, RLS-enforced key (sb_publishable_…). Replaces legacy anon. */
  supabasePublishableKey: "SUPABASE_PUBLISHABLE_KEY",
  /** Personal Access Token (sbp_…) for the Management API — enables DDL. */
  supabaseAccessToken: "SUPABASE_ACCESS_TOKEN",
  // AI providers — add keys for the providers you want active.
  // AnthropicDirectProvider: guaranteed JSON schema, no gateway markup, native thinking.
  anthropicApiKey: "ANTHROPIC_API_KEY",
  /** Required when using an identity-linked Anthropic API key. Find it in console.anthropic.com → Settings → Workspaces. */
  anthropicWorkspaceId: "ANTHROPIC_WORKSPACE_ID",
  // OpenRouterProvider: 300+ models through one key, cross-provider fallbacks.
  openrouterApiKey: "OPENROUTER_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  // Lead-source / research providers
  apifyToken: "APIFY_API_TOKEN",
  exaApiKey: "EXA_API_KEY",
  parallelApiKey: "PARALLEL_AI_API_KEY",
  getleadsApiKey: "GETLEADS_API_KEY",
  // Signal providers
  predictleadsApiKey: "PREDICTLEADS_API_KEY",
  predictleadsApiToken: "PREDICTLEADS_API_TOKEN",
  // Outreach / sending platform providers (Stage 16)
  smartleadApiKey: "SMARTLEAD_API_KEY",
} as const;

export type EnvKey = (typeof ENV_KEYS)[keyof typeof ENV_KEYS];

/** Returns the value or `undefined` if unset/empty. Never throws. */
export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : undefined;
}

/** Returns the value or throws a clear error naming the missing variable. */
export function requireEnv(name: string): string {
  const v = optionalEnv(name);
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/** True if every named variable is present — used by `isConfigured()` checks. */
export function hasEnv(...names: string[]): boolean {
  return names.every((n) => optionalEnv(n) !== undefined);
}
