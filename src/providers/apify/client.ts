/**
 * Thin, reusable Apify wrapper. The rest of the app calls runActor() /
 * getDatasetItems() and never imports apify-client directly, so the specific
 * Actor is never hardcoded across the codebase — swap the Actor id in one place.
 */
import { ApifyClient } from "apify-client";
import { ENV_KEYS, optionalEnv, requireEnv } from "../../config/env";

let client: ApifyClient | undefined;

export function isApifyConfigured(): boolean {
  return optionalEnv(ENV_KEYS.apifyToken) !== undefined;
}

function getClient(): ApifyClient {
  if (!client) client = new ApifyClient({ token: requireEnv(ENV_KEYS.apifyToken) });
  return client;
}

/** Runs an Actor synchronously and returns the finished run (throws if not SUCCEEDED). */
export async function runActor(
  actorId: string,
  input: Record<string, unknown>,
): Promise<{ defaultDatasetId: string; status: string }> {
  const run = await getClient().actor(actorId).call(input);
  if (run.status !== "SUCCEEDED") {
    throw new Error(`Apify actor "${actorId}" finished with status ${run.status}`);
  }
  return { defaultDatasetId: run.defaultDatasetId, status: run.status };
}

/** Reads up to `limit` items from a dataset. */
export async function getDatasetItems<T = Record<string, unknown>>(
  datasetId: string,
  limit?: number,
): Promise<T[]> {
  const { items } = await getClient()
    .dataset(datasetId)
    .listItems(limit ? { limit } : {});
  return items as T[];
}
