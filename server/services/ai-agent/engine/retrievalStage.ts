/**
 * AI Agent engine — retrieval stage (query build, runtime retrieval facade
 * call, query metadata).
 *
 * Phase 6 — runtime retrieval facade consolidation. This stage no longer
 * knows about retrieveHybridSources()/retrieveSources() directly; both live
 * behind server/services/ai-agent/runtimeRetrieval.ts::retrieveKnowledgeForRuntime(),
 * which preserves the exact hybrid-primary + conditional-legacy-fallback
 * orchestration this stage used to implement inline (Phase 5, Commit E).
 * See runtimeRetrieval.ts for the two fallback paths and their exact
 * semantics (unchanged).
 *
 * buildRetrievalQuery() and queryMeta construction stay owned by this stage
 * exactly as before — conversation-aware query building, added terms,
 * follow-up detection, and previous-clarification metadata are untouched.
 */
import type { ServerConfig } from '../../../config.js';
import { retrieveKnowledgeForRuntime } from '../runtimeRetrieval.js';
import { buildRetrievalQuery } from '../queryBuilder.js';
import type { MaybeRunInput } from './types.js';
import type { PreflightResult } from './preflightStage.js';
import type { ContextStageResult } from './contextStage.js';

export interface RetrievalStageResult {
  built: Awaited<ReturnType<typeof buildRetrievalQuery>>;
  sources: Awaited<ReturnType<typeof retrieveKnowledgeForRuntime>>['sources'];
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

  const {
    sources, hybridUsed, vectorUsed, keywordUsed, embeddingProviderName,
    embeddingModelName, fallbackReason, selectedSourcesMeta, pageContextDebug,
    retrievalDebug, excludedSummary,
  } = await retrieveKnowledgeForRuntime(config, {
    workspaceId,
    originalMessage: built.originalMessage,
    retrievalQuery: built.retrievalQuery,
    expandedQuery: built.expandedQuery,
    responseLanguage: locale,
    inputLanguage,
    limit: 5,
    pageContext,
  });

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
