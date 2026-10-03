/**
 * Helpers for the clients + icp_onboarding tables: look up a client by slug and
 * record answers as the interview proceeds (upsert by client + question_key).
 */
import { getSupabaseAdmin } from "./supabase";

export async function getClientIdBySlug(slug: string): Promise<string | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("clients")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`getClientIdBySlug failed: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** Records an answer for one question of one client. */
export async function saveAnswer(
  slug: string,
  questionKey: string,
  answer: string,
): Promise<void> {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { error } = await getSupabaseAdmin()
    .from("icp_onboarding")
    .update({ answer, answered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("client_id", clientId)
    .eq("question_key", questionKey);
  if (error) throw new Error(`saveAnswer failed: ${error.message}`);
}
