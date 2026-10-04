/**
 * Stage 21 — Read-only Smartlead API discovery.
 *
 * Calls GET /campaigns/{id}/leads and related endpoints to document:
 *   - Exact response shape
 *   - Pagination behaviour
 *   - Per-lead field names (id, email, status, timestamps, reply fields)
 *   - Exact status string values
 *
 * HARD CONSTRAINTS:
 *   - GET only. No POST/PUT/PATCH/DELETE.
 *   - No Supabase writes.
 *   - No campaign activation. No email sent.
 *   - API key never logged.
 *
 * The full raw lead object(s) are printed so the Stage 21 implementation
 * can be based on confirmed field names rather than assumed ones.
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

const SL_CAMPAIGN_ID = "3908578";
const API_BASE       = "https://server.smartlead.ai/api/v1";
const apiKey         = (process.env.SMARTLEAD_API_KEY ?? "").trim();

if (!apiKey) {
  console.error("SMARTLEAD_API_KEY not set");
  process.exit(1);
}

function section(t: string) {
  console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
}
function sub(t: string) {
  console.log(`\n${"─".repeat(60)}\n  ${t}\n${"─".repeat(60)}`);
}

async function slGet(path: string): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const sep  = path.includes("?") ? "&" : "?";
  // url contains api_key — never log it
  const url  = `${API_BASE}${path}${sep}api_key=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });

  const contentType = resp.headers.get("content-type") ?? "";
  let body: unknown;
  if (contentType.includes("application/json")) {
    body = await resp.json().catch(() => null);
  } else {
    body = await resp.text().catch(() => "");
  }

  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => { headers[k] = v; });

  return { status: resp.status, body, headers };
}

function redactKey(obj: unknown): unknown {
  if (typeof obj === "string") return obj.replace(/api_key=[^&\s"']*/gi, "api_key=[REDACTED]");
  return obj;
}

function printJson(obj: unknown, indent = 2) {
  console.log(JSON.stringify(obj, null, indent));
}

function analyzeLeadFields(lead: Record<string, unknown>) {
  console.log("\n  Field inventory for this lead object:");
  for (const [key, val] of Object.entries(lead)) {
    const type = val === null ? "null" : Array.isArray(val) ? `array[${(val as unknown[]).length}]` : typeof val;
    const preview = val === null ? "null"
      : typeof val === "object" ? JSON.stringify(val).slice(0, 80)
      : String(val).slice(0, 80);
    console.log(`    ${key.padEnd(32)} ${type.padEnd(12)} ${preview}`);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Stage 21 — Smartlead GET /campaigns/{id}/leads API Discovery");
  console.log(" Campaign: " + SL_CAMPAIGN_ID);
  console.log(" All calls are GET. No mutations.");
  console.log("=".repeat(70));

  // ── 1. Campaign summary — confirm status still DRAFTED ─────────────────────
  section("1. Campaign summary — confirm DRAFTED status");

  const campResp = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`);
  console.log(`  HTTP ${campResp.status}`);
  if (campResp.status === 200) {
    const camp = campResp.body as Record<string, unknown>;
    console.log(`  id:     ${camp.id ?? "?"}`);
    console.log(`  name:   ${camp.name ?? "?"}`);
    console.log(`  status: ${camp.status ?? "?"}`);
    const rawStatus = String(camp.status ?? "");
    const isDraft = rawStatus.toUpperCase() === "DRAFT" || rawStatus.toUpperCase() === "DRAFTED";
    console.log(`  isDraft: ${isDraft} ${isDraft ? "✓ safe to proceed" : "⚠ UNEXPECTED"}`);
  } else {
    console.log("  Non-200 response:");
    printJson(campResp.body);
  }

  // ── 2. GET /campaigns/{id}/leads — page 0, limit 10 ──────────────────────
  section("2. GET /campaigns/{id}/leads  (offset=0, limit=10)");

  const leadsResp = await slGet(`/campaigns/${SL_CAMPAIGN_ID}/leads?offset=0&limit=10`);
  console.log(`  HTTP ${leadsResp.status}`);
  console.log(`  Content-Type: ${leadsResp.headers["content-type"] ?? "unknown"}`);

  if (leadsResp.status !== 200) {
    console.log("  Non-200 response:");
    printJson(leadsResp.body);
    console.log("\n  Cannot proceed with lead inspection.");
  } else {
    const body = leadsResp.body;

    sub("2a. Raw top-level response shape");
    console.log(`  typeof body:    ${typeof body}`);
    console.log(`  Array.isArray:  ${Array.isArray(body)}`);

    if (Array.isArray(body)) {
      console.log(`  Array length:   ${body.length}`);
      console.log("\n  Top-level keys are absent (direct array).");
    } else if (body !== null && typeof body === "object") {
      const keys = Object.keys(body as object);
      console.log(`  Top-level keys: ${keys.join(", ")}`);
      // Check for known envelope patterns
      const obj = body as Record<string, unknown>;
      if (Array.isArray(obj.data))  console.log(`  obj.data length:  ${(obj.data as unknown[]).length}`);
      if (Array.isArray(obj.leads)) console.log(`  obj.leads length: ${(obj.leads as unknown[]).length}`);
      if (obj.total !== undefined)  console.log(`  obj.total:        ${obj.total}`);
      if (obj.count !== undefined)  console.log(`  obj.count:        ${obj.count}`);
    }

    sub("2b. Full raw response (complete, unfiltered)");
    printJson(redactKey(body));

    // Extract lead array regardless of envelope shape
    let leads: unknown[] = [];
    if (Array.isArray(body)) {
      leads = body;
    } else if (body !== null && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      if (Array.isArray(obj.data))  leads = obj.data  as unknown[];
      if (Array.isArray(obj.leads)) leads = obj.leads as unknown[];
    }

    if (leads.length > 0) {
      sub(`2c. Field inventory — lead[0] (${leads.length} lead(s) total)`);
      const firstLead = leads[0] as Record<string, unknown>;
      analyzeLeadFields(firstLead);

      if (leads.length > 1) {
        sub(`2d. Field inventory — lead[1]`);
        analyzeLeadFields(leads[1] as Record<string, unknown>);
      }

      // Highlight key fields we need to map
      sub("2e. Key field extraction — values needed for Stage 21 mapping");
      const l = firstLead;
      const candidates = [
        // Identity
        "id", "lead_id", "lead_id", "email_lead_id",
        // Contact info
        "email", "lead_email", "email_address",
        // Status
        "status", "lead_status", "email_status",
        // Timestamps
        "sent_at", "email_sent_at", "first_sent_at", "last_email_sent_at",
        "replied_at", "reply_at", "email_reply_at",
        "bounced_at", "bounce_at", "email_bounce_at",
        "unsubscribed_at", "created_at", "updated_at",
        // Reply info
        "reply_type", "reply_classification",
        // Lead data
        "first_name", "last_name", "company_name",
      ];
      console.log("\n  Checking for expected field names:");
      for (const field of candidates) {
        if (field in l) {
          const val = l[field];
          const preview = val === null ? "null"
            : typeof val === "object" ? JSON.stringify(val).slice(0, 100)
            : String(val).slice(0, 100);
          console.log(`    ✓ ${field.padEnd(30)} = ${preview}`);
        }
      }

      console.log("\n  Fields present but NOT in candidate list:");
      const knownCandidates = new Set(candidates);
      for (const key of Object.keys(l)) {
        if (!knownCandidates.has(key)) {
          const val = l[key];
          const preview = val === null ? "null"
            : typeof val === "object" ? JSON.stringify(val).slice(0, 100)
            : String(val).slice(0, 100);
          console.log(`    ? ${key.padEnd(30)} = ${preview}`);
        }
      }
    } else {
      console.log("\n  No leads found in response.");
    }
  }

  // ── 3. Pagination probe — offset=10, limit=10 ─────────────────────────────
  section("3. Pagination probe (offset=10, limit=10) — expect 0 leads");

  const page2 = await slGet(`/campaigns/${SL_CAMPAIGN_ID}/leads?offset=10&limit=10`);
  console.log(`  HTTP ${page2.status}`);
  const p2body = page2.body;
  const p2leads = Array.isArray(p2body) ? p2body
    : Array.isArray((p2body as Record<string, unknown>)?.data)  ? (p2body as Record<string, unknown>).data  as unknown[]
    : Array.isArray((p2body as Record<string, unknown>)?.leads) ? (p2body as Record<string, unknown>).leads as unknown[]
    : [];
  console.log(`  Lead count on page 2: ${p2leads.length}  (expected: 0 — only 1 lead uploaded)`);
  if (p2leads.length > 0) printJson(redactKey(p2body));

  // ── 4. GET /campaigns/{id}/leads without pagination params ────────────────
  section("4. GET /campaigns/{id}/leads — no pagination params");

  const noPage = await slGet(`/campaigns/${SL_CAMPAIGN_ID}/leads`);
  console.log(`  HTTP ${noPage.status}`);
  if (noPage.status === 200) {
    const npBody = noPage.body;
    const npLeads = Array.isArray(npBody) ? npBody
      : Array.isArray((npBody as Record<string, unknown>)?.data)  ? (npBody as Record<string, unknown>).data  as unknown[]
      : Array.isArray((npBody as Record<string, unknown>)?.leads) ? (npBody as Record<string, unknown>).leads as unknown[]
      : [];
    console.log(`  Lead count: ${npLeads.length}`);
    if (JSON.stringify(npBody) !== JSON.stringify(leadsResp.body)) {
      console.log("  Response differs from paginated call — printing:");
      printJson(redactKey(npBody));
    } else {
      console.log("  Response identical to paginated call (offset=0&limit=10).");
    }
  } else {
    printJson(redactKey(noPage.body));
  }

  // ── 5. Lead statistics endpoint (alternate) ───────────────────────────────
  section("5. GET /campaigns/{id}/leads-statistics (alternate endpoint probe)");

  const statsResp = await slGet(`/campaigns/${SL_CAMPAIGN_ID}/leads-statistics?offset=0&limit=10`);
  console.log(`  HTTP ${statsResp.status}`);
  if (statsResp.status === 200) {
    printJson(redactKey(statsResp.body));
  } else {
    console.log(`  Not available (${statsResp.status}) — field will not be used`);
  }

  // ── 6. Campaign analytics (already used in getCampaignHealth) ─────────────
  section("6. GET /campaigns/{id}/analytics — confirm send counts");

  const anaResp = await slGet(`/campaigns/${SL_CAMPAIGN_ID}/analytics`);
  console.log(`  HTTP ${anaResp.status}`);
  if (anaResp.status === 200) {
    printJson(redactKey(anaResp.body));
  } else {
    printJson(redactKey(anaResp.body));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  section("DISCOVERY COMPLETE — No mutations made");
  console.log(`
  HTTP methods used: GET only
  Endpoints called:
    GET /campaigns/${SL_CAMPAIGN_ID}
    GET /campaigns/${SL_CAMPAIGN_ID}/leads?offset=0&limit=10
    GET /campaigns/${SL_CAMPAIGN_ID}/leads?offset=10&limit=10
    GET /campaigns/${SL_CAMPAIGN_ID}/leads
    GET /campaigns/${SL_CAMPAIGN_ID}/leads-statistics?offset=0&limit=10
    GET /campaigns/${SL_CAMPAIGN_ID}/analytics

  Supabase: not touched
  Campaign status: not changed
  Email sent: NO
  API key in logs: NONE
`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
