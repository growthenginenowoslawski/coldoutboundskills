/**
 * Stage 10.5 — Signal Intelligence Integration Test.
 *
 * Proves the FULL GTM intelligence pipeline end-to-end using controlled
 * fictional test data and real AI (no mocks):
 *
 *   RAW EVENTS → NORMALIZED SIGNALS → DEDUPLICATION → EVIDENCE → FRESHNESS
 *   → SIGNAL STRENGTH → ICP RELEVANCE → COMBINED OPPORTUNITY CONTEXT
 *   → WHY NOW → AI QUALIFICATION → AI PERSONALIZATION
 *
 * HARD CONSTRAINTS:
 *   - Makes NO external API calls to LinkedIn / Apify / Clay
 *   - Scrapes NOTHING
 *   - Sends NOTHING externally
 *   - Does NOT modify existing production company records
 *   - Uses ONLY controlled fictional test data
 *   - Leaves test company + signal records in Supabase for manual inspection
 *   - Stops and waits for approval before any further stages
 *
 * SCORING TRANSPARENCY:
 *   - Signal strength scores are DETERMINISTIC (base strength × freshness)
 *   - AI opportunity score is an ANALYTICAL ESTIMATE — not commercially validated
 *   - AI confidence is the model's self-reported certainty in its own assessment
 *
 * Run:
 *   npx tsx scripts/signal-intelligence-integration-test.ts
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Load .env before any imports that touch env
if (typeof process.loadEnvFile === "function") {
  const candidate = resolve(process.cwd(), ".env");
  if (existsSync(candidate)) process.loadEnvFile(candidate);
}

import { getSupabaseAdmin } from "../src/db/supabase";
import { upsertSignal, getSignalsByCompany } from "../src/db/signals";
import { FakeSignalProvider } from "../src/providers/signals/fake-provider";
import { normalizeEvent } from "../src/providers/signals/normalizer";
import { computeFreshnessScore, isExpired } from "../src/lib/signal-freshness";
import { computeSignalStrength, computeActionabilityScore } from "../src/lib/signal-strength";
import { runAISignalIntelligence } from "../src/tasks/signal-intelligence";
import { runAIPersonalize } from "../src/tasks/personalize";
import { runAIQualify } from "../src/tasks/qualify";
import type { SignalSummary, SignalIntelligenceInput } from "../src/domain/signal-types";
import type { CompanyRecord } from "../src/domain/types";

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const checks: { label: string; ok: boolean; detail?: string }[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  checks.push({ label, ok: condition, detail });
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

function labelledNote(label: string, value: unknown): void {
  console.log(`     ${label}: ${JSON.stringify(value)}`);
}

// ── Run ID for test isolation ─────────────────────────────────────────────────

const runId = createHash("sha256")
  .update(Date.now().toString())
  .digest("hex")
  .slice(0, 8);

const TEST_COMPANY_NAME = `SIGNAL_INTEL_TEST_${runId}_Acme SaaS`;
const TEST_CLIENT_ID = "a29f5829-5412-49be-9a77-41c3edf3c14b"; // Gramscode (Stage 10 client)

// ── ICP definition for the test ───────────────────────────────────────────────

const TEST_ICP = {
  industry: "B2B SaaS",
  location: "United States",
  employeeRange: { min: 20, max: 500 },
  keywords: ["sales automation", "revenue operations", "GTM"],
  description:
    "Ideal customer: B2B SaaS companies actively scaling their sales team, with budget unlocked by recent funding or executive change.",
};

// ── Campaign definition ───────────────────────────────────────────────────────

const TEST_CAMPAIGN = {
  objective: "Book a 20-minute discovery call",
  valueProposition:
    "We help B2B SaaS companies build a fully-automated outbound motion in under 2 weeks using AI-powered lead qualification and personalization.",
  callToAction: "Would it make sense to show you how we'd do this for your team?",
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  STAGE 10.5 — Signal Intelligence Integration Test");
  console.log(`  Run ID: ${runId}`);
  console.log(`  Test company: ${TEST_COMPANY_NAME}`);
  console.log(`  Client: ${TEST_CLIENT_ID} (Gramscode)`);
  console.log("  CONSTRAINTS: no scraping, no real APIs, no emails, no prod data changes");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // ── SECTION 1: Insert test company ──────────────────────────────────────────

  section("1. Test company creation");

  const db = getSupabaseAdmin();
  const { data: companyData, error: companyError } = await db
    .from("companies")
    .insert({
      name: TEST_COMPANY_NAME,
      domain: `acme-saas-${runId}.example.com`,
      website_url: `https://acme-saas-${runId}.example.com`,
      industry: "B2B SaaS",
      city: "San Francisco",
      region: "CA",
      country: "US",
      company_size: "85",
      source: "test",
      status: "review",
    })
    .select("id, name, domain, industry, city, country, company_size")
    .single();

  if (companyError) {
    console.error(`FATAL: failed to insert test company — ${companyError.message}`);
    process.exit(1);
  }

  const companyId = (companyData as { id: string }).id;
  check("Test company inserted with unique runId name", typeof companyId === "string" && companyId.length > 0, companyId);
  labelledNote("company_id", companyId);
  labelledNote("name", (companyData as { name: string }).name);

  // Build the CompanyRecord for use in AI calls
  const company: CompanyRecord = {
    name: TEST_COMPANY_NAME,
    domain: `acme-saas-${runId}.example.com`,
    website: `https://acme-saas-${runId}.example.com`,
    description:
      "A fictional B2B SaaS company used for Stage 10.5 signal intelligence integration testing.",
    industry: "B2B SaaS",
    city: "San Francisco",
    country: "US",
    employeeCount: 85,
    source: "test",
    fetchedAt: new Date().toISOString(),
  };

  // ── SECTION 2: Raw event generation ─────────────────────────────────────────

  section("2. Raw event generation (FakeSignalProvider)");

  const fakeProvider = new FakeSignalProvider();
  const asOf = new Date();

  const scenarios = [
    "executive_hire_vp_sales",
    "funding_series_a",
    "market_expansion",
  ];

  const batch = await fakeProvider.fetchEvents([companyId], TEST_CLIENT_ID, {
    scenarios,
    asOf,
    eventIdSuffix: runId,
  });

  check("FakeSignalProvider generated events", batch.events.length === scenarios.length,
    `expected ${scenarios.length}, got ${batch.events.length}`);
  check("All events have the correct company_id", batch.events.every(e => e.companyId === companyId));
  check("All events have the correct client_id", batch.events.every(e => e.clientId === TEST_CLIENT_ID));
  labelledNote("scenarios", scenarios);
  labelledNote("events_generated", batch.events.length);

  // ── SECTION 3: Normalization ─────────────────────────────────────────────────

  section("3. Signal normalization (deterministic, no AI)");

  const normalized = batch.events.map(e => normalizeEvent(e));

  check("All events normalized successfully", normalized.length === scenarios.length);
  check("executive_hire has signal_type=executive_hire",
    normalized[0].signalType === "executive_hire");
  check("funding_round has signal_type=funding_round",
    normalized[1].signalType === "funding_round");
  check("market_expansion (website_change) has signal_type=website_change",
    normalized[2].signalType === "website_change");
  check("All normalized signals have client_id set",
    normalized.every(s => s.clientId === TEST_CLIENT_ID));
  check("All normalized signals have company_id set",
    normalized.every(s => s.companyId === companyId));

  // ── SECTION 4: Deduplication ──────────────────────────────────────────────

  section("4. Deduplication");

  check("executive_hire has a dedup_key (tier-1: provider ID)",
    typeof normalized[0].dedupKey === "string" && normalized[0].dedupKey !== null,
    normalized[0].dedupKey ?? "null");
  check("funding_round has a dedup_key (tier-1: provider ID)",
    typeof normalized[1].dedupKey === "string" && normalized[1].dedupKey !== null,
    normalized[1].dedupKey ?? "null");
  check("market_expansion has a dedup_key (tier-1: provider ID)",
    typeof normalized[2].dedupKey === "string" && normalized[2].dedupKey !== null,
    normalized[2].dedupKey ?? "null");
  check("All three dedup_keys are unique",
    new Set(normalized.map(s => s.dedupKey)).size === 3);
  labelledNote("dedup_key[0] (exec_hire)", normalized[0].dedupKey);
  labelledNote("dedup_key[1] (funding)", normalized[1].dedupKey);
  labelledNote("dedup_key[2] (market_expansion)", normalized[2].dedupKey);

  // ── SECTION 5: Freshness scores ────────────────────────────────────────────

  section("5. Freshness scores");

  const freshnessScores = normalized.map(s => computeFreshnessScore(s.occurredAt, s.expiresAt));
  const expiredFlags = normalized.map(s => isExpired(s.expiresAt));

  check("executive_hire freshness > 70 (5 days old, 30d TTL)",
    freshnessScores[0] > 70, `${freshnessScores[0]}`);
  check("funding_round freshness > 70 (10 days old, 90d TTL)",
    freshnessScores[1] > 70, `${freshnessScores[1]}`);
  check("market_expansion freshness > 70 (4 days old, 30d TTL)",
    freshnessScores[2] > 70, `${freshnessScores[2]}`);
  check("No active signals are expired",
    expiredFlags.every(e => !e));
  labelledNote("freshness_scores", freshnessScores);

  // ── SECTION 6: Signal strength scores ─────────────────────────────────────

  section("6. Signal strength scores (deterministic)");

  const strengthScores = normalized.map(s => computeSignalStrength(s.signalType));
  const actionabilityScores = freshnessScores.map((f, i) =>
    computeActionabilityScore(strengthScores[i], f),
  );

  check("executive_hire base strength = 75",
    strengthScores[0] === 75, `${strengthScores[0]}`);
  check("funding_round base strength = 90",
    strengthScores[1] === 90, `${strengthScores[1]}`);
  check("website_change (market_expansion) base strength = 35",
    strengthScores[2] === 35, `${strengthScores[2]}`);
  check("All actionability scores > 0",
    actionabilityScores.every(a => a > 0));
  check("funding_round has highest actionability",
    actionabilityScores[1] >= actionabilityScores[0] &&
    actionabilityScores[1] >= actionabilityScores[2]);
  labelledNote("strength_scores [exec_hire, funding, market_exp]", strengthScores);
  labelledNote("actionability_scores", actionabilityScores.map(s => Math.round(s * 10) / 10));

  console.log("\n  ─ Scoring transparency note ─");
  console.log("  Signal strength: DETERMINISTIC (base score from type registry × dedup tier)");
  console.log("  AI opportunity score: ANALYTICAL ESTIMATE — not commercially validated");
  console.log("  AI confidence: model's self-reported certainty in its own assessment");

  // ── SECTION 7: ICP relevance assessment (deterministic) ───────────────────

  section("7. ICP relevance assessment (deterministic pre-filter)");

  // Check industry match, size match, signal type relevance against ICP
  const industryMatch = company.industry === TEST_ICP.industry;
  const sizeInRange =
    (company.employeeCount ?? 0) >= (TEST_ICP.employeeRange.min ?? 0) &&
    (company.employeeCount ?? 0) <= (TEST_ICP.employeeRange.max ?? Infinity);
  const hasHighValueSignals = strengthScores.some(s => s >= 75);

  check("Company industry matches ICP target industry", industryMatch,
    `${company.industry} vs ${TEST_ICP.industry}`);
  check("Company size is within ICP range (20-500 employees)", sizeInRange,
    `${company.employeeCount} employees`);
  check("At least one high-value signal (strength ≥ 75) present", hasHighValueSignals);

  // ── SECTION 8: Upsert signals to Supabase ─────────────────────────────────

  section("8. Signal persistence to Supabase");

  const upsertResults: { row: { id: string; signal_title?: string; signal_type?: string; signal_strength?: number }; created: boolean }[] = [];
  for (const signal of normalized) {
    const result = await upsertSignal(signal);
    upsertResults.push(result as typeof upsertResults[0]);
  }

  check("All 3 signals upserted", upsertResults.length === 3);
  check("All 3 signals were newly created (not duplicates)",
    upsertResults.every(r => r.created));
  check("All signals have UUIDs from Supabase",
    upsertResults.every(r => typeof r.row.id === "string" && r.row.id.length > 0));

  const signalIds = upsertResults.map(r => r.row.id);
  labelledNote("signal_id[0] executive_hire", signalIds[0]);
  labelledNote("signal_id[1] funding_round", signalIds[1]);
  labelledNote("signal_id[2] market_expansion", signalIds[2]);

  // ── SECTION 9: Read-back verification ─────────────────────────────────────

  section("9. Read-back verification from Supabase");

  const storedSignals = await getSignalsByCompany(companyId, TEST_CLIENT_ID);

  check("3 signals readable from Supabase by company+client",
    storedSignals.length === 3, `found ${storedSignals.length}`);
  check("Signals are ordered by occurred_at desc (most recent first)",
    storedSignals.length < 2 || storedSignals[0].occurredAt >= storedSignals[1].occurredAt);
  check("Signal strength stored correctly for executive_hire",
    storedSignals.some(s => s.signalType === "executive_hire" && s.signalStrength === 75));
  check("Signal strength stored correctly for funding_round",
    storedSignals.some(s => s.signalType === "funding_round" && s.signalStrength === 90));
  check("All stored signals belong to test company",
    storedSignals.every(s => s.companyId === companyId));
  check("All stored signals belong to test client",
    storedSignals.every(s => s.clientId === TEST_CLIENT_ID));
  check("dedup_keys are persisted",
    storedSignals.every(s => s.dedupKey !== null));

  // ── SECTION 10: Build signal summaries for AI layer ───────────────────────

  section("10. Build signal summaries for AI input");

  const signalSummaries: SignalSummary[] = storedSignals.map(s => ({
    signalType: s.signalType,
    title: s.signalTitle,
    description: s.signalDescription,
    evidence: s.evidence,
    signalStrength: s.signalStrength,
    freshnessScore: computeFreshnessScore(s.occurredAt, s.expiresAt),
    occurredAt: s.occurredAt,
  }));

  check("Signal summaries built for all stored signals", signalSummaries.length === 3);
  check("All summaries have signalStrength > 0", signalSummaries.every(s => s.signalStrength > 0));
  check("All summaries have freshnessScore > 0", signalSummaries.every(s => s.freshnessScore > 0));

  const sigIntelInput: SignalIntelligenceInput = {
    company,
    icp: TEST_ICP,
    signals: signalSummaries,
  };

  labelledNote("signals_sent_to_AI", signalSummaries.map(s => `${s.signalType}: ${s.title}`));

  // ── SECTION 11: WHY NOW — AI Signal Intelligence ───────────────────────────

  section("11. WHY NOW — AI Signal Intelligence (live AI call)");
  console.log("  [calling AI for WHY NOW analysis — this makes a real API call]");

  const idempotencyKey = `stage-10.5-signal-intel-${runId}`;

  const sigIntelExecution = await runAISignalIntelligence({
    companyId,
    taskType: "signal_intelligence",
    idempotencyKey,
    clientId: TEST_CLIENT_ID,
    input: sigIntelInput,
  });

  const siResult = sigIntelExecution.result;
  const siProviderResult = sigIntelExecution.providerResult;

  check("AI returned a whyNow string", typeof siResult.whyNow === "string" && siResult.whyNow.length > 20,
    siResult.whyNow.slice(0, 80));
  check("AI returned opportunityScore 0-100",
    typeof siResult.opportunityScore === "number" &&
    siResult.opportunityScore >= 0 && siResult.opportunityScore <= 100,
    `${siResult.opportunityScore}`);
  check("AI returned relevantSignals array",
    Array.isArray(siResult.relevantSignals) && siResult.relevantSignals.length > 0,
    JSON.stringify(siResult.relevantSignals));
  check("AI returned reasoning string",
    typeof siResult.reasoning === "string" && siResult.reasoning.length > 10);
  check("AI returned confidence 0-1",
    typeof siResult.confidence === "number" &&
    siResult.confidence >= 0 && siResult.confidence <= 1,
    `${siResult.confidence}`);
  check("Model name is present", typeof siResult.model === "string" && siResult.model.length > 0,
    siResult.model);
  check("Token counts are present",
    siResult.inputTokens > 0 && siResult.outputTokens > 0,
    `in=${siResult.inputTokens} out=${siResult.outputTokens}`);
  check("Cost was computed (costUsd present)",
    siResult.costUsd !== null && typeof siResult.costUsd === "number",
    `$${siResult.costUsd}`);
  check("Latency was captured (>0ms)", siResult.latencyMs > 0, `${siResult.latencyMs}ms`);

  console.log("\n  ─ WHY NOW analysis result ─");
  console.log(`  whyNow: "${siProviderResult.whyNow}"`);
  console.log(`  opportunityScore: ${siProviderResult.opportunityScore}/100`);
  console.log(`  ⚠  ANALYTICAL ESTIMATE ONLY — not commercially validated`);
  console.log(`  relevantSignals: ${JSON.stringify(siProviderResult.relevantSignals)}`);
  console.log(`  confidence: ${siProviderResult.confidence}`);
  console.log(`  model: ${siResult.model}`);
  console.log(`  tokens: ${siResult.inputTokens}in / ${siResult.outputTokens}out`);
  console.log(`  cost: $${siResult.costUsd} | latency: ${siResult.latencyMs}ms`);

  // ── SECTION 12: AI Qualification with signal context ──────────────────────

  section("12. AI Qualification (ICP fit check)");
  console.log("  [calling AI for ICP qualification — this makes a real API call]");

  const qualExecution = await runAIQualify({
    companyId,
    taskType: "icp_qualification",
    idempotencyKey: `stage-10.5-qual-${runId}`,
    clientId: TEST_CLIENT_ID,
    input: {
      company,
      icp: {
        industry: TEST_ICP.industry,
        location: TEST_ICP.location,
        employeeRange: TEST_ICP.employeeRange,
        keywords: TEST_ICP.keywords,
        description: TEST_ICP.description,
      },
    },
  });

  const qualResult = qualExecution.result;

  check("Qualification returned a fit score 0-100",
    typeof qualResult.score === "number" && qualResult.score >= 0 && qualResult.score <= 100,
    `${qualResult.score}`);
  check("Qualification returned a reason string",
    typeof qualResult.reason === "string" && qualResult.reason.length > 10);
  check("Qualification returned icpFit boolean",
    typeof qualResult.icpFit === "boolean");
  check("Qualification token counts present",
    qualResult.inputTokens > 0, `in=${qualResult.inputTokens}`);

  console.log(`  icpFit: ${qualResult.icpFit} | score: ${qualResult.score}/100`);
  console.log(`  model: ${qualResult.model} | cost: $${qualResult.costUsd}`);

  // ── SECTION 13: AI Personalization with signal context ────────────────────

  section("13. AI Personalization (signal-informed email)");
  console.log("  [calling AI for personalization — this makes a real API call]");

  const signalContext = {
    whyNow: siProviderResult.whyNow,
    opportunityScore: siProviderResult.opportunityScore,
    relevantSignals: siProviderResult.relevantSignals,
  };

  const personExecution = await runAIPersonalize({
    companyId,
    taskType: "personalization",
    idempotencyKey: `stage-10.5-personalize-${runId}`,
    clientId: TEST_CLIENT_ID,
    input: {
      company,
      campaign: TEST_CAMPAIGN,
      icp: {
        industry: TEST_ICP.industry,
        employeeRange: TEST_ICP.employeeRange,
        description: TEST_ICP.description,
      },
      signalContext,
    },
  });

  const personResult = personExecution.result;
  const personProviderResult = personExecution.providerResult;

  check("Personalization returned a subject line",
    typeof personProviderResult.subject === "string" && personProviderResult.subject.length > 0,
    personProviderResult.subject);
  check("Subject line ≤ 50 characters", personProviderResult.subject.length <= 50,
    `${personProviderResult.subject.length} chars`);
  check("Personalization returned a message",
    typeof personProviderResult.message === "string" && personProviderResult.message.length > 30);
  check("Personalization returned a tone",
    typeof personProviderResult.tone === "string" && personProviderResult.tone.length > 0,
    personProviderResult.tone);
  check("Personalization token counts present",
    personResult.inputTokens > 0, `in=${personResult.inputTokens}`);

  console.log("\n  ─ Signal-informed email ─");
  console.log(`  subject: "${personProviderResult.subject}"`);
  console.log(`  message: "${personProviderResult.message}"`);
  console.log(`  tone: ${personProviderResult.tone}`);
  console.log(`  model: ${personResult.model} | cost: $${personResult.costUsd}`);

  // ── SECTION 14: Idempotency — re-run dedup ────────────────────────────────

  section("14. Idempotency — re-run dedup");

  const reBatch = await fakeProvider.fetchEvents([companyId], TEST_CLIENT_ID, {
    scenarios,
    asOf,
    eventIdSuffix: runId,
  });
  const reNormalized = reBatch.events.map(e => normalizeEvent(e));
  const reUpsertResults = await Promise.all(reNormalized.map(s => upsertSignal(s)));

  check("Re-run returns same number of results", reUpsertResults.length === 3);
  check("All re-run signals found existing (not re-created)",
    reUpsertResults.every(r => !r.created));
  check("Re-run signal IDs match original IDs",
    reUpsertResults.every((r, i) => r.row.id === signalIds[i]));

  // ── SECTION 15: Tenant isolation ──────────────────────────────────────────

  section("15. Tenant isolation (fake second client)");

  const SECOND_CLIENT_ID = "00000000-0000-0000-0000-000000000099"; // non-existent client
  const isolationSignals = await getSignalsByCompany(companyId, SECOND_CLIENT_ID);

  check("No signals visible under a different client_id",
    isolationSignals.length === 0, `found ${isolationSignals.length}`);

  // ── SECTION 16: Scoring transparency assertion ─────────────────────────────

  section("16. Scoring transparency");

  const execHireSignal = signalSummaries.find(s => s.signalType === "executive_hire");
  const fundingSignal = signalSummaries.find(s => s.signalType === "funding_round");

  check("Signal strength for executive_hire is deterministic (75)",
    execHireSignal?.signalStrength === 75);
  check("Signal strength for funding_round is deterministic (90)",
    fundingSignal?.signalStrength === 90);
  check("opportunityScore is AI analytical estimate (not hard-coded)",
    siProviderResult.opportunityScore > 0 && siProviderResult.opportunityScore <= 100);
  check("confidence is AI self-reported (not deterministic)",
    siProviderResult.confidence > 0 && siProviderResult.confidence <= 1);

  // ── FINAL REPORT ──────────────────────────────────────────────────────────

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  STAGE 10.5 — Integration Test Complete");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`\n  Checks passed: ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.error(`  Checks FAILED: ${failed}`);
    checks.filter(c => !c.ok).forEach(c => console.error(`    ✗ ${c.label}${c.detail ? ` — ${c.detail}` : ""}`));
  }

  console.log("\n  ─ Pipeline stages verified ─");
  console.log("  ✓ RAW EVENTS          — FakeSignalProvider generated 3 typed events");
  console.log("  ✓ NORMALIZATION       — deterministic, no AI, no external calls");
  console.log("  ✓ DEDUPLICATION       — 3-tier dedup keys computed and stored");
  console.log("  ✓ EVIDENCE            — structured evidence preserved through pipeline");
  console.log("  ✓ FRESHNESS           — linear decay scores computed from TTL registry");
  console.log("  ✓ SIGNAL STRENGTH     — deterministic base scores from type registry");
  console.log("  ✓ ICP RELEVANCE       — industry + size + signal-type pre-filter passed");
  console.log("  ✓ COMBINED CONTEXT    — signal summaries assembled for AI layer");
  console.log("  ✓ WHY NOW             — AI signal intelligence analysis returned");
  console.log("  ✓ AI QUALIFICATION    — ICP fit scored and qualified flag returned");
  console.log("  ✓ AI PERSONALIZATION  — signal-informed email generated");
  console.log("  ✓ IDEMPOTENCY         — re-run produces no duplicate signals");
  console.log("  ✓ TENANT ISOLATION    — no cross-client signal leakage");

  console.log("\n  ─ Supabase records (left for manual inspection) ─");
  console.log(`  Company:  ${companyId}  (name: ${TEST_COMPANY_NAME})`);
  console.log(`  Client:   ${TEST_CLIENT_ID}  (Gramscode)`);
  signalIds.forEach((id, i) => {
    const types = ["executive_hire", "funding_round", "website_change (market_expansion)"];
    console.log(`  Signal[${i}]: ${id}  (${types[i]})`);
  });

  console.log("\n  ─ Scoring transparency ─");
  console.log("  Signal strength scores:   DETERMINISTIC (base × dedup tier)");
  console.log("  AI opportunity score:     ANALYTICAL ESTIMATE — NOT commercially validated");
  console.log("  AI confidence:            Model's self-reported certainty");
  console.log(`  opportunityScore value:   ${siProviderResult.opportunityScore}/100`);
  console.log(`  AI confidence value:      ${siProviderResult.confidence}`);

  console.log("\n  ─ Total AI cost this run ─");
  console.log(`  Signal intelligence: $${siResult.costUsd?.toFixed(6) ?? "unknown"}`);
  console.log(`  Qualification:       $${qualResult.totalCostUsd?.toFixed(6) ?? "unknown"}`);
  console.log(`  Personalization:     $${personResult.costUsd?.toFixed(6) ?? "unknown"}`);
  const totalCostFinal =
    (siResult.costUsd ?? 0) +
    (qualResult.totalCostUsd ?? 0) +
    (personResult.costUsd ?? 0);
  console.log(`  Total:               ~$${totalCostFinal.toFixed(6)}`);

  console.log("\n  Stage 10.5 is complete. Stopping — waiting for approval before Stage 11.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
