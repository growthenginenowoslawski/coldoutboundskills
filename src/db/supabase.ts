/**
 * Server-side Supabase client.
 *
 * Uses the SECRET key (sb_secret_…), which bypasses RLS — so this module must
 * only ever run server-side (Trigger.dev tasks, the internal API, scripts).
 * Never import this from a browser/frontend bundle.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ENV_KEYS, requireEnv } from "../config/env";

let client: SupabaseClient | undefined;

/** Lazily-created singleton admin client. */
export function getSupabaseAdmin(): SupabaseClient {
  if (client) return client;
  client = createClient(
    requireEnv(ENV_KEYS.supabaseUrl),
    requireEnv(ENV_KEYS.supabaseSecretKey),
    {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "gramscode-research-engine" } },
    },
  );
  return client;
}
