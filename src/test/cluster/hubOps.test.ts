// @vitest-environment node
/**
 * The cluster primary's hub (server/cluster/hub.ts), run in-process with two
 * workers' owner ids: each operation keeps the single process's semantics
 * for the whole container (docs/operations/BACKEND_PROCESSES.md, "The hub").
 */
import { createHash } from 'node:crypto';
import { MemoryStore, type Options } from 'express-rate-limit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHub, type Hub } from '../../../server/cluster/hub.js';
import { KeyedChainLocks } from '../../../server/cluster/keyedLock.js';
import { ClaimSet } from '../../../server/cluster/claims.js';
import { __resetLoginAttempts } from '../../../server/middleware/loginAttempts.js';
import { __resetPrivacyJobSlots } from '../../../server/services/privacy/jobRateLimit.js';
import { __resetLive } from '../../../server/services/desktopApp/live.js';
import { resetCallRequestLimiter } from '../../../server/services/calls/callRequestLimiter.js';
import { __resetCalleeRings } from '../../../server/services/calls/calleeRingLimit.js';
import {
  __resetOperatorActivityIndex,
  operatorActivityIndexSize,
  stampOperatorActivity,
} from '../../../server/services/widget/operatorActivityIndex.js';

const A = 1;
const B = 2;
let hub: Hub;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

beforeEach(() => {
  hub = createHub({ gcEveryMs: null });
  __resetLoginAttempts();
  __resetPrivacyJobSlots();
  __resetLive();
  resetCallRequestLimiter();
  __resetCalleeRings();
  __resetOperatorActivityIndex();
});
afterEach(() => hub.stop());

describe('H1 re-auth', () => {
  it('a hash stored by one worker is taken once by another; the raw token never travels', async () => {
    const message = { hash: sha('tok-1'), userId: 'u1', expiresAt: Date.now() + 60_000 };
    expect(JSON.stringify(message)).not.toContain('tok-1');
    expect(await hub.handle(A, 'reauth.store', message)).toBe(true);
    expect(await hub.handle(B, 'reauth.take', { hash: sha('tok-1'), userId: 'u2' })).toBe(false);
    expect(await hub.handle(B, 'reauth.take', { hash: sha('tok-1'), userId: 'u1' })).toBe(true);
    expect(await hub.handle(A, 'reauth.take', { hash: sha('tok-1'), userId: 'u1' })).toBe(false);
  });

  it('an expired hash is refused', async () => {
    await hub.handle(A, 'reauth.store', { hash: sha('old'), userId: 'u1', expiresAt: Date.now() - 1 });
    expect(await hub.handle(B, 'reauth.take', { hash: sha('old'), userId: 'u1' })).toBe(false);
  });
});

describe('H3 login brute force', () => {
  it('failures split across workers lock at 5, and the lock is set on check', async () => {
    const key = '203.0.113.0:a@b.c';
    for (let i = 0; i < 4; i++) await hub.handle(i % 2 ? A : B, 'login.record', { key, success: false });
    expect(await hub.handle(A, 'login.check', { key })).toEqual({ blocked: false });
    await hub.handle(B, 'login.record', { key, success: false });
    const locked = (await hub.handle(A, 'login.check', { key })) as { blocked: boolean; retryAfter: number; failCount: number };
    expect(locked).toMatchObject({ blocked: true, failCount: 5 });
    expect(locked.retryAfter).toBe(300);
    // The lock written by the check holds on the other worker.
    expect(await hub.handle(B, 'login.check', { key })).toMatchObject({ blocked: true, failCount: 5 });
    await hub.handle(B, 'login.record', { key, success: true });
    expect(await hub.handle(A, 'login.check', { key })).toEqual({ blocked: false });
  });
});

describe('H4 limiter stores', () => {
  it("count exactly as express-rate-limit's own MemoryStore, across workers", async () => {
    const direct = new MemoryStore();
    direct.init({ windowMs: 60_000 } as Options);
    for (let i = 0; i < 7; i++) {
      const viaHub = (await hub.handle(i % 2 ? A : B, 'rl.increment', { name: 'auth', windowMs: 60_000, key: 'k' })) as {
        totalHits: number;
        resetTime: string;
      };
      const local = await direct.increment('k');
      expect(viaHub.totalHits).toBe(local.totalHits);
      expect(Math.abs(Date.parse(viaHub.resetTime) - local.resetTime!.getTime())).toBeLessThan(1_000);
    }
    await hub.handle(A, 'rl.decrement', { name: 'auth', windowMs: 60_000, key: 'k' });
    expect(((await hub.handle(B, 'rl.get', { name: 'auth', windowMs: 60_000, key: 'k' })) as { totalHits: number }).totalHits).toBe(6);
    await hub.handle(B, 'rl.resetKey', { name: 'auth', windowMs: 60_000, key: 'k' });
    expect(await hub.handle(A, 'rl.get', { name: 'auth', windowMs: 60_000, key: 'k' })).toBeNull();
    // Another limiter's name is another store.
    expect(((await hub.handle(A, 'rl.increment', { name: 'email', windowMs: 60_000, key: 'k' })) as { totalHits: number }).totalHits).toBe(1);
    direct.shutdown();
  });
});

describe('H2 privacy job slots', () => {
  it('5 exports and 2 deletions an hour per key, whichever worker asks', async () => {
    const take = (owner: number, action: string) => hub.handle(owner, 'privacy.slot', { action, key: 'ws-1' });
    const exports = await Promise.all([A, B, A, B, A, B].map((o) => take(o, 'export')));
    expect(exports).toEqual([true, true, true, true, true, false]);
    expect([await take(A, 'delete'), await take(B, 'delete'), await take(A, 'delete')]).toEqual([true, true, false]);
  });
});

describe('H5 desktop apps', () => {
  it('one roster and one sequence; a broadcast is seen and deleted everywhere', async () => {
    const beat = (owner: number, sessionId: string, afterSeq: number) =>
      hub.handle(owner, 'desktop.heartbeat', {
        input: { sessionId, userId: `u-${sessionId}`, workspaceId: null, version: '1.0', os: 'Windows 11', platform: 'windows' },
        afterSeq,
        platform: 'windows',
      }) as Promise<{ items: Array<{ id: string; seq: number }>; latest: number }>;
    const first = await beat(A, 's-1', -1);
    expect(first.items).toEqual([]);
    await beat(B, 's-2', -1);
    expect(((await hub.handle(A, 'desktop.summary', {})) as { online: number }).online).toBe(2);
    const b = (await hub.handle(B, 'desktop.add', {
      input: { title: 'Hi', body: '', severity: 'info', url: null, platforms: [], createdBy: 'admin' },
    })) as { id: string; seq: number };
    expect(b.seq).toBeGreaterThan(first.latest);
    const seen = await beat(A, 's-1', first.latest);
    expect(seen.items.map((x) => x.id)).toEqual([b.id]);
    expect(await hub.handle(A, 'desktop.remove', { id: b.id })).toBe(true);
    expect((await beat(B, 's-2', first.latest)).items).toEqual([]);
    await hub.handle(A, 'desktop.goodbye', { sessionId: 's-1', userId: 'u-s-1' });
    expect(((await hub.handle(B, 'desktop.summary', {})) as { online: number }).online).toBe(1);
  });
});

describe('H6 and H7 call limits', () => {
  it('ring-quiet holds across workers, and a give-back finds the ticket by its `at`', async () => {
    expect(await hub.handle(A, 'call.mayRing', { visitorKey: 'ws:v1' })).toBe(true);
    expect(await hub.handle(B, 'call.mayRing', { visitorKey: 'ws:v1' })).toBe(false);
    const first = (await hub.handle(A, 'call.take', { visitorKey: 'ws:v2', ipKey: '203.0.113.9' })) as {
      ok: true;
      ticket: { at: number };
    };
    expect(first.ok).toBe(true);
    // Within the 3 s gap: refused, on the other worker too.
    expect(((await hub.handle(B, 'call.take', { visitorKey: 'ws:v2', ipKey: null })) as { ok: boolean }).ok).toBe(false);
    await hub.handle(B, 'call.giveBack', { visitorKey: 'ws:v2', ipKey: '203.0.113.9', at: first.ticket.at });
    expect(((await hub.handle(B, 'call.take', { visitorKey: 'ws:v2', ipKey: null })) as { ok: boolean }).ok).toBe(true);
  });

  it("a callee's six rings a minute are shared, and a ring given back is free again", async () => {
    const rings = [];
    for (let i = 0; i < 7; i++) rings.push(await hub.handle(i % 2 ? A : B, 'callee.take', { calleeId: 'c1' }));
    expect(rings.filter(Boolean).length).toBe(6);
    expect(rings[6]).toBeNull();
    await hub.handle(A, 'callee.giveBack', rings[0]);
    expect(await hub.handle(B, 'callee.take', { calleeId: 'c1' })).not.toBeNull();
  });
});

describe('H8 operator activity', () => {
  it('is monotonic and answers what any worker stamped', async () => {
    const now = Date.now();
    await hub.handle(A, 'activity.stamp', { key: 'ws:u1', at: now });
    await hub.handle(B, 'activity.stamp', { key: 'ws:u1', at: now - 10_000 });
    expect(await hub.handle(B, 'activity.get', { keys: ['ws:u1', 'ws:u2'] })).toEqual({ 'ws:u1': now });
  });

  it('prunes old stamps and stays bounded', { timeout: 30_000 }, () => {
    const now = Date.now();
    for (let i = 0; i < 25_000; i++) stampOperatorActivity(`ws:u${i}`, now - i, now);
    expect(operatorActivityIndexSize()).toBeLessThanOrEqual(20_000);
    hub.gc(now + 11 * 60_000);
    expect(operatorActivityIndexSize()).toBe(0);
  });
});

describe('H9 chain locks', () => {
  it('first come, first served across workers', async () => {
    const order: string[] = [];
    await hub.handle(A, 'lock.acquire', { key: 'reply:c1', maxWaitMs: 5_000, token: 'a1' });
    const second = hub.handle(B, 'lock.acquire', { key: 'reply:c1', maxWaitMs: 5_000, token: 'b1' }).then(() => order.push('b1'));
    const third = hub.handle(A, 'lock.acquire', { key: 'reply:c1', maxWaitMs: 5_000, token: 'a2' }).then(() => order.push('a2'));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    expect(await hub.handle(A, 'lock.release', { token: 'a1' })).toBe(true);
    await second;
    expect(order).toEqual(['b1']);
    // Release is idempotent.
    expect(await hub.handle(A, 'lock.release', { token: 'a1' })).toBe(false);
    await hub.handle(B, 'lock.release', { token: 'b1' });
    await third;
    expect(order).toEqual(['b1', 'a2']);
  });

  it("a waiter whose bound passes proceeds and stays the tail; the next one waits for it", async () => {
    const locks = new KeyedChainLocks();
    await locks.acquire('k', 1_000, 't1', A);
    const t0 = Date.now();
    await locks.acquire('k', 30, 't2', B);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    let third = false;
    const p = locks.acquire('k', 5_000, 't3', A).then(() => { third = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBe(false);
    locks.release('t2');
    await p;
    expect(third).toBe(true);
  });

  it("a worker that exits releases its locks, and the next waiter goes on", async () => {
    await hub.handle(A, 'lock.acquire', { key: 'close:c1', maxWaitMs: 120_000, token: 'a1' });
    let went = false;
    const p = hub.handle(B, 'lock.acquire', { key: 'close:c1', maxWaitMs: 120_000, token: 'b1' }).then(() => { went = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(went).toBe(false);
    hub.releaseOwner(A);
    await p;
    expect(went).toBe(true);
  });

  it('a waiter whose worker exits mid-wait does not let the next one past the holder', async () => {
    const C = 3;
    const tick = () => new Promise((r) => setTimeout(r, 10));
    await hub.handle(A, 'lock.acquire', { key: 'close:c1', maxWaitMs: 120_000, token: 'a1' });
    void hub.handle(B, 'lock.acquire', { key: 'close:c1', maxWaitMs: 120_000, token: 'b1' });
    let third = false;
    const p = hub.handle(C, 'lock.acquire', { key: 'close:c1', maxWaitMs: 120_000, token: 'c1' }).then(() => { third = true; });
    await tick();
    // B's worker exits while B waits behind A.
    hub.releaseOwner(B);
    await tick();
    expect(third).toBe(false);
    // A newcomer queues behind the holder too.
    let fourth = false;
    const q = hub.handle(A, 'lock.acquire', { key: 'close:c1', maxWaitMs: 120_000, token: 'a2' }).then(() => { fourth = true; });
    await tick();
    expect(fourth).toBe(false);
    // Only A's release lets C go, then C's lets the newcomer go.
    await hub.handle(A, 'lock.release', { token: 'a1' });
    await p;
    expect(third).toBe(true);
    expect(fourth).toBe(false);
    await hub.handle(C, 'lock.release', { token: 'c1' });
    await q;
    expect(fourth).toBe(true);
    await hub.handle(A, 'lock.release', { token: 'a2' });
    expect(hub.locks.size).toBe(0);
  });

  it('a granted waiter whose worker exits releases at once', async () => {
    const locks = new KeyedChainLocks();
    await locks.acquire('k', 1_000, 't1', A);
    // t2's bound passes: it proceeds, as a holder.
    await locks.acquire('k', 5, 't2', B);
    let third = false;
    const p = locks.acquire('k', 5_000, 't3', A).then(() => { third = true; });
    locks.releaseOwner(B);
    await p;
    expect(third).toBe(true);
  });
});

describe('H10 claims', () => {
  it('are exclusive, and released when their owner exits', async () => {
    expect(await hub.handle(A, 'claim.take', { ns: 'transcript', key: 'c1' })).toBe(true);
    expect(await hub.handle(B, 'claim.take', { ns: 'transcript', key: 'c1' })).toBe(false);
    // Another worker cannot release A's claim.
    expect(await hub.handle(B, 'claim.release', { ns: 'transcript', key: 'c1' })).toBe(false);
    hub.releaseOwner(A);
    expect(await hub.handle(B, 'claim.take', { ns: 'transcript', key: 'c1' })).toBe(true);
    expect(await hub.handle(B, 'claim.release', { ns: 'transcript', key: 'c1' })).toBe(true);
  });
});

describe('bounds', () => {
  it('unknown operations are refused', async () => {
    await expect(hub.handle(A, 'process.exit', {})).rejects.toThrow(/unknown_hub_op/);
  });

  it('the size caps hold at 100,000 keys', { timeout: 30_000 }, async () => {
    const claims = new ClaimSet(1_000);
    for (let i = 0; i < 100_000; i++) claims.take('ns', `k${i}`, A);
    expect(claims.size).toBeLessThanOrEqual(1_000);
    const locks = new KeyedChainLocks(1_000);
    for (let i = 0; i < 100_000; i++) await locks.acquire(`k${i}`, 0, `t${i}`, A);
    expect(locks.size).toBeLessThanOrEqual(1_000);
    for (let i = 0; i < 100_000; i++) await hub.handle(A, 'reauth.store', { hash: `h${i}`, userId: 'u', expiresAt: Date.now() + 60_000 });
    for (let i = 0; i < 100_000; i++) await hub.handle(A, 'privacy.slot', { action: 'export', key: `w${i}` });
  });
});
