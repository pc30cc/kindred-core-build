import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { invalidateThrottled } from '@/realtime/invalidationThrottle';

let qc: QueryClient;
let calls: string[];

beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient();
  calls = [];
  vi.spyOn(qc, 'invalidateQueries').mockImplementation(async (filters) => {
    calls.push(JSON.stringify(filters?.queryKey));
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('invalidateThrottled', () => {
  it('an isolated event invalidates immediately', () => {
    invalidateThrottled(qc, ['conversations', 'ws-1']);
    expect(calls).toEqual(['["conversations","ws-1"]']);
  });

  it('a burst collapses into the immediate call plus one trailing call', () => {
    for (let i = 0; i < 25; i++) invalidateThrottled(qc, ['conversations', 'ws-1']);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(2);
    // Nothing more arrived: the window closes quietly.
    vi.advanceTimersByTime(5_000);
    expect(calls).toHaveLength(2);
  });

  it('a sustained stream refetches at most once per window', () => {
    for (let t = 0; t < 10_000; t += 100) {
      invalidateThrottled(qc, ['conversations', 'ws-1']);
      vi.advanceTimersByTime(100);
    }
    // 100 events over 10s: the leading call plus one per elapsed window.
    expect(calls.length).toBeLessThanOrEqual(11);
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it('keys are throttled independently', () => {
    invalidateThrottled(qc, ['conversations', 'ws-1']);
    invalidateThrottled(qc, ['inbox-counts', 'ws-1']);
    invalidateThrottled(qc, ['conversation', 'c-1']);
    expect(calls).toHaveLength(3);
  });

  it('an event after the window has closed is immediate again', () => {
    invalidateThrottled(qc, ['messages', 'c-1']);
    vi.advanceTimersByTime(1_500);
    invalidateThrottled(qc, ['messages', 'c-1']);
    expect(calls).toHaveLength(2);
  });

  it('honours a custom window', () => {
    invalidateThrottled(qc, ['visitor-intel-live', 'ws-1'], 2_000);
    invalidateThrottled(qc, ['visitor-intel-live', 'ws-1'], 2_000);
    vi.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(calls).toHaveLength(2);
  });
});
