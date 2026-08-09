/**
 * AI Agent engine — retrieval stage (query build, hybrid retrieval with
 * legacy keyword-only fallback, query metadata).
 *
 * Mechanically extracted from runInternal() in server/services/ai-agent/engine.ts
 * (Phase 5 engine extraction, Commit E). The body below is byte-identical to
 * the original code for this contiguous region -- only the function
 * boundary (signature, args destructure, and final return statement) is
 * new. No behavior change; this stage has no early/terminal returns in the
 * original code.
 *
 * NO retrieval facade: both retrieveHybridSources() and retrieveSources()
 * (and both current fallback paths -- hybrid-returns-nothing and
 * hybrid-throws) are preserved untouched, per Phase 5 scope. Includes the
 * Phase 2 `keywordUsed` fix on the hybrid-throw path.
 */
import type { ServerConfig } from '../../../config.js';
import { retrieveSources, type RetrievedSource } from '../retrieval.js';
import { retrieveHybridSources } from '../retrievalHybrid.js';
import { buildRetrievalQuery } from '../queryBuilder.js';
import type { MaybeRunInput } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';

export interface RetrievalStageResult {
  built: Awaited<ReturnType<typeof buildRetrievalQuery>>;
  sources: RetrievedSource[];
  hybridUsed: boolean;
  vectorUsed: boolean;
  keywordUsed: boolean;
  embeddingProviderName: string | null;
  embeddingModelName: string | null;
  fallbackReason: string | null;
  selectedSourcesMeta: Array<Record<string, unknown>>;
  pageContextDebug: any;
  retrievalDebug: any;
  excludedSummary: any;
  queryMeta: Record<string, unknown>;
}

export async function runRetrievalStage(
  config: ServerConfig,
  input: MaybeRunInput,
  pre: PreflightResult,
  ctxStage: ContextStageResult,
): Promise<RetrievalStageResult> {
  const { workspaceId, conversationId } = input;
  const question = (input.question || '').trim();
  const { pageContext } = pre;
  const { locale, inputLanguage } = ctxStage;

  // From here we either suggest or auto-reply. Both need retrieval.
  // Phase B — conversation-aware query builder + Phase C synonym expansion.
  const built = await buildRetrievalQuery({
    config,
    workspaceId,
    conversationId,
    currentMessage: question,
    inputLanguage,
    widgetLocale: locale,
  });

  // Pass 2 — hybrid retrieval with safe fallback to keyword-only retriever.
  let sources: RetrievedSource[] = [];
  let hybridUsed = false;
  let vectorUsed = false;
  let keywordUsed = false;
  let embeddingProviderName: string | null = null;
  let embeddingModelName: string | null = null;
  let fallbackReason: string | null = null;
  let selectedSourcesMeta: Array<Record<string, unknown>> = [];
  let pageContextDebug: any = null;
  let retrievalDebug: any = null;
  let excludedSummary: any = null;
  try {
    const hybrid = await retrieveHybridSources(config, {
      workspaceId,
      originalMessage: built.originalMessage,
      retrievalQuery: built.retrievalQuery,
      expandedQuery: built.expandedQuery,
      responseLanguage: locale,
      inputLanguage,
      limit: 5,
      pageContext: pageContext ? {
        currentPageUrl: pageContext.currentPageUrl,
        currentPageOrigin: pageContext.currentPageOrigin,
        currentPagePath: pageContext.currentPagePath,
        currentPageTitle: pageContext.currentPageTitle,
      } : null,
    });
    hybridUsed = hybrid.hybridUsed;
    vectorUsed = hybrid.vectorUsed;
    keywordUsed = hybrid.keywordUsed;
    embeddingProviderName = hybrid.embeddingProvider;
    embeddingModelName = hybrid.embeddingModel;
    fallbackReason = hybrid.fallbackReason || null;
    pageContextDebug = hybrid.pageContextDebug || null;
    retrievalDebug = hybrid.retrievalDebug || null;
    excludedSummary = hybrid.excludedSummary || null;
    selectedSourcesMeta = hybrid.sources.map((s) => ({
      id: s.source_id,
      source_type: s.source_type,
      kind: (s.kind === 'qna' ? 'qna' : 'kb_article'),
      title: s.title,
      slug: s.slug ?? null,
      source_url: s.source_type === 'file' ? null : (s.source_url ?? null),
      score: s.final_score,
      locale: s.locale ?? null,
      keyword_score: s.keyword_score,
      vector_score: s.vector_score,
      topic_boost: s.topic_boost,
      url_boost: s.url_boost,
      locale_bonus: s.locale_bonus,
      source_priority: s.source_priority,
      final_score: s.final_score,
    }));
    sources = hybrid.sources.map((s) => ({
      kind: (s.kind === 'qna' ? 'qna' : 'kb_article') as 'qna' | 'kb_article',
      id: s.source_id,
      title: s.title,
      excerpt: s.excerpt ?? null,
      content: s.content ?? null,
      slug: s.slug ?? null,
      locale: s.locale ?? null,
      score: s.final_score,
      // E2C — preserve original source_type + URL so prompt can label "Current page".
      source_type: s.source_type,
      source_url: s.source_type === 'file' ? null : (s.source_url ?? null),
      url_boost: s.url_boost,
    } as any));
    if (!sources.length && (vectorUsed || keywordUsed)) {
      // Fall through to legacy retriever only if hybrid produced nothing AND
      // the simple keyword-only path might still find loose matches.
      const legacy = await retrieveSources(config, workspaceId, built.retrievalQuery, locale, 5);
      if (legacy.length) {
        sources = legacy;
        hybridUsed = false;
        selectedSourcesMeta = legacy.map((s) => ({
          id: s.id, source_type: s.kind, kind: s.kind,
          title: s.title, slug: s.slug ?? null, source_url: null,
          score: s.score, locale: s.locale ?? null,
          keyword_score: s.score, vector_score: 0,
          topic_boost: 0, url_boost: 0, locale_bonus: 0, source_priority: 0,
          final_score: s.score,
        }));
      }
    }
  } catch (err: any) {
    console.warn('[ai-agent.engine] hybrid retrieval failed, falling back to keyword:', err?.message);
    fallbackReason = `hybrid_throw:${err?.message || 'unknown'}`;
    sources = await retrieveSources(config, workspaceId, built.retrievalQuery, locale, 5);
    // PHASE 2 FIX: the legacy retriever IS a keyword search, and it just
    // executed -- keywordUsed must reflect that so top-level queryMeta and
    // the nested retrieval_debug.execution block (hardcoded below) agree on
    // what actually ran for this request, instead of the top-level flag
    // staying at its unrelated `false` initial value.
    keywordUsed = true;
    selectedSourcesMeta = sources.map((s) => ({
      id: s.id, source_type: s.kind, kind: s.kind,
      title: s.title, slug: s.slug ?? null, source_url: null,
      score: s.score, locale: s.locale ?? null,
      keyword_score: s.score, vector_score: 0,
      topic_boost: 0, url_boost: 0, locale_bonus: 0, source_priority: 0,
      final_score: s.score,
    }));
    retrievalDebug = {
      execution: { fallback_reason: 'legacy_retriever_used', hybrid_used: false, vector_used: false, keyword_used: true },
      selected_sources: [],
      excluded_sources_summary: null,
    };
    excludedSummary = null;
  }

  const queryMeta = {
    original_message: built.originalMessage,
    retrieval_query: built.retrievalQuery,
    expanded_query: built.expandedQuery,
    context_messages_used: built.contextMessagesUsed,
    topics: built.topics,
    added_terms_count: built.addedTerms.length,
    follow_up_detected: built.followUpDetected,
    previous_ai_asked_clarification: built.previousAiAskedClarification,
    retrieval_results_count: sources.length,
    hybrid_used: hybridUsed,
    vector_used: vectorUsed,
    keyword_used: keywordUsed,
    embedding_provider: embeddingProviderName,
    embedding_model: embeddingModelName,
    fallback_reason: fallbackReason,
    selected_sources: selectedSourcesMeta,
    page_context: pageContextDebug || null,
    // E5 — standardized observable retrieval debug (Inspector reads this).
    retrieval_debug: retrievalDebug,
    excluded_sources_summary: excludedSummary,
  };

  return {
    built, sources, hybridUsed, vectorUsed, keywordUsed, embeddingProviderName,
    embeddingModelName, fallbackReason, selectedSourcesMeta, pageContextDebug,
    retrievalDebug, excludedSummary, queryMeta,
  };
}
