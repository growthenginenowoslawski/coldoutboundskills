/**
 * Stage 21B — BEFORE snapshot (read-only).
 *
 * Records the exact state of all relevant fields across Smartlead and Supabase
 * BEFORE the first send event. This snapshot is the baseline for comparing
 * AFTER the campaign is activated.
 *
 * HARD CONSTRAINTS:
 *   - GET only. No POST/PUT/PATCH/DELETE.
 *   - No Supabase writes.
 *   - No campaign activation. No email sent.
 *   - API key never logged.
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin }        from "../src/db/supabase.js";
import { SmartleadAdapter }        from "../src/providers/outreach/smartlead.js";

const SL_CAMPAIGN_ID       = "3908578";
const DB_CAMPAIGN_ID       = "74c84457-17db-41fa-bd53-a9af63bdb47d";
const CAMPAIGN_LEAD_MAP_ID = "3643998176";
const CAMPAIGN_LEAD_ID     = "6fa744d2-cfaf-48db-89cf-763ce785b3a1";
const LEAD_EMAIL           = "olugbogiafeez@gmail.com";

const API_BASE = "https://server.smartlead.ai/api/v1";
const apiKey   = (process.env.SMARTLEAD_API_KEY ?? "").trim();
const db       = getSupabaseAdmin();
const adapter  = new SmartleadAdapter({ apiKey });

// Intercept fetch — enforce GET only
let slGetCount = 0;
let slMutCount = 0;
const nativeFetch = globalThis.fetch;
(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const urlStr = String(url instanceof Request ? url.url : url);
  const method = (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();
  if (urlStr.includes("smartlead.ai")) {
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      slMutCount++;
      throw new Error(`BLOCKED: unexpected Smartlead mutation (${method}) in before-snapshot script`);
    }
    slGetCount++;
  }
  return nativeFetch(url, init);
};

async function rawGet(path: string): Promise<{ status: number; body: unknown }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_BASE}${path}${sep}api_key=${apiKey}`; // url contains key — never log
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const ct   = resp.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await resp.json().catch(() => null)
    : await resp.text().catch(() => "");
  return { status: resp.status, body };
}

function val(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return String(v);
}

function section(t: string) {
  console.log(`\n${"─".repeat(70)}\n  ${t}\n${"─".repeat(70)}`);
}

async function main(): Promise<void> {
  const snapshotAt = new Date().toISOString();

  console.log("=".repeat(70));
  console.log(" Stage 21B — BEFORE Snapshot (read-only)");
  console.log(`  Taken at:  ${snapshotAt}`);
  console.log(`  Campaign:  ${SL_CAMPAIGN_ID}  (local: ${DB_CAMPAIGN_ID})`);
  console.log(`  Lead:      ${LEAD_EMAIL}  (map_id: ${CAMPAIGN_LEAD_MAP_ID})`);
  console.log("=".repeat(70));

  // ── A. Smartlead campaign object ──────────────────────────────────────────
  section("A. Smartlead — campaign object (GET /campaigns/{id})");

  const campResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}`);
  let slCampaignStatus = "ERROR";

  if (campResp.status === 200) {
    const c = campResp.body as Record<string, unknown>;
    slCampaignStatus = val(c.status);
    console.log(`  id:              ${val(c.id)}`);
    console.log(`  name:            ${val(c.name)}`);
    console.log(`  status:          ${slCampaignStatus}`);
  } else {
    console.log(`  HTTP ${campResp.status} — could not fetch campaign`);
  }

  // ── B. Smartlead campaign roster (getCampaignLeadDetail) ──────────────────
  section("B. Smartlead — campaign roster (getCampaignLeadDetail)");

  let slStatus         = "NOT_FOUND";
  let slMapId          = "NOT_FOUND";
  let slCreatedAt      = "null";
  let slLeadCategoryId = "null";
  let slRawSentAt      = "null";
  let slRawRepliedAt   = "null";
  let slRawReplyType   = "null";

  const detail = await adapter.getCampaignLeadDetail(SL_CAMPAIGN_ID, CAMPAIGN_LEAD_MAP_ID);

  if (detail === null) {
    console.log("  Lead not found in campaign roster — unexpected.");
  } else {
    slStatus         = val(detail.smartleadStatus);
    slMapId          = val(detail.campaignLeadMapId);
    slCreatedAt      = val(detail.createdAt);
    slLeadCategoryId = val(detail.leadCategoryId);
    slRawSentAt      = val(detail.sentAt);
    slRawRepliedAt   = val(detail.repliedAt);
    slRawReplyType   = val(detail.replyType);

    console.log(`  campaign_lead_map_id:  ${slMapId}`);
    console.log(`  status (provider):     ${slStatus}`);
    console.log(`  lead_category_id:      ${slLeadCategoryId}`);
    console.log(`  created_at:            ${slCreatedAt}`);
    console.log(`  sent_at (roster):      ${slRawSentAt}`);
    console.log(`  replied_at (roster):   ${slRawRepliedAt}`);
    console.log(`  reply_type (roster):   ${slRawReplyType}`);
    console.log(`  isUnsubscribed:        ${detail.isUnsubscribed}`);
    console.log(`  leadId (global):       ${val(detail.leadId)}`);

    console.log(`\n  rawFields top-level keys: ${Object.keys(detail.rawFields).join(", ")}`);
  }

  // ── C. Global lead lookup ─────────────────────────────────────────────────
  section("C. Smartlead — global lead lookup (GET /leads/?email=...)");

  let slLastSentAt    = "null";
  let slLastReplyAt   = "null";
  let slLastActivityAt = "null";
  let slGlobalLeadCategoryId = "null";

  const globalResp = await rawGet(`/leads/?email=${encodeURIComponent(LEAD_EMAIL)}`);

  if (globalResp.status === 200 && globalResp.body) {
    const g = globalResp.body as Record<string, unknown>;
    console.log(`  id:               ${val(g.id)}`);
    console.log(`  email:            ${val(g.email)}`);
    console.log(`  is_unsubscribed:  ${val(g.is_unsubscribed)}`);
    console.log(`  created_at:       ${val(g.created_at)}`);

    const lcd = Array.isArray(g.lead_campaign_data)
      ? (g.lead_campaign_data as Record<string, unknown>[]).find(
          (e) => String(e.campaign_id) === SL_CAMPAIGN_ID ||
                 String(e.campaign_lead_map_id) === CAMPAIGN_LEAD_MAP_ID,
        ) ?? null
      : null;

    if (lcd) {
      slLastSentAt           = val(lcd.last_sent_at);
      slLastReplyAt          = val(lcd.last_reply_at);
      slLastActivityAt       = val(lcd.last_activity_at);
      slGlobalLeadCategoryId = val(lcd.lead_category_id);

      console.log(`\n  lead_campaign_data for campaign ${SL_CAMPAIGN_ID}:`);
      console.log(`    campaign_id:           ${val(lcd.campaign_id)}`);
      console.log(`    campaign_lead_map_id:  ${val(lcd.campaign_lead_map_id)}`);
      console.log(`    lead_category_id:      ${slGlobalLeadCategoryId}`);
      console.log(`    last_sent_at:          ${slLastSentAt}`);
      console.log(`    last_reply_at:         ${slLastReplyAt}`);
      console.log(`    last_activity_at:      ${slLastActivityAt}`);
      console.log(`    client_id:             ${val(lcd.client_id)}`);
      console.log(`    campaign_name:         ${val(lcd.campaign_name)}`);
    } else {
      console.log("  lead_campaign_data: no entry for this campaign");
    }
  } else {
    console.log(`  HTTP ${globalResp.status} — could not fetch global lead`);
  }

  // ── D. Campaign analytics ──────────────────────────────────────────────────
  section("D. Smartlead — campaign analytics (GET /campaigns/{id}/analytics)");

  let slSentCount   = "null";
  let slReplyCount  = "null";
  let slBounceCount = "null";
  let slOpenCount   = "null";

  const anaResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/analytics`);

  if (anaResp.status === 200) {
    const a = anaResp.body as Record<string, unknown>;
    slSentCount   = val(a.sent_count   ?? 0);
    slReplyCount  = val(a.reply_count  ?? 0);
    slBounceCount = val(a.bounce_count ?? 0);
    slOpenCount   = val(a.open_count   ?? 0);

    console.log(`  sent_count:       ${slSentCount}`);
    console.log(`  open_count:       ${slOpenCount}`);
    console.log(`  reply_count:      ${slReplyCount}`);
    console.log(`  bounce_count:     ${slBounceCount}`);
    console.log(`  campaign_status:  ${val(a.campaign_status)}`);
  } else {
    console.log(`  HTTP ${anaResp.status} — could not fetch analytics`);
  }

  // ── E. Supabase campaign_lead row ──────────────────────────────────────────
  section("E. Supabase — campaign_leads row");

  let localStatus    = "ERROR";
  let localSentAt    = "null";
  let localRepliedAt = "null";
  let localReplyType = "null";
  let localUpdatedAt = "null";
  let localPlatformLeadId = "null";

  const { data: dbRow, error: dbErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, sent_at, replied_at, reply_type, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (dbErr || !dbRow) {
    console.log(`  ERROR: ${dbErr?.message ?? "row not found"}`);
  } else {
    const r = dbRow as Record<string, unknown>;
    localStatus         = val(r.status);
    localSentAt         = val(r.sent_at);
    localRepliedAt      = val(r.replied_at);
    localReplyType      = val(r.reply_type);
    localUpdatedAt      = val(r.updated_at);
    localPlatformLeadId = val(r.platform_lead_id);

    console.log(`  id:                ${CAMPAIGN_LEAD_ID}`);
    console.log(`  status (local):    ${localStatus}`);
    console.log(`  platform_lead_id:  ${localPlatformLeadId}`);
    console.log(`  sent_at:           ${localSentAt}`);
    console.log(`  replied_at:        ${localRepliedAt}`);
    console.log(`  reply_type:        ${localReplyType}`);
    console.log(`  updated_at:        ${localUpdatedAt}`);
  }

  // ── Restore native fetch ───────────────────────────────────────────────────
  (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;

  // ── Consolidated snapshot table ────────────────────────────────────────────
  section("BEFORE SNAPSHOT — Consolidated");

  console.log(`
  Snapshot taken at: ${snapshotAt}

  ┌─────────────────────────────────────────────────────────────────────┐
  │  SOURCE            FIELD                        BEFORE VALUE        │
  ├─────────────────────────────────────────────────────────────────────┤
  │  Smartlead         campaign status              ${slCampaignStatus.padEnd(20)} │
  │  Smartlead roster  provider status (status)     ${slStatus.padEnd(20)} │
  │  Smartlead roster  campaign_lead_map_id         ${slMapId.padEnd(20)} │
  │  Smartlead roster  created_at                   ${slCreatedAt.slice(0, 20).padEnd(20)} │
  │  Smartlead roster  lead_category_id             ${slLeadCategoryId.padEnd(20)} │
  │  Smartlead roster  sent_at (roster field)       ${slRawSentAt.padEnd(20)} │
  │  Smartlead roster  replied_at (roster field)    ${slRawRepliedAt.padEnd(20)} │
  │  Smartlead roster  reply_type (roster field)    ${slRawReplyType.padEnd(20)} │
  │  Global lead       lead_category_id             ${slGlobalLeadCategoryId.padEnd(20)} │
  │  Global lead       last_sent_at                 ${slLastSentAt.padEnd(20)} │
  │  Global lead       last_reply_at                ${slLastReplyAt.padEnd(20)} │
  │  Global lead       last_activity_at             ${slLastActivityAt.padEnd(20)} │
  │  Analytics         sent_count                   ${slSentCount.padEnd(20)} │
  │  Analytics         reply_count                  ${slReplyCount.padEnd(20)} │
  │  Analytics         bounce_count                 ${slBounceCount.padEnd(20)} │
  │  Supabase          local status                 ${localStatus.padEnd(20)} │
  │  Supabase          local sent_at                ${localSentAt.padEnd(20)} │
  │  Supabase          local replied_at             ${localRepliedAt.padEnd(20)} │
  │  Supabase          local reply_type             ${localReplyType.padEnd(20)} │
  │  Supabase          local updated_at             ${localUpdatedAt.slice(0, 20).padEnd(20)} │
  └─────────────────────────────────────────────────────────────────────┘

  Smartlead GETs:      ${slGetCount}
  Smartlead mutations: ${slMutCount}  (expected: 0)
  Campaign activated:  NO
  Email sent:          NO
  Supabase writes:     NONE
  API key in logs:     NONE
`);

  console.log("  STOPPED — awaiting your activation instruction.");
}

main().catch((err: unknown) => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
