#!/usr/bin/env tsx
/**
 * Turn variants.yaml + leads.csv into files you import by hand in the Instantly UI.
 *
 * Makes NO network calls, reads NO API keys, and never touches Instantly.
 *
 * Usage:
 *   npx tsx skills/instantly-campaign-prep/scripts/prep.ts \
 *     --leads=profiles/<slug>/campaigns/<campaign>/leads.csv \
 *     --variants=profiles/<slug>/campaigns/<campaign>/variants.yaml
 *
 * Optional:
 *   --out=DIR              default: <variants dir>/instantly
 *   --var-style=camel|snake  default camel ({{firstName}}); use snake if the Instantly preview shows raw braces
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseCsv, parseYaml } from "./parsers";
import {
  extractVariables, findUnfilledVariables, parseSequence,
  prepareLeads, renderChecklist, renderSequenceMd, sequenceText, toCsv, type VarStyle,
} from "./lib";

function arg(name: string): string | undefined {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split("=").slice(1).join("=") : undefined;
}

function fail(msg: string, extra: string[] = []): never {
  console.error(`✗ ${msg}`);
  for (const e of extra) console.error(`  - ${e}`);
  process.exit(1);
}

const leadsPath = arg("leads");
const variantsPath = arg("variants");
if (!leadsPath || !variantsPath) fail("Usage: prep.ts --leads=leads.csv --variants=variants.yaml [--out=DIR] [--var-style=camel|snake]");

const style = (arg("var-style") ?? "camel") as VarStyle;
if (style !== "camel" && style !== "snake") fail(`--var-style must be camel or snake (got "${style}")`);

let csvText: string, yamlText: string;
try { csvText = readFileSync(resolve(leadsPath!), "utf8"); } catch { fail(`Cannot read leads file: ${leadsPath}`); }
try { yamlText = readFileSync(resolve(variantsPath!), "utf8"); } catch { fail(`Cannot read variants file: ${variantsPath}`); }

const { headers, rows } = parseCsv(csvText!);
const leads = prepareLeads(headers, rows);

let doc;
try { doc = parseYaml(yamlText!); } catch (e) { fail(`variants.yaml could not be parsed: ${(e as Error).message}`); }
const parsed = parseSequence(doc!);

const errors = [...leads.errors, ...parsed.errors];
const warnings = [...leads.warnings];

if (parsed.sequence) {
  const used = [...new Set(sequenceText(parsed.sequence).flatMap(extractVariables))];
  const unfilled = findUnfilledVariables(used, headers);
  if (unfilled.length) {
    errors.push(`Copy uses variable(s) with no matching CSV column: ${unfilled.map((u) => `{{${u}}}`).join(", ")}`);
  }
  const unusedCols = headers.filter((h) => !["email", "first_name", "last_name", "company_name"].includes(h) && !used.includes(h));
  if (unusedCols.length) warnings.push(`CSV column(s) not used in the copy: ${unusedCols.join(", ")}`);
}

if (errors.length) fail("Not ready to import:", errors);

const seq = parsed.sequence!;
const outDir = resolve(arg("out") ?? join(dirname(resolve(variantsPath!)), "instantly"));
mkdirSync(outDir, { recursive: true });

writeFileSync(join(outDir, "leads-instantly.csv"), toCsv(leads.headers, leads.rows));
writeFileSync(join(outDir, "sequence.md"), renderSequenceMd(seq, style));
writeFileSync(join(outDir, "review-checklist.md"), renderChecklist(seq, leads.rows.length, style));

console.log(`✓ ${leads.rows.length} leads ready (${rows.length - leads.rows.length} dropped)`);
console.log(`✓ ${seq.steps.length} step(s), ${seq.steps.reduce((n, s) => n + s.variants.length, 0)} variant(s), variable style: ${style}`);
for (const w of warnings) console.log(`! ${w}`);
console.log(`\nFiles in ${outDir}:`);
console.log("  leads-instantly.csv   → import in Instantly");
console.log("  sequence.md           → paste into the sequence editor");
console.log("  review-checklist.md   → follow before you press Launch");
console.log("\nNothing was sent and Instantly was not contacted.");
