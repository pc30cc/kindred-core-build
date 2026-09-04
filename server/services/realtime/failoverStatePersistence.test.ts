/**
 * Regression suite for write-on-change persistence of
 * `realtime_failover_state` (a single row that the 30s failover ticker used
 * to rewrite on every tick).
 *
 * Guarantees asserted here:
 *   1. latency / error-rate jitter alone      -> NO Postgres write
 *   2. a provider health STATUS transition    -> write
 *   3. an effective-provider failover change  -> write
 *   4. a genuine no-op                        -> no write until the 15min
 *                                                heartbeat comes due
 *
 * Guard #2 previously regressed: the engine stores `health.providers`
 * directly in `last_health`, while the signature helper looked for a nested
 * `.providers` key, so status transitions were invisible to the change
 * detector.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeDb {
  row: any;
  upserts: any[];
}

const db: FakeDb = { row: null, upserts: [] };

vi.mock('../../supabase.js', () => ({
  getServiceClient: () => ({
    from: (_name: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: db.row, error: null }),
        }),
      }),
      upsert: async (payload: any) => {
        db.upserts.push(payload);
        db.row = { ...payload };
        return { error: null };
      },
    }),
  }),
}));

const cfg = {} as any;

function health(statuses: Record<string, string>, latency = 10): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, status] of Object.entries(statuses)) {
    out[k] = { status, p95_latency_ms: latency, error_rate: latency / 1000, sample_size: 20 };
  }
  return out;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  db.row = {
    id: 'singleton',
    effective_provider: 'centrifugo',
    last_failover_at: null,
    last_failover_reason: null,
    candidate_recovery_provider: null,
    candidate_recovery_since: null,
    failback_eligible_at: null,
    cooldown_until: null,
    last_health: health({ centrifugo: 'healthy', polling_builtin: 'healthy' }),
    last_evaluated_at: null,
    updated_at: new Date().toISOString(),
  };
  db.upserts = [];
  const mod = await import('./failoverState.js');
  mod.__resetFailoverStateCacheForTests();
});

const load = () => import('./failoverState.js');

describe('failoverState — write-on-change persistence', () => {
  it('persists the first evaluation, then skips a pure latency/error-rate jitter tick', async () => {
    const { saveFailoverState } = await load();

    await saveFailoverState(cfg, {
      last_health: health({ centrifugo: 'healthy', polling_builtin: 'healthy' }, 11),
      last_evaluated_at: new Date().toISOString(),
    });
    expect(db.upserts).toHaveLength(1); // cold start: nothing persisted yet this process

    // 10 more ticks, 30s apart, where only latency and error rate move.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(30_000);
      await saveFailoverState(cfg, {
        last_health: health({ centrifugo: 'healthy', polling_builtin: 'healthy' }, 12 + i * 7),
        last_evaluated_at: new Date().toISOString(),
      });
    }
    expect(db.upserts).toHaveLength(1); // jitter never reaches Postgres
  });

  it('persists immediately when a provider health STATUS changes', async () => {
    const { saveFailoverState } = await load();
    await saveFailoverState(cfg, { last_health: health({ centrifugo: 'healthy', polling_builtin: 'healthy' }) });
    const before = db.upserts.length;

    vi.advanceTimersByTime(30_000);
    await saveFailoverState(cfg, { last_health: health({ centrifugo: 'degraded', polling_builtin: 'healthy' }) });
    expect(db.upserts).toHaveLength(before + 1);

    vi.advanceTimersByTime(30_000);
    await saveFailoverState(cfg, { last_health: health({ centrifugo: 'unhealthy', polling_builtin: 'healthy' }) });
    expect(db.upserts).toHaveLength(before + 2);

    vi.advanceTimersByTime(30_000);
    await saveFailoverState(cfg, { last_health: health({ centrifugo: 'healthy', polling_builtin: 'healthy' }) });
    expect(db.upserts).toHaveLength(before + 3);
  });

  it('persists an effective-provider failover transition', async () => {
    const { saveFailoverState } = await load();
    await saveFailoverState(cfg, { last_health: health({ centrifugo: 'healthy' }) });
    const before = db.upserts.length;

    vi.advanceTimersByTime(30_000);
    await saveFailoverState(cfg, {
      effective_provider: 'polling_builtin',
      last_failover_at: new Date().toISOString(),
      last_failover_reason: 'centrifugo_unhealthy',
      last_health: health({ centrifugo: 'healthy' }),
    });
    expect(db.upserts).toHaveLength(before + 1);
    expect(db.upserts[db.upserts.length - 1].effective_provider).toBe('polling_builtin');
  });

  it('a genuine no-op does not persist until the 15 minute heartbeat comes due', async () => {
    const { saveFailoverState } = await load();
    const snapshot = health({ centrifugo: 'healthy', polling_builtin: 'healthy' });
    await saveFailoverState(cfg, { last_health: snapshot, last_evaluated_at: new Date().toISOString() });
    const before = db.upserts.length;

    // 29 identical ticks over ~14.5 minutes.
    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(30_000);
      await saveFailoverState(cfg, { last_health: snapshot, last_evaluated_at: new Date().toISOString() });
    }
    expect(db.upserts).toHaveLength(before);

    // Crossing the 15 minute mark writes exactly one heartbeat row.
    vi.advanceTimersByTime(30_000);
    await saveFailoverState(cfg, { last_health: snapshot, last_evaluated_at: new Date().toISOString() });
    expect(db.upserts).toHaveLength(before + 1);
  });

  it('nested {providers:{...}} health shape is still understood', async () => {
    const { saveFailoverState } = await load();
    await saveFailoverState(cfg, { last_health: { providers: health({ centrifugo: 'healthy' }) } });
    const before = db.upserts.length;

    vi.advanceTimersByTime(30_000);
    await saveFailoverState(cfg, { last_health: { providers: health({ centrifugo: 'healthy' }, 999) } });
    expect(db.upserts).toHaveLength(before); // latency only

    vi.advanceTimersByTime(30_000);
    await saveFailoverState(cfg, { last_health: { providers: health({ centrifugo: 'unavailable' }) } });
    expect(db.upserts).toHaveLength(before + 1); // status change
  });
});
