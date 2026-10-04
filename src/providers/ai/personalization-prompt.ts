/**
 * Pure prompt + schema for AI personalization. No SDK imports — testable offline.
 *
 * Mirrors the qualification-prompt.ts pattern: system prompt, JSON schema, and
 * a user prompt builder that serializes PersonalizationInput into a prompt string.
 */
import type { PersonalizationInput } from "../../domain/types";

export const PERSONALIZATION_SYSTEM = [
  "You are an expert B2B cold outbound copywriter.",
  "Write a short, personalized cold email that feels human and specific — never salesy or generic.",
  "",
  "Hard rules:",
  "- Subject line: under 50 characters, sentence case, no hype words.",
  "- Body: exactly 3–5 short sentences. Plain text. No bullet points.",
  "- Open with something specific to THIS company (industry, size, city) — not a generic opener.",
  "- Weave in the value proposition naturally — do NOT copy it verbatim.",
  "- Close with the call to action as a soft, low-pressure question.",
  "- Sound like a thoughtful person writing a direct message, not a marketing template.",
  "- Return valid JSON only.",
].join("\n");

/** JSON schema for structured output (output_config.format.json_schema). */
export const PERSONALIZATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string", description: "Email subject line, max 50 chars" },
    message: { type: "string", description: "Email body, 3–5 sentences, plain text" },
    tone: {
      type: "string",
      enum: ["professional", "casual", "consultative", "direct"],
      description: "Tone chosen for this specific company",
    },
    confidence: {
      type: "number",
      description: "0-1 — how well this message fits the company's profile",
    },
  },
  required: ["subject", "message", "tone", "confidence"],
} as const;

/** Build the user message from a PersonalizationInput. */
export function buildPersonalizationPrompt(input: PersonalizationInput): string {
  const c = input.company;

  const companyLines = [
    `name: ${c.name}`,
    c.industry ? `industry: ${c.industry}` : null,
    c.employeeCount ? `size: ~${c.employeeCount} employees` : null,
    c.city && c.country ? `location: ${c.city}, ${c.country}` : c.country ? `country: ${c.country}` : null,
    c.description ? `description: ${c.description}` : null,
  ]
    .filter(Boolean)
    .map((l) => `  - ${l}`)
    .join("\n");

  const contactLine = input.contact
    ? `\nContact:\n  - name: ${input.contact.fullName}` +
      (input.contact.title ? `\n  - title: ${input.contact.title}` : "")
    : "";

  const campaignLines = [
    `  - objective: ${input.campaign.objective}`,
    `  - value prop: ${input.campaign.valueProposition}`,
    `  - CTA: ${input.campaign.callToAction}`,
  ].join("\n");

  const icpLines = [
    input.icp.industry ? `  - target industry: ${input.icp.industry}` : null,
    input.icp.employeeRange
      ? `  - target size: ${input.icp.employeeRange.min ?? "?"}–${input.icp.employeeRange.max ?? "?"} employees`
      : null,
    input.icp.description ? `  - ICP notes: ${input.icp.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const signalSection = input.signalContext
    ? [
        "",
        "SIGNAL CONTEXT (use these to write a specific, event-driven message):",
        `  Why now: ${input.signalContext.whyNow}`,
        `  Relevant signals: ${input.signalContext.relevantSignals.join(", ")}`,
        `  Opportunity score: ${input.signalContext.opportunityScore}/100 (analytical estimate)`,
        "  → Reference one specific signal in the opening sentence. Make it concrete.",
      ].join("\n")
    : "";

  return [
    "COMPANY:",
    companyLines || "  (no fields provided)",
    contactLine,
    "",
    "CAMPAIGN:",
    campaignLines,
    "",
    "ICP CONTEXT:",
    icpLines || "  (none provided)",
    signalSection,
    "",
    "Write a personalized outbound email for this company. Return JSON only.",
  ]
    .join("\n")
    .trim();
}
