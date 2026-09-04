import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReconnectClassifier } from './reconnectClassifier.js';
import { RECONNECT_TTL_MAP_MAX } from './constants.js';

const TTL_MS = 10 * 60_000; // 10-minute token TTL, matching typical realtime grant TTLs

describe('ReconnectClassifier', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('validateReconnect on a never-seen subject reports no duplicate and no prior grant', () => {
    const c = new ReconnectClassifier();
    expect(c.validateReconnect('ws-1', 'op-1')).toEqual({ duplicate: false, hadPriorGrant: false });
  });

  it('validateReconnect reports hadPriorGrant once a grant is on record', () => {
    const c = new ReconnectClassifier();
    c.recordGrant('ws-1', 'op-1', TTL_MS);
    expect(c.validateReconnect('ws-1', 'op-1')).toEqual({ duplicate: false, hadPriorGrant: true });
  });

  it('never gates on elapsed-time-vs-TTL — a reconnect report seconds after a grant is still validated, not reclassified', () => {
    const c = new ReconnectClassifier();
    c.recordGrant('ws-1', 'op-1', TTL_MS);
    vi.advanceTimersByTime(5_000); // far short of any TTL-based threshold
    // The old heuristic would have called this "genuine" only because it was
    // soon after a grant — validateReconnect makes no such judgment at all;
    // the caller already decided this is a reconnect via explicit intent.
    expect(c.validateReconnect('ws-1', 'op-1')).toEqual({ duplicate: false, hadPriorGrant: true });
  });

  it('dedupes a second reconnect report for the same subject within the dedup window', () => {
    const c = new ReconnectClassifier();
    expect(c.validateReconnect('ws-1', 'op-1').duplicate).toBe(false);
    vi.advanceTimersByTime(500); // well inside the 2s dedup window
    expect(c.validateReconnect('ws-1', 'op-1').duplicate).toBe(true);
  });

  it('does not dedupe once the dedup window has fully elapsed', () => {
    const c = new ReconnectClassifier();
    expect(c.validateReconnect('ws-1', 'op-1').duplicate).toBe(false);
    vi.advanceTimersByTime(2_001);
    expect(c.validateReconnect('ws-1', 'op-1').duplicate).toBe(false);
  });

  it('tracks each workspace:subject pair independently for both grants and dedup', () => {
    const c = new ReconnectClassifier();
    c.recordGrant('ws-1', 'op-1', TTL_MS);
    expect(c.validateReconnect('ws-1', 'op-2')).toEqual({ duplicate: false, hadPriorGrant: false });
    expect(c.validateReconnect('ws-2', 'op-1')).toEqual({ duplicate: false, hadPriorGrant: false });
  });

  it('is bounded at RECONNECT_TTL_MAP_MAX grant entries, evicting the oldest first (FIFO)', () => {
    const c = new ReconnectClassifier();
    const total = RECONNECT_TTL_MAP_MAX + 500;
    for (let i = 0; i < total; i++) {
      c.recordGrant(`ws-${i}`, 'op', TTL_MS);
    }
    expect(c.size()).toBe(RECONNECT_TTL_MAP_MAX);
    // The oldest 500 entries were evicted — validateReconnect for one of
    // them should see no prior grant.
    expect(c.validateReconnect('ws-0', 'op').hadPriorGrant).toBe(false);
  });
});
