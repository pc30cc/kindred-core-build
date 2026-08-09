/**
 * Phase 6 characterization — runtime retrieval facade
 * (server/services/ai-agent/runtimeRetrieval.ts::retrieveKnowledgeForRuntime).
 *
 * This file tests the facade DIRECTLY (not through the full engine), pinning
 * the exact hybrid-primary + conditional-legacy-fallback orchestration that
 * used to live inline in engine/retrievalStage.ts (Phase 5) and now lives
 * here. It does NOT modify retrieval.ts or retrievalHybrid.ts — those two
 * functions are mocked at the module boundary, same convention as
 * retrievalFallback.test.ts.
 *
 * Scenarios R1-R9 per the Phase 6 spec:
 *   R1 — hybrid success with sources
 *   R2 — hybrid empty + vector/keyword active + legacy has sources
 *   R3 — hybrid empty + vector/keyword active + legacy empty
 *   R4 — hybrid empty + neither keyword nor vector used (no fallback)
 *   R5 — hybrid throws + legacy succeeds
 *   R6 — hybrid throws + legacy empty
 *   R7 — hybrid throws + legacy throws (facade rejects, not swallowed)
 *   R8 — file-source URL privacy (source_url -> null)
 *   R9 — non-legacy source types (web_page/file/business_profile/learned_qna)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeHybridResult,
  makeHybridSource,
  makeRetrievedSource,
} from './helpers/engineFixtures.js';

let hybridImpl: () => Promise<any> = async () => makeHybridResult();
let legacyImpl: () => Promise<any> = async () => [];
let hybridCallCount = 0;
let legacyCallCount = 0;

vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({
  retrieveSources: (...args: any[]) => {
    legacyCallCount++;
    return legacyImpl();
  },
}));

vi.mock('../../../server/services/ai-agent/retrievalHybrid.js', () => ({
  retrieveHybridSources: (...args: any[]) => {
    hybridCallCount++;
    return hybridImpl();
  },
}));

const { retrieveKnowledgeForRuntime } = await import(
  '../../../server/services/ai-agent/runtimeRetrieval.js'
);

const CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'ANON_KEY',
  supabaseServiceRoleKey: 'SERVICE_KEY',
} as any;

function baseInput(overrides: Record<string, any> = {}) {
  return {
    workspaceId: 'ws-1',
    originalMessage: 'how do I reset my password',
    retrievalQuery: 'how do I reset my password',
    expandedQuery: 'how do I reset my password',
    responseLanguage: 'en',
    inputLanguage: 'en',
    limit: 5,
    pageContext: null,
    ...overrides,
  };
}

beforeEach(() => {
  hybridImpl = async () => makeHybridResult();
  legacyImpl = async () => [];
  hybridCallCount = 0;
  legacyCallCount = 0;
  vi.clearAllMocks();
});

describe('R1 — hybrid success with sources', () => {
  it('calls hybrid once, never calls legacy, and normalizes sources/metadata exactly', async () => {
    const hybridSource = makeHybridSource({
      id: 'chunk-1',
      source_id: 'kb-1',
      source_type: 'kb_article',
      kind: 'kb_article',
      title: 'Password reset',
      excerpt: 'excerpt text',
      content: 'content text',
      slug: 'reset',
      locale: 'en',
      final_score: 0.91,
      keyword_score: 0.8,
      vector_score: 0.95,
      topic_boost: 0.1,
      url_boost: 0,
      locale_bonus: 0.05,
      source_priority: 0.85,
    });
    hybridImpl = async () => makeHybridResult({
      sources: [hybridSource],
      vectorUsed: true,
      keywordUsed: true,
      hybridUsed: true,
      embeddingProvider: 'openai',
      embeddingModel: 'text-embedding-3-small',
      fallbackReason: undefined,
      pageContextDebug: { current_page_url: null, current_page_title: null, exact_page_match: false, same_path_match: false, same_host_match: false, page_matched_source_ids: [], page_url_boost_applied: false },
      retrievalDebug: { execution: { hybrid_used: true } },
      excludedSummary: { disabled_qna_excluded: 0 },
    });

    const result = await retrieveKnowledgeForRuntime(CONFIG, baseInput());

    expect(hybridCallCount).toBe(1);
    expect(legacyCallCount).toBe(0);
    expect(result.hybridUsed).toBe(true);
    expect(result.vectorUsed).toBe(true);
    expect(result.keywordUsed).toBe(true);
    expect(result.embeddingProviderName).toBe('openai');
    expect(result.embeddingModelName).toBe('text-embedding-3-small');
    expect(result.fallbackReason).toBeNull();
    expect(result.pageContextDebug).toEqual({ current_page_url: null, current_page_title: null, exact_page_match: false, same_path_match: false, same_host_match: false, page_matched_source_ids: [], page_url_boost_applied: false });
    expect(result.retrievalDebug).toEqual({ execution: { hybrid_used: true } });
    expect(result.excludedSummary).toEqual({ disabled_qna_excluded: 0 });

    expect(result.sources).toEqual([{
      kind: 'kb_article',
      id: 'kb-1',
      title: 'Password reset',
      excerpt: 'excerpt text',
      content: 'content text',
      slug: 'reset',
      locale: 'en',
      score: 0.91,
      source_type: 'kb_article',
      source_url: null,
      url_boost: 0,
    }]);

    expect(result.selectedSourcesMeta).toEqual([{
      id: 'kb-1',
      source_type: 'kb_article',
      kind: 'kb_article',
      title: 'Password reset',
      slug: 'reset',
      source_url: null,
      score: 0.91,
      locale: 'en',
      keyword_score: 0.8,
      vector_score: 0.95,
      topic_boost: 0.1,
      url_boost: 0,
      locale_bonus: 0.05,
      source_priority: 0.85,
      final_score: 0.91,
    }]);
  });
});

describe('R2 — hybrid empty + vector/keyword active + legacy has sources', () => {
  it('calls both retrievers, uses legacy sources, sets hybridUsed=false, preserves vector/keyword flags', async () => {
    hybridImpl = async () => makeHybridResult({ sources: [], vectorUsed: true, keywordUsed: true, hybridUsed: true });
    legacyImpl = async () => [makeRetrievedSource({ id: 'legacy-1', title: 'Legacy match', score: 0.7 })];

    const result = await retrieveKnowledgeForRuntime(CONFIG, baseInput());

    expect(hybridCallCount).toBe(1);
    expect(legacyCallCount).toBe(1);
    expect(result.sources).toEqual([{ kind: 'kb_article', id: 'legacy-1', title: 'Legacy match', excerpt: 'Legacy keyword match content.', content: 'Legacy keyword match content.', slug: 'legacy-kb-match', locale: 'en', score: 0.7 }]);
    expect(result.hybridUsed).toBe(false);
    expect(result.vectorUsed).toBe(true);
    expect(result.keywordUsed).toBe(true);
    expect(result.selectedSourcesMeta).toEqual([{
      id: 'legacy-1', source_type: 'kb_article', kind: 'kb_article',
      title: 'Legacy match', slug: 'legacy-kb-match', source_url: null,
      score: 0.7, locale: 'en',
      keyword_score: 0.7, vector_score: 0,
      topic_boost: 0, url_boost: 0, locale_bonus: 0, source_priority: 0,
      final_score: 0.7,
    }]);
  });
});

describe('R3 — hybrid empty + vector/keyword active + legacy empty', () => {
  it('pins the current (not "cleaner") result: hybridUsed stays true, empty sources, hybrid metadata untouched', async () => {
    hybridImpl = async () => makeHybridResult({
      sources: [], vectorUsed: true, keywordUsed: true, hybridUsed: true,
      fallbackReason: 'no_match',
      retrievalDebug: { execution: { hybrid_used: true } },
      excludedSummary: { disabled_qna_excluded: 2 },
    });
    legacyImpl = async () => [];

    const result = await retrieveKnowledgeForRuntime(CONFIG, baseInput());

    expect(hybridCallCount).toBe(1);
    expect(legacyCallCount).toBe(1);
    // legacy.length was 0, so the `if (legacy.length)` branch never ran —
    // sources/hybridUsed/selectedSourcesMeta stay at their pre-fallback
    // (hybrid) values, not reset to some "empty legacy" shape.
    expect(result.sources).toEqual([]);
    expect(result.hybridUsed).toBe(true);
    expect(result.vectorUsed).toBe(true);
    expect(result.keywordUsed).toBe(true);
    expect(result.fallbackReason).toBe('no_match');
    expect(result.retrievalDebug).toEqual({ execution: { hybrid_used: true } });
    expect(result.excludedSummary).toEqual({ disabled_qna_excluded: 2 });
    expect(result.selectedSourcesMeta).toEqual([]);
  });
});

describe('R4 — hybrid empty + neither keyword nor vector used', () => {
  it('does NOT call the legacy retriever and returns the empty hybrid result as-is', async () => {
    hybridImpl = async () => makeHybridResult({ sources: [], vectorUsed: false, keywordUsed: false, hybridUsed: true });

    const result = await retrieveKnowledgeForRuntime(CONFIG, baseInput());

    expect(hybridCallCount).toBe(1);
    expect(legacyCallCount).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.hybridUsed).toBe(true);
    expect(result.vectorUsed).toBe(false);
    expect(result.keywordUsed).toBe(false);
  });
});

describe('R5 — hybrid throws + legacy succeeds', () => {
  it('sets the hybrid_throw fallback reason, forces keywordUsed, and normalizes legacy sources', async () => {
    hybridImpl = async () => { throw new Error('vector index unreachable'); };
    legacyImpl = async () => [makeRetrievedSource({ id: 'legacy-2', title: 'Reset password', score: 0.9 })];

    const result = await retrieveKnowledgeForRuntime(CONFIG, baseInput());

    expect(hybridCallCount).toBe(1);
    expect(legacyCallCount).toBe(1);
    expect(result.fallbackReason).toBe('hybrid_throw:vector index unreachable');
    expect(result.hybridUsed).toBe(false);
    expect(result.vectorUsed).toBe(false);
    expect(result.keywordUsed).toBe(true);
    expect(result.retrievalDebug).toEqual({
      execution: { fallback_reason: 'legacy_retriever_used', hybrid_used: false, vector_used: false, keyword_used: true },
      selected_sources: [],
      excluded_sources_summary: null,
    });
    expect(result.excludedSummary).toBeNull();
    expect(result.sources).toEqual([{ kind: 'kb_article', id: 'legacy-2', title: 'Reset password', excerpt: 'Legacy keyword match content.', content: 'Legacy keyword match content.', slug: 'legacy-kb-match', locale: 'en', score: 0.9 }]);
    expect(result.selectedSourcesMeta).toEqual([{
      id: 'legacy-2', source_type: 'kb_article', kind: 'kb_article',
      title: 'Reset password', slug: 'legacy-kb-match', source_url: null,
      score: 0.9, locale: 'en',
      keyword_score: 0.9, vector_score: 0,
      topic_boost: 0, url_boost: 0, locale_bonus: 0, source_priority: 0,
      final_score: 0.9,
    }]);
  });
});

describe('R6 — hybrid throws + legacy empty', () => {
  it('keeps the catch-path metadata identical even when legacy also finds nothing', async () => {
    hybridImpl = async () => { throw new Error('embedding provider timeout'); };
    legacyImpl = async () => [];

    const result = await retrieveKnowledgeForRuntime(CONFIG, baseInput());

    expect(result.fallbackReason).toBe('hybrid_throw:embedding provider timeout');
    expect(result.hybridUsed).toBe(false);
    expect(result.vectorUsed).toBe(false);
    expect(result.keywordUsed).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.selectedSourcesMeta).toEqual([]);
    expect(result.retrievalDebug).toEqual({
      execution: { fallback_reason: 'legacy_retriever_used', hybrid_used: false, vector_used: false, keyword_used: true },
      selected_sources: [],
      excluded_sources_summary: null,
    });
    expect(result.excludedSummary).toBeNull();
  });
});

describe('R7 — hybrid throws + legacy throws', () => {
  it('is not swallowed locally — the facade rejects so the engine outer wrapper is the boundary', async () => {
    hybridImpl = async () => { throw new Error('vector index unreachable'); };
    legacyImpl = async () => { throw new Error('kb table unreachable too'); };

    await expect(retrieveKnowledgeForRuntime(CONFIG, baseInput())).rejects.toThrow('kb table unreachable too');
  });
});

describe('R8 — file-source URL privacy', () => {
  it('nulls source_url for source_type=file in both sources and selectedSourcesMeta', async () => {
    const fileSource = makeHybridSource({
      id: 'chunk-file-1',
      source_id: 'file-1',
      source_type: 'file',
      kind: 'kb_article',
      title: 'Confidential PDF',
      source_url: 'https://storage.example.com/private/confidential.pdf?token=secret',
    });
    hybridImpl = async () => makeHybridResult({ sources: [fileSource], vectorUsed: true, keywordUsed: true });

    const result = await retrieveKnowledgeForRuntime(CONFIG, baseInput());

    expect((result.sources[0] as any).source_url).toBeNull();
    expect((result.sources[0] as any).source_type).toBe('file');
    expect(result.selectedSourcesMeta[0].source_url).toBeNull();
  });
});

describe('R9 — non-legacy source types', () => {
  it.each([
    ['web_page', 'https://example.com/pricing'],
    ['file', 'https://storage.example.com/doc.pdf'],
    ['business_profile', null],
    ['learned_qna', null],
  ] as const)('preserves original source_type=%s while normalizing kind to qna|kb_article', async (sourceType, url) => {
    const hybridSource = makeHybridSource({
      id: `chunk-${sourceType}`,
      source_id: `${sourceType}-1`,
      source_type: sourceType,
      kind: sourceType === 'learned_qna' ? 'qna' : 'kb_article',
      title: `A ${sourceType} source`,
      source_url: url,
    });
    hybridImpl = async () => makeHybridResult({ sources: [hybridSource], vectorUsed: true, keywordUsed: true });

    const result = await retrieveKnowledgeForRuntime(CONFIG, baseInput());

    const src = result.sources[0] as any;
    expect(src.source_type).toBe(sourceType);
    expect(src.kind).toBe(sourceType === 'learned_qna' ? 'qna' : 'kb_article');
    // File sources never expose source_url; everything else passes it through as-is.
    expect(src.source_url).toBe(sourceType === 'file' ? null : url);

    const meta = result.selectedSourcesMeta[0];
    expect(meta.source_type).toBe(sourceType);
    expect(meta.kind).toBe(sourceType === 'learned_qna' ? 'qna' : 'kb_article');
    expect(meta.source_url).toBe(sourceType === 'file' ? null : url);
  });
});
