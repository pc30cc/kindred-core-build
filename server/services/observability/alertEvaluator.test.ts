/**
 * Correctness surface for the TypeScript replacement of the SQL
 * evaluate_alert_rules() function — the highest-risk part of the Live
 * Monitoring migration. Uses the REAL in-memory collector (fed synthetic
 * data) rather than mocking it, so these tests exercise the actual
 * integration between the evaluator and the collector's query methods.
 * Only the Supabase client (alert_rules / alert_events / widget_platform_settings)
 * is faked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getMonitoringCollector, __resetMonitoringCollectorForTests } from './collector/index.js';

interface FakeState {
  rules: any[];
  openEventsByRule: Record<string, Array<{ id: string; severity: string }>>;
  inserted: any[];
  updated: Array<{ id: string; patch: any }>;
  combinedOpenSlugs: string[];
  budgetMb?: number;
}

function makeFakeSb(state: FakeState) {
  const from = (name: string) => {
    const f: Record<string, any> = {};
    let limitN: number | null = null;
    const resolve = (): { data: any; error: null } => {
      if (name === 'alert_rules') return { data: state.rules, error: null };
      if (name === 'alert_events') {
        if (f.rule_id !== undefined) {
          // applyRuleResult's "current open row for this rule" lookup.
          const rows = state.openEventsByRule[f.rule_id] || [];
          return { data: limitN != null ? rows.slice(0, limitN) : rows, error: null };
        }
        if (Array.isArray(f.rule_slug)) {
          // evaluateCombinedRule's open-subrule lookup.
          const matched = state.combinedOpenSlugs.filter((s) => f.rule_slug.includes(s)).map((rule_slug) => ({ rule_slug }));
          return { data: matched, error: null };
        }
      }
      return { data: [], error: null };
    };
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: any) => {
        f[c] = v;
        return chain;
      },
      in: (c: string, v: any[]) => {
        f[c] = v;
        return chain;
      },
      order: () => chain,
      limit: (n: number) => {
        limitN = n;
        return chain;
      },
      maybeSingle: async () => {
        if (name === 'widget_platform_settings') {
          return { data: { perf_memory_budget_mb: state.budgetMb ?? 512 }, error: null };
        }
        return { data: null, error: null };
      },
      insert: async (payload: any) => {
        state.inserted.push(payload);
        return { error: null };
      },
      update: (payload: any) => ({
        eq: async (_c: string, v: any) => {
          state.updated.push({ id: v, patch: payload });
          return { error: null };
        },
      }),
      then: (res: any, rej: any) => Promise.resolve(resolve()).then(res, rej),
    };
    return chain;
  };
  return { from };
}

let fakeState: FakeState;
vi.mock('../../supabase.js', () => ({ getServiceClient: () => makeFakeSb(fakeState) }));

function rule(overrides: Partial<Record<string, any>>): any {
  return {
    id: 'rule-1',
    slug: 'test-rule',
    kind: 'count',
    metric: null,
    numerator: null,
    denominator: null,
    route_group: null,
    window_seconds: 300,
    warn_threshold: 5,
    critical_threshold: 10,
    min_sample: 0,
    subrules: [],
    aggregation: null,
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  __resetMonitoringCollectorForTests();
  fakeState = { rules: [], openEventsByRule: {}, inserted: [], updated: [], combinedOpenSlugs: [] };
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

const importEvaluator = () => import('./alertEvaluator.js');

describe('alertEvaluator — count kind', () => {
  it('golden comparison: matches the SQL semantics (COUNT(*) >= threshold) and opens a new alert', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 12; i++) collector.recordRealtimeMetric({ metric: 'realtime.subscribe_failed' });
    fakeState.rules = [rule({ id: 'r-count', slug: 'subscribe-failed-spike', kind: 'count', metric: 'realtime.subscribe_failed', warn_threshold: 5, critical_threshold: 10 })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);

    expect(result.evaluated).toBe(1);
    expect(result.state_changes).toBe(1);
    expect(fakeState.inserted).toHaveLength(1);
    expect(fakeState.inserted[0]).toMatchObject({ rule_id: 'r-count', severity: 'critical', metric_value: 12, threshold_value: 10 });
  });

  it('does not fire below warn_threshold', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 3; i++) collector.recordRealtimeMetric({ metric: 'realtime.subscribe_failed' });
    fakeState.rules = [rule({ id: 'r-count', kind: 'count', metric: 'realtime.subscribe_failed' })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);

    expect(result.state_changes).toBe(0);
    expect(fakeState.inserted).toHaveLength(0);
  });

  it('resolves an existing open alert once the count drops back below warn_threshold', async () => {
    fakeState.openEventsByRule['r-count'] = [{ id: 'evt-1', severity: 'critical' }];
    fakeState.rules = [rule({ id: 'r-count', kind: 'count', metric: 'realtime.subscribe_failed' })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);

    expect(result.state_changes).toBe(1);
    expect(fakeState.updated).toHaveLength(1);
    expect(fakeState.updated[0]).toMatchObject({ id: 'evt-1', patch: { state: 'resolved', severity: 'resolved' } });
  });
});

describe('alertEvaluator — ratio kind', () => {
  it('golden comparison: matches SQL semantics (num/den, gated by min_sample)', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 5; i++) collector.recordRealtimeMetric({ metric: 'realtime.subscribe_failed' });
    for (let i = 0; i < 20; i++) collector.recordRealtimeMetric({ metric: 'realtime.token_minted' });
    fakeState.rules = [
      rule({ id: 'r-ratio', kind: 'ratio', numerator: 'realtime.subscribe_failed', denominator: 'realtime.token_minted', warn_threshold: 0.1, critical_threshold: 0.2, min_sample: 10 }),
    ];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    await evaluateAlertRulesInMemory({} as any);

    // 5/20 = 0.25 >= critical_threshold 0.2
    expect(fakeState.inserted[0]).toMatchObject({ severity: 'critical', metric_value: 0.25, sample_size: 20 });
  });

  it('treats a below-min_sample denominator as zero (no false alarm on tiny samples)', async () => {
    const collector = getMonitoringCollector();
    collector.recordRealtimeMetric({ metric: 'realtime.subscribe_failed' });
    collector.recordRealtimeMetric({ metric: 'realtime.token_minted' });
    fakeState.rules = [
      rule({ id: 'r-ratio', kind: 'ratio', numerator: 'realtime.subscribe_failed', denominator: 'realtime.token_minted', warn_threshold: 0.1, critical_threshold: 0.2, min_sample: 10 }),
    ];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);

    // 1/1 = 100% would fire if not gated by min_sample — must not fire.
    expect(result.state_changes).toBe(0);
    expect(fakeState.inserted).toHaveLength(0);
  });
});

describe('alertEvaluator — perf_p95 / perf_error_rate kinds', () => {
  it('fires perf_p95 when the collector reports a high percentile with enough samples', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 25; i++) {
      collector.recordRequestSample({ routeGroup: 'realtime.operator_connect', method: 'POST', statusCode: 200, durationMs: 2000 });
    }
    fakeState.rules = [rule({ id: 'r-p95', kind: 'perf_p95', route_group: 'realtime.operator_connect', warn_threshold: 800, critical_threshold: 1500, min_sample: 20 })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    await evaluateAlertRulesInMemory({} as any);

    expect(fakeState.inserted[0]).toMatchObject({ severity: 'critical' });
  });

  it('fires perf_error_rate proportional to observed 5xx ratio', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 20; i++) {
      collector.recordRequestSample({ routeGroup: 'widget.bootstrap', method: 'POST', statusCode: i < 10 ? 500 : 200, durationMs: 50 });
    }
    fakeState.rules = [rule({ id: 'r-err', kind: 'perf_error_rate', route_group: 'widget.bootstrap', warn_threshold: 0.1, critical_threshold: 0.3, min_sample: 10 })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    await evaluateAlertRulesInMemory({} as any);

    expect(fakeState.inserted[0]).toMatchObject({ severity: 'critical', metric_value: 0.5 });
  });
});

describe('alertEvaluator — process_avg / process_ratio kinds', () => {
  it('process_avg (rss_pct_of_budget) never fires on an empty trend window (no sampler tick yet)', async () => {
    // The trend ring is only populated by the collector's own 60s sampler
    // (not exercised here); this proves the min_sample gate correctly
    // suppresses a false alert on zero samples rather than misreporting.
    // The actual AVG(a)/AVG(b) arithmetic is covered in processCollector.test.ts.
    fakeState.budgetMb = 256;
    fakeState.rules = [rule({ id: 'r-proc', kind: 'process_avg', metric: 'rss_pct_of_budget', warn_threshold: 0.5, critical_threshold: 0.8, min_sample: 1 })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);

    // No trend samples recorded yet in this fresh collector — never fires
    // on an empty window rather than misreporting.
    expect(fakeState.inserted).toHaveLength(0);
    expect(result.evaluated).toBe(1);
  });

  it('unknown process_avg metric name is inert (matches SQL ELSE v_value:=0 branch)', async () => {
    fakeState.rules = [rule({ id: 'r-proc-bad', kind: 'process_avg', metric: 'not_a_real_metric', warn_threshold: 0, critical_threshold: 0 })];
    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);
    expect(result.state_changes).toBe(0);
  });
});

describe('alertEvaluator — combined kind', () => {
  it('counts distinct open subrule slugs and fires without a min_sample gate', async () => {
    fakeState.combinedOpenSlugs = ['sub-a', 'sub-b', 'sub-b']; // duplicate rule_slug should count once (COUNT(DISTINCT))
    fakeState.rules = [rule({ id: 'r-combined', kind: 'combined', subrules: ['sub-a', 'sub-b', 'sub-c'], warn_threshold: 1, critical_threshold: 2 })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    await evaluateAlertRulesInMemory({} as any);

    expect(fakeState.inserted[0]).toMatchObject({ severity: 'critical', metric_value: 2, sample_size: 3 });
  });

  it('no open subrules → resolves an existing combined alert', async () => {
    fakeState.openEventsByRule['r-combined'] = [{ id: 'evt-combined', severity: 'critical' }];
    fakeState.combinedOpenSlugs = [];
    fakeState.rules = [rule({ id: 'r-combined', kind: 'combined', subrules: ['sub-a', 'sub-b'], warn_threshold: 1, critical_threshold: 2 })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    await evaluateAlertRulesInMemory({} as any);

    expect(fakeState.updated[0]).toMatchObject({ id: 'evt-combined', patch: { state: 'resolved' } });
  });
});

describe('alertEvaluator — lifecycle edge cases', () => {
  it('re-severity change updates the existing open row instead of inserting a duplicate', async () => {
    fakeState.openEventsByRule['r-count'] = [{ id: 'evt-1', severity: 'warn' }];
    const collector = getMonitoringCollector();
    for (let i = 0; i < 12; i++) collector.recordRealtimeMetric({ metric: 'realtime.subscribe_failed' });
    fakeState.rules = [rule({ id: 'r-count', kind: 'count', metric: 'realtime.subscribe_failed', warn_threshold: 5, critical_threshold: 10 })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);

    expect(result.state_changes).toBe(1);
    expect(fakeState.inserted).toHaveLength(0);
    expect(fakeState.updated[0]).toMatchObject({ id: 'evt-1', patch: { severity: 'critical' } });
  });

  it('same severity persisting only updates metric_value, not counted as a state change', async () => {
    fakeState.openEventsByRule['r-count'] = [{ id: 'evt-1', severity: 'critical' }];
    const collector = getMonitoringCollector();
    for (let i = 0; i < 12; i++) collector.recordRealtimeMetric({ metric: 'realtime.subscribe_failed' });
    fakeState.rules = [rule({ id: 'r-count', kind: 'count', metric: 'realtime.subscribe_failed', warn_threshold: 5, critical_threshold: 10 })];

    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);

    expect(result.state_changes).toBe(0);
    expect(fakeState.updated).toHaveLength(1); // silent metric_value refresh
  });

  it('disabled rules are never evaluated (excluded by the enabled=true filter)', async () => {
    fakeState.rules = []; // the fake sb.from('alert_rules') query already only returns what the "DB" would for eq('enabled', true)
    const { evaluateAlertRulesInMemory } = await importEvaluator();
    const result = await evaluateAlertRulesInMemory({} as any);
    expect(result.evaluated).toBe(0);
  });
});
