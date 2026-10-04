/**
 * Typed helpers for the `jobs` table.
 *
 * Stage 10 additions:
 *   - `idempotency_key` native column (was buried in input_data JSONB)
 *   - `claimJob()` — atomic find-or-create using the DB unique constraint
 */
import { getSupabaseAdmin } from "./supabase";

const TABLE = "jobs";

export interface JobRow {
  id: string;
  job_type: string;
  status: string;
  provider: string | null;
  list_id: string | null;
  campaign_id: string | null;
  total_items: number;
  processed_items: number;
  successful_items: number;
  failed_items: number;
  input_data: unknown | null;
  output_data: unknown | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  idempotency_key: string | null;
}

export interface CreateJobInput {
  jobType: string;
  idempotencyKey?: string;
  provider?: string;
  totalItems?: number;
  inputData?: unknown;
}

export interface UpdateJobPatch {
  status?: string;
  provider?: string;
  processedItems?: number;
  successfulItems?: number;
  failedItems?: number;
  outputData?: unknown;
  errorMessage?: string | null;
  startedAt?: string;
  completedAt?: string;
}

export async function createJob(input: CreateJobInput): Promise<JobRow> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .insert({
      job_type: input.jobType,
      status: "pending",
      provider: input.provider ?? null,
      total_items: input.totalItems ?? 0,
      processed_items: 0,
      successful_items: 0,
      failed_items: 0,
      input_data: input.inputData ?? null,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(`createJob failed: ${error.message}`);
  return data as JobRow;
}

export interface ClaimJobInput extends CreateJobInput {
  idempotencyKey: string;
}

/**
 * Atomically finds or creates a job for the given (jobType, idempotencyKey).
 *
 * If an active (non-failed, non-cancelled) job already exists for this pair →
 * returns { job, created: false }.
 *
 * If no active job exists → inserts a new pending row → returns { job, created: true }.
 *
 * Concurrent safety: the partial unique index `jobs_active_idempotency_idx` ensures
 * only one INSERT wins. The losing concurrent request gets error 23505, falls through
 * to the lookup path, and returns the winner's row.
 */
export async function claimJob(
  input: ClaimJobInput,
): Promise<{ job: JobRow; created: boolean }> {
  const db = getSupabaseAdmin();

  const { data, error } = await db
    .from(TABLE)
    .insert({
      job_type: input.jobType,
      idempotency_key: input.idempotencyKey,
      status: "pending",
      provider: input.provider ?? null,
      total_items: input.totalItems ?? 0,
      processed_items: 0,
      successful_items: 0,
      failed_items: 0,
      input_data: input.inputData ?? null,
    })
    .select()
    .single();

  if (!error) return { job: data as JobRow, created: true };

  // Unique violation: an active job already exists for this (job_type, idempotency_key).
  if (error.code === "23505") {
    const { data: existing, error: lookupErr } = await db
      .from(TABLE)
      .select("*")
      .eq("job_type", input.jobType)
      .eq("idempotency_key", input.idempotencyKey)
      .not("status", "in", `("failed","cancelled")`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lookupErr) {
      throw new Error(`claimJob lookup failed: ${lookupErr.message}`);
    }
    if (!existing) {
      // Extremely narrow race: the job was completed and the partial index now
      // excludes it... but 'completed' is still in the index. Should not happen.
      throw new Error(
        `claimJob: unique violation but no active job found for ` +
          `(${input.jobType}, ${input.idempotencyKey}) — possible race condition`,
      );
    }
    return { job: existing as JobRow, created: false };
  }

  throw new Error(`claimJob failed: ${error.message}`);
}

export async function getJob(id: string): Promise<JobRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getJob failed: ${error.message}`);
  return (data as JobRow | null) ?? null;
}

export async function updateJob(id: string, patch: UpdateJobPatch): Promise<JobRow> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.provider !== undefined) row.provider = patch.provider;
  if (patch.processedItems !== undefined) row.processed_items = patch.processedItems;
  if (patch.successfulItems !== undefined) row.successful_items = patch.successfulItems;
  if (patch.failedItems !== undefined) row.failed_items = patch.failedItems;
  if (patch.outputData !== undefined) row.output_data = patch.outputData;
  if (patch.errorMessage !== undefined) row.error_message = patch.errorMessage;
  if (patch.startedAt !== undefined) row.started_at = patch.startedAt;
  if (patch.completedAt !== undefined) row.completed_at = patch.completedAt;

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .update(row)
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`updateJob failed: ${error.message}`);
  return data as JobRow;
}

export async function completeJob(
  id: string,
  opts: { successfulItems?: number; failedItems?: number; outputData?: unknown } = {},
): Promise<JobRow> {
  return updateJob(id, {
    status: "completed",
    completedAt: new Date().toISOString(),
    ...opts,
  });
}

export async function deleteJob(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin().from(TABLE).delete().eq("id", id);
  if (error) throw new Error(`deleteJob failed: ${error.message}`);
}
