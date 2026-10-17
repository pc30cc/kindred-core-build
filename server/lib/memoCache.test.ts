// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoBusyError, MemoCache, RateGate, type MemoLoadContext } from './memoCache.js';

type V = { id: string; bad?: boolean; missing?: boolean };

function cache(overrides: Partial<ConstructorParameters<typeof MemoCache<V>>[0]> = {}) {
  return new MemoCache<V>({
    name: 'test',
    ttlMs: (v) => (v.missing ? 1_000 : 10_000),
    max: () => 3,
    isNegative: (v) => !!v.missing,
    negativeMax: () => 2,
    keepPrevious: (prev, next) => !!next.bad && !prev.bad,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MemoCache', () => {
  it('shares one load among concurrent misses, then serves from memory', async () => {
    const c = cache();
    const load = vi.fn(async () => ({ id: 'a' }));
    const results = await Promise.all(Array.from({ length: 20 }, () => c.get('k', load)));
    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);
    await c.get('k', load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('serves a stale entry at once and reloads it once in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const c = cache();
    let n = 0;
    const load = vi.fn(async (_ctx: MemoLoadContext) => ({ id: `v${++n}` }));
    expect((await c.get('k', load)).id).toBe('v1');
    vi.setSystemTime(10_001);
    const [a, b] = await Promise.all([c.get('k', load), c.get('k', load)]);
    expect(a.id).toBe('v1');
    expect(b.id).toBe('v1');
    await vi.waitFor(() => expect(c.peek('k')?.id).toBe('v2'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1][0]).toEqual({ background: true });
  });

  it('never stores a load that was running when its key was invalidated', async () => {
    const c = cache();
    let release: (v: V) => void = () => undefined;
    const pending = c.get('k', () => new Promise<V>((r) => { release = r; }));
    c.invalidate('k');
    release({ id: 'old' });
    expect((await pending).id).toBe('old');
    expect(c.peek('k')).toBeUndefined();
    // A request after the invalidation does not join the disowned load.
    const fresh = vi.fn(async () => ({ id: 'new' }));
    expect((await c.get('k', fresh)).id).toBe('new');
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the old entry when a background load fails, for up to maxStaleMs', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const c = cache({ maxStaleMs: 60_000, retryAfterMs: 5_000 });
    await c.get('k', async () => ({ id: 'good' }));
    const failing = vi.fn(async (): Promise<V> => { throw new Error('db down'); });
    vi.setSystemTime(20_000);
    expect((await c.get('k', failing)).id).toBe('good');
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    // Within the retry delay: no new attempt.
    vi.setSystemTime(21_000);
    expect((await c.get('k', failing)).id).toBe('good');
    expect(failing).toHaveBeenCalledTimes(1);
    // After it: one more background attempt, still the old entry.
    vi.setSystemTime(26_000);
    expect((await c.get('k', failing)).id).toBe('good');
    await vi.waitFor(() => expect(failing).toHaveBeenCalledTimes(2));
    // Beyond max stale the load is awaited (and its error surfaces).
    vi.setSystemTime(10_000 + 60_001);
    await expect(c.get('k', failing)).rejects.toThrow('db down');
  });

  it('a degraded reload does not replace a good entry', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const c = cache();
    await c.get('k', async () => ({ id: 'good' }));
    vi.setSystemTime(10_001);
    const degraded = vi.fn(async () => ({ id: 'degraded', bad: true }));
    await c.get('k', degraded);
    await vi.waitFor(() => expect(degraded).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(c.peek('k')?.id).toBe('good');
  });

  it('bounds the main map (LRU) and keeps negatives in their own, smaller map', async () => {
    const c = cache();
    for (const k of ['a', 'b', 'c']) await c.get(k, async () => ({ id: k }));
    await c.get('a', async () => ({ id: 'x' })); // touch a: b is now the oldest
    await c.get('d', async () => ({ id: 'd' }));
    expect(c.peek('b')).toBeUndefined();
    expect(c.peek('a')?.id).toBe('a');
    // A flood of "does not exist" answers never evicts a real entry.
    for (let i = 0; i < 50; i++) await c.get(`missing-${i}`, async () => ({ id: `m${i}`, missing: true }));
    expect(c.sizes()).toEqual([3, 2]);
    for (const k of ['a', 'c', 'd']) expect(c.peek(k)?.id).toBeDefined();
  });

  it('enabled() false bypasses the cache (single flight stays)', async () => {
    let on = true;
    const c = cache({ enabled: () => on });
    await c.get('k', async () => ({ id: 'cached' }));
    on = false;
    const load = vi.fn(async () => ({ id: 'live' }));
    const [a, b] = await Promise.all([c.get('k', load), c.get('k', load)]);
    expect(a.id).toBe('live');
    expect(b.id).toBe('live');
    expect(load).toHaveBeenCalledTimes(1);
    await c.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(c.sizes()).toEqual([0, 0]);
  });

  it('invalidateWhere drops matching entries and disowns running loads', async () => {
    const c = cache();
    await c.get('a', async () => ({ id: 'team-1' }));
    await c.get('b', async () => ({ id: 'team-2' }));
    let release: (v: V) => void = () => undefined;
    const running = c.get('c', () => new Promise<V>((r) => { release = r; }));
    c.invalidateWhere((v) => v.id === 'team-1');
    release({ id: 'c' });
    await running;
    expect(c.peek('a')).toBeUndefined();
    expect(c.peek('b')?.id).toBe('team-2');
    expect(c.peek('c')).toBeUndefined();
  });
});

describe('RateGate', () => {
  it('lets a burst through, then makes requests wait for tokens, then refuses after maxWait', async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = new RateGate('t', () => 2, () => 2, 1_000);
    await gate.acquire();
    await gate.acquire();
    expect(gate.tryAcquire()).toBe(false);
    let third = false;
    const p3 = gate.acquire().then(() => { third = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(third).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p3;
    expect(third).toBe(true);
    // Five more at 2/s with a 1 s wait: two make it, three are refused.
    const outcomes = Array.from({ length: 5 }, () => gate.acquire().then(() => 'ok', (e) => (e instanceof MemoBusyError ? 'busy' : 'other')));
    await vi.advanceTimersByTimeAsync(1_100);
    const settled = await Promise.all(outcomes);
    expect(settled.filter((x) => x === 'ok').length).toBe(2);
    expect(settled.filter((x) => x === 'busy').length).toBe(3);
  });

  it('0 per second = unlimited', async () => {
    const gate = new RateGate('t', () => 0, () => 1, 10);
    for (let i = 0; i < 100; i++) expect(gate.tryAcquire()).toBe(true);
    await gate.acquire();
  });
});

describe('MemoCache — serveStale and expireAll', () => {
  it('an entry serveStale refuses is reloaded in the foreground once past its lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const c = cache({ serveStale: (v) => !v.bad });
    let next: V = { id: 'degraded', bad: true };
    const load = vi.fn(async (_ctx: MemoLoadContext) => next);
    expect((await c.get('k', load)).id).toBe('degraded');
    next = { id: 'good' };
    vi.setSystemTime(10_001);
    // Not the stale degraded copy: the request waits for the reload.
    expect((await c.get('k', load)).id).toBe('good');
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1][0]).toEqual({ background: false });
  });

  it('a negative entry serveStale refuses is not served stale either', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const c = cache({ serveStale: (v) => !v.missing });
    let next: V = { id: 'gone', missing: true };
    const load = vi.fn(async () => next);
    await c.get('k', load);
    next = { id: 'created' };
    vi.setSystemTime(1_001);
    expect((await c.get('k', load)).id).toBe('created');
  });

  it('expireAll keeps the copies servable: the next request gets the old one and ONE reload runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 });
    const c = cache();
    let n = 0;
    const load = vi.fn(async (_ctx: MemoLoadContext) => ({ id: `v${++n}` }));
    await c.get('k', load);
    c.expireAll();
    expect(c.sizes()).toEqual([1, 0]);
    const [a, b] = await Promise.all([c.get('k', load), c.get('k', load)]);
    expect(a.id).toBe('v1');
    expect(b.id).toBe('v1');
    await vi.waitFor(() => expect(c.peek('k')?.id).toBe('v2'));
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1][0]).toEqual({ background: true });
    // The reloaded entry is fresh again.
    await c.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('expireAll disowns a running load (it may predate the signal)', async () => {
    const c = cache();
    let release: (v: V) => void = () => undefined;
    const pending = c.get('k', () => new Promise<V>((r) => { release = r; }));
    c.expireAll();
    release({ id: 'old' });
    expect((await pending).id).toBe('old');
    expect(c.peek('k')).toBeUndefined();
  });
});
