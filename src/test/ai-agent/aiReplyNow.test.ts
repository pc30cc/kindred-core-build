/**
 * Human Guidance UX — "AI Reply Now" acceptance suite.
 *
 * Drives the REAL production orchestration module
 * (server/services/ai-agent/replyNow.ts) with only the Supabase client and
 * the engine entry point faked, so the tests assert the actual contract:
 *
 *   - the run is anchored to the LATEST visitor message, never to guidance text
 *   - guidance is persisted BEFORE the engine runs (so the pipeline loads it
 *     through its normal path and owns consumption after delivery)
 *   - a human-owned / closed / silent conversation is refused with a precise
 *     reason and never starts a run
 *   - duplicate clicks collapse into a single generation
 *   - an operator-forced turn relaxes only the "don't speak unasked" guards
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONV = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OLD_MSG = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NEW_MSG = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OPERATOR = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const REQUEST = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const config = {} as any;

let conv: any;
let messages: any[];
let guidance: any[];
let requests: any[];
const order: string[] = [];
let guidanceInsertFails = false;

function makeSb() {
  const from = (name: string) => {
    const f: Record<string, any> = {};
    let mode: 'select' | 'update' = 'select';
    let patch: any = null;
    let inValues: any[] | null = null;
    let desc = false;

    const visitorRows = () => {
      let rows = messages.slice();
      if (inValues) rows = rows.filter((m) => inValues!.includes(m.sender_type));
      rows = rows.filter((m) =>
        Object.entries(f).every(([k, v]) => k.startsWith('__') || (m as any)[k] === v));
      rows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      if (desc) rows.reverse();
      return rows;
    };

    const guidanceRows = () =>
      guidance.filter((g) => Object.entries(f).every(([k, v]) => (g as any)[k] === v));

    const chain: any = {
      select: () => chain,
      eq: (col: string, val: any) => { f[col] = val; return chain; },
      in: (_col: string, vals: any[]) => { inValues = vals; return chain; },
      order: (_col: string, opts?: any) => { desc = opts?.ascending === false; return chain; },
      update: (p: any) => { mode = 'update'; patch = p; return chain; },
      insert: (row: any) => {
        order.push(`insert:${name}`);
        if (name === 'ai_agent_guidance') {
          if (guidanceInsertFails) {
            return {
              select: () => ({ single: async () => ({ data: null, error: { message: 'insert_failed' } }) }),
            };
          }
          const rec = { id: `g-${guidance.length + 1}`, use_count: 0, created_at: new Date().toISOString(), ...row };
          guidance.push(rec);
          return { select: () => ({ single: async () => ({ data: rec, error: null }) }) };
        }
        return { select: () => ({ single: async () => ({ data: null, error: null }) }) };
      },
      maybeSingle: async () => {
        if (name === 'conversations') {
          if (f.workspace_id && conv.workspace_id !== f.workspace_id) return { data: null, error: null };
          return { data: f.id === conv.id ? conv : null, error: null };
        }
        return { data: null, error: null };
      },
      limit: async () => {
        if (name === 'conversation_messages') return { data: visitorRows(), error: null };
        if (name === 'ai_agent_guidance') return { data: guidanceRows(), error: null };
        return { data: [], error: null };
      },
      then: (res: any, rej: any) => {
        if (mode === 'update') {
          order.push(`update:${name}`);
          if (name === 'ai_agent_guidance_requests') {
            for (const r of requests) {
              if (Object.entries(f).every(([k, v]) => (r as any)[k] === v)) Object.assign(r, patch);
            }
          }
          if (name === 'ai_agent_guidance') {
            for (const g of guidance) {
              if (Object.entries(f).every(([k, v]) => (g as any)[k] === v)) Object.assign(g, patch);
            }
          }
          return Promise.resolve({ error: null }).then(res, rej);
        }
        const data = name === 'ai_agent_guidance' ? guidanceRows() : [];
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return chain;
  };

  return { from, rpc: async () => ({ data: null, error: null }) };
}

let fakeSb: any;
const engineCalls: any[] = [];
let engineResult: any = { ran: true, action: 'replied', runId: 'run-1', messageId: 'm-1' };

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: async (_c: any, input: any) => {
    order.push('engine');
    engineCalls.push(input);
    return engineResult;
  },
}));

const rn = () => import('../../../server/services/ai-agent/replyNow.js');

beforeEach(async () => {
  conv = { id: CONV, workspace_id: WS, status: 'open', metadata: { ai_state: 'ai_managed' } };
  messages = [
    { id: OLD_MSG, conversation_id: CONV, sender_type: 'contact', body: 'first question', created_at: '2026-01-01T10:00:00.000Z' },
    { id: 'op-1', conversation_id: CONV, sender_type: 'agent', body: 'internal', created_at: '2026-01-01T10:01:00.000Z' },
    { id: NEW_MSG, conversation_id: CONV, sender_type: 'contact', body: 'and what about refunds?', created_at: '2026-01-01T10:02:00.000Z' },
  ];
  guidance = [];
  requests = [{ id: REQUEST, workspace_id: WS, conversation_id: CONV, status: 'pending' }];
  order.length = 0;
  engineCalls.length = 0;
  guidanceInsertFails = false;
  engineResult = { ran: true, action: 'replied', runId: 'run-1', messageId: 'm-1' };
  fakeSb = makeSb();
  (await rn()).__resetReplyNowIdempotency();
});

// ── A ────────────────────────────────────────────────────────────────
describe('A — AI Reply Now runs the real pipeline on the latest visitor message', () => {
  it('anchors to the newest visitor message and flags the turn as operator-forced', async () => {
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, {
      workspaceId: WS, conversationId: CONV, operatorId: OPERATOR,
      body: 'Refund window is 14 days.',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.visitorMessageId).toBe(NEW_MSG);
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0].visitorMessageId).toBe(NEW_MSG);
    expect(engineCalls[0].question).toBe('and what about refunds?');
    expect(engineCalls[0].operatorReplyNow).toBe(true);
    expect(engineCalls[0].operatorId).toBe(OPERATOR);
    // The guidance text is never used as the question / reply body.
    expect(engineCalls[0].question).not.toContain('Refund window');
  });

  it('persists guidance BEFORE the engine runs', async () => {
    const { replyNowWithGuidance } = await rn();
    await replyNowWithGuidance(config, {
      workspaceId: WS, conversationId: CONV, operatorId: OPERATOR, body: 'be brief',
    });
    expect(order.indexOf('insert:ai_agent_guidance')).toBeLessThan(order.indexOf('engine'));
    expect(guidance[0].status).toBe('active');
    expect(guidance[0].scope).toBe('next_turn');
    expect(guidance[0].kind).toBe('direction');
  });

  it('works with no guidance text at all (plain "answer now")', async () => {
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, {
      workspaceId: WS, conversationId: CONV, operatorId: OPERATOR,
    });
    expect(res.ok && res.guidance).toBeNull();
    expect(guidance).toHaveLength(0);
    expect(engineCalls).toHaveLength(1);
  });

  it('resolves the pending AI guidance request it answers', async () => {
    const { replyNowWithGuidance } = await rn();
    await replyNowWithGuidance(config, {
      workspaceId: WS, conversationId: CONV, operatorId: OPERATOR,
      body: '14 days', requestId: REQUEST,
    });
    expect(requests[0].status).toBe('resolved');
    expect(requests[0].resolved_by).toBe(OPERATOR);
  });
});

// ── B ────────────────────────────────────────────────────────────────
describe('B — ineligible conversations never start a run', () => {
  it('refuses when the visitor has never written', async () => {
    messages = [{ id: 'op-1', conversation_id: CONV, sender_type: 'agent', body: 'hi', created_at: '2026-01-01T10:00:00.000Z' }];
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, { workspaceId: WS, conversationId: CONV, operatorId: OPERATOR });
    expect(res).toMatchObject({ ok: false, reason: 'no_visitor_message' });
    expect(engineCalls).toHaveLength(0);
  });

  it('refuses after a human takeover', async () => {
    conv.metadata = { ai_state: 'human_active' };
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, { workspaceId: WS, conversationId: CONV, operatorId: OPERATOR, body: 'x' });
    expect(res).toMatchObject({ ok: false, reason: 'human_active' });
    expect(engineCalls).toHaveLength(0);
    expect(guidance).toHaveLength(0);
  });

  it('refuses on a closed conversation', async () => {
    conv.status = 'closed';
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, { workspaceId: WS, conversationId: CONV, operatorId: OPERATOR });
    expect(res).toMatchObject({ ok: false, reason: 'conversation_closed' });
    expect(engineCalls).toHaveLength(0);
  });

  it('refuses a conversation from another workspace', async () => {
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, {
      workspaceId: '99999999-9999-9999-9999-999999999999', conversationId: CONV, operatorId: OPERATOR,
    });
    expect(res).toMatchObject({ ok: false, reason: 'conversation_not_found' });
    expect(engineCalls).toHaveLength(0);
  });

  it('does not run the engine when guidance persistence fails', async () => {
    guidanceInsertFails = true;
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, {
      workspaceId: WS, conversationId: CONV, operatorId: OPERATOR, body: 'must persist first',
    });
    expect(res).toMatchObject({ ok: false, reason: 'guidance_create_failed' });
    expect(engineCalls).toHaveLength(0);
  });
});

// ── C ────────────────────────────────────────────────────────────────
describe('C — idempotency', () => {
  it('collapses duplicate clicks that share an idempotency key', async () => {
    const { replyNowWithGuidance } = await rn();
    const args = {
      workspaceId: WS, conversationId: CONV, operatorId: OPERATOR,
      body: 'answer politely', idempotencyKey: 'click-token-123',
    };
    const [a, b] = await Promise.all([
      replyNowWithGuidance(config, args),
      replyNowWithGuidance(config, args),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(engineCalls).toHaveLength(1);
    expect(guidance).toHaveLength(1);
    expect([a, b].filter((r) => r.ok && r.deduplicated)).toHaveLength(1);

    // A retry with the same key after settlement still does not re-answer.
    const c = await replyNowWithGuidance(config, args);
    expect(c.ok && c.deduplicated).toBe(true);
    expect(engineCalls).toHaveLength(1);
  });

  it('a different key is a genuinely new turn', async () => {
    const { replyNowWithGuidance } = await rn();
    await replyNowWithGuidance(config, { workspaceId: WS, conversationId: CONV, operatorId: OPERATOR, idempotencyKey: 'k1' });
    await replyNowWithGuidance(config, { workspaceId: WS, conversationId: CONV, operatorId: OPERATOR, idempotencyKey: 'k2' });
    expect(engineCalls).toHaveLength(2);
  });
});

// ── D ────────────────────────────────────────────────────────────────
describe('D — delivery outcomes are reported, never faked', () => {
  it('surfaces a suppressed (stale) generation instead of claiming a reply', async () => {
    engineResult = { ran: false, action: 'skipped', reason: 'stale_superseded_by_newer_visitor_message' };
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, { workspaceId: WS, conversationId: CONV, operatorId: OPERATOR, body: 'x' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.run.action).toBe('skipped');
    // Guidance stays ACTIVE — only the delivery stage may consume it.
    expect(guidance[0].status).toBe('active');
  });

  it('surfaces a handoff outcome', async () => {
    engineResult = { ran: true, action: 'handoff', runId: 'run-2' };
    const { replyNowWithGuidance } = await rn();
    const res = await replyNowWithGuidance(config, { workspaceId: WS, conversationId: CONV, operatorId: OPERATOR });
    expect(res.ok && res.run.action).toBe('handoff');
  });
});

// ── E ────────────────────────────────────────────────────────────────
describe('E — operator-forced runtime policy', () => {
  const base = {
    state: {
      aiRepliesCountInConversation: 0,
      aiRepliesInLastHour: 0,
      pendingHandoffRequested: false,
      hasHumanAgentReplied: false,
      aiState: 'ai_managed',
      managedByAi: true,
      humanTakeoverAt: null,
    } as any,
    availability: { state: 'online' } as any,
    visitorText: 'can I talk to a human please?',
  };
  const settings = (over: any = {}) => ({
    enabled: true,
    mode: 'suggest_only',
    handoff_on_human_request: true,
    handoff_keywords: ['human'],
    max_replies_per_hour: 5,
    max_replies_per_conversation: 3,
    ...over,
  }) as any;

  it('answers publicly even in suggest_only mode', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    const d = decideRuntime({ ...base, settings: settings(), operatorForcedReply: true });
    expect(d.action).toBe('auto_reply');
    expect(d.canAutoReply).toBe(true);
    expect(d.notes.operator_forced_reply).toBe(true);
  });

  it('ignores reply caps, hourly throttle and operators-online', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    const d = decideRuntime({
      ...base,
      state: { ...base.state, aiRepliesCountInConversation: 99, aiRepliesInLastHour: 99 },
      settings: settings({ mode: 'auto_reply_when_offline' }),
      operatorForcedReply: true,
    });
    expect(d.canAutoReply).toBe(true);
  });

  it('still refuses when a handoff is pending (ownership is never bypassed)', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    const d = decideRuntime({
      ...base,
      state: { ...base.state, pendingHandoffRequested: true },
      settings: settings(),
      operatorForcedReply: true,
    });
    expect(d.canAutoReply).toBe(false);
    expect(d.reason).toBe('pending_handoff');
  });


  it('still refuses when a human owns the conversation', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    const d = decideRuntime({
      ...base,
      state: { ...base.state, aiState: 'human_active' },
      settings: settings({ mode: 'auto_reply_always' }),
      operatorForcedReply: true,
    });
    expect(d.action).toBe('skip');
    expect(d.reason).toBe('human_already_joined');
  });

  it('still refuses when the agent is disabled or off', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    expect(decideRuntime({ ...base, settings: settings({ enabled: false }), operatorForcedReply: true }).action).toBe('skip');
    expect(decideRuntime({ ...base, settings: settings({ mode: 'off' }), operatorForcedReply: true }).action).toBe('skip');
  });

  it('leaves ordinary visitor-driven decisions completely unchanged', async () => {
    const { decideRuntime } = await import('../../../server/services/ai-agent/runtimePolicy.js');
    expect(decideRuntime({ ...base, settings: settings() }).action).toBe('handoff');
    expect(decideRuntime({
      ...base, visitorText: 'how much is shipping?', settings: settings(),
    }).action).toBe('suggest');
  });
});
