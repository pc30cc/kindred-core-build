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
import { getWorkspacePlanInfo } from '../../../middleware/featureGating.js';
import { chunkText, chunkQna } from './chunker.js';
import { indexSource, getEmbedderForWorkspace, type SourceType } from './indexer.js';
import { isUsableEmbeddingProvider, type EmbeddingProvider } from '../embeddings/index.js';
import { getOrCreateSettings } from '../settings.js';
import { isKbArticleLocked, resolveKbLock } from '../../knowledge-base/locks.js';
import { readRows } from '../../../lib/pagedRows.js';

const PLAN_BUDGETS: Record<string, number> = {
  free: 50,
  starter: 200,
  pro: 500,
  business: 2000,
  enterprise: 10000,
};
const DEFAULT_BUDGET = 200;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `ai_knowledge_chunks_embedded` is not a registry capability, so it keeps its
 * per-plan fallback; the plan it is read from is the plan in force, chosen by
 * the one rule every plan reader uses (getWorkspacePlanInfo →
 * planSelection.ts), with the workspace's limit override applied.
 */
async function resolveEmbeddingBudget(config: ServerConfig, workspaceId: string): Promise<number> {
  try {
    const info = await getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId);
    const limit = info.limits.ai_knowledge_chunks_embedded;
    if (typeof limit === 'number' && limit > 0) return limit;
    const slug = info.plan.slug.toLowerCase();
    if (PLAN_BUDGETS[slug]) return PLAN_BUDGETS[slug];
    return DEFAULT_BUDGET;
  } catch (error) {
    console.error('[KnowledgeSync] plan budget resolution failed', error);
    return DEFAULT_BUDGET;
  }
}


/** Source ids per retiring update (keeps each statement's IN list short). */
const RETIRE_BATCH = 500;
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
        .select('id, workspace_id, slug, locale, title, content, status, used_by_ai, created_at')
        .eq('id', input.sourceId)
        .maybeSingle();
      if (!art || art.workspace_id !== input.workspaceId) return;
      // Simple billing phase 4: an article over the plan's max_kb_articles is
      // locked and invisible to the AI, so its chunks are retired like an
      // unpublished one's; the catch-up after an upgrade re-adds them.
      const locked = isKbArticleLocked(await resolveKbLock(config, input.workspaceId), art);
      if (art.status !== 'published' || art.used_by_ai === false || locked) {
        // Unpublished (or locked) → mark all chunks deleted.
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
  } catch (err) {
    console.warn('[ai-agent.knowledgeIndex.sync] syncKnowledgeSource failed:', errorMessage(err));
  }
}

export type RebuildErrorCode =
  | 'kb_article_query_failed'
  | 'qna_query_failed'
  | 'business_profile_query_failed'
  | 'chunk_query_failed'
  | 'chunk_write_failed'
  | 'chunk_delete_failed'
  | 'chunk_reconciliation_failed'
  | 'reconciliation_skipped_untrusted'
  | 'embedding_provider_unavailable'
  | 'embedding_failed';

export interface RebuildSummary {
  ok: boolean;
  /**
   * Authoritative outcome for the outbox worker. `ok === false` NEVER means
   * "nothing to do" — the caller must defer or fail the event accordingly.
   */
  terminalState: 'completed' | 'deferred_provider_unavailable' | 'failed';
  /** Sanitized failure classification. Never contains raw database text. */
  errorCode?: RebuildErrorCode;
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

  /** First hard failure wins; later failures never downgrade the code. */
  const fail = (code: RebuildErrorCode): void => {
    summary.ok = false;
    summary.terminalState = 'failed';
    if (!summary.errorCode) summary.errorCode = code;
  };
  /** Set when ANY required write failed — blocks destructive reconciliation. */
  let indexWritesTrustworthy = true;
  /**
   * Phase 6-S5-R7 — the SINGLE canonical predicate for "everything this
   * rebuild depends on is verified". It starts true and can only ever go
   * false: every prerequisite failure (article query, Q&A query, business
   * profile lookup, chunk read/write/delete, embedding rejection) clears it,
   * and the destructive sweep reads this one flag instead of re-deriving a
   * partial condition per call site.
   */
  let rebuildTrustworthy = true;
  const distrust = (): void => { rebuildTrustworthy = false; };
  const applyIndexResult = (r: Awaited<ReturnType<typeof indexSource>>): void => {
    summary.chunksCreated += r.chunksCreated;
    summary.chunksUpdated += r.chunksUpdated;
    summary.chunksSkipped += r.chunksSkipped;
    summary.chunksDeleted += r.chunksDeleted;
    summary.embeddingsGenerated += r.embeddingsGenerated;
    summary.embeddingFailures += r.embeddingFailures;
    summary.sourcesProcessed += 1;
    if (!r.ok) {
      indexWritesTrustworthy = false;
      distrust();
      fail(
        r.errorCode === 'chunk_read_failed'
          ? 'chunk_query_failed'
          : r.errorCode === 'chunk_delete_failed'
            ? 'chunk_delete_failed'
            : 'chunk_write_failed',
      );
    }
    // An embedding that failed or was rejected as invalid leaves a chunk
    // without a usable vector. The index is therefore incomplete and must
    // not be used as the basis for retiring anything.
    if (r.embeddingFailures > 0) distrust();
  };

  // 1) Published KB articles
  //
  // Phase 6-S5-R4 — the eligible-article set is the ONLY input the
  // reconciliation sweep uses to decide what to retire. If this query fails we
  // must NOT treat "no rows" as "nothing is eligible", otherwise a transient
  // database error would wipe the entire KB index. The failure is recorded and
  // the sweep is skipped.
  //
  // Simple billing phase 4 — articles the plan has locked (over
  // max_kb_articles) are not eligible: the sweep below retires their chunks,
  // and the catch-up after an upgrade or a delete indexes them again. An
  // unreadable lock state locks nothing (fail open), so it never retires.
  //
  // Every eligible article, page by page: the data layer caps a read at
  // DATABASE_MAX_ROWS, and an article missing from this set would have its
  // chunks retired by the sweep below.
  const [{ data: publishedArticles, error: articlesError }, kbLock] = await Promise.all([
    readRows<Record<string, unknown>>((from, to) => sb
      .from('knowledge_base_articles')
      .select('id, slug, locale, title, content, status, created_at')
      .eq('workspace_id', workspaceId)
      .eq('status', 'published')
      .eq('used_by_ai', true)
      .order('id', { ascending: true })
      .range(from, to)),
    resolveKbLock(config, workspaceId),
  ]);
  const articleSetTrustworthy = !articlesError;
  if (articlesError) { distrust(); fail('kb_article_query_failed'); }
  const articles = (publishedArticles || []).filter((a) => !isKbArticleLocked(kbLock, a));
  const eligibleArticleIds = new Set<string>(articles.map((a) => a.id as string));
  for (const a of articles) {
    const chunks = chunkText([a.title, a.content].filter(Boolean).join('\n\n'));
    let r: Awaited<ReturnType<typeof indexSource>>;
    try {
      r = await indexSource(config, {
        workspaceId,
        sourceType: 'kb_article',
        sourceId: a.id as string,
        title: a.title as string,
        locale: (a.locale as string) || null,
        sourceUrl: a.slug ? `/help/${a.slug}` : null,
        chunks,
      }, embedder, { remainingEmbedBudget: remainingBudget });
    } catch (err) {
      // ENFORCED billing denial (exhausted wallet, missing rate card) — not a
      // transient per-item error. Stop attempting further embeds this
      // rebuild (they would fail identically) but keep processing remaining
      // sources so their chunk rows still get written.
      console.warn('[ai-agent.knowledgeIndex.sync] kb_article billing denial:', errorMessage(err));
      distrust();
      fail('embedding_failed');
      remainingBudget = 0;
      continue;
    }
    applyIndexResult(r);
    remainingBudget = Math.max(0, remainingBudget - r.embeddingsGenerated - r.embeddingFailures);
  }

  // 2) Enabled Q&A
  //
  // A failed query must never be read as "no Q&A exist": that would let the
  // rebuild report success on an untrusted, empty source set.
  const { data: qnas, error: qnasError } = await sb
    .from('ai_agent_qna')
    .select('id, question, answer, locale, enabled')
    .eq('workspace_id', workspaceId)
    .eq('enabled', true)
    .limit(5000);
  if (qnasError) { distrust(); fail('qna_query_failed'); }
  for (const q of qnasError ? [] : (qnas || [])) {
    const chunks = chunkQna(q.question as string, q.answer as string);
    let r: Awaited<ReturnType<typeof indexSource>>;
    try {
      r = await indexSource(config, {
        workspaceId,
        sourceType: 'qna',
        sourceId: q.id as string,
        title: q.question as string,
        locale: (q.locale as string) || null,
        chunks,
      }, embedder, { remainingEmbedBudget: remainingBudget });
    } catch (err) {
      console.warn('[ai-agent.knowledgeIndex.sync] qna billing denial:', errorMessage(err));
      distrust();
      fail('embedding_failed');
      remainingBudget = 0;
      continue;
    }
    applyIndexResult(r);
    remainingBudget = Math.max(0, remainingBudget - r.embeddingsGenerated - r.embeddingFailures);
  }

  // 3) Business profile
  //
  // An absent/empty profile is a VALID state. A settings lookup FAILURE is not
  // — it is indistinguishable from "empty" unless we detect it explicitly.
  let profileText = '';
  let profileOk = true;
  try {
    const settings = await getOrCreateSettings(config, workspaceId);
    profileText = [
      settings.business_description,
      settings.instructions?.custom_instructions,
    ].filter(Boolean).join('\n\n');
  } catch {
    profileOk = false;
    distrust();
    fail('business_profile_query_failed');
  }
  if (profileOk && profileText) {
    const chunks = chunkText(profileText);
    try {
      const r = await indexSource(config, {
        workspaceId,
        sourceType: 'business_profile',
        sourceId: workspaceId,
        title: 'Business profile',
        chunks,
      }, embedder, { remainingEmbedBudget: remainingBudget });
      applyIndexResult(r);
      remainingBudget = Math.max(0, remainingBudget - r.embeddingsGenerated);
    } catch (err) {
      console.warn('[ai-agent.knowledgeIndex.sync] business_profile billing denial:', errorMessage(err));
      distrust();
      fail('embedding_failed');
      remainingBudget = 0;
    }
  }

  // 4) Reconciliation sweep — Phase 6-S5-R3.
  //
  // Indexing above only ADDS/UPDATES. Articles that were deleted, unpublished,
  // archived or flagged used_by_ai=false leave stale chunks behind, so every
  // kb_article chunk whose source_id is not in the eligible set is retired.
  // Scoped to source_type='kb_article' — Q&A and business-profile chunks are
  // never touched here.
  //
  // The sweep is DESTRUCTIVE, so Phase 6-S5-R7 gates it on the single
  // canonical `rebuildTrustworthy` predicate: ANY prerequisite failure
  // anywhere above (article query, Q&A query, business-profile lookup, chunk
  // read/write/delete, or a failed/invalid embedding) blocks it entirely.
  // A blocked sweep is reported as non-terminal so the outbox event is
  // retried rather than marked processed on unverified data.
  const reconciliationAllowed =
    rebuildTrustworthy && articleSetTrustworthy && indexWritesTrustworthy;
  let reconciliationFailed = false;
  const reconciliationBlocked = !reconciliationAllowed;
  if (reconciliationAllowed) {
    // Every live kb_article chunk, page by page (DATABASE_MAX_ROWS caps a
    // single read): a chunk past the cap would never be retired.
    const { data: kbChunks, error: chunksError } = await readRows<{ id: string; source_id: string }>((from, to) => sb
      .from('ai_knowledge_chunks')
      .select('id, source_id')
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'kb_article')
      .neq('status', 'deleted')
      .order('id', { ascending: true })
      .range(from, to));
    if (chunksError) {
      reconciliationFailed = true;
      distrust();
      fail('chunk_query_failed');
    } else {
      const staleSourceIds = Array.from(
        new Set(
          (kbChunks || [])
            .map((c) => c.source_id as string)
            .filter((id) => id && !eligibleArticleIds.has(id)),
        ),
      );
      if (staleSourceIds.length > 0) {
        let retiredCount = 0;
        let retireFailed = false;
        for (let i = 0; i < staleSourceIds.length && !retireFailed; i += RETIRE_BATCH) {
          const { data: retired, error: retireError } = await sb
            .from('ai_knowledge_chunks')
            .update({ status: 'deleted', updated_at: new Date().toISOString() })
            .eq('workspace_id', workspaceId)
            .eq('source_type', 'kb_article')
            .neq('status', 'deleted')
            .in('source_id', staleSourceIds.slice(i, i + RETIRE_BATCH))
            .select('id');
          if (retireError) retireFailed = true;
          else retiredCount += (retired || []).length;
        }
        if (retireFailed) {
          reconciliationFailed = true;
          distrust();
          fail('chunk_reconciliation_failed');
        } else {
          summary.staleSourcesReconciled = staleSourceIds.length;
          summary.chunksDeleted += retiredCount;
        }
      }
    }
  }
  if (reconciliationBlocked || reconciliationFailed) {
    summary.reconciliationSkipped = true;
    if (reconciliationFailed) {
      fail('chunk_reconciliation_failed');
    } else if (summary.embeddingFailures === 0 || summary.terminalState === 'failed') {
      // A block caused by a real prerequisite failure. `fail` keeps the FIRST
      // code, so the precise upstream classification is preserved; a block
      // with no earlier cause is attributed to the skip itself.
      fail('reconciliation_skipped_untrusted');
    }
    // Otherwise the ONLY cause is incomplete embeddings, which the strict
    // policy below turns into a retryable deferral rather than a hard failure.
  }

  summary.embeddingBudgetUsed = budget - remainingBudget;

  // Phase 6-S5-R6 — STRICT partial-embedding policy.
  //
  // A rebuild that produced ANY embedding failure is not complete: the chunks
  // that failed have no vector and would silently never be retried once the
  // event is marked processed. Deployments with NO usable provider run a
  // documented keyword-only index and still complete normally.
  if (
    summary.terminalState === 'completed' &&
    isUsableEmbeddingProvider(embedder) &&
    summary.embeddingFailures > 0
  ) {
    summary.ok = false;
    summary.terminalState = 'deferred_provider_unavailable';
    summary.errorCode = 'embedding_provider_unavailable';
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

  // The data layer caps a read at DATABASE_MAX_ROWS, so the totals are exact
  // counts and the breakdowns are read page by page (two narrow columns, not
  // the vectors).
  const chunks = () => sb.from('ai_knowledge_chunks');
  const counted = () => chunks().select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
  const countOf = async (query: PromiseLike<{ count: number | null }>): Promise<number> => (await query).count || 0;
  const [active, stale, deleted, embedded, live, provider, newest] = await Promise.all([
    countOf(counted().eq('status', 'active')),
    countOf(counted().eq('status', 'stale')),
    countOf(counted().eq('status', 'deleted')),
    countOf(counted().not('embedding', 'is', null)),
    readRows<{ id: string; source_type: string; locale: string | null }>((from, to) => chunks()
      .select('id, source_type, locale')
      .eq('workspace_id', workspaceId)
      .neq('status', 'deleted')
      .order('id', { ascending: true })
      .range(from, to)),
    chunks()
      .select('embedding_provider, embedding_model')
      .eq('workspace_id', workspaceId)
      .not('embedding_provider', 'is', null)
      .limit(1)
      .maybeSingle(),
    chunks()
      .select('updated_at')
      .eq('workspace_id', workspaceId)
      .not('updated_at', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  status.activeChunks = active;
  status.staleChunks = stale;
  status.deletedChunks = deleted;
  status.embeddedChunks = embedded;
  for (const r of live.data) {
    status.bySourceType[r.source_type] = (status.bySourceType[r.source_type] || 0) + 1;
    const loc = r.locale || 'unknown';
    status.byLocale[loc] = (status.byLocale[loc] || 0) + 1;
  }
  const providerRow = provider.data as { embedding_provider?: string | null; embedding_model?: string | null } | null;
  if (providerRow?.embedding_provider) {
    status.embeddingProvider = providerRow.embedding_provider;
    status.embeddingModel = providerRow.embedding_model || null;
  }
  status.lastUpdated = ((newest.data as { updated_at?: string | null } | null)?.updated_at) ?? null;

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