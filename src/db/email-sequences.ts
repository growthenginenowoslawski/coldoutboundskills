/**
 * CRUD helpers for email_sequences + email_sequence_steps.
 * Produced by /campaign-copywriting.
 */
import { getSupabaseAdmin } from "./supabase";
import { getClientIdBySlug } from "./onboarding";

export interface NewEmailSequence {
  campaign_strategy_id?: string;
  name: string;
  campaign_angle?: string;
  target_audience?: string;
  core_pain_point?: string;
  value_proposition?: string;
  proof_point?: string;
  ai_variables?: Record<string, unknown>[];
  overall_score?: number;
  status?: "draft" | "approved" | "active" | "archived";
  notes?: string;
}

export interface NewSequenceStep {
  step: number;
  delay_days: number;
  is_new_thread?: boolean;
  strategy_type?: string;
  value_prop_angle?: string;
  subject_options?: string[];
  variants: { label: string; subject: string; body: string }[];
}

export async function insertEmailSequence(
  slug: string,
  sequence: NewEmailSequence,
  steps: NewSequenceStep[],
): Promise<string> {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const db = getSupabaseAdmin();

  const { data, error } = await db
    .from("email_sequences")
    .insert({ client_id: clientId, ...sequence })
    .select("id")
    .single();
  if (error) throw new Error(`insertEmailSequence failed: ${error.message}`);
  const sequenceId = (data as { id: string }).id;

  if (steps.length > 0) {
    const { error: stepsError } = await db
      .from("email_sequence_steps")
      .insert(steps.map(s => ({ sequence_id: sequenceId, ...s })));
    if (stepsError) throw new Error(`insertSequenceSteps failed: ${stepsError.message}`);
  }
  return sequenceId;
}

export async function listEmailSequences(slug: string) {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("email_sequences")
    .select("*, email_sequence_steps(*)")
    .eq("client_id", clientId)
    .order("created_at");
  if (error) throw new Error(`listEmailSequences failed: ${error.message}`);
  return data ?? [];
}
