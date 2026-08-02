/**
 * Knowledge sync — orchestrates indexing of all workspace sources.
 *
 * Used by:
 *   - syncKnowledgeSource(): per-source hooks (publish, q&a save).
 *   - rebuildWorkspaceIndex(): admin/backfill endpoint.
 *
 * Cost control: per-rebuild embedding budget capped by plan tier (sane
 * defaults if no plan limits are configured).
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { chunkText, chunkQna } from './chunker.js';
import { indexSource, getEmbedderForWorkspace, type SourceType } from './indexer.js';
import { isUsableEmbeddingProvider, type EmbeddingProvider } from '../embeddings/index.js';
import { getOrCreateSettings } from '../settings.js';

const PLAN_BUDGETS: Record<string, number> = {
  free: 50,
  starter: 200,
  pro: 500,
  business: 2000,
  enterprise: 10000,
};
const DEFAULT_BUDGET = 200;

async function resolveEmbeddingBudget(config: ServerConfig, workspaceId: string): Promise<number> {
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('workspace_subscriptions')
      .select('billing_plans(slug, limits)')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    const plan: any = (data as any)?.billing_plans;
    const limit = plan?.limits?.ai_knowledge_chunks_embedded;
    if (typeof limit === 'number' && limit > 0) return limit;
    const slug = (plan?.slug || '').toLowerCase();
    if (slug && PLAN_BUDGETS[slug]) return PLAN_BUDGETS[slug];
    return DEFAULT_BUDGET;
  } catch {
    return DEFAULT_BUDGET;
  }
}

export interface SyncSourceInput {
  workspaceId: string;
  sourceType: SourceType;
  sourceId: string;
}

/**
 * Best-effort: never throws to the caller. Indexing failures must not block
 * publish / Q&A save.
 */
export async function syncKnowledgeSource(
  config: ServerConfig,
  input: SyncSourceInput,
): Promise<void> {
  try {
    const sb = getServiceClient(config);
    const embedder = await getEmbedderForWorkspace(config, input.workspaceId);

    if (input.sourceType === 'kb_article') {
      const { data: art } = await sb
        .from('knowledge_base_articles')
        .select('id, workspace_id, slug, locale, title, content, status, used_by_ai')
        .eq('id', input.sourceId)
        .maybeSingle();
      if (!art || art.workspace_id !== input.workspaceId) return;
      if (art.status !== 'published' || (art as any).used_by_ai === false) {
        // Unpublished → mark all chunks deleted.
        await indexSource(config, {
          workspaceId: input.workspaceId,
          sourceType: 'kb_article',
          sourceId: input.sourceId,
          chunks: [],
        }, embedder);
        return;
      }
      const chunks = chunkText([art.title, art.content].filter(Boolean).join('\n\n'));
      await indexSource(config, {
        workspaceId: input.workspaceId,
        sourceType: 'kb_article',
        sourceId: input.sourceId,
        title: art.title,
        locale: art.locale,
        sourceUrl: art.slug ? `/help/${art.slug}` : null,
        chunks,
      }, embedder);
      return;
    }

    if (input.sourceType === 'qna') {
      const { data: q } = await sb
        .from('ai_agent_qna')
        .select('id, workspace_id, question, answer, locale, enabled')
        .eq('id', input.sourceId)
        .maybeSingle();
      if (!q || q.workspace_id !== input.workspaceId) return;
      if (!q.enabled) {
        await indexSource(config, {
          workspaceId: input.workspaceId,
          sourceType: 'qna',
          sourceId: input.sourceId,
          chunks: [],
        }, embedder);
        return;
      }
      const chunks = chunkQna(q.question, q.answer);
      await indexSource(config, {
        workspaceId: input.workspaceId,
        sourceType: 'qna',
        sourceId: input.sourceId,
        title: q.question,
        locale: q.locale,
        chunks,
      }, embedder);
      return;
    }

    if (input.sourceType === 'business_profile') {
      const settings = await getOrCreateSettings(config, input.workspaceId);
      const text = [settings.business_description, settings.instructions?.custom_instructions].filter(Boolean).join('\n\n');
      const chunks = text ? chunkText(text) : [];
      await indexSource(config, {
        workspaceId: input.workspaceId,
        sourceType: 'business_profile',
        sourceId: input.workspaceId,
        title: 'Business profile',
        chunks,
      }, embedder);
      return;
    }
  } catch (err: any) {
    console.warn('[ai-agent.knowledgeIndex.sync] syncKnowledgeSource failed:', err?.message);
  }
}

export interface RebuildSummary {
  ok: boolean;
  /**
   * Authoritative outcome for the outbox worker. `ok === false` NEVER means
   * "nothing to do" — the caller must defer or fail the event accordingly.
   */
  terminalState: 'completed' | 'deferred_provider_unavailable' | 'failed';
  chunksCreated: number;
  chunksUpdated: number;
  chunksSkipped: number;
  chunksDeleted: number;
  /** kb_article chunks removed because their article is no longer eligible. */
  staleSourcesReconciled: number;
  /**
   * True when the destructive reconciliation sweep was skipped because a
   * prerequisite query failed. Deleting on unverified data is never allowed.
   */
  reconciliationSkipped?: boolean;
  embeddingsGenerated: number;
  embeddingFailures: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBudget: number;
  embeddingBudgetUsed: number;
  sourcesProcessed: number;
}

export async function rebuildWorkspaceIndex(
  config: ServerConfig,
  workspaceId: string,
): Promise<RebuildSummary> {
  const sb = getServiceClient(config);
  const embedder: EmbeddingProvider = await getEmbedderForWorkspace(config, workspaceId);
  const budget = await resolveEmbeddingBudget(config, workspaceId);
  let remainingBudget = isUsableEmbeddingProvider(embedder) ? budget : 0;

  const summary: RebuildSummary = {
    ok: true,
    terminalState: 'completed',
    chunksCreated: 0,
    chunksUpdated: 0,
    chunksSkipped: 0,
    chunksDeleted: 0,
    staleSourcesReconciled: 0,
    embeddingsGenerated: 0,
    embeddingFailures: 0,
    embeddingProvider: embedder.name,
    embeddingModel: embedder.model,
    embeddingBudget: budget,
    embeddingBudgetUsed: 0,
    sourcesProcessed: 0,
  };

  // 1) Published KB articles
  //
  // Phase 6-S5-R4 — the eligible-article set is the ONLY input the
  // reconciliation sweep uses to decide what to retire. If this query fails we
  // must NOT treat "no rows" as "nothing is eligible", otherwise a transient
  // database error would wipe the entire KB index. The failure is recorded and
  // the sweep is skipped.
  const { data: articles, error: articlesError } = await sb
    .from('knowledge_base_articles')
    .select('id, slug, locale, title, content, status')
    .eq('workspace_id', workspaceId)
    .eq('status', 'published')
    .eq('used_by_ai', true)
    .limit(2000);
  const articleSetTrustworthy = !articlesError;
  const eligibleArticleIds = new Set<string>((articles || []).map((a) => a.id as string));
  for (const a of articles || []) {
    const chunks = chunkText([a.title, a.content].filter(Boolean).join('\n\n'));
    const r = await indexSource(config, {
      workspaceId,
      sourceType: 'kb_article',
      sourceId: a.id as string,
      title: a.title as string,
      locale: (a.locale as string) || null,
      sourceUrl: a.slug ? `/help/${a.slug}` : null,
      chunks,
    }, embedder, { remainingEmbedBudget: remainingBudget });
    summary.chunksCreated += r.chunksCreated;
    summary.chunksUpdated += r.chunksUpdated;
    summary.chunksSkipped += r.chunksSkipped;
    summary.chunksDeleted += r.chunksDeleted;
    summary.embeddingsGenerated += r.embeddingsGenerated;
    summary.embeddingFailures += r.embeddingFailures;
    remainingBudget = Math.max(0, remainingBudget - r.embeddingsGenerated - r.embeddingFailures);
    summary.sourcesProcessed += 1;
  }

  // 2) Enabled Q&A
  const { data: qnas } = await sb
    .from('ai_agent_qna')
    .select('id, question, answer, locale, enabled')
    .eq('workspace_id', workspaceId)
    .eq('enabled', true)
    .limit(5000);
  for (const q of qnas || []) {
    const chunks = chunkQna(q.question as string, q.answer as string);
    const r = await indexSource(config, {
      workspaceId,
      sourceType: 'qna',
      sourceId: q.id as string,
      title: q.question as string,
      locale: (q.locale as string) || null,
      chunks,
    }, embedder, { remainingEmbedBudget: remainingBudget });
    summary.chunksCreated += r.chunksCreated;
    summary.chunksUpdated += r.chunksUpdated;
    summary.chunksSkipped += r.chunksSkipped;
    summary.chunksDeleted += r.chunksDeleted;
    summary.embeddingsGenerated += r.embeddingsGenerated;
    summary.embeddingFailures += r.embeddingFailures;
    remainingBudget = Math.max(0, remainingBudget - r.embeddingsGenerated - r.embeddingFailures);
    summary.sourcesProcessed += 1;
  }

  // 3) Business profile
  const settings = await getOrCreateSettings(config, workspaceId);
  const profileText = [
    settings.business_description,
    settings.instructions?.custom_instructions,
  ].filter(Boolean).join('\n\n');
  if (profileText) {
    const chunks = chunkText(profileText);
    const r = await indexSource(config, {
      workspaceId,
      sourceType: 'business_profile',
      sourceId: workspaceId,
      title: 'Business profile',
      chunks,
    }, embedder, { remainingEmbedBudget: remainingBudget });
    summary.chunksCreated += r.chunksCreated;
    summary.chunksUpdated += r.chunksUpdated;
    summary.chunksSkipped += r.chunksSkipped;
    summary.chunksDeleted += r.chunksDeleted;
    summary.embeddingsGenerated += r.embeddingsGenerated;
    summary.embeddingFailures += r.embeddingFailures;
    remainingBudget = Math.max(0, remainingBudget - r.embeddingsGenerated);
    summary.sourcesProcessed += 1;
  }

  // 4) Reconciliation sweep — Phase 6-S5-R3.
  //
  // Indexing above only ADDS/UPDATES. Articles that were deleted, unpublished,
  // archived or flagged used_by_ai=false leave stale chunks behind, so every
  // kb_article chunk whose source_id is not in the eligible set is retired.
  // Scoped to source_type='kb_article' — Q&A and business-profile chunks are
  // never touched here.
  //
  // The sweep is DESTRUCTIVE, so it runs only when every prerequisite query
  // succeeded. On any query error it is skipped entirely and the rebuild is
  // reported as non-terminal so the outbox event is retried, never completed.
  let reconciliationFailed = !articleSetTrustworthy;
  if (articleSetTrustworthy) {
    const { data: kbChunks, error: chunksError } = await sb
      .from('ai_knowledge_chunks')
      .select('source_id')
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'kb_article')
      .neq('status', 'deleted')
      .limit(20000);
    if (chunksError) {
      reconciliationFailed = true;
    } else {
      const staleSourceIds = Array.from(
        new Set(
          (kbChunks || [])
            .map((c) => c.source_id as string)
            .filter((id) => id && !eligibleArticleIds.has(id)),
        ),
      );
      if (staleSourceIds.length > 0) {
        const { data: retired, error: retireError } = await sb
          .from('ai_knowledge_chunks')
          .update({ status: 'deleted', updated_at: new Date().toISOString() })
          .eq('workspace_id', workspaceId)
          .eq('source_type', 'kb_article')
          .neq('status', 'deleted')
          .in('source_id', staleSourceIds)
          .select('id');
        if (retireError) {
          reconciliationFailed = true;
        } else {
          summary.staleSourcesReconciled = staleSourceIds.length;
          summary.chunksDeleted += (retired || []).length;
        }
      }
    }
  }
  if (reconciliationFailed) {
    summary.ok = false;
    summary.terminalState = 'failed';
    summary.reconciliationSkipped = true;
  }

  summary.embeddingBudgetUsed = budget - remainingBudget;

  // Provider truthfulness: a configured embedding provider that failed every
  // attempt is an outage, not a success. Deployments with NO usable provider
  // run a documented keyword-only index and complete normally.
  if (
    isUsableEmbeddingProvider(embedder) &&
    summary.embeddingFailures > 0 &&
    summary.embeddingsGenerated === 0
  ) {
    summary.ok = false;
    summary.terminalState = 'deferred_provider_unavailable';
  }

  return summary;
}

export interface KnowledgeIndexStatus {
  activeChunks: number;
  embeddedChunks: number;
  staleChunks: number;
  deletedChunks: number;
  bySourceType: Record<string, number>;
  byLocale: Record<string, number>;
  lastUpdated: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingProviderAvailable: boolean;
}

export async function getKnowledgeIndexStatus(
  config: ServerConfig,
  workspaceId: string,
): Promise<KnowledgeIndexStatus> {
  const sb = getServiceClient(config);
  const status: KnowledgeIndexStatus = {
    activeChunks: 0,
    embeddedChunks: 0,
    staleChunks: 0,
    deletedChunks: 0,
    bySourceType: {},
    byLocale: {},
    lastUpdated: null,
    embeddingProvider: null,
    embeddingModel: null,
    embeddingProviderAvailable: false,
  };

  const { data: rows } = await sb
    .from('ai_knowledge_chunks')
    .select('status, source_type, locale, embedding, embedding_provider, embedding_model, updated_at')
    .eq('workspace_id', workspaceId)
    .limit(10000);
  let last: string | null = null;
  for (const r of rows || []) {
    if (r.status === 'active') status.activeChunks += 1;
    else if (r.status === 'stale') status.staleChunks += 1;
    else if (r.status === 'deleted') status.deletedChunks += 1;
    if (r.embedding) status.embeddedChunks += 1;
    if (r.status !== 'deleted') {
      status.bySourceType[r.source_type] = (status.bySourceType[r.source_type] || 0) + 1;
      const loc = r.locale || 'unknown';
      status.byLocale[loc] = (status.byLocale[loc] || 0) + 1;
    }
    if (r.embedding_provider && !status.embeddingProvider) {
      status.embeddingProvider = r.embedding_provider;
      status.embeddingModel = r.embedding_model || null;
    }
    if (!last || (r.updated_at && r.updated_at > last)) last = r.updated_at as string;
  }
  status.lastUpdated = last;

  try {
    const embedder = await getEmbedderForWorkspace(config, workspaceId);
    status.embeddingProviderAvailable = isUsableEmbeddingProvider(embedder);
    if (!status.embeddingProvider) {
      status.embeddingProvider = embedder.name;
      status.embeddingModel = embedder.model;
    }
  } catch { /* best-effort */ }

  return status;
}