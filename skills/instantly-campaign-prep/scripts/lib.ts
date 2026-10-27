/**
 * Pure helpers for instantly-campaign-prep. No network, no env, no file I/O,
 * so everything here is unit-testable (see src/__tests__/instantly-campaign-prep.test.ts).
 *
 * Output is meant to be imported by hand in the Instantly UI. Nothing here
 * talks to Instantly.
 *
 * UNVALIDATED ASSUMPTION: Instantly's merge-variable names. The default
 * ("camel") renders standard lead fields as {{firstName}} / {{lastName}} /
 * {{companyName}}; custom columns keep their header name. If the Instantly
 * preview shows raw braces, re-run with --var-style=snake.
 */

import type { YamlValue } from "./parsers";

// ── Types ─────────────────────────────────────────────────────────────────────

export type VarStyle = "camel" | "snake";

export const REQUIRED_COLS = ["email", "first_name", "last_name", "company_name"] as const;

/** Standard lead fields and the merge variable used for them in each style. */
const STANDARD_VARS: Record<string, { camel: string; snake: string }> = {
  first_name:   { camel: "firstName",   snake: "first_name" },
  last_name:    { camel: "lastName",    snake: "last_name" },
  company_name: { camel: "companyName", snake: "company_name" },
  email:        { camel: "email",       snake: "email" },
};

export interface Variant { label: string; subject: string; body: string }
export interface Step { step: number; delayDays: number; variants: Variant[] }
export interface Schedule {
  timezone: string; days: number[]; startHour: string; endHour: string;
  minTimeBetweenEmails: number | null; maxLeadsPerDay: number | null;
}
export interface InboxSelection { tag: string | null; count: number | null }
export interface Sequence {
  name: string; schedule: Schedule; inboxSelection: InboxSelection; steps: Step[];
}

export interface LeadReport {
  headers: string[];
  rows: Record<string, string>[];
  errors: string[];
  warnings: string[];
  dropped: { blankEmail: number; invalidEmail: number; duplicate: number };
}

// ── Leads ─────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

export function prepareLeads(headers: string[], rows: Record<string, string>[]): LeadReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dropped = { blankEmail: 0, invalidEmail: 0, duplicate: 0 };

  const missing = REQUIRED_COLS.filter((c) => !headers.includes(c));
  if (missing.length) {
    errors.push(`leads.csv is missing required column(s): ${missing.join(", ")}`);
    return { headers, rows: [], errors, warnings, dropped };
  }

  const dupHeaders = headers.filter((h, i) => headers.indexOf(h) !== i);
  if (dupHeaders.length) errors.push(`leads.csv has duplicate column header(s): ${[...new Set(dupHeaders)].join(", ")}`);

  const seen = new Set<string>();
  const out: Record<string, string>[] = [];
  for (const row of rows) {
    const email = (row.email ?? "").trim().toLowerCase();
    if (!email) { dropped.blankEmail++; continue; }
    if (!EMAIL_RE.test(email)) { dropped.invalidEmail++; continue; }
    if (seen.has(email)) { dropped.duplicate++; continue; }
    seen.add(email);
    out.push({ ...row, email });
  }

  if (dropped.blankEmail) warnings.push(`${dropped.blankEmail} row(s) dropped: blank email`);
  if (dropped.invalidEmail) warnings.push(`${dropped.invalidEmail} row(s) dropped: invalid email format`);
  if (dropped.duplicate) warnings.push(`${dropped.duplicate} row(s) dropped: duplicate email`);
  if (out.length === 0 && errors.length === 0) errors.push("No usable leads remain after cleaning.");

  const blankNames = out.filter((r) => !(r.first_name ?? "").trim()).length;
  if (blankNames) warnings.push(`${blankNames} lead(s) have an empty first_name — "Hi ," will render for them`);

  return { headers, rows: out, errors, warnings, dropped };
}

/** RFC-4180 style writer: quotes fields containing commas, quotes or newlines. */
export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const esc = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [headers.map(esc).join(",")];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h] ?? "")).join(","));
  return lines.join("\n") + "\n";
}

// ── Merge variables ───────────────────────────────────────────────────────────

const VAR_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

export function extractVariables(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) found.add(m[1]);
  return [...found];
}

/** Converts {{first_name}} etc. to the chosen style. Unknown names pass through untouched. */
export function convertVariables(text: string, style: VarStyle): string {
  return text.replace(VAR_RE, (_all, name: string) => {
    const std = STANDARD_VARS[name]
      ?? Object.values(STANDARD_VARS).find((v) => v.camel === name || v.snake === name);
    return `{{${std ? std[style] : name}}}`;
  });
}

/**
 * Variables used in the copy that no CSV column can fill. A variable is
 * satisfied by a header of the same name or by a standard field in either style.
 */
export function findUnfilledVariables(used: string[], headers: string[]): string[] {
  const available = new Set(headers);
  for (const [snake, v] of Object.entries(STANDARD_VARS)) {
    if (headers.includes(snake)) { available.add(v.camel); available.add(v.snake); }
  }
  return used.filter((u) => !available.has(u));
}

// ── Sequence ──────────────────────────────────────────────────────────────────

function asObj(v: YamlValue | undefined): Record<string, YamlValue> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}
const str = (v: YamlValue | undefined): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const numOrNull = (v: YamlValue | undefined): number | null => (typeof v === "number" ? v : null);

export function parseSequence(doc: YamlValue): { sequence?: Sequence; errors: string[] } {
  const errors: string[] = [];
  const root = asObj(doc);
  if (!root) return { errors: ["variants.yaml is empty or not a mapping"] };

  const name = str(root.name).trim();
  if (!name) errors.push("variants.yaml: `name` is required");

  const sch = asObj(root.schedule) ?? {};
  const days = Array.isArray(sch.days) ? sch.days.filter((d): d is number => typeof d === "number") : [1, 2, 3, 4, 5];
  if (days.some((d) => d < 1 || d > 7)) errors.push("variants.yaml: schedule.days must be 1 (Mon) to 7 (Sun)");
  const schedule: Schedule = {
    timezone: str(sch.timezone) || "America/New_York",
    days,
    startHour: str(sch.start_hour) || "08:00",
    endHour: str(sch.end_hour) || "17:00",
    minTimeBetweenEmails: numOrNull(sch.min_time_btw_emails),
    maxLeadsPerDay: numOrNull(sch.max_leads_per_day),
  };

  const inb = asObj(root.inbox_selection) ?? {};
  const inboxSelection: InboxSelection = { tag: str(inb.tag) || null, count: numOrNull(inb.count) };

  const stepsRaw = Array.isArray(root.sequences) ? root.sequences : [];
  if (stepsRaw.length === 0) errors.push("variants.yaml: `sequences` needs at least one step");

  const steps: Step[] = [];
  stepsRaw.forEach((s, i) => {
    const so = asObj(s);
    if (!so) { errors.push(`sequences[${i}] is not a mapping`); return; }
    const step = typeof so.step === "number" ? so.step : i + 1;
    if (step !== i + 1) errors.push(`sequences[${i}]: step numbers must run 1,2,3… (got ${step})`);
    const delayDays = typeof so.delay_days === "number" ? so.delay_days : 0;
    if (i === 0 && delayDays !== 0) errors.push("step 1 must have delay_days: 0");
    if (delayDays < 0) errors.push(`step ${step}: delay_days cannot be negative`);

    const vRaw = Array.isArray(so.variants) ? so.variants : [];
    if (vRaw.length === 0) errors.push(`step ${step}: needs at least one variant`);
    if (vRaw.length > 3) errors.push(`step ${step}: at most 3 variants (A/B/C)`);
    const variants: Variant[] = [];
    const labels = new Set<string>();
    vRaw.forEach((v, j) => {
      const vo = asObj(v);
      if (!vo) { errors.push(`step ${step} variant ${j + 1} is not a mapping`); return; }
      const label = str(vo.label).trim().toUpperCase() || String.fromCharCode(65 + j);
      if (!["A", "B", "C"].includes(label)) errors.push(`step ${step}: variant label must be A, B or C (got "${label}")`);
      if (labels.has(label)) errors.push(`step ${step}: duplicate variant label ${label}`);
      labels.add(label);
      const body = str(vo.body);
      if (!body.trim()) errors.push(`step ${step} variant ${label}: body is empty`);
      const subject = str(vo.subject);
      if (step === 1 && !subject.trim()) errors.push(`step 1 variant ${label}: subject is required on the first email`);
      variants.push({ label, subject, body });
    });
    steps.push({ step, delayDays, variants });
  });

  if (errors.length) return { errors };
  return { sequence: { name, schedule, inboxSelection, steps }, errors };
}

export function sequenceText(seq: Sequence): string[] {
  return seq.steps.flatMap((s) => s.variants.flatMap((v) => [v.subject, v.body]));
}

export function renderSequenceMd(seq: Sequence, style: VarStyle): string {
  const out: string[] = [
    `# ${seq.name} — sequence for Instantly`,
    "",
    `Variable style: \`${style}\`. Paste each subject and body into the matching step in the Instantly sequence editor.`,
    "",
  ];
  for (const s of seq.steps) {
    out.push(`## Step ${s.step}${s.step === 1 ? " (sends first)" : ` — wait ${s.delayDays} day(s) after step ${s.step - 1}`}`, "");
    for (const v of s.variants) {
      if (s.variants.length > 1) out.push(`### Variant ${v.label}`, "");
      const subj = convertVariables(v.subject, style);
      out.push(
        subj ? `**Subject:** ${subj}` : "**Subject:** _(blank — sends as a reply in the same thread)_",
        "",
        "```",
        convertVariables(v.body, style),
        "```",
        "",
      );
    }
  }
  return out.join("\n");
}

// ── Capacity + checklist ──────────────────────────────────────────────────────

export function estimateCapacity(seq: Sequence, leadCount: number): { perDay: number; daysToFirstTouch: number } | null {
  const inboxes = seq.inboxSelection.count;
  const perInbox = seq.schedule.maxLeadsPerDay;
  if (!inboxes || !perInbox) return null;
  const perDay = inboxes * perInbox;
  return { perDay, daysToFirstTouch: Math.ceil(leadCount / perDay) };
}

const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function renderChecklist(seq: Sequence, leadCount: number, style: VarStyle): string {
  const cap = estimateCapacity(seq, leadCount);
  const s = seq.schedule;
  const lines = [
    `# Review before you launch — ${seq.name}`,
    "",
    "Nothing here has been sent. Do these in the Instantly UI, in order. Press Launch only at the end.",
    "",
    "## 1. Create the campaign",
    `- [ ] New campaign named **${seq.name}**`,
    `- [ ] Import \`leads-instantly.csv\` (${leadCount} leads). Map \`email\`, first/last name, company; every other column becomes a custom variable.`,
    "",
    "## 2. Sequence",
    `- [ ] Paste each step from \`sequence.md\` (${seq.steps.length} step(s)).`,
    `- [ ] Use the preview on a real lead: names and custom lines must render, with no raw \`{{ }}\` showing.`,
    `- [ ] If raw braces show, the variable style is wrong. Re-run with \`--var-style=${style === "camel" ? "snake" : "camel"}\`.`,
    "",
    "## 3. Schedule",
    `- [ ] Timezone **${s.timezone}**, days **${s.days.map((d) => DAY_NAMES[d]).join("/")}**, **${s.startHour}–${s.endHour}**`,
  ];
  if (s.minTimeBetweenEmails != null) lines.push(`- [ ] At least ${s.minTimeBetweenEmails} minutes between emails`);
  if (s.maxLeadsPerDay != null) lines.push(`- [ ] Daily limit about ${s.maxLeadsPerDay} per inbox`);
  lines.push("", "## 4. Inboxes");
  if (seq.inboxSelection.count != null) {
    lines.push(`- [ ] Attach about **${seq.inboxSelection.count}** warmed-up inboxes${seq.inboxSelection.tag ? ` (tagged \`${seq.inboxSelection.tag}\`)` : ""}`);
  } else {
    lines.push("- [ ] Attach only inboxes that have finished warmup (about 2 weeks)");
  }
  lines.push("- [ ] Confirm every attached inbox shows as connected and healthy");
  if (cap) {
    lines.push(`- Capacity: about ${cap.perDay} new leads/day, so the first email reaches everyone in about ${cap.daysToFirstTouch} day(s).`);
  }
  lines.push(
    "",
    "## 5. Settings",
    "- [ ] Stop sending to a lead when they reply",
    "- [ ] Open tracking off, link tracking off (better deliverability for cold email)",
    "- [ ] Include an unsubscribe option appropriate to your market",
    "",
    "## 6. Before Launch",
    "- [ ] Send a test email to your own inbox and check it lands in Primary, not Spam",
    "- [ ] SPF, DKIM and DMARC present on every sending domain (run `/email-deliverability-audit`)",
    "- [ ] Reread the first email once, as the recipient",
    "",
    "## After launch",
    "- Wait 21 days, then run `/positive-reply-scoring`.",
    "- For a real A/B test, use two campaigns, not variants inside one (see `/experiment-design`).",
    "",
  );
  return lines.join("\n");
}
