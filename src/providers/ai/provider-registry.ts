import type { AIProvider } from "../types";
import { AnthropicDirectProvider } from "./anthropic-provider";
import { OpenRouterProvider } from "./openrouter-provider";

/**
 * The set of AI provider implementations available to the ModelRouter.
 * Adding a new provider = add a name here + a case in makeProvider().
 */
export type ProviderName = "anthropic-direct" | "openrouter";

/**
 * Factory that instantiates the correct AIProvider for a given name + model.
 *
 * This is intentionally a function, not a class — it holds no state and needs
 * no singleton. The router calls it to get a fresh provider instance, then
 * checks isConfigured() before using it.
 *
 * The exhaustive switch ensures TypeScript will error at compile time if a new
 * ProviderName is added without a corresponding case.
 */
export function makeProvider(provider: ProviderName, model: string): AIProvider {
  switch (provider) {
    case "anthropic-direct":
      return new AnthropicDirectProvider({ model });
    case "openrouter":
      return new OpenRouterProvider({ model });
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown AI provider: "${_exhaustive}"`);
    }
  }
}
