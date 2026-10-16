// @vitest-environment node
/**
 * The cache bus's local half (no database): handler dispatch, 'all',
 * re-entrancy, scope validation, and that publishing in supabase-rest mode
 * (no DATABASE_URL) stays local. The cross-process half — LISTEN/NOTIFY,
 * heartbeat, reconnect flush — is src/test/integration/cacheBus.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_MODE;
});

async function bus() {
  return import('./cacheBus.js');
}

describe('cache bus — local dispatch', () => {
  it('routes kind:key scopes to the kind, with the key', async () => {
    const b = await bus();
    const widget = vi.fn();
    const origin = vi.fn();
    b.onInvalidate('widget', widget);
    b.onInvalidate('origin', origin);
    b.invalidateLocal(['widget:AbC', 'origin:x']);
    expect(widget).toHaveBeenCalledWith('AbC');
    expect(origin).toHaveBeenCalledWith('x');
    b.invalidateLocal(['widget']);
    expect(widget).toHaveBeenLastCalledWith(null);
  });

  it("'all' runs every handler once, with key null", async () => {
    const b = await bus();
    const calls: string[] = [];
    b.onInvalidate('widget', (k) => calls.push(`widget:${k}`));
    b.onInvalidate('platform', (k) => calls.push(`platform:${k}`));
    b.invalidateLocal(['widget:a', 'all', 'platform']);
    expect(calls).toEqual(['widget:a', 'widget:null', 'platform:null']);
  });

  it('a handler that invalidates again is queued, not recursed, and never loops', async () => {
    const b = await bus();
    const calls: string[] = [];
    b.onInvalidate('entitlements', (k) => {
      calls.push(`entitlements:${k}`);
      b.invalidateLocal([k ? `widget:${k}` : 'widget']);
    });
    b.onInvalidate('widget', (k) => {
      calls.push(`widget:${k}`);
      b.invalidateLocal(['entitlements:w1']); // a cycle: dropped as already done
    });
    b.invalidateLocal(['entitlements:w1']);
    expect(calls).toEqual(['entitlements:w1', 'widget:w1']);
    calls.length = 0;
    b.invalidateLocal(['all']);
    expect(calls).toEqual(['entitlements:null', 'widget:null']);
  });

  it('a throwing handler does not stop the others', async () => {
    const b = await bus();
    const after = vi.fn();
    b.onInvalidate('widget', () => { throw new Error('boom'); });
    b.onInvalidate('widget', after);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    b.invalidateLocal(['widget:x']);
    expect(after).toHaveBeenCalledWith('x');
    warn.mockRestore();
  });

  it('rejects malformed scopes', async () => {
    const b = await bus();
    expect(b.isValidCacheScope('widget:7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e')).toBe(true);
    expect(b.isValidCacheScope('host:shop.example.com')).toBe(true);
    expect(b.isValidCacheScope('all')).toBe(true);
    for (const bad of ['', 'Widget:x', 'widget:', 'widget:a b', ':x', 'w'.repeat(40), 42, null]) {
      expect(b.isValidCacheScope(bad)).toBe(false);
    }
    const h = vi.fn();
    b.onInvalidate('widget', h);
    b.invalidateLocal(['widget:a b', 'Widget:x']);
    expect(h).not.toHaveBeenCalled();
  });

  it('publish runs the local handlers at once; supabase-rest mode sends nothing and never listens', async () => {
    const b = await bus();
    const h = vi.fn();
    b.onInvalidate('widget', h);
    b.publishCacheInvalidation(['widget:w1']);
    expect(h).toHaveBeenCalledWith('w1');
    b.startCacheBusListener();
    expect(b.isCrossNodeInvalidationActive()).toBe(false);
    expect(b.__cacheBusListenerClientForTests()).toBeNull();
  });
});
