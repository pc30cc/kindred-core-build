/**
 * Cancelling a subscription stops the NEXT renewal; it must not take away the
 * remainder of the period the customer already paid for.
 *
 * The bug: cancel (route and provider webhook) wrote `status: 'canceled'`
 * together with `cancel_at_period_end: true`. Every entitlement check requires
 * active/trialing, so access ended the moment the customer clicked cancel.
 * And resume set `active` even after the period had ended.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;
type Filter = [string, string, unknown];
interface FakeBuilder {
  _patch: Row | null;
  _filters: Filter[];
  update: (patch: Row) => FakeBuilder;
  eq: (c: string, v: unknown) => FakeBuilder;
  in: (c: string, v: unknown) => FakeBuilder;
  lte: (c: string, v: unknown) => FakeBuilder;
  select: () => Promise<{ data: Row[]; error: null }>;
}

const updates: Array<{ patch: Row; filters: Array<[string, string, unknown]> }> = [];
let expiredRows: Row[] = [];
const entitlementCalls: Row[] = [];

function fakeClient() {
  return {
    from: (_table: string) => {
      const b: FakeBuilder = {
        _patch: null,
        _filters: [],
        update: (patch: Row) => { b._patch = patch; return b; },
        eq: (c: string, v: unknown) => { b._filters.push(['eq', c, v]); return b; },
        in: (c: string, v: unknown) => { b._filters.push(['in', c, v]); return b; },
        lte: (c: string, v: unknown) => { b._filters.push(['lte', c, v]); return b; },
        select: async () => {
          updates.push({ patch: b._patch, filters: b._filters });
          return { data: expiredRows, error: null };
        },
      };
      return b;
    },
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/services/billing/entitlementChange.js', () => ({
  handleWorkspaceEntitlementChanged: async (_c: unknown, input: Row) => {
    entitlementCalls.push(input);
    return { ok: true, cacheCleared: true, catchupEnqueued: 0 };
  },
}));

const { buildCancelAtPeriodEndPatch, decideResume, expireCanceledSubscriptions } = await import(
  '../../../server/services/billing/cancellation.js'
);

const NOW = new Date('2026-09-26T12:00:00.000Z');
const FUTURE = '2026-10-10T00:00:00.000Z';
const PAST = '2026-09-20T00:00:00.000Z';

beforeEach(() => {
  updates.length = 0;
  entitlementCalls.length = 0;
  expiredRows = [];
});

describe('cancel at period end', () => {
  for (const status of ['active', 'trialing'] as const) {
    it(`keeps a ${status} subscription ${status} while its paid period runs`, () => {
      const patch = buildCancelAtPeriodEndPatch({ status, current_period_end: FUTURE }, NOW);
      expect(patch).not.toHaveProperty('status');
      expect(patch.cancel_at_period_end).toBe(true);
      expect(patch.canceled_at).toBe(NOW.toISOString());
    });
  }

  it('cancels right away when there is no remaining period', () => {
    expect(buildCancelAtPeriodEndPatch({ status: 'active', current_period_end: PAST }, NOW).status).toBe('canceled');
    expect(buildCancelAtPeriodEndPatch({ status: 'active', current_period_end: null }, NOW).status).toBe('canceled');
  });
});

describe('resume', () => {
  it('reactivates a scheduled cancellation while the period still runs, keeping the status', () => {
    const d = decideResume({ status: 'active', cancel_at_period_end: true, current_period_end: FUTURE }, NOW);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.patch).toMatchObject({ status: 'active', cancel_at_period_end: false, canceled_at: null });
    expect(d.statusChanged).toBe(false);

    const t = decideResume({ status: 'trialing', cancel_at_period_end: true, current_period_end: FUTURE }, NOW);
    expect(t.ok && t.patch.status).toBe('trialing');
  });

  it('restores a row an older build marked canceled while its period was still running', () => {
    const d = decideResume({ status: 'canceled', cancel_at_period_end: true, current_period_end: FUTURE }, NOW);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.patch.status).toBe('active');
    expect(d.statusChanged).toBe(true);
  });

  it('refuses once the period has ended', () => {
    const d = decideResume({ status: 'canceled', cancel_at_period_end: true, current_period_end: PAST }, NOW);
    expect(d.ok).toBe(false);
    // `in` narrowing: the app tsconfig is not strict, so `if (d.ok)` does not narrow the union.
    if (!('code' in d)) return;
    expect(d.code).toBe('SUBSCRIPTION_PERIOD_ENDED');
    const a = decideResume({ status: 'active', cancel_at_period_end: true, current_period_end: PAST }, NOW);
    expect(a.ok).toBe(false);
  });

  it('refuses a subscription that was canceled outright (not at period end)', () => {
    const d = decideResume({ status: 'expired', cancel_at_period_end: false, current_period_end: FUTURE }, NOW);
    expect(d.ok).toBe(false);
    // `in` narrowing: the app tsconfig is not strict, so `if (d.ok)` does not narrow the union.
    if (!('code' in d)) return;
    expect(d.code).toBe('SUBSCRIPTION_NOT_RESUMABLE');
  });
});

describe('period-end expiry (billing tick)', () => {
  it('only ends live subscriptions scheduled to cancel whose period has passed', async () => {
    expiredRows = [{ workspace_id: 'ws-a' }, { workspace_id: 'ws-b' }];
    const r = await expireCanceledSubscriptions({} as Parameters<typeof expireCanceledSubscriptions>[0], NOW);

    expect(r).toEqual({ expired: 2 });
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.status).toBe('canceled');
    expect(updates[0].filters).toContainEqual(['eq', 'cancel_at_period_end', true]);
    expect(updates[0].filters).toContainEqual(['in', 'status', ['active', 'trialing', 'past_due']]);
    expect(updates[0].filters).toContainEqual(['lte', 'current_period_end', NOW.toISOString()]);
    expect(entitlementCalls).toEqual([
      { workspaceId: 'ws-a', source: 'subscription_canceled' },
      { workspaceId: 'ws-b', source: 'subscription_canceled' },
    ]);
  });
});
