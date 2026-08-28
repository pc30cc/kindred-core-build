/**
 * AI provider endpoint catalog.
 *
 * ISOLATION RULE: this file names provider hostnames, so it must only ever be
 * imported by the AI Runtime deployable — never by `server/**` (Core). The
 * isolation guard test enforces that.
 */
import type { AIConfig } from '../../../shared/ai/types.js';

/** Default base URLs for OpenAI-compatible providers. */
export const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  perplexity: 'https://api.perplexity.ai',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** Providers that speak the OpenAI chat/embeddings wire format. */
export const OPENAI_COMPATIBLE = new Set([
  'openai',
  'azure_openai',
  'groq',
  'together',
  'mistral',
  'deepseek',
  'openrouter',
  'ollama',
]);

export function isOpenAICompatible(providerName: string): boolean {
  return OPENAI_COMPATIBLE.has(providerName);
}

/**
 * Providers with no public default endpoint. Without an explicit base URL the
 * OpenAI-compatible caller would silently fall back to api.openai.com and send
 * the provider's key there — fail fast instead.
 */
export const PROVIDERS_REQUIRING_BASE_URL = new Set(['azure_openai', 'ollama', 'cohere']);

export function assertProviderConfig(cfg: AIConfig): void {
  if (!cfg.apiKey && cfg.provider !== 'ollama') {
    throw new Error(`AI provider "${cfg.provider}" is missing an API key.`);
  }
  if (PROVIDERS_REQUIRING_BASE_URL.has(cfg.provider) && !cfg.baseUrl) {
    throw new Error(`AI provider "${cfg.provider}" requires an explicit base URL (endpoint).`);
  }
}

/** Applies the default endpoint for a provider when the operator left it blank. */
export function withDefaultBaseUrl(cfg: AIConfig): AIConfig {
  if (cfg.baseUrl) return cfg;
  const fallback = PROVIDER_BASE_URLS[cfg.provider];
  return fallback ? { ...cfg, baseUrl: fallback } : cfg;
}
