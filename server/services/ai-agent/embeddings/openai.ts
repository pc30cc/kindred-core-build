/**
 * OpenAI-compatible embedding provider.
 *
 * Uses the same workspace AI provider config (OpenAI / Azure OpenAI / Ollama
 * / OpenRouter / etc) so admins don't have to configure embeddings separately.
 * If the configured provider isn't OpenAI-compatible, we fall back to noop.
 */
import type { EmbeddingProvider, EmbedOptions } from './provider.js';
import { EMBED_BATCH_SIZE, clipForEmbedding } from './provider.js';

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

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  together: 'https://api.together.xyz/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

export interface OpenAIEmbeddingResolved {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  orgId?: string;
  dimensions: number;
}

export function isOpenAICompatible(providerName: string): boolean {
  return OPENAI_COMPATIBLE.has(providerName);
}

export function buildOpenAIEmbeddingProvider(cfg: OpenAIEmbeddingResolved): EmbeddingProvider {
  return {
    name: cfg.provider,
    model: cfg.model,
    dimensions: cfg.dimensions,
    async embedTexts(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
      if (!texts.length) return [];
      const out: number[][] = [];
      const cleaned = texts.map((t) => clipForEmbedding(t, opts?.truncateChars));
      // Batch
      for (let i = 0; i < cleaned.length; i += EMBED_BATCH_SIZE) {
        const batch = cleaned.slice(i, i + EMBED_BATCH_SIZE);
        const res = await fetch(`${cfg.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
            ...(cfg.orgId ? { 'OpenAI-Organization': cfg.orgId } : {}),
          },
          body: JSON.stringify({ model: cfg.model, input: batch }),
        });
        if (!res.ok) {
          const err: any = await res.json().catch(() => ({} as any));
          throw new Error(`embedding_provider_error: ${err?.error?.message || res.statusText}`);
        }
        const data: any = await res.json();
        for (const row of (data?.data as any[]) || []) {
          out.push(row.embedding || []);
        }
      }
      return out;
    },
  };
}

export { PROVIDER_BASE_URLS };