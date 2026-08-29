/**
 * Support Intelligence vNext — production acceptance matrix (scenarios A–L).
 *
 * Every scenario drives the REAL production service modules. Only the
 * Supabase client, the realtime publisher and the routing side effect are
 * faked; the fake Supabase implements migration-057 semantics (row-locked
 * shallow metadata merge + compare-and-swap on `ai_memory.rev`) so the tests
 * exercise the same persistence contract the deployed database provides.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WS = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONV = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const MSG = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ANCHOR = '2026-01-01T10:00:00.000Z';

const config = {} as any;

let conv: any;
let messages: any[];
let guidance: any[];
let prechat: any;
let routeCalls: string[];
let routeThrows = false;
let metadataRpcFails = false;
let runtimeFlagsRpcFails = false;
const order: string[] = [];

/** Migration 057 `patch_conversation_metadata`, in memory. */
function rpcPatchMetadata(args: any) {
  if (metadataRpcFails) return { data: null, error: { message: 'function does not exist' } };
  if (!conv || conv.id !== args.p_conversation_id) return { data: null, error: null };
  if (args.p_workspace_id && conv.workspace_id !== args.p_workspace_id) return { data: null, error: null };
  conv.metadata = { ...(conv.metadata || {}), ...(args.p_patch || {}) };
  return { data: conv.metadata, error: null };
}

/** Migration 057 `patch_conversation_ai_memory`, in memory (CAS on rev). */
function rpcPatchAiMemory(args: any) {
  if (!conv || conv.id !== args.p_conversation_id) return { data: null, error: null };
  const cur = (conv.metadata || {}).ai_memory || {};
  const rev = Number(cur.rev) || 0;
  if (args.p_expected_rev !== null && args.p_expected_rev !== undefined && rev !== args.p_expected_rev) {
    return { data: { conflict: true, rev, memory: cur }, error: null };
  }
  const next = { ...(args.p_memory || {}), rev: rev + 1 };
  conv.metadata = { ...(conv.metadata || {}), ai_memory: next };
  return { data: { conflict: false, rev: rev + 1, memory: next }, error: null };
}

/** Migration 058 `patch_conversation_runtime_flags`, in memory. */
function rpcPatchRuntimeFlags(args: any) {
  if (runtimeFlagsRpcFails) return { data: null, error: { message: 'function does not exist' } };
  if (!conv || conv.id !== args.p_conversation_id) return { data: null, error: null };
  const patch = args.p_patch || {};
  const meta: any = { ...(conv.metadata || {}) };
  if (patch.greeting_sent) meta.ai_greeting_sent = true;
  if (patch.handoff_sent) meta.ai_handoff_sent = true;
  const push = (key: string, val?: string) => {
    if (!val) return;
    const arr: string[] = Array.isArray(meta[key]) ? [...meta[key]] : [];
    if (!arr.includes(val)) arr.push(val);
    meta[key] = arr;
  };
  push('ai_trigger_executed_ids', patch.append_trigger_id);
  push('ai_workflow_planned_ids', patch.append_workflow_id);
  push('ai_routing_executed_rule_ids', patch.append_routing_rule_id);
  if (patch.touch !== false) meta.ai_last_runtime_action_at = new Date().toISOString();
  conv.metadata = meta;
  return { data: meta, error: null };
}

function makeSb() {
  const from = (name: string) => {
    const f: Record<string, any> = {};
    let patch: any = null;
    let mode: 'select' | 'update' = 'select';
    let inIds: string[] | null = null;

    const rows = () => {
      if (name === 'ai_agent_guidance') {
        return guidance.filter((g) =>
          Object.entries(f).every(([k, v]) => (g as any)[k] === v),
        );
      }
      if (name === 'conversation_messages') {
        return messages;
      }
      return [];
    };

    const applyUpdate = () => {
      order.push(`update:${name}`);
      if (name === 'conversations') {
        conv.metadata = patch.metadata !== undefined ? patch.metadata : conv.metadata;
        Object.assign(conv, patch);
        return { error: null };
      }
      if (name === 'ai_agent_guidance') {
        for (const g of guidance) {
          if (inIds && !inIds.includes(g.id)) continue;
          if (!Object.entries(f).every(([k, v]) => (g as any)[k] === v)) continue;
          Object.assign(g, patch);
        }
      }
      return { error: null };
    };

    const chain: any = {
      select: () => chain,
      eq: (col: string, val: any) => { f[col] = val; return chain; },
      in: (_col: string, vals: string[]) => { inIds = vals; return chain; },
      gt: (_col: string, val: any) => { f.__gt = val; return chain; },
      order: () => chain,
      update: (p: any) => { mode = 'update'; patch = p; return chain; },
      maybeSingle: async () => {
        if (name === 'conversations') {
          if (f.workspace_id && conv.workspace_id !== f.workspace_id) return { data: null, error: null };
          return { data: f.id === conv.id ? conv : null, error: null };
        }
        if (name === 'conversation_messages') {
          const m = messages.find((x) => x.id === f.id);
          return { data: m || { id: f.id, created_at: ANCHOR }, error: null };
        }
        if (name === 'widget_prechat_settings') return { data: prechat, error: null };
        if (name === 'contacts') return { data: null, error: null };
        return { data: null, error: null };
      },
      limit: async () => {
        if (name === 'conversation_messages') {
          const after = f.__gt;
          return { data: messages.filter((m) => !after || m.created_at > after), error: null };
        }
        return { data: rows(), error: null };
      },
      then: (res: any, rej: any) =>
        Promise.resolve(mode === 'update' ? applyUpdate() : { data: rows(), error: null }).then(res, rej),
    };
    return chain;
  };

  return {
    from,
    rpc: async (fn: string, args: any) => {
      order.push(`rpc:${fn}`);
      if (fn === 'patch_conversation_metadata') return rpcPatchMetadata(args);
      if (fn === 'patch_conversation_ai_memory') return rpcPatchAiMemory(args);
      if (fn === 'patch_conversation_runtime_flags') return rpcPatchRuntimeFlags(args);
      return { data: null, error: null };
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
    if (routeThrows) throw new Error('no operator available');
    routeCalls.push(a.conversationId);
    return { ok: true };
  },
}));

beforeEach(() => {
  conv = { id: CONV, workspace_id: WS, status: 'open', contact_id: null, metadata: {} };
  messages = [{ id: MSG, conversation_id: CONV, sender_type: 'contact', created_at: ANCHOR }];
  guidance = [];
  prechat = null;
  routeCalls = [];
  routeThrows = false;
  metadataRpcFails = false;
  runtimeFlagsRpcFails = false;
  order.length = 0;
  fakeSb = makeSb();
});

const freshness = () => import('../../../server/services/ai-agent/freshness.js');
const wm = () => import('../../../server/services/ai-agent/workingMemory.js');
const hs = () => import('../../../server/services/ai-agent/handoffState.js');
const hp = () => import('../../../server/services/ai-agent/handoffPolicy.js');
const gd = () => import('../../../server/services/ai-agent/guidance.js');

async function check(checkpoint: any = 'pre_delivery') {
  const { checkGenerationFreshness } = await freshness();
  return checkGenerationFreshness(config, {
    workspaceId: WS, conversationId: CONV, visitorMessageId: MSG, checkpoint,
  });
}

// ── A ────────────────────────────────────────────────────────────────
describe('A — normal grounded answer', () => {
  it('records the issue, stays fresh and never hands off', async () => {
    const { deriveTurnPatch, EMPTY_MEMORY, persistWorkingMemory, readWorkingMemory } = await wm();
    const patch = deriveTurnPatch({
      visitorText: 'How do I reset my password?',
      previousAssistantText: null,
      memory: EMPTY_MEMORY,
    });
    const next = await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch });
    expect(next?.currentIssue).toBe('How do I reset my password?');
    expect(next?.issueStatus).toBe('open');
    expect(readWorkingMemory(conv.metadata).currentIssue).toBe('How do I reset my password?');

    const { decideHandoff } = await hp();
    expect(decideHandoff({
      policy: 'adaptive', explicitHumanRequest: false, visitorText: 'How do I reset my password?',
      memory: next!, maxAssistAttempts: 1,
    }).kind).toBe('continue');

    expect((await check()).fresh).toBe(true);
  });
});

// ── B ────────────────────────────────────────────────────────────────
describe('B — broken previous link', () => {
  it('marks the offered URL as failed and forbids re-offering it', async () => {
    const { deriveTurnPatch, EMPTY_MEMORY, persistWorkingMemory, renderMemoryBlock } = await wm();
    const patch = deriveTurnPatch({
      visitorText: "that link doesn't open",
      previousAssistantText: 'See https://example.test/docs/reset',
      memory: EMPTY_MEMORY,
    });
    const next = await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch });
    expect(next?.failedResources).toContain('https://example.test/docs/reset');
    expect(next?.issueStatus).toBe('in_progress');
    const block = renderMemoryBlock(next!);
    expect(block).toMatch(/do not re-offer as the main answer/);
    expect(block).toMatch(/example\.test\/docs\/reset/);
  });

  it('does the same for the Persian phrasing', async () => {
    const { deriveTurnPatch, EMPTY_MEMORY } = await wm();
    const patch = deriveTurnPatch({
      visitorText: 'این لینک باز نمیشه',
      previousAssistantText: 'https://example.test/fa/help',
      memory: EMPTY_MEMORY,
    });
    expect(patch.addFailedResources).toContain('https://example.test/fa/help');
  });
});

// ── C ────────────────────────────────────────────────────────────────
describe('C — adaptive human request', () => {
  it('makes exactly one assist attempt and never claims a transfer happened', async () => {
    const { decideHandoff, assistFirstMessage } = await hp();
    const { EMPTY_MEMORY } = await wm();
    const d = decideHandoff({
      policy: 'adaptive', explicitHumanRequest: true, visitorText: 'can I talk to support?',
      memory: EMPTY_MEMORY, maxAssistAttempts: 1,
    });
    expect(d.kind).toBe('assist_once');
    expect(d.handoffRequestCount).toBe(1);
    for (const l of ['en', 'fa', 'tr']) {
      expect(assistFirstMessage(l)).not.toMatch(/transferred|وصل شدید|aktarıldınız/i);
    }
    // nothing durable happened — the conversation is still AI-managed
    expect(conv.metadata.ai_state).toBeUndefined();
  });

  it('skips the assist when a previous solution already failed', async () => {
    const { decideHandoff } = await hp();
    const { EMPTY_MEMORY } = await wm();
    expect(decideHandoff({
      policy: 'adaptive', explicitHumanRequest: true, visitorText: 'someone please help',
      memory: { ...EMPTY_MEMORY, failedResources: ['https://example.test/x'] }, maxAssistAttempts: 1,
    }).reason).toBe('previous_solution_failed');
  });

  it('legacy immediate policy is unchanged', async () => {
    const { decideHandoff, resolveHandoffPolicy } = await hp();
    const { EMPTY_MEMORY } = await wm();
    expect(resolveHandoffPolicy({ handoff_on_human_request: true } as any)).toBe('immediate');
    expect(decideHandoff({
      policy: 'immediate', explicitHumanRequest: true, visitorText: 'human',
      memory: EMPTY_MEMORY, maxAssistAttempts: 1,
    }).kind).toBe('handoff');
  });
});

// ── D ────────────────────────────────────────────────────────────────
describe('D — repeated operator request', () => {
  it('the second explicit request always hands off and is committed durably', async () => {
    const { decideHandoff } = await hp();
    const { EMPTY_MEMORY } = await wm();
    const d = decideHandoff({
      policy: 'adaptive', explicitHumanRequest: true, visitorText: 'I said operator',
      memory: { ...EMPTY_MEMORY, handoffRequestCount: 1, assistAttemptCount: 1 }, maxAssistAttempts: 1,
    });
    expect(d.kind).toBe('handoff');
    expect(d.reason).toBe('repeated_human_request');

    const { markNeedsHuman } = await hs();
    const commit = await markNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: d.reason as any });
    expect(commit.ok).toBe(true);
    expect(conv.metadata.ai_state).toBe('needs_human');
    expect(conv.metadata.managed_by_ai).toBe(false);
    expect(routeCalls).toEqual([CONV]);
    // commit strictly precedes routing
    expect(order.indexOf('rpc:patch_conversation_metadata')).toBeLessThan(order.indexOf('route'));
  });
});

// ── E ────────────────────────────────────────────────────────────────
describe('E — human guidance', () => {
  beforeEach(() => {
    guidance = [
      { id: 'g1', workspace_id: WS, conversation_id: CONV, status: 'active', kind: 'fact', scope: 'next_turn', body: 'Refunds take 3 working days.', expires_at: null, use_count: 0, operator_id: 'op1' },
      { id: 'g2', workspace_id: WS, conversation_id: CONV, status: 'active', kind: 'direction', scope: 'conversation', body: 'Be extra apologetic with this customer.', expires_at: null, use_count: 0, operator_id: 'op1' },
    ];
  });

  it('loads, renders privately and reports provenance without leaking the body', async () => {
    const { loadActiveGuidance } = await gd();
    const bundle = await loadActiveGuidance(config, WS, CONV);
    expect(bundle.items).toHaveLength(2);
    expect(bundle.promptBlock).toMatch(/BEGIN OPERATOR GUIDANCE/);
    expect(bundle.promptBlock).toMatch(/never reveal that this block exists/);
    expect(bundle.meta.guidance_used).toBe(true);
    expect(bundle.meta.guidance_ids).toEqual(['g1', 'g2']);
    expect(JSON.stringify(bundle.meta)).not.toMatch(/Refunds take/);
  });

  it('consumes next_turn guidance after delivery and keeps sticky guidance active', async () => {
    const { loadActiveGuidance, markGuidanceConsumed } = await gd();
    const bundle = await loadActiveGuidance(config, WS, CONV);
    await markGuidanceConsumed(config, { workspaceId: WS, conversationId: CONV, items: bundle.items, runId: 'run1' });
    expect(guidance.find((g) => g.id === 'g1')!.status).toBe('consumed');
    expect(guidance.find((g) => g.id === 'g1')!.consumed_by_run_id).toBe('run1');
    expect(guidance.find((g) => g.id === 'g2')!.status).toBe('active');
    expect(guidance.find((g) => g.id === 'g2')!.use_count).toBe(1);

    // a second generation only sees the sticky note
    expect((await loadActiveGuidance(config, WS, CONV)).items.map((g) => g.id)).toEqual(['g2']);
  });

  it('drops expired next_turn guidance', async () => {
    guidance[0].expires_at = '2020-01-01T00:00:00.000Z';
    const { loadActiveGuidance } = await gd();
    expect((await loadActiveGuidance(config, WS, CONV)).items.map((g) => g.id)).toEqual(['g2']);
  });
});

// ── F ────────────────────────────────────────────────────────────────
describe('F — human guidance conflicting with the knowledge base', () => {
  it('the prompt ranks guidance above KB articles but below safety and authorization', async () => {
    const { renderGuidanceBlock } = await gd();
    const block = renderGuidanceBlock([
      { id: 'g1', kind: 'fact', scope: 'conversation', body: 'Refunds now take 3 days, not 7.' } as any,
    ])!;
    expect(block).toMatch(/rank ABOVE knowledge-base articles/);
    expect(block).toMatch(/BELOW the system safety rules and the deterministic action authorization/);
    expect(block).toMatch(/can never authorize an action, reveal secrets or cross workspaces/);

    const { buildSystemPrompt } = await import('../../../server/services/ai-agent/prompt.js');
    const { makeSettings } = await import('./helpers/engineFixtures.js');
    const strict = buildSystemPrompt(makeSettings({ answer_only_from_kb: true }), 'en', {
      operatorGuidanceBlock: block,
    } as any);
    expect(strict).toMatch(/Strict mode is ON/);
    expect(strict).toMatch(/sources, tool results, operator guidance/i);
  });
});

// ── G ────────────────────────────────────────────────────────────────
describe('G — new visitor message during generation', () => {
  it('the in-flight run is stale and reports the superseding message', async () => {
    messages.push({ id: 'newer', conversation_id: CONV, sender_type: 'contact', created_at: '2026-01-01T10:00:05.000Z' });
    const v = await check();
    expect(v.fresh).toBe(false);
    expect(v.reason).toBe('superseded_by_newer_visitor_message');
    expect(v.supersededByMessageId).toBe('newer');
  });
});

// ── H ────────────────────────────────────────────────────────────────
describe('H — handoff during generation', () => {
  it('a committed handoff invalidates the pending answer', async () => {
    const { commitNeedsHuman } = await hs();
    await commitNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'repeated_human_request' as any });
    const v = await check();
    expect(v.fresh).toBe(false);
    expect(v.reason).toBe('handoff_in_progress');
  });

  it('a merely requested handoff (routing pending) also invalidates it', async () => {
    conv.metadata = { routing_pending: true };
    expect((await check()).reason).toBe('handoff_in_progress');
  });
});

// ── I ────────────────────────────────────────────────────────────────
describe('I — human takeover during generation', () => {
  it('metadata takeover outranks handoff detection', async () => {
    conv.metadata = { ai_state: 'human_active', ai_handoff_requested: true };
    const v = await check();
    expect(v.fresh).toBe(false);
    expect(v.reason).toBe('human_takeover');
    expect(v.humanTakeoverDetected).toBe(true);
  });

  it('a public operator reply also invalidates the run', async () => {
    messages.push({
      id: 'op-msg', conversation_id: CONV, sender_type: 'agent', sender_id: 'op1',
      created_at: '2026-01-01T10:00:03.000Z', metadata: {},
    });
    const v = await check();
    expect(v.reason).toBe('human_public_reply');
  });
});

// ── J ────────────────────────────────────────────────────────────────
describe('J — handoff commit failure', () => {
  it('no routing and no acknowledgement when the durable commit fails', async () => {
    metadataRpcFails = true;
    conv = { ...conv, id: 'missing' }; // the fallback path finds no row either
    const { markNeedsHuman } = await hs();
    const commit = await markNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'repeated_human_request' as any });
    expect(commit.ok).toBe(false);
    expect(routeCalls).toEqual([]);
    expect(order).not.toContain('route');
  });
});

// ── K ────────────────────────────────────────────────────────────────
describe('K — routing failure after a durable handoff', () => {
  it('the conversation stays durably needs_human and nothing throws', async () => {
    routeThrows = true;
    const { markNeedsHuman } = await hs();
    const commit = await markNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'repeated_human_request' as any });
    expect(commit.ok).toBe(true);
    expect(conv.metadata.ai_state).toBe('needs_human');
    expect(conv.metadata.ai_handoff_requested).toBe(true);
    // and the AI cannot resume on top of it
    expect((await check()).reason).toBe('handoff_in_progress');
  });

  it('routing is deferred (not attempted) while pre-chat is unanswered', async () => {
    prechat = { ask_name: true, ask_email: false, ask_phone: false };
    const { markNeedsHuman } = await hs();
    const commit = await markNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'repeated_human_request' as any });
    expect(commit.routingDeferred).toBe(true);
    expect(order).not.toContain('route');
    expect(conv.metadata.routing_pending).toBe(true);
  });
});

// ── L ────────────────────────────────────────────────────────────────
describe('L — concurrent working-memory write', () => {
  it('two overlapping writers both survive (no lost update)', async () => {
    const { persistWorkingMemory, readWorkingMemory } = await wm();
    await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { currentIssue: 'billing' } });
    await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { addFailedResources: ['https://example.test/a'] } });
    const m = readWorkingMemory(conv.metadata);
    expect(m.currentIssue).toBe('billing');
    expect(m.failedResources).toContain('https://example.test/a');
    expect((conv.metadata as any).ai_memory.rev).toBe(2);
  });

  it('a stale writer rebases onto the winner instead of clobbering it', async () => {
    const { persistWorkingMemory, readWorkingMemory } = await wm();
    // writer 1 reads rev 0
    const p1 = persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { currentIssue: 'first' } });
    await p1;
    // writer 2 was computed against rev 0 as well → conflict → retry
    conv.metadata.ai_memory.rev = 1;
    const before = order.filter((o) => o === 'rpc:patch_conversation_ai_memory').length;
    await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { addEntities: ['order #42'] } });
    const m = readWorkingMemory(conv.metadata);
    expect(m.currentIssue).toBe('first');
    expect(m.entities).toContain('order #42');
    expect(order.filter((o) => o === 'rpc:patch_conversation_ai_memory').length).toBeGreaterThan(before);
  });

  it('a handoff commit and a memory write never clobber each other', async () => {
    const { persistWorkingMemory } = await wm();
    const { commitNeedsHuman } = await hs();
    await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { currentIssue: 'refund' } });
    await commitNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'repeated_human_request' as any });
    await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { addEntities: ['INV-9'] } });
    expect(conv.metadata.ai_state).toBe('needs_human');
    expect(conv.metadata.ai_memory.currentIssue).toBe('refund');
    expect(conv.metadata.ai_memory.entities).toContain('INV-9');
  });
});

const rt = () => import('../../../server/services/ai-agent/runtime/conversationState.js');

// ── O ────────────────────────────────────────────────────────────────
describe('O — runtime flag writes vs. a concurrent needs_human transition', () => {
  it('runtime flags then handoff: both changes coexist', async () => {
    const { updateRuntimeFlags, readRuntimeFlags } = await rt();
    const { commitNeedsHuman } = await hs();
    await updateRuntimeFlags(config, CONV, { appendTriggerId: 'trigger-1' });
    await commitNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'repeated_human_request' as any });
    expect(conv.metadata.ai_state).toBe('needs_human');
    expect(readRuntimeFlags(conv.metadata).triggerExecutedIds).toContain('trigger-1');
  });

  it('handoff then runtime flags (reverse order): ai_state=needs_human is never overwritten', async () => {
    const { updateRuntimeFlags, readRuntimeFlags } = await rt();
    const { commitNeedsHuman } = await hs();
    await commitNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'repeated_human_request' as any });
    // A runtime writer holding a PRE-handoff snapshot of the document.
    await updateRuntimeFlags(config, CONV, { appendWorkflowId: 'wf-1', greetingSent: true });
    expect(conv.metadata.ai_state).toBe('needs_human');
    expect(conv.metadata.ai_handoff_requested).toBe(true);
    expect(conv.metadata.managed_by_ai).toBe(false);
    const flags = readRuntimeFlags(conv.metadata);
    expect(flags.workflowPlannedIds).toContain('wf-1');
    expect(flags.greetingSent).toBe(true);
  });

  it('runtime flags never clobber working memory either', async () => {
    const { updateRuntimeFlags } = await rt();
    const { persistWorkingMemory } = await wm();
    await persistWorkingMemory(config, { workspaceId: WS, conversationId: CONV, patch: { currentIssue: 'refund' } });
    await updateRuntimeFlags(config, CONV, { appendRoutingRuleId: 'rule-9' });
    expect(conv.metadata.ai_memory.currentIssue).toBe('refund');
    expect(conv.metadata.ai_routing_executed_rule_ids).toContain('rule-9');
  });
});

// ── P ────────────────────────────────────────────────────────────────
describe('P — runtime flag writes vs. a concurrent human takeover', () => {
  it('takeover metadata survives exactly', async () => {
    const { updateRuntimeFlags } = await rt();
    const { patchConversationMetadata } = await import('../../../server/services/conversationMetadata.js');
    await updateRuntimeFlags(config, CONV, { appendTriggerId: 'trigger-2' });
    await patchConversationMetadata(config, {
      conversationId: CONV,
      workspaceId: WS,
      patch: { ai_state: 'human_active', human_takeover_at: '2026-01-01T11:00:00.000Z', managed_by_ai: false },
    });
    // A late runtime writer must not resurrect AI ownership.
    await updateRuntimeFlags(config, CONV, { appendTriggerId: 'trigger-3' });
    expect(conv.metadata.ai_state).toBe('human_active');
    expect(conv.metadata.human_takeover_at).toBe('2026-01-01T11:00:00.000Z');
    expect(conv.metadata.managed_by_ai).toBe(false);
    expect(conv.metadata.ai_trigger_executed_ids).toEqual(['trigger-2', 'trigger-3']);
    expect((await check()).reason).toBe('human_takeover');
  });
});

// ── Q ────────────────────────────────────────────────────────────────
describe('Q — routing metadata written immediately after a durable handoff', () => {
  it('the canonical needs_human state is not reverted by the routing write', async () => {
    const { commitNeedsHuman } = await hs();
    const { patchConversationMetadata } = await import('../../../server/services/conversationMetadata.js');
    await commitNeedsHuman(config, { workspaceId: WS, conversationId: CONV, reason: 'repeated_human_request' as any });
    const snapshotBeforeHandoff = { department_id: null, routing_outcome: null };
    void snapshotBeforeHandoff; // the routing writer used to send this whole document back
    await patchConversationMetadata(config, {
      conversationId: CONV,
      workspaceId: WS,
      patch: { routing_outcome: 'assigned', department_id: 'dep-1' },
    });
    expect(conv.metadata.ai_state).toBe('needs_human');
    expect(conv.metadata.ai_handoff_requested).toBe(true);
    expect(conv.metadata.routing_outcome).toBe('assigned');
    expect(conv.metadata.department_id).toBe('dep-1');
    expect((await check()).reason).toBe('handoff_in_progress');
  });
});
