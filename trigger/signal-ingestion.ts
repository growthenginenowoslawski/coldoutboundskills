/**
 * Stage 11: Trigger.dev orchestration layer for signal ingestion.
 *
 * Durable execution shell: fetches real buying-intent signals from PredictLeads,
 * normalizes them through the existing signal engine, and writes genuinely new
 * signals to the signals table with full 3-tier deduplication.
 *
 * ── Operation identity ────────────────────────────────────────────────────────
 *
 *   Each (job_type="signal_ingestion", idempotencyKey) maps to exactly one
 *   active job row.  claimJob is atomic find-or-create — the same pattern as
 *   ai-qualify.ts.  Concurrent callers exit gracefully.
 *
 * ── Checkpoint lifecycle ──────────────────────────────────────────────────────
 *
 *   pending
 *     → running              (task started)
 *     → signals_ingested     (signals written to DB; stored in output_data)
 *     → completed
 *
 * ── Retry guarantees ─────────────────────────────────────────────────────────
 *
 *   Retry after completed:          idempotent — return cached output.
 *   Retry after signals_ingested:   skip provider call → completeJob.
 *   Retry after provider failure:   cursor not advanced (derived from DB MAX),
 *                                   upsertSignal dedup catches any partial writes.
 *   Retry after failed:             claimJob creates fresh row → full re-run.
 *
 * ── Polling cursor ────────────────────────────────────────────────────────────
 *
 *   MAX(occurred_at) from signals WHERE client_id + signal_source = 'predictleads'.
 *   Derived from the DB itself — always consistent with what is actually stored.
 *
 *   PredictLeads does not expose a server-side date filter.  The cursor is used
 *   client-side inside the provider (filter on first_seen_at >= since).
 *   The 3-tier dedup is the authoritative duplicate guard.
 *
 * ── Tenant isolation ──────────────────────────────────────────────────────────
 *
 *   clientId is validated at the start and threaded through every operation.
 *   Signals are written with client_id = payload.clientId — never mixed.
 */

import { logger, task } from "@trigger.dev/sdk";
import { claimJob, updateJob, completeJob } from "../src/db/jobs";
import { getSupabaseAdmin } from "../src/db/supabase";
import { upsertSignal } from "../src/db/signals";
import { normalizeBatch } from "../src/providers/signals/normalizer";
import {
  PredictLeadsSignalProvider,
  type PredictLeadsFetchOptions,
} from "../src/providers/signals/predictleads-provider";
import { getConfiguredSignalProviders } from "../src/providers/signals/registry";
import type { NormalizedSignal } from "../src/domain/signal-types";

// ── Payload ───────────────────────────────────────────────────────────────────

export interface SignalIngestionPayload {
  clientId: string;
  companyIds: string[];
  /**
   * Unique key for this logical operation.
   * Defaults to "signal-ingestion:{clientId}:{UTC-date}" when absent.
   */
  idempotencyKey?: string;
}

// ── Output ────────────────────────────────────────────────────────────────────

export interface SignalIngestionOutput {
  clientId: string;
  companiesRequested: number;
  companiesWithDomains: number;
  since: string | null;
  newSignalCount: number;
  skippedSignalCount: number;
  errorCount: number;
  completedAt: string;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

interface IngestionCheckpoint {
  _signal_checkpoint: {
    stage: "signals_ingested";
    since: string | null;
    newSignalCount: number;
    skippedSignalCount: number;
    errorCount: number;
    savedAt: string;
  };
}

function readIngestionCheckpoint(
  outputData: unknown,
): IngestionCheckpoint["_signal_checkpoint"] | null {
  if (!outputData || typeof outputData !== "object" || Array.isArray(outputData)) return null;
  const d = outputData as Record<string, unknown>;
  if (!d._signal_checkpoint || typeof d._signal_checkpoint !== "object") return null;
  const cp = d._signal_checkpoint as Record<string, unknown>;
  if (cp.stage !== "signals_ingested") return null;
  return d._signal_checkpoint as IngestionCheckpoint["_signal_checkpoint"];
}

// ── Task ──────────────────────────────────────────────────────────────────────

export const signalIngestion = task({
  id: "signal-ingestion",

  run: async (payload: SignalIngestionPayload): Promise<SignalIngestionOutput> => {
    const { clientId, companyIds } = payload;
    const idempotencyKey =
      payload.idempotencyKey ??
      `signal-ingestion:${clientId}:${new Date().toISOString().substring(0, 10)}`;

    logger.info("signal-ingestion started", {
      clientId,
      companyCount: companyIds.length,
      idempotencyKey,
    });

    // ── Guard: provider must be configured ───────────────────────────────────
    const configured = getConfiguredSignalProviders();
    if (configured.length === 0) {
      throw new Error(
        "No signal providers are configured. " +
          "Set PREDICTLEADS_API_KEY and PREDICTLEADS_API_TOKEN in the environment.",
      );
    }

    // ── 1. Atomic find-or-create job ─────────────────────────────────────────
    const { job: claimedJob, created } = await claimJob({
      jobType: "signal_ingestion",
      idempotencyKey,
      provider: "predictleads",
      totalItems: companyIds.length,
      inputData: { clientId, companyCount: companyIds.length, idempotencyKey },
    });

    const jobId = claimedJob.id;

    // ── 2. Resume decision ────────────────────────────────────────────────────
    if (claimedJob.status === "completed") {
      logger.info("idempotent skip — previously completed", { jobId, idempotencyKey });
      return claimedJob.output_data as SignalIngestionOutput;
    }

    const existingCp = readIngestionCheckpoint(claimedJob.output_data);
    if (existingCp) {
      logger.info("recovering from signals_ingested checkpoint", { jobId });
      const output: SignalIngestionOutput = {
        clientId,
        companiesRequested: companyIds.length,
        companiesWithDomains: 0,
        since: existingCp.since,
        newSignalCount: existingCp.newSignalCount,
        skippedSignalCount: existingCp.skippedSignalCount,
        errorCount: existingCp.errorCount,
        completedAt: new Date().toISOString(),
      };
      await completeJob(jobId, { successfulItems: existingCp.newSignalCount, outputData: output });
      return output;
    }

    // Concurrent duplicate guard (same pattern as ai-qualify.ts).
    if (!created) {
      logger.warn("concurrent execution detected — exiting gracefully", { jobId, idempotencyKey });
      return (claimedJob.output_data ?? {}) as SignalIngestionOutput;
    }

    // ── 3. Start fresh run ────────────────────────────────────────────────────
    await updateJob(jobId, { status: "running", startedAt: new Date().toISOString() });
    logger.info("job claimed, starting signal ingestion", { jobId, clientId });

    // ── 4. Load polling cursor ────────────────────────────────────────────────
    const since = await loadPollingCursor(clientId, "predictleads");
    logger.info("polling cursor loaded", { since: since ?? "null (first run)" });

    // ── 5. Resolve company domains ────────────────────────────────────────────
    const companyDomains = await resolveCompanyDomains(companyIds);
    const companiesWithDomains = companyDomains.size;
    logger.info("company domains resolved", {
      requested: companyIds.length,
      withDomains: companiesWithDomains,
      withoutDomains: companyIds.length - companiesWithDomains,
    });

    // ── 6. Fetch from PredictLeads ────────────────────────────────────────────
    const provider = new PredictLeadsSignalProvider();
    const fetchOpts: PredictLeadsFetchOptions = {
      companyDomains,
      since: since ?? undefined,
    };

    const batch = await provider.fetchEvents(companyIds, clientId, fetchOpts);

    logger.info("provider fetch complete", {
      provider: provider.id,
      eventsReceived: batch.events.length,
      meta: batch.meta,
    });

    // ── 7. Normalize ──────────────────────────────────────────────────────────
    const detectedAt = new Date().toISOString();
    const outcomes = normalizeBatch(batch.events, detectedAt);

    const normalized: NormalizedSignal[] = [];
    let normErrors = 0;

    for (const outcome of outcomes) {
      if (outcome.ok) {
        normalized.push(outcome.signal);
      } else {
        normErrors++;
        logger.warn("normalization failed for event", { error: outcome.error });
      }
    }

    logger.info("normalization complete", {
      total: outcomes.length,
      normalized: normalized.length,
      errors: normErrors,
    });

    // ── 8. Upsert signals (idempotent via dedup_key) ──────────────────────────
    let newSignalCount = 0;
    let skippedSignalCount = 0;
    let upsertErrors = 0;

    for (const signal of normalized) {
      try {
        const { created: signalCreated } = await upsertSignal(signal);
        if (signalCreated) {
          newSignalCount++;
        } else {
          skippedSignalCount++;
        }
      } catch (err) {
        upsertErrors++;
        logger.warn("upsertSignal failed", {
          signalType: signal.signalType,
          companyId: signal.companyId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const errorCount = normErrors + upsertErrors;
    logger.info("signal upsert complete", { newSignalCount, skippedSignalCount, upsertErrors });

    // ── 9. Write checkpoint (AFTER signals are in DB) ─────────────────────────
    //   Cursor advance is implicit: next run's MAX(occurred_at) query will read
    //   the newly inserted signals, so the cursor naturally moves forward.
    const checkpoint: IngestionCheckpoint = {
      _signal_checkpoint: {
        stage: "signals_ingested",
        since,
        newSignalCount,
        skippedSignalCount,
        errorCount,
        savedAt: new Date().toISOString(),
      },
    };
    await updateJob(jobId, { outputData: checkpoint });

    // ── 10. Complete ──────────────────────────────────────────────────────────
    const output: SignalIngestionOutput = {
      clientId,
      companiesRequested: companyIds.length,
      companiesWithDomains,
      since,
      newSignalCount,
      skippedSignalCount,
      errorCount,
      completedAt: new Date().toISOString(),
    };

    await completeJob(jobId, {
      successfulItems: newSignalCount,
      failedItems: errorCount,
      outputData: output,
    });

    logger.info("signal-ingestion completed", {
      jobId,
      idempotencyKey,
      newSignalCount,
      skippedSignalCount,
      errorCount,
    });

    return output;
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns MAX(occurred_at) for signals already stored for this client + source.
 * This is the polling cursor — next run will pass it as `since` to the provider.
 * Returns null on first run (no signals exist yet).
 */
async function loadPollingCursor(
  clientId: string,
  signalSource: string,
): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("signals")
    .select("occurred_at")
    .eq("client_id", clientId)
    .eq("signal_source", signalSource)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.warn("loadPollingCursor failed — falling back to full fetch", {
      error: error.message,
    });
    return null;
  }

  return (data as { occurred_at: string } | null)?.occurred_at ?? null;
}

/**
 * Queries the companies table and returns Map<companyId → bare domain>.
 * Companies without a domain (no domain or website_url column) are excluded
 * because PredictLeads identifies companies by domain, not by name.
 */
async function resolveCompanyDomains(
  companyIds: string[],
): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from("companies")
    .select("id, domain, website_url")
    .in("id", companyIds);

  if (error) {
    throw new Error(`resolveCompanyDomains failed: ${error.message}`);
  }

  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{
    id: string;
    domain: string | null;
    website_url: string | null;
  }>) {
    const d = extractBareDomain(row.domain ?? row.website_url);
    if (d) map.set(row.id, d);
  }

  return map;
}

/**
 * Extracts a bare domain (e.g. "stripe.com") from a domain string or URL.
 * Returns null when the input is empty or unparseable.
 */
function extractBareDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;
  if (!s.includes("://")) {
    return s.replace(/^www\./, "").toLowerCase().split("/")[0];
  }
  try {
    const { hostname } = new URL(s);
    return hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}
