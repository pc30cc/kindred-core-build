/**
 * FINAL PRODUCTION READINESS — conversation continuity smoke tests
 * (E2 follow-up, E3 clarification continuity, E4 topic switch,
 *  E10 two-tenant isolation).
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

const { buildRetrievalQuery } = await import('../../../server/services/ai-agent/queryBuilder.js');
const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;

function seed(messages: Array<{ id: string; conversation_id: string; sender_type: string; body: string; metadata?: any }>) {
  store = {
    conversations: [
      { id: 'conv-a', workspace_id: 'ws-1' },
      { id: 'conv-b', workspace_id: 'ws-2' },
    ],
    conversation_messages: messages.map((m, i) => ({
      metadata: {},
      created_at: `2026-01-01T00:0${i}:00Z`,
      ...m,
    })),
  };
}

beforeEach(() => { store = {}; });

describe('E2 — multi-turn follow-up', () => {
  it('keeps the Pro-plan topic when the visitor asks a pronoun follow-up', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: 'What does the Pro plan include?' },
      { id: 'm2', conversation_id: 'conv-a', sender_type: 'ai', body: 'The Pro plan includes these features.' },
    ]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-a',
      currentMessage: 'Does that include API access?',
    });
    expect(built.followUpDetected).toBe(true);
    expect(built.retrievalQuery.toLowerCase()).toContain('api access');
    expect(built.retrievalQuery.toLowerCase()).toContain('pro plan');
  });
});

describe('E3 — clarification continuity', () => {
  it('retrieval keeps the original problem plus the clarification answer', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: "My subscription isn't working." },
      {
        id: 'm2', conversation_id: 'conv-a', sender_type: 'ai',
        body: 'Is the problem payment or account access?',
        metadata: { ai_agent: { decision_type: 'ask_clarifying_question' } },
      },
    ]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-a',
      currentMessage: 'Account access.',
    });
    const q = built.retrievalQuery.toLowerCase();
    expect(q).toContain('account access');
    expect(q).toContain('subscription');
  });
});

describe('E4 — topic switch', () => {
  it('a new standalone question does not inherit the refund topic', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-a', sender_type: 'visitor', body: 'How do refunds work?' },
      { id: 'm2', conversation_id: 'conv-a', sender_type: 'ai', body: 'Refunds are processed in 5 days.' },
    ]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-a',
      currentMessage: 'What is API access?',
    });
    expect(built.followUpDetected).toBe(false);
    expect(built.retrievalQuery.toLowerCase()).not.toContain('refund');
  });
});

describe('E10 — two tenants', () => {
  it('workspace A never sees workspace B conversation context', async () => {
    seed([
      { id: 'm1', conversation_id: 'conv-b', sender_type: 'visitor', body: 'tenant two secret pricing' },
    ]);
    const built = await buildRetrievalQuery({
      config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-b',
      currentMessage: 'what about that?',
    });
    expect(built.conversationContext).toBe('');
    expect(built.retrievalQuery.toLowerCase()).not.toContain('tenant two');
  });
});
