/**
 * P0 — runLimitHandoff() must be COMMIT-FIRST.
 *
 * The dedupe marker is only allowed to exist once the durable needs_human
 * transition persisted. These tests drive the real orchestration with a
 * hand-controlled persistence layer so a failing commit can be observed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Controlled persistence ────────────────────────────────────────────────
let convMeta: Record<string, any> = {};
let commitOk = true;
const commitCalls: any[] = [];
const routeCalls: any[] = [];
const insertCalls: any[] = [];
const runLogs: any[] = [];

const fakeSb = {
  from: (_table: string) => ({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: { metadata: convMeta } }),
      }),
    }),
    update: () => ({ eq: async () => ({ error: null }) }),
  }),
  rpc: async (_fn: string, args: any) => {
    convMeta = { ...convMeta, ...(args.p_patch || {}) };
    return { data: true, error: null };
  },
};

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  logRun: async (_c: any, input: any) => {
    runLogs.push(input);
    return `run-${runLogs.length}`;
  },
}));

vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async (_c: any, input: any) => {
    insertCalls.push(input);
    return { id: `msg-${insertCalls.length}` };
  },
  deriveAgentDisplay: () => ({ agentName: 'AI', agentLogoUrl: null }),
}));

vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  commitNeedsHuman: async (_c: any, input: any) => {
    commitCalls.push(input);
    if (!commitOk) return { ok: false, routingDeferred: false };
    convMeta = { ...convMeta, ai_state: 'needs_human', ai_handoff_reason: input.reason };
    return { ok: true, routingDeferred: false };
  },
  routeAfterHandoff: async (_c: any, input: any) => { routeCalls.push(input); },
}));

const { runLimitHandoff } = await import('../../../server/services/ai-agent/limitHandoff.js');

const CONFIG: any = {};
const settings = (over: Record<string, any> = {}) =>
  ({ mode: 'auto_reply_always', agent_name: 'AI', ...over }) as any;

const call = (over: Record<string, any> = {}) =>
  runLimitHandoff(CONFIG, {
    workspaceId: 'ws-1',
    conversationId: 'conv-1',
    visitorMessageId: 'vm-1',
    question: 'hi',
    locale: 'en',
    reason: 'no_ai_provider',
    settings: settings(),
    ...over,
  } as any);

beforeEach(() => {
  convMeta = {};
  commitOk = true;
  commitCalls.length = 0;
  routeCalls.length = 0;
  insertCalls.length = 0;
  runLogs.length = 0;
});

describe('runLimitHandoff — commit-first contract', () => {
  it('a failed commit writes no marker, sends nothing, routes nothing, logs failure', async () => {
    commitOk = false;
    const res = await call();

    expect(res.committed).toBe(false);
    expect(res.sentMessage).toBe(false);
    expect(res.duplicate).toBe(false);
    expect(insertCalls).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);
    expect(convMeta.ai_limit_handoff_committed).toBeUndefined();
    expect(convMeta.ai_limit_handoff_sent).toBeUndefined();
    expect(convMeta.ai_limit_handoff_message_sent).toBeUndefined();
    // Observability must not claim a successful handoff.
    expect(runLogs).toHaveLength(1);
    expect(runLogs[0].status).toBe('failed');
    expect(runLogs[0].skipReason).toBe('commit_failed');
    expect(runLogs[0].metadata.commit_failed).toBe(true);
  });

  it('retries the commit on the next attempt and acknowledges exactly once', async () => {
    commitOk = false;
    await call();
    expect(commitCalls).toHaveLength(1);

    commitOk = true;
    const second = await call();

    expect(commitCalls).toHaveLength(2); // commit was really attempted again
    expect(second.committed).toBe(true);
    expect(second.duplicate).toBe(false);
    expect(second.sentMessage).toBe(true);
    expect(insertCalls).toHaveLength(1);
    expect(convMeta.ai_limit_handoff_committed).toBe(true);
    expect(convMeta.ai_state).toBe('needs_human');
  });

  it('a repeat of a committed reason is a duplicate with no second acknowledgement', async () => {
    const first = await call();
    expect(first.sentMessage).toBe(true);

    const second = await call();
    expect(second.committed).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(second.sentMessage).toBe(false);
    expect(insertCalls).toHaveLength(1);
    expect(commitCalls).toHaveLength(1);
  });

  it('fallback_behavior=silent commits durably without a visitor message', async () => {
    const res = await call({ settings: settings({ fallback_behavior: 'silent' }) });

    expect(res.committed).toBe(true);
    expect(res.sentMessage).toBe(false);
    expect(insertCalls).toHaveLength(0);
    expect(convMeta.ai_state).toBe('needs_human');
    expect(convMeta.ai_limit_handoff_committed).toBe(true);
    expect(routeCalls).toHaveLength(1);
  });

  it('suggest_only commits durably without a visitor message', async () => {
    const res = await call({
      settings: settings({ mode: 'suggest_only' }),
      suppressVisitorMessage: true,
    });

    expect(res.committed).toBe(true);
    expect(res.sentMessage).toBe(false);
    expect(insertCalls).toHaveLength(0);
    expect(convMeta.ai_state).toBe('needs_human');
  });

  it('an ambiguous legacy marker without durable state re-runs the commit', async () => {
    convMeta = { ai_limit_handoff_sent: true, ai_limit_handoff_reason: 'no_ai_provider' };
    const res = await call();

    expect(commitCalls).toHaveLength(1);
    expect(res.committed).toBe(true);
    expect(convMeta.ai_limit_handoff_committed).toBe(true);
    expect(insertCalls).toHaveLength(0);
  });

  it('a legacy marker whose commit still fails does not claim a handoff', async () => {
    convMeta = { ai_limit_handoff_sent: true, ai_limit_handoff_reason: 'no_ai_provider' };
    commitOk = false;
    const res = await call();

    expect(res.committed).toBe(false);
    expect(runLogs[0].status).toBe('failed');
    expect(convMeta.ai_limit_handoff_committed).toBeUndefined();
  });
});
