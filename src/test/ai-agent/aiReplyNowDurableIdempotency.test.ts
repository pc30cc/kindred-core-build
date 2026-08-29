/**
 * AI Reply Now — blocker 2: durable, multi-process idempotency.
 *
 * Two independent Core instances are simulated by loading the production
 * module twice (each copy gets its OWN in-process Map) while sharing a single
 * fake `ai_agent_reply_now_claims` table. Correctness must come from the
 * shared durable store, not from the local map.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WS2 = '11111111-1111-1111-1111-111111111111';
const CONV = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CONV2 = '22222222-2222-2222-2222-222222222222';
const MSG = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const OPERATOR = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const config = {} as any;

/** Shared "database" across both simulated instances. */
const claims = new Map<string, any>();
let engineCalls: any[] = [];
let engineDelayMs = 0;
let engineFails = false;

function matches(row: any, f: Record<string, any>): boolean {
  return Object.entries(f).every(([k, v]) => row[k] === v);
}

function makeSb() {
  const from = (name: string) => {
    const f: Record<string, any> = {};
    let mode: 'select' | 'update' = 'select';
    let patch: any = null;
    const neq: [string, any][] = [];
    const lt: [string, any][] = [];

    const claimRows = () =>
      [...claims.values()].filter(
        (r) => matches(r, f)
          && neq.every(([c, v]) => r[c] !== v)
          && lt.every(([c, v]) => new Date(r[c]).getTime() < new Date(v).getTime()),
      );

    const chain: any = {
      select: () => chain,
      eq: (c: string, v: any) => { f[c] = v; return chain; },
      neq: (c: string, v: any) => { neq.push([c, v]); return chain; },
      lt: (c: string, v: any) => { lt.push([c, v]); return chain; },
      in: () => chain,
      order: () => chain,
      update: (p: any) => { mode = 'update'; patch = p; return chain; },
      insert: async (row: any) => {
        if (name !== 'ai_agent_reply_now_claims') return { error: null };
        if (claims.has(row.claim_key)) return { error: { message: 'duplicate key' } };
        claims.set(row.claim_key, { ...row });
        return { error: null };
      },
      maybeSingle: async () => {
        if (name === 'conversations') {
          if (f.workspace_id !== WS && f.workspace_id !== WS2) return { data: null, error: null };
          return {
            data: { id: f.id, workspace_id: f.workspace_id, status: 'open', metadata: { ai_state: 'ai_managed' } },
            error: null,
          };
        }
        if (name === 'ai_agent_reply_now_claims') {
          return { data: claimRows()[0] || null, error: null };
        }
        return { data: null, error: null };
      },
      limit: async () => {
        if (name === 'conversation_messages') {
          return {
            data: [{ id: MSG, conversation_id: f.conversation_id, sender_type: 'contact', body: 'hi?', created_at: '2026-01-01T10:00:00.000Z' }],
            error: null,
          };
        }
        return { data: [], error: null };
      },
      then: (res: any, rej: any) => {
        if (mode === 'update' && name === 'ai_agent_reply_now_claims') {
          const rows = claimRows();
          rows.forEach((r) => Object.assign(r, patch));
          return Promise.resolve({ data: rows.map((r) => ({ claim_key: r.claim_key })), error: null }).then(res, rej);
        }
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      },
    };
    return chain;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

const fakeSb = makeSb();
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai-agent/engine.js', () => ({
  maybeRunAiAssistantAfterVisitorMessage: async (_c: any, input: any) => {
    engineCalls.push(input);
    if (engineDelayMs) await new Promise((r) => setTimeout(r, engineDelayMs));
    if (engineFails) throw new Error('engine_exploded');
    return { ran: true, action: 'replied', runId: `run-${engineCalls.length}`, messageId: `m-${engineCalls.length}` };
  },
}));

/** Loads a FRESH copy of the module = an independent Core process. */
async function instance() {
  vi.resetModules();
  return import('../../../server/services/ai-agent/replyNow.js');
}

beforeEach(() => {
  claims.clear();
  engineCalls = [];
  engineDelayMs = 0;
  engineFails = false;
});

const args = (over: any = {}) => ({
  workspaceId: WS, conversationId: CONV, operatorId: OPERATOR, idempotencyKey: 'idem-key-0001', ...over,
});

describe('AI Reply Now — durable idempotency across instances', () => {
  it('collapses concurrent requests from two instances to ONE generation', async () => {
    const a = await instance();
    const b = await instance();
    engineDelayMs = 60;
    const [ra, rb] = await Promise.all([
      a.replyNowWithGuidance(config, args()),
      b.replyNowWithGuidance(config, args()),
    ]);
    expect(engineCalls).toHaveLength(1);
    const results = [ra, rb];
    expect(results.filter((r: any) => r.ok && !r.deduplicated)).toHaveLength(1);
    const dup: any = results.find((r: any) => r.deduplicated || !r.ok);
    expect(dup.ok ? dup.run.messageId : dup.reason).toBeTruthy();
  });

  it('a retry after completion is deduplicated and returns the same result', async () => {
    const a = await instance();
    const first: any = await a.replyNowWithGuidance(config, args());
    const b = await instance();
    const retry: any = await b.replyNowWithGuidance(config, args());
    expect(engineCalls).toHaveLength(1);
    expect(retry.ok).toBe(true);
    expect(retry.deduplicated).toBe(true);
    expect(retry.run.messageId).toBe(first.run.messageId);
  });

  it('a different idempotency key starts a new requested turn', async () => {
    const a = await instance();
    await a.replyNowWithGuidance(config, args());
    await a.replyNowWithGuidance(config, args({ idempotencyKey: 'idem-key-0002' }));
    expect(engineCalls).toHaveLength(2);
  });

  it('the same key on a different conversation does not collide', async () => {
    const a = await instance();
    await a.replyNowWithGuidance(config, args());
    const b = await instance();
    await b.replyNowWithGuidance(config, args({ conversationId: CONV2 }));
    expect(engineCalls).toHaveLength(2);
    expect(engineCalls.map((c) => c.conversationId).sort()).toEqual([CONV, CONV2].sort());
  });

  it('isolates tenants: same key in another workspace runs its own turn', async () => {
    const a = await instance();
    await a.replyNowWithGuidance(config, args());
    const b = await instance();
    await b.replyNowWithGuidance(config, args({ workspaceId: WS2 }));
    expect(engineCalls).toHaveLength(2);
    expect(new Set(engineCalls.map((c) => c.workspaceId)).size).toBe(2);
  });

  it('a failed run leaves a retryable claim (retry produces a real generation)', async () => {
    const a = await instance();
    engineFails = true;
    await expect(a.replyNowWithGuidance(config, args())).rejects.toThrow('engine_exploded');
    expect([...claims.values()][0].status).toBe('failed');

    engineFails = false;
    const b = await instance();
    const retry: any = await b.replyNowWithGuidance(config, args());
    expect(retry.ok).toBe(true);
    expect(retry.deduplicated).toBe(false);
    expect(engineCalls).toHaveLength(2);
    expect([...claims.values()][0].status).toBe('completed');
  });

  it('an abandoned (expired) running claim can be taken over by exactly one retry', async () => {
    const a = await instance();
    await a.replyNowWithGuidance(config, args());
    // Simulate a crashed instance: stale running claim.
    const row = [...claims.values()][0];
    row.status = 'running';
    row.result = null;
    row.expires_at = new Date(Date.now() - 60_000).toISOString();

    const b = await instance();
    const c = await instance();
    const [rb, rc] = await Promise.all([
      b.replyNowWithGuidance(config, args()),
      c.replyNowWithGuidance(config, args()),
    ]);
    expect(engineCalls).toHaveLength(2); // 1 original + exactly 1 takeover
    expect([rb, rc].filter((r: any) => r.ok && !r.deduplicated)).toHaveLength(1);
  });
});
