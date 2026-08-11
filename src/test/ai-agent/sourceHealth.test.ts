/**
 * Follow-up 6B — behavioral characterization of server/services/ai-agent/
 * sourceHealth.ts, which previously had ZERO behavioral test coverage (per
 * the retrieval-eligibility-duplication audit). Written BEFORE wiring the
 * shared sourcePolicy.ts predicates in, to pin current output first.
 *
 * Deliberately does NOT assert every field of SourceHealthItem -- only the
 * eligibility decision (`eligible`) and `reason` for representative rows
 * per source type, per the audit's own scoping guidance.
 */
import { describe, it, expect, vi } from 'vitest';
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

const { getSourceHealth } = await import('../../../server/services/ai-agent/sourceHealth.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;
const WS_A = 'ws-a';

function itemFor(items: Array<any>, sourceId: string) {
  return items.find((i) => i.source_id === sourceId);
}

describe('H1 — Q&A disabled', () => {
  it('eligible=false, reason=disabled_qna', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [makeQnaRow({ id: 'qna-off', workspace_id: WS_A, enabled: false })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'qna-off');
    expect(it_?.eligible).toBe(false);
    expect(it_?.reason).toBe('disabled_qna');
  });
});

describe('H2 — Q&A enabled but no active chunks', () => {
  it('eligible=false, reason=no_active_chunks (current behavior, NOT corrected here even though keyword retrieval may still work)', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [makeQnaRow({ id: 'qna-nochunks', workspace_id: WS_A, enabled: true })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'qna-nochunks');
    expect(it_?.eligible).toBe(false);
    expect(it_?.reason).toBe('no_active_chunks');
  });
});

describe('H3 — Q&A enabled + active + embedded chunk', () => {
  it('eligible=true, reason=eligible', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [makeQnaRow({ id: 'qna-ok', workspace_id: WS_A, enabled: true })],
      ai_knowledge_chunks: [makeChunkRow({ id: 'c1', workspace_id: WS_A, source_type: 'qna', source_id: 'qna-ok', status: 'active', embedding: [0.1, 0.2] })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'qna-ok');
    expect(it_?.eligible).toBe(true);
    expect(it_?.reason).toBe('eligible');
  });
});

describe('H4 — KB draft', () => {
  it('reason=draft_kb', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      knowledge_base_articles: [makeKbArticleRow({ id: 'kb-draft', workspace_id: WS_A, status: 'draft', used_by_ai: true })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'kb-draft');
    expect(it_?.eligible).toBe(false);
    expect(it_?.reason).toBe('draft_kb');
  });
});

describe('H5 — KB used_by_ai=false', () => {
  it('reason=kb_disabled_for_ai (distinct from draft_kb)', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      knowledge_base_articles: [makeKbArticleRow({ id: 'kb-notai', workspace_id: WS_A, status: 'published', used_by_ai: false })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'kb-notai');
    expect(it_?.eligible).toBe(false);
    expect(it_?.reason).toBe('kb_disabled_for_ai');
  });
});

describe('KB published + used_by_ai + active/embedded chunk (sanity: eligible path still reachable)', () => {
  it('reason=eligible', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      knowledge_base_articles: [makeKbArticleRow({ id: 'kb-ok', workspace_id: WS_A, status: 'published', used_by_ai: true })],
      ai_knowledge_chunks: [makeChunkRow({ id: 'c2', workspace_id: WS_A, source_type: 'kb_article', source_id: 'kb-ok', status: 'active', embedding: [0.1] })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'kb-ok');
    expect(it_?.eligible).toBe(true);
    expect(it_?.reason).toBe('eligible');
  });
});

describe('H6 — learned candidate unapproved', () => {
  it('reason=candidate_not_approved', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_learning_candidates: [makeLearningCandidateRow({ id: 'cand-pending', workspace_id: WS_A, status: 'pending' })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'cand-pending');
    expect(it_?.eligible).toBe(false);
    expect(it_?.reason).toBe('candidate_not_approved');
  });

  it('approved + active/embedded chunk -> eligible=true (sanity)', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_learning_candidates: [makeLearningCandidateRow({ id: 'cand-ok', workspace_id: WS_A, status: 'approved' })],
      ai_knowledge_chunks: [makeChunkRow({ id: 'c3', workspace_id: WS_A, source_type: 'learned_qna', source_id: 'cand-ok', status: 'active', embedding: [0.1] })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'cand-ok');
    expect(it_?.eligible).toBe(true);
    expect(it_?.reason).toBe('eligible');
  });
});

describe('H7 — file inactive', () => {
  it('reason=file_not_active', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_data_sources: [makeDataSourceRow({ id: 'file-paused', workspace_id: WS_A, source_type: 'file', status: 'paused' })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'file-paused');
    expect(it_?.eligible).toBe(false);
    expect(it_?.reason).toBe('file_not_active');
  });

  it('active + active/embedded chunk -> eligible=true (sanity)', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_data_sources: [makeDataSourceRow({ id: 'file-ok', workspace_id: WS_A, source_type: 'file', status: 'active' })],
      ai_knowledge_chunks: [makeChunkRow({ id: 'c4', workspace_id: WS_A, source_type: 'file', source_id: 'file-ok', status: 'active', embedding: [0.1] })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'file-ok');
    expect(it_?.eligible).toBe(true);
    expect(it_?.reason).toBe('eligible');
  });
});

describe('H8 — website inactive / web_page parent derivation', () => {
  it('website row: reason=website_not_active', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_data_sources: [makeDataSourceRow({ id: 'site-failed', workspace_id: WS_A, source_type: 'website', status: 'failed' })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    const it_ = itemFor(r.items, 'site-failed');
    expect(it_?.eligible).toBe(false);
    expect(it_?.reason).toBe('website_not_active');
  });

  it('web_page item (derived parent): inactive parent website -> reason=website_not_active, using the existing parent derivation', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_data_sources: [makeDataSourceRow({ id: 'site-failed2', workspace_id: WS_A, source_type: 'website', status: 'failed' })],
      ai_knowledge_chunks: [makeChunkRow({
        id: 'c5', workspace_id: WS_A, source_type: 'web_page', source_id: 'site-failed2:h1',
        status: 'active', metadata: { parent_source_id: 'site-failed2' },
      })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, { sourceType: 'web_page' });
    const it_ = itemFor(r.items, 'site-failed2:h1');
    expect(it_?.eligible).toBe(false);
    expect(it_?.reason).toBe('website_not_active');
  });

  it('web_page item: active parent + active/embedded chunk -> eligible=true (sanity)', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_data_sources: [makeDataSourceRow({ id: 'site-ok', workspace_id: WS_A, source_type: 'website', status: 'active' })],
      ai_knowledge_chunks: [makeChunkRow({
        id: 'c6', workspace_id: WS_A, source_type: 'web_page', source_id: 'site-ok:h1',
        status: 'active', embedding: [0.1], metadata: { parent_source_id: 'site-ok' },
      })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, { sourceType: 'web_page' });
    const it_ = itemFor(r.items, 'site-ok:h1');
    expect(it_?.eligible).toBe(true);
    expect(it_?.reason).toBe('eligible');
  });
});

describe('summary counters reflect eligible/not_eligible correctly', () => {
  it('a mixed set produces matching eligible/not_eligible totals', async () => {
    fakeSb = makeFakeSupabase(makeRetrievalTables({
      ai_agent_qna: [
        makeQnaRow({ id: 'qna-a', workspace_id: WS_A, enabled: true }),
        makeQnaRow({ id: 'qna-b', workspace_id: WS_A, enabled: false }),
      ],
      ai_knowledge_chunks: [makeChunkRow({ id: 'c7', workspace_id: WS_A, source_type: 'qna', source_id: 'qna-a', status: 'active', embedding: [0.1] })],
    }));
    const r = await getSourceHealth(CONFIG, WS_A, {});
    expect(r.summary.eligible).toBe(1);
    expect(r.summary.not_eligible).toBe(1);
  });
});
