/**
 * Persistence helpers for Stage 23 tables.
 *
 * contact_intelligence          — campaign-agnostic, one row per (client, company, contact)
 * contact_campaign_relevance    — campaign-specific, one row per (client, company, contact, campaign_strategy)
 *
 * Both tables are created by migration 0018_contact_intelligence.sql.
 * Do NOT call these functions until that migration is applied.
 *
 * All writes use upsert on the named UNIQUE constraints to support idempotency.
 * Passing the same inputs twice produces one row (deterministic).
 *
 * PII note: raw job title is never passed to or stored by these functions.
 * title_classification JSONB contains only function/seniority/confidence.
 */

import { getSupabaseAdmin } from "./supabase";
import type {
  TitleClassification,
  ContactGateSnapshot,
  PersonRelevanceReason,
  PersonRelevanceEvidence,
  PersonRelevanceNarrative,
  ContactIntelligenceRow,
  ContactCampaignRelevanceRow,
} from "../domain/contact-intelligence-types";

// ── Row mappers ───────────────────────────────────────────────────────────────

function fromContactIntelligenceRow(row: Record<string, unknown>): ContactIntelligenceRow {
  return {
    id:                          row.id as string,
    clientId:                    row.client_id as string,
    companyId:                    row.company_id as string,
    contactId:                    row.contact_id as string,
    titleClassification:          (row.title_classification ?? null) as TitleClassification | null,
    gateSnapshot:                 (row.gate_snapshot ?? null) as ContactGateSnapshot | null,
    isContactReady:               (row.is_contact_ready ?? null) as boolean | null,
    contactReadinessAssessedAt:   (row.contact_readiness_assessed_at ?? null) as string | null,
    createdAt:                    row.created_at as string,
    updatedAt:                    row.updated_at as string,
  };
}

function fromContactCampaignRelevanceRow(row: Record<string, unknown>): ContactCampaignRelevanceRow {
  return {
    id:                  row.id as string,
    clientId:            row.client_id as string,
    companyId:            row.company_id as string,
    contactId:            row.contact_id as string,
    campaignStrategyId:   row.campaign_strategy_id as string,
    relevanceScore:       (row.relevance_score != null ? Number(row.relevance_score) : null),
    isPersonRelevant:     (row.is_person_relevant ?? null) as boolean | null,
    isPersonQualified:    (row.is_person_qualified ?? null) as boolean | null,
    relevanceReason:      (row.relevance_reason ?? null) as PersonRelevanceReason | null,
    evidence:             (row.evidence ?? null) as PersonRelevanceEvidence | null,
    narrative:            (row.narrative ?? null) as PersonRelevanceNarrative | null,
    scoringVersion:       (row.scoring_version ?? null) as string | null,
    relevanceAssessedAt:  (row.relevance_assessed_at ?? null) as string | null,
    createdAt:            row.created_at as string,
    updatedAt:            row.updated_at as string,
  };
}

// ── contact_intelligence reads ─────────────────────────────────────────────

/**
 * Get the contact_intelligence row for a specific (client, company, contact).
 * Returns null when the row doesn't exist yet (not yet assessed).
 */
export async function getContactIntelligence(
  clientId:  string,
  companyId:  string,
  contactId:  string,
): Promise<ContactIntelligenceRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("contact_intelligence")
    .select("*")
    .eq("client_id", clientId)
    .eq("company_id", companyId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (error) throw new Error(`getContactIntelligence failed: ${error.message}`);
  return data ? fromContactIntelligenceRow(data as Record<string, unknown>) : null;
}

/**
 * Get all contact_intelligence rows for a company (all contacts at that account).
 * Returns rows for all contacts regardless of readiness.
 */
export async function listContactIntelligenceForCompany(
  clientId:  string,
  companyId:  string,
): Promise<ContactIntelligenceRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("contact_intelligence")
    .select("*")
    .eq("client_id", clientId)
    .eq("company_id", companyId);
  if (error) throw new Error(`listContactIntelligenceForCompany failed: ${error.message}`);
  return (data ?? []).map((r) => fromContactIntelligenceRow(r as Record<string, unknown>));
}

// ── contact_intelligence writes ────────────────────────────────────────────

export interface UpsertContactIntelligenceInput {
  clientId:                   string;
  companyId:                   string;
  contactId:                   string;
  titleClassification:         TitleClassification | null;
  gateSnapshot:                ContactGateSnapshot | null;
  isContactReady:              boolean | null;
  contactReadinessAssessedAt:  string | null;
}

/**
 * Upsert a contact_intelligence row.
 *
 * Uses ON CONFLICT on the named unique constraint
 * contact_intelligence_client_company_contact_key.
 * Idempotent: calling twice with identical inputs produces one row.
 */
export async function upsertContactIntelligence(
  input: UpsertContactIntelligenceInput,
): Promise<ContactIntelligenceRow> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("contact_intelligence")
    .upsert(
      {
        client_id:                    input.clientId,
        company_id:                    input.companyId,
        contact_id:                    input.contactId,
        title_classification:          input.titleClassification,
        gate_snapshot:                 input.gateSnapshot,
        is_contact_ready:              input.isContactReady,
        contact_readiness_assessed_at: input.contactReadinessAssessedAt,
        updated_at:                    now,
      },
      {
        onConflict:          "client_id,company_id,contact_id",
        ignoreDuplicates:    false,
      },
    )
    .select()
    .single();
  if (error) throw new Error(`upsertContactIntelligence failed: ${error.message}`);
  return fromContactIntelligenceRow(data as Record<string, unknown>);
}

// ── contact_campaign_relevance reads ──────────────────────────────────────

/**
 * Get the contact_campaign_relevance row for a specific
 * (client, company, contact, campaign_strategy).
 * Returns null when not yet assessed.
 */
export async function getContactCampaignRelevance(
  clientId:           string,
  companyId:           string,
  contactId:           string,
  campaignStrategyId:  string,
): Promise<ContactCampaignRelevanceRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("contact_campaign_relevance")
    .select("*")
    .eq("client_id", clientId)
    .eq("company_id", companyId)
    .eq("contact_id", contactId)
    .eq("campaign_strategy_id", campaignStrategyId)
    .maybeSingle();
  if (error) throw new Error(`getContactCampaignRelevance failed: ${error.message}`);
  return data ? fromContactCampaignRelevanceRow(data as Record<string, unknown>) : null;
}

/**
 * Get all contact_campaign_relevance rows for a campaign.
 * Optionally filter to qualified-only contacts.
 */
export async function listContactCampaignRelevance(
  clientId:            string,
  campaignStrategyId:  string,
  options?: { qualifiedOnly?: boolean },
): Promise<ContactCampaignRelevanceRow[]> {
  let q = getSupabaseAdmin()
    .from("contact_campaign_relevance")
    .select("*")
    .eq("client_id", clientId)
    .eq("campaign_strategy_id", campaignStrategyId);
  if (options?.qualifiedOnly) {
    q = q.eq("is_person_qualified", true);
  }
  const { data, error } = await q;
  if (error) throw new Error(`listContactCampaignRelevance failed: ${error.message}`);
  return (data ?? []).map((r) => fromContactCampaignRelevanceRow(r as Record<string, unknown>));
}

/**
 * Get all contact_campaign_relevance rows for a company × campaign pair.
 * Used when assessing all contacts at an account for a specific campaign.
 */
export async function listContactCampaignRelevanceForCompany(
  clientId:            string,
  companyId:            string,
  campaignStrategyId:  string,
): Promise<ContactCampaignRelevanceRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("contact_campaign_relevance")
    .select("*")
    .eq("client_id", clientId)
    .eq("company_id", companyId)
    .eq("campaign_strategy_id", campaignStrategyId);
  if (error) throw new Error(`listContactCampaignRelevanceForCompany failed: ${error.message}`);
  return (data ?? []).map((r) => fromContactCampaignRelevanceRow(r as Record<string, unknown>));
}

// ── contact_campaign_relevance writes ─────────────────────────────────────

export interface UpsertContactCampaignRelevanceInput {
  clientId:            string;
  companyId:            string;
  contactId:            string;
  campaignStrategyId:  string;
  relevanceScore:       number | null;
  isPersonRelevant:     boolean | null;
  isPersonQualified:    boolean | null;
  relevanceReason:      PersonRelevanceReason | null;
  evidence:             PersonRelevanceEvidence | null;
  narrative:            PersonRelevanceNarrative | null;
  scoringVersion:       string | null;
  relevanceAssessedAt:  string | null;
}

/**
 * Upsert a contact_campaign_relevance row.
 *
 * Uses ON CONFLICT on the named unique constraint
 * contact_campaign_relevance_client_contact_campaign_key.
 * Idempotent: calling twice with identical inputs produces one row.
 */
export async function upsertContactCampaignRelevance(
  input: UpsertContactCampaignRelevanceInput,
): Promise<ContactCampaignRelevanceRow> {
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from("contact_campaign_relevance")
    .upsert(
      {
        client_id:             input.clientId,
        company_id:             input.companyId,
        contact_id:             input.contactId,
        campaign_strategy_id:  input.campaignStrategyId,
        relevance_score:        input.relevanceScore,
        is_person_relevant:     input.isPersonRelevant,
        is_person_qualified:    input.isPersonQualified,
        relevance_reason:       input.relevanceReason,
        evidence:               input.evidence,
        narrative:              input.narrative,
        scoring_version:        input.scoringVersion,
        relevance_assessed_at:  input.relevanceAssessedAt,
        updated_at:             now,
      },
      {
        onConflict:       "client_id,company_id,contact_id,campaign_strategy_id",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();
  if (error) throw new Error(`upsertContactCampaignRelevance failed: ${error.message}`);
  return fromContactCampaignRelevanceRow(data as Record<string, unknown>);
}
