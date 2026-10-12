import OpenAI from "openai";
import { ENV_KEYS, optionalEnv, requireEnv } from "../../config/env";
import type { PersonalizationInput, PersonalizationResult, QualificationInput, QualificationResult } from "../../domain/types";
import type { SignalIntelligenceInput, SignalIntelligenceResult } from "../../domain/signal-types";
import type { AIProvider } from "../types";
import {
  buildQualificationPrompt,
  QUALIFICATION_SCHEMA,
  QUALIFICATION_SYSTEM,
} from "./qualification-prompt";
import {
  buildPersonalizationPrompt,
  PERSONALIZATION_SCHEMA,
  PERSONALIZATION_SYSTEM,
} from "./personalization-prompt";
import {
  buildSignalIntelligencePrompt,
  SIGNAL_INTELLIGENCE_SCHEMA,
  SIGNAL_INTELLIGENCE_SYSTEM,
} from "./signal-intelligence-prompt";

export interface OpenRouterProviderOptions {
  model: string;
  fallbacks?: string[];
}

let _client: OpenAI | undefined;
function getClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: requireEnv(ENV_KEYS.openrouterApiKey),
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://gramscode.com",
        "X-Title": "Gramscode GTM",
      },
    });
  }
  return _client;
}

export class OpenRouterProvider implements AIProvider {
  readonly id: string;
  readonly capability = "ai" as const;
  private readonly model: string;
  private readonly fallbacks: string[];

  constructor(opts: OpenRouterProviderOptions) {
    this.model = opts.model;
    this.fallbacks = opts.fallbacks ?? [];
    this.id = `openrouter:${opts.model}`;
  }

  isConfigured(): boolean {
    return optionalEnv(ENV_KEYS.openrouterApiKey) !== undefined;
  }

  async qualifyCompany(input: QualificationInput): Promise<QualificationResult> {
    const base = {
      model: this.model,
      messages: [
        { role: "system" as const, content: QUALIFICATION_SYSTEM },
        { role: "user" as const, content: buildQualificationPrompt(input) },
      ],
      response_format: {
        type: "json_schema" as const,
        json_schema: {
          name: "qualification",
          strict: true,
          schema: QUALIFICATION_SCHEMA as Record<string, unknown>,
        },
      },
      max_tokens: 2000,
    };

    // Merge OpenRouter-specific fallback fields when configured.
    const requestBody =
      this.fallbacks.length > 0
        ? { ...base, models: [this.model, ...this.fallbacks], route: "fallback" }
        : base;

    const response = await getClient().chat.completions.create(
      requestBody as Parameters<OpenAI["chat"]["completions"]["create"]>[0],
    );

    const text = response.choices[0]?.message?.content ?? "";
    let parsed: Omit<QualificationResult, "model" | "qualifiedAt" | "inputTokens" | "outputTokens">;

    try {
      parsed = JSON.parse(text);
    } catch {
      // One retry with strict JSON-only instruction to handle edge-case formatting.
      const retry = await getClient().chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              QUALIFICATION_SYSTEM +
              "\n\nCRITICAL: Return ONLY valid JSON. No markdown, no prose, no code fences.",
          },
          { role: "user", content: buildQualificationPrompt(input) },
        ],
        response_format: { type: "json_object" },
        max_tokens: 2000,
      });
      const retryText = retry.choices[0]?.message?.content ?? "";
      parsed = JSON.parse(retryText);
    }

    return {
      ...parsed,
      model: response.model ?? this.model,
      qualifiedAt: new Date().toISOString(),
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    };
  }

  async personalizeMessage(input: PersonalizationInput): Promise<PersonalizationResult> {
    const response = await getClient().chat.completions.create({
      model: this.model,
      messages: [
        { role: "system" as const, content: PERSONALIZATION_SYSTEM },
        { role: "user" as const, content: buildPersonalizationPrompt(input) },
      ],
      response_format: {
        type: "json_schema" as const,
        json_schema: {
          name: "personalization",
          strict: true,
          schema: PERSONALIZATION_SCHEMA as Record<string, unknown>,
        },
      },
      max_tokens: 1000,
    });

    const text = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as Omit<
      PersonalizationResult,
      "model" | "personalizedAt" | "inputTokens" | "outputTokens"
    >;

    return {
      ...parsed,
      model: response.model ?? this.model,
      personalizedAt: new Date().toISOString(),
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    };
  }

  async analyzeSignals(input: SignalIntelligenceInput): Promise<SignalIntelligenceResult> {
    const response = await getClient().chat.completions.create({
      model: this.model,
      messages: [
        { role: "system" as const, content: SIGNAL_INTELLIGENCE_SYSTEM },
        { role: "user" as const, content: buildSignalIntelligencePrompt(input) },
      ],
      response_format: {
        type: "json_schema" as const,
        json_schema: {
          name: "signal_intelligence",
          strict: true,
          schema: SIGNAL_INTELLIGENCE_SCHEMA as Record<string, unknown>,
        },
      },
      max_tokens: 1500,
    });

    const text = response.choices[0]?.message?.content ?? "";
    const parsed = JSON.parse(text) as Omit<
      SignalIntelligenceResult,
      "model" | "analyzedAt" | "inputTokens" | "outputTokens"
    >;

    return {
      ...parsed,
      model: response.model ?? this.model,
      analyzedAt: new Date().toISOString(),
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    };
  }
}
