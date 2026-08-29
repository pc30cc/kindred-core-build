/**
 * Support Intelligence vNext — production blocker regression suite.
 *
 * Pins the four behavioural invariants that the vNext review flagged:
 *   1. handoff ordering — commit(needs_human) → visitor ack → operator routing
 *   2. freshness invalidates a pending/actual handoff before delivery
 *   3. working memory persistence is compare-and-swap, never a lost update
 *   4. the prompt ranks operator guidance as trusted evidence (no contradiction)
 *
 * Everything here drives the REAL service modules; only the Supabase client
 * and the routing side effect are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const routeCalls: string[] = [];
const order: string[] = [];
let convRow: any = null;
let rpcHandler: (fn: string, args: any) => { data: any; error: any } = () => ({ data: null, error: null });
let messagesAfterAnchor: any[] = [];

function makeSb() {
  const table = (name: string) => {
    const state: any = { name, filters: {} as Record<string, any> };
    const chain: any = {
      select: () => chain,
      eq: (col: string, val: any) => { state.filters[col] = val; return chain; },
      gt: () => chain,
      order: () => chain,
      limit: async () => ({ data: messagesAfterAnchor, error: null }),
      maybeSingle: async () => {
        if (name === 'conversation_messages') {
          return { data: { id: state.filters.id, created_at: '2026-01-01T00:00:00.000Z' }, error: null };
        }
        return { data: convRow, error: null };
      },
      update: (patch: any) => {
        order.push(`update:${name}`);
        convRow = { ...(convRow || {}), ...patch };
        return { eq: () => ({ eq: async () => ({ error: null }), then: undefined }) } as any;
      },
    };
    return chain;
  };
  return {
    from: table,
    rpc: async (fn: string, args: any) => {
      order.push(`rpc:${fn}`);
      return rpcHandler(fn, args);
    },
  };
}

let fakeSb: any;

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: vi.fn(async () => {}),
}));
vi.mock('../../../server/services/chatRouting.js', () => ({
  routeConversationToOperator: async (_c: any, a: any) => {
    order.push('route');
    routeCalls.push(a.conversationId);
    return { ok: true };
  },
}));

const config = {} as any;
const WS = '11111111-1111-1111-1111-111111111111';
const CONV = '22222222-2222-2222-2222-222222222222';
const MSG = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
  routeCalls.length = 0;
  order.length = 0;
  messagesAfterAnchor = [];
  convRow = { id: CONV, workspace_id: WS, status: 'open', metadata: {} };
  rpcHandler = () => ({ data: true, error: null });
  fakeSb = makeSb();
});

describe('blocker 1 — handoff ordering', () => {
  it('commitNeedsHuman persists needs_human without routing', async () => {
    const { commitNeedsHuman } = await import('../../../server/services/ai-agent/handoffState.js');
    const commit = await commitNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'human_request' });
    expect(commit.ok).toBe(true);
    expect(routeCalls).toHaveLength(0);
    expect(order.some((o) => o.startsWith('rpc:patch_conversation_metadata'))).toBe(true);
  });

  it('routeAfterHandoff runs only after a successful commit', async () => {
    const { routeAfterHandoff } = await import('../../../server/services/ai-agent/handoffState.js');
    await routeAfterHandoff(config, { workspaceId: WS, conversationId: CONV, commit: { ok: false, routingDeferred: false } });
    expect(routeCalls).toHaveLength(0);
    await routeAfterHandoff(config, { workspaceId: WS, conversationId: CONV, commit: { ok: true, routingDeferred: false } });
    expect(routeCalls).toEqual([CONV]);
  });

  it('routeAfterHandoff stays deferred for pre-chat', async () => {
    const { routeAfterHandoff } = await import('../../../server/services/ai-agent/handoffState.js');
    await routeAfterHandoff(config, { workspaceId: WS, conversationId: CONV, commit: { ok: true, routingDeferred: true } });
    expect(routeCalls).toHaveLength(0);
  });

  it('markNeedsHuman commits strictly before it routes', async () => {
    const { markNeedsHuman } = await import('../../../server/services/ai-agent/handoffState.js');
    await markNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'low_confidence' });
    const commitIdx = order.findIndex((o) => o === 'rpc:patch_conversation_metadata');
    const routeIdx = order.indexOf('route');
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(routeIdx).toBeGreaterThan(commitIdx);
  });

  it('no routing happens when the durable commit fails', async () => {
    rpcHandler = () => ({ data: null, error: { message: 'boom' } });
    // Fallback path also fails: simulate an update that never lands.
    convRow = null;
    const { markNeedsHuman } = await import('../../../server/services/ai-agent/handoffState.js');
    const commit = await markNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'human_request' });
    expect(commit.ok).toBe(false);
    expect(routeCalls).toHaveLength(0);
  });
});

describe('blocker 2 — freshness invalidates handoff', () => {
  it('is stale when a handoff was requested', async () => {
    convRow = { status: 'open', metadata: { ai_handoff_requested: true } };
    const { checkGenerationFreshness } = await import('../../../server/services/ai-agent/freshness.js');
    const v = await checkGenerationFreshness(config, {
      workspaceId: WS, conversationId: CONV, visitorMessageId: MSG, checkpoint: 'pre_delivery',
    });
    expect(v.fresh).toBe(false);
    expect(v.reason).toBe('handoff_in_progress');
  });

  it('is stale when the conversation is already needs_human', async () => {
    convRow = { status: 'open', metadata: { ai_state: 'needs_human' } };
    const { checkGenerationFreshness } = await import('../../../server/services/ai-agent/freshness.js');
    const v = await checkGenerationFreshness(config, {
      workspaceId: WS, conversationId: CONV, visitorMessageId: MSG, checkpoint: 'post_generation',
    });
    expect(v.fresh).toBe(false);
    expect(v.reason).toBe('handoff_in_progress');
  });

  it('human takeover still outranks handoff detection', async () => {
    convRow = { status: 'open', metadata: { ai_state: 'human_active', ai_handoff_requested: true } };
    const { checkGenerationFreshness } = await import('../../../server/services/ai-agent/freshness.js');
    const v = await checkGenerationFreshness(config, {
      workspaceId: WS, conversationId: CONV, visitorMessageId: MSG, checkpoint: 'pre_delivery',
    });
    expect(v.reason).toBe('human_takeover');
    expect(v.humanTakeoverDetected).toBe(true);
  });

  it('is fresh on a clean AI-managed conversation', async () => {
    convRow = { status: 'open', metadata: { ai_state: 'ai_managed' } };
    const { checkGenerationFreshness } = await import('../../../server/services/ai-agent/freshness.js');
    const v = await checkGenerationFreshness(config, {
      workspaceId: WS, conversationId: CONV, visitorMessageId: MSG, checkpoint: 'pre_generation',
    });
    expect(v.fresh).toBe(true);
    expect(v.reason).toBeNull();
  });

  it('a newer visitor message supersedes the run', async () => {
    messagesAfterAnchor = [{ id: 'newer', sender_type: 'contact', created_at: '2026-01-01T00:01:00.000Z', metadata: {} }];
    const { checkGenerationFreshness } = await import('../../../server/services/ai-agent/freshness.js');
    const v = await checkGenerationFreshness(config, {
      workspaceId: WS, conversationId: CONV, visitorMessageId: MSG, checkpoint: 'pre_delivery',
    });
    expect(v.fresh).toBe(false);
    expect(v.reason).toBe('superseded_by_newer_visitor_message');
  });
});

describe('blocker 3 — working memory compare-and-swap', () => {
  it('retries on a rev conflict and rebases onto the winner', async () => {
    let calls = 0;
    rpcHandler = (fn) => {
      if (fn !== 'patch_conversation_ai_memory') return { data: true, error: null };
      calls++;
      if (calls === 1) {
        return { data: { conflict: true, rev: 7, memory: { rev: 7, issue_summary: 'written by the other turn' } }, error: null };
      }
      return { data: { conflict: false, rev: 8 }, error: null };
    };
    const { persistWorkingMemory } = await import('../../../server/services/ai-agent/workingMemory.js');
    const next = await persistWorkingMemory(config, {
      workspaceId: WS, conversationId: CONV, patch: { issueSummary: 'mine' },
    });
    expect(calls).toBe(2);
    expect(next).not.toBeNull();
  });

  it('never issues a whole-metadata overwrite while the RPC works', async () => {
    rpcHandler = (fn) => (fn === 'patch_conversation_ai_memory'
      ? { data: { conflict: false, rev: 1 }, error: null }
      : { data: true, error: null });
    const { persistWorkingMemory } = await import('../../../server/services/ai-agent/workingMemory.js');
    await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { issueSummary: 'x' } });
    expect(order.filter((o) => o === 'update:conversations')).toHaveLength(0);
  });

  it('falls back to a scoped write on pre-057 deployments', async () => {
    rpcHandler = (fn) => (fn === 'patch_conversation_ai_memory'
      ? { data: null, error: { message: 'function does not exist' } }
      : { data: true, error: null });
    const { persistWorkingMemory } = await import('../../../server/services/ai-agent/workingMemory.js');
    const next = await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { issueSummary: 'x' } });
    expect(next).not.toBeNull();
    expect(order).toContain('update:conversations');
  });
});

describe('blocker 4 — prompt instruction hierarchy has no contradiction', () => {
  async function build(overrides: Record<string, any> = {}) {
    const { buildSystemPrompt } = await import('../../../server/services/ai-agent/prompt.js');
    const { makeSettings } = await import('./helpers/engineFixtures.js');
    return buildSystemPrompt(makeSettings(overrides), 'en', {
      operatorGuidanceBlock: 'FACT: refunds take 3 working days.',
    } as any);
  }

  it('names operator guidance as trusted evidence', async () => {
    const p = await build();
    expect(p).toMatch(/OPERATOR GUIDANCE/);
    expect(p).toMatch(/trusted evidence/i);
  });

  it('does not restrict business facts to sources and tools alone', async () => {
    const p = await build();
    expect(p).not.toMatch(/may ONLY be stated when the SOURCES block or TOOL RESULTS/);
  });

  it('strict mode still admits operator guidance as grounding', async () => {
    const p = await build({ answer_only_from_kb: true });
    expect(p).toMatch(/Strict mode is ON/);
    expect(p).toMatch(/sources, tool results, operator guidance/i);
  });

  it('keeps guidance private from the visitor', async () => {
    const p = await build();
    expect(p).toMatch(/never say that it came from an operator/i);
  });
});
