/**
 * failoverHealth.ts was repointed from direct Supabase selects on
 * realtime_metric_events / perf_request_samples to synchronous reads
 * against the Live Monitoring collector. These tests use the REAL
 * collector (fed synthetic data) to prove the health classification is
 * unchanged by that migration — only the data source moved.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getMonitoringCollector, __resetMonitoringCollectorForTests } from '../observability/collector/index.js';
import type { RealtimeFailoverPolicy } from './controlPlane.js';

vi.mock('./index.js', () => ({
  getCentrifugoDriver: async () => ({ health: async () => ({ status: 'healthy', message: '' }) }),
  loadRealtimeConfig: async () => ({}),
}));

const policy: RealtimeFailoverPolicy = {
  realtime_failover_enabled: true,
  realtime_failover_cooldown_seconds: 60,
  realtime_failover_error_threshold: 0.1,
  realtime_failover_latency_threshold_ms: 800,
  realtime_failover_health_window_seconds: 300,
} as RealtimeFailoverPolicy;

beforeEach(() => {
  __resetMonitoringCollectorForTests();
});

const importHealth = () => import('./failoverHealth.js');

describe('evaluateProviderHealth — centrifugo', () => {
  it('classifies healthy when error rate and latency are both within threshold', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 100; i++) {
      collector.recordRealtimeMetric({ metric: 'realtime.token_minted', driver: 'centrifugo' });
    }
    for (let i = 0; i < 30; i++) {
      collector.recordRequestSample({ routeGroup: 'realtime.operator_connect', method: 'POST', statusCode: 200, durationMs: 50 });
    }
    const { evaluateProviderHealth } = await importHealth();
    const snapshot = await evaluateProviderHealth({} as any, policy);
    expect(snapshot.providers.centrifugo.status).toBe('healthy');
  });

  it('classifies unhealthy when the error rate is over 2x the threshold', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 20; i++) {
      collector.recordRealtimeMetric({ metric: 'realtime.subscribe_failed', driver: 'centrifugo' });
    }
    for (let i = 0; i < 80; i++) {
      collector.recordRealtimeMetric({ metric: 'realtime.token_minted', driver: 'centrifugo' });
    }
    const { evaluateProviderHealth } = await importHealth();
    const snapshot = await evaluateProviderHealth({} as any, policy);
    // 20 errors / 100 total = 20% >= 2x the 10% threshold.
    expect(snapshot.providers.centrifugo.status).toBe('unhealthy');
    expect(snapshot.providers.centrifugo.error_rate).toBeCloseTo(0.2);
  });

  it('classifies degraded on high p95 latency alone', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 40; i++) {
      collector.recordRealtimeMetric({ metric: 'realtime.token_minted', driver: 'centrifugo' });
    }
    for (let i = 0; i < 30; i++) {
      collector.recordRequestSample({ routeGroup: 'realtime.operator_connect', method: 'POST', statusCode: 200, durationMs: 900 });
    }
    const { evaluateProviderHealth } = await importHealth();
    const snapshot = await evaluateProviderHealth({} as any, policy);
    expect(snapshot.providers.centrifugo.status).toBe('degraded');
  });

  it('isolates driver-tagged error rates — a supabase error burst does not affect the centrifugo signal', async () => {
    const collector = getMonitoringCollector();
    for (let i = 0; i < 50; i++) collector.recordRealtimeMetric({ metric: 'realtime.token_minted', driver: 'centrifugo' });
    for (let i = 0; i < 50; i++) collector.recordRealtimeMetric({ metric: 'realtime.subscribe_failed', driver: 'supabase' });
    const { evaluateProviderHealth } = await importHealth();
    const snapshot = await evaluateProviderHealth({} as any, policy);
    expect(snapshot.providers.centrifugo.error_rate).toBe(0);
  });
});

describe('evaluateProviderHealth — polling_builtin', () => {
  it('is always healthy by definition', async () => {
    const { evaluateProviderHealth } = await importHealth();
    const snapshot = await evaluateProviderHealth({} as any, policy);
    expect(snapshot.providers.polling_builtin.status).toBe('healthy');
  });
});
