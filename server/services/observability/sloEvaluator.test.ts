/**
 * An open SLO breach is bumped at most once per evaluation cycle,
 * cluster-wide. Every replica evaluates every 60s; counting each pass made
 * consecutive_breaches climb replica-count times a minute, so enforcement
 * rules gated on min_consecutive_breaches fired N times sooner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerConfig } from '../../config.js';

type Row = Record<string, unknown>;

interface BreachRow {
  id: string;
  state: string;
  consecutive_breaches: number;
  last_breach_at: string;
  [column: string]: unknown;
}

let breach: BreachRow;
const updates: Array<{ patch: Row; filters: Array<[string, unknown]> }> = [];

function query(table: string) {
  const filters: Array<[string, unknown]> = [];
  let patch: Row | null = null;
  const q = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return q;
    },
    gte: () => q,
    order: () => q,
    limit: () => q,
    update: (p: Row) => {
      patch = p;
      return q;
    },
    insert: async () => ({ error: null }),
    maybeSingle: async () => {
      if (table === 'slo_breach_events' && filters.some(([c, v]) => c === 'state' && v === 'open')) {
        return { data: { ...breach }, error: null };
      }
      return { data: null, error: null };
    },
    then: (resolve: (v: unknown) => unknown) => {
      if (patch) {
        updates.push({ patch, filters: [...filters] });
        const matches = filters.every(([c, v]) => breach[c] === v);
        if (matches) Object.assign(breach, patch);
        return resolve({ data: null, error: null });
      }
      if (table === 'slo_definitions') {
        return resolve({
          data: [{
            id: 'slo-1', slug: 'platform_uptime_24h', scope_type: 'platform', metric_key: 'uptime_pct',
            target_type: 'min', target_value: 99, window_seconds: 86400, enabled: true,
          }],
          error: null,
        });
      }
      if (table === 'sla_reliability_hourly') {
        return resolve({
          data: [{ scope_type: 'platform', scope_key: 'platform', uptime_pct: 90, bucket_hour: new Date().toISOString() }],
          error: null,
        });
      }
      if (table === 'slo_breach_events') {
        return resolve({ data: [{ slo_id: 'slo-1', scope_type: 'platform', scope_key: 'platform' }], error: null });
      }
      return resolve({ data: [], error: null });
    },
  };
  return q;
}

vi.mock('../../supabase.js', () => ({ getServiceClient: () => ({ from: (t: string) => query(t) }) }));
vi.mock('./metrics.js', () => ({ emitLog: () => undefined }));

const cfg = {} as ServerConfig;
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
  updates.length = 0;
  breach = { id: 'b-1', state: 'open', consecutive_breaches: 2, last_breach_at: secondsAgo(60) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SLO breach bump gate', () => {
  it('bumps a breach last counted a cycle ago', async () => {
    const { runSloEvaluation } = await import('./sloEvaluator.js');
    const result = await runSloEvaluation(cfg);
    expect(result.bumped).toBe(1);
    expect(breach.consecutive_breaches).toBe(3);
  });

  it('does not bump — or write — a breach another replica already counted this cycle', async () => {
    breach.last_breach_at = secondsAgo(20);
    const { runSloEvaluation } = await import('./sloEvaluator.js');
    const result = await runSloEvaluation(cfg);
    expect(result.bumped).toBe(0);
    expect(updates).toHaveLength(0);
    expect(breach.consecutive_breaches).toBe(2);
  });

  it('two replicas passing the gate together bump once', async () => {
    const { runSloEvaluation } = await import('./sloEvaluator.js');
    await Promise.all([runSloEvaluation(cfg), runSloEvaluation(cfg)]);
    expect(breach.consecutive_breaches).toBe(3);
    // Both conditioned their write on the count they read.
    expect(updates.every((u) => u.filters.some(([c, v]) => c === 'consecutive_breaches' && v === 2))).toBe(true);
  });
});
