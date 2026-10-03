/**
 * Persistence layer for the `email_verifications` table — Stage 17.
 *
 * Stores third-party email deliverability results (Millionverifier, Enirchley).
 * A contact can have zero or more verification records; only the most recent
 * matters for eligibility decisions (see getLatestEmailVerification).
 *
 * ── Live schema (confirmed Stage 17 Step 0) ───────────────────────────────────
 *
 * is_valid:    BOOLEAN NULL — the eligibility gate. NULL = unknown result.
 * result:      TEXT NULL    — provider-specific detail string.
 * contact_id:  UUID NULL    — FK → contacts(id) ON DELETE CASCADE.
 * verified_at: TIMESTAMPTZ NULL — when the provider ran the check.
 *
 * There is NO `status` enum column. The documentation in 10-EMAIL-VERIFICATIONS.md
 * was speculative; `is_valid` (boolean) is the live truth.
 *
 * ── Eligibility semantics ─────────────────────────────────────────────────────
 *
 *   is_valid = true   → provider confirmed deliverable; gate passes (subject to staleness)
 *   is_valid = false  → provider confirmed invalid; HARD BLOCK — do not send
 *   is_valid = null   → unknown result; treated as unverified (contact.email_status fallback)
 *
 * See evaluateEmailGate() in src/lib/contact-eligibility.ts for full logic.
 *
 * ── Excluded by design (Stage 17) ────────────────────────────────────────────
 *
 * No writes to this table. No verification API calls. Read-only.
 */

import { getSupabaseAdmin } from "./supabase";

const TABLE = "email_verifications" as const;

// ── Domain type ───────────────────────────────────────────────────────────────

export interface EmailVerificationRow {
  id:         string;
  /**
   * FK → contacts(id) ON DELETE CASCADE.
   * Nullable per live schema — some rows may have been inserted without a contact link.
   */
  contactId:  string | null;
  /** The email address that was verified. NOT NULL. */
  email:      string;
  /**
   * Provider verdict.
   *   true  → deliverable
   *   false → invalid; do not send (HARD BLOCK in eligibility gate)
   *   null  → unknown / provider could not determine
   */
  isValid:    boolean | null;
  /**
   * Provider-specific detail. E.g. "ok", "invalid", "catch_all", "unknown".
   * Informational only — eligibility decisions use isValid (boolean), not this field.
   */
  result:     string | null;
  /** When the provider ran the check. Null when not recorded by the inserting system. */
  verifiedAt: string | null;
  createdAt:  string;
}

// ── Pure mapper ───────────────────────────────────────────────────────────────

export function fromEmailVerificationRow(row: Record<string, unknown>): EmailVerificationRow {
  return {
    id:         row.id          as string,
    contactId:  (row.contact_id  as string | null) ?? null,
    email:      row.email        as string,
    isValid:    (row.is_valid    as boolean | null) ?? null,
    result:     (row.result      as string | null) ?? null,
    verifiedAt: (row.verified_at as string | null) ?? null,
    createdAt:  row.created_at   as string,
  };
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/**
 * Returns the most recent verification record for a contact, or null if none exists.
 *
 * "Most recent" is determined by created_at DESC because verified_at is nullable
 * and may not be populated by all verification providers.
 *
 * Returns null when:
 *   - The contact has never been submitted for verification.
 *   - The contact_id FK was not set on the verification row.
 */
export async function getLatestEmailVerification(
  contactId: string,
): Promise<EmailVerificationRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(TABLE)
    .select("*")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`getLatestEmailVerification failed: ${error.message}`);
  if (!data) return null;
  return fromEmailVerificationRow(data as Record<string, unknown>);
}
