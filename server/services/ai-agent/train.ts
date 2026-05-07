/**
 * AI Agent — Train / Data Hub aggregator (Pass E1).
 *
 * Read-only, workspace-scoped aggregation across all trainable knowledge
 * surfaces. Powers GET /api/ai-agent/train/overview.
 *
 * Sources unified here:
 *   - ai_data_sources         (website, file, snippet, business_profile rows)
 *   - knowledge_base_articles (published vs draft)
 *   - ai_agent_qna            (enabled vs disabled)
 *   - ai_agent_learning_candidates (pending / approved / rejected / converted)
 *   - ai_knowledge_chunks     (the actual retrieval index)
 *   - ai_source_sync_logs     (recent sync history)
 *
 * SAFETY: this module never crawls anything, never executes a tool, never
 * writes outside its own diagnostic surface. Pure aggregation.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getKnowledgeIndexStatus, type KnowledgeIndexStatus } from './knowledgeIndex/sync.js';

export interface TrainWarning {
  code: string;
  severity: 'info' | 'warn' | 'error';
  message: string;
  source_type?: string;
  source_id?: string;
}

export interface TrainSourceTypeBreakdown {
  source_type: string;
  total: number;
  active: number;
  paused: number;
  failed: number;
  syncing: number;
  last_synced_at: string | null;
}

export interface TrainOverviewResponse {
  counts: {
    totalSources: number;
    activeSources: number;
    pausedSources: number;
    failedSources: number;
    syncingSources: number;
    qnaEnabled: number;
    qnaDisabled: number;
    kbPublished: number;
    kbDraft: number;
    learningPending: number;
    learningApproved: number;
    learningRejected: number;
    learningConvertedQna: number;
    learningConvertedKb: number;
    activeChunks: number;
    embeddedChunks: number;
    failedEmbeddings: number;
    deletedChunks: number;
  };
  sourcesByType: TrainSourceTypeBreakdown[];
  knowledgeIndex: KnowledgeIndexStatus | null;
  recentSyncLogs: Array<Record<string, unknown>>;
  recentJobs: Array<Record<string, unknown>>;
  warnings: TrainWarning[];
  lastSyncAt: string | null;
  lastRebuildAt: string | null;
  /**
   * Retrieval safety contract — what the runtime is allowed to read.
   * Surfaced in the UI so operators know exactly what gets used.
   */
  retrievalContract: {
    allowed: string[];
    blocked: string[];
  };
}

const RETRIEVAL_ALLOWED = [
  'qna (enabled)',
  'kb_article (published)',
  'business_profile (active)',
  'website / web_page chunk (status=active, embedding present)',
  'file chunk (status=active, embedding present)',
  'learned_qna chunk (status=active, candidate approved)',
];
const RETRIEVAL_BLOCKED = [
  'kb_article (draft / unpublished)',
  'qna (disabled)',
  'learning candidate (pending / rejected)',
  'data_source (paused / failed / deleted)',
  'chunk (status != active)',
  'cross-workspace data',
  'spam conversation content',
];

export async function buildTrainOverview(
  config: ServerConfig,
  workspaceId: string,
): Promise<TrainOverviewResponse> {
  const sb = getServiceClient(config);

  const [
    sourceRows,
    qnaRows,
    kbRows,
    learningStats,
    chunkAgg,
    syncLogs,
    recentJobs,
    knowledgeIndex,
  ] = await Promise.all([
    sb.from('ai_data_sources')
      .select('id, source_type, status, last_synced_at, last_error, name')
      .eq('workspace_id', workspaceId)
      .neq('status', 'deleted'),
    sb.from('ai_agent_qna').select('id, enabled').eq('workspace_id', workspaceId),
    sb.from('knowledge_base_articles').select('id, status').eq('workspace_id', workspaceId),
    sb.from('ai_agent_learning_candidates').select('status').eq('workspace_id', workspaceId),
    sb.from('ai_knowledge_chunks')
      .select('source_type, status, embedding')
      .eq('workspace_id', workspaceId)
      .limit(20000),
    sb.from('ai_source_sync_logs')
      .select('id, source_id, status, message, pages_found, chunks_created, embedded_chunks, errors, created_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(20),
    sb.from('ai_kb_jobs')
      .select('id, status, source_kind, source_domain, pages_discovered, pages_crawled, pages_failed, articles_generated, error_message, created_at, completed_at')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false })
      .limit(10),
    getKnowledgeIndexStatus(config, workspaceId).catch(() => null),
  ]);

  // ── Source breakdown ──
  const sources = sourceRows.data || [];
  const byType = new Map<string, TrainSourceTypeBreakdown>();
  let lastSync: string | null = null;
  for (const s of sources) {
    const key = (s.source_type as string) || 'unknown';
    const cur =
      byType.get(key) ||
      ({ source_type: key, total: 0, active: 0, paused: 0, failed: 0, syncing: 0, last_synced_at: null } as TrainSourceTypeBreakdown);
    cur.total += 1;
    const st = (s.status as string) || '';
    if (st === 'active') cur.active += 1;
    else if (st === 'paused') cur.paused += 1;
    else if (st === 'failed') cur.failed += 1;
    else if (st === 'syncing') cur.syncing += 1;
    if (s.last_synced_at && (!cur.last_synced_at || s.last_synced_at > cur.last_synced_at)) {
      cur.last_synced_at = s.last_synced_at as string;
    }
    if (s.last_synced_at && (!lastSync || s.last_synced_at > lastSync)) lastSync = s.last_synced_at as string;
    byType.set(key, cur);
  }

  // Q&A is a first-class source even though it isn't in ai_data_sources.
  const qna = qnaRows.data || [];
  const qnaEnabled = qna.filter((q: any) => q.enabled).length;
  const qnaDisabled = qna.length - qnaEnabled;
  if (qna.length > 0) {
    byType.set('qna', {
      source_type: 'qna',
      total: qna.length,
      active: qnaEnabled,
      paused: qnaDisabled,
      failed: 0,
      syncing: 0,
      last_synced_at: null,
    });
  }
  const kb = kbRows.data || [];
  const kbPublished = kb.filter((a: any) => a.status === 'published').length;
  const kbDraft = kb.filter((a: any) => a.status === 'draft').length;
  if (kb.length > 0) {
    byType.set('kb_article', {
      source_type: 'kb_article',
      total: kb.length,
      active: kbPublished,
      paused: kbDraft,
      failed: 0,
      syncing: 0,
      last_synced_at: null,
    });
  }

  // Learning candidate breakdown
  const learning = learningStats.data || [];
  const lc = { pending: 0, approved: 0, rejected: 0, converted_to_qna: 0, converted_to_kb: 0 };
  for (const r of learning) {
    const k = (r as any).status as keyof typeof lc;
    if (k in lc) lc[k] += 1;
  }

  // Chunk aggregation
  const chunks = chunkAgg.data || [];
  let activeChunks = 0;
  let embeddedChunks = 0;
  let deletedChunks = 0;
  let failedEmbeddings = 0;
  for (const c of chunks) {
    const st = (c as any).status as string;
    if (st === 'active') activeChunks += 1;
    if (st === 'deleted') deletedChunks += 1;
    if ((c as any).embedding) embeddedChunks += 1;
    else if (st === 'active') failedEmbeddings += 1;
  }

  // Warnings
  const warnings: TrainWarning[] = [];
  const totalActiveSources =
    Array.from(byType.values()).reduce((s, t) => s + t.active, 0);
  if (totalActiveSources === 0) {
    warnings.push({
      code: 'no_knowledge_sources',
      severity: 'warn',
      message: 'No active knowledge sources yet. Add Q&A, web pages, files, or publish KB articles.',
    });
  }
  if (activeChunks > 0 && embeddedChunks === 0) {
    warnings.push({
      code: 'no_embedded_chunks',
      severity: 'warn',
      message: 'Knowledge chunks exist but none are embedded. Rebuild the knowledge index.',
    });
  }
  if (failedEmbeddings > 0) {
    warnings.push({
      code: 'failed_embeddings',
      severity: 'warn',
      message: `${failedEmbeddings} active chunk(s) are missing embeddings.`,
    });
  }
  if (lc.pending > 0) {
    warnings.push({
      code: 'learning_candidates_pending',
      severity: 'info',
      message: `${lc.pending} learning candidate(s) awaiting review.`,
    });
  }
  if (qna.length === 0) {
    warnings.push({
      code: 'no_qna',
      severity: 'info',
      message: 'No Q&A pairs yet — Q&A is the highest-priority retrieval source.',
    });
  }
  // Per-source warnings
  for (const s of sources) {
    if (s.source_type === 'website' && !s.last_synced_at) {
      warnings.push({
        code: 'website_not_synced',
        severity: 'warn',
        message: `Website source "${s.name}" has not been synced yet.`,
        source_type: 'website',
        source_id: s.id as string,
      });
    }
    if (s.status === 'failed') {
      warnings.push({
        code: 'source_failed',
        severity: 'error',
        message: `Source "${s.name}" sync failed${s.last_error ? `: ${s.last_error}` : ''}.`,
        source_type: s.source_type as string,
        source_id: s.id as string,
      });
    }
  }
  if (kbDraft > 0 && kbPublished === 0) {
    warnings.push({
      code: 'only_draft_kb',
      severity: 'info',
      message: `${kbDraft} KB draft(s) exist but none are published — drafts are not used by the AI.`,
    });
  }

  // Last rebuild — use most recent updated_at from chunks (best-effort).
  const lastRebuildAt = knowledgeIndex?.lastUpdated || null;

  return {
    counts: {
      totalSources: sources.length,
      activeSources: sources.filter((s: any) => s.status === 'active').length,
      pausedSources: sources.filter((s: any) => s.status === 'paused').length,
      failedSources: sources.filter((s: any) => s.status === 'failed').length,
      syncingSources: sources.filter((s: any) => s.status === 'syncing').length,
      qnaEnabled,
      qnaDisabled,
      kbPublished,
      kbDraft,
      learningPending: lc.pending,
      learningApproved: lc.approved,
      learningRejected: lc.rejected,
      learningConvertedQna: lc.converted_to_qna,
      learningConvertedKb: lc.converted_to_kb,
      activeChunks,
      embeddedChunks,
      failedEmbeddings,
      deletedChunks,
    },
    sourcesByType: Array.from(byType.values()).sort((a, b) => a.source_type.localeCompare(b.source_type)),
    knowledgeIndex,
    recentSyncLogs: (syncLogs.data as any[]) || [],
    recentJobs: (recentJobs.data as any[]) || [],
    warnings,
    lastSyncAt: lastSync,
    lastRebuildAt,
    retrievalContract: {
      allowed: RETRIEVAL_ALLOWED,
      blocked: RETRIEVAL_BLOCKED,
    },
  };
}

/**
 * Debug — paginated chunk inspector for the Knowledge Index UI.
 * Read-only.  Bounded by `limit` (max 200).
 */
export interface ChunkDebugRow {
  id: string;
  source_type: string;
  source_id: string;
  title: string | null;
  source_url: string | null;
  locale: string | null;
  status: string;
  has_embedding: boolean;
  content_preview: string;
  updated_at: string;
}

export async function listChunks(
  config: ServerConfig,
  workspaceId: string,
  opts: { sourceType?: string | null; status?: string | null; query?: string | null; limit?: number },
): Promise<{ items: ChunkDebugRow[]; total: number }> {
  const sb = getServiceClient(config);
  const limit = Math.min(Math.max(opts.limit || 50, 1), 200);

  let q = sb
    .from('ai_knowledge_chunks')
    .select('id, source_type, source_id, title, source_url, locale, status, embedding, content, updated_at', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (opts.sourceType) q = q.eq('source_type', opts.sourceType);
  if (opts.status) q = q.eq('status', opts.status);
  if (opts.query) q = q.ilike('content', `%${opts.query.replace(/%/g, '')}%`);

  const { data, count } = await q;
  const items: ChunkDebugRow[] = (data || []).map((r: any) => ({
    id: r.id,
    source_type: r.source_type,
    source_id: r.source_id,
    title: r.title,
    source_url: r.source_url,
    locale: r.locale,
    status: r.status,
    has_embedding: !!r.embedding,
    content_preview: ((r.content as string) || '').slice(0, 240),
    updated_at: r.updated_at,
  }));
  return { items, total: count || items.length };
}

/**
 * Single-source rebuild — workspace-scoped, owner/admin gated at the route.
 * Returns the indexer summary or a "not_supported" marker for source types
 * not yet wired into syncKnowledgeSource.
 */
export async function rebuildSingleSource(
  config: ServerConfig,
  workspaceId: string,
  sourceType: string,
  sourceId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const { syncKnowledgeSource } = await import('./knowledgeIndex/sync.js');
  if (!['kb_article', 'qna', 'business_profile'].includes(sourceType)) {
    return { ok: false, reason: 'source_type_not_yet_supported_for_per_source_rebuild' };
  }
  await syncKnowledgeSource(config, { workspaceId, sourceType: sourceType as any, sourceId });
  return { ok: true };
}