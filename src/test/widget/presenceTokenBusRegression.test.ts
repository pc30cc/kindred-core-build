/**
 * P0 — regression coverage for the presence-token-TTL fix (commit
 * dab91da, "Bound presence token refresh by the session token's own
 * TTL") against the canonical single-flight session bus.
 *
 * That fix only widened the Math.min() bound `scheduleRefresh()` uses to
 * decide WHEN to renew the presence Centrifugo socket in place — it reads
 * the session token's exp claim, it never refreshes the session token
 * itself. The actual network-refresh authority is, and remains,
 * `window.__gs_token` (the canonical bus installed once by loader.js):
 * every layer (loader heartbeat, presence, runtime.js's TokenManager) that
 * needs a new token asks the SAME bus, which is documented to be
 * single-flight so concurrent callers can never produce two competing
 * refresh engines, duplicate network calls, or a storm.
 *
 * This suite proves that behaviorally: it boots the real loader.js in
 * jsdom (the bus is installed synchronously at the top of the IIFE,
 * before bootstrap() even resolves), then drives window.__gs_token.refresh()
 * and .recover() from multiple "concurrent callers" the way the heartbeat,
 * presence, and TokenManager each independently would, and asserts each
 * produces exactly ONE network call with every caller converging on the
 * same resulting token — never a race, never a duplicate.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const LOADER_SRC = read('public/widget/loader.js');

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    headers: { get: () => null },
  };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  for (const key of Object.keys(window as any)) {
    if (key.indexOf('__gs') === 0) delete (window as any)[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Boots loader.js far enough that window.__gs_token (the canonical bus)
 *  exists, without needing bootstrap/config to actually resolve (the bus
 *  is installed at the very top of the IIFE, synchronously). */
function bootBus(fetchImpl: (url: string, init?: any) => Promise<any>) {
  (window as any).fetch = vi.fn(fetchImpl);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LOADER_SRC).call(window);
  return (window as any).__gs_token;
}

describe('canonical session bus — single-flight authority (no dual refresh engines)', () => {
  it('is installed once, synchronously, before bootstrap/config resolve', () => {
    const bus = bootBus(() => new Promise(() => {})); // never resolves
    expect(bus).toBeTruthy();
    expect(bus.__canonicalSession).toBe(true);
    expect(typeof bus.refresh).toBe('function');
    expect(typeof bus.recover).toBe('function');
    expect(typeof bus.bootstrap).toBe('function');
  });

  it('bus.refresh(): N concurrent callers produce exactly ONE network call and all resolve to the same new token', async () => {
    let refreshCalls = 0;
    const bus = bootBus((url: string) => {
      const u = String(url);
      if (u.includes('/api/widget/session/refresh')) {
        refreshCalls++;
        // Simulate real latency so concurrent callers genuinely overlap
        // in flight, not just in the same microtask tick.
        return new Promise((res) => setTimeout(() => res(jsonResponse({ session_token: 'tok-refreshed-1' })), 20));
      }
      return Promise.resolve(jsonResponse({}));
    });
    bus.configure({ apiBase: 'https://api.test', workspaceId: 'ws-test', token: 'tok-initial' });

    // Three independent "layers" (loader heartbeat, presence, runtime
    // TokenManager) all deciding at the same moment that the token needs
    // refreshing — exactly the scenario the canonical-bus design exists
    // to collapse into one request.
    const [a, b, c] = await Promise.all([bus.refresh(), bus.refresh(), bus.refresh()]);

    expect(refreshCalls).toBe(1);
    expect(a).toBe('tok-refreshed-1');
    expect(b).toBe('tok-refreshed-1');
    expect(c).toBe('tok-refreshed-1');
    expect(bus.get()).toBe('tok-refreshed-1');

    // A SUBSEQUENT call (not concurrent with the first batch) is a fresh
    // refresh — proves single-flight dedup releases properly and doesn't
    // wedge the bus into permanently returning a cached promise.
    refreshCalls = 0;
    const d = await bus.refresh();
    expect(refreshCalls).toBe(1);
    expect(d).toBe('tok-refreshed-1'); // fetch mock always returns the same token; still exactly one call
  });

  it('bus.recover(): concurrent callers single-flight through refresh-then-bootstrap, never duplicate bootstraps', async () => {
    let refreshCalls = 0;
    let bootstrapCalls = 0;
    const bus = bootBus((url: string) => {
      const u = String(url);
      if (u.includes('/api/widget/session/refresh')) {
        refreshCalls++;
        // Refresh fails — token is past its grace window — forcing recover()
        // down the bootstrap path, same as a visitor whose tab slept for hours.
        return new Promise((res) => setTimeout(() => res(jsonResponse({}, false, 401)), 10));
      }
      if (u.includes('/api/widget/bootstrap')) {
        bootstrapCalls++;
        return new Promise((res) => setTimeout(() => res(jsonResponse({ session_token: 'tok-rebootstrapped' })), 10));
      }
      return Promise.resolve(jsonResponse({}));
    });
    bus.configure({ apiBase: 'https://api.test', workspaceId: 'ws-test', token: 'tok-stale' });

    // Heartbeat AND presence both hit a 401 at ~the same moment and both
    // call recover() — must not produce two independent bootstrap POSTs.
    const [x, y] = await Promise.all([bus.recover(), bus.recover()]);

    expect(refreshCalls).toBe(1);
    expect(bootstrapCalls).toBe(1);
    expect(x).toBe('tok-rebootstrapped');
    expect(y).toBe('tok-rebootstrapped');
    expect(bus.get()).toBe('tok-rebootstrapped');
  });

  it('runtime.js TokenManager delegates to the SAME bus instead of opening its own refresh engine when the bus is present', () => {
    // Source-contract guard, not a duplicate of the behavioral proof above:
    // this pins the ONE line that makes createTokenManager route through
    // the canonical bus rather than its local fetch fallback, so a future
    // edit can't silently reintroduce a second engine without failing here.
    const runtimeSrc = read('public/widget/runtime.js');
    expect(runtimeSrc).toContain("return (b && b.__canonicalSession) ? b : null;");
    expect(runtimeSrc).toContain('if (bus && bus.refresh) {');
    expect(runtimeSrc).toContain('if (!bus || !bus.recover) return Promise.resolve(null);');
  });

  it('presence TTL fix: scheduleRefresh bounds its timer by the session token exp, but only READS the bus — it never calls refresh/recover/bootstrap itself', () => {
    // The Phase-1 fix (commit dab91da) added readSessionTokenExpiry() into
    // presence's own Math.min() schedule bound. Pin that it stays a pure
    // read: presence must keep going through fetchConfig()'s existing
    // mgr.recover() 401/403 path for actual token repair, never call
    // window.__gs_token.refresh/.bootstrap directly from inside
    // startVisitorPresence — that would be exactly the second engine this
    // regression guards against.
    const loaderSrc = read('public/widget/loader.js');
    const presenceStart = loaderSrc.indexOf('function startVisitorPresence(');
    const presenceEnd = loaderSrc.indexOf('\n  // ─── Visitor tracking', presenceStart);
    expect(presenceStart).toBeGreaterThan(-1);
    expect(presenceEnd).toBeGreaterThan(presenceStart);
    const presenceBody = loaderSrc.slice(presenceStart, presenceEnd);

    expect(presenceBody).toContain('readSessionTokenExpiry(tokenNow())');
    expect(presenceBody).toContain("mgr.recover({ discardToken: r.status === 403 })");
    // Never a direct proactive refresh/bootstrap call from inside presence —
    // only the reactive 401/403 recover() path above.
    expect(presenceBody).not.toContain('__gs_token.refresh(');
    expect(presenceBody).not.toContain('__gs_token.bootstrap(');
  });
});
