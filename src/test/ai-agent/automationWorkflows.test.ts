/**
 * Phase 1B — C15: Workflows. evaluateWorkflows() is pure and tested
 * directly with no mocking. executeMatchedWorkflows() performs real IO
 * (insertAiMessage/markNeedsHuman/markHandoffRequested/readAiConversationMeta),
 * so those collaborators are mocked at the module boundary the same way
 * handoff.test.ts does, with markHandoffRequested/readAiConversationMeta
 * left real against a faked `conversations` table so the idempotency check
 * genuinely works (see the C8 combined-precedence test for why a stub
 * there would give a false-positive result).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateWorkflows } from '../../../server/services/ai-agent/runtime/workflowRuntime.js';
import { makeSettings, makeConversationState, makeFakeSupabase } from './helpers/engineFixtures.js';

function evalCtx(overrides: Record<string, any> = {}) {
  return {
    workspaceId: 'ws-1',
    conversationId: 'conv-1',
    visitorMessageId: 'vmsg-1',
    visitorText: 'hello',
    inputLanguage: 'en',
    responseLanguage: 'en',
    topTopic: null,
    detectedTopics: [],
    settings: makeSettings(),
    runtimeConfig: null,
    conversationState: makeConversationState(),
    answerStrategy: null,
    now: Date.now(),
    ...overrides,
  };
}

function workflow(overrides: Record<string, any> = {}) {
  return {
    id: 'wf1', name: 'Test workflow', description: null,
    trigger_json: { event: 'visitor_first_message' },
    steps_json: [{ type: 'send_message', payload: { body: 'hello' } }],
    enabled: true, status: 'active', version: 1,
    ...overrides,
  };
}

describe('C15 — Workflows: evaluateWorkflows() (pure)', () => {
  it('no match when no workflow is configured', () => {
    const r = evaluateWorkflows(evalCtx(), 'visitor_first_message');
    expect(r.matchedWorkflowIds).toHaveLength(0);
  });

  it('matches a workflow whose trigger event matches', () => {
    const r = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [workflow()] } }), 'visitor_first_message');
    expect(r.matchedWorkflowIds).toContain('wf1');
  });

  it('does not match a disabled or non-active workflow', () => {
    const disabled = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [workflow({ enabled: false })] } }), 'visitor_first_message');
    const draft = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [workflow({ status: 'draft' })] } }), 'visitor_first_message');
    expect(disabled.matchedWorkflowIds).toHaveLength(0);
    expect(draft.matchedWorkflowIds).toHaveLength(0);
  });

  it('classifies a safe step (send_message) as executed-capability in planned metadata', () => {
    const r = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [workflow()] } }), 'visitor_first_message');
    expect(r.plannedActions[0].payload.capability).toBe('executed');
  });

  it('classifies a blocked/unsafe step (webhook) as blocked, never executed', () => {
    const wf = workflow({ steps_json: [{ type: 'webhook', payload: { url: 'https://evil.example/hook' } }] });
    const r = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [wf] } }), 'visitor_first_message');
    expect(r.plannedActions[0].payload.capability).toBe('blocked');
    expect(r.plannedActions[0].payload.capability_reason).toMatch(/^blocked:/);
  });

  it('a workflow already executed for this (id, event, topic) dedup key is skipped', () => {
    const ctx = evalCtx({
      runtimeConfig: { workflows: [workflow()] },
      conversationState: makeConversationState({ _metadata: { ai_workflow_executed_keys: ['wf1:visitor_first_message:-'] } }),
    });
    const r = evaluateWorkflows(ctx, 'visitor_first_message');
    expect(r.matchedWorkflowIds).toContain('wf1'); // still "matched" for reporting purposes
    expect(r.skippedActions).toHaveLength(1);
    expect(r.skippedActions[0].skippedReason).toBe('duplicate_workflow_execution');
  });
});

// ─── executeMatchedWorkflows: safe execution / stop-AI / handoff / blocked ───
let fakeSb: ReturnType<typeof makeFakeSupabase>;
const insertAiMessageCalls: any[] = [];
const markNeedsHumanCalls: any[] = [];
const markHandoffRequestedCalls: any[] = [];

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));
vi.mock('../../../server/services/ai-agent/responder.js', () => ({
  insertAiMessage: async (_config: any, input: any) => {
    insertAiMessageCalls.push(input);
    return { id: `msg-${insertAiMessageCalls.length}` };
  },
  deriveAgentDisplay: (settings: any) => ({ agentName: settings.agent_name || 'AI Assistant', agentLogoUrl: null }),
}));
vi.mock('../../../server/services/ai-agent/handoffState.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    markNeedsHuman: async (_config: any, input: any) => {
      markNeedsHumanCalls.push(input);
    },

    // vNext blocker 1 — handoff is a two-phase commit; the engine calls
    // commitNeedsHuman() then routeAfterHandoff(). Both are recorded here so
    // these suites keep asserting on handoff side effects.
    commitNeedsHuman: async (_config: any, input: any) => {
      markNeedsHumanCalls.push(input);
      return { ok: true, routingDeferred: false };
    },
    routeAfterHandoff: async () => {},
  };
});
vi.mock('../../../server/services/ai-agent/conversationState.js', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    markHandoffRequested: async (...args: any[]) => {
      markHandoffRequestedCalls.push(args);
      return actual.markHandoffRequested(...args);
    },
  };
});

const { executeMatchedWorkflows } = await import('../../../server/services/ai-agent/runtime/workflowExecutor.js');

const CONFIG = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } as any;

function execCtx(overrides: Record<string, any> = {}) {
  return {
    config: CONFIG, workspaceId: 'ws-1', conversationId: 'conv-1',
    responseLanguage: 'en', inputLanguage: 'en', settings: makeSettings(), runId: null,
    ...overrides,
  };
}

beforeEach(() => {
  insertAiMessageCalls.length = 0;
  markNeedsHumanCalls.length = 0;
  markHandoffRequestedCalls.length = 0;
  fakeSb = makeFakeSupabase({ conversations: [{ id: 'conv-1', metadata: {} }] });
});

describe('C15 — Workflows: executeMatchedWorkflows() (real IO, mocked at true boundaries)', () => {
  it('safe execution: a send_message step inserts exactly one message, does not stop AI unless continue_ai=false', async () => {
    const matchResult = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [workflow()] } }), 'visitor_first_message');
    const exec = await executeMatchedWorkflows(execCtx(), matchResult, evalCtx({ runtimeConfig: { workflows: [workflow()] } }));
    expect(exec.executedActions).toHaveLength(1);
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(exec.stopAi).toBe(false); // send_message defaults continue_ai -> stopAi=false
    expect(exec.handoffExecuted).toBe(false);
  });

  it('stop-AI: a send_message step with continue_ai=false stops AI without a handoff', async () => {
    const wf = workflow({ steps_json: [{ type: 'send_message', payload: { body: 'We are closed.', continue_ai: false } }] });
    const matchResult = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [wf] } }), 'visitor_first_message');
    const exec = await executeMatchedWorkflows(execCtx(), matchResult, evalCtx({ runtimeConfig: { workflows: [wf] } }));
    expect(exec.stopAi).toBe(true);
    expect(exec.handoffExecuted).toBe(false);
    expect(insertAiMessageCalls).toHaveLength(1);
  });

  it('handoff step: inserts one ack, marks needs-human, reports handoffExecuted=true', async () => {
    const wf = workflow({ steps_json: [{ type: 'handoff' }] });
    const matchResult = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [wf] } }), 'visitor_first_message');
    const exec = await executeMatchedWorkflows(execCtx(), matchResult, evalCtx({ runtimeConfig: { workflows: [wf] } }));
    expect(exec.handoffExecuted).toBe(true);
    expect(insertAiMessageCalls).toHaveLength(1);
    expect(insertAiMessageCalls[0].handoff).toBe(true);
    expect(markNeedsHumanCalls).toHaveLength(1);
  });

  it('a blocked step (webhook) is never executed and never inserts a message', async () => {
    const wf = workflow({ steps_json: [{ type: 'webhook', payload: { url: 'https://evil.example/hook' } }] });
    const matchResult = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [wf] } }), 'visitor_first_message');
    const exec = await executeMatchedWorkflows(execCtx(), matchResult, evalCtx({ runtimeConfig: { workflows: [wf] } }));
    expect(exec.executedActions).toHaveLength(0);
    expect(exec.blockedActions.length).toBeGreaterThan(0);
    expect(insertAiMessageCalls).toHaveLength(0);
  });

  it('a second handoff step for an already-handed-off conversation does not insert a duplicate ack', async () => {
    fakeSb = makeFakeSupabase({ conversations: [{ id: 'conv-1', metadata: { ai_handoff_requested: true } }] });
    const wf = workflow({ steps_json: [{ type: 'handoff' }] });
    const matchResult = evaluateWorkflows(evalCtx({ runtimeConfig: { workflows: [wf] } }), 'visitor_first_message');
    const exec = await executeMatchedWorkflows(execCtx(), matchResult, evalCtx({ runtimeConfig: { workflows: [wf] } }));
    expect(insertAiMessageCalls).toHaveLength(0);
    expect(exec.handoffExecuted).toBe(true); // still reported true (already in handoff state)
  });
});
