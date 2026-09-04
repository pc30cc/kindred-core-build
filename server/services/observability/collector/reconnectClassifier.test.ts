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

  it('classifies a never-seen workspace:subject pair as genuine (true first connect)', () => {
    const c = new ReconnectClassifier();
    expect(c.classify('ws-1', 'op-1', TTL_MS)).toBe('genuine');
  });

  it('classifies a re-negotiation soon after a grant as genuine (something actually failed)', () => {
    const c = new ReconnectClassifier();
    c.recordGrant('ws-1', 'op-1', TTL_MS);
    vi.advanceTimersByTime(TTL_MS * 0.2); // well under half the TTL
    expect(c.classify('ws-1', 'op-1', TTL_MS)).toBe('genuine');
  });

  it('classifies a re-negotiation in the back half of the TTL as routine_refresh (proactive token refresh)', () => {
    const c = new ReconnectClassifier();
    c.recordGrant('ws-1', 'op-1', TTL_MS);
    vi.advanceTimersByTime(TTL_MS * 0.8); // past the 50% threshold, consistent with a proactive refresh
    expect(c.classify('ws-1', 'op-1', TTL_MS)).toBe('routine_refresh');
  });

  it('treats a wildly stale grant (> 3x TTL old) as genuine and evicts it', () => {
    const c = new ReconnectClassifier();
    c.recordGrant('ws-1', 'op-1', TTL_MS);
    vi.advanceTimersByTime(TTL_MS * 4);
    expect(c.classify('ws-1', 'op-1', TTL_MS)).toBe('genuine');
    expect(c.size()).toBe(0); // the stale entry was evicted, not left to linger
  });

  it('tracks each workspace:subject pair independently', () => {
    const c = new ReconnectClassifier();
    c.recordGrant('ws-1', 'op-1', TTL_MS);
    expect(c.classify('ws-1', 'op-2', TTL_MS)).toBe('genuine'); // different subject, no prior grant
    expect(c.classify('ws-2', 'op-1', TTL_MS)).toBe('genuine'); // different workspace, no prior grant
  });

  it('is bounded at RECONNECT_TTL_MAP_MAX entries, evicting the oldest first (FIFO)', () => {
    const c = new ReconnectClassifier();
    const total = RECONNECT_TTL_MAP_MAX + 500;
    for (let i = 0; i < total; i++) {
      c.recordGrant(`ws-${i}`, 'op', TTL_MS);
    }
    expect(c.size()).toBe(RECONNECT_TTL_MAP_MAX);
    // The oldest 500 entries were evicted — a fresh classify() for one of
    // them should see no prior grant (genuine), not the original one.
    expect(c.classify('ws-0', 'op', TTL_MS)).toBe('genuine');
  });
});
