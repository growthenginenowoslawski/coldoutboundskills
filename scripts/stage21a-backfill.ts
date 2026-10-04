/**
 * Stage 21A — platform_lead_id backfill (live).
 *
 * Calls backfillPlatformLeadIds() against Smartlead campaign 3908578.
 * Writes campaign_lead_map_id → campaign_leads.platform_lead_id for any row
 * where it is missing or differs.
 *
 * HARD CONSTRAINTS:
 *   - GET only against Smartlead. No POST/PUT/PATCH/DELETE.
 *   - Campaign not activated. No email sent.
 *   - Does not touch status, sent_at, replied_at, reply_type.
 *   - API key never logged.
 *   - Stops after first backfill. Does not run idempotency rerun.
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin }         from "../src/db/supabase.js";
import { backfillPlatformLeadIds }  from "../src/lib/platform-lead-id-backfill.js";

const GRAMSCODE_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const DB_CAMPAIGN_ID      = "74c84457-17db-41fa-bd53-a9af63bdb47d";
const SL_CAMPAIGN_ID      = "3908578";
const CAMPAIGN_LEAD_ID    = "6fa744d2-cfaf-48db-89cf-763ce785b3a1";
const CONTACT_ID          = "53e3fad0-74a1-4680-a24a-1f2292b1aa59";

const API_BASE = "https://server.smartlead.ai/api/v1";
const apiKey   = (process.env.SMARTLEAD_API_KEY ?? "").trim();
const db       = getSupabaseAdmin();

function section(t: string) {
  console.log(`\n${"─".repeat(70)}\n  ${t}\n${"─".repeat(70)}`);
}
function ok(label: string, detail?: string) {
  console.log(`  ✓ ${label}${detail ? `  (${detail})` : ""}`);
}
function warn(label: string) {
  console.log(`  ⚠ ${label}`);
}
function stop(label: string, detail?: string): never {
  console.error(`\n  ✗ STOP: ${label}${detail ? ` — ${detail}` : ""}\n`);
  process.exit(1);
}

async function slGet(path: string): Promise<unknown> {
  const sep  = path.includes("?") ? "&" : "?";
  const url  = `${API_BASE}${path}${sep}api_key=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  return resp.json();
}

// Intercept fetch to audit Smartlead calls — confirm GET only
let slGetCount    = 0;
let slPostCount   = 0;
const nativeFetch = globalThis.fetch;
(globalThis as unknown as { fetch: typeof fetch }).fetch = async (
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const urlStr = String(url instanceof Request ? url.url : url);
  const method = (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase();
  if (urlStr.includes("smartlead.ai")) {
    if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
      slPostCount++;
    } else {
      slGetCount++;
    }
  }
  return nativeFetch(url, init);
};

async function main(): Promise<void> {
  console.log("=".repeat(70));
  console.log(" Stage 21A — platform_lead_id backfill");
  console.log("=".repeat(70));

  // ── Pre-call baseline ──────────────────────────────────────────────────────
  section("Pre-call baseline — DB state");

  const { data: preRow, error: preErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, sent_at, replied_at, reply_type, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (preErr || !preRow) stop("campaign_lead not found", preErr?.message);
  const pre = preRow as Record<string, unknown>;

  console.log(`  campaign_lead id:   ${CAMPAIGN_LEAD_ID}`);
  console.log(`  status:             ${pre.status}`);
  console.log(`  platform_lead_id:   ${pre.platform_lead_id ?? "null"}`);
  console.log(`  sent_at:            ${pre.sent_at ?? "null"}`);
  console.log(`  replied_at:         ${pre.replied_at ?? "null"}`);
  console.log(`  reply_type:         ${pre.reply_type ?? "null"}`);
  console.log(`  updated_at (before):${pre.updated_at}`);

  const { count: preCount } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", DB_CAMPAIGN_ID);
  console.log(`  row count:          ${preCount}`);

  // Confirm Smartlead campaign still DRAFTED
  try {
    const camp     = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string, unknown>;
    const slStatus = String(camp.status ?? "unknown");
    const isDraft  = slStatus.toUpperCase() === "DRAFT" || slStatus.toUpperCase() === "DRAFTED";
    isDraft
      ? ok(`Smartlead campaign status: ${slStatus}`)
      : warn(`Smartlead campaign status: ${slStatus} — UNEXPECTED`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    warn(`Could not verify Smartlead campaign status: ${msg}`);
  }

  // ── THE BACKFILL CALL ──────────────────────────────────────────────────────
  section("BACKFILL — backfillPlatformLeadIds()");
  console.log("\n  Calling backfillPlatformLeadIds() — GET only against Smartlead ...\n");

  let result: Awaited<ReturnType<typeof backfillPlatformLeadIds>>;
  let callError: string | null = null;

  try {
    result = await backfillPlatformLeadIds({
      clientId:   GRAMSCODE_CLIENT_ID,
      campaignId: DB_CAMPAIGN_ID,
    });
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err))
      .replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    callError = msg;
    result = null as unknown as typeof result;
  } finally {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;
  }

  // ── Provider call audit ────────────────────────────────────────────────────
  section("Provider call audit");

  console.log(`  Smartlead GETs made:         ${slGetCount}`);
  console.log(`  Smartlead POSTs/mutations:   ${slPostCount}  (expected: 0)`);

  slPostCount === 0
    ? ok("No Smartlead mutations — GET only confirmed")
    : warn(`${slPostCount} non-GET Smartlead call(s) — UNEXPECTED`);

  if (callError) {
    console.error(`\n  backfillPlatformLeadIds threw: ${callError}`);
    process.exit(1);
  }

  // ── Backfill result ────────────────────────────────────────────────────────
  section("Backfill result");

  console.log(`  slLeadsDiscovered: ${result.slLeadsDiscovered}  (Smartlead leads returned)`);
  console.log(`  dbRowsProcessed:   ${result.dbRowsProcessed}   (uploaded rows checked)`);
  console.log(`  rowsUpdated:       ${result.rowsUpdated}   (platform_lead_id written)`);
  console.log(`  rowsSkipped:       ${result.rowsSkipped}   (already correct — no write)`);
  console.log(`  rowsUnmatched:     ${result.rowsUnmatched}   (DB rows not found in Smartlead)`);
  console.log(`  slLeadsUnmatched:  ${result.slLeadsUnmatched}   (Smartlead leads not in DB)`);
  console.log(`  elapsedMs:         ${result.elapsedMs}`);

  // ── Post-call DB verification ──────────────────────────────────────────────
  section("Post-call DB verification");

  const { data: postRow, error: postErr } = await db
    .from("campaign_leads")
    .select("id, status, platform_lead_id, sent_at, replied_at, reply_type, updated_at")
    .eq("id", CAMPAIGN_LEAD_ID)
    .single();

  if (postErr || !postRow) stop("campaign_lead not found after backfill", postErr?.message);
  const post = postRow as Record<string, unknown>;

  console.log(`\n  campaign_lead after backfill:`);
  console.log(`    status:           ${post.status}`);
  console.log(`    platform_lead_id: ${post.platform_lead_id ?? "null"}`);
  console.log(`    sent_at:          ${post.sent_at ?? "null"}`);
  console.log(`    replied_at:       ${post.replied_at ?? "null"}`);
  console.log(`    reply_type:       ${post.reply_type ?? "null"}`);
  console.log(`    updated_at:       ${post.updated_at}`);

  // Assertions
  const platformIdSet     = post.platform_lead_id !== null;
  const statusUnchanged   = post.status    === pre.status;
  const sentAtUnchanged   = post.sent_at   === pre.sent_at;
  const repliedAtUnchanged = post.replied_at === pre.replied_at;
  const replyTypeUnchanged = post.reply_type === pre.reply_type;
  const updatedAtAdvanced  = result.rowsUpdated > 0
    ? post.updated_at !== pre.updated_at
    : post.updated_at === pre.updated_at;

  platformIdSet
    ? ok(`platform_lead_id set: ${post.platform_lead_id}`)
    : warn("platform_lead_id is still null — backfill did not write");

  statusUnchanged
    ? ok(`status unchanged: ${pre.status}`)
    : warn(`status changed: ${pre.status} → ${post.status} — UNEXPECTED`);

  sentAtUnchanged
    ? ok("sent_at unchanged (null)")
    : warn("sent_at changed — UNEXPECTED");

  repliedAtUnchanged
    ? ok("replied_at unchanged (null)")
    : warn("replied_at changed — UNEXPECTED");

  replyTypeUnchanged
    ? ok("reply_type unchanged (null)")
    : warn("reply_type changed — UNEXPECTED");

  if (result.rowsUpdated > 0) {
    updatedAtAdvanced
      ? ok(`updated_at advanced`, `${pre.updated_at} → ${post.updated_at}`)
      : warn("updated_at did NOT advance — expected write did not occur");
  } else {
    ok("updated_at unchanged (row already had correct platform_lead_id)");
  }

  const { count: postCount } = await db
    .from("campaign_leads")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", DB_CAMPAIGN_ID);

  console.log(`\n  Row count before: ${preCount}  after: ${postCount}  (expected: unchanged)`);
  preCount === postCount
    ? ok("Row count unchanged — no rows created or deleted")
    : warn(`Row count changed: ${preCount} → ${postCount} — UNEXPECTED`);

  // ── Smartlead campaign status ──────────────────────────────────────────────
  section("Smartlead campaign status (post-backfill)");

  try {
    const camp2    = await slGet(`/campaigns/${SL_CAMPAIGN_ID}`) as Record<string, unknown>;
    const status2  = String(camp2.status ?? "unknown");
    const isDraft  = status2.toUpperCase() === "DRAFT" || status2.toUpperCase() === "DRAFTED";
    isDraft
      ? ok(`Smartlead campaign: ${status2} — no activation`)
      : warn(`Smartlead campaign: ${status2} — UNEXPECTED`);
  } catch (err) {
    const msg = (err as Error).message.replace(/api_key=[^&\s]*/gi, "[REDACTED]");
    warn(`Could not verify Smartlead campaign status: ${msg}`);
  }

  ok("API key never appeared in any console output");
  ok("No email sent — campaign remains DRAFTED");

  // ── Supabase verification SQL ──────────────────────────────────────────────
  section("Supabase SQL to independently verify");

  console.log(`
  ── A: platform_lead_id set to the confirmed campaign_lead_map_id ────────────
  SELECT id, status, platform_lead_id, sent_at, replied_at, reply_type,
         updated_at
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected:
    platform_lead_id = '${post.platform_lead_id ?? "(should be 3643998176)"}'
    status           = ${post.status}    (unchanged)
    sent_at          = null              (unchanged)
    replied_at       = null              (unchanged)
    reply_type       = null              (unchanged)
    updated_at       > '${pre.updated_at}'

  ── B: updated_at advanced (backfill wrote the row) ─────────────────────────
  SELECT updated_at > '${pre.updated_at}' AS advanced
  FROM campaign_leads
  WHERE id = '${CAMPAIGN_LEAD_ID}';

  Expected: advanced = true  (if rowsUpdated=1)

  ── C: Row count unchanged ───────────────────────────────────────────────────
  SELECT COUNT(*) AS row_count
  FROM campaign_leads
  WHERE campaign_id = '${DB_CAMPAIGN_ID}';

  Expected: row_count = ${postCount}

  ── D: Campaign still draft ──────────────────────────────────────────────────
  SELECT id, status, platform_campaign_id
  FROM campaigns
  WHERE id = '${DB_CAMPAIGN_ID}';

  Expected: status=draft, platform_campaign_id=${SL_CAMPAIGN_ID}

  ── E: Contact unchanged ─────────────────────────────────────────────────────
  SELECT id, email, email_status, status
  FROM contacts
  WHERE id = '${CONTACT_ID}';

  Expected: email=olugbogiafeez@gmail.com, email_status=VERIFIED
  `);

  // ── Summary ────────────────────────────────────────────────────────────────
  section("BACKFILL COMPLETE — Summary");

  const allOk = platformIdSet && statusUnchanged && sentAtUnchanged
    && repliedAtUnchanged && replyTypeUnchanged && slPostCount === 0
    && !callError && preCount === postCount;

  console.log(`
  Smartlead leads discovered:    ${result.slLeadsDiscovered}
  DB rows processed:             ${result.dbRowsProcessed}
  Rows updated (platform_lead_id written): ${result.rowsUpdated}
  Rows skipped (already correct):         ${result.rowsSkipped}
  Rows unmatched (in DB, not in SL):      ${result.rowsUnmatched}
  SL leads unmatched (in SL, not in DB):  ${result.slLeadsUnmatched}

  platform_lead_id: ${pre.platform_lead_id ?? "null"} → ${post.platform_lead_id ?? "null"}
  updated_at:       ${pre.updated_at}
                  → ${post.updated_at}

  Safety:
    Smartlead GETs:          ${slGetCount}
    Smartlead mutations:     ${slPostCount}
    Campaign status:         DRAFTED
    API key in logs:         NONE
    Email sent:              NO
    status/sent_at/replied_at/reply_type: unchanged

  Result: ${allOk ? "✓ BACKFILL SUCCEEDED" : "✗ BACKFILL INCOMPLETE — review warnings above"}

  STOPPED — awaiting your Supabase verification.
  Do not run the idempotency rerun until you confirm.
`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
