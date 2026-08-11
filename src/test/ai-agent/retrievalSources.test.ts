/**
 * Phase 1B — C10: source-type coverage for the REAL retrieval
 * implementation (server/services/ai-agent/retrievalHybrid.ts), not mocked
 * at the engine boundary this time.
 *
 * Source types confirmed present in current code (retrievalHybrid.ts:29,
 * SOURCE_PRIORITY at line ~117-124): qna, kb_article, learned_qna,
 * business_profile, web_page, file — all six from the Phase 0 inventory
 * are real. qna and kb_article come from their own tables
 * (ai_agent_qna / knowledge_base_articles); business_profile, learned_qna,
 * web_page and file all come through ai_knowledge_chunks, distinguished by
 * the `source_type` column.
 *
 * Only the true external boundary (Supabase) is faked here — the retrieval
 * function itself runs for real. No AI provider is seeded in
 * provider_configs/app_runtime_config, so resolveEmbeddingProvider()
 * naturally resolves to the noop provider and the keyword path is
 * exercised (see providerOrchestration.test.ts / retrievalVector.test.ts
 * for the provider-config resolution and vector-path tests respectively).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase } from './helpers/engineFixtures.js';
import {
  makeQnaRow,
  makeKbArticleRow,
  makeChunkRow,
  makeDataSourceRow,
  makeLearningCandidateRow,
  makeRetrievalTables,
} from './helpers/retrievalFixtures.js';

let fakeSb: ReturnType<typeof makeFakeSupabase>;
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai/index.js', () => ({
  resolveAIConfig: async () => null, // no embedding provider configured -> noop, keyword-only path
}));

const { retrieveHybridSources } = await import('../../../server/services/ai-agent/retrievalHybrid.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;
const WS = 'ws-1';

function baseQueryInput(overrides: Record<string, any> = {}) {
  return {
    workspaceId: WS,
    originalMessage: '',
    retrievalQuery: '',
    expandedQuery: '',
    responseLanguage: 'en',
    inputLanguage: 'en',
    limit: 10,
    ...overrides,
  };
}

beforeEach(() => {
  fakeSb = makeFakeSupabase(makeRetrievalTables());
});

describe('C10 — qna', () => {
  it('retrieves an eligible Q&A row with correct identity and content', async () => {
    fakeSb = makeFakeSupabase(
      makeRetrievalTables({
        ai_agent_qna: [
          makeQnaRow({ id: 'qna-1', workspace_id: WS, question: 'How do I reset my password?', answer: 'Go to settings and click reset password.' }),
        ],
      }),
    );

    const result = await retrieveHybridSources(CONFIG, baseQueryInput({ originalMessage: 'reset password', retrievalQuery: 'reset password' }));

    const hit = result.sources.find((s) => s.source_type === 'qna');
    expect(hit).toBeTruthy();
    expect(hit!.source_id).toBe('qna-1');
    expect(hit!.title).toBe('How do I reset my password?');
    expect(hit!.content).toBe('Go to settings and click reset password.');
    expect(hit!.final_score).toBeGreaterThan(0);
  });
});

describe('C10 — kb_article', () => {
  it('retrieves an eligible published KB article with correct identity, content and URL', async () => {
    fakeSb = makeFakeSupabase(
      makeRetrievalTables({
        knowledge_base_articles: [
          makeKbArticleRow({ id: 'kb-1', workspace_id: WS, slug: 'reset-password', title: 'How to reset your password' }),
        ],
      }),
    );

    const result = await retrieveHybridSources(CONFIG, baseQueryInput({ originalMessage: 'reset password', retrievalQuery: 'reset password' }));

    const hit = result.sources.find((s) => s.source_type === 'kb_article');
    expect(hit).toBeTruthy();
    expect(hit!.source_id).toBe('kb-1');
    expect(hit!.slug).toBe('reset-password');
    expect(hit!.source_url).toBe('/help/reset-password');
  });
});

describe('C10 — business_profile', () => {
  it('retrieves an eligible business_profile chunk with correct identity and content', async () => {
    fakeSb = makeFakeSupabase(
      makeRetrievalTables({
        ai_knowledge_chunks: [
          makeChunkRow({
            id: 'chunk-bp-1',
            workspace_id: WS,
            source_type: 'business_profile',
            source_id: 'profile-1',
            title: 'About our company',
            content: 'We are a customer support software company serving small businesses.',
          }),
        ],
      }),
    );

    const result = await retrieveHybridSources(
      CONFIG,
      baseQueryInput({ originalMessage: 'what does your company do', retrievalQuery: 'what does your company do' }),
    );

    const hit = result.sources.find((s) => s.source_type === 'business_profile');
    expect(hit).toBeTruthy();
    expect(hit!.source_id).toBe('profile-1');
    expect(hit!.content).toContain('customer support software');
  });
});

describe('C10 — learned_qna', () => {
  it('retrieves an eligible learned_qna chunk when its parent candidate is approved', async () => {
    fakeSb = makeFakeSupabase(
      makeRetrievalTables({
        ai_knowledge_chunks: [
          makeChunkRow({
            id: 'chunk-lq-1',
            workspace_id: WS,
            source_type: 'learned_qna',
            source_id: 'candidate-1',
            title: 'Refund timing question',
            content: 'Refunds are processed within 5 business days of the request.',
          }),
        ],
        ai_agent_learning_candidates: [makeLearningCandidateRow({ id: 'candidate-1', workspace_id: WS, status: 'approved' })],
      }),
    );

    const result = await retrieveHybridSources(
      CONFIG,
      baseQueryInput({ originalMessage: 'refund business days', retrievalQuery: 'refund business days' }),
    );

    const hit = result.sources.find((s) => s.source_type === 'learned_qna');
    expect(hit).toBeTruthy();
    expect(hit!.source_id).toBe('candidate-1');
  });
});

describe('C10 — web_page', () => {
  it('retrieves an eligible web_page chunk when its parent website source is active', async () => {
    fakeSb = makeFakeSupabase(
      makeRetrievalTables({
        ai_knowledge_chunks: [
          makeChunkRow({
            id: 'chunk-wp-1',
            workspace_id: WS,
            source_type: 'web_page',
            source_id: 'website-1:hash1',
            title: 'Pricing',
            content: 'Our pricing plans start at 9 dollars per month for the starter tier.',
            source_url: 'https://example.com/pricing',
            metadata: { parent_source_id: 'website-1' },
          }),
        ],
        ai_data_sources: [makeDataSourceRow({ id: 'website-1', workspace_id: WS, source_type: 'website', status: 'active' })],
      }),
    );

    const result = await retrieveHybridSources(
      CONFIG,
      baseQueryInput({ originalMessage: 'pricing plans starter', retrievalQuery: 'pricing plans starter' }),
    );

    const hit = result.sources.find((s) => s.source_type === 'web_page');
    expect(hit).toBeTruthy();
    expect(hit!.source_id).toBe('website-1:hash1');
    expect(hit!.source_url).toBe('https://example.com/pricing');
  });
});

describe('C10 — file', () => {
  it('retrieves an eligible file chunk with correct identity, and NEVER exposes a source_url', async () => {
    fakeSb = makeFakeSupabase(
      makeRetrievalTables({
        ai_knowledge_chunks: [
          makeChunkRow({
            id: 'chunk-file-1',
            workspace_id: WS,
            source_type: 'file',
            source_id: 'file-1',
            title: 'Employee handbook',
            content: 'Vacation policy: employees accrue 1.5 days per month of employment.',
            source_url: 'https://storage.example.com/signed/employee-handbook.pdf?token=SECRET',
          }),
        ],
        ai_data_sources: [makeDataSourceRow({ id: 'file-1', workspace_id: WS, source_type: 'file', status: 'active' })],
      }),
    );

    const result = await retrieveHybridSources(
      CONFIG,
      baseQueryInput({ originalMessage: 'vacation policy accrue', retrievalQuery: 'vacation policy accrue' }),
    );

    const hit = result.sources.find((s) => s.source_type === 'file');
    expect(hit).toBeTruthy();
    expect(hit!.source_id).toBe('file-1');
    // Security/privacy invariant pinned exactly as implemented (retrievalHybrid.ts
    // "Files MUST NEVER expose any URL"): source_url is force-nulled for files
    // even though the underlying chunk row has one.
    expect(hit!.source_url).toBeNull();
  });
});

describe('C10 — ranking inclusion threshold (not arbitrary ordering)', () => {
  it('a source with zero keyword overlap and no other signal is not returned at all', async () => {
    fakeSb = makeFakeSupabase(
      makeRetrievalTables({
        ai_agent_qna: [makeQnaRow({ id: 'qna-unrelated', workspace_id: WS, question: 'Completely unrelated topic zzz', answer: 'zzz' })],
      }),
    );

    const result = await retrieveHybridSources(
      CONFIG,
      baseQueryInput({ originalMessage: 'reset password', retrievalQuery: 'reset password' }),
    );

    expect(result.sources.find((s) => s.source_id === 'qna-unrelated')).toBeUndefined();
  });
});
