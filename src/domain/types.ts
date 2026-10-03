/**
 * Core domain types shared across providers, tasks, and the API.
 * These are provider-agnostic on purpose: every provider normalizes INTO these
 * shapes so the rest of the system never depends on a vendor's payload.
 */

/** A company research request (the input to the sourcing engine). */
export interface SearchQuery {
  industry?: string;
  location?: string;
  employeeRange?: { min?: number; max?: number };
  keywords?: string[];
  competitor?: string;
  trigger?: string;
  /** Hard cap on companies to return — a cost-control lever. */
  limit: number;
}

/**
 * Distinguishes what we actually saw from what was guessed, so the AI layer
 * (and you) never mistake an inference for a fact.
 */
export type DataConfidence = "observed" | "inferred" | "unknown";

/** A normalized company record. Identity for dedup is domain first, name second. */
export interface CompanyRecord {
  name: string;
  /** Bare host, lowercased, no protocol/path/www — undefined if unknown. */
  domain?: string;
  website?: string;
  description?: string;
  industry?: string;
  /** Human-readable combined location (for logs/display). */
  location?: string;
  /** Structured location — maps to companies.city / region / country. */
  city?: string;
  region?: string;
  country?: string;
  employeeCount?: number;
  /** Provider id that produced this record, e.g. "apify", "exa". */
  source: string;
  /** The record's id within that source, for provenance + re-fetch. */
  sourceRecordId?: string;
  /** Original provider payload, kept for audit. */
  raw?: unknown;
  /** ISO timestamp of when this was fetched. */
  fetchedAt: string;
}

/** Input for the AI personalization task. */
export interface PersonalizationInput {
  company: CompanyRecord;
  contact?: PersonRecord;
  campaign: {
    /** What the email is trying to achieve. */
    objective: string;
    /** Why the recipient should care — the core pitch. */
    valueProposition: string;
    /** Low-pressure ask at the end of the email. */
    callToAction: string;
  };
  icp: {
    industry?: string;
    employeeRange?: { min?: number; max?: number };
    description?: string;
  };
  /**
   * Optional signal context from the WHY NOW layer.
   * When present, the AI uses these signals to write a more specific,
   * event-driven message rather than relying solely on company metadata.
   */
  signalContext?: {
    whyNow: string;
    /** AI-generated score 0-100. ANALYTICAL ESTIMATE — not commercially validated. */
    opportunityScore: number;
    relevantSignals: string[];
  };
}

/** Structured personalization verdict — mirrors QualificationResult's contract. */
export interface PersonalizationResult {
  /** Email subject line. */
  subject: string;
  /** Email body — 3–5 sentences, plain text. */
  message: string;
  /** Tone chosen by the model. */
  tone: string;
  /** 0-1 self-reported confidence the message will resonate. */
  confidence: number;
  // Observability (satisfies AITaskResult contract):
  model: string;
  personalizedAt: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** A normalized person/contact record (minimal for now; expands in Stage 6). */
export interface PersonRecord {
  fullName: string;
  title?: string;
  companyDomain?: string;
  linkedinUrl?: string;
  source: string;
  sourceRecordId?: string;
  raw?: unknown;
  fetchedAt: string;
}

/** Everything the AI qualifier is allowed to reason over. */
export interface QualificationInput {
  company: CompanyRecord;
  icp: {
    industry?: string;
    location?: string;
    employeeRange?: { min?: number; max?: number };
    keywords?: string[];
    description?: string;
  };
  /** Extra research signals gathered during enrichment. */
  signals?: string[];
}

/** Structured qualification verdict — never free-form text. */
export interface QualificationResult {
  icpFit: boolean;
  /** 0-100. */
  score: number;
  industryMatch: boolean;
  sizeMatch: boolean;
  locationMatch: boolean;
  reason: string;
  signals: string[];
  /** 0-1 self-reported confidence. */
  confidence: number;
  /** Provenance of the judgment. */
  model: string;
  qualifiedAt: string;
  /** Token usage — populated by providers that expose usage (e.g. OpenRouter). */
  inputTokens?: number;
  outputTokens?: number;
}
