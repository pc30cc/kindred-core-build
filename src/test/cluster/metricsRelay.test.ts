// @vitest-environment node
/**
 * Monitoring samples in cluster mode (server/cluster/metricsRelay.ts): a
 * sample recorded on worker A reaches worker B exactly once, through the
 * primary, and B never sends it on; so each worker's collector — what
 * failover, alerting and the admin pages read — holds the container's totals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BATCH, RELAY_EVERY_MS, RelayingMonitoringCollector } from '../../../server/cluster/metricsRelay.js';
import { __createMonitoringCollectorForTests } from '../../../server/services/observability/collector/index.js';
import type { MetricsBatch } from '../../../server/cluster/protocol.js';

/** Two workers and a primary that passes each batch to every other worker, as primary.ts does. */
function cluster() {
  const sent: Array<{ from: number; batch: MetricsBatch }> = [];
  const workers: RelayingMonitoringCollector[] = [];
  const make = (index: number) =>
    new RelayingMonitoringCollector(__createMonitoringCollectorForTests(), (message) => {
      const batch = (message as { batch: MetricsBatch }).batch;
      sent.push({ from: index, batch });
      workers.forEach((w, i) => { if (i !== index) w.ingest(batch); });
    });
  workers.push(make(0), make(1));
  return { a: workers[0], b: workers[1], sent };
}

afterEach(() => vi.useRealTimers());

/**
 * The fake clock starts early in a minute: the error-rate window reads the
 * current minute's slot, so a run starting in a minute's last seconds would
 * see the samples recorded at its start in the previous slot.
 */
const START = new Date('2026-01-01T00:00:10Z');

describe('the metrics relay', () => {
  it('a sample recorded on A is ingested by B once, after the relay interval, and not sent on', () => {
    vi.useFakeTimers({ now: START });
    const { a, b, sent } = cluster();
    for (let i = 0; i < 10; i++) a.recordRequestSample({ routeGroup: 'widget', method: 'GET', statusCode: i < 2 ? 500 : 200, durationMs: 20 });
    for (let i = 0; i < 4; i++) b.recordRequestSample({ routeGroup: 'widget', method: 'GET', statusCode: 200, durationMs: 20 });
    a.recordRealtimeMetric({ metric: 'realtime.token_minted', driver: 'centrifugo' });
    expect(b.queryPerfErrorRate('widget', 60)).toEqual({ rate: 0, sample: 4 });
    vi.advanceTimersByTime(RELAY_EVERY_MS);
    // Each worker sent its own batch once; nothing ingested was sent again.
    expect(sent.map((s) => s.from).sort()).toEqual([0, 1]);
    expect(sent.find((s) => s.from === 0)!.batch.perf).toHaveLength(10);
    expect(sent.find((s) => s.from === 1)!.batch.perf).toHaveLength(4);
    vi.advanceTimersByTime(RELAY_EVERY_MS * 5);
    expect(sent).toHaveLength(2);
    // Both see the container's totals.
    expect(b.queryPerfErrorRate('widget', 60)).toEqual({ rate: 2 / 14, sample: 14 });
    expect(a.queryPerfErrorRate('widget', 60)).toEqual({ rate: 2 / 14, sample: 14 });
    expect(b.queryRealtimeCount('realtime.token_minted', 60)).toBe(1);
    expect(b.queryRealtimeCountByDriver('realtime.token_minted', 'centrifugo', 60)).toBe(1);
  });

  it(`a batch holds at most ${MAX_BATCH} samples`, () => {
    vi.useFakeTimers({ now: START });
    const { a, sent } = cluster();
    for (let i = 0; i < MAX_BATCH + 5; i++) a.recordRequestSample({ routeGroup: 'widget', method: 'GET', statusCode: 200, durationMs: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].batch.perf).toHaveLength(MAX_BATCH);
    vi.advanceTimersByTime(RELAY_EVERY_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1].batch.perf).toHaveLength(5);
  });

  it('a malformed batch is ignored', () => {
    const { b } = cluster();
    b.ingest(null);
    b.ingest({ realtime: [null, 7, { nope: 1 }], perf: 'x' } as unknown as MetricsBatch);
    expect(b.queryPerfErrorRate('widget', 60).sample).toBe(0);
  });
});
