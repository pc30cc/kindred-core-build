/**
 * Phase 1B — C13: page-aware retrieval, against the REAL canonicalizeUrl()
 * and page-boost logic inside retrieveHybridSources() (not mocked
 * indirectly — the real function is exercised end-to-end via pageContext).
 *
 * Exact constants read directly from retrievalHybrid.ts and pinned below,
 * not guessed:
 *  - canonicalizeUrl() strips: hash; these exact query params: token,
 *    access_token, refresh_token, code, password, session, auth, key,
 *    secret, api_key, sig, signature; lowercases host; strips a leading
 *    "www."; strips a trailing "/" (except bare "/").
 *  - Page-match boost: exact canonical URL match -> 1.0 (exact_page_match);
 *    same host+path (search/hash differ) -> 0.8 (same_path_match); same
 *    host only -> 0.35 (same_host_match); different host -> no page boost
 *    at all.
 *  - Final score formula weights are asserted directly off the exposed
 *    retrieval_debug.ranking_weights object rather than re-derived:
 *    keyword 0.32, vector 0.40, source_priority 0.10, locale_bonus 0.05,
 *    topic_boost 0.08, url_boost 0.05, page_boost 0.55 (page_boost
 *    dominates by design — this is pinned via relative-ranking tests
 *    below, not one brittle absolute final-score assertion).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeSupabase } from './helpers/engineFixtures.js';
import { makeChunkRow, makeDataSourceRow, makeRetrievalTables } from './helpers/retrievalFixtures.js';

let fakeSb: ReturnType<typeof makeFakeSupabase>;
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai/index.js', () => ({ resolveAIConfig: async () => null }));

const { retrieveHybridSources } = await import('../../../server/services/ai-agent/retrievalHybrid.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;
const WS = 'ws-1';

function seedPricingPage(overrides: Record<string, any> = {}) {
  return makeFakeSupabase(makeRetrievalTables({
    ai_knowledge_chunks: [
      makeChunkRow({
        id: 'pricing-chunk',
        workspace_id: WS,
        source_type: 'web_page',
        source_id: 'site-1:pricing',
        title: 'Pricing',
        content: 'Our pricing information for various plans.',
        source_url: 'https://example.com/pricing',
        metadata: { parent_source_id: 'site-1' },
        ...overrides,
      }),
    ],
    ai_data_sources: [makeDataSourceRow({ id: 'site-1', workspace_id: WS, source_type: 'website', status: 'active' })],
  }));
}

function q(currentPageUrl: string | null, overrides: Record<string, any> = {}) {
  return {
    workspaceId: WS,
    originalMessage: 'what is on this page',
    retrievalQuery: 'what is on this page',
    expandedQuery: '',
    responseLanguage: 'en',
    inputLanguage: 'en',
    limit: 10,
    pageContext: currentPageUrl ? { currentPageUrl } : null,
    ...overrides,
  };
}

beforeEach(() => {
  fakeSb = seedPricingPage();
});

describe('C13 — exact URL match', () => {
  it('an identical canonical URL sets exact_page_match and injects the page as a source', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing'));
    expect(r.pageContextDebug?.exact_page_match).toBe(true);
    expect(r.pageContextDebug?.same_path_match).toBe(false);
    expect(r.sources.some((s) => s.source_id === 'site-1:pricing')).toBe(true);
  });
});

describe('C13 — same host + same path, differing non-sensitive query/hash', () => {
  it('a different (non-sensitive) query string on the same path is a path match, not exact', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing?ref=email-campaign'));
    expect(r.pageContextDebug?.exact_page_match).toBe(false);
    expect(r.pageContextDebug?.same_path_match).toBe(true);
  });

  it('a hash-only difference is still an EXACT match (hash is stripped before comparison)', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing#annual-plan'));
    expect(r.pageContextDebug?.exact_page_match).toBe(true);
  });
});

describe('C13 — same host, different path', () => {
  it('sets same_host_match only, not exact or same_path', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/features'));
    expect(r.pageContextDebug?.exact_page_match).toBe(false);
    expect(r.pageContextDebug?.same_path_match).toBe(false);
    expect(r.pageContextDebug?.same_host_match).toBe(true);
  });
});

describe('C13 — different host', () => {
  it('produces no page-specific match at all', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://another-site.example/pricing'));
    expect(r.pageContextDebug?.exact_page_match).toBe(false);
    expect(r.pageContextDebug?.same_path_match).toBe(false);
    expect(r.pageContextDebug?.same_host_match).toBe(false);
    expect(r.pageContextDebug?.page_url_boost_applied).toBe(false);
  });
});

describe('C13 — trailing slash normalization', () => {
  it('/pricing and /pricing/ canonicalize to the same path (exact match)', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing/'));
    expect(r.pageContextDebug?.exact_page_match).toBe(true);
  });
});

describe('C13 — www normalization', () => {
  it('www.example.com and example.com canonicalize to the same host (exact match)', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://www.example.com/pricing'));
    expect(r.pageContextDebug?.exact_page_match).toBe(true);
  });

  it('is symmetric: a stored URL WITH www still exact-matches a visited URL WITHOUT www', async () => {
    fakeSb = seedPricingPage({ source_url: 'https://www.example.com/pricing' });
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing'));
    expect(r.pageContextDebug?.exact_page_match).toBe(true);
  });
});

describe('C13 — sensitive query parameters', () => {
  const SENSITIVE_KEYS = ['token', 'access_token', 'refresh_token', 'code', 'password', 'session', 'auth', 'key', 'secret', 'api_key', 'sig', 'signature'];

  it.each(SENSITIVE_KEYS)('a "%s" query parameter does not affect canonical matching (still exact)', async (key) => {
    const r = await retrieveHybridSources(CONFIG, q(`https://example.com/pricing?${key}=super-secret-value-12345`));
    expect(r.pageContextDebug?.exact_page_match).toBe(true);
  });

  it('sensitive parameter VALUES never appear in retrieval debug metadata', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing?token=super-secret-value-12345&access_token=another-secret-999'));
    const serializedDebug = JSON.stringify(r.retrievalDebug) + JSON.stringify(r.pageContextDebug);
    expect(serializedDebug).not.toContain('super-secret-value-12345');
    expect(serializedDebug).not.toContain('another-secret-999');
  });

  it('a non-sensitive query parameter alongside a sensitive one is still visible in canonical url debug, only the sensitive one is stripped', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing?ref=campaign&token=secret-abc'));
    expect(r.pageContextDebug?.current_page_url).toContain('ref=campaign');
    expect(r.pageContextDebug?.current_page_url).not.toContain('secret-abc');
    expect(r.pageContextDebug?.current_page_url).not.toContain('token=');
  });
});

describe('C13 — relative ranking (page boost dominates, not an exact float)', () => {
  it('an exact-page match outranks a same-host-only match for an otherwise-similar page chunk', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [
        makeChunkRow({ id: 'exact-chunk', workspace_id: WS, source_type: 'web_page', source_id: 'site-1:pricing', title: 'Pricing', content: 'pricing content', source_url: 'https://example.com/pricing', metadata: { parent_source_id: 'site-1' } }),
        makeChunkRow({ id: 'host-chunk', workspace_id: WS, source_type: 'web_page', source_id: 'site-1:other', title: 'Other page', content: 'other page content', source_url: 'https://example.com/other-page', metadata: { parent_source_id: 'site-1' } }),
      ],
      ai_data_sources: [makeDataSourceRow({ id: 'site-1', workspace_id: WS, source_type: 'website', status: 'active' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing'));
    const exact = r.sources.find((s) => s.source_id === 'site-1:pricing');
    const host = r.sources.find((s) => s.source_id === 'site-1:other');
    expect(exact).toBeTruthy();
    expect(exact!.final_score).toBeGreaterThan(host?.final_score ?? 0);
  });

  it('page boost can outrank a strong keyword match from an unrelated source', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [
        makeChunkRow({ id: 'page-chunk', workspace_id: WS, source_type: 'web_page', source_id: 'site-1:pricing', title: 'Pricing', content: 'unrelated filler words here', source_url: 'https://example.com/pricing', metadata: { parent_source_id: 'site-1' } }),
      ],
      ai_agent_qna: [
        // No keyword overlap with "what is on this page" beyond noise, so this
        // should score far lower than the exact page-boosted chunk above.
        { id: 'qna-noise', workspace_id: WS, question: 'random unrelated question xyz', answer: 'random unrelated answer xyz', locale: 'en', enabled: true },
      ],
      ai_data_sources: [makeDataSourceRow({ id: 'site-1', workspace_id: WS, source_type: 'website', status: 'active' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing'));
    const page = r.sources.find((s) => s.source_id === 'site-1:pricing');
    expect(page).toBeTruthy();
    expect(r.sources[0].source_id).toBe('site-1:pricing');
  });
});

describe('C13 — exposed ranking weight constants (pinned, not to be silently retuned)', () => {
  it('retrieval_debug.ranking_weights matches the current implementation exactly', async () => {
    const r = await retrieveHybridSources(CONFIG, q('https://example.com/pricing'));
    expect((r.retrievalDebug as any).ranking_weights).toEqual({
      keyword_weight: 0.32,
      vector_weight: 0.40,
      source_priority_weight: 0.10,
      locale_bonus_weight: 0.05,
      topic_boost_weight: 0.08,
      url_boost_weight: 0.05,
      page_boost_weight: 0.55,
    });
  });
});

describe('C13 — no pageContext provided', () => {
  it('produces no page debug data and no page-specific injection', async () => {
    const r = await retrieveHybridSources(CONFIG, q(null));
    expect(r.pageContextDebug?.exact_page_match).toBe(false);
    expect(r.pageContextDebug?.current_page_url).toBeNull();
  });
});
