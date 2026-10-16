/**
 * The shipped loader.js:
 *
 *   - a 429 (rate limited) is asked again exactly ONCE, after the wait the
 *     server names (`retry_after` in the body, else the Retry-After header),
 *     at most 10 s (2 s when it names none), plus up to 0.5 s of jitter; a
 *     second 429 is final. 5xx keep their own retries.
 *   - POST /api/widget/track and /api/realtime/visitor-presence go CORS-simple
 *     (no request header; the token as `widget_token` in the JSON body) only
 *     when the bootstrap said `protocol` >= 3. Any older backend gets exactly
 *     the request it always got: JSON with X-Widget-Token.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
type Win = Record<string, unknown>;
const win = () => window as unknown as Win;

function response(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  };
}

function patchAppendChild(target: HTMLElement) {
  const real = target.appendChild.bind(target);
  return vi.spyOn(target, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const el = node as unknown as { tagName?: string; onload?: () => void; getAttribute?: (n: string) => string | null };
    if ((el.tagName === 'SCRIPT' || el.tagName === 'LINK') && el.getAttribute?.('data-gs-runtime-call') !== 'true') {
      setTimeout(() => { if (typeof el.onload === 'function') el.onload(); }, 0);
    }
    return real(node) as T;
  });
}

const CONFIG = { enabled: true, features: { chat: true, visitorTracking: true }, primaryColor: '#123456', templateId: 'default' };
type Answer = ReturnType<typeof response>;
let fetchMock: ReturnType<typeof vi.fn>;
let readyFired = 0;

/** Boots the loader; bootstrap answers are used in order (the last repeats). */
async function boot(bootstrapAnswers: Answer[]) {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const k of ['__gs', '__gs_id', '__gs_api_base', '__gs_loaded', '__gs_loader_injected', '__gs_token', '__gs_runtime', '__gs_policy', '__gs_session_id', '__gs_visitor_presence']) {
    delete win()[k];
  }
  const el = document.createElement('script');
  el.setAttribute('src', 'https://app.test/widget/loader.js');
  document.head.appendChild(el);
  win().__gs_id = 'ws-test';
  win().__gs_api_base = 'https://api.test';
  readyFired = 0;
  win().__gs = [['onReady', () => { readyFired += 1; }]];
  patchAppendChild(document.head);
  let n = 0;
  fetchMock = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/bootstrap')) return Promise.resolve(bootstrapAnswers[Math.min(n++, bootstrapAnswers.length - 1)]);
    if (u.includes('/api/widget/config')) return Promise.resolve(response(CONFIG));
    if (u.includes('/api/widget/track')) return Promise.resolve(response({ ok: true, session_id: 'sess-1' }));
    if (u.includes('/api/realtime/visitor-presence')) return Promise.resolve(response({ vendor: 'database', presence: false }));
    return Promise.resolve(response({}));
  });
  win().fetch = fetchMock;
  new Function(LOADER_SRC).call(window);
  await vi.advanceTimersByTimeAsync(0);
}

type Init = { method?: string; credentials?: string; headers?: Record<string, string>; body?: string };
const calls = (part: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(part));
const bootstrapCount = () => calls('/api/widget/bootstrap').length;
const current = (protocol: number, extra: Record<string, unknown> = {}) => response({
  session_token: 'tok-new', workspace_id: 'ws-test', availability: { state: 'online' }, protocol, config: CONFIG, ...extra,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('429: one retry after the wait the server names', () => {
  it('waits `retry_after` seconds (+ jitter), asks once more, and the widget comes up', async () => {
    await boot([response({ code: 'RATE_LIMITED', retry_after: 3 }, 429), current(3)]);
    expect(bootstrapCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2999);
    expect(bootstrapCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bootstrapCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(10);
    expect(readyFired).toBe(1);
  });

  it('a second 429 is final: no third request, no ready', async () => {
    await boot([response({ retry_after: 1 }, 429)]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bootstrapCount()).toBe(2);
    expect(readyFired).toBe(0);
  });

  it('the Retry-After header counts when the body names nothing, capped at 10 s', async () => {
    await boot([response({ error: 'busy' }, 429, { 'retry-after': '120' }), current(3)]);
    await vi.advanceTimersByTimeAsync(9999);
    expect(bootstrapCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(bootstrapCount()).toBe(2);
  });

  it('naming nothing at all → 2 s; the jitter adds at most 0.5 s', async () => {
    (Math.random as unknown as ReturnType<typeof vi.fn>).mockReturnValue(0.999);
    await boot([response({}, 429), current(3)]);
    await vi.advanceTimersByTimeAsync(2498);
    expect(bootstrapCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(bootstrapCount()).toBe(2);
  });

  it('5xx keep their own quick retries (unchanged)', async () => {
    await boot([response({}, 503), current(3)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bootstrapCount()).toBe(2);
    expect(readyFired).toBe(1);
  });
});

describe('track and visitor-presence: CORS-simple only for a backend that says protocol >= 3', () => {
  async function pageView(protocol: number | undefined) {
    const answer = protocol === undefined
      ? response({ session_token: 'tok-new', workspace_id: 'ws-test', availability: { state: 'online' }, protocol: 2, config: CONFIG })
      : current(protocol);
    await boot([answer]);
    await vi.advanceTimersByTimeAsync(2500); // scheduleDeferred → track → presence
    const track = calls('/api/widget/track');
    const presence = calls('/api/realtime/visitor-presence');
    expect(track).toHaveLength(1);
    expect(presence).toHaveLength(1);
    return { track: track[0][1] as Init, presence: presence[0][1] as Init };
  }

  it('protocol 3: no request header at all (text/plain, no preflight), the token in the body, never in the URL', async () => {
    const { track, presence } = await pageView(3);
    for (const init of [track, presence]) {
      expect(init.method).toBe('POST');
      expect(init.credentials).toBe('include');
      expect(init).not.toHaveProperty('headers');
      expect(JSON.parse(String(init.body)).widget_token).toBe('tok-new');
    }
    expect(JSON.parse(String(track.body))).toMatchObject({ workspace_id: 'ws-test', event: 'page_view' });
    expect(JSON.parse(String(presence.body))).toEqual({ workspace_id: 'ws-test', session_id: 'sess-1', widget_token: 'tok-new' });
    for (const c of [...calls('/api/widget/track'), ...calls('/api/realtime/visitor-presence')]) {
      expect(String(c[0])).not.toContain('tok-new');
    }
  });

  it('protocol 2 (a backend from before): exactly the old request — JSON with X-Widget-Token, no token in the body', async () => {
    const { track, presence } = await pageView(undefined);
    for (const init of [track, presence]) {
      expect(init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Widget-Token': 'tok-new' });
      expect(JSON.parse(String(init.body))).not.toHaveProperty('widget_token');
    }
  });
});
