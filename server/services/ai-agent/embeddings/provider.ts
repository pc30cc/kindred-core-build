/**
 * AI Agent — Embedding provider interface.
 *
 * All embedding providers run server-side only. API keys never reach the
 * frontend. Resolution piggy-backs on the existing AI provider config so we
 * don't introduce a parallel secrets/keys system.
 */

import type { AiRunContext } from '../../ai-billing/runContext.js';

export interface EmbedOptions {
  /** Soft hint for the caller; providers may ignore. */
  truncateChars?: number;
  /**
   * AI billing — the business-operation Run this embedding belongs to.
   * When present, every batch is recorded as an EMBEDDING step of that Run
   * instead of being lost outside the financial boundary.
   */
  runCtx?: AiRunContext | null;
}

export interface EmbeddingProvider {
  /** Stable provider id (e.g. 'openai', 'noop'). */
  name: string;
  /** Model id (e.g. 'text-embedding-3-small'). */
  model: string;
  /** Embedding dimensionality. Must match the DB vector column. */
  dimensions: number;
  /** Returns one vector per input text. May return [] when disabled. */
  embedTexts(texts: string[], opts?: EmbedOptions): Promise<number[][]>;
}

/** Hard cap per text — keeps token usage predictable. */
export const EMBED_MAX_CHARS = 6000;
/** Batch size cap (OpenAI accepts up to 2048; we stay well below). */
export const EMBED_BATCH_SIZE = 32;

export function clipForEmbedding(text: string, max = EMBED_MAX_CHARS): string {
  const t = (text || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}