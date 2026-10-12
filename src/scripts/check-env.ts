/**
 * Verifies required env vars are PRESENT without ever printing their values.
 * Run: npx tsx src/scripts/check-env.ts
 */
import { ENV_KEYS, optionalEnv } from "../config/env";

const required = [ENV_KEYS.supabaseUrl, ENV_KEYS.supabaseSecretKey];
const optional = [
  ENV_KEYS.supabasePublishableKey,
  "SUPABASE_JWKS_URL",
  ENV_KEYS.anthropicApiKey,
];

function mask(name: string): string {
  const v = optionalEnv(name);
  if (!v) return "MISSING";
  // Show only that it's present + length + a short non-sensitive prefix.
  const prefix = v.slice(0, Math.min(6, v.indexOf("_") + 1)) || v.slice(0, 3);
  return `present (${v.length} chars, starts "${prefix}…")`;
}

let ok = true;
console.log("Required:");
for (const name of required) {
  const status = mask(name);
  if (status === "MISSING") ok = false;
  console.log(`  ${name}: ${status}`);
}
console.log("Optional:");
for (const name of optional) {
  console.log(`  ${name}: ${mask(name)}`);
}

if (!ok) {
  console.error("\nOne or more required variables are missing.");
  process.exit(1);
}
console.log("\nAll required variables present.");
