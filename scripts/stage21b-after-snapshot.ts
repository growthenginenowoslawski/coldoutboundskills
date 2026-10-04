/**
 * Stage 21B — AFTER snapshot (read-only).
 *
 * Records the exact state of all relevant fields across Smartlead and Supabase
 * AFTER the first real send event confirmed by the UI (1/1 sends, 1 opened,
 * campaign status: Completed).
 *
 * Compares directly against the BEFORE snapshot for empirical field mapping.
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

if (!apiKey) {
  console.error("SMARTLEAD_API_KEY not set");
  process.exit(1);
}

const db      = getSupabaseAdmin();
const adapter = new SmartleadAdapter({ apiKey });

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
      throw new Error(`BLOCKED: unexpected Smartlead mutation (${method}) in after-snapshot script`);
    }
    slGetCount++;
  }
  return nativeFetch(url, init);
};

async function rawGet(path: string): Promise<{ status: number; body: unknown }> {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API_BASE}${path}${sep}api_key=${apiKey}`;
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

function printJson(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

async function main(): Promise<void> {
  const snapshotAt = new Date().toISOString();

  console.log("=".repeat(70));
  console.log(" Stage 21B — AFTER Snapshot (read-only)");
  console.log(`  Taken at:       ${snapshotAt}`);
  console.log(`  Campaign SL:    ${SL_CAMPAIGN_ID}  (local: ${DB_CAMPAIGN_ID})`);
  console.log(`  Lead email:     ${LEAD_EMAIL}  (map_id: ${CAMPAIGN_LEAD_MAP_ID})`);
  console.log(`  Context:        UI shows 1/1 sends, 1 open, campaign=Completed`);
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
    console.log(`\n  Full campaign object top-level keys:`);
    for (const [k, v] of Object.entries(c)) {
      if (k === "name") continue;
      const preview = v === null ? "null"
        : typeof v === "object" ? JSON.stringify(v).slice(0, 80)
        : String(v).slice(0, 80);
      console.log(`    ${k.padEnd(30)} ${preview}`);
    }
  } else {
    console.log(`  HTTP ${campResp.status} — could not fetch campaign`);
    printJson(campResp.body);
  }

  // ── B. Campaign roster via getCampaignLeadDetail ──────────────────────────
  section("B. Smartlead — campaign roster (getCampaignLeadDetail)");

  let slStatus         = "NOT_FOUND";
  let slMapId          = "NOT_FOUND";
  let slCreatedAt      = "null";
  let slLeadCategoryId = "null";
  let slRawSentAt      = "null";
  let slRawRepliedAt   = "null";
  let slRawReplyType   = "null";
  let slBouncedAt      = "null";
  let slUnsubscribedAt = "null";

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
    slBouncedAt      = val(detail.bouncedAt);
    slUnsubscribedAt = val(detail.unsubscribedAt);

    console.log(`  campaign_lead_map_id:  ${slMapId}`);
    console.log(`  status (provider):     ${slStatus}`);
    console.log(`  lead_category_id:      ${slLeadCategoryId}`);
    console.log(`  created_at:            ${slCreatedAt}`);
    console.log(`  sent_at:               ${slRawSentAt}`);
    console.log(`  replied_at:            ${slRawRepliedAt}`);
    console.log(`  bounced_at:            ${slBouncedAt}`);
    console.log(`  unsubscribed_at:       ${slUnsubscribedAt}`);
    console.log(`  reply_type:            ${slRawReplyType}`);
    console.log(`  isUnsubscribed:        ${detail.isUnsubscribed}`);
    console.log(`  leadId (global):       ${val(detail.leadId)}`);

    console.log(`\n  rawFields — complete per-lead object from Smartlead:`);
    for (const [k, v] of Object.entries(detail.rawFields)) {
      const type    = v === null ? "null"
        : Array.isArray(v) ? `array[${(v as unknown[]).length}]`
        : typeof v;
      const preview = v === null ? "null"
        : typeof v === "object" ? JSON.stringify(v).slice(0, 90)
        : String(v).slice(0, 90);
      console.log(`    ${k.padEnd(30)} ${type.padEnd(10)} ${preview}`);
    }

    const rawLead = detail.rawFields.lead;
    if (rawLead && typeof rawLead === "object") {
      console.log(`\n  rawFields.lead — nested lead object:`);
      for (const [k, v] of Object.entries(rawLead as Record<string, unknown>)) {
        const type    = v === null ? "null"
          : Array.isArray(v) ? `array[${(v as unknown[]).length}]`
          : typeof v;
        const preview = v === null ? "null"
          : typeof v === "object" ? JSON.stringify(v).slice(0, 90)
          : String(v).slice(0, 90);
        console.log(`    ${k.padEnd(30)} ${type.padEnd(10)} ${preview}`);
      }
    }
  }

  // ── C. Global lead lookup ─────────────────────────────────────────────────
  section("C. Smartlead — global lead lookup (GET /leads/?email=...)");

  let slLastSentAt           = "null";
  let slLastReplyAt          = "null";
  let slLastActivityAt       = "null";
  let slGlobalLeadCategoryId = "null";

  const globalResp = await rawGet(`/leads/?email=${encodeURIComponent(LEAD_EMAIL)}`);
  console.log(`  HTTP ${globalResp.status}`);

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
      for (const [k, v] of Object.entries(lcd)) {
        const preview = v === null ? "null"
          : typeof v === "object" ? JSON.stringify(v).slice(0, 80)
          : String(v).slice(0, 80);
        console.log(`    ${k.padEnd(30)} ${preview}`);
      }
    } else {
      console.log("  lead_campaign_data: no entry found for this campaign");
      if (Array.isArray(g.lead_campaign_data)) {
        console.log(`  lead_campaign_data length: ${(g.lead_campaign_data as unknown[]).length}`);
        printJson(g.lead_campaign_data);
      }
    }

    // Print all top-level fields
    console.log(`\n  All top-level global lead fields:`);
    for (const [k, v] of Object.entries(g)) {
      if (k === "lead_campaign_data") {
        console.log(`    ${k.padEnd(30)} array[${Array.isArray(v) ? (v as unknown[]).length : "?"}]`);
        continue;
      }
      const preview = v === null ? "null"
        : typeof v === "object" ? JSON.stringify(v).slice(0, 80)
        : String(v).slice(0, 80);
      console.log(`    ${k.padEnd(30)} ${preview}`);
    }
  } else {
    console.log(`  Body: ${JSON.stringify(globalResp.body).slice(0, 200)}`);
  }

  // ── D. Campaign analytics ──────────────────────────────────────────────────
  section("D. Smartlead — campaign analytics (GET /campaigns/{id}/analytics)");

  let slSentCount   = "null";
  let slReplyCount  = "null";
  let slBounceCount = "null";
  let slOpenCount   = "null";

  const anaResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/analytics`);
  console.log(`  HTTP ${anaResp.status}`);

  if (anaResp.status === 200) {
    const a = anaResp.body as Record<string, unknown>;
    slSentCount   = val(a.sent_count   ?? 0);
    slReplyCount  = val(a.reply_count  ?? 0);
    slBounceCount = val(a.bounce_count ?? 0);
    slOpenCount   = val(a.open_count   ?? 0);

    console.log(`\n  Full analytics object:`);
    for (const [k, v] of Object.entries(a)) {
      const preview = v === null ? "null"
        : typeof v === "object" ? JSON.stringify(v).slice(0, 80)
        : String(v).slice(0, 80);
      console.log(`    ${k.padEnd(30)} ${preview}`);
    }
  } else {
    printJson(anaResp.body);
  }

  // ── E. Supabase campaign_lead row ──────────────────────────────────────────
  section("E. Supabase — campaign_leads row");

  let localStatus         = "ERROR";
  let localSentAt         = "null";
  let localRepliedAt      = "null";
  let localReplyType      = "null";
  let localUpdatedAt      = "null";
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

  // ── Consolidated BEFORE vs AFTER comparison ────────────────────────────────
  section("BEFORE vs AFTER — Consolidated Comparison");

  const BEFORE = {
    slCampaignStatus:      "DRAFTED",
    slStatus:              "STARTED",
    slMapId:               "3643998176",
    slCreatedAt:           "2026-09-05T20:29:22.000Z",
    slLeadCategoryId:      "null",
    slRawSentAt:           "null",
    slRawRepliedAt:        "null",
    slRawReplyType:        "null",
    slLastSentAt:          "null",
    slLastReplyAt:         "null",
    slLastActivityAt:      "null",
    slGlobalCategoryId:    "null",
    slSentCount:           "0",
    slReplyCount:          "0",
    slBounceCount:         "0",
    localStatus:           "uploaded",
    localSentAt:           "null",
    localRepliedAt:        "null",
    localReplyType:        "null",
    localPlatformLeadId:   "3643998176",
  };

  const AFTER = {
    slCampaignStatus,
    slStatus,
    slMapId,
    slCreatedAt,
    slLeadCategoryId,
    slRawSentAt,
    slRawRepliedAt,
    slRawReplyType,
    slLastSentAt,
    slLastReplyAt,
    slLastActivityAt,
    slGlobalCategoryId:    slGlobalLeadCategoryId,
    slSentCount,
    slReplyCount,
    slBounceCount,
    localStatus,
    localSentAt,
    localRepliedAt,
    localReplyType,
    localPlatformLeadId,
  };

  console.log(`
  Snapshot taken at: ${snapshotAt}
  Context: UI shows campaign=Completed, 1/1 sends, 1 opened, 0 replies
`);

  const rows: Array<[string, string, string, string, string]> = [
    ["SOURCE",          "FIELD",                    "BEFORE",            "AFTER",             "CHANGED?"],
    ["Smartlead",       "campaign status",           BEFORE.slCampaignStatus,  AFTER.slCampaignStatus,  BEFORE.slCampaignStatus !== AFTER.slCampaignStatus ? "YES <<<" : "same"],
    ["SL roster",       "provider status",           BEFORE.slStatus,         AFTER.slStatus,          BEFORE.slStatus !== AFTER.slStatus ? "YES <<<" : "same"],
    ["SL roster",       "campaign_lead_map_id",      BEFORE.slMapId,          AFTER.slMapId,           BEFORE.slMapId !== AFTER.slMapId ? "YES <<<" : "same"],
    ["SL roster",       "lead_category_id",          BEFORE.slLeadCategoryId, AFTER.slLeadCategoryId,  BEFORE.slLeadCategoryId !== AFTER.slLeadCategoryId ? "YES <<<" : "same"],
    ["SL roster",       "sent_at",                   BEFORE.slRawSentAt,      AFTER.slRawSentAt,       BEFORE.slRawSentAt !== AFTER.slRawSentAt ? "YES <<<" : "same"],
    ["SL roster",       "replied_at",                BEFORE.slRawRepliedAt,   AFTER.slRawRepliedAt,    BEFORE.slRawRepliedAt !== AFTER.slRawRepliedAt ? "YES <<<" : "same"],
    ["SL roster",       "reply_type",                BEFORE.slRawReplyType,   AFTER.slRawReplyType,    BEFORE.slRawReplyType !== AFTER.slRawReplyType ? "YES <<<" : "same"],
    ["Global lead",     "lead_category_id",          BEFORE.slGlobalCategoryId, AFTER.slGlobalCategoryId, BEFORE.slGlobalCategoryId !== AFTER.slGlobalCategoryId ? "YES <<<" : "same"],
    ["Global lead",     "last_sent_at",              BEFORE.slLastSentAt,     AFTER.slLastSentAt,      BEFORE.slLastSentAt !== AFTER.slLastSentAt ? "YES <<<" : "same"],
    ["Global lead",     "last_reply_at",             BEFORE.slLastReplyAt,    AFTER.slLastReplyAt,     BEFORE.slLastReplyAt !== AFTER.slLastReplyAt ? "YES <<<" : "same"],
    ["Global lead",     "last_activity_at",          BEFORE.slLastActivityAt, AFTER.slLastActivityAt,  BEFORE.slLastActivityAt !== AFTER.slLastActivityAt ? "YES <<<" : "same"],
    ["Analytics",       "sent_count",                BEFORE.slSentCount,      AFTER.slSentCount,       BEFORE.slSentCount !== AFTER.slSentCount ? "YES <<<" : "same"],
    ["Analytics",       "reply_count",               BEFORE.slReplyCount,     AFTER.slReplyCount,      BEFORE.slReplyCount !== AFTER.slReplyCount ? "YES <<<" : "same"],
    ["Analytics",       "bounce_count",              BEFORE.slBounceCount,    AFTER.slBounceCount,     BEFORE.slBounceCount !== AFTER.slBounceCount ? "YES <<<" : "same"],
    ["Supabase",        "local status",              BEFORE.localStatus,      AFTER.localStatus,       BEFORE.localStatus !== AFTER.localStatus ? "YES <<<" : "same"],
    ["Supabase",        "local sent_at",             BEFORE.localSentAt,      AFTER.localSentAt,       BEFORE.localSentAt !== AFTER.localSentAt ? "YES <<<" : "same"],
    ["Supabase",        "local replied_at",          BEFORE.localRepliedAt,   AFTER.localRepliedAt,    BEFORE.localRepliedAt !== AFTER.localRepliedAt ? "YES <<<" : "same"],
    ["Supabase",        "local reply_type",          BEFORE.localReplyType,   AFTER.localReplyType,    BEFORE.localReplyType !== AFTER.localReplyType ? "YES <<<" : "same"],
    ["Supabase",        "platform_lead_id",          BEFORE.localPlatformLeadId, AFTER.localPlatformLeadId, BEFORE.localPlatformLeadId !== AFTER.localPlatformLeadId ? "YES <<<" : "same"],
  ];

  const c0 = 16, c1 = 28, c2 = 24, c3 = 24, c4 = 10;
  const sep = `  ├${"─".repeat(c0+2)}┼${"─".repeat(c1+2)}┼${"─".repeat(c2+2)}┼${"─".repeat(c3+2)}┼${"─".repeat(c4+2)}┤`;
  const top = `  ┌${"─".repeat(c0+2)}┬${"─".repeat(c1+2)}┬${"─".repeat(c2+2)}┬${"─".repeat(c3+2)}┬${"─".repeat(c4+2)}┐`;
  const bot = `  └${"─".repeat(c0+2)}┴${"─".repeat(c1+2)}┴${"─".repeat(c2+2)}┴${"─".repeat(c3+2)}┴${"─".repeat(c4+2)}┘`;

  console.log(top);
  for (let i = 0; i < rows.length; i++) {
    const [s, f, b, a, ch] = rows[i];
    console.log(`  │ ${s.slice(0,c0).padEnd(c0)} │ ${f.slice(0,c1).padEnd(c1)} │ ${b.slice(0,c2).padEnd(c2)} │ ${a.slice(0,c3).padEnd(c3)} │ ${ch.slice(0,c4).padEnd(c4)} │`);
    if (i === 0) console.log(sep);
  }
  console.log(bot);

  console.log(`
  Smartlead GETs:      ${slGetCount}
  Smartlead mutations: ${slMutCount}  (expected: 0)
  Campaign activated:  NO (was already sent before this snapshot)
  Email sent:          NO (snapshot only)
  Supabase writes:     NONE
  API key in logs:     NONE
`);
}

main().catch((err: unknown) => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
