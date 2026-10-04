/**
 * CRUD helpers for campaign_reviews.
 * Tracks Step 4 of the Campaign Creation Workflow:
 * notify client → share scripts → share list → collect feedback → revisions → green light.
 */
import { getSupabaseAdmin } from "./supabase";
import { getClientIdBySlug } from "./onboarding";

export type ReviewStatus =
  | "pending_review"
  | "scripts_shared"
  | "list_shared"
  | "feedback_received"
  | "revisions_made"
  | "approved";

export interface NewCampaignReview {
  campaign_id?: string;
  sequence_id?: string;
  scripts_shared_at?: string;
  list_shared_at?: string;
  scripts_share_url?: string;
  list_share_url?: string;
  client_feedback?: string;
  revision_notes?: string;
  revision_count?: number;
  approved_by?: string;
  approved_at?: string;
  status?: ReviewStatus;
}

export async function createCampaignReview(slug: string, review: NewCampaignReview) {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_reviews")
    .insert({ client_id: clientId, ...review })
    .select()
    .single();
  if (error) throw new Error(`createCampaignReview failed: ${error.message}`);
  return data;
}

export async function updateCampaignReview(id: string, updates: Partial<NewCampaignReview> & { status?: ReviewStatus }) {
  const { error } = await getSupabaseAdmin()
    .from("campaign_reviews")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`updateCampaignReview failed: ${error.message}`);
}

export async function listCampaignReviews(slug: string) {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_reviews")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listCampaignReviews failed: ${error.message}`);
  return data ?? [];
}

export async function approveCampaignReview(id: string, approvedBy: string) {
  const { error } = await getSupabaseAdmin()
    .from("campaign_reviews")
    .update({
      status: "approved",
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`approveCampaignReview failed: ${error.message}`);
}
