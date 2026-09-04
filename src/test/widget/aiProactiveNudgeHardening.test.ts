/**
 * AI Proactive Nudge — hardening pass regression tests (module-level unit
 * tests for lifecycle.ts, session.ts, and sessionState.ts).
 *
 * evaluate.ts's full orchestration is covered separately in
 * aiProactiveNudgeEvaluateOrchestration.test.ts because those tests must
 * `vi.mock` sessionState.ts (and other collaborators) to isolate control
 * flow — vi.mock is file-scoped/hoisted, so mocking a module in this file
 * would silently hijack the "real implementation" tests below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

// ─────────────────────────────────────────────────────────────────────
// Part 1 — lifecycle.ts: guarded status transitions (pure, no mocks needed
// beyond a minimal fake Supabase query builder).
// ─────────────────────────────────────────────────────────────────────
import { transitionNudgeStatus } from '../../../server/services/widget/aiNudge/lifecycle.js';

function fakeUpdateBuilder(matchesFilter: boolean) {
  const builder: any = {
    eq: () => builder,
    in: () => builder,
    gt: () => builder,
    select: async () => (matchesFilter ? { data: [{ id: 'nudge-1' }], error: null } : { data: [], error: null }),
  };
  return builder;
}

describe('lifecycle.ts — guarded nudge status transitions', () => {
  it('allows generated -> shown', async () => {
    const supabase = { from: () => ({ update: () => fakeUpdateBuilder(true) }) };
    const ok = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'shown' });
    expect(ok).toBe(true);
  });

  it('"shown -> shown" (replayed ack) cannot re-fire — shown only allows FROM generated', async () => {
    const supabase = { from: () => ({ update: () => fakeUpdateBuilder(false) }) };
    const ok = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'shown' });
    expect(ok).toBe(false);
  });

  it('dismissed/clicked never allow "generated" as a prior state (no skipping the shown step)', async () => {
    // dismissed and clicked may ONLY follow 'shown' — a nudge still
    // 'generated' cannot transition directly to either.
    const supabase = { from: () => ({ update: () => fakeUpdateBuilder(false) }) };
    const dismissedOk = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'dismissed' });
    const clickedOk = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'clicked' });
    expect(dismissedOk).toBe(false);
    expect(clickedOk).toBe(false);
  });

  it('converted allows only from clicked (rejects from generated/shown/dismissed)', async () => {
    const supabase = { from: () => ({ update: () => fakeUpdateBuilder(false) }) };
    const ok = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'converted' });
    expect(ok).toBe(false);
  });

  it('"generated" itself has no allowed prior state (it is the initial state, never a transition target)', async () => {
    const supabase = { from: () => ({ update: () => fakeUpdateBuilder(true) }) };
    const ok = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'generated' });
    expect(ok).toBe(false);
  });

  it('a shown ack past expires_at is rejected when requireNotExpired is set', async () => {
    const supabase = { from: () => ({ update: () => fakeUpdateBuilder(false) }) };
    const ok = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'shown', requireNotExpired: true });
    expect(ok).toBe(false);
  });

  it('a DB error is treated as a failed transition, never thrown', async () => {
    const supabase = { from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ in: () => ({ select: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }) }) };
    const ok = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'shown' });
    expect(ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 2 — session.ts: trusted session lineage derivation.
// ─────────────────────────────────────────────────────────────────────
import { hashTrustedNudgeSession, resolveTrustedNudgeSessionKey } from '../../../server/services/widget/aiNudge/session.js';

describe('session.ts — trusted session lineage', () => {
  it('is a deterministic, stable hash of the same nonce', () => {
    expect(hashTrustedNudgeSession('abc123')).toBe(hashTrustedNudgeSession('abc123'));
  });

  it('produces different keys for different nonces', () => {
    expect(hashTrustedNudgeSession('abc123')).not.toBe(hashTrustedNudgeSession('xyz789'));
  });

  it('resolves from req._widgetNonce set by enforceWidgetToken', () => {
    const req: any = { _widgetNonce: 'the-real-nonce' };
    expect(resolveTrustedNudgeSessionKey(req)).toBe(hashTrustedNudgeSession('the-real-nonce'));
  });

  it('fails closed (returns null) when no verified token nonce exists', () => {
    expect(resolveTrustedNudgeSessionKey({} as any)).toBeNull();
    expect(resolveTrustedNudgeSessionKey({ _widgetNonce: '' } as any)).toBeNull();
  });

  it('never derives from a client-supplied session_id field, even if present on the request body', () => {
    // A rotated client session_id in the body must have zero influence —
    // only the middleware-verified nonce on the request object matters.
    const req: any = { _widgetNonce: 'server-nonce', body: { session_id: 'attacker-controlled-rotating-id' } };
    const key1 = resolveTrustedNudgeSessionKey(req);
    req.body.session_id = 'a-completely-different-rotated-id';
    const key2 = resolveTrustedNudgeSessionKey(req);
    expect(key1).toBe(key2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Part 3 — sessionState.ts: atomic evaluation-identity RPC caller.
// ─────────────────────────────────────────────────────────────────────
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: vi.fn() }));

describe('sessionState.ts — durable evaluation identity caller', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls the atomic RPC with workspace + trusted session key + fingerprint + ceiling, never a client identifier', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, evaluation_id: 'eval-1', evaluation_count: 1, is_new: true }, error: null });
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await acquireAiNudgeEvaluation({} as any, 'ws-1', 'trusted-key-abc', 'fp-1', 5);
    expect(result).toEqual({ evaluationId: 'eval-1', evaluationCount: 1, isNew: true });
    expect(rpc).toHaveBeenCalledWith('ai_nudge_acquire_evaluation', expect.objectContaining({
      _workspace_id: 'ws-1',
      _session_key: 'trusted-key-abc',
      _fingerprint: 'fp-1',
      _max_evaluations: 5,
    }));
  });

  it('returns the SAME evaluation_id without incrementing when the RPC reports a replay (is_new: false)', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true, evaluation_id: 'eval-1', evaluation_count: 1, is_new: false }, error: null });
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await acquireAiNudgeEvaluation({} as any, 'ws-1', 'trusted-key-abc', 'fp-1', 5);
    expect(result).toEqual({ evaluationId: 'eval-1', evaluationCount: 1, isNew: false });
  });

  it('returns null (denied) when the RPC reports the ceiling was reached', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: false, reason: 'ceiling_reached' }, error: null });
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await acquireAiNudgeEvaluation({} as any, 'ws-1', 'trusted-key-abc', 'fp-1', 5);
    expect(result).toBeNull();
  });

  it('fails closed (returns null, never throws) on a DB error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } });
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await acquireAiNudgeEvaluation({} as any, 'ws-1', 'trusted-key-abc', 'fp-1', 5);
    expect(result).toBeNull();
  });

  it('never calls the RPC at all when the ceiling is zero (platform/workspace disabled)', async () => {
    const rpc = vi.fn();
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await acquireAiNudgeEvaluation({} as any, 'ws-1', 'trusted-key-abc', 'fp-1', 0);
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never calls the RPC when the fingerprint is missing (fail closed, not "unlimited")', async () => {
    const rpc = vi.fn();
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { acquireAiNudgeEvaluation } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await acquireAiNudgeEvaluation({} as any, 'ws-1', 'trusted-key-abc', '', 5);
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
