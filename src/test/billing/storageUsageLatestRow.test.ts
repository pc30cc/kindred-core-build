/**
 * storage_gb usage is cumulative occupancy, so it comes from the newest
 * counter row — not only the current month's. With no row yet this month
 * (no counter has written since the 1st), usage used to read 0 and a
 * workspace could upload past its limit until something created the row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CounterRow { period: string; storage_bytes: number }

let rows: CounterRow[] = [];
let failFallback = false;

function counters() {
  const filters: { period?: string; before?: string } = {};
  const q = {
    select: () => q,
    eq: (col: string, v: string) => {
      if (col === 'period') filters.period = v;
      return q;
    },
    lt: (_col: string, v: string) => {
      filters.before = v;
      return q;
    },
    order: () => q,
    limit: () => q,
    maybeSingle: async () => {
      if (filters.before !== undefined) {
        if (failFallback) return { data: null, error: { message: 'boom' } };
        const prior = rows.filter((r) => r.period < filters.before!).sort((a, b) => b.period.localeCompare(a.period))[0];
        return { data: prior ?? null, error: null };
      }
      return { data: rows.find((r) => r.period === filters.period) ?? null, error: null };
    },
  };
  return q;
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => counters() }) }));

const { resolveUsage, currentMonthPeriod } = await import('../../../server/services/billing/usageResolvers');

const config = { supabaseUrl: 'http://stub', supabaseServiceRoleKey: 'k' } as Parameters<typeof resolveUsage>[0];
const GB = 1024 ** 3;
const thisMonth = currentMonthPeriod();

beforeEach(() => {
  rows = [];
  failFallback = false;
});

describe('storage_gb usage', () => {
  it('reads the current month when its row exists', async () => {
    rows = [{ period: '2000-01', storage_bytes: 5 * GB }, { period: thisMonth, storage_bytes: 2 * GB }];
    const r = await resolveUsage(config, 'ws-1', 'storage_gb');
    expect(r.value).toBe(2);
  });

  it('carries the newest earlier month when this month has no row yet', async () => {
    rows = [{ period: '2000-01', storage_bytes: 1 * GB }, { period: '2000-02', storage_bytes: 3 * GB }];
    const r = await resolveUsage(config, 'ws-1', 'storage_gb');
    expect(r.value).toBe(3);
  });

  it('is 0 for a workspace that never stored anything', async () => {
    const r = await resolveUsage(config, 'ws-1', 'storage_gb');
    expect(r.value).toBe(0);
  });

  it('falls back to the old 0 if the earlier-month read fails', async () => {
    rows = [{ period: '2000-02', storage_bytes: 3 * GB }];
    failFallback = true;
    const r = await resolveUsage(config, 'ws-1', 'storage_gb');
    expect(r.value).toBe(0);
    expect(r.supported).toBe(true);
  });
});
