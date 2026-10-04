/**
 * Stage 21A — platform_lead_id backfill.
 *
 * Matches campaign_leads rows (status='uploaded') against the Smartlead
 * campaign roster, and writes campaign_lead_map_id → platform_lead_id for
 * any row where that value is missing or differs.
 *
 * ── What this does ────────────────────────────────────────────────────────────
 *
 * 1. Reads campaign_leads rows with status='uploaded' for the given campaign.
 * 2. Loads contact emails for those rows (batched read — no N+1).
 * 3. Fetches all leads from the Smartlead campaign via paginated GET.
 * 4. Matches by normalized email (lowercase + trim).
 * 5. For each matched row where platform_lead_id is null or differs:
 *      writes platform_lead_id = campaign_lead_map_id, advances updated_at.
 * 6. For each matched row where platform_lead_id already equals campaign_lead_map_id:
 *      skips — no write, updated_at not advanced.
 *
 * ── What this does NOT do ─────────────────────────────────────────────────────
 *
 *  - Does not activate the Smartlead campaign.
 *  - Does not send email.
 *  - Does not update status, sent_at, replied_at, or reply_type.
 *  - Does not create campaign_leads rows.
 *  - Does not map Smartlead status strings (Stage 21B — unconfirmed values).
 *  - Does not make POST/PUT/PATCH/DELETE calls to Smartlead.
 *
 * ── Preconditions ─────────────────────────────────────────────────────────────
 *
 * Campaign must: exist, belong to clientId, use platform='smartlead', have a
 * non-null platform_campaign_id. No status restriction (unlike Stage 20 upload
 * which requires status='draft').
 *
 * ── Idempotency ───────────────────────────────────────────────────────────────
 *
 * Running twice is safe. Rows already having the correct platform_lead_id are
 * skipped (rowsSkipped increments). Rows with a different value are corrected.
 */

import { getCampaignById }           from "../db/campaigns.js";
import type { CampaignRow }          from "../db/campaigns.js";
import {
  getUploadedLeads,
  updateLeadPlatformId,
}                                    from "../db/campaign-leads.js";
import { getContactsByIds }          from "../db/contacts.js";
import { OutreachProviderRegistry }  from "../providers/outreach/registry.js";
import type { CampaignLeadRecord }   from "../providers/outreach/types.js";

// ── Input / output types ──────────────────────────────────────────────────────

export interface BackfillInput {
  clientId:   string;
  campaignId: string;
}

export interface BackfillResult {
  campaignId:         string;
  clientId:           string;
  startedAt:          string; // ISO 8601
  completedAt:        string; // ISO 8601
  elapsedMs:          number;
  /** Leads returned by Smartlead GET (after skipping unparseable items). */
  slLeadsDiscovered:  number;
  /** campaign_leads rows with status='uploaded' that were checked. */
  dbRowsProcessed:    number;
  /** Rows where platform_lead_id was written (null or mismatched). */
  rowsUpdated:        number;
  /** Rows where platform_lead_id already matched — no write. */
  rowsSkipped:        number;
  /** DB rows whose contact email was not found in the Smartlead roster. */
  rowsUnmatched:      number;
  /** Smartlead leads whose email was not found in any uploaded DB row. */
  slLeadsUnmatched:   number;
}

/** Minimal provider interface required by the orchestrator. Allows test injection. */
export interface LeadBackfillProvider {
  getCampaignLeads(platformCampaignId: string): Promise<CampaignLeadRecord[]>;
}

// ── Pure functions ─────────────────────────────────────────────────────────────

/**
 * Validate campaign-level preconditions for the backfill.
 * Less restrictive than validateUploadPreconditions: no status requirement.
 */
export function validateBackfillPreconditions(
  campaign: CampaignRow | null,
  clientId:  string,
): { ok: true } | { ok: false; reason: string; detail: string } {
  if (!campaign) {
    return { ok: false, reason: "CAMPAIGN_NOT_FOUND", detail: "Campaign not found for this client." };
  }
  if (campaign.clientId !== clientId) {
    return {
      ok:     false,
      reason: "CAMPAIGN_CLIENT_MISMATCH",
      detail: `Campaign belongs to client ${campaign.clientId}, not ${clientId}.`,
    };
  }
  if (campaign.platform !== "smartlead") {
    return {
      ok:     false,
      reason: "CAMPAIGN_PLATFORM_UNSUPPORTED",
      detail: `Campaign platform '${campaign.platform}' is not supported. Stage 21A requires platform='smartlead'.`,
    };
  }
  if (!campaign.platformCampaignId) {
    return {
      ok:     false,
      reason: "CAMPAIGN_MISSING_PLATFORM_ID",
      detail: "Campaign has no platform_campaign_id. Cannot fetch leads from provider.",
    };
  }
  return { ok: true };
}

/** Normalize an email address for case-insensitive matching. */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/** Build the final BackfillResult from collected counts. Pure. */
export function buildBackfillResult(params: {
  campaignId:        string;
  clientId:          string;
  startedAt:         Date;
  slLeadsDiscovered: number;
  dbRowsProcessed:   number;
  rowsUpdated:       number;
  rowsSkipped:       number;
  rowsUnmatched:     number;
  slLeadsUnmatched:  number;
}): BackfillResult {
  const completedAt = new Date();
  return {
    campaignId:        params.campaignId,
    clientId:          params.clientId,
    startedAt:         params.startedAt.toISOString(),
    completedAt:       completedAt.toISOString(),
    elapsedMs:         completedAt.getTime() - params.startedAt.getTime(),
    slLeadsDiscovered: params.slLeadsDiscovered,
    dbRowsProcessed:   params.dbRowsProcessed,
    rowsUpdated:       params.rowsUpdated,
    rowsSkipped:       params.rowsSkipped,
    rowsUnmatched:     params.rowsUnmatched,
    slLeadsUnmatched:  params.slLeadsUnmatched,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Backfill platform_lead_id for all uploaded campaign_leads in a campaign.
 *
 * opts.provider — inject a mock for tests. When absent, resolved from env via registry.
 */
export async function backfillPlatformLeadIds(
  input: BackfillInput,
  opts?: { provider?: LeadBackfillProvider },
): Promise<BackfillResult> {
  const startedAt = new Date();

  // [1] Validate campaign
  const campaign = await getCampaignById(input.clientId, input.campaignId);
  const check    = validateBackfillPreconditions(campaign, input.clientId);
  if (!check.ok) {
    throw new Error(`backfillPlatformLeadIds: ${check.reason} — ${check.detail}`);
  }
  const platformCampaignId = campaign!.platformCampaignId!;

  // [2] Fetch uploaded DB rows
  const uploadedRows = await getUploadedLeads(input.campaignId, input.clientId);

  if (uploadedRows.length === 0) {
    return buildBackfillResult({
      campaignId: input.campaignId, clientId: input.clientId, startedAt,
      slLeadsDiscovered: 0, dbRowsProcessed: 0,
      rowsUpdated: 0, rowsSkipped: 0, rowsUnmatched: 0, slLeadsUnmatched: 0,
    });
  }

  // [3] Load contact emails (batched)
  const contactIds  = uploadedRows.map((r) => r.contactId);
  const contactMap  = await getContactsByIds(contactIds);

  // Build email → DB row map (normalized email)
  const dbByEmail = new Map<string, typeof uploadedRows[number]>();
  for (const row of uploadedRows) {
    const contact = contactMap.get(row.contactId);
    if (!contact?.email) continue;
    dbByEmail.set(normalizeEmail(contact.email), row);
  }

  // [4] Fetch Smartlead leads (paginated)
  const provider: LeadBackfillProvider =
    opts?.provider ?? OutreachProviderRegistry.fromEnv().getProvider(
      campaign!.platform as "smartlead",
      input.clientId,
    );

  const slLeads = await provider.getCampaignLeads(platformCampaignId);

  // [5] Match Smartlead leads to DB rows by normalized email
  const now              = startedAt.toISOString();
  let rowsUpdated        = 0;
  let rowsSkipped        = 0;
  let slLeadsUnmatched   = 0;

  const matchedDbRowIds = new Set<string>();

  for (const slLead of slLeads) {
    const dbRow = dbByEmail.get(slLead.email);

    if (!dbRow) {
      slLeadsUnmatched++;
      continue;
    }

    matchedDbRowIds.add(dbRow.id);

    if (dbRow.platformLeadId === slLead.campaignLeadMapId) {
      // Already correct — no write, updated_at not advanced
      rowsSkipped++;
    } else {
      await updateLeadPlatformId(dbRow.id, slLead.campaignLeadMapId, now);
      rowsUpdated++;
    }
  }

  // Count DB rows that had no matching Smartlead lead
  const rowsUnmatched = uploadedRows.filter((r) => {
    const contact = contactMap.get(r.contactId);
    if (!contact?.email) return true;
    return !matchedDbRowIds.has(r.id);
  }).length;

  return buildBackfillResult({
    campaignId:        input.campaignId,
    clientId:          input.clientId,
    startedAt,
    slLeadsDiscovered: slLeads.length,
    dbRowsProcessed:   uploadedRows.length,
    rowsUpdated,
    rowsSkipped,
    rowsUnmatched,
    slLeadsUnmatched,
  });
}
