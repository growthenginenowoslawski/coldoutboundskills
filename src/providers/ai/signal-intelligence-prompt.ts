/**
 * Pure prompt + schema for signal intelligence (WHY NOW analysis).
 * No SDK imports — fully testable offline.
 *
 * The AI receives structured, pre-scored signal context and produces a
 * WHY NOW assessment explaining why now is the right time to reach out.
 *
 * IMPORTANT: opportunityScore is an AI analytical estimate used to test
 * this architecture. It is NOT a commercially validated scoring model.
 */
import type { SignalIntelligenceInput } from "../../domain/signal-types";

export const SIGNAL_INTELLIGENCE_SYSTEM = [
  "You are a GTM timing analyst. Your job is to assess whether NOW is the right",
  "time to reach out to a company, based on structured buying signals.",
  "",
  "You receive: a company profile, an ICP definition, and a list of scored signals",
  "with freshness ratings. Your output explains the timing opportunity.",
  "",
  "Hard rules:",
  "- Ground your analysis ONLY in the signals provided. Do not invent events.",
  "- whyNow must be 1-2 sentences, specific to the signals. No generic statements.",
  "- opportunityScore (0-100) is your analytical estimate for architecture testing",
  "  only — it is NOT a commercially validated score. Reflect this in reasoning.",
  "- relevantSignals must be exact signal titles from the input, not paraphrases.",
  "- reasoning explains HOW each signal contributes to the timing assessment.",
  "- confidence (0-1) reflects how strongly the signals support the timing argument.",
  "- Return valid JSON only.",
].join("\n");

export const SIGNAL_INTELLIGENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    whyNow: {
      type: "string",
      description: "1-2 sentences explaining why now is the right moment to reach out, grounded in the signals.",
    },
    opportunityScore: {
      type: "number",
      description: "0-100 analytical estimate of timing opportunity. NOT commercially validated.",
    },
    relevantSignals: {
      type: "array",
      items: { type: "string" },
      description: "Exact titles of the signals that most support the timing assessment.",
    },
    reasoning: {
      type: "string",
      description: "Full explanation of how each relevant signal contributes to the timing window.",
    },
    confidence: {
      type: "number",
      description: "0-1 confidence in the assessment given the available signal data.",
    },
  },
  required: ["whyNow", "opportunityScore", "relevantSignals", "reasoning", "confidence"],
} as const;

/** Build the user prompt from a SignalIntelligenceInput. */
export function buildSignalIntelligencePrompt(input: SignalIntelligenceInput): string {
  const c = input.company;

  const companyLines = [
    `  name: ${c.name}`,
    c.industry ? `  industry: ${c.industry}` : null,
    c.employeeCount ? `  size: ~${c.employeeCount} employees` : null,
    c.city && c.country
      ? `  location: ${c.city}, ${c.country}`
      : c.country
        ? `  country: ${c.country}`
        : null,
    c.description ? `  description: ${c.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const icp = input.icp;
  const icpLines = [
    icp.industry ? `  target industry: ${icp.industry}` : null,
    icp.location ? `  target location: ${icp.location}` : null,
    icp.employeeRange
      ? `  target size: ${icp.employeeRange.min ?? "?"}–${icp.employeeRange.max ?? "?"} employees`
      : null,
    icp.keywords?.length ? `  keywords: ${icp.keywords.join(", ")}` : null,
    icp.description ? `  notes: ${icp.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const signalLines = input.signals
    .map((s, i) => {
      const evidenceSummary = Object.entries(s.evidence)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("; ");

      return [
        `${i + 1}. [${s.signalType.toUpperCase()}] ${s.title}`,
        `   Strength: ${s.signalStrength}/100 | Freshness: ${s.freshnessScore}/100 | Occurred: ${s.occurredAt.slice(0, 10)}`,
        s.description ? `   Context: ${s.description}` : null,
        evidenceSummary ? `   Evidence: ${evidenceSummary}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return [
    "COMPANY:",
    companyLines || "  (no fields provided)",
    "",
    "ICP:",
    icpLines || "  (none provided)",
    "",
    `ACTIVE SIGNALS (${input.signals.length}):`,
    signalLines || "  (none)",
    "",
    "Assess the timing opportunity for outreach to this company. Return JSON only.",
    "NOTE: opportunityScore is an analytical estimate for architecture testing only — not commercially validated.",
  ].join("\n");
}
