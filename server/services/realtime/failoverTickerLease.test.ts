/**
 * The failover ticker takes its cluster lease only when there is something to
 * commit.
 *
 * The lease is two database writes (acquire + release). Taken on every 30s
 * tick it was the single largest periodic writer — ~5,760 writes a day — to
 * arrive at "nothing changed" almost every time. The engine is pure and the
 * evaluation is read-only, so the ticker now decides first and leases only for
 * a transition, a material change against the STORED row, or the stored
 * 15-minute heartbeat.
 *
 * Runs the real decision engine and the real state module against a fake
 * database; only the lease, the health probe and the policy are stubbed.
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

const lease = {
  acquire: vi.fn(async () => true),
  release: vi.fn(async () => undefined),
};
vi.mock('../observability/tickerLease.js', () => ({
  acquireTickerLease: () => lease.acquire(),
  releaseTickerLease: () => lease.release(),
}));

const audit = vi.fn(async () => undefined);
vi.mock('./providerAudit.js', () => ({ recordRealtimeProviderAudit: () => audit() }));
vi.mock('./resolvePublisher.js', () => ({ invalidatePublisherCache: () => undefined }));
vi.mock('../observability/metrics.js', () => ({ emitLog: () => undefined }));

let policy: any;
vi.mock('./controlPlane.js', () => ({ loadControlPlane: async () => policy }));

let providers: Record<string, any>;
vi.mock('./failoverHealth.js', () => ({
  evaluateProviderHealth: async () => ({ window_seconds: 300, evaluated_at: Date.now(), providers }),
}));

const cfg = {} as any;

function signal(status: string) {
  return { status, error_rate: 0.001, p95_latency_ms: 12, sample_size: 20, reason: null, checked_at: Date.now() };
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'singleton',
    effective_provider: 'centrifugo',
    last_failover_at: null,
    last_failover_reason: null,
    candidate_recovery_provider: null,
    candidate_recovery_since: null,
    failback_eligible_at: null,
    cooldown_until: null,
    last_health: { centrifugo: signal('healthy'), supabase_realtime: signal('healthy'), polling_builtin: signal('healthy') },
    last_evaluated_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function tick() {
  const state = await import('./failoverState.js');
  state.__resetFailoverStateCacheForTests();
  const { runFailoverTickOnce } = await import('./failoverTicker.js');
  await runFailoverTickOnce(cfg);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  policy = {
    realtime_failover_enabled: false,
    realtime_failback_enabled: true,
    realtime_failover_cooldown_seconds: 300,
    realtime_failback_stable_window_seconds: 600,
    realtime_failover_error_threshold: 0.05,
    realtime_failover_latency_threshold_ms: 2000,
    realtime_failover_health_window_seconds: 300,
    realtime_provider_order: ['centrifugo', 'supabase_realtime', 'polling_builtin'],
    realtime_provider_lock: null,
  };
  providers = { centrifugo: signal('healthy'), supabase_realtime: signal('healthy'), polling_builtin: signal('healthy') };
  db.row = storedRow();
  db.upserts = [];
  lease.acquire.mockClear();
  lease.acquire.mockImplementation(async () => true);
  lease.release.mockClear();
  audit.mockClear();
});

describe('failover ticker lease', () => {
  it('takes no lease and writes nothing when the stored row already says it all', async () => {
    await tick();
    expect(lease.acquire).not.toHaveBeenCalled();
    expect(db.upserts).toHaveLength(0);
  });

  it('latency jitter alone is still not a reason to lease or write', async () => {
    providers.centrifugo = { ...signal('healthy'), p95_latency_ms: 900, error_rate: 0.02 };
    await tick();
    expect(lease.acquire).not.toHaveBeenCalled();
    expect(db.upserts).toHaveLength(0);
  });

  it('leases and writes once the stored heartbeat is 15 minutes old', async () => {
    db.row = storedRow({ last_evaluated_at: new Date(Date.now() - 16 * 60_000).toISOString() });
    await tick();
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    expect(db.upserts).toHaveLength(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('leases and writes when there is no stored row yet', async () => {
    db.row = null;
    await tick();
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    expect(db.upserts).toHaveLength(1);
  });

  it('a provider health STATUS change is material: lease + write', async () => {
    providers.centrifugo = signal('degraded');
    await tick();
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    expect(db.upserts).toHaveLength(1);
    expect(db.row.last_health.centrifugo.status).toBe('degraded');
  });

  it('a transition is committed under the lease, audited, and the lease released', async () => {
    policy.realtime_provider_lock = 'polling_builtin';
    await tick();
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    expect(db.upserts).toHaveLength(1);
    expect(db.row.effective_provider).toBe('polling_builtin');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when another replica holds the lease', async () => {
    policy.realtime_provider_lock = 'polling_builtin';
    lease.acquire.mockImplementation(async () => false);
    await tick();
    expect(lease.acquire).toHaveBeenCalledTimes(1);
    expect(db.upserts).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
    expect(lease.release).not.toHaveBeenCalled();
  });

  it('compares against the stored row, not against what this process last wrote', async () => {
    // This process persists "degraded"...
    providers.centrifugo = signal('degraded');
    await tick();
    expect(db.upserts).toHaveLength(1);
    // ...then another replica writes "healthy" behind its back. The next
    // evaluation still says "degraded", which now differs from the ROW, so
    // it must be written again even though this process wrote that exact
    // value a moment ago.
    db.row = { ...db.row, last_health: { ...db.row.last_health, centrifugo: signal('healthy') } };
    const { runFailoverTickOnce } = await import('./failoverTicker.js');
    await runFailoverTickOnce(cfg);
    expect(db.upserts).toHaveLength(2);
    expect(db.row.last_health.centrifugo.status).toBe('degraded');
  });
});
