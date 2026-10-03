/**
 * CRUD helpers for list_quality_scores.
 * Produced by /list-quality-scorecard.
 */
import { getSupabaseAdmin } from "./supabase";
import { getClientIdBySlug } from "./onboarding";

export interface NewListQualityScore {
  list_id?: string;
  list_name?: string;
  total_rows?: number;
  grade: string;
  overall_score: number;
  email_verification_score?: number;
  duplicate_email_score?: number;
  duplicate_domain_score?: number;
  title_relevance_score?: number;
  bad_title_score?: number;
  catchall_density_score?: number;
  icp_fit_score?: number;
  name_quality_score?: number;
  top_issues?: string[];
  pre_send_checklist?: { item: string; checked: boolean }[];
}

export async function insertListQualityScore(slug: string, score: NewListQualityScore) {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("list_quality_scores")
    .insert({ client_id: clientId, ...score })
    .select()
    .single();
  if (error) throw new Error(`insertListQualityScore failed: ${error.message}`);
  return data;
}

export async function listQualityScores(slug: string) {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("list_quality_scores")
    .select("*")
    .eq("client_id", clientId)
    .order("scored_at", { ascending: false });
  if (error) throw new Error(`listQualityScores failed: ${error.message}`);
  return data ?? [];
}
