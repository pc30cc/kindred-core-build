/**
 * OpenAI-compatible embedding provider — Core side.
 *
 * PROVIDER NETWORK ISOLATION: Core does not call the embeddings endpoint.
 * It batches the texts and forwards them to the AI Runtime, which owns the
 * provider socket (runtime/ai/providers/embeddings.ts).
 *
 * Uses the same workspace AI provider config (OpenAI / Azure OpenAI / Ollama
 * / OpenRouter / etc) so admins don't have to configure embeddings separately.
 * If the configured provider isn't OpenAI-compatible, callers fall back to noop.
 */
import type { ServerConfig } from '../../../config.js';
import type { EmbeddingProvider, EmbedOptions } from './provider.js';
import { EMBED_BATCH_SIZE, clipForEmbedding } from './provider.js';
import { runtimeEmbed } from '../../ai/runtimeClient.js';

/**
 * Providers speaking the OpenAI embeddings wire format. Kept as plain names —
 * no endpoint hostnames live in Core; the runtime owns the endpoint catalog.
 */
const OPENAI_COMPATIBLE = new Set([
  'openai',
  'azure_openai',
  'groq',
  'together',
  'mistral',
  'deepseek',
  'openrouter',
  'ollama',
]);

export interface OpenAIEmbeddingResolved {
  provider: string;
  apiKey: string;
  /** Optional operator-configured endpoint; the runtime applies defaults. */
  baseUrl?: string;
  model: string;
  orgId?: string;
  dimensions: number;
}

export function isOpenAICompatible(providerName: string): boolean {
  return OPENAI_COMPATIBLE.has(providerName);
}

export function buildOpenAIEmbeddingProvider(
  serverConfig: ServerConfig,
  cfg: OpenAIEmbeddingResolved,
): EmbeddingProvider {
  return {
    name: cfg.provider,
    model: cfg.model,
    dimensions: cfg.dimensions,
    async embedTexts(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
      if (!texts.length) return [];
      const out: number[][] = [];
      const cleaned = texts.map((t) => clipForEmbedding(t, opts?.truncateChars));
      for (let i = 0; i < cleaned.length; i += EMBED_BATCH_SIZE) {
        const batch = cleaned.slice(i, i + EMBED_BATCH_SIZE);
        const vectors = await runtimeEmbed(
          serverConfig,
          {
            provider: cfg.provider,
            apiKey: cfg.apiKey,
            model: cfg.model,
            baseUrl: cfg.baseUrl,
            orgId: cfg.orgId,
          },
          batch,
        );
        out.push(...vectors);
      }
      return out;
    },
  };
}
