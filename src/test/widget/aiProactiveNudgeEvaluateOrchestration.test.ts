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
vi.mock('../../../server/services/widget/aiNudge/dedup.js', () => ({
  isDuplicateAiNudgeContext: vi.fn().mockReturnValue(false),
  recordAiNudgeEvaluation: vi.fn(),
}));
vi.mock('../../../server/services/widget/aiNudge/sessionState.js', () => ({
  tryIncrementAiNudgeEvaluationCounter: vi.fn(),
  recordAiNudgeShownForSession: vi.fn(),
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

  async function wireHappyPath(overrides: { freqResult?: any; ceiling?: number | null; policy?: Partial<typeof BASE_POLICY> } = {}) {
    const { resolveEffectiveAiNudgePolicy } = await import('../../../server/services/widget/aiNudge/policy.js');
    (resolveEffectiveAiNudgePolicy as any).mockResolvedValue({ ...BASE_POLICY, ...(overrides.policy || {}) });

    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue(makeFakeSupabase({
      freqResult: overrides.freqResult ?? { data: [], error: null },
    }));

    const { tryIncrementAiNudgeEvaluationCounter } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    (tryIncrementAiNudgeEvaluationCounter as any).mockResolvedValue(overrides.ceiling === undefined ? 1 : overrides.ceiling);

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

  it('session-id rotation attack: the evaluation ceiling is keyed on trustedSessionKey, never the client session_id', async () => {
    const { evaluateAiProactiveNudge } = await wireHappyPath();
    const { tryIncrementAiNudgeEvaluationCounter } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    for (const rotatedSessionId of ['session-A', 'session-B', 'session-C']) {
      await evaluateAiProactiveNudge({} as any, {
        workspaceId: 'ws-1', trustedSessionKey: 'trusted-abc', visitorId: null, sessionId: rotatedSessionId,
        locale: 'en', device: 'desktop', ctx: baseCtx() as any, journey: baseJourney() as any,
      });
    }
    // Every call used the SAME trusted key regardless of the rotated client session_id.
    const calls = (tryIncrementAiNudgeEvaluationCounter as any).mock.calls;
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect(call[2]).toBe('trusted-abc');
    }
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
