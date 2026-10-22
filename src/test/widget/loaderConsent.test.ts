/**
 * The shipped loader.js and visitor privacy (P-01, docs/WIDGET_PUBLIC_API.md
 * "Privacy and consent"):
 *
 *   - a tracked page is its path: `?email=…&token=…` is not sent unless the
 *     workspace keeps query strings (config.privacy.keepQuery), and the
 *     referrer goes without its query either way;
 *   - while the workspace waits for consent (config.privacy.consent), or the
 *     browser sends Global Privacy Control, nothing is tracked (no /track,
 *     no Smart Engagement storage) until the page pushes ['consent', true];
 *     /track then says the consent was given;
 *   - a ['consent', false] queued before the loader ran holds tracking;
 *   - ['consent', false] after tracking started stops the heartbeat and the
 *     presence socket.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
type Win = Record<string, unknown>;
const win = () => window as unknown as Win;
const SMART_KEY = 'gs:smart:v1:ws-test:session';

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    headers: { get: () => null },
  };
}

function patchAppendChild(target: HTMLElement) {
  const real = target.appendChild.bind(target);
  return vi.spyOn(target, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const el = node as unknown as { tagName?: string; onload?: () => void };
    if (el.tagName === 'SCRIPT' || el.tagName === 'LINK') setTimeout(() => { if (typeof el.onload === 'function') el.onload(); }, 0);
    return real(node) as T;
  });
}

const SMART = { enabled: true, engineUrl: 'https://cdn.test/widget/smart-engine.js', rules: [{ id: 'r1', version: 1, mode: 'bubble', trigger: { type: 'time_on_page', seconds: 999 } }] };
type Init = { method?: string; headers?: Record<string, string>; body?: string };
let fetchMock: ReturnType<typeof vi.fn>;

async function boot(config: Record<string, unknown> = {}, queued: unknown[][] = []) {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const k of Object.keys(win())) if (k.startsWith('__gs')) delete win()[k];
  if (queued.length) win().__gs = queued.slice();
  const el = document.createElement('script');
  el.setAttribute('src', 'https://app.test/widget/loader.js');
  document.head.appendChild(el);
  win().__gs_id = 'ws-test';
  win().__gs_api_base = 'https://api.test';
  patchAppendChild(document.head);
  const full = { enabled: true, features: { chat: true, visitorTracking: true }, primaryColor: '#123456', templateId: 'default', smart: SMART, ...config };
  fetchMock = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/boot')) {
      return Promise.resolve(response({ session_token: 'tok-1', workspace_id: 'ws-test', availability: { state: 'online' }, protocol: 3, config: full }));
    }
    if (u.includes('/api/widget/track')) return Promise.resolve(response({ ok: true, session_id: 'sess-1' }));
    if (u.includes('/api/realtime/visitor-presence')) return Promise.resolve(response({ vendor: 'database', presence: false }));
    return Promise.resolve(response({}));
  });
  win().fetch = fetchMock;
  new Function(LOADER_SRC).call(window);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2500); // scheduleDeferred → track → presence
}

const calls = (part: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(part));
const bodyOf = (part: string, i = 0) => JSON.parse(String((calls(part)[i][1] as Init).body || '{}')) as Record<string, unknown>;
const push = (...cmd: unknown[]) => (win().__gs as { push: (c: unknown[]) => void }).push(cmd);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, '', '/shop/checkout?email=sara%40example.com&token=s3cret#step-2');
  Object.defineProperty(document, 'referrer', { value: 'https://search.test/results?q=sara%40example.com', configurable: true });
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: undefined, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loader: what a tracked page is', () => {
  it('the path only, and the referrer without its query', async () => {
    await boot();
    const track = bodyOf('/api/widget/track');
    expect(track.current_page).toBe('/shop/checkout');
    expect(track.referrer).toBe('https://search.test/results');
    expect(JSON.stringify(track)).not.toContain('s3cret');
    expect(JSON.stringify(track)).not.toContain('example.com');
    // Nothing asked for consent: tracked, saying no consent was given or refused.
    expect(track.consent).toBeNull();
  });

  it('its query string too when the workspace keeps it', async () => {
    await boot({ privacy: { keepQuery: true } });
    expect(bodyOf('/api/widget/track').current_page).toBe('/shop/checkout?email=sara%40example.com&token=s3cret');
    expect(bodyOf('/api/widget/track').referrer).toBe('https://search.test/results');
  });
});

describe('loader: waiting for consent', () => {
  it('tracks nothing and stores nothing until the page gives consent', async () => {
    await boot({ privacy: { consent: true } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls('/api/widget/track')).toHaveLength(0);
    expect(window.sessionStorage.getItem(SMART_KEY)).toBeNull();

    push('consent', true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls('/api/widget/track')).toHaveLength(1);
    expect(bodyOf('/api/widget/track').consent).toBe(true);
    expect(window.sessionStorage.getItem(SMART_KEY)).not.toBeNull();
  });

  it('a consent the page queued before the loader ran is applied first', async () => {
    await boot({ privacy: { consent: true } }, [['consent', true]]);
    expect(calls('/api/widget/track')).toHaveLength(1);
    expect(bodyOf('/api/widget/track').consent).toBe(true);
  });

  it('a refusal queued before the loader ran holds tracking even where no consent is asked', async () => {
    await boot({}, [['consent', false]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls('/api/widget/track')).toHaveLength(0);
    expect(window.sessionStorage.getItem(SMART_KEY)).toBeNull();
  });

  it('only true (or "granted") is consent', async () => {
    await boot({ privacy: { consent: true } });
    push('consent', 'yes');
    push('consent', 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls('/api/widget/track')).toHaveLength(0);
    push('consent', 'granted');
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls('/api/widget/track')).toHaveLength(1);
  });

  it('Global Privacy Control waits for consent whatever the workspace says', async () => {
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    await boot();
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls('/api/widget/track')).toHaveLength(0);
    push('consent', true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(calls('/api/widget/track')).toHaveLength(1);
    expect(bodyOf('/api/widget/track').consent).toBe(true);
  });

  it('custom events (gsAnalytics.track): the path only, the consent given, nothing once it is taken back', async () => {
    await boot({ privacy: { consent: true } }, [['consent', true]]);
    const gs = win().gsAnalytics as { track: (name: string, props?: unknown) => void };
    gs.track('signup', { plan: 'pro' });
    expect(bodyOf('/api/widget/event')).toMatchObject({ event_name: 'signup', page_url: '/shop/checkout', consent: true });
    push('consent', false);
    gs.track('signup');
    expect(calls('/api/widget/event')).toHaveLength(1);
  });

  it('a consent taken back stops the heartbeat and the presence socket', async () => {
    await boot();
    expect(calls('/api/widget/track')).toHaveLength(1);
    const stop = vi.fn();
    (win().__gs_visitor_presence as { stop: () => void }).stop = stop;
    await vi.advanceTimersByTimeAsync(61_000);
    const beats = calls('/api/widget/action').length;
    expect(beats).toBeGreaterThan(0);

    push('consent', false);
    expect(stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls('/api/widget/action')).toHaveLength(beats);
  });
});
