import Anthropic from "@anthropic-ai/sdk";
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

export interface AnthropicProviderOptions {
  /** Defaults to "claude-opus-4-8". */
  model?: string;
  /** Enable extended thinking (adaptive). Slower and more expensive — use only for complex tasks. */
  enableThinking?: boolean;
  /** Token budget for the response. Defaults to 4096; set higher when thinking is enabled. */
  maxTokens?: number;
}

let _client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!_client) {
    const workspaceId = optionalEnv(ENV_KEYS.anthropicWorkspaceId);
    _client = new Anthropic({
      apiKey: requireEnv(ENV_KEYS.anthropicApiKey),
      ...(workspaceId && { defaultHeaders: { "anthropic-workspace-id": workspaceId } }),
    });
  }
  return _client;
}

/**
 * Direct Anthropic SDK provider — bypasses OpenRouter entirely.
 *
 * Advantages over OpenRouterProvider for Claude tasks:
 *   - Native output_config.format.json_schema: response is GUARANTEED valid JSON
 *     (enforced at the model level, not via system-prompt injection).
 *   - Native extended thinking support (thinking: { type: "adaptive" }).
 *   - No gateway markup (5–15% cheaper for heavy Claude usage).
 *   - One fewer network hop (lower latency for latency-sensitive tasks).
 *
 * Use this for: icp_qualification, campaign_strategy — tasks that require
 * guaranteed structured output or deep reasoning.
 */
export class AnthropicDirectProvider implements AIProvider {
  readonly id: string;
  readonly capability = "ai" as const;

  private readonly model: string;
  private readonly enableThinking: boolean;
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.model = opts.model ?? "claude-opus-4-8";
    this.enableThinking = opts.enableThinking ?? false;
    this.maxTokens = opts.maxTokens ?? (this.enableThinking ? 8000 : 4096);
    this.id = `anthropic-direct:${this.model}`;
  }

  isConfigured(): boolean {
    return optionalEnv(ENV_KEYS.anthropicApiKey) !== undefined;
  }

  async qualifyCompany(input: QualificationInput): Promise<QualificationResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: QUALIFICATION_SYSTEM,
      // Native JSON schema enforcement — guaranteed parseable, no prompt injection.
      output_config: {
        format: { type: "json_schema", schema: QUALIFICATION_SCHEMA },
      },
      messages: [{ role: "user", content: buildQualificationPrompt(input) }],
      ...(this.enableThinking && { thinking: { type: "adaptive" } }),
    } as Anthropic.MessageCreateParamsNonStreaming;

    const response = await getClient().messages.create(params);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("AnthropicDirectProvider.qualifyCompany: no text block in response");
    }

    const parsed = JSON.parse(textBlock.text) as Omit<
      QualificationResult,
      "model" | "qualifiedAt" | "inputTokens" | "outputTokens"
    >;

    return {
      ...parsed,
      model: this.model,
      qualifiedAt: new Date().toISOString(),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  async personalizeMessage(input: PersonalizationInput): Promise<PersonalizationResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: PERSONALIZATION_SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: PERSONALIZATION_SCHEMA },
      },
      messages: [{ role: "user", content: buildPersonalizationPrompt(input) }],
    } as Anthropic.MessageCreateParamsNonStreaming;

    const response = await getClient().messages.create(params);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("AnthropicDirectProvider.personalizeMessage: no text block in response");
    }

    const parsed = JSON.parse(textBlock.text) as Omit<
      PersonalizationResult,
      "model" | "personalizedAt" | "inputTokens" | "outputTokens"
    >;

    return {
      ...parsed,
      model: this.model,
      personalizedAt: new Date().toISOString(),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  async analyzeSignals(input: SignalIntelligenceInput): Promise<SignalIntelligenceResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: SIGNAL_INTELLIGENCE_SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: SIGNAL_INTELLIGENCE_SCHEMA },
      },
      messages: [{ role: "user", content: buildSignalIntelligencePrompt(input) }],
    } as Anthropic.MessageCreateParamsNonStreaming;

    const response = await getClient().messages.create(params);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("AnthropicDirectProvider.analyzeSignals: no text block in response");
    }

    const parsed = JSON.parse(textBlock.text) as Omit<
      SignalIntelligenceResult,
      "model" | "analyzedAt" | "inputTokens" | "outputTokens"
    >;

    return {
      ...parsed,
      model: this.model,
      analyzedAt: new Date().toISOString(),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
