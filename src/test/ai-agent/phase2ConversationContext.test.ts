/**
 * Phase 2.1 / 2.2 / 2.3 / 2.9 — multi-turn conversation context, clarification
 * continuity, deterministic retrieval-query rewriting and tenant isolation.
 *
 * Only the Supabase boundary is faked; conversationContext.ts and
 * queryBuilder.ts run for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, any>;
let store: Record<string, Row[]> = {};

function makeSb() {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let orderCol: string | null = null;
    let ascending = true;
    let lim = Infinity;
    const rows = () => {
      let out = (store[table] || []).filter((r) => filters.every((f) => f(r)));
      if (orderCol) {
        out = out.slice().sort((a, b) => String(a[orderCol!]).localeCompare(String(b[orderCol!])));
        if (!ascending) out.reverse();
      }
      return out.slice(0, lim);
    };
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => { filters.push((r) => r?.[col] === val); return builder; },
      order: (col: string, o: any) => { orderCol = col; ascending = o?.ascending !== false; return builder; },
      limit: (n: number) => { lim = n; return builder; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: rows(), error: null }),
    };
    return builder;
  }
  return { from };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => makeSb() }));

const { loadConversationContext, formatConversationContext } =
  await import('../../../server/services/ai-agent/conversationContext.js');
const { buildRetrievalQuery } = await import('../../../server/services/ai-agent/queryBuilder.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;

function seed(messages: Array<{ id: string; conversation_id: string; sender_type: string; body: string; metadata?: any }>) {
  store = {
    conversations: [
      { id: 'conv-a', workspace_id: 'ws-1' },
      { id: 'conv-b', workspace_id: 'ws-1' },
      { id: 'conv-other', workspace_id: 'ws-2' },
    ],
    conversation_messages: messages.map((m, i) => ({
      metadata: {},
      created_at: `2026-01-01T00:0${i}:00Z`,
      ...m,
    })),
  };
}

beforeEach(() => { store = {}; });

describe('2.1 — bounded conversation context', () => {
  it('keeps newest turns and labels roles', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: 'How much is the Pro plan?' },
      { id: 'm2', conversation_id: 'conv-a', sender_type: 'ai', body: 'The Pro plan is described here.' },
      { id: 'm3', conversation_id: 'conv-a', sender_type: 'visitor', body: 'Does that include API access?' },
    ]);
    const ctx = await loadConversationContext(CONFIG, { workspaceId: 'ws-1', conversationId: 'conv-a' });
    expect(ctx.used).toBe(true);
    expect(ctx.text.startsWith('RECENT CONVERSATION:')).toBe(true);
    expect(ctx.text).toContain('Visitor: How much is the Pro plan?');
    expect(ctx.text).toContain('Assistant: The Pro plan is described here.');
    expect(ctx.turnsUsed).toBe(3);
  });

  it('is bounded by turn count and characters', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: 'visitor' as const, text: `message ${i}` }));
    const out = formatConversationContext(turns, { maxTurns: 3, maxChars: 1000 });
    expect(out.turnsUsed).toBe(3);
    expect(out.text).toContain('message 19');
    expect(out.text).not.toContain('message 5');

    const long = formatConversationContext(
      [{ role: 'visitor', text: 'a'.repeat(200) }, { role: 'visitor', text: 'b'.repeat(200) }],
      { maxTurns: 10, maxChars: 250, maxCharsPerTurn: 300 },
    );
    expect(long.turnsUsed).toBe(1);
    expect(long.charCount).toBeLessThanOrEqual(250);
  });
});

describe('2.9 — tenant / conversation isolation', () => {
  it('never returns another conversation context', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: 'secret A topic' },
      { id: 'm2', conversation_id: 'conv-b', sender_type: 'visitor', body: 'unrelated B topic' },
    ]);
    const ctx = await loadConversationContext(CONFIG, { workspaceId: 'ws-1', conversationId: 'conv-b' });
    expect(ctx.text).toContain('unrelated B topic');
    expect(ctx.text).not.toContain('secret A topic');
  });

  it('refuses a conversation belonging to another workspace', async () => {
    seed([{ id: 'm1', conversation_id: 'conv-other', sender_type: 'visitor', body: 'tenant two data' }]);
    const ctx = await loadConversationContext(CONFIG, { workspaceId: 'ws-1', conversationId: 'conv-other' });
    expect(ctx.used).toBe(false);
    expect(ctx.tenantMismatch).toBe(true);
    expect(ctx.text).toBe('');
  });

  it('requires explicit identifiers', async () => {
    seed([{ id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: 'x' }]);
    expect((await loadConversationContext(CONFIG, { workspaceId: '', conversationId: 'conv-a' })).used).toBe(false);
    expect((await loadConversationContext(CONFIG, { workspaceId: 'ws-1', conversationId: '' })).used).toBe(false);
  });

  it('query builder does not leak cross-workspace context', async () => {
    seed([{ id: 'm1', conversation_id: 'conv-other', sender_type: 'visitor', body: 'tenant two pricing' }]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-other',
      currentMessage: 'what about that?',
    });
    expect(built.conversationContext).toBe('');
    expect(built.retrievalQuery).not.toContain('tenant two');
  });
});

describe('2.3 — contextual retrieval query rewriting', () => {
  it('resolves a pronoun follow-up using the previous visitor turn', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: 'How much is the Pro plan?' },
      { id: 'm2', conversation_id: 'conv-a', sender_type: 'ai', body: 'Here is the plan overview.' },
      { id: 'm3', conversation_id: 'conv-a', sender_type: 'visitor', body: 'Does that include API access?' },
    ]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-a',
      currentMessage: 'Does that include API access?',
    });
    expect(built.followUpDetected).toBe(true);
    expect(built.rewriteReason).toBe('referential_followup');
    expect(built.retrievalQuery.toLowerCase()).toContain('pro plan');
    expect(built.retrievalQuery.toLowerCase()).toContain('api access');
  });

  it('resolves a numeric-constraint follow-up', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: 'What plans support multiple agents?' },
      { id: 'm2', conversation_id: 'conv-a', sender_type: 'ai', body: 'Several plans do.' },
      { id: 'm3', conversation_id: 'conv-a', sender_type: 'visitor', body: 'What about 10 agents?' },
    ]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-a',
      currentMessage: 'What about 10 agents?',
    });
    expect(built.retrievalQuery.toLowerCase()).toContain('plans support multiple agents');
    expect(built.retrievalQuery).toContain('10 agents');
  });

  it('does not let an old topic dominate a self-contained new question', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: 'How do refunds work for annual billing?' },
      { id: 'm2', conversation_id: 'conv-a', sender_type: 'ai', body: 'Refund overview.' },
      { id: 'm3', conversation_id: 'conv-a', sender_type: 'visitor', body: 'Which integrations do you offer for Slack and Salesforce workflows?' },
    ]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-a',
      currentMessage: 'Which integrations do you offer for Slack and Salesforce workflows?',
    });
    expect(built.rewriteReason).toBe('none');
    expect(built.followUpDetected).toBe(false);
    expect(built.retrievalQuery.toLowerCase()).not.toContain('refunds work for annual');
  });
});

describe('2.2 — clarification follow-up continuity', () => {
  it('combines original intent and clarification answer for retrieval', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: "My subscription isn't working." },
      {
        id: 'm2', conversation_id: 'conv-a', sender_type: 'ai',
        body: 'Are you having trouble with payment or accessing the account?',
        metadata: { answer_strategy: { decision_type: 'ask_clarifying_question' } },
      },
      { id: 'm3', conversation_id: 'conv-a', sender_type: 'visitor', body: 'Accessing the account.' },
    ]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-a',
      currentMessage: 'Accessing the account.',
    });
    expect(built.previousAiAskedClarification).toBe(true);
    expect(built.rewriteReason).toBe('clarification_followup');
    expect(built.retrievalQuery.toLowerCase()).toContain('subscription');
    expect(built.retrievalQuery.toLowerCase()).toContain('accessing the account');
    expect(built.clarification.originalIntent).toBe("My subscription isn't working.");
    expect(built.clarification.question).toContain('payment or accessing');
    expect(built.clarification.followUpResponse).toBe('Accessing the account.');
  });
});