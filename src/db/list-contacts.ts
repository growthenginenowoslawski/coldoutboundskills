/**
 * Batched DB read helpers for resolving contacts reachable from a campaign's list — Stage 19A.
 *
 * ── FINDING 5: lists have no client_id ────────────────────────────────────────
 *
 * The lists and list_members tables have no client_id column. These functions are
 * deliberately unscoped by client — the only available scope is the listId itself,
 * which comes from the campaign record (campaigns.list_id is client-scoped). There
 * is no DB-level guarantee that the list was built for the same client as the campaign.
 *
 * This is an active multi-tenant isolation gap documented in
 * docs/supabase/25-SUPABASE-SECURITY.md as FINDING 5. It is NOT resolved here.
 * The caller (assessCampaignLeadSupply) surfaces this via LeadSupplyReport.listClientWarning.
 *
 * ── All functions are read-only ───────────────────────────────────────────────
 *
 * No writes to any table. No campaign_leads writes. No email sends.
 *
 * ── Batching design ───────────────────────────────────────────────────────────
 *
 * Each function is one DB round-trip (IN clause) regardless of set size.
 * Together they enable the orchestrator to assess any list size in ~10 queries.
 * No N+1 patterns.
 */

import { getSupabaseAdmin } from "./supabase";
import { fromContactRow } from "./contacts";
import type { ContactRow } from "./contacts";
import { fromAccountIntelligenceRow } from "./account-intelligence";
import type { AccountIntelligenceRow } from "./account-intelligence";
import { fromEmailVerificationRow } from "./email-verifications";
import type { EmailVerificationRow } from "./email-verifications";
import { fromContactSuppressionRow } from "./contact-suppression";
import type { ContactSuppressionRow } from "./contact-suppression";

// ── Contact resolution ────────────────────────────────────────────────────────

/**
 * Returns all unique contacts reachable from a list, via two paths:
 *
 *   Path A: list_members WHERE company_id IS NOT NULL
 *           → contacts WHERE company_id IN (those company IDs)
 *
 *   Path B: list_members WHERE contact_id IS NOT NULL
 *           → contacts WHERE id IN (those contact IDs)
 *
 * Both paths are union-merged. Contacts appearing through both paths are
 * deduplicated by contact.id (a Map keyed by id). A contact fetched via
 * Path A is not re-fetched by Path B even if it is also a direct member.
 *
 * Returns [] when the list has no members or no reachable contacts.
 *
 * ── FINDING 5 reminder ────────────────────────────────────────────────────────
 * This function has no client_id parameter — lists are global infrastructure.
 * Cross-client contamination is possible if the campaign's list_id was assigned
 * to a list built for another client. See 25-SUPABASE-SECURITY.md FINDING 5.
 */
export async function getContactsForList(listId: string): Promise<ContactRow[]> {
  const db = getSupabaseAdmin();

  // One query: all list_members for this list (company_id and contact_id columns)
  const { data: members, error: memberErr } = await db
    .from("list_members")
    .select("company_id, contact_id")
    .eq("list_id", listId);

  if (memberErr) throw new Error(`getContactsForList(members) failed: ${memberErr.message}`);
  if (!members || (members as unknown[]).length === 0) return [];

  type MemberRow = { company_id: string | null; contact_id: string | null };
  const rows = members as MemberRow[];

  const companyIds = [...new Set(
    rows.filter((r) => r.company_id != null).map((r) => r.company_id as string),
  )];
  const directContactIds = [...new Set(
    rows.filter((r) => r.contact_id != null).map((r) => r.contact_id as string),
  )];

  // Use a Map to deduplicate by contact.id across both paths
  const contactMap = new Map<string, ContactRow>();

  // Path A: company → contacts
  if (companyIds.length > 0) {
    const { data: companyContacts, error: ccErr } = await db
      .from("contacts")
      .select("*")
      .in("company_id", companyIds);

    if (ccErr) throw new Error(`getContactsForList(path-A) failed: ${ccErr.message}`);
    for (const row of (companyContacts as Record<string, unknown>[] ?? [])) {
      const c = fromContactRow(row);
      contactMap.set(c.id, c);
    }
  }

  // Path B: direct contact members
  if (directContactIds.length > 0) {
    const { data: directContacts, error: dcErr } = await db
      .from("contacts")
      .select("*")
      .in("id", directContactIds);

    if (dcErr) throw new Error(`getContactsForList(path-B) failed: ${dcErr.message}`);
    for (const row of (directContacts as Record<string, unknown>[] ?? [])) {
      const c = fromContactRow(row);
      // contactMap.set is idempotent for contacts already fetched via Path A
      contactMap.set(c.id, c);
    }
  }

  return [...contactMap.values()];
}

// ── Batched supporting data ───────────────────────────────────────────────────

/**
 * Batched: fetch account_intelligence rows for a set of companies under a client.
 * Returns a Map<companyId, AccountIntelligenceRow>.
 *
 * Companies with no AI row for this client are absent from the map.
 * The caller treats absent entries as null → NO_ACCOUNT_INTELLIGENCE or ACCOUNT_SCORE_ZERO.
 *
 * Client isolation: .eq("client_id") ensures only this client's intelligence is returned.
 */
export async function getAccountIntelligenceMap(
  clientId:   string,
  companyIds: string[],
): Promise<Map<string, AccountIntelligenceRow>> {
  if (companyIds.length === 0) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from("account_intelligence")
    .select("*")
    .eq("client_id", clientId)
    .in("company_id", companyIds);

  if (error) throw new Error(`getAccountIntelligenceMap failed: ${error.message}`);

  const result = new Map<string, AccountIntelligenceRow>();
  for (const row of (data as Record<string, unknown>[] ?? [])) {
    const ai = fromAccountIntelligenceRow(row);
    result.set(ai.companyId, ai);
  }
  return result;
}

/**
 * Batched: fetch the most recent email_verification for each contact in the set.
 * Returns a Map<contactId, EmailVerificationRow>.
 *
 * Strategy: one query fetching all rows WHERE contact_id IN (...) ORDER BY created_at DESC,
 * then pick the first-seen per contactId in memory (ordered DESC means first = most recent).
 *
 * Contacts with no verification row are absent from the map → null in eligibility check,
 * which triggers the Prospeo soft-pass fallback (emailStatus='VERIFIED').
 *
 * Rows where contact_id IS NULL (some legacy email_verification rows) are naturally
 * excluded because the IN clause only matches non-null contact_id values.
 */
export async function getLatestEmailVerificationMap(
  contactIds: string[],
): Promise<Map<string, EmailVerificationRow>> {
  if (contactIds.length === 0) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from("email_verifications")
    .select("*")
    .in("contact_id", contactIds)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getLatestEmailVerificationMap failed: ${error.message}`);

  const result = new Map<string, EmailVerificationRow>();
  for (const row of (data as Record<string, unknown>[] ?? [])) {
    const ev = fromEmailVerificationRow(row);
    // First-seen wins because results are ORDER BY created_at DESC
    if (ev.contactId && !result.has(ev.contactId)) {
      result.set(ev.contactId, ev);
    }
  }
  return result;
}

/**
 * Batched: fetch all contact_suppression records for a set of contacts under a client.
 * Returns a Map<contactId, ContactSuppressionRow[]>.
 *
 * Contacts with no suppression records are absent from the map.
 * The caller treats absent entries as [] → no suppression → gate passes.
 *
 * Returns both active and historical records. The eligibility evaluator
 * (isContactSuppressedFromRecords) applies the temporal semantics:
 *   expires_at IS NULL → permanent block
 *   expires_at > now   → timed active block
 *   expires_at ≤ now   → historical, does NOT block
 *
 * Client isolation: .eq("client_id") ensures only this client's suppressions are returned.
 */
export async function getSuppressionMap(
  clientId:   string,
  contactIds: string[],
): Promise<Map<string, ContactSuppressionRow[]>> {
  if (contactIds.length === 0) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from("contact_suppression")
    .select("*")
    .eq("client_id", clientId)
    .in("contact_id", contactIds)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`getSuppressionMap failed: ${error.message}`);

  const result = new Map<string, ContactSuppressionRow[]>();
  for (const row of (data as Record<string, unknown>[] ?? [])) {
    const s = fromContactSuppressionRow(row);
    const existing = result.get(s.contactId) ?? [];
    existing.push(s);
    result.set(s.contactId, existing);
  }
  return result;
}

/**
 * Batched: returns the set of contactIds already enrolled in a campaign.
 *
 * READ ONLY — no writes to campaign_leads. Stage 19A uses this to check the
 * ALREADY_ENROLLED gate without performing enrollment. Actual writes are Stage 19B+.
 *
 * A contact is considered enrolled if ANY campaign_leads row exists for
 * (campaign_id, contact_id) regardless of the lead's status column.
 */
export async function getEnrolledContactIds(
  campaignId: string,
  contactIds: string[],
): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set();

  const { data, error } = await getSupabaseAdmin()
    .from("campaign_leads")
    .select("contact_id")
    .eq("campaign_id", campaignId)
    .in("contact_id", contactIds);

  if (error) throw new Error(`getEnrolledContactIds failed: ${error.message}`);

  const result = new Set<string>();
  for (const row of (data as { contact_id: string }[] ?? [])) {
    result.add(row.contact_id);
  }
  return result;
}
