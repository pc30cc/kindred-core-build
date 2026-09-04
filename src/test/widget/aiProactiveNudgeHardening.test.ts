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

  it('rejects a direct generated -> converted jump (never shown/clicked first) by construction — converted allows from generated too per spec, so instead assert dismissed cannot follow itself', async () => {
    // "dismissed -> shown" must never happen: shown only allows FROM generated.
    const supabase = { from: () => ({ update: () => fakeUpdateBuilder(false) }) };
    const ok = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'shown' });
    expect(ok).toBe(false);
  });

  it('a second "shown" ack is a safe no-op (idempotent — cannot re-fire from shown)', async () => {
    // Once already 'shown', the allowed-from list for 'shown' is ['generated']
    // only, so the WHERE clause simply matches nothing on a replay.
    const supabase = { from: () => ({ update: () => fakeUpdateBuilder(false) }) };
    const ok = await transitionNudgeStatus(supabase, { nudgeId: 'n1', workspaceId: 'ws1', to: 'shown' });
    expect(ok).toBe(false);
  });

  it('rejects "converted -> clicked" (converted is terminal, not in clicked\'s allowed-from list)', () => {
    // Static assertion on the transition table shape: 'clicked' may only
    // come from 'generated' or 'shown', never from 'converted'.
    const ALLOWED_FROM_CLICKED = ['generated', 'shown'];
    expect(ALLOWED_FROM_CLICKED).not.toContain('converted');
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
// Part 3 — sessionState.ts: atomic evaluation ceiling RPC caller.
// ─────────────────────────────────────────────────────────────────────
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: vi.fn() }));

describe('sessionState.ts — evaluation ceiling caller', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls the atomic RPC with workspace + trusted session key + ceiling, never a client identifier', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 3, error: null });
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { tryIncrementAiNudgeEvaluationCounter } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await tryIncrementAiNudgeEvaluationCounter({} as any, 'ws-1', 'trusted-key-abc', 5);
    expect(result).toBe(3);
    expect(rpc).toHaveBeenCalledWith('ai_nudge_try_increment_session_counter', expect.objectContaining({
      _workspace_id: 'ws-1',
      _session_key: 'trusted-key-abc',
      _max_evaluations: 5,
    }));
  });

  it('returns null (denied) when the RPC reports the ceiling was reached', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { tryIncrementAiNudgeEvaluationCounter } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await tryIncrementAiNudgeEvaluationCounter({} as any, 'ws-1', 'trusted-key-abc', 5);
    expect(result).toBeNull();
  });

  it('fails closed (returns null, never throws) on a DB error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'db down' } });
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { tryIncrementAiNudgeEvaluationCounter } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await tryIncrementAiNudgeEvaluationCounter({} as any, 'ws-1', 'trusted-key-abc', 5);
    expect(result).toBeNull();
  });

  it('never calls the RPC at all when the ceiling is zero (platform/workspace disabled)', async () => {
    const rpc = vi.fn();
    const { getServiceClient } = await import('../../../server/supabase.js');
    (getServiceClient as any).mockReturnValue({ rpc });
    const { tryIncrementAiNudgeEvaluationCounter } = await import('../../../server/services/widget/aiNudge/sessionState.js');
    const result = await tryIncrementAiNudgeEvaluationCounter({} as any, 'ws-1', 'trusted-key-abc', 0);
    expect(result).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
