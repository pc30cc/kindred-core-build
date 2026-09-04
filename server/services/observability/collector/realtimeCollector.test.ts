import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RealtimeCollector } from './realtimeCollector.js';
import { KNOWN_REALTIME_METRICS, RECENT_EVENTS_CAPACITY } from './constants.js';

describe('RealtimeCollector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts a known metric and breaks it down by driver/source', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'realtime.reconnect_attempt', driver: 'centrifugo', source: 'operator' });
    c.record({ metric: 'realtime.reconnect_attempt', driver: 'centrifugo', source: 'widget' });
    c.record({ metric: 'realtime.reconnect_attempt', driver: 'supabase', source: 'operator' });

    const summary = c.querySummary('1h');
    expect(summary.counts['realtime.reconnect_attempt'].total).toBe(3);
    expect(summary.counts['realtime.reconnect_attempt'].by_driver.centrifugo).toBe(2);
    expect(summary.counts['realtime.reconnect_attempt'].by_driver.supabase).toBe(1);
    expect(summary.counts['realtime.reconnect_attempt'].by_source.operator).toBe(2);
    expect(summary.counts['realtime.reconnect_attempt'].by_source.widget).toBe(1);
  });

  it('drops unknown metric names without growing the metrics Map', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'totally.unknown.metric' });
    const summary = c.querySummary('7d');
    expect(Object.keys(summary.counts)).not.toContain('totally.unknown.metric');
    // Never returns an empty-count entry for something never recorded.
    expect(c.queryCount('totally.unknown.metric', 60)).toBe(0);
  });

  it('every known metric starts at zero (pre-populated, not lazily created)', () => {
    const c = new RealtimeCollector();
    for (const m of KNOWN_REALTIME_METRICS) {
      expect(c.queryCount(m, 3600)).toBe(0);
    }
  });

  it('ages data out of the 1h window once the minute ring wraps past 60 minutes', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'realtime.token_minted' });
    expect(c.queryCount('realtime.token_minted', 3600)).toBe(1);

    vi.advanceTimersByTime(61 * 60_000); // 61 minutes later — the minute slot has wrapped and been reset
    expect(c.queryCount('realtime.token_minted', 3600)).toBe(0);
  });

  it('keeps hourly data alive well past the 1h window (7-day hour ring)', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'realtime.token_minted' });
    vi.advanceTimersByTime(6 * 60 * 60_000); // 6 hours later
    const summary = c.querySummary('24h');
    expect(summary.counts['realtime.token_minted'].total).toBe(1);
  });

  it('drops hourly data once the 7-day hour ring wraps', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'realtime.token_minted' });
    vi.advanceTimersByTime(8 * 24 * 60 * 60_000); // 8 days later
    const summary = c.querySummary('7d');
    expect(summary.counts['realtime.token_minted']).toBeUndefined();
  });

  it('computes count/ratio window queries used by the alert evaluator', () => {
    const c = new RealtimeCollector();
    for (let i = 0; i < 5; i++) c.record({ metric: 'realtime.subscribe_failed' });
    for (let i = 0; i < 20; i++) c.record({ metric: 'realtime.token_minted' });
    expect(c.queryCount('realtime.subscribe_failed', 300)).toBe(5);
    const ratio = c.queryRatio('realtime.subscribe_failed', 'realtime.token_minted', 300);
    expect(ratio).toEqual({ num: 5, den: 20 });
  });

  it('queryCountByDriver isolates one driver (used by failoverHealth)', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'realtime.subscribe_failed', driver: 'centrifugo' });
    c.record({ metric: 'realtime.subscribe_failed', driver: 'supabase' });
    c.record({ metric: 'realtime.subscribe_failed', driver: 'centrifugo' });
    expect(c.queryCountByDriver('realtime.subscribe_failed', 'centrifugo', 300)).toBe(2);
    expect(c.queryCountByDriver('realtime.subscribe_failed', 'supabase', 300)).toBe(1);
  });

  it('queryCount reads the 7-day hour ring once the window exceeds the 1h minute-ring capacity (alert window semantics fix)', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'realtime.token_minted' });
    vi.advanceTimersByTime(90 * 60_000); // 90 minutes later — the minute ring has wrapped/aged out
    // A 1h window genuinely sees nothing any more (minute ring correctly empty).
    expect(c.queryCount('realtime.token_minted', 3600)).toBe(0);
    // A 2h window must NOT silently stay pinned to the minute ring's ~1h
    // view — it has to read the hour ring and find the event.
    expect(c.queryCount('realtime.token_minted', 7200)).toBe(1);
  });

  it('rounds a hour-ring window up to whole hours rather than silently truncating to 1h (documented approximation)', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'realtime.token_minted' });
    vi.advanceTimersByTime(61 * 60_000); // 61 minutes later — just past the minute ring's capacity
    // Requesting 3601s (just over 1h) rounds UP to 2 whole hour-ring slots,
    // not a precise "~1h+1s" lookback — the event (61 min old) is still
    // found because the 2-hour-slot lookback comfortably covers it. This is
    // the intentional hour-granularity approximation, proven here rather
    // than left as a silent truncation.
    expect(c.queryCount('realtime.token_minted', 3601)).toBe(1);
  });

  it('clamps a window beyond the intended 7-day retention to the full hour ring instead of erroring', () => {
    const c = new RealtimeCollector();
    c.record({ metric: 'realtime.token_minted' });
    vi.advanceTimersByTime(2 * 60 * 60_000);
    const tenDaysSeconds = 10 * 24 * 60 * 60;
    expect(c.queryCount('realtime.token_minted', tenDaysSeconds)).toBe(1);
  });

  describe('recent-events ring buffer', () => {
    it('returns the most recent events first, optionally filtered by metric', () => {
      const c = new RealtimeCollector();
      c.record({ metric: 'realtime.token_minted', workspaceId: 'ws-1' });
      c.record({ metric: 'realtime.subscribe_failed', workspaceId: 'ws-2' });
      c.record({ metric: 'realtime.token_minted', workspaceId: 'ws-3' });

      const all = c.queryEvents({ limit: 10 });
      expect(all).toHaveLength(3);
      expect(all[0].workspace_id).toBe('ws-3'); // most recent first

      const filtered = c.queryEvents({ metric: 'realtime.token_minted', limit: 10 });
      expect(filtered.map((e) => e.workspace_id)).toEqual(['ws-3', 'ws-1']);
    });

    it('is bounded — never holds more than RECENT_EVENTS_CAPACITY entries, oldest evicted first', () => {
      const c = new RealtimeCollector();
      const total = RECENT_EVENTS_CAPACITY + 250;
      for (let i = 0; i < total; i++) {
        c.record({ metric: 'realtime.token_minted', workspaceId: `ws-${i}` });
      }
      const events = c.queryEvents({ limit: RECENT_EVENTS_CAPACITY + 500 });
      expect(events.length).toBe(RECENT_EVENTS_CAPACITY);
      // The oldest 250 were evicted — the newest entry should be ws-<total-1>.
      expect(events[0].workspace_id).toBe(`ws-${total - 1}`);
      expect(events[events.length - 1].workspace_id).toBe(`ws-${total - RECENT_EVENTS_CAPACITY}`);
    });
  });
});
