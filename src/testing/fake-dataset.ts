/**
 * TEST/FAKE company dataset for E2E integration testing.
 *
 * ⚠️  ALL DATA IN THIS FILE IS FICTIONAL.
 * ⚠️  Never use these companies for real outbound campaigns.
 * ⚠️  All names, domains, and descriptions are invented test fixtures.
 *
 * 10 scenarios covering the full GTM pipeline:
 *   1  Clear ICP fit       — single low-tier call accepted
 *   2  Clear non-ICP       — single low-tier call rejected
 *   3  Borderline ICP      — barely above confidence threshold
 *   4  LOW → MEDIUM        — first escalation scenario
 *   5  LOW → MEDIUM (alt)  — second escalation scenario, different company
 *   6  LOW → MED → HIGH    — full 3-tier escalation chain
 *   7  Provider failure    — AI call throws; job marked failed
 *   8  Retry checkpoint-1  — stops after AI, resumes from checkpoint
 *   9  Duplicate submit    — same key submitted twice → idempotent return
 *  10  Multi-client        — same company, two clients → two separate jobs
 */
import type { QualificationInput } from "../domain/types.ts";

export const E2E_TEST_MARKER = "[E2E-TEST]";
export const E2E_SOURCE = "e2e-test-fake";
const FETCHED_AT = "2026-08-28T00:00:00.000Z";

export const TEST_ICP = {
  industry: "SaaS",
  employeeRange: { min: 20, max: 500 },
  description: "B2B SaaS companies in growth stage with outbound sales motion",
  keywords: ["sales", "outbound", "CRM", "GTM"],
};

export interface FakeScenario {
  scenarioId: number;
  name: string;
  description: string;
  expectedOutcome: string;
  companyDb: {
    name: string;
    domain: string;
    website_url: string;
    industry: string;
    company_size: string;
    country: string;
    city: string;
    region: string;
    source: string;
  };
  qualInput: QualificationInput;
}

export const FAKE_SCENARIOS: FakeScenario[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1: Clear ICP Fit
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 1,
    name: "TechFlow SaaS [TEST]",
    description: "Clear ICP fit — B2B SaaS, growth stage, US market",
    expectedOutcome: "icpFit=true, 1 attempt, confidence>=0.75",
    companyDb: {
      name: "[E2E-TEST] TechFlow SaaS",
      domain: "techflow-fake-test.io",
      website_url: "https://techflow-fake-test.io",
      industry: "SaaS",
      company_size: "51-200",
      country: "United States",
      city: "Austin",
      region: "Texas",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] TechFlow SaaS",
        domain: "techflow-fake-test.io",
        industry: "SaaS",
        employeeCount: 120,
        city: "Austin",
        region: "Texas",
        country: "United States",
        description: "B2B sales engagement platform helping GTM teams run outbound at scale",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["hiring SDRs", "recently raised Series A", "using Salesforce"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 2: Clear Non-ICP
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 2,
    name: "BrickLayer Construction [TEST]",
    description: "Clear non-ICP — construction company, wrong industry",
    expectedOutcome: "icpFit=false, 1 attempt, confidence>=0.75",
    companyDb: {
      name: "[E2E-TEST] BrickLayer Construction",
      domain: "bricklayer-fake-test.com",
      website_url: "https://bricklayer-fake-test.com",
      industry: "Construction",
      company_size: "201-500",
      country: "United States",
      city: "Houston",
      region: "Texas",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] BrickLayer Construction",
        domain: "bricklayer-fake-test.com",
        industry: "Construction",
        employeeCount: 350,
        city: "Houston",
        region: "Texas",
        country: "United States",
        description: "Commercial and residential construction contractor serving the Gulf Coast",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["new building permits", "equipment leasing"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 3: Borderline ICP
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 3,
    name: "MidPoint Analytics [TEST]",
    description: "Borderline ICP — data analytics SaaS, small team, weak signals",
    expectedOutcome: "icpFit=true, 1 attempt, confidence just above 0.75",
    companyDb: {
      name: "[E2E-TEST] MidPoint Analytics",
      domain: "midpoint-analytics-fake-test.io",
      website_url: "https://midpoint-analytics-fake-test.io",
      industry: "Data & Analytics",
      company_size: "11-50",
      country: "United States",
      city: "Denver",
      region: "Colorado",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] MidPoint Analytics",
        domain: "midpoint-analytics-fake-test.io",
        industry: "Data & Analytics",
        employeeCount: 42,
        city: "Denver",
        region: "Colorado",
        country: "United States",
        description: "Self-serve analytics for mid-market companies; some sales motion but mostly PLG",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["product-led growth", "freemium plan"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 4: LOW → MEDIUM escalation
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 4,
    name: "UpScale Commerce [TEST]",
    description: "LOW→MEDIUM escalation — e-commerce SaaS, ambiguous signals",
    expectedOutcome: "2 attempts (low escalated, medium accepted), confidence>=0.75 at medium",
    companyDb: {
      name: "[E2E-TEST] UpScale Commerce",
      domain: "upscale-commerce-fake-test.io",
      website_url: "https://upscale-commerce-fake-test.io",
      industry: "E-Commerce Technology",
      company_size: "51-200",
      country: "Canada",
      city: "Toronto",
      region: "Ontario",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] UpScale Commerce",
        domain: "upscale-commerce-fake-test.io",
        industry: "E-Commerce Technology",
        employeeCount: 85,
        city: "Toronto",
        region: "Ontario",
        country: "Canada",
        description: "Shopify app ecosystem player building checkout and post-purchase tools",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["Shopify Plus partner", "expanding to US"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 5: LOW → MEDIUM (second instance)
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 5,
    name: "GrowthPulse Marketing [TEST]",
    description: "LOW→MEDIUM escalation — martech SaaS, UK market",
    expectedOutcome: "2 attempts (low escalated, medium accepted)",
    companyDb: {
      name: "[E2E-TEST] GrowthPulse Marketing",
      domain: "growthpulse-fake-test.io",
      website_url: "https://growthpulse-fake-test.io",
      industry: "Marketing Technology",
      company_size: "11-50",
      country: "United Kingdom",
      city: "London",
      region: "England",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] GrowthPulse Marketing",
        domain: "growthpulse-fake-test.io",
        industry: "Marketing Technology",
        employeeCount: 62,
        city: "London",
        region: "England",
        country: "United Kingdom",
        description: "Email automation platform for B2B marketers with CRM integrations",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["LinkedIn Ads spend", "content-led growth"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 6: LOW → MEDIUM → HIGH (full escalation)
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 6,
    name: "MegaScale Enterprise [TEST]",
    description: "Full 3-tier escalation — large enterprise software, complex signals",
    expectedOutcome: "3 attempts (low→medium→high), accepted at high tier",
    companyDb: {
      name: "[E2E-TEST] MegaScale Enterprise",
      domain: "megascale-enterprise-fake-test.com",
      website_url: "https://megascale-enterprise-fake-test.com",
      industry: "Enterprise Software",
      company_size: "501-1000",
      country: "Germany",
      city: "Berlin",
      region: "Berlin",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] MegaScale Enterprise",
        domain: "megascale-enterprise-fake-test.com",
        industry: "Enterprise Software",
        employeeCount: 900,
        city: "Berlin",
        region: "Berlin",
        country: "Germany",
        description: "SAP ecosystem integrator building vertical ERP modules for manufacturing",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["SAP partner", "digital transformation initiative", "US expansion announced"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 7: Provider failure
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 7,
    name: "FailFast Fintech [TEST]",
    description: "Provider failure — AI call throws; job must be marked failed",
    expectedOutcome: "job.status='failed', enrichment_runs=0, task throws",
    companyDb: {
      name: "[E2E-TEST] FailFast Fintech",
      domain: "failfast-fintech-fake-test.io",
      website_url: "https://failfast-fintech-fake-test.io",
      industry: "Fintech",
      company_size: "11-50",
      country: "United States",
      city: "New York",
      region: "New York",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] FailFast Fintech",
        domain: "failfast-fintech-fake-test.io",
        industry: "Fintech",
        employeeCount: 30,
        city: "New York",
        region: "New York",
        country: "United States",
        description: "B2B payments API for marketplace platforms",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["fintech API", "developer-first"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 8: Retry after checkpoint-1 (ai_executed)
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 8,
    name: "RetryRight Software [TEST]",
    description: "Retry after AI checkpoint — first run stops after AI, second resumes",
    expectedOutcome: "2 task calls, 1 AI execution total, enrichment written on second call",
    companyDb: {
      name: "[E2E-TEST] RetryRight Software",
      domain: "retryright-software-fake-test.io",
      website_url: "https://retryright-software-fake-test.io",
      industry: "DevOps & Infrastructure",
      company_size: "51-200",
      country: "United States",
      city: "Seattle",
      region: "Washington",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] RetryRight Software",
        domain: "retryright-software-fake-test.io",
        industry: "DevOps & Infrastructure",
        employeeCount: 95,
        city: "Seattle",
        region: "Washington",
        country: "United States",
        description: "CI/CD and deployment automation platform for engineering teams",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["GitHub Actions competitor", "Series B funded"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 9: Duplicate submission (idempotency)
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 9,
    name: "DupeCheck Agency [TEST]",
    description: "Duplicate submission — same idempotency key submitted twice",
    expectedOutcome: "second call returns decision='done', no new enrichment rows",
    companyDb: {
      name: "[E2E-TEST] DupeCheck Agency",
      domain: "dupecheck-agency-fake-test.io",
      website_url: "https://dupecheck-agency-fake-test.io",
      industry: "Sales Enablement",
      company_size: "11-50",
      country: "United States",
      city: "Chicago",
      region: "Illinois",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] DupeCheck Agency",
        domain: "dupecheck-agency-fake-test.io",
        industry: "Sales Enablement",
        employeeCount: 28,
        city: "Chicago",
        region: "Illinois",
        country: "United States",
        description: "Outbound sales agency offering SDR-as-a-service for B2B SaaS startups",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["SDR outsourcing", "intent data buyer"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 10: Multi-client isolation
  // ─────────────────────────────────────────────────────────────────────────
  {
    scenarioId: 10,
    name: "MultiClient Labs [TEST]",
    description: "Multi-client — same company submitted by two different clients",
    expectedOutcome: "two separate jobs with different job IDs and client_ids",
    companyDb: {
      name: "[E2E-TEST] MultiClient Labs",
      domain: "multiclient-labs-fake-test.io",
      website_url: "https://multiclient-labs-fake-test.io",
      industry: "SaaS",
      company_size: "51-200",
      country: "United States",
      city: "San Francisco",
      region: "California",
      source: E2E_SOURCE,
    },
    qualInput: {
      company: {
        name: "[E2E-TEST] MultiClient Labs",
        domain: "multiclient-labs-fake-test.io",
        industry: "SaaS",
        employeeCount: 150,
        city: "San Francisco",
        region: "California",
        country: "United States",
        description: "Revenue intelligence platform serving multiple verticals",
        source: E2E_SOURCE,
        fetchedAt: FETCHED_AT,
      },
      icp: TEST_ICP,
      signals: ["revenue intelligence", "multi-vertical SaaS"],
    },
  },
];
