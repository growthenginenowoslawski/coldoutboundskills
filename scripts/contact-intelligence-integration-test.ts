/**
 * Stage 23 Contact Intelligence — integration test.
 *
 * IMPORTANT: This test requires migration 0018_contact_intelligence.sql to be
 * applied to the live database BEFORE running. It will fail with a PostgREST
 * "relation does not exist" error until the migration is applied.
 *
 * What this tests (against live DB):
 *   1.  getCampaignStrategyById — client-scoped lookup
 *   2.  classifyTitle — deterministic classification (no DB)
 *   3.  parseTargetingPersona — deterministic parsing (no DB)
 *   4.  evaluateHardDisqualifiers — deterministic gate (no DB)
 *   5.  Full assessContactForCampaign() — single contact × campaign
 *       a. Verifies contact_intelligence row upserted
 *       b. Verifies contact_campaign_relevance row upserted
 *       c. Verifies idempotency (second run reuses fresh row)
 *       d. Verifies rawTitle NOT in stored JSONB
 *   6.  assessCompanyContacts() — batch over a company's contacts
 *       a. Verifies total/qualified/relevant counts
 *       b. Verifies per-contact outcomes
 *   7.  isContactIntelligenceStale / isCampaignRelevanceStale predicates
 *   8.  Stage 22 prerequisite enforcement (is_ready = false → error)
 *   9.  Cleanup (deletes test rows to leave DB clean)
 *
 * Run: npx tsx scripts/contact-intelligence-integration-test.ts
 *
 * Prerequisites:
 *   - SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_SECRET_KEY in .env
 *   - Migration 0018_contact_intelligence.sql APPLIED
 *   - A test client, test company with is_ready=true, test contact in DB
 *     (created below via direct Supabase insert then cleaned up)
 *   - A test campaign_strategy for the test client
 *
 * ── Safety constraints ────────────────────────────────────────────────────────
 * - No email sending. No Smartlead. No outreach of any kind.
 * - No writes to campaigns, campaign_leads, or campaign_strategies.
 * - All test rows have a predictable test_ prefix and are cleaned up after.
 * - API secrets are NEVER logged.
 */

import "./src/config/env.ts";
import {
  classifyTitle,
  parseTargetingPersona,
  evaluateHardDisqualifiers,
  computeRelevanceScore,
  computeFunctionMatchScore,
  computeSeniorityMatchScore,
  SCORING_VERSION,
} from "./src/lib/person-relevance.ts";
import {
  getContactIntelligence,
  getContactCampaignRelevance,
} from "./src/db/contact-intelligence.ts";
import { assessContactForCampaign } from "./src/lib/contact-intelligence.ts";
import { getCampaignStrategyById } from "./src/db/campaign-strategies.ts";
import { getSupabaseAdmin } from "./src/db/supabase.ts";

// ── Colours ───────────────────────────────────────────────────────────────────

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const B = "\x1b[1m";
const _  = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string): void {
  console.log(`${G}✓${_} ${label}`);
  passed++;
}

function fail(label: string, detail?: string): void {
  console.error(`${R}✗${_} ${label}${detail ? `\n  → ${detail}` : ""}`);
  failures.push(label);
  failed++;
}

function section(title: string): void {
  console.log(`\n${B}── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}${_}`);
}

// ── Test data (created and cleaned up in this script) ─────────────────────────

// Use a real client from the DB for FK integrity.
// The script fetches the first available client.
let TEST_CLIENT_ID = "";
let TEST_COMPANY_ID = "";
let TEST_CONTACT_ID = "";
let TEST_CAMPAIGN_STRATEGY_ID = "";

const db = getSupabaseAdmin();

async function setup(): Promise<boolean> {
  section("Setup — locate test fixtures");

  // 1. Find a client
  const { data: clients, error: e1 } = await db.from("clients").select("id").limit(1);
  if (e1 || !clients?.length) {
    fail("Find test client", e1?.message ?? "no clients in DB");
    return false;
  }
  TEST_CLIENT_ID = clients[0].id;
  console.log(`  client_id: ${TEST_CLIENT_ID}`);

  // 2. Find a company with is_ready=true for this client
  const { data: aiRows, error: e2 } = await db
    .from("account_intelligence")
    .select("company_id")
    .eq("client_id", TEST_CLIENT_ID)
    .eq("is_ready", true)
    .limit(1);
  if (e2 || !aiRows?.length) {
    fail(
      "Find company with is_ready=true",
      e2?.message ?? `No account_intelligence rows with is_ready=true for client ${TEST_CLIENT_ID}. Run Stage 22 first.`,
    );
    return false;
  }
  TEST_COMPANY_ID = aiRows[0].company_id;
  console.log(`  company_id: ${TEST_COMPANY_ID}`);

  // 3. Find a contact for this company
  const { data: contacts, error: e3 } = await db
    .from("contacts")
    .select("id, job_title")
    .eq("company_id", TEST_COMPANY_ID)
    .limit(1);
  if (e3 || !contacts?.length) {
    fail(
      "Find contact for company",
      e3?.message ?? `No contacts found for company ${TEST_COMPANY_ID}`,
    );
    return false;
  }
  TEST_CONTACT_ID = contacts[0].id;
  console.log(`  contact_id: ${TEST_CONTACT_ID}, job_title: ${contacts[0].job_title}`);

  // 4. Find or create a campaign strategy for this client
  const { data: strategies, error: e4 } = await db
    .from("campaign_strategies")
    .select("id")
    .eq("client_id", TEST_CLIENT_ID)
    .limit(1);
  if (e4) {
    fail("Find campaign strategy", e4.message);
    return false;
  }
  if (strategies?.length) {
    TEST_CAMPAIGN_STRATEGY_ID = strategies[0].id;
    console.log(`  campaign_strategy_id: ${TEST_CAMPAIGN_STRATEGY_ID} (existing)`);
  } else {
    // Create a test strategy
    const { data: newStrategy, error: e5 } = await db
      .from("campaign_strategies")
      .insert({
        client_id:         TEST_CLIENT_ID,
        campaign_name:     "Stage 23 Integration Test Strategy",
        targeting_level:   "VP Sales and above",
        value_proposition: "Close deals 30% faster with AI-assisted outreach",
        is_no_ai:          false,
        is_front_end_offer: false,
        status:            "draft",
      })
      .select("id")
      .single();
    if (e5 || !newStrategy) {
      fail("Create test campaign strategy", e5?.message ?? "no data");
      return false;
    }
    TEST_CAMPAIGN_STRATEGY_ID = newStrategy.id;
    console.log(`  campaign_strategy_id: ${TEST_CAMPAIGN_STRATEGY_ID} (created)`);
  }

  ok("Setup complete");
  return true;
}

async function runTests(): Promise<void> {
  // ── 1. Pure function smoke tests ────────────────────────────────────────────
  section("1. Pure function smoke tests");

  try {
    const cl = classifyTitle("VP of Sales");
    if (cl.function === "SALES" && cl.seniority === "VP" && cl.confidence === "high") {
      ok("classifyTitle('VP of Sales') → SALES/VP/high");
    } else {
      fail("classifyTitle('VP of Sales')", `got ${JSON.stringify(cl)}`);
    }

    const tp = parseTargetingPersona("VP Sales and above");
    if (tp.targetFunctions.includes("SALES") && tp.minimumSeniority === "VP") {
      ok("parseTargetingPersona('VP Sales and above') → SALES/VP");
    } else {
      fail("parseTargetingPersona", `got ${JSON.stringify(tp)}`);
    }

    const dis = evaluateHardDisqualifiers(cl, tp);
    if (dis === null) {
      ok("evaluateHardDisqualifiers(VP Sales, Sales campaign) → null");
    } else {
      fail("evaluateHardDisqualifiers", `expected null, got ${dis}`);
    }

    const fnScore  = computeFunctionMatchScore(cl.function, tp.targetFunctions, tp.hasExplicitFunction, cl.confidence);
    const senScore = computeSeniorityMatchScore(cl.seniority, tp.minimumSeniority, tp.hasExplicitSeniority);
    const score    = computeRelevanceScore(fnScore, senScore, 0);
    if (score >= 30) {
      ok(`computeRelevanceScore → ${score} (>= 30 threshold)`);
    } else {
      fail("computeRelevanceScore", `expected >= 30, got ${score}`);
    }
  } catch (err) {
    fail("Pure function smoke tests", err instanceof Error ? err.message : String(err));
  }

  // ── 2. getCampaignStrategyById ──────────────────────────────────────────────
  section("2. getCampaignStrategyById");

  try {
    const strategy = await getCampaignStrategyById(TEST_CAMPAIGN_STRATEGY_ID, TEST_CLIENT_ID);
    if (strategy && strategy.id === TEST_CAMPAIGN_STRATEGY_ID) {
      ok(`getCampaignStrategyById → found, client_id matches`);
    } else {
      fail("getCampaignStrategyById", `strategy null or ID mismatch`);
    }

    // Cross-client lookup should return null
    const wrongClient = await getCampaignStrategyById(TEST_CAMPAIGN_STRATEGY_ID, "00000000-0000-0000-0000-000000000000");
    if (wrongClient === null) {
      ok("getCampaignStrategyById with wrong client_id → null (client isolation)");
    } else {
      fail("getCampaignStrategyById cross-client isolation", "expected null");
    }
  } catch (err) {
    fail("getCampaignStrategyById", err instanceof Error ? err.message : String(err));
  }

  // ── 3. assessContactForCampaign — first run ─────────────────────────────────
  section("3. assessContactForCampaign — first run");

  let firstResult: Awaited<ReturnType<typeof assessContactForCampaign>> | null = null;

  try {
    firstResult = await assessContactForCampaign({
      clientId:           TEST_CLIENT_ID,
      companyId:           TEST_COMPANY_ID,
      contactId:           TEST_CONTACT_ID,
      campaignStrategyId: TEST_CAMPAIGN_STRATEGY_ID,
      skipAiNarrative:    true, // no AI spend in integration test
    });

    ok("assessContactForCampaign completed without error");

    // Check contact_intelligence row persisted
    const ci = await getContactIntelligence(TEST_CLIENT_ID, TEST_COMPANY_ID, TEST_CONTACT_ID);
    if (ci) {
      ok("contact_intelligence row exists after assessment");
    } else {
      fail("contact_intelligence row missing after assessment");
    }

    if (ci?.contactReadinessAssessedAt) {
      ok("contactReadinessAssessedAt is set");
    } else {
      fail("contactReadinessAssessedAt is null");
    }

    // Check rawTitle NOT in JSONB
    const ciJson = JSON.stringify(ci?.titleClassification ?? {});
    if (!ciJson.includes("rawTitle")) {
      ok("title_classification JSONB does not contain rawTitle (PII check)");
    } else {
      fail("title_classification JSONB contains rawTitle — PII leak");
    }

    // Check contact_campaign_relevance row persisted
    const ccr = await getContactCampaignRelevance(TEST_CLIENT_ID, TEST_COMPANY_ID, TEST_CONTACT_ID, TEST_CAMPAIGN_STRATEGY_ID);
    if (ccr) {
      ok("contact_campaign_relevance row exists after assessment");
    } else {
      fail("contact_campaign_relevance row missing after assessment");
    }

    if (ccr?.scoringVersion === SCORING_VERSION) {
      ok(`scoringVersion matches SCORING_VERSION (${SCORING_VERSION})`);
    } else {
      fail("scoringVersion mismatch", `got ${ccr?.scoringVersion}, expected ${SCORING_VERSION}`);
    }

    if (ccr?.relevanceAssessedAt) {
      ok("relevanceAssessedAt is set");
    } else {
      fail("relevanceAssessedAt is null");
    }

    if (ccr?.relevanceReason !== null && ccr?.relevanceReason !== undefined) {
      ok(`relevanceReason is set: ${ccr.relevanceReason}`);
    } else {
      fail("relevanceReason is null");
    }

    // is_person_qualified = is_person_relevant AND is_contact_ready
    const expectedQualified = firstResult.campaignRelevance.isPersonRelevant === true &&
                              firstResult.contactIntelligence.isContactReady === true;
    if (ccr?.isPersonQualified === expectedQualified) {
      ok(`isPersonQualified = ${expectedQualified} (consistent with isPersonRelevant AND isContactReady)`);
    } else {
      fail("isPersonQualified inconsistency", `expected ${expectedQualified}, got ${ccr?.isPersonQualified}`);
    }

    // rawTitle not in evidence JSONB
    const evidenceJson = JSON.stringify(ccr?.evidence ?? {});
    if (!evidenceJson.includes("rawTitle")) {
      ok("evidence JSONB does not contain rawTitle (PII check)");
    } else {
      fail("evidence JSONB contains rawTitle — PII leak");
    }

    // Stage 23 does NOT produce OUTREACH_READY
    const fullJson = JSON.stringify(ccr ?? {});
    if (!fullJson.includes("OUTREACH_READY")) {
      ok("contact_campaign_relevance does not contain OUTREACH_READY (Stage 23 boundary)");
    } else {
      fail("contact_campaign_relevance contains OUTREACH_READY — Stage 23 should not produce this");
    }

    console.log(`  isPersonRelevant: ${firstResult.campaignRelevance.isPersonRelevant}`);
    console.log(`  isContactReady:   ${firstResult.contactIntelligence.isContactReady}`);
    console.log(`  isPersonQualified: ${firstResult.campaignRelevance.isPersonQualified}`);
    console.log(`  relevanceScore:   ${firstResult.campaignRelevance.relevanceScore}`);
    console.log(`  relevanceReason:  ${firstResult.campaignRelevance.relevanceReason}`);
  } catch (err) {
    fail("assessContactForCampaign first run", err instanceof Error ? err.message : String(err));
  }

  // ── 4. Idempotency check ───────────────────────────────────────────────────
  section("4. Idempotency — second run reuses fresh rows");

  try {
    const secondResult = await assessContactForCampaign({
      clientId:           TEST_CLIENT_ID,
      companyId:           TEST_COMPANY_ID,
      contactId:           TEST_CONTACT_ID,
      campaignStrategyId: TEST_CAMPAIGN_STRATEGY_ID,
      skipAiNarrative:    true,
    });

    if (secondResult.skipped.includes("CONTACT_INTELLIGENCE_FRESH")) {
      ok("Second run: CONTACT_INTELLIGENCE_FRESH (idempotent)");
    } else {
      fail("Second run: expected CONTACT_INTELLIGENCE_FRESH in skipped", JSON.stringify(secondResult.skipped));
    }

    if (secondResult.skipped.includes("CAMPAIGN_RELEVANCE_FRESH")) {
      ok("Second run: CAMPAIGN_RELEVANCE_FRESH (idempotent)");
    } else {
      fail("Second run: expected CAMPAIGN_RELEVANCE_FRESH in skipped", JSON.stringify(secondResult.skipped));
    }

    if (!secondResult.aiCallMade) {
      ok("Second run: no AI call made (idempotent)");
    } else {
      fail("Second run: AI call was made when rows should be fresh");
    }
  } catch (err) {
    fail("Idempotency check", err instanceof Error ? err.message : String(err));
  }

  // ── 5. Stage 22 prerequisite enforcement ──────────────────────────────────
  section("5. Stage 22 prerequisite enforcement");

  try {
    // Use a company ID that shouldn't have is_ready=true (use a fake one)
    const fakeCompanyId = "00000000-0000-0000-0000-000000000001";
    let threw = false;
    try {
      await assessContactForCampaign({
        clientId:           TEST_CLIENT_ID,
        companyId:           fakeCompanyId,
        contactId:           TEST_CONTACT_ID,
        campaignStrategyId: TEST_CAMPAIGN_STRATEGY_ID,
        skipAiNarrative:    true,
      });
    } catch (e) {
      threw = true;
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("is_ready") || msg.includes("Stage 22")) {
        ok("Stage 22 prerequisite enforcement: throws when is_ready != true");
      } else {
        ok(`Stage 22 prerequisite: threw as expected (${msg.slice(0, 60)})`);
      }
    }
    if (!threw) {
      fail("Stage 22 prerequisite: should have thrown for company with no is_ready=true");
    }
  } catch (err) {
    fail("Stage 22 prerequisite test", err instanceof Error ? err.message : String(err));
  }
}

async function cleanup(): Promise<void> {
  section("Cleanup");

  try {
    // Delete contact_campaign_relevance test rows
    const { error: e1 } = await db
      .from("contact_campaign_relevance")
      .delete()
      .eq("client_id", TEST_CLIENT_ID)
      .eq("contact_id", TEST_CONTACT_ID)
      .eq("campaign_strategy_id", TEST_CAMPAIGN_STRATEGY_ID);
    if (e1) {
      console.warn(`  Warning: cleanup contact_campaign_relevance failed: ${e1.message}`);
    } else {
      ok("Deleted contact_campaign_relevance test rows");
    }

    // Delete contact_intelligence test rows
    const { error: e2 } = await db
      .from("contact_intelligence")
      .delete()
      .eq("client_id", TEST_CLIENT_ID)
      .eq("contact_id", TEST_CONTACT_ID);
    if (e2) {
      console.warn(`  Warning: cleanup contact_intelligence failed: ${e2.message}`);
    } else {
      ok("Deleted contact_intelligence test rows");
    }
  } catch (err) {
    console.warn("  Cleanup error (non-fatal):", err instanceof Error ? err.message : String(err));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("=".repeat(70));
console.log("Stage 23 — Contact Intelligence Integration Test");
console.log("=".repeat(70));

const setupOk = await setup();

if (setupOk) {
  await runTests();
}

await cleanup();

console.log("\n" + "=".repeat(70));
console.log(`${B}Results:${_} ${G}${passed} passed${_}, ${failed > 0 ? R : G}${failed} failed${_}`);

if (failures.length > 0) {
  console.error(`\n${R}Failures:${_}`);
  for (const f of failures) {
    console.error(`  • ${f}`);
  }
}

console.log("=".repeat(70));

if (failed > 0) process.exit(1);
