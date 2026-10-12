/**
 * CRUD helpers for the campaign_plans table.
 * One synthesised plan per client, produced by /cold-email-kickoff Step 5.
 */
import { getSupabaseAdmin } from "./supabase";
import { getClientIdBySlug } from "./onboarding";

export interface CampaignPlanRow {
  id: string;
  client_id: string;
  business_summary: string | null;
  icp_summary: string | null;
  offer_summary: string | null;
  infrastructure_status: Record<string, unknown> | null;
  top_campaign_names: string[] | null;
  next_steps: string | null;
  status: "draft" | "approved";
  generated_at: string;
  created_at: string;
  updated_at: string;
}

export interface NewCampaignPlan {
  business_summary?: string;
  icp_summary?: string;
  offer_summary?: string;
  infrastructure_status?: Record<string, unknown>;
  top_campaign_names?: string[];
  next_steps?: string;
  status?: "draft" | "approved";
}

export async function upsertCampaignPlan(slug: string, plan: NewCampaignPlan): Promise<CampaignPlanRow> {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const db = getSupabaseAdmin();
  const { data: existing } = await db
    .from("campaign_plans")
    .select("id")
    .eq("client_id", clientId)
    .eq("status", "draft")
    .maybeSingle();
  if (existing) {
    const { data, error } = await db
      .from("campaign_plans")
      .update({ ...plan, updated_at: new Date().toISOString() })
      .eq("id", (existing as { id: string }).id)
      .select()
      .single();
    if (error) throw new Error(`upsertCampaignPlan update failed: ${error.message}`);
    return data as CampaignPlanRow;
  }
  const { data, error } = await db
    .from("campaign_plans")
    .insert({ client_id: clientId, ...plan })
    .select()
    .single();
  if (error) throw new Error(`upsertCampaignPlan insert failed: ${error.message}`);
  return data as CampaignPlanRow;
}

export async function getCampaignPlan(slug: string): Promise<CampaignPlanRow | null> {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_plans")
    .select("*")
    .eq("client_id", clientId)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getCampaignPlan failed: ${error.message}`);
  return (data ?? null) as CampaignPlanRow | null;
}
