/**
 * AI Agent — runtime retrieval facade (Phase 6).
 *
 * The ONE retrieval interface the production visitor-message runtime
 * (server/services/ai-agent/engine/retrievalStage.ts) is allowed to know
 * about. Wraps hybrid retrieval (retrievalHybrid.ts) as the primary path
 * with a conditional fallback to the legacy keyword-only retriever
 * (retrieval.ts) — exactly the orchestration that used to live inline in
 * retrievalStage.ts, moved here unchanged.
 *
 * Scope: this file is orchestration only. It does NOT change scoring,
 * eligibility, tenant filtering, source types, canonical URL behavior, or
 * embedding resolution — those all remain owned by retrievalHybrid.ts and
 * retrieval.ts, untouched.
 *
 * Other product surfaces (Operator Assist, Internal QA/debug, Playground,
 * the read-only Overview/dry-run aggregator, the QA test harness) have
 * different retrieval contracts and intentionally keep calling
 * retrieveHybridSources()/retrieveSources() directly — see the Phase 6
 * call-site audit in the PR/commit description. This facade is not a
 * replacement for those calls.
 */
import type { ServerConfig } from '../../config.js';
import { retrieveSources, type RetrievedSource } from './retrieval.js';
import { retrieveHybridSources } from './retrievalHybrid.js';

export interface RuntimeRetrievalInput {
  workspaceId: string;
  originalMessage: string;
  retrievalQuery: string;
  expandedQuery?: string;
  responseLanguage: string;
  inputLanguage?: string;
  limit: number;
  pageContext?: {
    currentPageUrl?: string | null;
    currentPageOrigin?: string | null;
    currentPagePath?: string | null;
    currentPageTitle?: string | null;
  } | null;
}

export interface RuntimeRetrievalResult {
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
}

/**
 * Hybrid-primary retrieval with a conditional legacy fallback, for the
 * production visitor-message AI runtime ONLY. Byte-identical orchestration
 * to the original inline retrievalStage.ts logic (Phase 5) — see the two
 * fallback paths below, both preserved exactly:
 *
 *   Path A — hybrid resolves with zero sources AND (vectorUsed ||
 *            keywordUsed) was true -> legacy retrieveSources(), used only
 *            if it returns results. NOT triggered merely by an empty
 *            hybrid result.
 *   Path B — hybrid throws -> legacy retrieveSources() unconditionally,
 *            with keywordUsed forced true (Phase 2 fix) and a synthetic
 *            retrievalDebug block. Not locally caught — a second failure
 *            here propagates to the caller (the engine's outer
 *            never-throw wrapper is the intended boundary).
 */
export async function retrieveKnowledgeForRuntime(
  config: ServerConfig,
  input: RuntimeRetrievalInput,
): Promise<RuntimeRetrievalResult> {
  const {
    workspaceId, originalMessage, retrievalQuery, expandedQuery,
    responseLanguage: locale, inputLanguage, limit, pageContext,
  } = input;

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
      originalMessage,
      retrievalQuery,
      expandedQuery,
      responseLanguage: locale,
      inputLanguage,
      limit,
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
      const legacy = await retrieveSources(config, workspaceId, retrievalQuery, locale, limit);
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
    sources = await retrieveSources(config, workspaceId, retrievalQuery, locale, limit);
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

  return {
    sources, hybridUsed, vectorUsed, keywordUsed, embeddingProviderName,
    embeddingModelName, fallbackReason, selectedSourcesMeta, pageContextDebug,
    retrievalDebug, excludedSummary,
  };
}
