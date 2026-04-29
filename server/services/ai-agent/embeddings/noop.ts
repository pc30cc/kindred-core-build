import type { EmbeddingProvider } from './provider.js';

/**
 * No-op embedding provider — used when AI/embedding provider is unavailable.
 * Hybrid retrieval gracefully falls back to keyword search.
 */
export const noopEmbeddingProvider: EmbeddingProvider = {
  name: 'noop',
  model: 'noop',
  dimensions: 1536,
  async embedTexts(): Promise<number[][]> {
    return [];
  },
};