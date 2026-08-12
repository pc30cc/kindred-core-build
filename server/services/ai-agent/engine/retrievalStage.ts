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
import { decideKnowledgeRetrieval, isBusinessEvidenceReason } from '../retrievalDecision.js';
import { detectTopics } from '../queryExpansion.js';
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
  retrievalAttempted: boolean;
  retrievalDecisionReason: string;
  /** Semantic (not execution) evidence that this turn is business-specific. */
  businessSignalDetected: boolean;
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

  // Architecture cleanup — retrieval is decided from PIPELINE SIGNALS
  // (owner topics, domain vocabulary, page context, business follow-up),
  // never from message shape (question mark / digits / word count).
  // See ../retrievalDecision.ts.
  const lastAssistantTurn = [...(built.contextTurns || [])]
    .reverse().find((t: any) => t?.role === 'assistant');
  const lastAssistantMeta: any = lastAssistantTurn?.metadata || {};
  const priorTurnUsedBusinessKnowledge =
    ((lastAssistantMeta.kb_article_ids || []).length + (lastAssistantMeta.qna_ids || []).length) > 0;
  const priorVisitorTurn = [...(built.contextTurns || [])]
    .reverse().find((t: any) => t?.role === 'visitor' && (t?.text || '') !== built.originalMessage);
  const priorIntentText = built.clarification?.originalIntent || priorVisitorTurn?.text || '';

  const retrievalDecision = decideKnowledgeRetrieval({
    // Domain vocabulary of the CURRENT message. The builder already computes
    // this; recompute when it returned nothing so the signal never depends on
    // how the query was rewritten.
    domainTopics: ((built.topics || []).length
      ? built.topics
      : detectTopics(question)) as string[],
    addedTerms: built.addedTerms || [],
    workspaceTopicSlugs: ((ctxStage.detectedTopicsMeta as any)?.detectedTopics || [])
      .map((t: any) => t?.slug).filter(Boolean),
    // Ambient availability vs. the visitor actually referring to the page.
    pageContextAvailable: !!pageContext?.currentPageUrl,
    pageContextReferenced: !!pre.isPageIntent && !!pageContext?.currentPageUrl,
    followUp: !!built.followUpDetected || !!built.previousAiAskedClarification,
    priorIntentDomainTopics: priorIntentText ? (detectTopics(priorIntentText) as string[]) : [],
    priorTurnUsedBusinessKnowledge,
  });
  const knowledgeLookupNeeded = retrievalDecision.retrieve;
  const emptyRetrieval = {
    sources: [] as any[], hybridUsed: false, vectorUsed: false, keywordUsed: false,
    embeddingProviderName: null, embeddingModelName: null,
    fallbackReason: `retrieval_skipped_${retrievalDecision.reason}`, selectedSourcesMeta: [],
    pageContextDebug: null, retrievalDebug: null, excludedSummary: null,
  };
  const {
    sources, hybridUsed, vectorUsed, keywordUsed, embeddingProviderName,
    embeddingModelName, fallbackReason, selectedSourcesMeta, pageContextDebug,
    retrievalDebug, excludedSummary,
  } = knowledgeLookupNeeded ? await retrieveKnowledgeForRuntime(config, {
    workspaceId,
    originalMessage: built.originalMessage,
    retrievalQuery: built.retrievalQuery,
    expandedQuery: built.expandedQuery,
    responseLanguage: locale,
    inputLanguage,
    limit: 5,
    pageContext,
  }) : (emptyRetrieval as any);

  const queryMeta = {
    original_message: built.originalMessage,
    retrieval_query: built.retrievalQuery,
    expanded_query: built.expandedQuery,
    context_messages_used: built.contextMessagesUsed,
    topics: built.topics,
    added_terms_count: built.addedTerms.length,
    follow_up_detected: built.followUpDetected,
    previous_ai_asked_clarification: built.previousAiAskedClarification,
    // ── Phase 2 observability ──────────────────────────────────────────
    conversation_context_used: !!built.conversationContextUsed,
    conversation_turns_used: built.conversationTurnsUsed ?? 0,
    query_rewrite_reason: built.rewriteReason || 'none',
    clarification_context: {
      asked: !!built.clarification?.asked,
      question: built.clarification?.question ?? null,
      original_intent: built.clarification?.originalIntent ?? null,
      follow_up_response: built.clarification?.followUpResponse ?? null,
    },
    knowledge_lookup_needed: knowledgeLookupNeeded,
    // Instrumentation — tests/inspector can assert retrieval really was skipped.
    retrieval_attempted: knowledgeLookupNeeded,
    retrieval_decision_reason: retrievalDecision.reason,
    retrieval_decision_signals: retrievalDecision.signals,
    business_signal_detected: isBusinessEvidenceReason(retrievalDecision.reason),
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
    retrievalAttempted: knowledgeLookupNeeded,
    retrievalDecisionReason: retrievalDecision.reason,
    businessSignalDetected: isBusinessEvidenceReason(retrievalDecision.reason),
  };
}
