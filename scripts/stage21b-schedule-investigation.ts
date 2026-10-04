/**
 * Stage 21B — Read-only schedule investigation.
 *
 * Investigates why the first send is ~39 hours out despite the campaign being
 * set to ACTIVE. Probes all scheduling-relevant endpoints:
 *   - Campaign object (status, start_date, schedule fields if embedded)
 *   - Campaign sequences (seq_delay_details — first-email delay)
 *   - Campaign schedule (timezone, days_of_the_week, sending window)
 *   - Campaign settings
 *   - Assigned email accounts (warmup status, send limits, daily quota)
 *   - Campaign lead roster (current lead status after activation)
 *
 * HARD CONSTRAINTS:
 *   - GET only. No POST/PUT/PATCH/DELETE.
 *   - No Supabase writes.
 *   - No campaign, sequence, sender, schedule, or lead modifications.
 *   - API key never logged.
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

if (!apiKey) { console.error("SMARTLEAD_API_KEY not set"); process.exit(1); }

// Intercept — block mutations hard
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
      throw new Error(`BLOCKED: mutation attempt (${method}) in read-only investigation`);
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

function section(t: string) {
  console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
}
function sub(label: string) { console.log(`\n  ── ${label}`); }
function row(label: string, value: unknown) {
  const v = value === null || value === undefined ? "null" : String(value);
  console.log(`  ${label.padEnd(36)} ${v}`);
}
function note(msg: string) { console.log(`  ℹ  ${msg}`); }
function warn(msg: string) { console.log(`  ⚠  ${msg}`); }
function ok(msg: string)   { console.log(`  ✓  ${msg}`); }
function printFull(obj: unknown) { console.log(JSON.stringify(obj, null, 2)); }

// Parse a time string like "08:00" into a decimal hour (8.0)
function parseHour(t: string | null | undefined): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h + (m ?? 0) / 60;
}

// Day-of-week labels (Smartlead uses 0=Sun or 1=Mon depending on version — we'll show both)
const DOW_LABELS_0SUN  = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_LABELS_1MON  = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function main(): Promise<void> {
  const now = new Date();
  console.log("=".repeat(70));
  console.log("  Stage 21B — Schedule Investigation (GET only)");
  console.log(`  Investigation time (UTC): ${now.toISOString()}`);
  console.log(`  Day of week (UTC):        ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getUTCDay()]}`);
  console.log(`  Campaign: ${SL_CAMPAIGN_ID}`);
  console.log("=".repeat(70));

  // ── 1. Full campaign object ────────────────────────────────────────────────
  section("1. Campaign object — GET /campaigns/{id}");

  const campResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}`);
  console.log(`  HTTP ${campResp.status}`);

  let campObj: Record<string, unknown> = {};
  if (campResp.status === 200) {
    campObj = campResp.body as Record<string, unknown>;

    sub("Core campaign fields");
    row("id",           campObj.id);
    row("name",         campObj.name);
    row("status",       campObj.status);
    row("created_at",   campObj.created_at);
    row("updated_at",   campObj.updated_at);
    row("start_date",   campObj.start_date);
    row("end_date",     campObj.end_date);

    sub("Schedule fields (if embedded in campaign object)");
    const schedKeys = ["timezone", "days_of_the_week", "start_hour", "end_hour",
                       "min_time_btw_emails", "max_new_leads_per_day",
                       "send_as_plain_text", "follow_up_percentage"];
    let foundScheduleFields = false;
    for (const k of schedKeys) {
      if (k in campObj) {
        row(k, campObj[k] instanceof Object ? JSON.stringify(campObj[k]) : campObj[k]);
        foundScheduleFields = true;
      }
    }
    if (!foundScheduleFields) {
      note("No schedule fields embedded in campaign object — likely in a sub-object or separate endpoint.");
    }

    sub("All top-level keys in campaign object");
    console.log(`  ${Object.keys(campObj).join(", ")}`);

    // Look for any nested schedule/settings sub-object
    for (const [key, val] of Object.entries(campObj)) {
      if (typeof val === "object" && val !== null && !Array.isArray(val) &&
          (key.includes("schedule") || key.includes("setting") || key.includes("timing"))) {
        console.log(`\n  ── Nested sub-object: ${key}`);
        printFull(val);
      }
    }

    // Show start_date analysis
    if (campObj.start_date) {
      const startDate = new Date(campObj.start_date as string);
      const diffMs = startDate.getTime() - now.getTime();
      const diffH  = diffMs / 3_600_000;
      note(`start_date is ${diffH > 0 ? diffH.toFixed(1) + "h in the future" : "in the past / now"}`);
      if (diffH > 0) warn(`Campaign has a future start_date — sends are gated until ${campObj.start_date}`);
    } else {
      note("start_date is null — no future gate from start_date");
    }
  }

  // ── 2. Campaign schedule endpoint ──────────────────────────────────────────
  section("2. Campaign schedule — GET /campaigns/{id}/schedule");

  const schedResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/schedule`);
  console.log(`  HTTP ${schedResp.status}`);

  let schedObj: Record<string, unknown> = {};
  if (schedResp.status === 200) {
    // May be array or object depending on Smartlead version
    const body = schedResp.body;
    const schedData = Array.isArray(body) ? body[0] : body;
    schedObj = (schedData ?? {}) as Record<string, unknown>;
    printFull(schedData);
  } else {
    note(`Schedule endpoint returned ${schedResp.status} — schedule may be embedded elsewhere.`);
    // Try alternate path
    const altResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/settings`);
    if (altResp.status === 200) {
      note("Falling back to /settings endpoint:");
      const settingsBody = altResp.body;
      printFull(settingsBody);
      if (settingsBody && typeof settingsBody === "object") {
        schedObj = settingsBody as Record<string, unknown>;
      }
    }
  }

  // Analyse schedule if we found it
  const timezone  = (schedObj.timezone ?? campObj.timezone ?? null) as string | null;
  const startHour = (schedObj.start_hour ?? campObj.start_hour ?? null) as string | null;
  const endHour   = (schedObj.end_hour   ?? campObj.end_hour   ?? null) as string | null;
  const daysRaw   = (schedObj.days_of_the_week ?? campObj.days_of_the_week ?? null);
  const minGap    = (schedObj.min_time_btw_emails ?? campObj.min_time_btw_emails ?? null);
  const maxLeads  = (schedObj.max_new_leads_per_day ?? campObj.max_new_leads_per_day ?? null);

  if (timezone || startHour || endHour || daysRaw) {
    sub("Schedule analysis");
    row("timezone",             timezone);
    row("start_hour",           startHour);
    row("end_hour",             endHour);
    row("min_time_btw_emails",  minGap);
    row("max_new_leads_per_day", maxLeads);

    if (Array.isArray(daysRaw)) {
      const days0 = (daysRaw as number[]).map((d) => DOW_LABELS_0SUN[d] ?? d).join(", ");
      const days1 = (daysRaw as number[]).map((d) => DOW_LABELS_1MON[d - 1] ?? d).join(", ");
      row("days_of_the_week (raw)", JSON.stringify(daysRaw));
      row("  interpreted (0=Sun)", days0);
      row("  interpreted (1=Mon)", days1);
    }

    // Compute next window open time
    if (timezone && startHour && endHour && Array.isArray(daysRaw)) {
      sub("Next send window computation");

      // Try to figure out current time in campaign timezone
      try {
        const nowInTz = new Date(now.toLocaleString("en-US", { timeZone: timezone }));
        const tzOffset = (now.getTime() - nowInTz.getTime()) / 3_600_000;
        const nowHour  = nowInTz.getHours() + nowInTz.getMinutes() / 60;
        const nowDow   = nowInTz.getDay(); // 0=Sun

        const startH = parseHour(startHour) ?? 8;
        const endH   = parseHour(endHour)   ?? 17;
        const days   = daysRaw as number[];

        note(`Current time in ${timezone}: ${nowInTz.toLocaleTimeString("en-US", { hour12: false })} (${DOW_LABELS_0SUN[nowDow]})`);
        note(`Send window: ${startHour}–${endHour} on days ${JSON.stringify(days)}`);

        // Is right now inside the window?
        const inWindow = days.includes(nowDow) && nowHour >= startH && nowHour < endH;
        note(`Window currently open: ${inWindow ? "YES" : "NO"}`);

        if (!inWindow) {
          // Find next open moment
          let daysToNext = 0;
          let checked = 0;
          let candidateDow = nowDow;
          let candidateHour = startH;

          while (checked <= 7) {
            if (days.includes(candidateDow)) {
              if (checked === 0 && nowHour < endH) {
                // Today has window time remaining (after start_hour)
                if (nowHour < startH) {
                  // Window hasn't opened yet today
                  candidateHour = startH;
                  break;
                }
              } else if (checked > 0) {
                candidateHour = startH;
                break;
              }
            }
            checked++;
            daysToNext++;
            candidateDow = (candidateDow + 1) % 7;
          }

          const nextWindowMs = daysToNext * 86_400_000 +
            (candidateHour - (checked === 0 ? nowHour : 0)) * 3_600_000;
          const nextWindowH  = nextWindowMs / 3_600_000;
          const nextOpenUtc  = new Date(now.getTime() + nextWindowMs);

          note(`Next window opens in ~${nextWindowH.toFixed(1)}h (${nextOpenUtc.toISOString()} UTC)`);
          note(`Day: ${DOW_LABELS_0SUN[candidateDow]}, hour: ${candidateHour}:00 ${timezone}`);

          if (Math.abs(nextWindowH - 39) < 4) {
            warn(`⟹  This matches the ~39h "Next Email In" — sending blocked until window opens`);
          }
        } else {
          note("Window IS currently open — delay not explained by schedule window alone.");
          note("Check sequence delay, inbox warmup, or max_new_leads_per_day instead.");
        }
      } catch (e) {
        note(`Could not compute timezone offset: ${(e as Error).message}`);
      }
    }
  }

  // ── 3. Sequences — first-email delay ──────────────────────────────────────
  section("3. Campaign sequences — GET /campaigns/{id}/sequences");

  const seqResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/sequences`);
  console.log(`  HTTP ${seqResp.status}`);

  if (seqResp.status === 200) {
    const seqData = seqResp.body;
    printFull(seqData);

    // Extract first sequence delay
    const sequences = Array.isArray(seqData) ? seqData : [];
    if (sequences.length > 0) {
      sub("Sequence delay analysis");
      for (const seq of sequences as Record<string, unknown>[]) {
        const seqNum   = seq.seq_number ?? seq.sequence_number ?? "?";
        const delay    = seq.seq_delay_details ?? seq.delay_details ?? {};
        const delayObj = typeof delay === "object" && delay !== null
          ? delay as Record<string, unknown> : {};
        const delayDays = delayObj.delay_in_days ?? delayObj.days ?? null;

        row(`Seq ${seqNum} — delay_in_days`, delayDays);

        if (Number(delayDays) > 0) {
          warn(`Sequence ${seqNum} has delay_in_days=${delayDays} — first email is deferred by ${delayDays} day(s) from enrollment`);
        } else {
          ok(`Sequence ${seqNum}: delay_in_days=${delayDays ?? 0} — no artificial delay`);
        }
      }
    } else {
      note("No sequences array or empty array returned.");
    }
  } else {
    note(`Sequences endpoint returned ${seqResp.status}`);
    printFull(seqResp.body);
  }

  // ── 4. Email accounts assigned to campaign ─────────────────────────────────
  section("4. Assigned email accounts — GET /campaigns/{id}/email-accounts");

  const inboxResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/email-accounts`);
  console.log(`  HTTP ${inboxResp.status}`);

  if (inboxResp.status === 200) {
    const inboxData = inboxResp.body;
    const inboxes = Array.isArray(inboxData) ? inboxData : [];
    note(`${inboxes.length} email account(s) assigned to campaign`);

    if (inboxes.length === 0) {
      warn("NO email accounts assigned — campaign cannot send without a sender inbox");
    }

    for (const inbox of inboxes as Record<string, unknown>[]) {
      const inboxId    = inbox.id ?? inbox.email_account_id ?? "?";
      const email      = inbox.from_email ?? inbox.email ?? "?";
      const smtpOk     = inbox.is_smtp_success ?? inbox.smtp_success ?? null;
      const imapOk     = inbox.is_imap_success ?? inbox.imap_success ?? null;
      const msgPerDay  = inbox.message_per_day ?? inbox.daily_limit ?? null;
      const sentToday  = inbox.daily_sent_count ?? null;
      const warmup     = inbox.warmup_details ?? {};
      const wObj       = typeof warmup === "object" && warmup !== null
        ? warmup as Record<string, unknown> : {};
      const wStatus    = wObj.status ?? wObj.warmup_status ?? null;
      const wBlocked   = wObj.is_warmup_blocked ?? null;
      const wRep       = wObj.warmup_reputation ?? null;
      const wMaxPerDay = wObj.max_email_per_day ?? null;

      sub(`Inbox: ${email} (id: ${inboxId})`);
      row("  smtp_ok",              smtpOk);
      row("  imap_ok",              imapOk);
      row("  message_per_day",      msgPerDay);
      row("  daily_sent_count",     sentToday);
      row("  warmup.status",        wStatus);
      row("  warmup.is_blocked",    wBlocked);
      row("  warmup.reputation",    wRep);
      row("  warmup.max_per_day",   wMaxPerDay);

      const quota = Number(msgPerDay ?? 0);
      const used  = Number(sentToday ?? 0);
      if (quota > 0 && used >= quota) {
        warn(`Daily send quota exhausted (${used}/${quota}) — no more sends today`);
      } else if (quota > 0) {
        ok(`Quota available: ${used}/${quota} used today`);
      }

      if (wBlocked === true) {
        warn("Warmup is blocked — inbox cannot send while warmup is blocked");
      }

      if (!smtpOk) warn("SMTP not healthy — inbox may not be able to send");
      if (!imapOk) warn("IMAP not healthy — replies may not be received");
    }

    sub("Full inbox account response");
    printFull(inboxData);
  } else {
    note(`Email-accounts endpoint returned ${inboxResp.status}`);
    printFull(inboxResp.body);
  }

  // ── 5. Lead status post-activation ────────────────────────────────────────
  section("5. Campaign lead roster post-activation — GET /campaigns/{id}/leads");

  const leadsResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/leads?offset=0&limit=10`);
  console.log(`  HTTP ${leadsResp.status}`);

  if (leadsResp.status === 200) {
    const leadsBody = leadsResp.body as Record<string, unknown>;
    const leads = Array.isArray(leadsBody.data) ? leadsBody.data : [];
    row("total_leads",  leadsBody.total_leads);
    row("leads on page", leads.length);

    for (const lead of leads as Record<string, unknown>[]) {
      const mapId  = lead.campaign_lead_map_id ?? "?";
      const status = lead.status ?? "?";
      const catId  = lead.lead_category_id;
      const sentAt = lead.sent_at;
      const repAt  = lead.replied_at;
      const rpType = lead.reply_type;

      sub(`Lead ${mapId}`);
      row("  status",            status);
      row("  lead_category_id",  catId);
      row("  sent_at",           sentAt);
      row("  replied_at",        repAt);
      row("  reply_type",        rpType);

      // Check for new fields that weren't present before activation
      const knownFields = new Set(["campaign_lead_map_id", "lead_category_id", "status",
                                    "created_at", "lead", "sent_at", "replied_at",
                                    "bounced_at", "unsubscribed_at", "reply_type"]);
      const newFields = Object.keys(lead).filter((k) => !knownFields.has(k));
      if (newFields.length > 0) {
        note(`New top-level fields not seen pre-activation: ${newFields.join(", ")}`);
        for (const f of newFields) row(`  ${f}`, lead[f]);
      }

      if (status === "STARTED") {
        note('Status still "STARTED" — lead is enrolled but sequence has not begun sending yet');
      } else if (status !== "STARTED") {
        warn(`Status changed from STARTED to "${status}" — sequence has progressed`);
      }
    }
  } else {
    note(`Leads endpoint returned ${leadsResp.status}`);
    printFull(leadsResp.body);
  }

  // ── 6. Campaign analytics post-activation ─────────────────────────────────
  section("6. Campaign analytics post-activation — GET /campaigns/{id}/analytics");

  const anaResp = await rawGet(`/campaigns/${SL_CAMPAIGN_ID}/analytics`);
  console.log(`  HTTP ${anaResp.status}`);

  if (anaResp.status === 200) {
    const a = anaResp.body as Record<string, unknown>;
    row("campaign_status",  a.campaign_status);
    row("sent_count",       a.sent_count ?? 0);
    row("open_count",       a.open_count ?? 0);
    row("reply_count",      a.reply_count ?? 0);
    row("bounce_count",     a.bounce_count ?? 0);
    row("leads_count",      a.leads_count);

    sub("Full analytics object");
    printFull(a);
  }

  // ── 7. Restore + summary ───────────────────────────────────────────────────
  (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;

  section("INVESTIGATION COMPLETE — Findings summary");

  console.log(`
  Investigation time (UTC): ${now.toISOString()}
  Day (UTC):                ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getUTCDay()]}

  Smartlead GETs:      ${slGetCount}
  Smartlead mutations: ${slMutCount}  (expected: 0)

  STOPPED — no campaign, sequence, sender, schedule, or lead modified.
`);
}

main().catch((err: unknown) => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = nativeFetch;
  const msg = err instanceof Error ? err.message : String(err);
  console.error("\nUnhandled:", msg.replace(/api_key=[^&\s]*/gi, "[REDACTED]"));
  process.exit(1);
});
