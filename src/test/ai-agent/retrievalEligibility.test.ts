/**
 * Phase 1B — C12: eligibility rules + mandatory cross-workspace isolation,
 * against the REAL retrieveHybridSources() implementation.
 *
 * Two distinct eligibility layers exist in current code and both are
 * exercised here:
 *  1. Query-time filters (the initial ai_agent_qna/knowledge_base_articles/
 *     ai_knowledge_chunks queries already scope by workspace_id + enabled/
 *     status/used_by_ai) — this is the PRIMARY, always-on defense.
 *  2. The defense-in-depth re-check block (retrievalHybrid.ts "E5 / Pass 3"
 *     comment) that re-verifies parent-row eligibility for anything that
 *     made it into the aggregated candidate set — this exists specifically
 *     to catch drift between a still-"active" ai_knowledge_chunks row and a
 *     parent (ai_agent_qna / knowledge_base_articles / ai_data_sources /
 *     ai_agent_learning_candidates) that has since become
 *     disabled/draft/inactive/unapproved. To exercise layer 2 directly (not
 *     just layer 1), several tests below seed a stale ai_knowledge_chunks
 *     row whose parent has since changed state — this is the exact drift
 *     scenario the code's own comment describes protecting against.
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
vi.mock('../../../server/services/ai/index.js', () => ({ resolveAIConfig: async () => null }));

const { retrieveHybridSources } = await import('../../../server/services/ai-agent/retrievalHybrid.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;
const WS_A = 'ws-a';
const WS_B = 'ws-b';

function q(overrides: Record<string, any> = {}) {
  return {
    workspaceId: WS_A,
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

describe('C12 — Q&A eligibility (query-time layer)', () => {
  it('enabled=true is eligible', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [makeQnaRow({ id: 'qna-on', workspace_id: WS_A, enabled: true, question: 'reset password help' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'reset password help', retrievalQuery: 'reset password help' }));
    expect(r.sources.some((s) => s.source_id === 'qna-on')).toBe(true);
  });

  it('enabled=false is excluded and never reaches the candidate set', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [makeQnaRow({ id: 'qna-off', workspace_id: WS_A, enabled: false, question: 'reset password help' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'reset password help', retrievalQuery: 'reset password help' }));
    expect(r.sources.some((s) => s.source_id === 'qna-off')).toBe(false);
  });
});

describe('C12 — Q&A eligibility (defense-in-depth layer: stale chunk drift)', () => {
  it('a stale qna-type chunk whose parent Q&A has since been disabled is dropped and counted', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [
        makeChunkRow({ id: 'chunk-stale-qna', workspace_id: WS_A, source_type: 'qna', source_id: 'qna-stale', status: 'active', title: 'reset password help', content: 'reset password help' }),
      ],
      ai_agent_qna: [makeQnaRow({ id: 'qna-stale', workspace_id: WS_A, enabled: false, question: 'reset password help' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'reset password help', retrievalQuery: 'reset password help' }));
    expect(r.sources.some((s) => s.source_id === 'qna-stale')).toBe(false);
    expect(r.excludedSummary?.disabled_qna_excluded).toBe(1);
  });
});

describe('C12 — Core KB eligibility', () => {
  it('published + used_by_ai=true is eligible', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      knowledge_base_articles: [makeKbArticleRow({ id: 'kb-pub', workspace_id: WS_A, status: 'published', used_by_ai: true, title: 'reset password guide' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'reset password guide', retrievalQuery: 'reset password guide' }));
    expect(r.sources.some((s) => s.source_id === 'kb-pub')).toBe(true);
  });

  it('draft (never published) is excluded at query time', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      knowledge_base_articles: [makeKbArticleRow({ id: 'kb-draft', workspace_id: WS_A, status: 'draft', title: 'reset password guide' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'reset password guide', retrievalQuery: 'reset password guide' }));
    expect(r.sources.some((s) => s.source_id === 'kb-draft')).toBe(false);
  });

  it('a stale kb_article-type chunk whose parent article has since gone to draft is dropped and counted', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [
        makeChunkRow({ id: 'chunk-stale-kb', workspace_id: WS_A, source_type: 'kb_article', source_id: 'kb-stale', status: 'active', title: 'reset password guide', content: 'reset password guide' }),
      ],
      knowledge_base_articles: [makeKbArticleRow({ id: 'kb-stale', workspace_id: WS_A, status: 'draft', title: 'reset password guide' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'reset password guide', retrievalQuery: 'reset password guide' }));
    expect(r.sources.some((s) => s.source_id === 'kb-stale')).toBe(false);
    expect(r.excludedSummary?.draft_kb_excluded).toBe(1);
  });

  it('used_by_ai=false excludes an otherwise-published article at query time', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      knowledge_base_articles: [makeKbArticleRow({ id: 'kb-notai', workspace_id: WS_A, status: 'published', used_by_ai: false, title: 'reset password guide' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'reset password guide', retrievalQuery: 'reset password guide' }));
    expect(r.sources.some((s) => s.source_id === 'kb-notai')).toBe(false);
  });
});

describe('C12 — file eligibility', () => {
  it('an active parent source makes its file chunk eligible', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [makeChunkRow({ id: 'c1', workspace_id: WS_A, source_type: 'file', source_id: 'file-active', title: 'handbook vacation policy', content: 'handbook vacation policy' })],
      ai_data_sources: [makeDataSourceRow({ id: 'file-active', workspace_id: WS_A, source_type: 'file', status: 'active' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'handbook vacation policy', retrievalQuery: 'handbook vacation policy' }));
    expect(r.sources.some((s) => s.source_id === 'file-active')).toBe(true);
  });

  it('a paused/inactive parent source excludes its file chunk and increments the counter', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [makeChunkRow({ id: 'c2', workspace_id: WS_A, source_type: 'file', source_id: 'file-paused', title: 'handbook vacation policy', content: 'handbook vacation policy' })],
      ai_data_sources: [makeDataSourceRow({ id: 'file-paused', workspace_id: WS_A, source_type: 'file', status: 'paused' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'handbook vacation policy', retrievalQuery: 'handbook vacation policy' }));
    expect(r.sources.some((s) => s.source_id === 'file-paused')).toBe(false);
    expect(r.excludedSummary?.inactive_file_excluded).toBe(1);
  });
});

describe('C12 — web_page eligibility', () => {
  it('an active parent website makes its web_page chunk eligible', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [makeChunkRow({ id: 'c3', workspace_id: WS_A, source_type: 'web_page', source_id: 'site-active:h1', title: 'pricing plans', content: 'pricing plans', metadata: { parent_source_id: 'site-active' } })],
      ai_data_sources: [makeDataSourceRow({ id: 'site-active', workspace_id: WS_A, source_type: 'website', status: 'active' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'pricing plans', retrievalQuery: 'pricing plans' }));
    expect(r.sources.some((s) => s.source_id === 'site-active:h1')).toBe(true);
  });

  it('an inactive parent website excludes its web_page chunk and increments the counter', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [makeChunkRow({ id: 'c4', workspace_id: WS_A, source_type: 'web_page', source_id: 'site-failed:h1', title: 'pricing plans', content: 'pricing plans', metadata: { parent_source_id: 'site-failed' } })],
      ai_data_sources: [makeDataSourceRow({ id: 'site-failed', workspace_id: WS_A, source_type: 'website', status: 'failed' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'pricing plans', retrievalQuery: 'pricing plans' }));
    expect(r.sources.some((s) => s.source_id === 'site-failed:h1')).toBe(false);
    expect(r.excludedSummary?.inactive_web_page_excluded).toBe(1);
  });
});

describe('C12 — learned Q&A eligibility', () => {
  it('an approved candidate is eligible', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [makeChunkRow({ id: 'c5', workspace_id: WS_A, source_type: 'learned_qna', source_id: 'cand-approved', title: 'refund timing', content: 'refund timing' })],
      ai_agent_learning_candidates: [makeLearningCandidateRow({ id: 'cand-approved', workspace_id: WS_A, status: 'approved' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'refund timing', retrievalQuery: 'refund timing' }));
    expect(r.sources.some((s) => s.source_id === 'cand-approved')).toBe(true);
  });

  it('an unapproved (pending) candidate is explicitly excluded and counted', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [makeChunkRow({ id: 'c6', workspace_id: WS_A, source_type: 'learned_qna', source_id: 'cand-pending', title: 'refund timing', content: 'refund timing' })],
      ai_agent_learning_candidates: [makeLearningCandidateRow({ id: 'cand-pending', workspace_id: WS_A, status: 'pending' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'refund timing', retrievalQuery: 'refund timing' }));
    expect(r.sources.some((s) => s.source_id === 'cand-pending')).toBe(false);
    expect(r.excludedSummary?.unapproved_learned_qna_excluded).toBe(1);
  });

  it('a rejected candidate is also excluded (only status=="approved" passes)', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [makeChunkRow({ id: 'c7', workspace_id: WS_A, source_type: 'learned_qna', source_id: 'cand-rejected', title: 'refund timing', content: 'refund timing' })],
      ai_agent_learning_candidates: [makeLearningCandidateRow({ id: 'cand-rejected', workspace_id: WS_A, status: 'rejected' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'refund timing', retrievalQuery: 'refund timing' }));
    expect(r.sources.some((s) => s.source_id === 'cand-rejected')).toBe(false);
  });
});

describe('C12 — business_profile: IMPLEMENTATION / DECLARED-INVARIANT NOTE', () => {
  it('a workspace-scoped active business_profile chunk is retrievable (no parent-table re-check exists for this source type)', async () => {
    // retrievalHybrid.ts's defense-in-depth block (E5/Pass 3) explicitly
    // re-verifies qna, kb_article, file and web_page eligibility, but has
    // NO branch for source_type === 'business_profile' at all — it relies
    // solely on the initial ai_knowledge_chunks query-time filter
    // (workspace_id + status='active'). This is not necessarily a bug
    // (business_profile chunks may have no separate "draft" concept to
    // drift from), but it is a real, confirmed asymmetry with the other
    // five source types and is pinned here rather than assumed away.
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [makeChunkRow({ id: 'c8', workspace_id: WS_A, source_type: 'business_profile', source_id: 'profile-1', title: 'about us', content: 'about us company info' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'about us company info', retrievalQuery: 'about us company info' }));
    expect(r.sources.some((s) => s.source_id === 'profile-1')).toBe(true);
  });
});

describe('C12 — excludedSummary counter semantics (pinned exactly as implemented)', () => {
  it('inactive_chunks_excluded, pending_candidates_excluded and cross_workspace_excluded stay at 0 despite matching drops — the counter names do NOT all reflect what actually increments them', async () => {
    // retrievalHybrid.ts initializes these three counters but:
    //  - inactive_chunks_excluded is explicitly commented "reserved (we
    //    already filter at query time)" and is never incremented anywhere.
    //  - pending_candidates_excluded is never incremented anywhere (a
    //    pending learning candidate is instead counted under
    //    unapproved_learned_qna_excluded, see the test above).
    //  - cross_workspace_excluded is never incremented anywhere either —
    //    cross-workspace rows are dropped via a plain `continue` inside the
    //    eligibility re-check loop (`if (r.workspace_id !== input.workspaceId) continue;`)
    //    with no counter increment. Cross-workspace isolation is real (see
    //    the isolation tests below) but this specific counter never reports it.
    // This is characterized here, not fixed.
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [
        makeChunkRow({ id: 'cw-1', workspace_id: WS_A, source_type: 'qna', source_id: 'qna-cross', title: 'reset password help', content: 'reset password help' }),
      ],
      ai_agent_qna: [makeQnaRow({ id: 'qna-cross', workspace_id: WS_B, enabled: true, question: 'reset password help' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ originalMessage: 'reset password help', retrievalQuery: 'reset password help' }));

    // The cross-workspace row is still correctly excluded from output...
    expect(r.sources.some((s) => s.source_id === 'qna-cross')).toBe(false);
    // ...but via disabled_qna_excluded (since it's simply absent from the
    // eligibleQna set built from a workspace-matched lookup), not via a
    // dedicated cross_workspace_excluded increment.
    expect(r.excludedSummary?.disabled_qna_excluded).toBe(1);
    expect(r.excludedSummary?.cross_workspace_excluded).toBe(0);
    expect(r.excludedSummary?.inactive_chunks_excluded).toBe(0);
    expect(r.excludedSummary?.pending_candidates_excluded).toBe(0);
  });
});

describe('C12 — cross-workspace isolation (MANDATORY)', () => {
  it('Q&A: high-scoring workspace B data never appears when querying as workspace A', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [
        makeQnaRow({ id: 'qna-b-secret', workspace_id: WS_B, enabled: true, question: 'reset password immediately now', answer: 'reset password immediately now' }),
      ],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ workspaceId: WS_A, originalMessage: 'reset password immediately now', retrievalQuery: 'reset password immediately now' }));
    expect(r.sources).toHaveLength(0);
    expect(r.sources.some((s) => s.source_id === 'qna-b-secret')).toBe(false);
  });

  it('knowledge_base_articles: workspace B data never appears when querying as workspace A', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      knowledge_base_articles: [
        makeKbArticleRow({ id: 'kb-b-secret', workspace_id: WS_B, status: 'published', used_by_ai: true, title: 'reset password immediately now' }),
      ],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ workspaceId: WS_A, originalMessage: 'reset password immediately now', retrievalQuery: 'reset password immediately now' }));
    expect(r.sources.some((s) => s.source_id === 'kb-b-secret')).toBe(false);
  });

  it('ai_knowledge_chunks (file/web_page/business_profile/learned_qna family): workspace B data never appears when querying as workspace A, even with an active/approved parent in B', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_knowledge_chunks: [
        makeChunkRow({ id: 'chunk-b-secret', workspace_id: WS_B, source_type: 'file', source_id: 'file-b-secret', title: 'confidential workspace b document', content: 'confidential workspace b document' }),
      ],
      ai_data_sources: [makeDataSourceRow({ id: 'file-b-secret', workspace_id: WS_B, source_type: 'file', status: 'active' })],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ workspaceId: WS_A, originalMessage: 'confidential workspace b document', retrievalQuery: 'confidential workspace b document' }));
    expect(r.sources).toHaveLength(0);
    expect(r.sources.some((s) => s.source_id === 'file-b-secret')).toBe(false);
  });

  it('mixed tenancy: workspace A and B both have matching data, only A data is returned for an A query', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [
        makeQnaRow({ id: 'qna-a', workspace_id: WS_A, enabled: true, question: 'reset password now please' }),
        makeQnaRow({ id: 'qna-b', workspace_id: WS_B, enabled: true, question: 'reset password now please' }),
      ],
    }));
    const r = await retrieveHybridSources(CONFIG, q({ workspaceId: WS_A, originalMessage: 'reset password now please', retrievalQuery: 'reset password now please' }));
    const ids = r.sources.map((s) => s.source_id);
    expect(ids).toContain('qna-a');
    expect(ids).not.toContain('qna-b');
  });
});
