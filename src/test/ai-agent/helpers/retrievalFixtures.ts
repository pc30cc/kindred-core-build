/**
 * Phase 1B — row builders for the tables server/services/ai-agent/
 * retrievalHybrid.ts and retrieval.ts actually query, matching the exact
 * column shapes read directly from that file (not guessed). Plain factory
 * functions only — no vi.mock() here.
 */

export function makeQnaRow(overrides: Record<string, any> = {}) {
  return {
    id: 'qna-1',
    workspace_id: 'ws-1',
    question: 'How do I reset my password?',
    answer: 'Go to settings and click reset password.',
    locale: 'en',
    enabled: true,
    ...overrides,
  };
}

export function makeKbArticleRow(overrides: Record<string, any> = {}) {
  return {
    id: 'kb-1',
    workspace_id: 'ws-1',
    slug: 'reset-password',
    locale: 'en',
    title: 'How to reset your password',
    excerpt: 'Steps to reset your password.',
    content: 'Go to account settings and click "reset password" to receive a reset link.',
    status: 'published',
    used_by_ai: true,
    ...overrides,
  };
}

/** ai_knowledge_chunks — covers business_profile, learned_qna, web_page, file source types. */
export function makeChunkRow(overrides: Record<string, any> = {}) {
  return {
    id: 'chunk-1',
    workspace_id: 'ws-1',
    source_type: 'file',
    source_id: 'file-1',
    status: 'active',
    title: 'Refund policy',
    content: 'Refunds are processed within 5 business days of the request.',
    locale: 'en',
    source_url: null,
    metadata: {},
    embedding: null,
    ...overrides,
  };
}

export function makeDataSourceRow(overrides: Record<string, any> = {}) {
  return {
    id: 'source-1',
    workspace_id: 'ws-1',
    source_type: 'file',
    status: 'active',
    ...overrides,
  };
}

export function makeLearningCandidateRow(overrides: Record<string, any> = {}) {
  return {
    id: 'candidate-1',
    workspace_id: 'ws-1',
    status: 'approved',
    ...overrides,
  };
}

export function makeRetrievalTables(overrides: Record<string, any[]> = {}) {
  return {
    ai_agent_qna: [],
    knowledge_base_articles: [],
    ai_knowledge_chunks: [],
    ai_data_sources: [],
    ai_agent_learning_candidates: [],
    ...overrides,
  };
}
