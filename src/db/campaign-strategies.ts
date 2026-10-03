/**
 * CRUD helpers for the campaign_strategies table.
 * One row per campaign idea per client, produced by /campaign-strategy.
 */
import { getSupabaseAdmin } from "./supabase";
import { getClientIdBySlug } from "./onboarding";

export interface CampaignStrategyRow {
  id: string;
  client_id: string;
  campaign_name: string;
  targeting_level: string | null;
  list_filters: string | null;
  ai_strategy: string | null;
  value_proposition: string | null;
  campaign_overview: string | null;
  is_no_ai: boolean;
  is_front_end_offer: boolean;
  rank: number | null;
  status: "draft" | "approved" | "active" | "archived";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewCampaignStrategy {
  campaign_name: string;
  targeting_level?: string;
  list_filters?: string;
  ai_strategy?: string;
  value_proposition?: string;
  campaign_overview?: string;
  is_no_ai?: boolean;
  is_front_end_offer?: boolean;
  rank?: number;
  status?: "draft" | "approved" | "active" | "archived";
  notes?: string;
}

export async function insertCampaignStrategy(slug: string, strategy: NewCampaignStrategy): Promise<CampaignStrategyRow> {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_strategies")
    .insert({ client_id: clientId, ...strategy })
    .select()
    .single();
  if (error) throw new Error(`insertCampaignStrategy failed: ${error.message}`);
  return data as CampaignStrategyRow;
}

export async function listCampaignStrategies(slug: string): Promise<CampaignStrategyRow[]> {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_strategies")
    .select("*")
    .eq("client_id", clientId)
    .order("rank", { nullsFirst: false })
    .order("created_at");
  if (error) throw new Error(`listCampaignStrategies failed: ${error.message}`);
  return (data ?? []) as CampaignStrategyRow[];
}

export async function getCampaignStrategyById(
  id: string,
  clientId: string,
): Promise<CampaignStrategyRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("campaign_strategies")
    .select("*")
    .eq("id", id)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`getCampaignStrategyById failed: ${error.message}`);
  return data as CampaignStrategyRow | null;
}

export async function approveCampaignStrategy(id: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("campaign_strategies")
    .update({ status: "approved", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`approveCampaignStrategy failed: ${error.message}`);
}
