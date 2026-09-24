/**
 * Bounded cache, single-flight and circuit breaker for live store reads.
 */
import { describe, it, expect } from 'vitest';
import { BoundedTtlCache, SingleFlight, ConnectionGuard } from '../../../server/services/commerce/liveGuard';
import { CommerceError } from '../../../shared/commerce/types';

describe('BoundedTtlCache', () => {
  it('expires entries after their TTL', () => {
    let now = 0;
    const c = new BoundedTtlCache<string>(10, 1_000, 100, () => now);
    c.set('a', 'x', 50, 1);
    expect(c.get('a')).toBe('x');
    now = 51;
    expect(c.get('a')).toBeUndefined();
  });

  it('evicts least recently used past the entry cap', () => {
    const c = new BoundedTtlCache<string>(2, 1_000, 100);
    c.set('a', '1', 1_000, 1);
    c.set('b', '2', 1_000, 1);
    c.get('a');
    c.set('c', '3', 1_000, 1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe('1');
    expect(c.snapshot().entries).toBe(2);
  });

  it('never holds more bytes than its cap', () => {
    const c = new BoundedTtlCache<string>(100, 10, 8);
    for (let i = 0; i < 20; i += 1) c.set(`k${i}`, 'v', 1_000, 4);
    expect(c.snapshot().bytes).toBeLessThanOrEqual(10);
  });

  it('refuses an entry bigger than the per-entry cap', () => {
    const c = new BoundedTtlCache<string>(10, 1_000, 5);
    expect(c.set('big', 'v', 1_000, 6)).toBe(false);
    expect(c.snapshot().rejectedTooLarge).toBe(1);
  });
});

describe('SingleFlight', () => {
  it('shares one in-flight promise between identical requests', async () => {
    const sf = new SingleFlight(10);
    let calls = 0;
    const fn = () => new Promise<number>((r) => { calls += 1; setTimeout(() => r(42), 5); });
    const results = await Promise.all([sf.run('k', fn), sf.run('k', fn), sf.run('k', fn)]);
    expect(results).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
    expect(sf.size).toBe(0);
  });

  it('does not grow past its key cap', async () => {
    const sf = new SingleFlight(1);
    const slow = () => new Promise<void>((r) => setTimeout(r, 5));
    await Promise.all([sf.run('a', slow), sf.run('b', slow)]);
    expect(sf.size).toBe(0);
  });
});

describe('ConnectionGuard', () => {
  const failing = () => Promise.reject(new CommerceError('commerce_live_unavailable', 'down'));

  it('opens after three transport failures and fails fast while open', async () => {
    let now = 0;
    const g = new ConnectionGuard(() => now);
    for (let i = 0; i < 3; i += 1) await expect(g.run('c', failing)).rejects.toBeTruthy();
    let called = false;
    await expect(g.run('c', async () => { called = true; })).rejects.toMatchObject({ code: 'commerce_live_unavailable' });
    expect(called).toBe(false);
    now += ConnectionGuard.OPEN_MS + 1;
    await g.run('c', async () => { called = true; });
    expect(called).toBe(true);
  });

  it('does not count identity or permission refusals as store failures', async () => {
    const g = new ConnectionGuard();
    for (let i = 0; i < 5; i += 1) await expect(g.run('c', () => Promise.reject(new CommerceError('identity_expired')))).rejects.toBeTruthy();
    expect(g.isOpen('c')).toBe(false);
  });

  it('caps concurrent calls per store', async () => {
    const g = new ConnectionGuard();
    const hang = () => new Promise<void>((r) => setTimeout(r, 20));
    const running = Array.from({ length: ConnectionGuard.MAX_INFLIGHT }, () => g.run('c', hang));
    await expect(g.run('c', hang)).rejects.toMatchObject({ code: 'commerce_live_unavailable' });
    await Promise.all(running);
  });

  it('keeps stores independent', async () => {
    const g = new ConnectionGuard();
    for (let i = 0; i < 3; i += 1) await expect(g.run('a', failing)).rejects.toBeTruthy();
    await expect(g.run('b', async () => 1)).resolves.toBe(1);
  });
});
