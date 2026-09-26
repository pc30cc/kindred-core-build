/**
 * AI billing recovery — the lease is taken only when there is something to
 * recover.
 *
 * The recovery lease is a write (acquire + release) on every 5-minute tick of
 * every replica. An install with no AI traffic paid it for passes that could
 * only ever return an all-zero report. runAiBillingRecoveryLeased() now asks
 * each step's predicate first (one `limit 1` read per step) and returns that
 * same all-zero report without touching the lease when nothing matches. Any
 * probe that cannot answer fails open: the pass runs exactly as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Rows each probed table returns; a table named in `failing` errors instead. */
let rows: Record<string, unknown[]> = {};
let failing = new Set<string>();
const rpcCalls: string[] = [];

function queryFor(table: string) {
  const q: any = {};
  for (const m of ['select', 'eq', 'lt', 'lte', 'gt', 'in', 'not', 'limit', 'update', 'order']) {
    q[m] = () => q;
  }
  q.then = (resolve: (v: unknown) => unknown) =>
    resolve(failing.has(table) ? { data: null, error: { message: `${table} unavailable` } } : { data: rows[table] ?? [], error: null });
  return q;
}

vi.mock('../../../server/supabase', () => ({
  getServiceClient: () => ({
    from: (table: string) => queryFor(table),
    rpc: async (name: string) => {
      rpcCalls.push(name);
      if (name === 'ai_billing_try_acquire_recovery_lease') return { data: true, error: null };
      if (name === 'ai_expire_lots') return { data: 0, error: null };
      return { data: null, error: null };
    },
  }),
}));

vi.mock('../../../server/services/ai-billing/runContext', () => ({ billingCycleId: () => '2026-01' }));

const config = {} as any;

beforeEach(() => {
  vi.resetModules();
  rows = {};
  failing = new Set();
  rpcCalls.length = 0;
});

describe('AI billing recovery lease probe', () => {
  it('returns an all-zero report without touching the lease when nothing is recoverable', async () => {
    const { runAiBillingRecoveryLeased } = await import('../../../server/services/ai-billing/recovery');
    const report = await runAiBillingRecoveryLeased(config);
    expect(report).toEqual({ releasedReservations: 0, closedRuns: 0, settledRuns: 0, expiredLots: 0, reconciled: 0 });
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ['workspace_ai_reservations'],
    ['ai_runs'],
    ['workspace_ai_balance_lots'],
  ])('takes the lease (and releases it) when %s has a candidate', async (table) => {
    rows[table] = [{ id: 'x' }];
    const { runAiBillingRecoveryLeased } = await import('../../../server/services/ai-billing/recovery');
    await runAiBillingRecoveryLeased(config);
    expect(rpcCalls[0]).toBe('ai_billing_try_acquire_recovery_lease');
    expect(rpcCalls).toContain('ai_billing_release_recovery_lease');
  });

  it('fails open: a probe that errors means the pass runs as before', async () => {
    failing.add('ai_runs');
    const { runAiBillingRecoveryLeased } = await import('../../../server/services/ai-billing/recovery');
    await runAiBillingRecoveryLeased(config);
    expect(rpcCalls[0]).toBe('ai_billing_try_acquire_recovery_lease');
  });
});
