/**
 * P1 — delivery accounting must be observable: a run is only promoted to
 * replied/suggested (credits=1) after the artifact persisted, and a failed
 * promotion must never be reported as a clean success.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const finalizeCalls: any[] = [];
let finalizeResult: any = { ok: true, attempts: 1 };
let insertResult: any = { id: 'msg_1' };
let suggestionInsert: any = { data: { id: 'sug_1' }, error: null };
let logRunResult: any = 'run_1';
const insertMessageCalls: any[] = [];
const suggestionInsertCalls: any[] = [];

vi.mock('../../../server/services/ai-agent/logs.js', () => ({
  logRun: async () => logRunResult,
  finalizeRun: async (_c: any, runId: any, patch: any) => {
    finalizeCalls.push({ runId, ...patch });
    return finalizeResult;
  },
}));

vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async (_c: any, payload: any) => {
    insertMessageCalls.push(payload);
    return insertResult;
  },
  deriveAgentDisplay: () => ({ agentName: 'AI', agentLogoUrl: null }),
}));

vi.mock('../../../server/services/ai-agent/handoffState.js', () => ({
  markAiManaged: async () => {},
}));

vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async () => {},
}));

const { runDeliveryStage } = await import('../../../server/services/ai-agent/engine/deliveryStage.js');

const sb = {
  from: (table: string) => ({
    insert: (row: any) => {
      suggestionInsertCalls.push({ table, row });
      return { select: () => ({ single: async () => suggestionInsert }) };
    },
  }),
};

function args(canAutoReply: boolean) {
  return [
    {} as any,
    { workspaceId: 'ws', conversationId: 'c1', visitorMessageId: 'v1', question: 'hi' } as any,
    { settings: { mode: canAutoReply ? 'auto' : 'suggest_only' }, runtimeCfg: null, decisionTimeline: [] } as any,
    { sb, locale: 'en', languageMeta: {}, detectedTopicsMeta: {}, guidanceMeta: {} } as any,
    {} as any,
    { decision: { canAutoReply, canSuggest: !canAutoReply } } as any,
    { sources: [], queryMeta: {} } as any,
    { strategy: { confidence: 0.9, decisionType: 'answer' }, strategyMeta: {}, triggerMeta: {}, workflowMeta: {}, toolMeta: {}, pageContextMetaRef: {}, routingMeta: {} } as any,
    { aiResult: { text: 'hello', provider: 'openai', model: 'm', promptTokens: 1, completionTokens: 1, latencyMs: 5 } } as any,
  ] as const;
}

beforeEach(() => {
  finalizeCalls.length = 0;
  insertMessageCalls.length = 0;
  suggestionInsertCalls.length = 0;
  logRunResult = 'run_1';
  finalizeResult = { ok: true, attempts: 1 };
  insertResult = { id: 'msg_1' };
  suggestionInsert = { data: { id: 'sug_1' }, error: null };
});

describe('auto reply delivery accounting', () => {
  it('normal reply succeeds and bills exactly one credit', async () => {
    const r = await (runDeliveryStage as any)(...args(true));
    expect(r.action).toBe('replied');
    expect(r.finalizationPending).toBeUndefined();
    expect(finalizeCalls).toEqual([{ runId: 'run_1', status: 'replied', creditsUsed: 1 }]);
  });

  it('AI message insert failure → no replied status, no credit', async () => {
    insertResult = { id: null, error: 'db down' };
    const r = await (runDeliveryStage as any)(...args(true));
    expect(r.action).toBe('failed');
    expect(r.reason).toBe('ai_message_insert_failed');
    expect(finalizeCalls[0].status).toBe('failed');
    expect(finalizeCalls[0].creditsUsed).toBe(0);
    expect(finalizeCalls.some((c) => c.status === 'replied')).toBe(false);
  });

  it('message persists but finalization fails → reported as pending, not silent', async () => {
    finalizeResult = { ok: false, error: 'update failed', attempts: 2 };
    const r = await (runDeliveryStage as any)(...args(true));
    expect(r.action).toBe('replied');
    expect(r.messageId).toBe('msg_1');
    expect(r.reason).toBe('run_finalization_failed');
    expect(r.finalizationPending).toBe(true);
  });
});

describe('suggestion delivery accounting', () => {
  it('normal suggestion succeeds and bills exactly one credit', async () => {
    const r = await (runDeliveryStage as any)(...args(false));
    expect(r.action).toBe('suggested');
    expect(r.suggestionId).toBe('sug_1');
    expect(r.finalizationPending).toBeUndefined();
    expect(finalizeCalls).toEqual([{ runId: 'run_1', status: 'suggested', creditsUsed: 1 }]);
  });

  it('suggestion insert failure → no suggested status, no credit', async () => {
    suggestionInsert = { data: null, error: { message: 'insert blocked' } };
    const r = await (runDeliveryStage as any)(...args(false));
    expect(r.action).toBe('failed');
    expect(r.reason).toBe('suggestion_insert_failed');
    expect(finalizeCalls[0].status).toBe('failed');
    expect(finalizeCalls[0].creditsUsed).toBe(0);
    expect(finalizeCalls.some((c) => c.status === 'suggested')).toBe(false);
  });

  it('suggestion persists but finalization fails → reported as pending', async () => {
    finalizeResult = { ok: false, error: 'update failed', attempts: 2 };
    const r = await (runDeliveryStage as any)(...args(false));
    expect(r.action).toBe('suggested');
    expect(r.reason).toBe('run_finalization_failed');
    expect(r.finalizationPending).toBe(true);
  });
});
