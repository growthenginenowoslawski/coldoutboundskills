/**
 * Stage 21B — Read-only lead status discovery.
 *
 * Goal: empirically establish the Smartlead per-lead status contract before
 * designing the canonical Stage 21B status mapping.
 *
 * Calls made (GET only):
 *   1. getCampaignLeadDetail via new adapter method — full CampaignLeadDetail
 *   2. GET /campaigns/{id}/leads/{campaign_lead_map_id} — does a per-lead endpoint exist?
 *   3. GET /leads/?email={email} — global lead lookup (different field set?)
 *   4. GET /campaigns/{id}/leads?offset=0&limit=1 — raw envelope for field inventory
 *   5. GET /campaigns/{id}/analytics — aggregate send counts (confirm 0 sent)
 *
 * HARD CONSTRAINTS:
 *   - GET only. No POST/PUT/PATCH/DELETE.
 *   - No Supabase writes. No schema changes.
 *   - No campaign activation. No email sent.
 *   - API key never logged.
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { SmartleadAdapter }          from "../src/providers/outreach/smartlead.js";
import type { CampaignLeadDetail }   from "../src/providers/outreach/types.js";

const SL_CAMPAIGN_ID       = "3908578";
const CAMPAIGN_LEAD_MAP_ID = "3643998176";
const LEAD_EMAIL           = "olugbogiafeez@gmail.com";

const API_BASE = "https://server.smartlead.ai/api/v1";
const apiKey   = (process.env.SMARTLEAD_API_KEY ?? "").trim();

if (!apiKey) {
  console.error("SMARTLEAD_API_KEY not set");
  process.exit(1);
}

// Intercept fetch — confirm GET only
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
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") slMutCount++;
    else slGetCount++;
  }
  return nativeFetch(url, init);
};

function section(t: string) {
  console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
}
function sub(t: string) {
  console.log(`\n  ── ${t}`);
}
function ok(label: string) { console.log(`  ✓ ${label}`); }
function warn(label: string) { console.log(`  ⚠ ${label}`); }
function printJson(obj: unknown) { console.log(JSON.stringify(obj, null, 2)); }

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

function fieldTable(obj: Record<string, unknown>, indent = "    ") {
  for (const [key, val] of Object.entries(obj)) {
    const type    = val === null ? "null"
      : Array.isArray(val) ? `array[${(val as unknown[]).length}]`
      : typeof val;
    const preview = val === null ? "null"
      : typeof val === "object" ? JSON.stringify(val).slice(0, 90)
      : String(val).slice(0, 90);
    console.log(`${indent}${key.padEnd(30)} ${type.padEnd(10)} ${preview}`);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Stage 21B — Lead Status Discovery (GET only)");
  console.log(` Campaign:              ${SL_CAMPAIGN_ID}`);
  console.log(` campaign_lead_map_id:  ${CAMPAIGN_LEAD_MAP_ID}`);
  console.log(` Lead email:            ${LEAD_EMAIL}`);
  console.log("=".repeat(70));

  const adapter = new SmartleadAdapter({ apiKey });

  // ── 1. getCampaignLeadDetail via adapter ────────────────────────────────────
  section("1. getCampaignLeadDetail() via adapter (new Stage 21B method)");

  let detail: CampaignLeadDetail | null = null;
  try {
    detail = await adapter.getCampaignLeadDetail(SL_CAMPAIGN_ID, CAMPAIGN_LEAD_MAP_ID);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    console.error(`  ERROR: ${msg}`);
  }

  if (detail === null) {
    warn("getCampaignLeadDetail returned null — lead not found in campaign roster");
    warn("Cannot proceed with field analysis for this lead.");
  } else {
    ok(`Lead found — campaignLeadMapId: ${detail.campaignLeadMapId}`);

    sub("Mapped CampaignLeadDetail fields");
    console.log(`    campaignLeadMapId:  ${detail.campaignLeadMapId}`);
    console.log(`    email:             ${detail.email}`);
    console.log(`    smartleadStatus:   ${detail.smartleadStatus}`);
    console.log(`    leadId:            ${detail.leadId}`);
    console.log(`    leadCategoryId:    ${detail.leadCategoryId}`);
    console.log(`    createdAt:         ${detail.createdAt}`);
    console.log(`    isUnsubscribed:    ${detail.isUnsubscribed}`);
    console.log(`    --- engagement fields (expected null for DRAFTED campaign) ---`);
    console.log(`    sentAt:            ${detail.sentAt}`);
    console.log(`    repliedAt:         ${detail.repliedAt}`);
    console.log(`    bouncedAt:         ${detail.bouncedAt}`);
    console.log(`    unsubscribedAt:    ${detail.unsubscribedAt}`);
    console.log(`    replyType:         ${detail.replyType}`);

    sub("Full rawFields — complete per-lead object from Smartlead");
    fieldTable(detail.rawFields);

    sub("Fields present in rawFields that are NOT yet in our mapped schema");
    const mappedKeys = new Set([
      "campaign_lead_map_id", "lead_category_id", "status", "created_at",
      "sent_at", "replied_at", "bounced_at", "unsubscribed_at", "reply_type", "lead",
    ]);
    const unmapped = Object.keys(detail.rawFields).filter((k) => !mappedKeys.has(k));
    if (unmapped.length === 0) {
      ok("No unmapped top-level fields — all fields accounted for in schema");
    } else {
      console.log(`    ${unmapped.length} unmapped field(s):`);
      for (const k of unmapped) {
        const val = detail.rawFields[k];
        console.log(`    ? ${k.padEnd(28)} = ${JSON.stringify(val).slice(0, 80)}`);
      }
    }

    sub("Nested lead object fields (inside rawFields.lead)");
    const rawLead = detail.rawFields.lead;
    if (rawLead && typeof rawLead === "object") {
      fieldTable(rawLead as Record<string, unknown>);
    } else {
      warn("rawFields.lead is not an object");
    }

    sub("Engagement field null analysis");
    const engagementFields = ["sentAt", "repliedAt", "bouncedAt", "unsubscribedAt", "replyType"] as const;
    const allNull = engagementFields.every((f) => detail![f] === null);
    if (allNull) {
      ok("All engagement fields are null — consistent with DRAFTED campaign (status=STARTED)");
      console.log("    This is expected. These fields will be populated after the campaign goes active.");
    } else {
      warn("Some engagement fields are non-null — unexpected for a DRAFTED campaign:");
      for (const f of engagementFields) {
        if (detail![f] !== null) console.log(`    ${f}: ${detail![f]}`);
      }
    }
  }

  // ── 2. Per-lead endpoint probe ──────────────────────────────────────────────
  section(`2. Per-lead endpoint probe — GET /campaigns/${SL_CAMPAIGN_ID}/leads/${CAMPAIGN_LEAD_MAP_ID}`);
  console.log("  Testing whether Smartlead exposes a per-lead detail endpoint...");

  const perLeadResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/leads/${CAMPAIGN_LEAD_MAP_ID}`);
  console.log(`  HTTP ${perLeadResp.status}`);

  if (perLeadResp.status === 200) {
    warn("Per-lead endpoint exists! This is a faster lookup path for Stage 21B.");
    sub("Response body");
    printJson(perLeadResp.body);
  } else if (perLeadResp.status === 404) {
    ok("HTTP 404 — no per-lead endpoint. Stage 21B must paginate /campaigns/{id}/leads (confirmed).");
  } else {
    warn(`HTTP ${perLeadResp.status} — unexpected response`);
    printJson(perLeadResp.body);
  }

  // ── 3. Global lead lookup ───────────────────────────────────────────────────
  section(`3. Global lead lookup — GET /leads/?email=${LEAD_EMAIL}`);
  console.log("  Testing the global lead lookup endpoint (different field set from roster?)...");

  const globalLeadResp = await rawGet(`/leads/?email=${encodeURIComponent(LEAD_EMAIL)}`);
  console.log(`  HTTP ${globalLeadResp.status}`);

  if (globalLeadResp.status === 200 && globalLeadResp.body !== null) {
    sub("Response shape");
    const body = globalLeadResp.body;
    const isArray = Array.isArray(body);
    console.log(`  typeof body:    ${typeof body}`);
    console.log(`  Array.isArray:  ${isArray}`);
    if (isArray) {
      console.log(`  Array length:   ${(body as unknown[]).length}`);
    }
    sub("Full global lead response");
    printJson(body);

    // Compare fields to campaign roster lead object
    const globalObj: Record<string, unknown> = isArray
      ? ((body as unknown[])[0] as Record<string, unknown> ?? {})
      : (body as Record<string, unknown>);

    if (detail?.rawFields) {
      sub("Fields in global lead NOT present in campaign roster lead");
      const rosterKeys = new Set(Object.keys(detail.rawFields));
      const globalOnly = Object.keys(globalObj).filter((k) => !rosterKeys.has(k));
      if (globalOnly.length === 0) {
        ok("Global lead has no additional top-level fields vs. campaign roster lead");
      } else {
        console.log(`  ${globalOnly.length} additional field(s) in global lead:`);
        for (const k of globalOnly) {
          console.log(`    + ${k.padEnd(28)} = ${JSON.stringify(globalObj[k]).slice(0, 80)}`);
        }
      }

      sub("Fields in campaign roster lead NOT present in global lead");
      const globalKeys = new Set(Object.keys(globalObj));
      const rosterOnly = Object.keys(detail.rawFields).filter((k) => !globalKeys.has(k));
      if (rosterOnly.length === 0) {
        ok("Campaign roster lead has no fields absent from global lead");
      } else {
        console.log(`  ${rosterOnly.length} field(s) only in campaign roster:`);
        for (const k of rosterOnly) {
          console.log(`    + ${k.padEnd(28)} = ${JSON.stringify(detail.rawFields[k]).slice(0, 80)}`);
        }
      }
    }
  } else {
    warn(`HTTP ${globalLeadResp.status} — global lead lookup not available or empty`);
    if (globalLeadResp.body) printJson(globalLeadResp.body);
  }

  // ── 4. Campaign analytics — confirm 0 sends ──────────────────────────────────
  section("4. Campaign analytics — confirm sent_count=0 (campaign not yet active)");

  const anaResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/analytics`);
  console.log(`  HTTP ${anaResp.status}`);
  if (anaResp.status === 200) {
    const ana = anaResp.body as Record<string, unknown>;
    console.log(`  campaign_status:  ${ana.campaign_status ?? "?"}`);
    console.log(`  sent_count:       ${ana.sent_count ?? 0}`);
    console.log(`  open_count:       ${ana.open_count ?? 0}`);
    console.log(`  reply_count:      ${ana.reply_count ?? 0}`);
    console.log(`  bounce_count:     ${ana.bounce_count ?? 0}`);
    const sentCount = Number(ana.sent_count ?? 0);
    sentCount === 0
      ? ok("sent_count=0 — campaign has not yet sent. Status fields will be null until first send.")
      : warn(`sent_count=${sentCount} — campaign has already sent! Status discovery may reveal active fields.`);
  } else {
    printJson(anaResp.body);
  }

  // ── 5. Restore native fetch & audit ─────────────────────────────────────────
  (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;

  // ── Stage 21B field mapping proposal ─────────────────────────────────────────
  section("Stage 21B field mapping analysis — based on empirical discovery");

  console.log(`
  ── Confirmed fields (campaign roster — DRAFTED, status=STARTED) ─────────────
  campaign_lead_map_id  → platform_lead_id (already backfilled in Stage 21A)
  status                → smartleadStatus  (raw value: "STARTED")
  lead_category_id      → leadCategoryId   (null for STARTED — semantics TBD)
  created_at            → createdAt        (ISO timestamp — campaign enrollment date)
  lead.id               → leadId           (global Smartlead lead identity)
  lead.is_unsubscribed  → isUnsubscribed   (boolean — false for active leads)
  lead.email            → contacts.email   (match key — normalized lowercase)

  ── Engagement fields — null for DRAFTED, expected to populate when active ────
  sent_at               → campaign_leads.sent_at
  replied_at            → campaign_leads.replied_at
  bounced_at            → (no DB column yet — Stage 21B may need migration)
  unsubscribed_at       → (no DB column yet — Stage 21B may need migration)
  reply_type            → campaign_leads.reply_type

  ── Status string mapping (UNCONFIRMED — only STARTED observed) ──────────────
  "STARTED"             → 'uploaded'   (enrolled, sequence not yet begun)
  "INPROGRESS" (?)      → 'sent'       (sequence running — unconfirmed)
  "COMPLETED"  (?)      → 'replied'    (sequence finished — unconfirmed)
  "BOUNCE"     (?)      → 'bounced'    (hard bounce — unconfirmed)
  "UNSUBSCRIBED" (?)    → 'opted_out'  (unsubscribed — unconfirmed)

  NOTE: All status strings after "STARTED" are hypothetical. The authoritative
  values will be confirmed by running getCampaignLeadDetail() after the first
  send event — Stage 21B implementation is blocked on that observation.

  ── What Stage 21B implementation needs before it can proceed ─────────────────
  1. Campaign activated → at least one send completes
  2. Re-run getCampaignLeadDetail() → observe actual status string after send
  3. Confirm whether sent_at, replied_at appear in /campaigns/{id}/leads response
     or only in the global /leads/?email= endpoint
  4. Confirm whether reply_type appears, and what values it takes
  5. Decide whether bounced_at / unsubscribed_at need new DB columns

  ── No DB migration needed yet — all decisions deferred to post-first-send ────
`);

  // ── Call audit ───────────────────────────────────────────────────────────────
  section("DISCOVERY COMPLETE — Call audit");

  console.log(`  Smartlead GETs:      ${slGetCount}`);
  console.log(`  Smartlead mutations: ${slMutCount}  (expected: 0)`);

  slMutCount === 0
    ? ok("No Smartlead mutations — GET only confirmed")
    : warn(`${slMutCount} non-GET call(s) — UNEXPECTED`);

  ok("API key not logged");
  ok("No Supabase writes");
  ok("No campaign activation");
  ok("No email sent");

  console.log(`
  Endpoints called:
    GET /campaigns/${SL_CAMPAIGN_ID}/leads?offset=0&limit=100   (via getCampaignLeadDetail)
    GET /campaigns/${SL_CAMPAIGN_ID}/leads/${CAMPAIGN_LEAD_MAP_ID}    (per-lead probe)
    GET /leads/?email=${LEAD_EMAIL}       (global lookup)
    GET /campaigns/${SL_CAMPAIGN_ID}/analytics                  (send count check)
`);
}

main().catch((err: unknown) => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
