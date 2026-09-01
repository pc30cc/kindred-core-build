/**
 * Knowledge indexer — upserts chunks for a single source.
 *
 * Idempotent. Skips re-embedding when content_hash hasn't changed. Marks any
 * orphaned chunks (chunk_index >= newCount) as deleted.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import type { Chunk } from './chunker.js';
import { chunkHash } from './hash.js';
import { resolveEmbeddingProvider, isUsableEmbeddingProvider, type EmbeddingProvider } from '../embeddings/index.js';

export type SourceType = 'kb_article' | 'qna' | 'learned_qna' | 'web_page' | 'file' | 'business_profile';

export interface IndexSourceInput {
  workspaceId: string;
  sourceType: SourceType;
  sourceId: string;
  title?: string | null;
  locale?: string | null;
  sourceUrl?: string | null;
  chunks: Chunk[];
  metadata?: Record<string, unknown>;
}

export type IndexSourceErrorCode =
  | 'chunk_read_failed'
  | 'chunk_write_failed'
  | 'chunk_delete_failed';

export interface IndexSourceResult {
  /**
   * Phase 6-S5-R5 — authoritative success flag. A false value means at least
   * one required database operation failed; the caller must NOT report a
   * completed rebuild and must NOT run destructive reconciliation.
   */
  ok: boolean;
  errorCode?: IndexSourceErrorCode;
  retryable?: boolean;
  chunksCreated: number;
  chunksUpdated: number;
  chunksSkipped: number;
  chunksDeleted: number;
  embeddingsGenerated: number;
  embeddingFailures: number;
}

/**
 * AI billing — background KB indexing is billable provider work. When the
 * caller did not open a Run (most background paths), a standalone Run is
 * opened for this source so the embedding usage is never lost.
 */
async function ensureIndexingRun(
  config: ServerConfig,
  workspaceId: string,
  sourceType: string,
  sourceId: string,
): Promise<import('../../ai-billing/runContext.js').AiRunContext | null> {
  try {
    const { beginAiRun } = await import('../../ai-billing/runContext.js');
    return await beginAiRun(config, {
      workspaceId,
      operationKey: `kb_index:${sourceType}:${sourceId}:${new Date().toISOString().slice(0, 13)}`,
      payload: { workspaceId, sourceType, sourceId },
      entryPoint: 'kb_index',
      estimate: { promptChars: 0 },
    });
  } catch (err) {
    console.warn('[ai-billing] kb index run not opened:', (err as any)?.message);
    return null;
  }
}

export async function indexSource(
  config: ServerConfig,
  input: IndexSourceInput,
  embedder?: EmbeddingProvider,
  opts?: {
    remainingEmbedBudget?: number;
    /** AI billing — Run owning this indexing job's embedding usage. */
    runCtx?: import('../../ai-billing/runContext.js').AiRunContext | null;
  },
): Promise<IndexSourceResult> {
  const sb = getServiceClient(config);
  const result: IndexSourceResult = {
    ok: true,
    chunksCreated: 0,
    chunksUpdated: 0,
    chunksSkipped: 0,
    chunksDeleted: 0,
    embeddingsGenerated: 0,
    embeddingFailures: 0,
  };

  // If chunks empty → mark all existing as deleted (source removed/unpublished).
  if (!input.chunks.length) {
    const { data: deleted, error: deleteError } = await sb
      .from('ai_knowledge_chunks')
      .update({ status: 'deleted' })
      .eq('workspace_id', input.workspaceId)
      .eq('source_type', input.sourceType)
      .eq('source_id', input.sourceId)
      .neq('status', 'deleted')
      .select('id');
    if (deleteError) {
      result.ok = false;
      result.errorCode = 'chunk_delete_failed';
      result.retryable = true;
      return result;
    }
    result.chunksDeleted = (deleted || []).length;
    return result;
  }

  // Load existing chunks for this source.
  const { data: existing, error: existingError } = await sb
    .from('ai_knowledge_chunks')
    .select('id, chunk_index, content_hash, embedding, status')
    .eq('workspace_id', input.workspaceId)
    .eq('source_type', input.sourceType)
    .eq('source_id', input.sourceId);
  if (existingError) {
    result.ok = false;
    result.errorCode = 'chunk_read_failed';
    result.retryable = true;
    return result;
  }
  const existingByIndex = new Map<number, any>();
  for (const row of existing || []) existingByIndex.set(row.chunk_index, row);

  // Decide which chunks need (re)embedding.
  const toEmbed: { i: number; content: string; hash: string }[] = [];
  const upserts: Array<Record<string, unknown>> = [];
  for (const c of input.chunks) {
    const hash = chunkHash({
      source_type: input.sourceType,
      source_id: input.sourceId,
      chunk_index: c.index,
      content: c.content,
    });
    const prev = existingByIndex.get(c.index);
    const needsRow = !prev || prev.content_hash !== hash || prev.status !== 'active';
    const needsEmbed = !prev || prev.content_hash !== hash || !prev.embedding;
    if (!needsRow) {
      result.chunksSkipped += 1;
      continue;
    }
    upserts.push({
      workspace_id: input.workspaceId,
      source_type: input.sourceType,
      source_id: input.sourceId,
      source_url: input.sourceUrl ?? null,
      title: input.title ?? null,
      content: c.content,
      locale: input.locale ?? null,
      chunk_index: c.index,
      content_hash: hash,
      status: 'active',
      metadata: input.metadata ?? {},
    });
    if (needsEmbed) toEmbed.push({ i: c.index, content: c.content, hash });
  }

  // Embed in batch. Phase 6-S5-R7 — STRICT validation: a provider may return
  // a short/long vector, a non-array, or NaN/Infinity entries. Writing such a
  // value produces a silently unusable index row, so anything that is not a
  // finite vector of the provider's exact dimensionality is counted as an
  // embedding FAILURE and never persisted.
  let vectors: Map<number, number[]> = new Map();
  if (toEmbed.length && embedder && isUsableEmbeddingProvider(embedder)) {
    const budget = opts?.remainingEmbedBudget ?? toEmbed.length;
    const slice = toEmbed.slice(0, Math.max(0, budget));
    if (slice.length) {
      const ownCtx = opts?.runCtx
        ? null
        : await ensureIndexingRun(config, input.workspaceId, input.sourceType, input.sourceId);
      const embedCtx = opts?.runCtx ?? ownCtx;
      try {
        const out = await embedder.embedTexts(slice.map((t) => t.content), { runCtx: embedCtx });
        const expected = embedder.dimensions;
        slice.forEach((t, idx) => {
          const v = Array.isArray(out) ? out[idx] : undefined;
          if (isValidEmbedding(v, expected)) vectors.set(t.i, v as number[]);
        });
        result.embeddingsGenerated = vectors.size;
        result.embeddingFailures += slice.length - vectors.size;
        if (vectors.size < slice.length) {
          console.warn(
            '[knowledgeIndex.indexer] rejected invalid embeddings',
            JSON.stringify({ expected, requested: slice.length, accepted: vectors.size }),
          );
        }
      } catch (err: any) {
        console.warn('[knowledgeIndex.indexer] embedding batch failed:', err?.message);
        result.embeddingFailures += slice.length;
      } finally {
        // Settle only the Run we opened ourselves; a caller-owned Run is
        // settled at its own business-operation boundary.
        if (ownCtx) {
          try {
            const billing = await import('../../ai-billing/runContext.js');
            if (ownCtx.stepSeq > 0) await billing.settleAiRun(config, ownCtx);
            else await billing.failAiRun(config, ownCtx, 'no_billable_usage');
          } catch (e: any) {
            console.warn('[ai-billing] kb index run not closed:', e?.message);
          }
        }
      }
    }
  }

  // Apply embedding/provider info to each upsert row.
  for (const row of upserts) {
    const v = vectors.get(row.chunk_index as number);
    if (v) {
      (row as any).embedding = vectorToSql(v);
      (row as any).embedding_provider = embedder?.name ?? null;
      (row as any).embedding_model = embedder?.model ?? null;
    }
  }

  // Upsert (workspace_id, source_type, source_id, chunk_index) is unique.
  if (upserts.length) {
    const { data: inserted, error } = await sb
      .from('ai_knowledge_chunks')
      .upsert(upserts, { onConflict: 'workspace_id,source_type,source_id,chunk_index' })
      .select('id, chunk_index');
    if (error) {
      console.warn('[knowledgeIndex.indexer] upsert failed:', error.message);
      result.ok = false;
      result.errorCode = 'chunk_write_failed';
      result.retryable = true;
      return result;
    } else {
      // We can't perfectly distinguish create vs update from upsert; use
      // existing-set membership as proxy.
      for (const row of inserted || []) {
        if (existingByIndex.has(row.chunk_index)) result.chunksUpdated += 1;
        else result.chunksCreated += 1;
      }
    }
  }

  // Mark chunks that no longer exist as deleted.
  const newIndices = new Set(input.chunks.map((c) => c.index));
  const orphan = (existing || []).filter((r) => !newIndices.has(r.chunk_index) && r.status !== 'deleted');
  if (orphan.length) {
    const { error } = await sb
      .from('ai_knowledge_chunks')
      .update({ status: 'deleted' })
      .in('id', orphan.map((r) => r.id));
    if (error) {
      result.ok = false;
      result.errorCode = 'chunk_delete_failed';
      result.retryable = true;
      return result;
    }
    result.chunksDeleted = orphan.length;
  }

  return result;
}

/**
 * Phase 6-S5-R7 — an embedding is only usable when it is a real numeric
 * vector of the provider's exact dimensionality with no NaN/Infinity entries.
 * Anything else must be rejected BEFORE it reaches the database, otherwise
 * the row looks embedded while retrieval silently degrades.
 */
export function isValidEmbedding(v: unknown, expectedDimensions: number): v is number[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  if (expectedDimensions > 0 && v.length !== expectedDimensions) return false;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  return true;
}

/** pgvector accepts vector-as-text in the form "[0.1,0.2,...]". */
function vectorToSql(v: number[]): string {
  return `[${v.map((n) => Number.isFinite(n) ? n.toString() : '0').join(',')}]`;
}

export { vectorToSql };

export async function getEmbedderForWorkspace(
  config: ServerConfig,
  workspaceId: string,
): Promise<EmbeddingProvider> {
  return resolveEmbeddingProvider(config, workspaceId);
}