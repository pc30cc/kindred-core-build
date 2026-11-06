// @vitest-environment node
/**
 * The worker side of the hub (server/cluster/client.ts) when the primary
 * does not answer: each operation follows its own fallback within
 * HUB_TIMEOUT_MS (a lock: its own bound plus that), and says so at most once
 * a minute. When it answers too late, what it took is given back there. And
 * when it does answer, the reply reaches the right caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setHubTransportForTests,
  hubClaim,
  hubLock,
  HubRateLimitStore,
  hubLimiterStore,
  sharedCall,
  type HubTransport,
} from '../../../server/cluster/client.js';
import { HUB_TIMEOUT_MS } from '../../../server/cluster/protocol.js';
import { consumeReauth, issueReauth } from '../../../server/services/privacy/reauth.js';
import { takePrivacyJobSlot, __resetPrivacyJobSlots } from '../../../server/services/privacy/jobRateLimit.js';
import { createHub } from '../../../server/cluster/hub.js';
import { addBroadcastShared } from '../../../server/services/desktopApp/liveShared.js';
import { __resetLive, listBroadcasts } from '../../../server/services/desktopApp/live.js';
import { takeSharedCallRequest } from '../../../server/services/calls/callRequestShared.js';
import { resetCallRequestLimiter } from '../../../server/services/calls/callRequestLimiter.js';
import { __resetCalleeRings, takeSharedCalleeRing } from '../../../server/services/calls/calleeRingLimit.js';
import type { Options } from 'express-rate-limit';

const silent: HubTransport = { send: () => undefined, onMessage: () => undefined };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  __resetPrivacyJobSlots();
});
afterEach(() => {
  __setHubTransportForTests(null);
  vi.useRealTimers();
  warn.mockRestore();
});

describe('a primary that never answers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setHubTransportForTests(silent);
  });

  it('limiters count in this worker and never reject', async () => {
    const store = new HubRateLimitStore('auth');
    store.init({ windowMs: 60_000 } as Options);
    const first = store.increment('k');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    expect((await first).totalHits).toBe(1);
    const second = store.increment('k');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    expect((await second).totalHits).toBe(2);
    const slot = takePrivacyJobSlot('export', 'ws');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    expect(await slot).toBe(true);
    store.shutdown();
  });

  it('re-auth fails closed: nothing is issued, nothing accepted', async () => {
    const issued = issueReauth('u1').then(() => 'issued', () => 'refused');
    const taken = consumeReauth('u1', 'some-token');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    expect(await issued).toBe('refused');
    expect(await taken).toBe(false);
  });

  it('a lock proceeds after its own bound plus the IPC wait', async () => {
    let done = false;
    const lock = hubLock('reply:c1', 5_000).then((release) => {
      done = true;
      return release;
    });
    await vi.advanceTimersByTimeAsync(5_000 + HUB_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    const release = await lock;
    release();
    release();
  });

  it('a claim falls back to a Set of this worker', async () => {
    const first = hubClaim('transcript', 'c1');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    const release = await first;
    expect(release).not.toBeNull();
    const second = hubClaim('transcript', 'c1');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    expect(await second).toBeNull();
    release!();
  });

  it('warns at most once a minute per operation', async () => {
    for (let i = 0; i < 3; i++) {
      const p = sharedCall('login.check', { key: 'k' }, () => ({ blocked: false }));
      await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
      await p;
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('hub login.check unavailable')).length).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    const p = sharedCall('login.check', { key: 'k' }, () => ({ blocked: false }));
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    await p;
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('hub login.check unavailable')).length).toBe(2);
  });

  it('in cluster mode the guess-or-send limiters get the shared store', () => {
    expect(hubLimiterStore('auth').store).toBeInstanceOf(HubRateLimitStore);
  });
});

describe('a primary that answers too late', () => {
  let hub: ReturnType<typeof createHub>;
  let sent: Array<{ op: string; args: Record<string, unknown> }>;
  let delayMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    hub = createHub({ gcEveryMs: null });
    sent = [];
    delayMs = HUB_TIMEOUT_MS + 500;
    __resetLive();
    resetCallRequestLimiter();
    __resetCalleeRings();
    let deliver: (m: unknown) => void = () => undefined;
    __setHubTransportForTests({
      onMessage: (h) => { deliver = h; },
      send: (message) => {
        const m = message as { id?: number; op: string; args: Record<string, unknown> };
        sent.push({ op: m.op, args: m.args });
        // The primary applies it at once (in order); its answer comes after `delayMs`.
        const wait = delayMs;
        void hub.handle(7, m.op, m.args).then((result) => {
          if (m.id !== undefined) setTimeout(() => deliver({ kcb: 1, re: m.id, ok: true, result }), wait);
        });
      },
    });
  });
  afterEach(() => hub.stop());

  it('a claim taken there is released by its token, so the key is not held for 10 minutes', async () => {
    const first = hubClaim('transcript', 'c1');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    const release = await first;
    // This worker's own Set took it…
    expect(release).not.toBeNull();
    // …and the primary's take, which landed, is released.
    expect(hub.claims.size).toBe(0);
    const take = sent.find((m) => m.op === 'claim.take');
    expect(sent.find((m) => m.op === 'claim.release')?.args).toEqual({ ns: 'transcript', key: 'c1', token: take?.args.token });
    release!();
    await vi.advanceTimersByTimeAsync(1_000);
    // The next request, answered at once, gets it from the primary.
    delayMs = 0;
    const next = hubClaim('transcript', 'c1');
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).not.toBeNull();
    expect(hub.claims.size).toBe(1);
  });

  it("the token frees only that take, never a claim another request of the worker holds", async () => {
    delayMs = 0;
    const held = hubClaim('transcript', 'c1');
    await vi.advanceTimersByTimeAsync(1);
    expect(await held).not.toBeNull();
    delayMs = HUB_TIMEOUT_MS + 500;
    const second = hubClaim('transcript', 'c1');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS + 1_000);
    await second;
    expect(hub.claims.size).toBe(1);
  });

  it('a desktop broadcast added there is taken back: the 503 holds, and the retry makes one', async () => {
    const input = { title: 'Update', body: 'Restart the app', severity: 'info' as const, url: null, createdBy: 'admin' };
    const first = addBroadcastShared(input).then(() => 'added', (err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    expect(await first).toBe('desktop_broadcasts_unavailable');
    expect(listBroadcasts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listBroadcasts()).toEqual([]);
    delayMs = 0;
    const retry = addBroadcastShared(input);
    await vi.advanceTimersByTimeAsync(1);
    expect((await retry).title).toBe('Update');
    expect(listBroadcasts()).toHaveLength(1);
  });

  it("a call-request ticket the primary took is given back when its answer arrives", async () => {
    const at = Date.now();
    const p = takeSharedCallRequest('ws:v1', '203.0.113.1');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    await p;
    expect(sent.some((m) => m.op === 'call.giveBack')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.filter((m) => m.op === 'call.giveBack').map((m) => m.args)).toEqual([
      { visitorKey: 'ws:v1', ipKey: '203.0.113.1', at },
    ]);
  });

  it("a callee's ring the primary took is given back when its answer arrives", async () => {
    const at = Date.now();
    const p = takeSharedCalleeRing('callee-1');
    await vi.advanceTimersByTimeAsync(HUB_TIMEOUT_MS);
    await p;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.filter((m) => m.op === 'callee.giveBack').map((m) => m.args)).toEqual([{ calleeId: 'callee-1', at }]);
  });
});

describe('a primary that answers', () => {
  it('replies reach their callers, by id, through the hub', async () => {
    const hub = createHub({ gcEveryMs: null });
    let deliver: (m: unknown) => void = () => undefined;
    const transport: HubTransport = {
      onMessage: (h) => { deliver = h; },
      send: (message) => {
        const m = message as { id?: number; op: string; args: unknown };
        void hub.handle(7, m.op, m.args).then(
          (result) => m.id !== undefined && deliver({ kcb: 1, re: m.id, ok: true, result }),
          (err: Error) => m.id !== undefined && deliver({ kcb: 1, re: m.id, ok: false, error: err.message }),
        );
      },
    };
    __setHubTransportForTests(transport);
    const results = await Promise.all([
      sharedCall('privacy.slot', { action: 'delete', key: 'w' }, () => 'local'),
      sharedCall('privacy.slot', { action: 'delete', key: 'w' }, () => 'local'),
      sharedCall('privacy.slot', { action: 'delete', key: 'w' }, () => 'local'),
    ]);
    expect(results).toEqual([true, true, false]);
    const { token } = await issueReauth('u1');
    expect(await consumeReauth('u1', token)).toBe(true);
    expect(await consumeReauth('u1', token)).toBe(false);
    hub.stop();
  });
});
