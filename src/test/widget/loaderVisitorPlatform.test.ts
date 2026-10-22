/**
 * The shipped loader.js names the visitor's browser and OS on the page-view
 * track (`browser`, `os`), which the visitor list shows. Phones are named
 * before computers: an iPhone says "like Mac OS X" and Android says "Linux",
 * and the old Mac/Linux-first order filed them under macOS and Linux (seen
 * 2026-10-22 on an iPhone in iOS Safari). An iPad that asks for the desktop
 * site says Macintosh; its touch screen tells it apart.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
type Win = Record<string, unknown>;
const win = () => window as unknown as Win;

function response(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    headers: { get: () => null },
  };
}

const CONFIG = { enabled: true, features: { chat: true, visitorTracking: true }, primaryColor: '#123456', templateId: 'default' };
const BOOT = { session_token: 'tok', workspace_id: 'ws-test', availability: { state: 'online' }, protocol: 3, config: CONFIG };

function setDevice(userAgent: string, maxTouchPoints = 0) {
  Object.defineProperty(window.navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(window.navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true });
}

/** One page view; returns the `browser` and `os` the track carried. */
async function trackedPlatform(): Promise<{ browser: string; os: string }> {
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
  const fetchMock = vi.fn((url: string, _init?: unknown) => {
    const u = String(url);
    if (u.includes('/api/widget/boot')) return Promise.resolve(response(BOOT));
    if (u.includes('/api/widget/track')) return Promise.resolve(response({ ok: true, session_id: 'sess-1' }));
    if (u.includes('/api/realtime/visitor-presence')) return Promise.resolve(response({ vendor: 'database', presence: false }));
    return Promise.resolve(response({}));
  });
  win().fetch = fetchMock;
  new Function(LOADER_SRC).call(window);
  await vi.advanceTimersByTimeAsync(2500); // scheduleDeferred → track
  const track = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/widget/track'));
  expect(track).toHaveLength(1);
  const body = JSON.parse(String((track[0][1] as { body?: string }).body));
  return { browser: body.browser, os: body.os };
}

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15',
  iphoneEdge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 EdgiOS/141.0.3537.85 Mobile/15E148 Safari/605.1.15',
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  androidEdge: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.3537.85',
  windowsLegacyEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.19582',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.85',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  linuxChrome: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

let realUserAgent: PropertyDescriptor | undefined;
let realTouchPoints: PropertyDescriptor | undefined;
beforeEach(() => {
  realUserAgent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent');
  realTouchPoints = Object.getOwnPropertyDescriptor(window.navigator, 'maxTouchPoints');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, d] of [['userAgent', realUserAgent], ['maxTouchPoints', realTouchPoints]] as const) {
    if (d) Object.defineProperty(window.navigator, k, d);
    else delete (window.navigator as unknown as Record<string, unknown>)[k];
  }
});

describe('the browser and OS a page view reports', () => {
  it.each([
    ['iPhone, Safari', UA.iphoneSafari, 5, 'Safari', 'iOS'],
    ['iPhone, Chrome', UA.iphoneChrome, 5, 'Chrome', 'iOS'],
    ['iPhone, Firefox', UA.iphoneFirefox, 5, 'Firefox', 'iOS'],
    ['iPhone, Edge', UA.iphoneEdge, 5, 'Edge', 'iOS'],
    ['iPad asking for the desktop site', UA.ipadDesktop, 5, 'Safari', 'iOS'],
    ['Android phone, Chrome', UA.androidChrome, 5, 'Chrome', 'Android'],
    ['Android phone, Edge', UA.androidEdge, 5, 'Edge', 'Android'],
    ['Windows, Edge before Chromium (EdgeHTML)', UA.windowsLegacyEdge, 0, 'Edge', 'Windows'],
    ['Mac, Safari', UA.macSafari, 0, 'Safari', 'macOS'],
    ['Windows, Edge', UA.windowsEdge, 0, 'Edge', 'Windows'],
    ['Windows, Firefox', UA.windowsFirefox, 0, 'Firefox', 'Windows'],
    ['Linux, Chrome', UA.linuxChrome, 0, 'Chrome', 'Linux'],
  ])('%s', async (_name, ua, touch, browser, os) => {
    setDevice(ua, touch);
    expect(await trackedPlatform()).toEqual({ browser, os });
  });
});
