/**
 * CRUD helpers for the lead_magnets table.
 * One row per brainstormed magnet idea per client.
 */
import { getSupabaseAdmin } from "./supabase";
import { getClientIdBySlug } from "./onboarding";

export interface LeadMagnetRow {
  id: string;
  client_id: string;
  archetype_key: string;
  name: string;
  description: string | null;
  delivery_notes: string | null;
  cta_example: string | null;
  score: number | null;
  rank: number | null;
  status: "draft" | "selected" | "rejected";
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewLeadMagnet {
  archetype_key: string;
  name: string;
  description?: string;
  delivery_notes?: string;
  cta_example?: string;
  score?: number;
  rank?: number;
  status?: "draft" | "selected" | "rejected";
  notes?: string;
}

export async function insertLeadMagnet(slug: string, magnet: NewLeadMagnet): Promise<LeadMagnetRow> {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("lead_magnets")
    .insert({ client_id: clientId, ...magnet })
    .select()
    .single();
  if (error) throw new Error(`insertLeadMagnet failed: ${error.message}`);
  return data as LeadMagnetRow;
}

export async function listLeadMagnets(slug: string): Promise<LeadMagnetRow[]> {
  const clientId = await getClientIdBySlug(slug);
  if (!clientId) throw new Error(`no client with slug "${slug}"`);
  const { data, error } = await getSupabaseAdmin()
    .from("lead_magnets")
    .select("*")
    .eq("client_id", clientId)
    .order("rank", { nullsFirst: false })
    .order("score", { ascending: false });
  if (error) throw new Error(`listLeadMagnets failed: ${error.message}`);
  return (data ?? []) as LeadMagnetRow[];
}

export async function selectLeadMagnet(id: string): Promise<void> {
  const db = getSupabaseAdmin();
  const { data: row } = await db.from("lead_magnets").select("client_id").eq("id", id).single();
  if (!row) throw new Error(`lead magnet ${id} not found`);
  await db.from("lead_magnets").update({ status: "rejected", updated_at: new Date().toISOString() })
    .eq("client_id", (row as { client_id: string }).client_id).neq("id", id);
  const { error } = await db.from("lead_magnets")
    .update({ status: "selected", updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(`selectLeadMagnet failed: ${error.message}`);
}
