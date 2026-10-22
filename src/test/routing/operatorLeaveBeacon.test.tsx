/**
 * R-11, the panel's side: a tab that goes away says so with a beacon naming
 * itself, so the server ends only its part of the operator's presence lease
 * (migration 282b) instead of letting routing pick them for up to 5 minutes.
 *
 *   - every heartbeat names the tab (a source id);
 *   - pagehide sends one beacon with that id (text/plain JSON, the cookie
 *     rides along), and the tab comes back under a new id when the page is
 *     restored from the back/forward cache;
 *   - on iPhone and iPad a hidden tab counts as gone (iOS suspends it, often
 *     without a pagehide), and comes back when visible; on a computer a
 *     hidden tab keeps beating and sends nothing;
 *   - leaving the workspace (unmount) ends this tab's presence there;
 *   - without sendBeacon, or when it refuses, a keepalive fetch;
 *   - the server keeps the plain lease write while 282b's function is
 *     missing, and a beacon then changes nothing.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const calls = vi.hoisted(() => ({
  beats: [] as Array<{ ws: string; interacted: boolean; source?: string }>,
  leaves: [] as Array<{ ws: string; source: string }>,
}));

vi.mock('@/lib/operator-activity-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/operator-activity-api')>()),
  sendOperatorHeartbeat: async (ws: string, interacted: boolean, source?: string) => { calls.beats.push({ ws, interacted, source }); },
  sendOperatorLeave: (ws: string, source: string) => { calls.leaves.push({ ws, source }); },
}));

const { useOperatorHeartbeat, leavesWhenHidden, newPresenceSourceId } = await import('@/hooks/useOperatorHeartbeat');
const api = await vi.importActual<typeof import('@/lib/operator-activity-api')>('@/lib/operator-activity-api');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}
function pageTransition(type: 'pagehide' | 'pageshow', persisted: boolean) {
  const e = new Event(type) as Event & { persisted: boolean };
  Object.defineProperty(e, 'persisted', { value: persisted });
  window.dispatchEvent(e);
}

beforeEach(() => {
  calls.beats = [];
  calls.leaves = [];
  setUserAgent(DESKTOP);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useOperatorHeartbeat: the tab names itself and says when it goes', () => {
  it('beats under a tab id; pagehide sends one beacon with it; a restored page comes back under a new id', () => {
    const { unmount } = renderHook(() => useOperatorHeartbeat('ws-1'));
    expect(calls.beats).toHaveLength(1);
    const first = calls.beats[0].source!;
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

    pageTransition('pagehide', true);
    pageTransition('pagehide', true);
    expect(calls.leaves).toEqual([{ ws: 'ws-1', source: first }]);

    pageTransition('pageshow', true);
    expect(calls.beats).toHaveLength(2);
    const second = calls.beats[1].source!;
    expect(second).not.toBe(first);
    expect(calls.beats[1].interacted).toBe(true);

    // Leaving the workspace ends this tab's presence there.
    unmount();
    expect(calls.leaves).toEqual([{ ws: 'ws-1', source: first }, { ws: 'ws-1', source: second }]);
  });

  it('a first page load (pageshow, not persisted) does not beat twice', () => {
    renderHook(() => useOperatorHeartbeat('ws-1'));
    pageTransition('pageshow', false);
    expect(calls.beats).toHaveLength(1);
  });

  it('on a computer a hidden tab keeps its presence: no beacon', () => {
    renderHook(() => useOperatorHeartbeat('ws-1'));
    setVisibility('hidden');
    setVisibility('visible');
    expect(calls.leaves).toEqual([]);
    expect(calls.beats).toHaveLength(1);
  });

  it('on an iPhone a hidden tab is gone, and back when visible (a new id); no beats while gone', () => {
    vi.useFakeTimers();
    try {
      setUserAgent(IPHONE);
      renderHook(() => useOperatorHeartbeat('ws-1'));
      const first = calls.beats[0].source!;
      setVisibility('hidden');
      expect(calls.leaves).toEqual([{ ws: 'ws-1', source: first }]);
      // A timer that still fires while hidden does not bring it back.
      vi.advanceTimersByTime(120_000);
      expect(calls.beats).toHaveLength(1);
      // pagehide after hidden: no second beacon.
      pageTransition('pagehide', false);
      expect(calls.leaves).toHaveLength(1);
      setVisibility('visible');
      expect(calls.beats).toHaveLength(2);
      expect(calls.beats[1].source).not.toBe(first);
      vi.advanceTimersByTime(120_000);
      expect(calls.beats).toHaveLength(3);
      expect(calls.beats[2].source).toBe(calls.beats[1].source);
    } finally {
      vi.useRealTimers();
    }
  });

  it('no workspace: nothing is sent', () => {
    const { unmount } = renderHook(() => useOperatorHeartbeat(undefined));
    pageTransition('pagehide', false);
    unmount();
    expect(calls.beats).toEqual([]);
    expect(calls.leaves).toEqual([]);
  });
});

describe('who counts a hidden tab as gone', () => {
  it('iPhone, iPod and iPad (also iPadOS posing as a Mac); not desktops or Android', () => {
    expect(leavesWhenHidden({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true);
    expect(leavesWhenHidden({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', maxTouchPoints: 5 })).toBe(true);
    expect(leavesWhenHidden({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5, platform: 'MacIntel' })).toBe(true);
    expect(leavesWhenHidden({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0, platform: 'MacIntel' })).toBe(false);
    expect(leavesWhenHidden({ userAgent: DESKTOP, maxTouchPoints: 0 })).toBe(false);
    expect(leavesWhenHidden({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', maxTouchPoints: 5 })).toBe(false);
    expect(leavesWhenHidden(undefined)).toBe(false);
  });

  it('tab ids are what the server accepts, and new each time', () => {
    const a = newPresenceSourceId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newPresenceSourceId()).not.toBe(a);
  });
});

describe('sendOperatorLeave', () => {
  it('a beacon: the leave URL and a JSON string (sent as text/plain)', () => {
    const beacon = vi.fn(() => true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    Object.defineProperty(window.navigator, 'sendBeacon', { value: beacon, configurable: true });
    api.sendOperatorLeave('ws-1', 'tab-abcdefgh');
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, body] = beacon.mock.calls[0] as unknown as [string, string];
    expect(url).toMatch(/\/api\/operator-activity\/leave$/);
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toEqual({ workspace_id: 'ws-1', source_id: 'tab-abcdefgh' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sendBeacon refused (or missing): a keepalive fetch with the cookie, as text/plain', () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    Object.defineProperty(window.navigator, 'sendBeacon', { value: () => false, configurable: true });
    api.sendOperatorLeave('ws-1', 'tab-abcdefgh');
    Object.defineProperty(window.navigator, 'sendBeacon', { value: undefined, configurable: true });
    api.sendOperatorLeave('ws-1', 'tab-abcdefgh');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/operator-activity\/leave$/);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'include' });
    expect((init.headers as Record<string, string>)['Content-Type']).toMatch(/^text\/plain/);
  });

  it('the heartbeat carries the tab id', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await api.sendOperatorHeartbeat('ws-1', false, 'tab-abcdefgh');
    await api.sendOperatorHeartbeat('ws-1', true);
    const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)));
    expect(bodies).toEqual([
      { workspace_id: 'ws-1', interacted: false, source_id: 'tab-abcdefgh' },
      { workspace_id: 'ws-1', interacted: true },
    ]);
  });
});

describe('the server before migration 282b', () => {
  it('a beat keeps the plain lease write; a beacon changes nothing', async () => {
    vi.resetModules();
    const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
    const rpcs: string[] = [];
    const missing = { data: null, error: { code: '42883', message: 'function public.operator_presence_beat(uuid, uuid, text, timestamp with time zone, bigint) does not exist' } };
    vi.doMock('../../../server/supabase.js', () => ({
      getServiceClient: () => ({
        rpc: async (fn: string) => { rpcs.push(fn); return missing; },
        from: (table: string) => ({
          upsert: async (row: Record<string, unknown>) => { writes.push({ table, row }); return { data: null, error: null }; },
        }),
      }),
    }));
    const presence = await import('../../../server/services/widget/operatorPresence.js');
    presence.__resetPresenceSourcesProbe();
    const now = new Date('2026-10-22T10:00:00Z');
    expect(await presence.recordOperatorPresenceBeat({} as never, 'ws', 'u', now, 'tab-abcdefgh')).toBe(true);
    expect(writes).toEqual([{ table: 'operator_presence_live', row: { workspace_id: 'ws', user_id: 'u', last_seen_at: now.toISOString(), updated_at: now.toISOString() } }]);
    // Believed missing for a while: the next beat goes straight to the upsert.
    await presence.recordOperatorPresenceBeat({} as never, 'ws', 'u', new Date(now.getTime() + 120_000), 'tab-abcdefgh');
    expect(rpcs).toEqual(['operator_presence_beat']);
    expect(writes).toHaveLength(2);
    expect(await presence.endOperatorPresenceSource({} as never, 'ws', 'u', 'tab-abcdefgh', now)).toBe('unknown');
    vi.doUnmock('../../../server/supabase.js');
  });
});
