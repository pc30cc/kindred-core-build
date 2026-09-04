import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerfCollector } from './perfCollector.js';

describe('PerfCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aggregates count/error_count/error_rate per (route_group, method)', () => {
    const c = new PerfCollector();
    c.record({ routeGroup: 'widget.bootstrap', method: 'POST', statusCode: 200, durationMs: 50 });
    c.record({ routeGroup: 'widget.bootstrap', method: 'POST', statusCode: 200, durationMs: 60 });
    c.record({ routeGroup: 'widget.bootstrap', method: 'POST', statusCode: 500, durationMs: 90 });

    const { rows } = c.querySummary('1h');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      route_group: 'widget.bootstrap',
      method: 'POST',
      count: 3,
      error_count: 1,
      max_ms: 90,
      sum_ms: 200,
    });
    expect(rows[0].error_rate).toBeCloseTo(1 / 3);
    expect(rows[0].status_groups['2xx']).toBe(2);
    expect(rows[0].status_groups['5xx']).toBe(1);
  });

  it('computes histogram-approximated percentiles matching the hand-derived linear interpolation', () => {
    const c = new PerfCollector();
    // 100 samples uniformly at 10ms all land in the [5,10] histogram bucket;
    // percentileFromHistogram interpolates linearly within that bucket, so
    // the approximation is not exactly 10ms even though every sample is.
    for (let i = 0; i < 100; i++) {
      c.record({ routeGroup: 'widget.action', method: 'PUT', statusCode: 200, durationMs: 10 });
    }
    const { rows } = c.querySummary('1h');
    // target = p/100 * 100; interpolated = round(5 + (10-5) * target/100)
    expect(rows[0].p50).toBe(8); // round(5 + 5*0.50) = 8
    expect(rows[0].p95).toBe(10); // round(5 + 5*0.95) = 10
    expect(rows[0].p99).toBe(10); // round(5 + 5*0.99) = 10
  });

  it('never records a route_group that was never instrumented', () => {
    const c = new PerfCollector();
    const { rows } = c.querySummary('1h');
    expect(rows).toHaveLength(0);
  });

  it('ages minute-ring data out after 1h but keeps hour-ring data for 24h', () => {
    const c = new PerfCollector();
    c.record({ routeGroup: 'realtime.subscribe', method: 'POST', statusCode: 200, durationMs: 20 });

    vi.advanceTimersByTime(61 * 60_000);
    expect(c.querySummary('1h').rows).toHaveLength(0);
    expect(c.querySummary('24h').rows).toHaveLength(1);

    vi.advanceTimersByTime(25 * 60 * 60_000);
    expect(c.querySummary('24h').rows).toHaveLength(0);
  });

  it('queryPercentile/queryErrorRate power the alert-rule perf_p95/perf_error_rate kinds', () => {
    const c = new PerfCollector();
    for (let i = 0; i < 10; i++) {
      c.record({ routeGroup: 'realtime.operator_connect', method: 'POST', statusCode: i < 2 ? 500 : 200, durationMs: 100 });
    }
    const err = c.queryErrorRate('realtime.operator_connect', 300);
    expect(err).toEqual({ rate: 0.2, sample: 10 });
    const pct = c.queryPercentile('realtime.operator_connect', 95, 300);
    expect(pct.sample).toBe(10);
    expect(pct.value).toBe(98); // round(50 + (100-50) * 0.95) = 98, all mass in the [50,100] bucket
  });

  it('returns zero-sample results for a route group with no traffic', () => {
    const c = new PerfCollector();
    expect(c.queryPercentile('never.instrumented', 95, 300)).toEqual({ value: 0, sample: 0 });
    expect(c.queryErrorRate('never.instrumented', 300)).toEqual({ rate: 0, sample: 0 });
  });

  it('queryPercentile/queryErrorRate read the 24h hour ring once the window exceeds the 1h minute-ring capacity (alert window semantics fix)', () => {
    const c = new PerfCollector();
    for (let i = 0; i < 10; i++) {
      c.record({ routeGroup: 'realtime.operator_connect', method: 'POST', statusCode: i < 2 ? 500 : 200, durationMs: 100 });
    }
    vi.advanceTimersByTime(90 * 60_000); // 90 minutes later — the minute ring has wrapped/aged out
    // A 1h window genuinely sees nothing any more (minute ring correctly empty).
    expect(c.queryErrorRate('realtime.operator_connect', 3600)).toEqual({ rate: 0, sample: 0 });
    // A 2h window must NOT silently stay pinned to the minute ring's ~1h
    // view — it has to read the hour ring and find the samples.
    expect(c.queryErrorRate('realtime.operator_connect', 7200)).toEqual({ rate: 0.2, sample: 10 });
  });

  it('rounds a hour-ring window up to whole hours rather than silently truncating to 1h (documented approximation)', () => {
    const c = new PerfCollector();
    c.record({ routeGroup: 'realtime.subscribe', method: 'POST', statusCode: 200, durationMs: 20 });
    vi.advanceTimersByTime(61 * 60_000); // just past the minute ring's capacity
    // 3601s rounds UP to 2 whole hour-ring slots, not a precise "~1h+1s"
    // lookback — proving the approximation is intentional and tested, not
    // a silent truncation.
    const pct = c.queryPercentile('realtime.subscribe', 50, 3601);
    expect(pct.sample).toBe(1);
  });

  it('clamps a window beyond the intended 24h perf retention to the full hour ring instead of erroring', () => {
    const c = new PerfCollector();
    c.record({ routeGroup: 'widget.action', method: 'PUT', statusCode: 200, durationMs: 10 });
    vi.advanceTimersByTime(2 * 60 * 60_000);
    const sevenDaysSeconds = 7 * 24 * 60 * 60; // far beyond the 24h perf hour ring
    const pct = c.queryPercentile('widget.action', 50, sevenDaysSeconds);
    expect(pct.sample).toBe(1);
  });

  it('queryP95ForRouteGroups merges histograms across multiple route groups (failoverHealth use case)', () => {
    const c = new PerfCollector();
    c.record({ routeGroup: 'realtime.operator_connect', method: 'POST', statusCode: 200, durationMs: 50 });
    c.record({ routeGroup: 'realtime.subscribe', method: 'POST', statusCode: 200, durationMs: 50 });
    const merged = c.queryP95ForRouteGroups(['realtime.operator_connect', 'realtime.subscribe'], 300);
    expect(merged.sample).toBe(2);
    expect(merged.p95).toBe(49); // round(25 + (50-25) * 0.95) = 49, all mass in the [25,50] bucket
  });
});
