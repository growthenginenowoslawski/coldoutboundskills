/**
 * Contact eligibility evaluation — Stage 17.
 *
 * A PURE, deterministic function-set. No I/O. All input is passed in;
 * callers are responsible for fetching the DB rows before calling these functions.
 *
 * ── Four-gate model ───────────────────────────────────────────────────────────
 *
 * Gates are evaluated in strict order. The first failure short-circuits:
 *
 *   1. ACCOUNT GATE   — Is this company worth pursuing for this client?
 *                       Requires a non-zero opportunity score in account_intelligence.
 *
 *   2. CONTACT GATE   — Does this contact have the identity info needed?
 *                       Requires: non-null email, correct company link.
 *
 *   3. EMAIL GATE     — Is the email address likely deliverable?
 *                       Requires: verification result or Prospeo soft-pass.
 *
 *   4. SUPPRESSION GATE — Has this client blocked this contact?
 *                       A hard block — AI cannot override.
 *
 * An optional 5th gate (CAMPAIGN GATE) is evaluated when a specific campaign
 * enrollment is being checked. See evaluateCampaignEligibility().
 *
 * ── Threshold labelling ───────────────────────────────────────────────────────
 *
 * Any threshold that has not been validated against campaign outcome data is
 * labelled INITIAL_HYPOTHESIS_NOT_VALIDATED. These will be tuned once
 * send/reply data accumulates.
 *
 * ── What this module does NOT do ─────────────────────────────────────────────
 *
 * - No DB reads (caller provides all rows)
 * - No campaign_leads writes (enrollment is Stage 18+)
 * - No account_intelligence writes
 * - No suppression record creation
 * - No cached/materialized eligibility — evaluated fresh on every call
 */

import type { AccountIntelligenceRow } from "../db/account-intelligence";
import type { ContactRow } from "../db/contacts";
import type { EmailVerificationRow } from "../db/email-verifications";
import { isContactSuppressedFromRecords } from "../db/contact-suppression";
import type { ContactSuppressionRow } from "../db/contact-suppression";
import type { CampaignRow } from "../db/campaigns";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * How old an email verification can be before it is considered stale.
 * After this many days, is_valid = true is no longer trusted and the gate
 * returns EMAIL_VERIFICATION_STALE.
 *
 * INITIAL_HYPOTHESIS_NOT_VALIDATED — no campaign outcome data yet.
 * Email addresses churn: people change jobs, domains expire. 90 days is a
 * conservative starting point, not a validated deliverability threshold.
 */
export const EMAIL_VERIFICATION_STALENESS_DAYS = 90;

// ── Result types ──────────────────────────────────────────────────────────────

export type EligibilityGate =
  | "account"
  | "contact"
  | "email"
  | "suppression"
  | "campaign";

export type EligibilityReason =
  // Account gate
  | "NO_ACCOUNT_INTELLIGENCE"
  | "ACCOUNT_SCORE_ZERO"
  // Contact gate
  | "CONTACT_NOT_FOUND"
  | "NO_EMAIL"
  | "CONTACT_COMPANY_MISMATCH"
  // Email gate
  | "EMAIL_NOT_VERIFIED"
  | "EMAIL_INVALID"
  | "EMAIL_VERIFICATION_STALE"
  // Suppression gate
  | "CONTACT_SUPPRESSED"
  // Campaign gate
  | "CAMPAIGN_NOT_FOUND"
  | "CAMPAIGN_CLIENT_MISMATCH"
  | "CAMPAIGN_NOT_ACTIVE"
  | "ALREADY_ENROLLED";

export interface EligibilityResult {
  eligible: boolean;
  /** Null when eligible = true. Machine-readable reason for the caller. */
  reason:   EligibilityReason | null;
  /** Which gate produced this result. Null when eligible = true. */
  gate:     EligibilityGate | null;
  /** Human-readable explanation. Always set. */
  detail:   string;
}

// ── Shared result constants ───────────────────────────────────────────────────

const ELIGIBLE: EligibilityResult = {
  eligible: true,
  reason:   null,
  gate:     null,
  detail:   "Contact is eligible for outreach.",
};

function blocked(
  gate:   EligibilityGate,
  reason: EligibilityReason,
  detail: string,
): EligibilityResult {
  return { eligible: false, reason, gate, detail };
}

// ── Gate 1: Account ───────────────────────────────────────────────────────────

/**
 * Evaluates whether the account (company) has sufficient intelligence to
 * justify outreach by this client.
 *
 * Pass condition: account_intelligence exists AND opportunity_score > 0.
 *
 * opportunity_score = 0 means no active signals have been scored for this
 * company. It does NOT mean the company is bad — it means there is no
 * signal-backed reason to prioritise them right now.
 *
 * A minimum score threshold above 0 (e.g. ≥ 20) is INITIAL_HYPOTHESIS_NOT_VALIDATED.
 * Only zero is used as the gate condition until outcome data validates a higher floor.
 */
export function evaluateAccountGate(
  accountIntelligence: Pick<AccountIntelligenceRow, "opportunityScore"> | null,
): EligibilityResult {
  if (accountIntelligence === null) {
    return blocked(
      "account",
      "NO_ACCOUNT_INTELLIGENCE",
      "No account intelligence row for this (client, company) pair. Run account prioritisation first.",
    );
  }
  if (accountIntelligence.opportunityScore === 0) {
    return blocked(
      "account",
      "ACCOUNT_SCORE_ZERO",
      "Account opportunity score is 0 — no active signals. Company not currently prioritised.",
    );
  }
  return ELIGIBLE;
}

// ── Gate 2: Contact ───────────────────────────────────────────────────────────

/**
 * Evaluates whether the contact has the identity information required for
 * outreach: a non-empty email address and correct company linkage.
 *
 * Pass condition: contact exists, contact.email is non-empty, contact.companyId
 * matches the company being evaluated.
 *
 * The company mismatch check is a data-integrity guard. It catches cases where
 * a contact was sourced for company A but is being evaluated for company B —
 * this should not happen in normal flows but is checked defensively.
 */
export function evaluateContactGate(
  contact:   Pick<ContactRow, "companyId" | "email"> | null,
  companyId: string,
): EligibilityResult {
  if (contact === null) {
    return blocked("contact", "CONTACT_NOT_FOUND", "Contact ID does not exist in the contacts table.");
  }
  if (!contact.email || contact.email.trim() === "") {
    return blocked("contact", "NO_EMAIL", "Contact has no email address on file.");
  }
  if (contact.companyId !== companyId) {
    return blocked(
      "contact",
      "CONTACT_COMPANY_MISMATCH",
      `Contact's company (${contact.companyId}) does not match the target company (${companyId}).`,
    );
  }
  return ELIGIBLE;
}

// ── Gate 3: Email verification ────────────────────────────────────────────────

/**
 * Evaluates whether the contact's email address is likely deliverable.
 *
 * Decision tree (evaluated top-to-bottom):
 *
 *   1. emailVerification.isValid = false  → EMAIL_INVALID (hard block, no override)
 *   2. emailVerification.isValid = true   → check staleness
 *        stale (verified_at > 90 days ago) → EMAIL_VERIFICATION_STALE
 *        fresh (or no verified_at)         → PASS
 *   3. emailVerification.isValid = null   → unknown result
 *        contact.emailStatus = 'VERIFIED' → PASS (Prospeo soft-pass)
 *        otherwise                        → EMAIL_NOT_VERIFIED
 *   4. emailVerification = null           → no row at all
 *        contact.emailStatus = 'VERIFIED' → PASS (Prospeo soft-pass)
 *        otherwise                        → EMAIL_NOT_VERIFIED
 *
 * "Prospeo soft-pass": email_status = 'VERIFIED' is set by the Prospeo data
 * pipeline at the time of contact sourcing. It's an early-stage verification
 * signal, not a full deliverability check, but it's better than no signal.
 */
export function evaluateEmailGate(
  contact:           Pick<ContactRow, "emailStatus">,
  emailVerification: EmailVerificationRow | null,
  now:               Date = new Date(),
): EligibilityResult {
  if (emailVerification !== null) {
    if (emailVerification.isValid === false) {
      return blocked(
        "email",
        "EMAIL_INVALID",
        `Email marked invalid by verification provider.${emailVerification.result ? ` Detail: ${emailVerification.result}` : ""}`,
      );
    }
    if (emailVerification.isValid === true) {
      if (isEmailVerificationStale(emailVerification.verifiedAt, now)) {
        return blocked(
          "email",
          "EMAIL_VERIFICATION_STALE",
          `Email verification is older than ${EMAIL_VERIFICATION_STALENESS_DAYS} days (verified_at: ${emailVerification.verifiedAt}). Re-verify before sending. — INITIAL_HYPOTHESIS_NOT_VALIDATED threshold`,
        );
      }
      return ELIGIBLE;
    }
    // isValid === null: unknown result — fall through to email_status check
  }

  // No verification row, or isValid === null: use Prospeo email_status as fallback
  if (contact.emailStatus === "VERIFIED") {
    return ELIGIBLE;
  }

  return blocked(
    "email",
    "EMAIL_NOT_VERIFIED",
    "No valid email verification on file and email_status is not 'VERIFIED'. Run email verification before enrolling.",
  );
}

// ── Gate 4: Suppression ───────────────────────────────────────────────────────

/**
 * Evaluates whether the contact is suppressed from outreach by this client.
 *
 * Delegates to isContactSuppressedFromRecords() which implements the temporal
 * suppression semantics:
 *   expires_at IS NULL  → permanent block
 *   expires_at > now()  → timed active block
 *   expires_at <= now() → historical only, does NOT block
 *
 * This gate is a HARD BLOCK. AI reasoning cannot override a suppression record.
 * Suppression must be lifted via liftSuppression() in src/db/contact-suppression.ts
 * before the contact becomes eligible again.
 *
 * @param suppressionRecords  All contact_suppression rows for (clientId, contactId).
 *                            Pass an empty array when no records exist.
 */
export function evaluateSuppressionGate(
  suppressionRecords: Pick<ContactSuppressionRow, "expiresAt">[],
  now: Date = new Date(),
): EligibilityResult {
  if (isContactSuppressedFromRecords(suppressionRecords, now)) {
    return blocked(
      "suppression",
      "CONTACT_SUPPRESSED",
      "Contact has an active suppression record for this client. Lift the suppression to re-enable eligibility.",
    );
  }
  return ELIGIBLE;
}

// ── Gate 5: Campaign enrollment ───────────────────────────────────────────────

/**
 * Evaluates whether the contact can be enrolled in a specific campaign.
 *
 * Conditions that block enrollment:
 *   - Campaign does not exist (CAMPAIGN_NOT_FOUND)
 *   - Campaign belongs to a different client (CAMPAIGN_CLIENT_MISMATCH — data integrity)
 *   - Campaign is not in a state that accepts new enrollments (CAMPAIGN_NOT_ACTIVE)
 *   - Contact is already enrolled (ALREADY_ENROLLED)
 *
 * Permitted campaign statuses: 'draft' and 'running'.
 *   draft   → campaign is being built; pre-enrollment is allowed (leads will be
 *              sent when the campaign is activated by the user)
 *   running → campaign is live and accepting new leads
 *
 * Blocked statuses: 'review', 'ready', 'paused', 'completed', 'cancelled'.
 *   These campaigns are not accepting new enrollments.
 *
 * Live DB CHECK constraint (Stage 18 correction):
 *   draft | review | ready | running | paused | completed | cancelled
 *   ("active" and "archived" are NOT valid DB values — corrected from Stage 15 TypeScript type)
 *
 * @param existingEnrollment  True when a campaign_leads row already exists for
 *                             (campaignId, contactId). Caller must check this.
 */
export function evaluateCampaignGate(
  campaign:           Pick<CampaignRow, "clientId" | "status"> | null,
  clientId:           string,
  existingEnrollment: boolean,
): EligibilityResult {
  if (campaign === null) {
    return blocked("campaign", "CAMPAIGN_NOT_FOUND", "Campaign ID does not exist.");
  }
  if (campaign.clientId !== clientId) {
    return blocked(
      "campaign",
      "CAMPAIGN_CLIENT_MISMATCH",
      `Campaign belongs to client ${campaign.clientId}, not ${clientId}.`,
    );
  }

  const activatable: readonly CampaignRow["status"][] = ["draft", "running"];
  if (!activatable.includes(campaign.status as CampaignRow["status"])) {
    return blocked(
      "campaign",
      "CAMPAIGN_NOT_ACTIVE",
      `Campaign status '${campaign.status}' does not accept new enrollments. Must be 'draft' or 'active'.`,
    );
  }

  if (existingEnrollment) {
    return blocked(
      "campaign",
      "ALREADY_ENROLLED",
      "Contact is already enrolled in this campaign.",
    );
  }

  return ELIGIBLE;
}

// ── Orchestrated evaluators ───────────────────────────────────────────────────

/**
 * Evaluates all 4 eligibility gates for a contact in order.
 * The first failing gate short-circuits evaluation.
 *
 * Use this to answer: "Can this contact be outreached by this client at all?"
 * For campaign-specific enrollment, use evaluateCampaignEligibility().
 */
export function evaluateContactEligibility(input: {
  accountIntelligence: Pick<AccountIntelligenceRow, "opportunityScore"> | null;
  contact:             Pick<ContactRow, "companyId" | "email" | "emailStatus"> | null;
  companyId:           string;
  emailVerification:   EmailVerificationRow | null;
  suppressionRecords:  Pick<ContactSuppressionRow, "expiresAt">[];
  now?:                Date;
}): EligibilityResult {
  const now = input.now ?? new Date();

  const accountResult = evaluateAccountGate(input.accountIntelligence);
  if (!accountResult.eligible) return accountResult;

  const contactResult = evaluateContactGate(input.contact, input.companyId);
  if (!contactResult.eligible) return contactResult;

  // After contact gate passes, contact is guaranteed non-null and email is non-null.
  const emailResult = evaluateEmailGate(input.contact!, input.emailVerification, now);
  if (!emailResult.eligible) return emailResult;

  const suppressionResult = evaluateSuppressionGate(input.suppressionRecords, now);
  if (!suppressionResult.eligible) return suppressionResult;

  return ELIGIBLE;
}

/**
 * Evaluates all 5 eligibility gates, including the campaign gate.
 *
 * Use this to answer: "Can this contact be enrolled in THIS campaign?"
 * Builds on evaluateContactEligibility() then adds the campaign gate.
 */
export function evaluateCampaignEligibility(input: {
  accountIntelligence: Pick<AccountIntelligenceRow, "opportunityScore"> | null;
  contact:             Pick<ContactRow, "companyId" | "email" | "emailStatus"> | null;
  companyId:           string;
  emailVerification:   EmailVerificationRow | null;
  suppressionRecords:  Pick<ContactSuppressionRow, "expiresAt">[];
  campaign:            Pick<CampaignRow, "clientId" | "status"> | null;
  clientId:            string;
  existingEnrollment:  boolean;
  now?:                Date;
}): EligibilityResult {
  const contactResult = evaluateContactEligibility({
    accountIntelligence: input.accountIntelligence,
    contact:             input.contact,
    companyId:           input.companyId,
    emailVerification:   input.emailVerification,
    suppressionRecords:  input.suppressionRecords,
    now:                 input.now,
  });
  if (!contactResult.eligible) return contactResult;

  return evaluateCampaignGate(input.campaign, input.clientId, input.existingEnrollment);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function isEmailVerificationStale(verifiedAt: string | null, now: Date): boolean {
  if (verifiedAt === null) return false; // no timestamp — give benefit of the doubt
  const staleAfterMs = EMAIL_VERIFICATION_STALENESS_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() - new Date(verifiedAt).getTime() > staleAfterMs;
}
