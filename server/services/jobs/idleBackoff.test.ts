import { describe, it, expect } from 'vitest';
import { IdleBackoff, IntervalGate, IdleIntervalSkipper, intFromEnv } from './idleBackoff.js';

/** No jitter, so the growth curve itself is assertable. */
const plain = (over: Partial<ConstructorParameters<typeof IdleBackoff>[0]> = {}) =>
  new IdleBackoff({ busyMs: 50, idleMs: 1500, maxIdleMs: 30_000, jitterRatio: 0, ...over });

describe('IdleBackoff', () => {
  it('a busy cycle keeps the fast cadence', () => {
    const b = plain();
    expect(b.next(true)).toBe(50);
    expect(b.next(true)).toBe(50);
    expect(b.idleCycles).toBe(0);
  });

  it('the FIRST idle cycle still waits exactly the old fixed interval', () => {
    // This is the compatibility guarantee: a queue that alternates between
    // work and a single empty poll behaves exactly as it did before.
    const b = plain();
    expect(b.next(false)).toBe(1500);
  });

  it('consecutive idle cycles grow geometrically up to the ceiling', () => {
    const b = plain();
    expect([b.next(false), b.next(false), b.next(false), b.next(false), b.next(false)]).toEqual([
      1500, 3000, 6000, 12_000, 24_000,
    ]);
    // Clamped from here on, never beyond maxIdleMs.
    expect(b.next(false)).toBe(30_000);
    expect(b.next(false)).toBe(30_000);
  });

  it('finding work resets the streak immediately', () => {
    const b = plain();
    b.next(false);
    b.next(false);
    b.next(false);
    expect(b.idleCycles).toBe(3);

    expect(b.next(true)).toBe(50);
    expect(b.idleCycles).toBe(0);
    // Back to the original interval, not to wherever the streak had climbed.
    expect(b.next(false)).toBe(1500);
  });

  it('jitter spreads replicas out without changing the magnitude', () => {
    // Lockstep replicas are the reason jitter exists: identical fixed
    // intervals make N replicas poll simultaneously forever.
    const lo = new IdleBackoff({ busyMs: 50, idleMs: 1000, maxIdleMs: 30_000, jitterRatio: 0.2, random: () => 0 });
    const hi = new IdleBackoff({ busyMs: 50, idleMs: 1000, maxIdleMs: 30_000, jitterRatio: 0.2, random: () => 1 });
    expect(lo.next(false)).toBe(800); // 1000 * (1 - 0.2)
    expect(hi.next(false)).toBe(1200); // 1000 * (1 + 0.2)
  });

  it('jitter never pushes a delay negative', () => {
    const b = new IdleBackoff({ busyMs: 0, idleMs: 1, maxIdleMs: 1, jitterRatio: 0.99, random: () => 0 });
    expect(b.next(true)).toBeGreaterThanOrEqual(0);
    expect(b.next(false)).toBeGreaterThanOrEqual(0);
  });

  it('rejects nonsensical configuration rather than silently misbehaving', () => {
    expect(() => new IdleBackoff({ busyMs: 50, idleMs: 0, maxIdleMs: 10 })).toThrow(/idleMs/);
    expect(() => new IdleBackoff({ busyMs: 50, idleMs: 100, maxIdleMs: 10 })).toThrow(/maxIdleMs/);
    expect(() => new IdleBackoff({ busyMs: 50, idleMs: 100, maxIdleMs: 200, factor: 0.5 })).toThrow(/factor/);
    expect(() => new IdleBackoff({ busyMs: 50, idleMs: 100, maxIdleMs: 200, jitterRatio: 1 })).toThrow(/jitterRatio/);
  });

  it('an idle day costs a small fraction of the fixed-interval poll count', () => {
    // The whole point, stated as a number: 24h of an empty queue at the old
    // 1.5s interval versus the same 24h under backoff.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const fixedPolls = DAY_MS / 1500;

    const b = plain();
    let elapsed = 0;
    let polls = 0;
    while (elapsed < DAY_MS) {
      elapsed += b.next(false);
      polls += 1;
    }

    expect(fixedPolls).toBeGreaterThan(57_000);
    expect(polls).toBeLessThan(3_000);
  });
});

describe('IntervalGate', () => {
  it('passes on the first call so a fresh worker still reaps immediately', () => {
    expect(new IntervalGate(60_000).due(1_000_000)).toBe(true);
  });

  it('refuses until the interval has elapsed, then passes once', () => {
    const g = new IntervalGate(60_000);
    expect(g.due(0)).toBe(true);
    expect(g.due(30_000)).toBe(false);
    expect(g.due(59_999)).toBe(false);
    expect(g.due(60_000)).toBe(true);
    expect(g.due(60_001)).toBe(false);
  });

  it('collapses a 5s tick into one sweep per minute', () => {
    const g = new IntervalGate(60_000);
    let passed = 0;
    for (let t = 0; t < 60 * 60 * 1000; t += 5_000) if (g.due(t)) passed += 1;
    expect(passed).toBe(60); // one per minute for an hour, not 720
  });

  it('rejects a non-positive interval', () => {
    expect(() => new IntervalGate(0)).toThrow(/everyMs/);
  });
});

describe('IdleIntervalSkipper', () => {
  const skipper = () => new IdleIntervalSkipper(5_000, plain({ busyMs: 5_000, idleMs: 5_000, maxIdleMs: 30_000 }));

  /** Runs `intervals` ticks, reporting `found` for every cycle that runs; returns how many ran. */
  function drive(s: IdleIntervalSkipper, intervals: number, found = false): number {
    let ran = 0;
    for (let i = 0; i < intervals; i++) {
      if (s.skip()) continue;
      ran += 1;
      s.record(found);
    }
    return ran;
  }

  it('the first idle cycle still runs on the very next interval', () => {
    const s = skipper();
    s.record(false);
    expect(s.skip()).toBe(false);
  });

  it('an idle queue eases off to one cycle per ceiling', () => {
    const s = skipper();
    // Runs at intervals 1, 2, 4, 8, then every 6th (30s / 5s).
    expect(drive(s, 8)).toBe(4);
    expect(drive(s, 60)).toBe(10);
  });

  it('a busy queue never skips an interval', () => {
    const s = skipper();
    expect(drive(s, 50, true)).toBe(50);
  });

  it('finding work cancels the pending skips at once', () => {
    const s = skipper();
    drive(s, 30);
    s.record(true);
    expect(s.skip()).toBe(false);
  });
});

describe('intFromEnv', () => {
  it('reads a plain integer', () => {
    expect(intFromEnv('7000', 5000, 1000, 60_000)).toBe(7000);
  });

  it('falls back on anything unparseable instead of producing NaN', () => {
    expect(intFromEnv(undefined, 5000, 1000, 60_000)).toBe(5000);
    expect(intFromEnv('', 5000, 1000, 60_000)).toBe(5000);
    expect(intFromEnv('fast', 5000, 1000, 60_000)).toBe(5000);
  });

  it('clamps a unit typo instead of polling every few milliseconds', () => {
    expect(intFromEnv('5s', 5000, 1000, 60_000)).toBe(1000);
    expect(intFromEnv('9999999', 5000, 1000, 60_000)).toBe(60_000);
  });
});
