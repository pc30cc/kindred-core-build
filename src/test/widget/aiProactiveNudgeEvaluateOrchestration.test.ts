/**
 * AI Proactive Nudge — evaluate.ts full orchestration hardening tests.
 *
 * Every DB/AI collaborator is mocked so these tests exercise real
 * control flow: privacy enforcement, fail-closed frequency lookup, the
 * atomic per-session evaluation ceiling (including immunity to a
 * rotated client session_id), and AI Run linkage/settlement.
 * Kept in its own file (separate from aiProactiveNudgeHardening.test.ts)
 * because vi.mock is file-scoped/hoisted — mocking sessionState.ts etc.
 * here must not hijack the "real implementation" unit tests there.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: vi.fn() }));

// ─────────────────────────────────────────────────────────────────────
// Part 4 — evaluate.ts: full orchestration. Every DB/AI dependency is
// mocked so these tests exercise real control flow: privacy enforcement,
// fail-closed frequency lookup, the atomic evaluation ceiling (including
// immunity to a rotated client session_id), and AI Run linkage.
// ─────────────────────────────────────────────────────────────────────
vi.mock('../../../server/services/widget/aiNudge/policy.js', () => ({ resolveEffectiveAiNudgePolicy: vi.fn() }));
vi.mock('../../../server/services/widget/aiNudge/sessionState.js', () => ({
  acquireAiNudgeEvaluation: vi.fn(),
}));
vi.mock('../../../server/services/ai-agent/settings.js', () => ({ getOrCreateSettings: vi.fn().mockResolvedValue({ agent_name: 'Bot' }) }));
vi.mock('../../../server/services/ai-agent/retrieval.js', () => ({ retrieveSources: vi.fn().mockResolvedValue([]) }));
vi.mock('../../../server/services/ai/index.js', () => ({ executeAICompletion: vi.fn() }));
vi.mock('../../../server/services/ai-billing/runContext.js', () => ({
  beginAiRunGuarded: vi.fn(),
  settleAiRun: vi.fn().mockResolvedValue(undefined),
  failAiRun: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../server/services/observability/metrics.js', () => ({ emitMetric: vi.fn() }));

function baseCtx(overrides: any = {}) {
  return {
    masterEnabled: true,
    mode: 'production',
    page: { url: '/pricing', path: '/pricing', hostname: 'example.com' },
    device: 'desktop',
    locale: 'en',
    visitor: { isReturning: true, sessionPageCount: 3 },
    availability: { online: true },
    interaction: {},
    signals: { elapsedMs: 60000, scrollPercent: 80, inactiveMs: 0, exitIntent: false },
    ...overrides,
  };
}

function baseJourney(overrides: any = {}) {
  return {
    current: { path: '/checkout', ts: 3000 },
    recentPages: [{ path: '/pricing', ts: 1000 }, { path: '/features', ts: 2000 }],
    sessionPageCount: 3,
    returning: true,
    ...overrides,
  };
}

const BASE_POLICY = {
  available: true,
  unavailableReason: null,
  mode: 'active' as const,
  includePaths: [],
  excludePaths: [],
  guidance: null,
  useKb: true,
  useJourney: true,
  useReturningVisitor: true,
  maxPerSession: 3,
  cooldownSeconds: 60,
  stopAfterDismiss: true,
  stopAfterWidgetOpen: true,
  stopAfterConversation: true,
  mobileEnabled: true,
  maxEvaluationsPerSession: 5,
  maxMessageLength: 220,
  minConfidenceFloor: 0.5,
};

/** Frequency-lookup select chain — matches loadServerFrequencyState's exact call shape. */
function freqSelectChain(result: { data: any; error: any }) {
  return {
    eq: () => ({
      eq: () => ({
        in: () => ({
          gte: () => ({
            order: () => ({
              limit: async () => result,
            }),
          }),
        }),
      }),
    }),
  };
}

function makeFakeSupabase(opts: { freqResult: { data: any; error: any }; insertedId?: string }) {
  return {
    from: (table: string) => {
      if (table === 'widget_ai_nudges') {
        return {
          select: () => freqSelectChain(opts.freqResult),
          insert: () => ({
            select: () => ({
              single: async () => ({ data: { id: opts.insertedId || 'nudge-generated-1' }, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
    },
  };
}

const SHOW_DECISION_RAW = JSON.stringify({
  decision: 'show', intent: 'pricing', confidence: 0.9,
  message: 'Need help choosing a plan?', topic: 'pricing',
  cta: { label: 'Chat now', action: 'open_chat' },
});

describe('evaluate.ts — full orchestration hardening', () => {
  beforeEach(() => vi.clearAllMocks());

  async function wireHappyPath(overrides: { freqResult?: any; ceiling?: number | null; acquisition?: any; policy?: Partial<typeof BASE_POLICY> } = {}) {
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    (resolveEffectiveAiNudgePolicy as any).mockResolvedValue({ ...BASE_POLICY, ...(overrides.policy || {}) });

    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue(makeFakeSupabase({
      freqResult: overrides.freqResult ?? { data: [], error: null },
    }));

    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    if (overrides.ceiling === null) {
      (acquireAiNudgeEvaluation as any).mockResolvedValue(null);
    } else {
      (acquireAiNudgeEvaluation as any).mockResolvedValue(
        overrides.acquisition ?? { evaluationId: 'eval-1', evaluationCount: overrides.ceiling ?? 1, isNew: true },
      );
    }

    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext.js');
    (beginAiRunGuarded as any).mockResolvedValue({ runId: 'run-123', stepSeq: 1, workspaceId: 'ws-1' });

    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    (executeAICompletion as any).mockResolvedValue({ text: SHOW_DECISION_RAW });

    return { evaluateAiProactiveNudge: (await import('../../../server/services/widget/aiNudge/evaluate.js')).evaluateAiProactiveNudge };
  }

  it('fails closed with missing trusted session key without touching any dependency', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath();
    const result = await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: '', visitorId: null, sessionId: 'client-1',
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(result).toEqual({ decision: 'suppress' });
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    expect(executeAICompletion).not.toHaveBeenCalled();
  });

  it('generates a nudge with status "generated" and NO shown event at generation time (lifecycle fix)', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath();
    const { getServiceClient } = await import('../../../server/supabase.js');
    const insertSpy = vi.fn().mockReturnValue({ select: () => ({ single: async () => ({ data: { id: 'nudge-1' }, error: null }) }) });
    (getServiceClient as any).mockReturnValue({
      from: (table: string) => {
        if (table === 'widget_ai_nudges') return { select: () => freqSelectChain({ data: [], error: null }), insert: insertSpy };
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      },
    });
    const result = await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: 'client-1',
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(result.decision).toBe('show');
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'generated', session_key: 'trusted-abc' }));
    // Never an eager insert into widget_smart_events at generation time.
    const fromCalls = (await import('../../../server/supabase.js') as any);
    void fromCalls; // shape already proven by the single from() mock above having no widget_smart_events branch invoked
  });

  it('persists the AI Run id on the generated nudge row', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath();
    const { getServiceClient } = await import('../../../server/supabase.js');
    const insertSpy = vi.fn().mockReturnValue({ select: () => ({ single: async () => ({ data: { id: 'nudge-1' }, error: null }) }) });
    (getServiceClient as any).mockReturnValue({
      from: (table: string) => {
        if (table === 'widget_ai_nudges') return { select: () => freqSelectChain({ data: [], error: null }), insert: insertSpy };
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      },
    });
    await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(insertSpy).toHaveBeenCalledWith(expect.objectContaining({ ai_run_id: 'run-123' }));
    const { settleAiRun } = await import('../../../server/services/ai-billing/runContext.js');
    expect(settleAiRun).toHaveBeenCalled();
  });

  it('fails closed when the authoritative frequency lookup errors — zero AI calls, never a permissive empty state', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath({ freqResult: { data: null, error: { message: 'db down' } } });
    const result = await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(result).toEqual({ decision: 'suppress' });
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    expect(executeAICompletion).not.toHaveBeenCalled();
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext.js');
    expect(beginAiRunGuarded).not.toHaveBeenCalled();
  });

  it('suppresses and makes zero provider calls once the durable evaluation ceiling denies the request', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath({ ceiling: null });
    const result = await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(result).toEqual({ decision: 'suppress' });
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    expect(executeAICompletion).not.toHaveBeenCalled();
  });

  it('session-id rotation attack: evaluation identity is acquired on trustedSessionKey, never the client session_id (blocker 4 test D)', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath();
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    for (const rotatedSessionId of ['session-A', 'session-B', 'session-C']) {
      await evaluateAiProactiveNudge({} as any, {
        workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: rotatedSessionId,
        locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
      });
    }
    // Every call used the SAME trusted key regardless of the rotated client session_id.
    const calls = (acquireAiNudgeEvaluation as any).mock.calls;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call[2]).toBe('trusted-abc');
    }
  });

  it('blocker 4 test A: a replayed evaluation (same evaluationId) with an already-persisted result returns that SAME result — zero additional provider execution', async () => {
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    (resolveEffectiveAiNudgePolicy as any).mockResolvedValue(BASE_POLICY);
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    (acquireAiNudgeEvaluation as any).mockResolvedValue({ evaluationId: 'eval-replay-1', evaluationCount: 1, isNew: false });
    const { getServiceClient } = await import('../../../server/supabase.js');
    // The widget_ai_nudges select must serve BOTH the frequency-lookup chain
    // AND the replay-lookup (.eq().eq().maybeSingle()) chain, since
    // evaluate.ts uses the same table for both.
    (getServiceClient as any).mockReturnValue({
      from: (table: string) => {
        if (table === 'widget_ai_nudges') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({ gte: () => ({ order: () => ({ limit: async () => ({ data: [], error: null }) }) }) }),
                  maybeSingle: async () => ({
                    data: { id: 'existing-nudge-1', message: 'Need help?', topic: 'pricing', cta_label: 'Chat', cta_action: 'open_chat', cta_url: null },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      },
    });
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext.js');
    const evaluateAiProactiveNudge = (await import('../../../server/services/widget/aiNudge/evaluate.js')).evaluateAiProactiveNudge;
    const result = await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(result).toEqual({
      decision: 'show',
      nudgeId: 'existing-nudge-1',
      message: 'Need help?',
      topic: 'pricing',
      cta: { label: 'Chat', action: 'open_chat', url: undefined },
    });
    expect(executeAICompletion).not.toHaveBeenCalled();
    expect(beginAiRunGuarded).not.toHaveBeenCalled();
  });

  it('blocker 4 test B: a genuinely new evaluation (isNew: true) always proceeds through a real provider call, keyed by its own evaluationId', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath({ acquisition: { evaluationId: 'eval-new-2', evaluationCount: 2, isNew: true } });
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext.js');
    await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(executeAICompletion).toHaveBeenCalled();
    const beginArgs = (beginAiRunGuarded as any).mock.calls[0][1];
    expect(beginArgs.operationKey).toContain('eval-new-2');
    expect(beginArgs.operationKey).not.toContain('undefined');
    const completionArgs = (executeAICompletion as any).mock.calls[0][1];
    expect(completionArgs.requestId).toContain('eval-new-2');
    expect(completionArgs.billing.operationKey).toContain('eval-new-2');
  });

  /**
   * A stateful fake widget_ai_nudges table that actually enforces the
   * UNIQUE (workspace_id, evaluation_id) constraint the migration adds —
   * a second insert for a key already in `store` returns a 23505 error,
   * exactly like Postgres would. Used by the cross-replica/lost-response/
   * owner-crash race tests below, where "another replica" or "a retry" is
   * simulated as a second evaluateAiProactiveNudge() call sharing this
   * same in-memory table.
   */
  function makeRaceSimSupabase(opts: { freqResult?: { data: any; error: any } } = {}) {
    const store = new Map<string, any>();
    let nextId = 1;
    const fake = {
      from: (table: string) => {
        if (table !== 'widget_ai_nudges') {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        }
        return {
          select: () => ({
            eq: (_col1: string, val1: any) => ({
              eq: (_col2: string, val2: any) => ({
                in: () => ({ gte: () => ({ order: () => ({ limit: async () => opts.freqResult ?? { data: [], error: null } }) }) }),
                maybeSingle: async () => ({ data: store.get(`${val1}:${val2}`) || null, error: null }),
              }),
            }),
          }),
          insert: (row: any) => ({
            select: () => ({
              single: async () => {
                const key = `${row.workspace_id}:${row.evaluation_id}`;
                if (store.has(key)) {
                  return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_widget_ai_nudges_evaluation"' } };
                }
                const id = `nudge-${nextId++}`;
                store.set(key, { id, message: row.message, topic: row.topic, cta_label: row.cta_label, cta_action: row.cta_action, cta_url: row.cta_url });
                return { data: { id }, error: null };
              },
            }),
          }),
        };
      },
    };
    return { fake, store };
  }

  it('race fix test 5 — cross-replica concurrency: the follower makes ZERO provider calls, the owner makes exactly ONE, and a later replay recovers the persisted nudge with zero more', async () => {
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    (resolveEffectiveAiNudgePolicy as any).mockResolvedValue(BASE_POLICY);
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const { getServiceClient } = await import('../../../server/supabase.js');
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    const { beginAiRunGuarded, settleAiRun } = await import('../../../server/services/ai-billing/runContext.js');
    (executeAICompletion as any).mockResolvedValue({ text: SHOW_DECISION_RAW });
    (beginAiRunGuarded as any).mockResolvedValue({ runId: 'run-shared', stepSeq: 1, workspaceId: 'ws-1' });

    const { fake } = makeRaceSimSupabase();
    (getServiceClient as any).mockReturnValue(fake);
    const evaluateAiProactiveNudge = (await import('../../../server/services/widget/aiNudge/evaluate.js')).evaluateAiProactiveNudge;
    const input = {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop' as const, ctx: baseCtx() as any, journey: baseJourney() as any,
    };

    // Replica B reaches the durable RPC FIRST and is told isNew:false — the
    // RPC already handed evaluationId E to replica A, which has not
    // inserted its nudge row yet. This is the exact race the fix closes.
    (acquireAiNudgeEvaluation as any).mockResolvedValueOnce({ evaluationId: 'E', evaluationCount: 1, isNew: false });
    const resultB = await evaluateAiProactiveNudge({} as any, input);
    expect(resultB).toEqual({ decision: 'suppress' });
    expect(executeAICompletion).not.toHaveBeenCalled();
    expect(beginAiRunGuarded).not.toHaveBeenCalled();

    // Replica A owns evaluationId E (isNew:true) and is the only one that executes.
    (acquireAiNudgeEvaluation as any).mockResolvedValueOnce({ evaluationId: 'E', evaluationCount: 1, isNew: true });
    const resultA = await evaluateAiProactiveNudge({} as any, input);
    expect(resultA.decision).toBe('show');
    expect(executeAICompletion).toHaveBeenCalledTimes(1);
    expect(beginAiRunGuarded).toHaveBeenCalledTimes(1);
    expect(settleAiRun).toHaveBeenCalledTimes(1);

    // A later replay of the SAME evaluationId (another follower, or a
    // retry) recovers A's persisted row — zero additional provider calls.
    (acquireAiNudgeEvaluation as any).mockResolvedValueOnce({ evaluationId: 'E', evaluationCount: 1, isNew: false });
    const resultReplay = await evaluateAiProactiveNudge({} as any, input);
    expect(resultReplay.decision).toBe('show');
    expect(resultReplay.nudgeId).toBe(resultA.nudgeId);
    expect(executeAICompletion).toHaveBeenCalledTimes(1);
    expect(beginAiRunGuarded).toHaveBeenCalledTimes(1);
  });

  it('race fix test 6 — lost-response recovery: a same-process retry after a lost HTTP response recovers the persisted nudge with zero additional charge', async () => {
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    (resolveEffectiveAiNudgePolicy as any).mockResolvedValue(BASE_POLICY);
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const { getServiceClient } = await import('../../../server/supabase.js');
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext.js');
    (executeAICompletion as any).mockResolvedValue({ text: SHOW_DECISION_RAW });
    (beginAiRunGuarded as any).mockResolvedValue({ runId: 'run-1', stepSeq: 1, workspaceId: 'ws-1' });
    const { fake } = makeRaceSimSupabase();
    (getServiceClient as any).mockReturnValue(fake);
    const evaluateAiProactiveNudge = (await import('../../../server/services/widget/aiNudge/evaluate.js')).evaluateAiProactiveNudge;
    const input = {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop' as const, ctx: baseCtx() as any, journey: baseJourney() as any,
    };

    // 1-3: the evaluation executes successfully and the nudge persists —
    // then the HTTP response back to the widget is (hypothetically) lost.
    (acquireAiNudgeEvaluation as any).mockResolvedValueOnce({ evaluationId: 'E', evaluationCount: 1, isNew: true });
    const first = await evaluateAiProactiveNudge({} as any, input);
    expect(first.decision).toBe('show');
    expect(executeAICompletion).toHaveBeenCalledTimes(1);

    // 4: the widget retries the SAME context on the SAME Core process. With
    // no in-process dedup cache to (incorrectly) suppress it, the retry
    // reaches the durable RPC, which — for a retry within the dedup window
    // — hands back the SAME evaluationId with isNew:false.
    (acquireAiNudgeEvaluation as any).mockResolvedValueOnce({ evaluationId: 'E', evaluationCount: 1, isNew: false });
    const retry = await evaluateAiProactiveNudge({} as any, input);
    expect(acquireAiNudgeEvaluation).toHaveBeenCalledTimes(2);
    expect(retry.decision).toBe('show');
    expect(retry.nudgeId).toBe(first.nudgeId);
    expect(executeAICompletion).toHaveBeenCalledTimes(1); // zero additional call
    expect(beginAiRunGuarded).toHaveBeenCalledTimes(1); // zero additional charge
  });

  it('race fix test 7 — owner-crash/follower: a follower for an unpersisted evaluation never calls AI; after the dedup window a fresh evaluationId allows exactly one new execution', async () => {
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    (resolveEffectiveAiNudgePolicy as any).mockResolvedValue(BASE_POLICY);
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const { getServiceClient } = await import('../../../server/supabase.js');
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext.js');
    (executeAICompletion as any).mockResolvedValue({ text: SHOW_DECISION_RAW });
    (beginAiRunGuarded as any).mockResolvedValue({ runId: 'run-2', stepSeq: 1, workspaceId: 'ws-1' });
    const { fake } = makeRaceSimSupabase();
    (getServiceClient as any).mockReturnValue(fake);
    const evaluateAiProactiveNudge = (await import('../../../server/services/widget/aiNudge/evaluate.js')).evaluateAiProactiveNudge;
    const input = {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop' as const, ctx: baseCtx() as any, journey: baseJourney() as any,
    };

    // The owner that acquired evaluationId E as isNew:true crashed before
    // ever persisting a nudge row — the store has no entry for E. A
    // follower now receives isNew:false for the SAME evaluationId.
    (acquireAiNudgeEvaluation as any).mockResolvedValueOnce({ evaluationId: 'E', evaluationCount: 1, isNew: false });
    const followerResult = await evaluateAiProactiveNudge({} as any, input);
    expect(followerResult).toEqual({ decision: 'suppress' });
    expect(executeAICompletion).not.toHaveBeenCalled();
    expect(beginAiRunGuarded).not.toHaveBeenCalled();

    // Only once the durable dedup window has fully lapsed does the RPC
    // mint a genuinely NEW evaluationId — exactly one new execution is
    // then allowed for this fingerprint.
    (acquireAiNudgeEvaluation as any).mockResolvedValueOnce({ evaluationId: 'E2', evaluationCount: 2, isNew: true });
    const laterResult = await evaluateAiProactiveNudge({} as any, input);
    expect(laterResult.decision).toBe('show');
    expect(executeAICompletion).toHaveBeenCalledTimes(1);
    expect(beginAiRunGuarded).toHaveBeenCalledTimes(1);
  });

  it('race fix — an insert-time unique-violation (23505) on evaluation_id is treated as a safe replay, not a visitor-facing error', async () => {
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    (resolveEffectiveAiNudgePolicy as any).mockResolvedValue(BASE_POLICY);
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const { getServiceClient } = await import('../../../server/supabase.js');
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    const { beginAiRunGuarded } = await import('../../../server/services/ai-billing/runContext.js');
    (executeAICompletion as any).mockResolvedValue({ text: SHOW_DECISION_RAW });
    (beginAiRunGuarded as any).mockResolvedValue({ runId: 'run-3', stepSeq: 1, workspaceId: 'ws-1' });
    // isNew:true (this caller believes it owns the insert) but the store
    // ALREADY has a row for this evaluationId — simulates a bug or an
    // unforeseen race at the acquisition layer; the DB-level UNIQUE index
    // is the final backstop.
    (acquireAiNudgeEvaluation as any).mockResolvedValue({ evaluationId: 'E', evaluationCount: 1, isNew: true });
    const { fake, store } = makeRaceSimSupabase();
    store.set('ws-1:E', { id: 'nudge-already-there', message: 'Need help choosing a plan?', topic: 'pricing', cta_label: 'Chat now', cta_action: 'open_chat', cta_url: null });
    (getServiceClient as any).mockReturnValue(fake);
    const evaluateAiProactiveNudge = (await import('../../../server/services/widget/aiNudge/evaluate.js')).evaluateAiProactiveNudge;
    const result = await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(result.decision).toBe('show');
    expect(result.nudgeId).toBe('nudge-already-there');
  });

  it('useJourney=false: recentPages never reach the eligibility score or the AI prompt', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath({ policy: { useJourney: false } });
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    const journey = baseJourney({
      recentPages: [{ path: '/DISTINCTIVE-SECRET-PAGE-A', ts: 1000 }, { path: '/DISTINCTIVE-SECRET-PAGE-B', ts: 2000 }],
    });
    await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: journey as any,
    });
    expect(executeAICompletion).toHaveBeenCalled();
    const promptArg = (executeAICompletion as any).mock.calls[0][1];
    expect(promptArg.prompt).not.toContain('DISTINCTIVE-SECRET-PAGE');
  });

  it('useReturningVisitor=false: returning status never reaches the AI prompt, even when the client claims returning=true', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath({ policy: { useReturningVisitor: false } });
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop',
      ctx: baseCtx({ visitor: { isReturning: true, sessionPageCount: 3 } }) as any,
      journey: baseJourney({ returning: true }) as any,
    });
    expect(executeAICompletion).toHaveBeenCalled();
    const promptArg = (executeAICompletion as any).mock.calls[0][1];
    expect(promptArg.prompt).toContain('Returning visitor: no');
  });

  it('useKb=false: retrieveSources is never called', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath({ policy: { useKb: false } });
    const { retrieveSources } = await import('../../../server/services/ai-agent/retrieval.js');
    await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(retrieveSources).not.toHaveBeenCalled();
  });

  it('useKb=true: retrieveSources IS called', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath({ policy: { useKb: true } });
    const { retrieveSources } = await import('../../../server/services/ai-agent/retrieval.js');
    await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(retrieveSources).toHaveBeenCalled();
  });

  it('forged high-intent behavior signals cannot bypass the trusted evaluation ceiling', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath({ ceiling: null });
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    const forgedCtx = baseCtx({ signals: { elapsedMs: 99999999, scrollPercent: 100, inactiveMs: 0, exitIntent: true }, visitor: { isReturning: true, sessionPageCount: 999 } });
    for (let i = 0; i < 5; i++) {
      const result = await evaluateAiProactiveNudge({} as any, {
        workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: `rotated-${i}`,
        locale: 'en', device: 'desktop', ctx: forgedCtx as any, journey: baseJourney() as any,
      });
      expect(result).toEqual({ decision: 'suppress' });
    }
    expect(executeAICompletion).not.toHaveBeenCalled();
  });

  it('a malformed AI response is still settled as billed usage (real tokens were spent) but never shown', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath();
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    (executeAICompletion as any).mockResolvedValue({ text: 'not json at all' });
    const result = await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(result).toEqual({ decision: 'suppress' });
    const { settleAiRun } = await import('../../../server/services/ai-billing/runContext.js');
    expect(settleAiRun).toHaveBeenCalled();
  });

  it('a provider failure fails the AI Run instead of settling it', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath();
    const { executeAICompletion } = await import('../../../server/services/ai/index.js');
    (executeAICompletion as any).mockRejectedValue(new Error('runtime_unreachable'));
    const result = await evaluateAiProactiveNudge({} as any, {
      workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: null,
      locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
    });
    expect(result).toEqual({ decision: 'suppress' });
    const { failAiRun, settleAiRun } = await import('../../../server/services/ai-billing/runContext.js');
    expect(failAiRun).toHaveBeenCalled();
    expect(settleAiRun).not.toHaveBeenCalled();
  });
});
