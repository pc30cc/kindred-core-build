/**
 * Phase 1B — vector path characterization for retrieveHybridSources(),
 * supporting C10/C11's "hybrid" claim end-to-end. Only the true external
 * embedding boundary (the provider's HTTP call) is stubbed; resolution
 * (resolveEmbeddingProvider -> resolveAIConfig -> Supabase) runs for real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeSupabase } from './helpers/engineFixtures.js';
import { makeQnaRow, makeChunkRow, makeRetrievalTables } from './helpers/retrievalFixtures.js';

let fakeSb: ReturnType<typeof makeFakeSupabase>;
let resolveAIConfigImpl: () => Promise<any> = async () => null;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai/index.js', () => ({
  resolveAIConfig: (...args: any[]) => resolveAIConfigImpl(),
}));

const { retrieveHybridSources } = await import('../../../server/services/ai-agent/retrievalHybrid.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;
const WS = 'ws-1';

function q(overrides: Record<string, any> = {}) {
  return {
    workspaceId: WS,
    originalMessage: 'reset password',
    retrievalQuery: 'reset password',
    expandedQuery: '',
    responseLanguage: 'en',
    inputLanguage: 'en',
    limit: 10,
    ...overrides,
  };
}

beforeEach(() => {
  fakeSb = makeFakeSupabase(makeRetrievalTables());
  resolveAIConfigImpl = async () => null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('vector-unavailable path (no workspace/global AI provider configured)', () => {
  it('falls back to keyword-only: keywordUsed=true, vectorUsed=false, hybridUsed=false, embeddingProvider=noop', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [makeQnaRow({ id: 'qna-1', workspace_id: WS, question: 'reset password help' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q());
    expect(r.keywordUsed).toBe(true);
    expect(r.vectorUsed).toBe(false);
    expect(r.hybridUsed).toBe(false);
    expect(r.embeddingProvider).toBe('noop');
    expect(r.sources.some((s) => s.source_id === 'qna-1')).toBe(true);
  });
});

describe('keyword-only path with a configured but non-OpenAI-compatible provider', () => {
  it('still resolves to noop and stays keyword-only (isOpenAICompatible gate)', async () => {
    resolveAIConfigImpl = async () => ({ provider: 'not_a_real_provider', apiKey: 'k' });
    const r = await retrieveHybridSources(CONFIG, q());
    expect(r.vectorUsed).toBe(false);
    expect(r.embeddingProvider).toBe('noop');
  });
});

describe('vector-success path', () => {
  it('an OpenAI-compatible provider with a usable embedding produces vectorUsed=true and hybridUsed=true when keyword also ran', async () => {
    resolveAIConfigImpl = async () => ({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o-mini' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 0, 0] }] }),
      })) as any,
    );
    // business_profile is used here (rather than file/web_page) specifically
    // because it has no parent-row eligibility re-check (see the C12 finding
    // in retrievalEligibility.test.ts) — keeps this test focused on vector
    // scoring, not eligibility plumbing already covered elsewhere.
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [
        makeChunkRow({
          id: 'chunk-vec-1',
          workspace_id: WS,
          source_type: 'business_profile',
          source_id: 'profile-vec-1',
          title: 'unrelated title words',
          content: 'unrelated content words with zero keyword overlap',
          embedding: [1, 0, 0],
        }),
      ],
    }));

    const r = await retrieveHybridSources(CONFIG, q());

    expect(r.vectorUsed).toBe(true);
    expect(r.keywordUsed).toBe(true);
    expect(r.hybridUsed).toBe(true);
    const hit = r.sources.find((s) => s.source_id === 'profile-vec-1');
    expect(hit).toBeTruthy();
    expect(hit!.vector_score).toBeGreaterThan(0.9); // identical vectors -> cosine ~= 1
  });

  it('a vector match is found for a chunk with ZERO keyword overlap (proves vector path is genuinely independent of keyword scoring)', async () => {
    resolveAIConfigImpl = async () => ({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o-mini' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ embedding: [0, 1, 0] }] }),
      })) as any,
    );
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [
        makeChunkRow({
          id: 'chunk-vec-2',
          workspace_id: WS,
          source_type: 'business_profile',
          source_id: 'profile-vec-only',
          title: 'zzz completely different vocabulary zzz',
          content: 'zzz completely different vocabulary zzz',
          embedding: [0, 1, 0],
        }),
      ],
    }));

    const r = await retrieveHybridSources(CONFIG, q());
    const hit = r.sources.find((s) => s.source_id === 'profile-vec-only');
    expect(hit).toBeTruthy();
    expect(hit!.keyword_score).toBe(0);
    expect(hit!.vector_score).toBeGreaterThan(0.9);
  });
});

describe('vector failure behavior', () => {
  it('an embedding HTTP failure is caught, keyword results still return, and fallback_reason is set', async () => {
    resolveAIConfigImpl = async () => ({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o-mini' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'upstream down' } }),
      })) as any,
    );
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [makeQnaRow({ id: 'qna-still-works', workspace_id: WS, question: 'reset password help' })],
    }));

    const r = await retrieveHybridSources(CONFIG, q());

    expect(r.vectorUsed).toBe(false);
    expect(r.keywordUsed).toBe(true);
    expect(r.fallbackReason).toMatch(/^vector_failed:/);
    expect(r.sources.some((s) => s.source_id === 'qna-still-works')).toBe(true);
  });
});
