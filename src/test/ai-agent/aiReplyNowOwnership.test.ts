/**
 * AI Reply Now — blocker 1: canonical AI-ownership guard (backend).
 *
 * Frontend visibility is not an authorization invariant: the backend must
 * refuse "AI Reply Now" whenever the conversation is not canonically owned by
 * the AI, and must never start a generation in that case.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONV = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MSG = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OPERATOR = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const config = {} as any;

let conv: any;
const engineCalls: any[] = [];

function makeSb() {
  const from = (name: string) => {
    const f: Record<string, any> = {};
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: any) => { f[c] = v; return chain; },
      neq: () => chain,
      lt: () => chain,
      in: () => chain,
      order: () => chain,
      update: () => chain,
      insert: () => Promise.resolve({ error: null }),
      maybeSingle: async () => {
        if (name === 'conversations') {
          if (f.workspace_id && f.workspace_id !== conv.workspace_id) return { data: null, error: null };
          return { data: f.id === conv.id ? conv : null, error: null };
        }
        return { data: null, error: null };
      },
      limit: async () => {
        if (name === 'conversation_messages') {
          return {
            data: [{ id: MSG, conversation_id: CONV, sender_type: 'contact', body: 'hi?', created_at: '2026-01-01T10:00:00.000Z' }],
            error: null,
          };
        }
        return { data: [], error: null };
      },
      then: (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej),
    };
    return chain;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

let fakeSb: any = makeSb();
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: async (_c: any, input: any) => {
    engineCalls.push(input);
    return { ran: true, action: 'replied', runId: 'run-1', messageId: 'm-1' };
  },
}));

const rn = () => import('../../../server/services/ai-agent/replyNow.js');

beforeEach(() => {
  conv = { id: CONV, workspace_id: WS, status: 'open', metadata: { ai_state: 'ai_managed' } };
  engineCalls.length = 0;
  fakeSb = makeSb();
});

async function attempt() {
  const { replyNowWithGuidance } = await rn();
  return replyNowWithGuidance(config, { workspaceId: WS, conversationId: CONV, operatorId: OPERATOR });
}

describe('AI Reply Now — canonical AI ownership guard', () => {
  it('allows ai_managed', async () => {
    const res = await attempt();
    expect(res.ok).toBe(true);
    expect(engineCalls).toHaveLength(1);
  });

  it('blocks needs_human with zero generation', async () => {
    conv.metadata = { ai_state: 'needs_human' };
    const res: any = await attempt();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('handoff_in_progress');
    expect(engineCalls).toHaveLength(0);
  });

  it('blocks human_assigned', async () => {
    conv.metadata = { ai_state: 'human_assigned' };
    const res: any = await attempt();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('human_active');
    expect(engineCalls).toHaveLength(0);
  });

  it('blocks human_active', async () => {
    conv.metadata = { ai_state: 'human_active' };
    const res: any = await attempt();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('human_active');
    expect(engineCalls).toHaveLength(0);
  });

  it('blocks human_takeover_at even when the state still says ai_managed', async () => {
    conv.metadata = { ai_state: 'ai_managed', human_takeover_at: '2026-01-01T11:00:00.000Z' };
    const res: any = await attempt();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('human_active');
    expect(engineCalls).toHaveLength(0);
  });

  it('blocks an active ai_handoff_requested flag', async () => {
    conv.metadata = { ai_state: 'ai_managed', ai_handoff_requested: true };
    const res: any = await attempt();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('handoff_in_progress');
    expect(engineCalls).toHaveLength(0);
  });

  it('blocks conversations that were never AI-managed', async () => {
    conv.metadata = {};
    const res: any = await attempt();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not_ai_managed');
    expect(engineCalls).toHaveLength(0);
  });

  it('allows again after the canonical transition back to ai_managed', async () => {
    conv.metadata = { ai_state: 'needs_human', ai_handoff_requested: true };
    expect((await attempt()).ok).toBe(false);
    conv.metadata = { ai_state: 'ai_managed', ai_handoff_requested: false, managed_by_ai: true };
    const res = await attempt();
    expect(res.ok).toBe(true);
    expect(engineCalls).toHaveLength(1);
  });

  it('refuses a stale request issued after a handoff started', async () => {
    // Frontend rendered "Guide AI" before the handoff, request arrives after.
    conv.metadata = { ai_state: 'ai_managed' };
    conv.metadata = { ai_state: 'needs_human' };
    const res: any = await attempt();
    expect(res.ok).toBe(false);
    expect(engineCalls).toHaveLength(0);
  });
});

describe('runtime policy — operator-forced turn never bypasses ownership', () => {
  const settings: any = {
    enabled: true, mode: 'auto_reply_always', handoff_keywords: [],
    max_replies_per_hour: 0, max_replies_per_conversation: 3,
  };
  const availability: any = { state: 'online' };
  const baseState: any = {
    aiState: 'ai_managed', pendingHandoffRequested: false, humanTakeoverAt: null,
    hasHumanAgentReplied: false, aiRepliesCountInConversation: 99, aiRepliesInLastHour: 99,
    managedByAi: true,
  };

  it('relaxes reply caps and throttles for an ai_managed conversation', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    const d = decideRuntime({ settings, state: baseState, availability, visitorText: 'hi', operatorForcedReply: true });
    expect(d.action).toBe('auto_reply');
  });

  it('does not bypass a pending handoff', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    const d = decideRuntime({
      settings, availability, visitorText: 'hi', operatorForcedReply: true,
      state: { ...baseState, pendingHandoffRequested: true },
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('pending_handoff');
  });

  it('does not bypass needs_human / human_assigned / takeover', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    for (const patch of [
      { aiState: 'needs_human' },
      { aiState: 'human_assigned' },
      { humanTakeoverAt: '2026-01-01T00:00:00.000Z' },
      { aiState: 'human_active' },
    ]) {
      const d = decideRuntime({
        settings, availability, visitorText: 'hi', operatorForcedReply: true,
        state: { ...baseState, ...patch } as any,
      });
      expect(d.action).toBe('skip');
    }
  });
});
