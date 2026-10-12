/**
 * Provider lead upload — Stage 20.
 *
 * Takes campaign_leads rows with status='ready', uploads the corresponding
 * contacts to the outreach provider, and transitions rows to status='uploaded'.
 *
 * ── Safety constraints ─────────────────────────────────────────────────────────
 *
 * 1. Platform gate: only campaign.platform === 'smartlead' is accepted.
 *    Campaigns with platform='plusvibe' or 'instantly' are rejected before
 *    any provider call — those adapters are not implemented.
 *
 * 2. Status gate: only campaign.status === 'draft' is accepted.
 *    The behaviour of adding leads to a running Smartlead campaign is
 *    undocumented; 'draft' is the only confirmed-safe state. Relax in Stage 20.5
 *    once running-campaign behaviour is confirmed empirically.
 *
 * 3. platformCampaignId gate: null is rejected before any provider call.
 *    A campaign must have its Smartlead campaign ID set before upload.
 *
 * 4. No emails sent. No campaign status mutations. No eligibility gate changes.
 *    No RLS policy changes. FINDING 5 and FINDING 6 remain open.
 *
 * ── Concurrency model ──────────────────────────────────────────────────────────
 *
 * Stage 20 is single-worker. Concurrent invocations for the same campaign are
 * not supported and may result in duplicate provider calls. Smartlead handles
 * dedup natively — a re-uploaded lead returns already_added_to_campaign=1
 * rather than an error, so the extra call is safe but wasteful.
 *
 * Failure recovery: if the process crashes after a successful provider call but
 * before the DB update, the affected rows stay 'ready'. The next invocation
 * re-uploads those leads; Smartlead accepts them idempotently (duplicate_count
 * reflects this). The DB is then updated correctly on the retry. No data loss.
 *
 * Stage 20.5 upgrade path: replace the read-then-upload-then-update pattern with
 * a DB claim (UPDATE ... WHERE status='ready' RETURNING) using an 'uploading'
 * status. That requires a migration — deferred until the upload path is
 * validated end-to-end.
 *
 * ── platform_lead_id ──────────────────────────────────────────────────────────
 *
 * Smartlead's upload response returns aggregate counts only:
 *   upload_count              — leads accepted as new
 *   already_added_to_campaign — per-campaign dedup counter (idempotent re-upload)
 *   duplicate_count           — global suppression/unsubscribe counter (different meaning)
 * No per-lead ID is returned. campaign_leads.platform_lead_id stays NULL after
 * upload. Backfilling platform_lead_id requires a separate GET /campaigns/{id}/leads
 * call (Stage 21+).
 */

import { getCampaignById }             from "../db/campaigns.js";
import type { CampaignRow }            from "../db/campaigns.js";
import {
  getReadyLeadsForUpload,
  markLeadsUploaded,
}                                      from "../db/campaign-leads.js";
import { getContactsByIds }            from "../db/contacts.js";
import { getCompaniesByIds }           from "../db/companies.js";
import { OutreachProviderRegistry }    from "../providers/outreach/registry.js";
import type {
  UploadLeadInput,
  UploadLeadsResult,
}                                      from "../providers/outreach/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE = 100;

// ── Input / output types ──────────────────────────────────────────────────────

export interface UploadInput {
  clientId:   string;
  campaignId: string;
  /** Cap on how many 'ready' leads to process in this run. Default: all. */
  limit?:     number;
  /** Re-validate preconditions and measure ready count, but skip provider call and DB writes. */
  dryRun?:    boolean;
}

/** One lead successfully transitioned to 'uploaded'. */
export interface UploadedLead {
  campaignLeadId: string;
  contactId:      string;
  uploadedAt:     string; // ISO 8601
}

/** Outcome for one provider batch call. */
export interface BatchUploadOutcome {
  batchIndex:    number;
  leadsInBatch:  number;
  uploadCount:   number;
  duplicateCount: number;
  /** true if the provider call threw — those leads remain 'ready'. */
  failed:        boolean;
  /** Error message if failed=true. Never contains the API key or request URL. */
  error?:        string;
}

export interface UploadResult {
  campaignId:     string;
  clientId:       string;
  startedAt:      string; // ISO 8601
  readyCount:     number; // 'ready' rows found before upload
  uploadedCount:  number; // rows successfully transitioned to 'uploaded'
  duplicateCount: number; // Smartlead-side duplicates (still considered uploaded)
  failedCount:    number; // rows left as 'ready' due to provider errors
  skippedCount:   number; // rows skipped (contact/email missing — should not occur)
  batches:        BatchUploadOutcome[];
  dryRun:         boolean;
}

/** Minimal provider interface required by the orchestrator. Allows test injection. */
export interface LeadUploadProvider {
  uploadLeads(platformCampaignId: string, leads: UploadLeadInput[]): Promise<UploadLeadsResult>;
}

// ── Pure functions ─────────────────────────────────────────────────────────────

/**
 * Validate campaign-level preconditions before touching the provider.
 * Pure — no I/O.
 *
 * Rejects early on any configuration error so the error is deterministic and
 * clear before any DB reads or network calls are made.
 */
export function validateUploadPreconditions(
  campaign:  CampaignRow | null,
  clientId:  string,
): { ok: true } | { ok: false; reason: string; detail: string } {
  if (!campaign) {
    return {
      ok:     false,
      reason: "CAMPAIGN_NOT_FOUND",
      detail: "Campaign not found for this client.",
    };
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
      detail: `Campaign platform '${campaign.platform}' is not supported for upload. Stage 20 requires platform='smartlead'.`,
    };
  }
  if (!campaign.platformCampaignId) {
    return {
      ok:     false,
      reason: "CAMPAIGN_MISSING_PLATFORM_ID",
      detail: "Campaign has no platform_campaign_id. Set this to the Smartlead campaign ID before uploading.",
    };
  }
  if (campaign.status !== "draft") {
    return {
      ok:     false,
      reason: "CAMPAIGN_NOT_DRAFT",
      detail: `Campaign status '${campaign.status}' is not 'draft'. Stage 20 only uploads to draft campaigns (running-campaign behaviour is unconfirmed).`,
    };
  }
  return { ok: true };
}

/**
 * Split an array into consecutive batches of at most `size` elements.
 * Pure — no I/O. Returns [] when items is empty.
 */
export function toBatchesOf<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const safeSize = Math.max(1, size);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    batches.push(items.slice(i, i + safeSize));
  }
  return batches;
}

/**
 * Aggregate per-batch outcomes into the final UploadResult.
 * Pure — no I/O.
 */
export function buildUploadResult(opts: {
  campaignId:    string;
  clientId:      string;
  startedAt:     Date;
  readyCount:    number;
  batches:       BatchUploadOutcome[];
  skippedCount:  number;
  dryRun:        boolean;
}): UploadResult {
  let uploadedCount  = 0;
  let duplicateCount = 0;
  let failedCount    = 0;

  for (const b of opts.batches) {
    if (b.failed) {
      failedCount += b.leadsInBatch;
    } else {
      uploadedCount  += b.uploadCount;
      duplicateCount += b.duplicateCount;
    }
  }

  return {
    campaignId:     opts.campaignId,
    clientId:       opts.clientId,
    startedAt:      opts.startedAt.toISOString(),
    readyCount:     opts.readyCount,
    uploadedCount,
    duplicateCount,
    failedCount,
    skippedCount:   opts.skippedCount,
    batches:        opts.batches,
    dryRun:         opts.dryRun,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Upload 'ready' campaign leads to the outreach provider and transition them
 * to 'uploaded' on success.
 *
 * DB queries — up to 5 + 1 per batch:
 *   [1] getCampaignById              — campaign fetch + precondition check
 *   [2] getReadyLeadsForUpload       — ready campaign_leads rows
 *   [3] getContactsByIds             — contact data for provider payload
 *   [4] getCompaniesByIds            — company names for provider payload
 *   [5..N] markLeadsUploaded         — one UPDATE per successful batch
 *
 * [5..N] are skipped when dryRun=true or no ready leads exist.
 *
 * Provider options:
 *   opts.provider — override the provider (used by tests to inject a mock).
 *   When not provided, OutreachProviderRegistry.fromEnv() resolves the provider
 *   from SMARTLEAD_API_KEY in environment variables.
 *
 * No emails sent. No campaign mutations. No RLS changes.
 */
export async function uploadCampaignLeads(
  input: UploadInput,
  opts?: { provider?: LeadUploadProvider },
): Promise<UploadResult> {
  const startedAt = new Date();
  const dryRun    = input.dryRun ?? false;

  // [1] Fetch campaign and validate preconditions
  const campaign = await getCampaignById(input.clientId, input.campaignId);
  const check    = validateUploadPreconditions(campaign, input.clientId);
  if (!check.ok) {
    throw new Error(`uploadCampaignLeads: ${check.reason} — ${check.detail}`);
  }

  // campaign is confirmed non-null and has platformCampaignId from this point
  const platformCampaignId = campaign!.platformCampaignId!;

  // [2] Fetch ready leads
  const readyLeads = await getReadyLeadsForUpload(
    input.campaignId,
    input.clientId,
    input.limit,
  );

  if (readyLeads.length === 0 || dryRun) {
    return buildUploadResult({
      campaignId:   input.campaignId,
      clientId:     input.clientId,
      startedAt,
      readyCount:   readyLeads.length,
      batches:      [],
      skippedCount: 0,
      dryRun,
    });
  }

  // [3] Fetch contacts in batch
  const contactIds  = readyLeads.map((cl) => cl.contactId);
  const contactMap  = await getContactsByIds(contactIds);

  // [4] Fetch company names in batch
  const companyIds  = [...new Set(
    [...contactMap.values()].map((c) => c.companyId),
  )];
  const companyMap  = await getCompaniesByIds(companyIds);

  // Build (campaignLeadId, UploadLeadInput) pairs — skip leads without email
  const uploadItems: Array<{ campaignLeadId: string; lead: UploadLeadInput }> = [];
  let skippedCount = 0;

  for (const cl of readyLeads) {
    const contact = contactMap.get(cl.contactId);
    if (!contact?.email) {
      // Should not occur: enrollment enforced the email gate. Skip defensively.
      skippedCount++;
      continue;
    }
    const company = contact ? companyMap.get(contact.companyId) : undefined;
    uploadItems.push({
      campaignLeadId: cl.id,
      lead: {
        email:       contact.email,
        firstName:   contact.firstName  ?? "",
        lastName:    contact.lastName   ?? "",
        companyName: company?.name      ?? "",
      },
    });
  }

  // Resolve provider — use injection if provided (tests), else registry (production)
  const provider: LeadUploadProvider =
    opts?.provider ?? OutreachProviderRegistry.fromEnv().getProvider(
      campaign!.platform as "smartlead",
      input.clientId,
    );

  // Split into batches of 100 and upload
  const batches     = toBatchesOf(uploadItems, BATCH_SIZE);
  const outcomes:     BatchUploadOutcome[] = [];
  const nowStr      = startedAt.toISOString();

  for (let i = 0; i < batches.length; i++) {
    const batchItems = batches[i]!;
    const batchLeads = batchItems.map((item) => item.lead);

    let outcome: BatchUploadOutcome;
    try {
      const result = await provider.uploadLeads(platformCampaignId, batchLeads);

      // [5] Transition this batch to 'uploaded'
      const batchLeadIds = batchItems.map((item) => item.campaignLeadId);
      await markLeadsUploaded(batchLeadIds, nowStr);

      outcome = {
        batchIndex:    i,
        leadsInBatch:  batchItems.length,
        uploadCount:   result.uploadCount,
        duplicateCount: result.duplicateCount,
        failed:        false,
      };
    } catch (err) {
      // Provider call failed — leaves rows as 'ready' for retry on next invocation
      const msg = err instanceof Error ? err.message : String(err);
      outcome = {
        batchIndex:    i,
        leadsInBatch:  batchItems.length,
        uploadCount:   0,
        duplicateCount: 0,
        failed:        true,
        error:         msg,
      };
    }

    outcomes.push(outcome);
  }

  return buildUploadResult({
    campaignId:   input.campaignId,
    clientId:     input.clientId,
    startedAt,
    readyCount:   readyLeads.length,
    batches:      outcomes,
    skippedCount,
    dryRun,
  });
}
