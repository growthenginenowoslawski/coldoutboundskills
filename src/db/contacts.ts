/**
 * Persistence layer for the `contacts` table — Stage 17.
 *
 * Contacts are GLOBAL — there is no client_id column. The same person can
 * be targeted by multiple clients. Client-specific restrictions live in
 * contact_suppression (per client) and campaign_leads (per campaign).
 *
 * ── Dedup constraint ─────────────────────────────────────────────────────────
 *
 * contacts.email has a UNIQUE constraint (`contacts_email_key`). One email
 * address = one contact globally. The dedup key is email, not linkedin_url
 * (live schema fact confirmed Stage 17 Step 0).
 *
 * contacts.email is nullable. Multiple contacts can have email = NULL
 * (NULL != NULL in SQL, so the UNIQUE constraint is not violated).
 *
 * ── No list_id column ─────────────────────────────────────────────────────────
 *
 * Despite some documentation, the live contacts table does NOT have a list_id
 * column. List membership is tracked exclusively via the list_members junction
 * table. (Live schema correction confirmed Stage 16 design report.)
 *
 * ── Excluded by design (Stage 17) ────────────────────────────────────────────
 *
 * No contact writes. No list_members writes. No campaign_leads writes.
 * This module is read-only for Stage 17 eligibility evaluation.
 */

import { getSupabaseAdmin } from "./supabase";

const TABLE = "contacts" as const;

// ── Domain type ───────────────────────────────────────────────────────────────

export interface ContactRow {
  id:          string;
  /** FK → companies(id) ON DELETE CASCADE. NOT NULL — every contact has a company. */
  companyId:   string;
  firstName:   string | null;
  lastName:    string | null;
  fullName:    string | null;
  jobTitle:    string | null;
  linkedinUrl: string | null;
  /**
   * Primary email address. UNIQUE globally (contacts_email_key constraint).
   * Nullable — a contact can exist without a confirmed email address.
   * A null email means the contact CANNOT be enrolled in any campaign.
   */
  email:       string | null;
  /**
   * Prospeo's confidence label for the email address.
   * Known value: 'VERIFIED' — Prospeo confirmed this email is valid.
   * Null when email was not sourced or confirmed by Prospeo.
   * Used as a soft-pass for the email gate when no email_verifications row exists.
   */
  emailStatus: string | null;
  /**
   * Lifecycle status. DB default: 'test'. Live data: mostly 'review'.
   * CHECK constraint allows: review, approved, rejected (and 'test' in schema).
   * Not used by the eligibility evaluator — the account intelligence score
   * and suppression state are the authoritative eligibility gates.
   */
  status:      string;
  source:      string | null;
  createdAt:   string;
}

// ── Pure mapper ───────────────────────────────────────────────────────────────

export function fromContactRow(row: Record<string, unknown>): ContactRow {
  return {
    id:          row.id          as string,
    companyId:   row.company_id  as string,
    firstName:   (row.first_name  as string | null) ?? null,
    lastName:    (row.last_name   as string | null) ?? null,
    fullName:    (row.full_name   as string | null) ?? null,
    jobTitle:    (row.job_title   as string | null) ?? null,
    linkedinUrl: (row.linkedin_url as string | null) ?? null,
    email:       (row.email       as string | null) ?? null,
    emailStatus: (row.email_status as string | null) ?? null,
    status:      row.status       as string,
    source:      (row.source      as string | null) ?? null,
    createdAt:   row.created_at   as string,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Fetch a contact by ID.
 * Returns null when the ID does not match any row.
 *
 * No client_id filter — contacts is a global table.
 * Client-specific restrictions are evaluated separately via suppression/campaign gates.
 */
export async function getContactById(contactId: string): Promise<ContactRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("id", contactId)
    .maybeSingle();

  if (error) throw new Error(`getContactById failed: ${error.message}`);
  if (!data) return null;
  return fromContactRow(data as Record<string, unknown>);
}

/**
 * Batch-fetch contacts by a set of IDs.
 * Returns a Map<contactId, ContactRow>.
 * IDs with no matching row are absent from the map.
 *
 * No client_id filter — contacts is global.
 * Used by Stage 19B enrollment to re-validate contacts at write time.
 */
export async function getContactsByIds(
  contactIds: string[],
): Promise<Map<string, ContactRow>> {
  if (contactIds.length === 0) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .in("id", contactIds);

  if (error) throw new Error(`getContactsByIds failed: ${error.message}`);
  const result = new Map<string, ContactRow>();
  for (const row of (data as Record<string, unknown>[] ?? [])) {
    const c = fromContactRow(row);
    result.set(c.id, c);
  }
  return result;
}

/**
 * Fetch all contacts at a given company.
 * Results are ordered by created_at ASC (insertion order).
 *
 * No client_id filter — contacts is global.
 * A company can have contacts sourced by different clients.
 */
export async function getContactsByCompanyId(companyId: string): Promise<ContactRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`getContactsByCompanyId failed: ${error.message}`);
  return (data as Record<string, unknown>[]).map(fromContactRow);
}
