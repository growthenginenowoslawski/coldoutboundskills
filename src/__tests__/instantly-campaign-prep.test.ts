/**
 * instantly-campaign-prep — pure-logic tests. No network, no files, no keys.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCsv, parseYaml } from "../../skills/instantly-campaign-prep/scripts/parsers";
import {
  convertVariables, estimateCapacity, extractVariables, findUnfilledVariables,
  parseSequence, prepareLeads, renderChecklist, renderSequenceMd, sequenceText, toCsv,
} from "../../skills/instantly-campaign-prep/scripts/lib";

const H = ["email", "first_name", "last_name", "company_name", "situation_line"];
const row = (email: string, extra: Record<string, string> = {}) => ({
  email, first_name: "Sam", last_name: "Lee", company_name: "Acme", situation_line: "saw your launch", ...extra,
});

const YAML = `
name: "Test campaign"
schedule:
  timezone: Europe/London
  days: [1, 2, 3, 4, 5]
  start_hour: "08:00"
  end_hour: "17:00"
  min_time_btw_emails: 10
  max_leads_per_day: 30
inbox_selection:
  tag: active
  count: 20
sequences:
  - step: 1
    delay_days: 0
    variants:
      - label: A
        subject: "Quick idea for {{company_name}}"
        body: "Hi {{first_name}}, {{situation_line}}."
      - label: B
        subject: "{{first_name}}, a thought"
        body: "Hi {{first_name}}, different angle."
  - step: 2
    delay_days: 3
    variants:
      - label: A
        subject: ""
        body: "Following up, {{first_name}}."
`;

const seq = () => {
  const r = parseSequence(parseYaml(YAML));
  assert.deepEqual(r.errors, []);
  return r.sequence!;
};

// ── leads ─────────────────────────────────────────────────────────────────────

test("prepareLeads: clean list passes through, emails lowercased", () => {
  const r = prepareLeads(H, [row("A@X.com"), row("b@x.com")]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows.map((x) => x.email), ["a@x.com", "b@x.com"]);
});

test("prepareLeads: drops blank, invalid and duplicate emails with counts", () => {
  const r = prepareLeads(H, [row("a@x.com"), row(""), row("not-an-email"), row("A@x.com"), row("a b@x.com"), row("c@x.io")]);
  assert.deepEqual(r.rows.map((x) => x.email), ["a@x.com", "c@x.io"]);
  assert.deepEqual(r.dropped, { blankEmail: 1, invalidEmail: 2, duplicate: 1 });
  assert.equal(r.warnings.length, 3);
});

test("prepareLeads: missing required columns is an error and yields no rows", () => {
  const r = prepareLeads(["email", "first_name"], [{ email: "a@x.com", first_name: "A" }]);
  assert.match(r.errors[0], /last_name, company_name/);
  assert.equal(r.rows.length, 0);
});

test("prepareLeads: duplicate headers and empty result are errors; blank first names warn", () => {
  assert.ok(prepareLeads([...H, "email"], [row("a@x.com")]).errors.some((e) => /duplicate column/.test(e)));
  assert.ok(prepareLeads(H, [row("")]).errors.some((e) => /No usable leads/.test(e)));
  assert.ok(prepareLeads(H, [row("a@x.com", { first_name: " " })]).warnings.some((w) => /empty first_name/.test(w)));
});

test("toCsv: quotes commas, quotes and newlines; round-trips through parseCsv", () => {
  const rows = [row("a@x.com", { company_name: 'Acme, "Inc"', situation_line: "line one" })];
  const csv = toCsv(H, rows);
  assert.ok(csv.includes('"Acme, ""Inc"""'));
  const back = parseCsv(csv);
  assert.deepEqual(back.headers, H);
  assert.equal(back.rows[0].company_name, 'Acme, "Inc"');
});

// ── variables ─────────────────────────────────────────────────────────────────

test("extractVariables: finds unique names, tolerates spaces", () => {
  assert.deepEqual(extractVariables("Hi {{first_name}} {{ first_name }} {{situation_line}}"), ["first_name", "situation_line"]);
  assert.deepEqual(extractVariables("no variables {here} {a|b}"), []);
});

test("convertVariables: camel and snake styles; custom names untouched", () => {
  const t = "{{first_name}} {{last_name}} {{company_name}} {{situation_line}}";
  assert.equal(convertVariables(t, "camel"), "{{firstName}} {{lastName}} {{companyName}} {{situation_line}}");
  assert.equal(convertVariables("{{firstName}}", "snake"), "{{first_name}}");
  assert.equal(convertVariables("{{ first_name }}", "camel"), "{{firstName}}");
});

test("findUnfilledVariables: standard fields satisfied in either style; missing custom flagged", () => {
  assert.deepEqual(findUnfilledVariables(["first_name", "firstName", "situation_line"], H), []);
  assert.deepEqual(findUnfilledVariables(["value_line", "firstName"], H), ["value_line"]);
  assert.deepEqual(findUnfilledVariables(["firstName"], ["email"]), ["firstName"]);
});

// ── sequence ──────────────────────────────────────────────────────────────────

test("parseSequence: valid yaml parses steps, variants, schedule and inboxes", () => {
  const s = seq();
  assert.equal(s.name, "Test campaign");
  assert.equal(s.steps.length, 2);
  assert.deepEqual(s.steps[0].variants.map((v) => v.label), ["A", "B"]);
  assert.equal(s.steps[1].delayDays, 3);
  assert.equal(s.schedule.timezone, "Europe/London");
  assert.deepEqual(s.inboxSelection, { tag: "active", count: 20 });
});

test("parseSequence: reports specific problems", () => {
  const bad = (y: string) => parseSequence(parseYaml(y)).errors.join(" | ");
  assert.match(bad("foo: bar"), /name.*required/);
  assert.match(bad("name: x\nsequences: []"), /at least one step/);
  assert.match(
    bad(`name: x
sequences:
  - step: 1
    delay_days: 2
    variants:
      - label: A
        subject: "s"
        body: "b"`),
    /delay_days: 0/,
  );
  assert.match(
    bad(`name: x
sequences:
  - step: 1
    delay_days: 0
    variants:
      - label: A
        subject: ""
        body: "b"`),
    /subject is required/,
  );
  assert.match(
    bad(`name: x
sequences:
  - step: 1
    delay_days: 0
    variants:
      - label: D
        subject: "s"
        body: ""`),
    /label must be A, B or C.*body is empty|body is empty.*label must be A, B or C/,
  );
});

test("parseSequence: non-mapping document is rejected", () => {
  assert.match(parseSequence(null).errors[0], /empty or not a mapping/);
});

test("sequence variables can be checked against the CSV end to end", () => {
  const used = [...new Set(sequenceText(seq()).flatMap(extractVariables))];
  assert.deepEqual(used.sort(), ["company_name", "first_name", "situation_line"]);
  assert.deepEqual(findUnfilledVariables(used, H), []);
  assert.deepEqual(findUnfilledVariables(used, ["email", "first_name", "last_name", "company_name"]), ["situation_line"]);
});

// ── rendering ─────────────────────────────────────────────────────────────────

test("renderSequenceMd: converts variables, labels variants, marks threaded follow-ups", () => {
  const md = renderSequenceMd(seq(), "camel");
  assert.ok(md.includes("Hi {{firstName}}, {{situation_line}}."));
  assert.ok(md.includes("### Variant A") && md.includes("### Variant B"));
  assert.ok(md.includes("## Step 2 — wait 3 day(s) after step 1"));
  assert.ok(md.includes("blank — sends as a reply"));
  assert.ok(!md.includes("{{first_name}}"));
  assert.ok(renderSequenceMd(seq(), "snake").includes("{{first_name}}"));
});

test("estimateCapacity and renderChecklist use schedule + inbox settings", () => {
  const s = seq();
  assert.deepEqual(estimateCapacity(s, 1200), { perDay: 600, daysToFirstTouch: 2 });
  const cl = renderChecklist(s, 1200, "camel");
  assert.ok(cl.includes("Europe/London") && cl.includes("Mon/Tue/Wed/Thu/Fri"));
  assert.ok(cl.includes("1200 leads"));
  assert.ok(cl.includes("about 2 day(s)"));
  assert.ok(cl.includes("--var-style=snake"));
  assert.ok(cl.includes("Nothing here has been sent"));
});

test("estimateCapacity: null when inbox count or daily limit is unknown", () => {
  const s = seq();
  s.inboxSelection.count = null;
  assert.equal(estimateCapacity(s, 100), null);
  assert.ok(renderChecklist(s, 100, "camel").includes("finished warmup"));
});
