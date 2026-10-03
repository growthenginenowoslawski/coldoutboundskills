/**
 * Pure prompt + schema for AI ICP qualification. No SDK imports here so it can
 * be unit-tested offline. The rule that matters most: the model must ground its
 * verdict ONLY in the provided data and never invent facts.
 */
import type { QualificationInput } from "../../domain/types";

export const QUALIFICATION_SYSTEM = [
  "You are a precise B2B ICP (Ideal Customer Profile) qualifier.",
  "You are given a company's known data and an ICP definition. Decide whether the",
  "company fits the ICP and assign a 0-100 score.",
  "",
  "Hard rules:",
  "- Use ONLY the company data provided. Do NOT invent facts, employee counts,",
  "  revenue, or details that are not present.",
  "- Distinguish observed data (present in the input) from inference. If a field",
  "  needed to judge a criterion is missing, treat that criterion as UNMET and say",
  "  so in `reason`; do not guess.",
  "- A *Match boolean is true only when the provided data actually supports it.",
  "  When the relevant data is unknown, set it false and note the uncertainty.",
  "- `confidence` (0-1) reflects how sufficient the data was to judge — low when",
  "  key fields are missing.",
  "- `signals` must be short phrases grounded in the input, not speculation.",
].join("\n");

/** JSON Schema for structured output (output_config.format). */
export const QUALIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    icpFit: { type: "boolean", description: "Overall: does this company fit the ICP?" },
    score: { type: "integer", description: "0-100 fit score" },
    industryMatch: { type: "boolean" },
    sizeMatch: { type: "boolean" },
    locationMatch: { type: "boolean" },
    reason: { type: "string", description: "1-3 sentences, grounded in the provided data" },
    signals: { type: "array", items: { type: "string" } },
    confidence: { type: "number", description: "0-1 confidence given data sufficiency" },
  },
  required: [
    "icpFit",
    "score",
    "industryMatch",
    "sizeMatch",
    "locationMatch",
    "reason",
    "signals",
    "confidence",
  ],
} as const;

/** Build the user message: the company's known fields + the ICP definition. */
export function buildQualificationPrompt(input: QualificationInput): string {
  const c = input.company;
  const known: [string, unknown][] = [
    ["name", c.name],
    ["domain", c.domain],
    ["website", c.website],
    ["industry", c.industry],
    ["city", c.city],
    ["region", c.region],
    ["country", c.country],
    ["employeeCount", c.employeeCount],
    ["description", c.description],
  ];
  const companyLines = known
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join("\n");

  const icp = input.icp;
  const icpLines = [
    icp.industry ? `  - industry: ${icp.industry}` : "",
    icp.location ? `  - location: ${icp.location}` : "",
    icp.employeeRange
      ? `  - employee range: ${icp.employeeRange.min ?? "?"}–${icp.employeeRange.max ?? "?"}`
      : "",
    icp.keywords?.length ? `  - keywords: ${icp.keywords.join(", ")}` : "",
    icp.description ? `  - notes: ${icp.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const signals = input.signals?.length
    ? `\nAdditional signals:\n${input.signals.map((s) => `  - ${s}`).join("\n")}`
    : "";

  return [
    "COMPANY (known data only):",
    companyLines || "  (no fields provided)",
    "",
    "ICP DEFINITION:",
    icpLines || "  (none provided)",
    signals,
    "",
    "Return the qualification as structured JSON.",
  ].join("\n");
}
