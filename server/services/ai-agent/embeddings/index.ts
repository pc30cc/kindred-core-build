/**
 * AI Agent — Embedding provider resolver.
 *
 * Tries to reuse the workspace AI provider config (so admins don't manage two
 * separate sets of keys). Returns the noop provider when no usable embedding
 * backend exists — callers must handle this and fall back to keyword search.
 */
import type { ServerConfig } from '../../../config.js';
import { resolveAIConfig } from '../../ai/index.js';
import type { EmbeddingProvider } from './provider.js';
import { noopEmbeddingProvider } from './noop.js';
import { buildOpenAIEmbeddingProvider, isOpenAICompatible } from './openai.js';

export type { EmbeddingProvider } from './provider.js';
export { EMBED_BATCH_SIZE, EMBED_MAX_CHARS, clipForEmbedding } from './provider.js';

const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const DEFAULT_DIMENSIONS = 1536;

export async function resolveEmbeddingProvider(
  config: ServerConfig,
  workspaceId: string,
): Promise<EmbeddingProvider> {
  try {
    const ai = await resolveAIConfig(config, workspaceId);
    if (!ai || !ai.apiKey) return noopEmbeddingProvider;
    if (!isOpenAICompatible(ai.provider)) return noopEmbeddingProvider;
    // No endpoint default here: the AI Runtime owns the provider catalog.
    return buildOpenAIEmbeddingProvider(config, {
      provider: ai.provider,
      apiKey: ai.apiKey,
      baseUrl: ai.baseUrl,
      model: DEFAULT_EMBEDDING_MODEL,
      orgId: ai.orgId,
      dimensions: DEFAULT_DIMENSIONS,
    });
  } catch (err) {
    console.warn('[ai-agent.embeddings] resolve failed, using noop:', (err as any)?.message);
    return noopEmbeddingProvider;
  }
}


export function isUsableEmbeddingProvider(p: EmbeddingProvider): boolean {
  return p.name !== 'noop';
}