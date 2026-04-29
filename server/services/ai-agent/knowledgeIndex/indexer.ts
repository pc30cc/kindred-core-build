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

export interface IndexSourceResult {
  chunksCreated: number;
  chunksUpdated: number;
  chunksSkipped: number;
  chunksDeleted: number;
  embeddingsGenerated: number;
  embeddingFailures: number;
}

export async function indexSource(
  config: ServerConfig,
  input: IndexSourceInput,
  embedder?: EmbeddingProvider,
  opts?: { remainingEmbedBudget?: number },
): Promise<IndexSourceResult> {
  const sb = getServiceClient(config);
  const result: IndexSourceResult = {
    chunksCreated: 0,
    chunksUpdated: 0,
    chunksSkipped: 0,
    chunksDeleted: 0,
    embeddingsGenerated: 0,
    embeddingFailures: 0,
  };

  // If chunks empty → mark all existing as deleted (source removed/unpublished).
  if (!input.chunks.length) {
    const { count } = await sb
      .from('ai_knowledge_chunks')
      .update({ status: 'deleted' })
      .eq('workspace_id', input.workspaceId)
      .eq('source_type', input.sourceType)
      .eq('source_id', input.sourceId)
      .neq('status', 'deleted')
      .select('id', { count: 'exact', head: true });
    result.chunksDeleted = count || 0;
    return result;
  }

  // Load existing chunks for this source.
  const { data: existing } = await sb
    .from('ai_knowledge_chunks')
    .select('id, chunk_index, content_hash, embedding, status')
    .eq('workspace_id', input.workspaceId)
    .eq('source_type', input.sourceType)
    .eq('source_id', input.sourceId);
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

  // Embed in batch (best-effort).
  let vectors: Map<number, number[]> = new Map();
  if (toEmbed.length && embedder && isUsableEmbeddingProvider(embedder)) {
    const budget = opts?.remainingEmbedBudget ?? toEmbed.length;
    const slice = toEmbed.slice(0, Math.max(0, budget));
    if (slice.length) {
      try {
        const out = await embedder.embedTexts(slice.map((t) => t.content));
        slice.forEach((t, idx) => {
          const v = out[idx];
          if (v && v.length) vectors.set(t.i, v);
        });
        result.embeddingsGenerated = vectors.size;
        result.embeddingFailures += slice.length - vectors.size;
      } catch (err: any) {
        console.warn('[knowledgeIndex.indexer] embedding batch failed:', err?.message);
        result.embeddingFailures += slice.length;
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
    if (!error) result.chunksDeleted = orphan.length;
  }

  return result;
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