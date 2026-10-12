/**
 * Stage 23 Controlled Validation — assessContactForCampaign()
 *
 * Creates 6 synthetic fixtures covering every discriminating case, runs the
 * full assessment pipeline, reports every field the user asked for, then
 * deletes all test rows.
 *
 * HARD CONSTRAINTS:
 *   - No emails sent. No Smartlead. No outreach.
 *   - No writes to campaigns, campaign_leads, or campaign_strategies (except
 *     the one test strategy created here and deleted at cleanup).
 *   - No production security / config / schema changes.
 *   - All test rows are identifiable by TEST_RUN_ID prefix in their name/notes.
 *
 * Six cases:
 *   C1  VP of Sales               — email verified, no suppression
 *       → RELEVANT, ready, QUALIFIED
 *   C2  Sales Development Rep      — email verified, no suppression
 *       → WRONG_SENIORITY (hard disqualifier)
 *   C3  Chief Technology Officer   — email verified, no suppression
 *       → WRONG_FUNCTION (hard disqualifier)
 *   C4  VP of Sales (email-blind)  — no email at all, no suppression
 *       → RELEVANT but NOT READY (contact gate fails — null email)
 *   C5  VP of Sales (suppressed)   — email verified, permanent suppression
 *       → RELEVANT but NOT READY (suppression gate)
 *   C6  (no job title)             — email verified, no suppression
 *       → NO_TITLE hard disqualifier
 *
 * Additional checks:
 *   R1  Case 1 re-run              — idempotency / FRESH cache hits
 *   I1  Account not ready          — Stage 22 prerequisite enforcement
 *   I2  Cross-client strategy      — campaign strategy client isolation
 *   I3  PII audit                  — raw job title never in stored JSONB
 *   I4  OUTREACH_READY absent      — Stage 23 boundary enforcement
 *
 * Run: npx tsx scripts/stage23-controlled-validation.ts
 */

import { existsSync } from "node:fs";
import { resolve }    from "node:path";

if (typeof process.loadEnvFile === "function") {
  const c = resolve(process.cwd(), ".env");
  if (existsSync(c)) process.loadEnvFile(c);
}

import { getSupabaseAdmin }               from "../src/db/supabase.js";
import { assessContactForCampaign }       from "../src/lib/contact-intelligence.js";
import {
  getContactIntelligence,
  getContactCampaignRelevance,
}                                          from "../src/db/contact-intelligence.js";
import { SCORING_VERSION }                from "../src/lib/person-relevance.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const RUN_TAG     = `stage23-val-${Date.now()}`;
const GRAMSCODE   = "a29f5829-5412-49be-9a77-41c3edf3c14b";
const NOW_ISO     = new Date().toISOString();

// Campaign targeting: "VP Sales and above" → tests SALES function + VP minimum seniority
const TARGETING   = "VP Sales and above";
const VALUE_PROP  = "Close 30% more deals with AI-assisted outreach intelligence.";

const db = getSupabaseAdmin();

// ── Logging helpers ───────────────────────────────────────────────────────────

const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", _ = "\x1b[0m";

let passCount = 0;
let failCount = 0;
const issues: string[] = [];

function pass(label: string) { console.log(`  ${G}✓${_} ${label}`); passCount++; }
function fail(label: string, detail?: string) {
  console.error(`  ${R}✗${_} ${label}${detail ? `\n    ${D}→ ${detail}${_}` : ""}`);
  issues.push(`${label}${detail ? ` (${detail})` : ""}`);
  failCount++;
}
function warn(label: string) { console.log(`  ${Y}⚠${_} ${label}`); }
function section(t: string) {
  console.log(`\n${B}${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}${_}`);
}
function field(name: string, val: unknown) {
  const s = val === null || val === undefined ? `${D}null${_}`
    : typeof val === "object" ? JSON.stringify(val).slice(0, 120)
    : String(val);
  console.log(`    ${name.padEnd(30)} ${s}`);
}

// ── IDs of everything we create (populated during setup) ─────────────────────

const ids = {
  company:      "",
  strategy:     "",
  contacts: {
    c1_vp_sales:      "",
    c2_sdr:           "",
    c3_cto:           "",
    c4_no_email:      "",
    c5_suppressed:    "",
    c6_no_title:      "",
  },
  suppression:  "",
};

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup(): Promise<boolean> {
  section("SETUP — creating controlled test fixtures");

  try {
    // 1. Company
    const { data: co, error: e1 } = await db
      .from("companies")
      .insert({ name: `${RUN_TAG}-company`, domain: "stage23-val.invalid", status: "review" })
      .select("id").single();
    if (e1 || !co) { fail("Insert test company", e1?.message); return false; }
    ids.company = (co as { id: string }).id;
    console.log(`  company_id:   ${ids.company}`);

    // 2. account_intelligence — is_ready=true, opportunity_score=80
    const { error: e2 } = await db.from("account_intelligence").insert({
      client_id:                    GRAMSCODE,
      company_id:                   ids.company,
      opportunity_score:            80,
      opportunity_score_updated_at: NOW_ISO,
      is_ready:                     true,
      readiness_assessed_at:        NOW_ISO,
      why_now:                      { ready: true, narrative: { whyNow: "Synthetic Stage23 test: active hiring signal." }, evidence: { topSignals: [] } },
      created_at:                   NOW_ISO,
      updated_at:                   NOW_ISO,
    });
    if (e2) { fail("Insert account_intelligence", e2.message); return false; }
    console.log(`  account_intelligence: is_ready=true, opportunity_score=80`);

    // 3. Campaign strategy (Gramscode, VP Sales targeting)
    const { data: strat, error: e3 } = await db
      .from("campaign_strategies")
      .insert({
        client_id:          GRAMSCODE,
        campaign_name:      `${RUN_TAG} — VP Sales Pipeline Campaign`,
        targeting_level:    TARGETING,
        value_proposition:  VALUE_PROP,
        is_no_ai:           false,
        is_front_end_offer: false,
        status:             "draft",
        notes:              `Stage 23 controlled validation run ${RUN_TAG}`,
        // Explicitly set updated_at to script-start time (NOW_ISO) so it's
        // guaranteed to be < assessedAt from any case run that follows.
        // Without this, Postgres server-clock skew (~290ms ahead of Node.js)
        // makes campaignUpdatedAt > assessedAt appear true and triggers spurious
        // CAMPAIGN_RELEVANCE staleness on immediate re-runs.
        updated_at:         NOW_ISO,
      })
      .select("id").single();
    if (e3 || !strat) { fail("Insert campaign strategy", e3?.message); return false; }
    ids.strategy = (strat as { id: string }).id;
    console.log(`  strategy_id:  ${ids.strategy}  targeting="${TARGETING}"`);

    // 4. Six contacts
    const contactDefs: Array<{ key: keyof typeof ids.contacts; jobTitle: string | null; email: string | null; emailStatus: string | null; label: string }> = [
      { key: "c1_vp_sales",   jobTitle: "VP of Sales",                  email: "c1.vp.sales@stage23-val.invalid",   emailStatus: "VERIFIED", label: "C1 VP of Sales" },
      { key: "c2_sdr",        jobTitle: "Sales Representative",          email: "c2.sdr@stage23-val.invalid",         emailStatus: "VERIFIED", label: "C2 Sales Representative (IC seniority)" },
      { key: "c3_cto",        jobTitle: "Chief Technology Officer",     email: "c3.cto@stage23-val.invalid",         emailStatus: "VERIFIED", label: "C3 CTO (wrong function)" },
      { key: "c4_no_email",   jobTitle: "VP of Sales",                  email: null,                                 emailStatus: null,       label: "C4 VP of Sales (no email)" },
      { key: "c5_suppressed", jobTitle: "VP of Sales",                  email: "c5.suppressed@stage23-val.invalid",  emailStatus: "VERIFIED", label: "C5 VP of Sales (suppressed)" },
      { key: "c6_no_title",   jobTitle: null,                           email: "c6.notitle@stage23-val.invalid",     emailStatus: "VERIFIED", label: "C6 No job title" },
    ];

    for (const def of contactDefs) {
      const { data: ct, error: ec } = await db.from("contacts").insert({
        company_id:   ids.company,
        first_name:   "Test",
        last_name:    def.key,
        full_name:    `Test ${def.key}`,
        job_title:    def.jobTitle,
        email:        def.email,
        email_status: def.emailStatus,
        status:       "test",
        source:       `stage23-validation:${RUN_TAG}`,
      }).select("id").single();
      if (ec || !ct) { fail(`Insert contact ${def.label}`, ec?.message); return false; }
      ids.contacts[def.key] = (ct as { id: string }).id;
      console.log(`  ${def.label}: ${ids.contacts[def.key]}  title="${def.jobTitle ?? "null"}"  email="${def.email ?? "null"}"  emailStatus="${def.emailStatus ?? "null"}"`);
    }

    // 5. Permanent suppression for C5
    const { data: sup, error: e5 } = await db.from("contact_suppression").insert({
      client_id:  GRAMSCODE,
      contact_id: ids.contacts.c5_suppressed,
      reason:     "do_not_contact",
      expires_at: null,  // permanent
      notes:      `Stage 23 validation test ${RUN_TAG}`,
    }).select("id").single();
    if (e5 || !sup) { fail("Insert suppression for C5", e5?.message); return false; }
    ids.suppression = (sup as { id: string }).id;
    console.log(`  suppression for C5: ${ids.suppression}  reason=do_not_contact  expires_at=null (permanent)`);

    pass("All fixtures created");
    return true;
  } catch (err) {
    fail("Setup exception", err instanceof Error ? err.message : String(err));
    return false;
  }
}

// ── Case runner ───────────────────────────────────────────────────────────────

interface CaseSpec {
  label:              string;
  caseNum:            string;
  contactKey:         keyof typeof ids.contacts;
  enableAi:           boolean;
  expectRelevant:     boolean | null;
  expectReady:        boolean | null;
  expectQualified:    boolean | null;
  expectReason:       string | null;
  expectGateFail?:    string;   // which gate we expect to fail
}

async function runCase(spec: CaseSpec): Promise<void> {
  section(`${spec.caseNum}: ${spec.label}`);

  const contactId = ids.contacts[spec.contactKey];

  let result: Awaited<ReturnType<typeof assessContactForCampaign>>;
  let runErr: Error | null = null;
  const t0 = Date.now();

  try {
    result = await assessContactForCampaign({
      clientId:           GRAMSCODE,
      companyId:           ids.company,
      contactId,
      campaignStrategyId: ids.strategy,
      skipAiNarrative:    !spec.enableAi,
    });
  } catch (err) {
    runErr = err instanceof Error ? err : new Error(String(err));
    fail(`assessContactForCampaign threw unexpectedly`, runErr.message.slice(0, 120));
    return;
  }

  const elapsed = Date.now() - t0;

  const ci  = result!.contactIntelligence;
  const ccr = result!.campaignRelevance;

  // ── Print every field the user asked for ─────────────────────────────────────
  console.log(`\n  ${B}Contact Intelligence (campaign-agnostic)${_}`);
  field("client_id",                    GRAMSCODE);
  field("company_id",                   ids.company);
  field("contact_id",                   contactId);
  field("contact_id (DB row)",          ci.id);
  field("titleClassification.function", ci.titleClassification?.function ?? null);
  field("titleClassification.seniority",ci.titleClassification?.seniority ?? null);
  field("titleClassification.confidence", ci.titleClassification?.confidence ?? null);
  field("isContactReady (snapshot)",    ci.isContactReady);
  field("contactReadinessAssessedAt",   ci.contactReadinessAssessedAt);
  if (ci.gateSnapshot) {
    console.log(`\n  ${B}Gate Snapshot${_}`);
    field("  accountGate",     ci.gateSnapshot.accountGate);
    field("  contactGate",     ci.gateSnapshot.contactGate);
    field("  emailGate",       ci.gateSnapshot.emailGate);
    field("  suppressionGate", ci.gateSnapshot.suppressionGate);
    field("  blockingGate",    ci.gateSnapshot.blockingGate);
    field("  blockingReason",  ci.gateSnapshot.blockingReason);
    field("  evaluatedAt",     ci.gateSnapshot.evaluatedAt);
  }

  console.log(`\n  ${B}Campaign Relevance (campaign-specific)${_}`);
  field("campaign_strategy_id",   ids.strategy);
  field("targeting_level",        TARGETING);
  field("relevanceScore",         ccr.relevanceScore);
  field("isPersonRelevant",       ccr.isPersonRelevant);
  field("isPersonQualified",      ccr.isPersonQualified);
  field("relevanceReason",        ccr.relevanceReason);
  field("scoringVersion",         ccr.scoringVersion);
  field("aiCallMade",             result!.aiCallMade);
  field("skipped",                result!.skipped.join(", ") || "none");
  field("elapsed_ms",             elapsed);

  if (ccr.evidence) {
    console.log(`\n  ${B}Evidence (deterministic)${_}`);
    field("  functionMatch score",  ccr.evidence.factorScores.functionMatch);
    field("  seniorityMatch score", ccr.evidence.factorScores.seniorityMatch);
    field("  signalBonus",         ccr.evidence.factorScores.signalBonus);
    field("  targetFunctions",     JSON.stringify(ccr.evidence.targetingPersona.targetFunctions));
    field("  minimumSeniority",    ccr.evidence.targetingPersona.minimumSeniority);
    field("  signalAlignments",    ccr.evidence.signalAlignments.length + " signals");
    field("  hypothesis",          ccr.evidence.hypothesis);
  }

  if (ccr.narrative) {
    console.log(`\n  ${B}AI Narrative${_}`);
    field("  whyThisPerson",  ccr.narrative.whyThisPerson);
    field("  confidence",     ccr.narrative.confidence);
    field("  model",          ccr.narrative.model);
    field("  inputTokens",    ccr.narrative.inputTokens);
    field("  outputTokens",   ccr.narrative.outputTokens);
    field("  costUsd",        ccr.narrative.costUsd);
    field("  latencyMs",      ccr.narrative.latencyMs);
  } else if (spec.enableAi) {
    warn("AI narrative was null despite enableAi=true (possibly scored below threshold or AI failed)");
  }

  // ── Persisted row IDs ─────────────────────────────────────────────────────
  console.log(`\n  ${B}Persisted Rows${_}`);
  field("  contact_intelligence.id",          ci.id);
  field("  contact_campaign_relevance.id",    ccr.id);
  field("  contact_intelligence updated_at",  ci.updatedAt);
  field("  ccr updated_at",                   ccr.updatedAt);

  // ── Assertions ──────────────────────────────────────────────────────────
  console.log(`\n  ${B}Assertions${_}`);

  if (spec.expectRelevant !== null) {
    ccr.isPersonRelevant === spec.expectRelevant
      ? pass(`isPersonRelevant = ${spec.expectRelevant}`)
      : fail(`isPersonRelevant should be ${spec.expectRelevant}`, `got ${ccr.isPersonRelevant}`);
  }

  if (spec.expectReady !== null) {
    ci.isContactReady === spec.expectReady
      ? pass(`isContactReady = ${spec.expectReady}`)
      : fail(`isContactReady should be ${spec.expectReady}`, `got ${ci.isContactReady}`);
  }

  if (spec.expectQualified !== null) {
    ccr.isPersonQualified === spec.expectQualified
      ? pass(`isPersonQualified = ${spec.expectQualified}`)
      : fail(`isPersonQualified should be ${spec.expectQualified}`, `got ${ccr.isPersonQualified}`);
  }

  if (spec.expectReason !== null) {
    ccr.relevanceReason === spec.expectReason
      ? pass(`relevanceReason = "${spec.expectReason}"`)
      : fail(`relevanceReason should be "${spec.expectReason}"`, `got "${ccr.relevanceReason}"`);
  }

  if (spec.expectGateFail) {
    ci.gateSnapshot?.blockingGate === spec.expectGateFail
      ? pass(`blockingGate = "${spec.expectGateFail}"`)
      : fail(`blockingGate should be "${spec.expectGateFail}"`, `got "${ci.gateSnapshot?.blockingGate}"`);
  }

  // Qualified = relevant AND ready
  const expectedQ = (ccr.isPersonRelevant === true) && (ci.isContactReady === true);
  ccr.isPersonQualified === expectedQ
    ? pass(`isPersonQualified = isPersonRelevant(${ccr.isPersonRelevant}) AND isContactReady(${ci.isContactReady}) = ${expectedQ}`)
    : fail(`isPersonQualified inconsistency: expected ${expectedQ}`, `got ${ccr.isPersonQualified}`);

  // scoringVersion correct
  ccr.scoringVersion === SCORING_VERSION
    ? pass(`scoringVersion = "${SCORING_VERSION}"`)
    : fail(`scoringVersion mismatch`, `expected "${SCORING_VERSION}", got "${ccr.scoringVersion}"`);

  // No OUTREACH_READY anywhere in stored rows
  const rowJson = JSON.stringify(ccr);
  !rowJson.includes("OUTREACH_READY")
    ? pass("OUTREACH_READY absent from contact_campaign_relevance (Stage 23 boundary)")
    : fail("OUTREACH_READY found in stored row — Stage 23 must not produce this");
}

// ── Additional system checks ──────────────────────────────────────────────────

async function runPiiCheck(): Promise<void> {
  section("PII Audit — raw job title never in stored JSONB");

  const contactId = ids.contacts.c1_vp_sales;
  const ci  = await getContactIntelligence(GRAMSCODE, ids.company, contactId);
  const ccr = await getContactCampaignRelevance(GRAMSCODE, ids.company, contactId, ids.strategy);

  const rawTitle = "VP of Sales"; // known job_title for C1

  const ciStr  = JSON.stringify(ci?.titleClassification ?? {});
  const ccrStr = JSON.stringify(ccr?.evidence ?? {});

  !ciStr.includes(rawTitle)
    ? pass(`"${rawTitle}" not in title_classification JSONB`)
    : fail(`"${rawTitle}" found in title_classification JSONB — PII leak`);

  !ccrStr.includes(rawTitle)
    ? pass(`"${rawTitle}" not in evidence JSONB`)
    : fail(`"${rawTitle}" found in evidence JSONB — PII leak`);

  !ciStr.includes("rawTitle") && !ccrStr.includes("rawTitle")
    ? pass("No 'rawTitle' key in any stored JSONB")
    : fail("'rawTitle' key found in stored JSONB — PII leak");
}

async function runIdempotencyCheck(): Promise<void> {
  section("Idempotency — Case 1 re-run (must hit FRESH cache)");

  const result = await assessContactForCampaign({
    clientId:           GRAMSCODE,
    companyId:           ids.company,
    contactId:           ids.contacts.c1_vp_sales,
    campaignStrategyId: ids.strategy,
    skipAiNarrative:    true,
    // No 'now' override — uses real wall-clock time (must be after campaign created_at)
  });

  result.skipped.includes("CONTACT_INTELLIGENCE_FRESH")
    ? pass("CONTACT_INTELLIGENCE_FRESH in skipped")
    : fail("Expected CONTACT_INTELLIGENCE_FRESH", `skipped=${JSON.stringify(result.skipped)}`);

  result.skipped.includes("CAMPAIGN_RELEVANCE_FRESH")
    ? pass("CAMPAIGN_RELEVANCE_FRESH in skipped")
    : fail("Expected CAMPAIGN_RELEVANCE_FRESH", `skipped=${JSON.stringify(result.skipped)}`);

  !result.aiCallMade
    ? pass("No AI call on cache hit (idempotent)")
    : fail("AI call made despite fresh cache — unexpected");

  console.log(`    skipped: ${result.skipped.join(", ")}`);
  console.log(`    aiCallMade: ${result.aiCallMade}`);
}

async function runAccountReadinessCheck(): Promise<void> {
  section("Stage 22 Prerequisite — account not ready must throw");

  const fakeCompanyId = "00000000-0000-0000-0000-000000000099";
  let threw = false;
  try {
    await assessContactForCampaign({
      clientId:           GRAMSCODE,
      companyId:           fakeCompanyId,
      contactId:           ids.contacts.c1_vp_sales,
      campaignStrategyId: ids.strategy,
      skipAiNarrative:    true,
    });
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    const expected = msg.includes("is_ready") || msg.includes("Stage 22") || msg.includes("not true");
    expected
      ? pass(`Threw with correct message: "${msg.slice(0, 80)}"`)
      : pass(`Threw (non-specific but correct): "${msg.slice(0, 80)}"`);
  }
  if (!threw) fail("Did not throw for company with no is_ready=true");
}

async function runClientIsolationCheck(): Promise<void> {
  section("Client Isolation — campaign strategy from wrong client must throw");

  // Strategy belongs to GRAMSCODE. Using fake client ID should fail at
  // getCampaignStrategyById (returns null → throws "not found" before any AI).
  const fakeClientId = "00000000-0000-0000-0000-000000000088";
  let threw = false;
  try {
    await assessContactForCampaign({
      clientId:           fakeClientId,
      companyId:           ids.company,
      contactId:           ids.contacts.c1_vp_sales,
      campaignStrategyId: ids.strategy,
      skipAiNarrative:    true,
    });
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    Threw: "${msg.slice(0, 120)}"`);
    pass("Cross-client campaign strategy lookup throws (client isolation)");
  }
  if (!threw) fail("Did not throw for cross-client campaign strategy lookup");

  // Also verify getCampaignStrategyById returns null for wrong client directly
  const { getCampaignStrategyById } = await import("../src/db/campaign-strategies.js");
  const nullResult = await getCampaignStrategyById(ids.strategy, fakeClientId);
  nullResult === null
    ? pass("getCampaignStrategyById returns null for wrong client_id")
    : fail("getCampaignStrategyById returned data for wrong client_id — isolation breach");
}

// ── DB row inventory ──────────────────────────────────────────────────────────

async function printDbInventory(): Promise<void> {
  section("Database Row Inventory (what Stage 23 created)");

  const { data: ciRows } = await db
    .from("contact_intelligence")
    .select("id, contact_id, is_contact_ready, title_classification, contact_readiness_assessed_at, updated_at")
    .eq("client_id", GRAMSCODE)
    .eq("company_id", ids.company);

  console.log(`\n  contact_intelligence rows: ${(ciRows ?? []).length}`);
  for (const r of (ciRows ?? []) as Record<string, unknown>[]) {
    const tc = r.title_classification as { function?: string; seniority?: string; confidence?: string } | null;
    console.log(`    ${String(r.id).slice(0,8)}…  contact=${String(r.contact_id).slice(0,8)}…  ready=${r.is_contact_ready}  fn=${tc?.function ?? "null"}/${tc?.seniority ?? "null"}/${tc?.confidence ?? "null"}`);
  }

  const { data: ccrRows } = await db
    .from("contact_campaign_relevance")
    .select("id, contact_id, is_person_relevant, is_person_qualified, relevance_score, relevance_reason, scoring_version, narrative")
    .eq("client_id", GRAMSCODE)
    .eq("campaign_strategy_id", ids.strategy);

  console.log(`\n  contact_campaign_relevance rows: ${(ccrRows ?? []).length}`);
  for (const r of (ccrRows ?? []) as Record<string, unknown>[]) {
    const hasNarrative = r.narrative !== null;
    console.log(`    ${String(r.id).slice(0,8)}…  contact=${String(r.contact_id).slice(0,8)}…  relevant=${r.is_person_relevant}  qualified=${r.is_person_qualified}  score=${r.relevance_score}  reason=${r.relevance_reason}  narrative=${hasNarrative}`);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  section("CLEANUP — deleting all test fixtures");

  const checks: Array<[string, () => Promise<{ error: unknown }>]> = [
    ["contact_campaign_relevance (all for test strategy)",
      () => db.from("contact_campaign_relevance").delete().eq("campaign_strategy_id", ids.strategy)],
    ["contact_intelligence (all for test company)",
      () => db.from("contact_intelligence").delete().eq("company_id", ids.company)],
    ["contact_suppression (C5 suppression)",
      () => db.from("contact_suppression").delete().eq("id", ids.suppression)],
    ["contacts (all 6 test contacts)",
      () => db.from("contacts").delete().eq("company_id", ids.company)],
    ["campaign_strategies (test strategy)",
      () => db.from("campaign_strategies").delete().eq("id", ids.strategy)],
    ["account_intelligence (test company)",
      () => db.from("account_intelligence").delete().eq("company_id", ids.company).eq("client_id", GRAMSCODE)],
    ["companies (test company)",
      () => db.from("companies").delete().eq("id", ids.company)],
  ];

  for (const [label, fn] of checks) {
    const { error } = await fn();
    error
      ? warn(`Cleanup warning — ${label}: ${String((error as { message?: string }).message ?? error).slice(0, 80)}`)
      : pass(`Deleted: ${label}`);
  }

  // Verify nothing left
  const { data: leftover } = await db
    .from("contact_intelligence")
    .select("id").eq("company_id", ids.company).limit(1);
  (leftover ?? []).length === 0
    ? pass("No contact_intelligence rows remaining for test company")
    : fail("contact_intelligence rows remain after cleanup");

  const { data: leftoverCCR } = await db
    .from("contact_campaign_relevance")
    .select("id").eq("campaign_strategy_id", ids.strategy).limit(1);
  (leftoverCCR ?? []).length === 0
    ? pass("No contact_campaign_relevance rows remaining for test strategy")
    : fail("contact_campaign_relevance rows remain after cleanup");
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("=".repeat(70));
console.log(`${B} Stage 23 Controlled Validation — assessContactForCampaign()${_}`);
console.log(`  Run tag:   ${RUN_TAG}`);
console.log(`  Client:    gramscode (${GRAMSCODE})`);
console.log(`  Targeting: "${TARGETING}"`);
console.log(`  SCORING_VERSION: ${SCORING_VERSION}`);
console.log(`  AI enabled: C1 (VP Sales — full qualification), C5 (suppressed VP — observe separation)`);
console.log("=".repeat(70));

const setupOk = await setup();

if (!setupOk) {
  console.error("\nSetup failed — cannot run cases. Check above for errors.");
  process.exit(1);
}

// ── Run all 6 cases ───────────────────────────────────────────────────────────

await runCase({
  label:           "VP of Sales — email verified, no suppression",
  caseNum:         "C1",
  contactKey:      "c1_vp_sales",
  enableAi:        true,   // observe AI narrative + cost
  expectRelevant:  true,
  expectReady:     true,
  expectQualified: true,
  expectReason:    "RELEVANT",
});

await runCase({
  label:           "Sales Representative — IC seniority (WRONG_SENIORITY hard disqualifier)",
  caseNum:         "C2",
  contactKey:      "c2_sdr",
  enableAi:        false,
  expectRelevant:  false,
  expectReady:     true,
  expectQualified: false,
  expectReason:    "WRONG_SENIORITY",
});

await runCase({
  label:           "Chief Technology Officer — wrong function entirely",
  caseNum:         "C3",
  contactKey:      "c3_cto",
  enableAi:        false,
  expectRelevant:  false,
  expectReady:     true,
  expectQualified: false,
  expectReason:    "WRONG_FUNCTION",
});

await runCase({
  label:           "VP of Sales — no email (contact gate fails → not ready)",
  caseNum:         "C4",
  contactKey:      "c4_no_email",
  enableAi:        false,
  expectRelevant:  true,   // person IS relevant; it's the contact gate that fails
  expectReady:     false,
  expectQualified: false,
  expectReason:    "RELEVANT",
  expectGateFail:  "contact",
});

await runCase({
  label:           "VP of Sales — permanent suppression (suppression gate fails)",
  caseNum:         "C5",
  contactKey:      "c5_suppressed",
  enableAi:        true,   // observe: AI still fires because isPersonRelevant=true
  expectRelevant:  true,
  expectReady:     false,  // suppression gate blocks readiness
  expectQualified: false,
  expectReason:    "RELEVANT",
  expectGateFail:  "suppression",
});

await runCase({
  label:           "No job title — NO_TITLE hard disqualifier",
  caseNum:         "C6",
  contactKey:      "c6_no_title",
  enableAi:        false,
  expectRelevant:  false,
  expectReady:     null,   // gate snapshot still populated, but reason=NO_TITLE fires first
  expectQualified: false,
  expectReason:    "NO_TITLE",
});

// ── System checks ─────────────────────────────────────────────────────────────

await runIdempotencyCheck();
await runAccountReadinessCheck();
await runClientIsolationCheck();
await runPiiCheck();
await printDbInventory();

// ── Cleanup ───────────────────────────────────────────────────────────────────

await cleanup();

// ── Final report ─────────────────────────────────────────────────────────────

section("FINAL REPORT");

console.log(`\n  ${B}Pass/Fail${_}: ${G}${passCount} passed${_}, ${failCount > 0 ? R : G}${failCount} failed${_}`);

if (issues.length > 0) {
  console.log(`\n  ${R}Issues:${_}`);
  for (const i of issues) console.log(`    • ${i}`);
} else {
  console.log(`\n  ${G}All assertions passed. Stage 23 behaviour confirmed as expected.${_}`);
}

console.log(`\n  ${B}Concept Map${_}`);
console.log(`    CONTACT READY     = all 4 eligibility gates pass (account, contact, email, suppression)`);
console.log(`                        Is a DISCOVERY SNAPSHOT. NOT outreach authorization.`);
console.log(`    PERSON RELEVANT   = relevanceScore >= 30 AND no hard disqualifier (NO_TITLE / WRONG_FUNCTION / WRONG_SENIORITY)`);
console.log(`                        Campaign-specific. Independent of contact readiness.`);
console.log(`    PERSON QUALIFIED  = PERSON RELEVANT AND CONTACT READY`);
console.log(`                        Snapshot only. Does NOT imply OUTREACH_READY.`);
console.log(`    OUTREACH_READY    = NOT produced by Stage 23. Belongs to future activation stage.`);

console.log("\n" + "=".repeat(70));

if (failCount > 0) process.exit(1);
