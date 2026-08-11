/**
 * Phase 1 characterization tests — shared fixture builders for AI Agent
 * engine tests.
 *
 * IMPORTANT: this file must never call `vi.mock()` itself. It only exports
 * plain factory functions that produce default data shapes matching the
 * real interfaces in server/services/ai-agent/*. Each test file wires its
 * own `vi.mock()` calls (per this repo's existing convention, see
 * src/test/security/aiCreditOrdering.test.ts) and may use these factories
 * inside its mock implementations.
 */

export function makeSettings(overrides: Record<string, any> = {}) {
  return {
    id: 'settings-1',
    workspace_id: 'ws-1',
    enabled: true,
    agent_name: 'AI Assistant',
    agent_logo_url: null,
    business_description: null,
    answer_guidance: 'balanced',
    mode: 'auto_reply_always',
    answer_only_from_kb: false,
    welcome_message: null,
    fallback_message: "I'm not sure about that yet. I'll connect you with a human agent.",
    handoff_keywords: ['human', 'agent', 'operator'],
    max_replies_per_conversation: 3,
    max_replies_per_hour: 20,
    allowed_locales: ['en'],
    show_sources_to_operator: true,
    show_sources_to_visitor: false,
    handoff_on_low_confidence: true,
    handoff_on_human_request: true,
    handoff_when_no_kb_match: true,
    confidence_threshold: 0.55,
    instructions: {},
    metadata: {},
    ai_intro_enabled: true,
    intro_message: null,
    intro_message_localized: {},
    handoff_message_localized: {},
    handoff_prechat_message_localized: {},
    fallback_behavior: 'handoff',
    stop_on_handoff: true,
    pause_auto_reply_after_human_reply: true,
    allow_suggestions_after_takeover: true,
    keep_in_automated_until_handoff: true,
    escalation_style: 'balanced',
    allow_clarifying_questions: true,
    max_clarification_attempts: 1,
    allow_answer_with_caveat: true,
    learning_enabled: true,
    auto_create_learning_candidates: true,
    require_approval_for_learning: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeConversationState(overrides: Record<string, any> = {}) {
  return {
    exists: true,
    status: 'open',
    assignedTo: null,
    hasHumanAgentReplied: false,
    isAssignedToHuman: false,
    lastHumanReplyAt: null,
    lastVisitorMessageAt: '2026-01-01T00:00:00.000Z',
    aiRepliesCountInConversation: 0,
    aiRepliesInLastHour: 0,
    pendingHandoffRequested: false,
    aiState: null,
    managedByAi: false,
    humanTakeoverAt: null,
    _metadata: {},
    ...overrides,
  };
}

export function makeAvailability(overrides: Record<string, any> = {}) {
  return {
    state: 'online',
    reason: 'operators_online',
    source: 'widget_resolver',
    ...overrides,
  };
}

export function makeHybridResult(overrides: Record<string, any> = {}) {
  return {
    sources: [],
    vectorUsed: true,
    keywordUsed: true,
    hybridUsed: true,
    fallbackReason: undefined,
    embeddingProvider: 'openai',
    embeddingModel: 'text-embedding-3-small',
    retrievalResultsCount: 0,
    topics: [],
    pageContextDebug: undefined,
    excludedSummary: undefined,
    retrievalDebug: undefined,
    ...overrides,
  };
}

export function makeHybridSource(overrides: Record<string, any> = {}) {
  return {
    id: 'chunk-1',
    kind: 'kb_article',
    source_type: 'kb_article',
    source_id: 'kb-1',
    title: 'How to reset your password',
    content: 'Go to settings and click reset password.',
    excerpt: 'Go to settings and click reset password.',
    locale: 'en',
    source_url: null,
    slug: 'reset-password',
    score: 0.9,
    keyword_score: 0.9,
    vector_score: 0.9,
    final_score: 0.9,
    topic_boost: 0,
    url_boost: 0,
    locale_bonus: 0,
    source_priority: 0.85,
    metadata: {},
    ...overrides,
  };
}

export function makeRetrievedSource(overrides: Record<string, any> = {}) {
  return {
    kind: 'kb_article',
    id: 'kb-legacy-1',
    title: 'Legacy KB match',
    excerpt: 'Legacy keyword match content.',
    content: 'Legacy keyword match content.',
    slug: 'legacy-kb-match',
    locale: 'en',
    score: 0.6,
    ...overrides,
  };
}

export function makeAIResponse(overrides: Record<string, any> = {}) {
  return {
    text: 'Here is the answer to your question.',
    model: 'gpt-4o-mini',
    provider: 'openai',
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    latencyMs: 250,
    ...overrides,
  };
}

export function makeStrategyDecision(overrides: Record<string, any> = {}) {
  return {
    decisionType: 'answer',
    reason: 'strong_match',
    retrievalStrength: 'strong',
    topScore: 0.9,
    confidence: 0.9,
    sourceTypesUsed: ['kb_article'],
    handoffRequired: false,
    ...overrides,
  };
}

export function makeBuiltQuery(overrides: Record<string, any> = {}) {
  return {
    retrievalQuery: 'how do I reset my password',
    expandedQuery: 'how do I reset my password',
    originalMessage: 'how do I reset my password',
    contextMessagesUsed: 0,
    topics: [],
    addedTerms: [],
    followUpDetected: false,
    previousAiAskedClarification: false,
    ...overrides,
  };
}

export const DEFAULT_WORKSPACE_ID = 'ws-1';
export const DEFAULT_CONVERSATION_ID = 'conv-1';
export const DEFAULT_VISITOR_MESSAGE_ID = 'vmsg-1';

/**
 * Minimal, honest fake Supabase client for the handful of direct `sb.from()`
 * calls engine.ts itself makes (workspace locale lookup, suggestion dedupe
 * check/insert, prechat settings lookup for offline handoff copy). Only
 * supports the operations actually used by those call sites — not a general
 * Supabase replacement. Tables not seeded return empty results rather than
 * throwing, matching real Supabase behavior for a missing row.
 */
export function makeFakeSupabase(seed: Record<string, any[]> = {}) {
  const store: Record<string, any[]> = { ...seed };
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let mode: 'select' | 'insert' | 'update' = 'select';
    let insertedRow: any = null;
    let updatePatch: any = null;
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => {
        filters.push((r) => r?.[col] === val);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      // No-op passthrough, same as limit()/order() above -- this fake does
      // not paginate, it always returns the full filtered set. Callers that
      // loop on `.range(from, from + PAGE - 1)` until a short page is seen
      // (e.g. sourceHealth.ts) terminate correctly after one iteration
      // against small test fixtures, since the "full set" IS the short page.
      range: () => builder,
      in: (col: string, vals: any[]) => {
        filters.push((r) => vals.includes(r?.[col]));
        return builder;
      },
      not: (col: string, op: string, val: any) => {
        if (op === 'is' && val === null) {
          filters.push((r) => r?.[col] !== null && r?.[col] !== undefined);
        }
        return builder;
      },
      insert: (payload: any) => {
        mode = 'insert';
        const row = { id: `${table}-${(store[table]?.length || 0) + 1}`, ...payload };
        store[table] = [...(store[table] || []), row];
        insertedRow = row;
        return builder;
      },
      update: (patch: any) => {
        mode = 'update';
        updatePatch = patch;
        return builder;
      },
      maybeSingle: async () => {
        if (mode === 'insert') return { data: insertedRow, error: null };
        if (mode === 'update') {
          const rows = store[table] || [];
          const target = rows.find((r) => filters.every((f) => f(r)));
          if (target) Object.assign(target, updatePatch);
          return { data: target ?? null, error: null };
        }
        const rows = store[table] || [];
        const found = rows.find((r) => filters.every((f) => f(r))) ?? null;
        return { data: found, error: null };
      },
      single: async () => {
        if (mode === 'insert') return { data: insertedRow, error: null };
        const rows = store[table] || [];
        const found = rows.find((r) => filters.every((f) => f(r))) ?? null;
        if (!found) return { data: null, error: { message: `${table}: not found` } };
        return { data: found, error: null };
      },
      then: (resolve: any) => {
        // Support bare `await sb.from(t).select().eq(...)` (list form, no
        // maybeSingle/single) — used rarely by direct engine.ts callers.
        if (mode === 'update') {
          const rows = store[table] || [];
          for (const r of rows) if (filters.every((f) => f(r))) Object.assign(r, updatePatch);
          return resolve({ data: rows, error: null });
        }
        const rows = store[table] || [];
        const found = rows.filter((r) => filters.every((f) => f(r)));
        return resolve({ data: found, error: null });
      },
    };
    return builder;
  }
  return {
    from,
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('not used') }) },
    rpc: async () => ({ data: null, error: null }),
    __store: store,
  };
}
