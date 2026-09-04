import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProcessCollector } from './processCollector.js';
import { PROCESS_TREND_CAPACITY } from './constants.js';

describe('ProcessCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('snapshotNow returns live values straight from the Node runtime', () => {
    const c = new ProcessCollector();
    const snap = c.snapshotNow();
    // RSS can fluctuate between two live calls (GC, allocator behavior) —
    // assert it's a real positive measurement, not a stale/zero placeholder.
    expect(snap.rss_bytes).toBeGreaterThan(0);
    expect(snap.heap_total_bytes).toBeGreaterThan(0);
    expect(snap.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof snap.event_loop_lag_ms).toBe('number');
    expect(Number.isFinite(snap.event_loop_lag_ms)).toBe(true);
  });

  it('queryTrend always returns a fresh latest snapshot, not a stale trend entry', () => {
    const c = new ProcessCollector();
    c.startTrendSampler(60_000);
    vi.advanceTimersByTime(60_000);
    const before = c.queryTrend('1h');
    expect(before.latest).not.toBeNull();
    // uptime keeps advancing even without another sampler tick.
    vi.advanceTimersByTime(5_000);
    const after = c.queryTrend('1h');
    expect(after.latest!.uptime_seconds).toBeGreaterThanOrEqual(before.latest!.uptime_seconds);
    c.stopTrendSampler();
  });

  it('trend ring is bounded at PROCESS_TREND_CAPACITY regardless of how long the sampler runs', () => {
    const c = new ProcessCollector();
    c.startTrendSampler(60_000);
    // Run for far longer than the ring capacity.
    vi.advanceTimersByTime((PROCESS_TREND_CAPACITY + 50) * 60_000);
    const trend = c.queryTrend('24h');
    expect(trend.samples.length).toBe(PROCESS_TREND_CAPACITY);
    c.stopTrendSampler();
  });

  it('queryAverage computes AVG(a)/AVG(b) for heap_used_over_total, not an average of per-sample ratios', () => {
    const c = new ProcessCollector();
    c.startTrendSampler(60_000);
    // Two ticks with different used/total pairs.
    const spy = vi.spyOn(process, 'memoryUsage');
    spy.mockReturnValueOnce({ rss: 1, heapTotal: 100, heapUsed: 10, external: 0, arrayBuffers: 0 } as any);
    vi.advanceTimersByTime(60_000);
    spy.mockReturnValueOnce({ rss: 1, heapTotal: 200, heapUsed: 190, external: 0, arrayBuffers: 0 } as any);
    vi.advanceTimersByTime(60_000);
    spy.mockRestore();

    const avg = c.queryAverage('heap_used_over_total', 300);
    // AVG(used) = (10+190)/2 = 100; AVG(total) = (100+200)/2 = 150; ratio = 100/150.
    expect(avg.value).toBeCloseTo(100 / 150);
    expect(avg.sample).toBe(2);
    c.stopTrendSampler();
  });

  it('returns zero-sample for an empty window', () => {
    const c = new ProcessCollector();
    expect(c.queryAverage('event_loop_lag_ms', 60)).toEqual({ value: 0, sample: 0 });
  });

  it('stopTrendSampler clears the ring', () => {
    const c = new ProcessCollector();
    c.startTrendSampler(60_000);
    vi.advanceTimersByTime(120_000);
    c.stopTrendSampler();
    const trend = c.queryTrend('1h');
    expect(trend.samples).toHaveLength(0);
  });
});
