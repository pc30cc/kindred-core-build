/**
 * The shipped loader.js and the visitor credential (for browsers that drop
 * the HttpOnly dvsid cookie; server/services/widget/visitorIdentity.ts):
 *
 *   - it keeps the bootstrap's credential on the token bus (`vc`, which the
 *     runtime sends too) and, only while the server says the cookie did not
 *     arrive, in the page's own localStorage;
 *   - the next page view sends the stored one in the CORS-simple bootstrap
 *     body; a browser that keeps the cookie has its stored copy removed;
 *   - /track carries it in its body (CORS-simple) or, in the header form, as
 *     X-Widget-Visitor;
 *   - a new signed-in person on this browser (`fresh_visitor`) sends none and
 *     the stored one is dropped;
 *   - an older backend that sends none leaves everything as it was.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
type Win = Record<string, unknown>;
const win = () => window as unknown as Win;
const KEY = 'gs:vc:ws-test';

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
    const el = node as unknown as { tagName?: string; onload?: () => void; getAttribute?: (n: string) => string | null };
    if ((el.tagName === 'SCRIPT' || el.tagName === 'LINK') && el.getAttribute?.('data-gs-runtime-call') !== 'true') {
      setTimeout(() => { if (typeof el.onload === 'function') el.onload(); }, 0);
    }
    return real(node) as T;
  });
}

const CONFIG = { enabled: true, features: { chat: true, visitorTracking: true }, primaryColor: '#123456', templateId: 'default' };
type Init = { method?: string; headers?: Record<string, string>; body?: string };
let fetchMock: ReturnType<typeof vi.fn>;

async function boot(answer: Record<string, unknown>, attrs: Record<string, string> = {}) {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const k of Object.keys(win())) if (k.startsWith('__gs')) delete win()[k];
  const el = document.createElement('script');
  el.setAttribute('src', 'https://app.test/widget/loader.js');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.head.appendChild(el);
  win().__gs_id = 'ws-test';
  win().__gs_api_base = 'https://api.test';
  patchAppendChild(document.head);
  fetchMock = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/boot')) {
      return Promise.resolve(response({ session_token: 'tok-1', workspace_id: 'ws-test', availability: { state: 'online' }, protocol: 3, config: CONFIG, ...answer }));
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
const tokenBus = () => win().__gs_token as { vc?: string };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loader: the visitor credential', () => {
  it('keeps it in memory and in the page\'s storage while the cookie did not arrive, and sends it with /track', async () => {
    await boot({ visitor_credential: 'vc-1', visitor_cookie: false });
    expect(tokenBus().vc).toBe('vc-1');
    expect(window.localStorage.getItem(KEY)).toBe('vc-1');
    expect(calls('/api/widget/track').length).toBeGreaterThan(0);
    const track = bodyOf('/api/widget/track');
    expect(track.visitor_credential).toBe('vc-1');
    // CORS-simple: no custom header that would need a preflight.
    expect((calls('/api/widget/track')[0][1] as Init).headers).toBeUndefined();
  });

  it('the next page view sends the stored credential in the bootstrap body', async () => {
    window.localStorage.setItem(KEY, 'vc-stored');
    await boot({ visitor_credential: 'vc-stored', visitor_cookie: false });
    expect(bodyOf('/api/widget/boot').visitor_credential).toBe('vc-stored');
    const init = calls('/api/widget/boot')[0][1] as Init;
    expect(init.headers).toBeUndefined();
  });

  it('a browser that keeps the cookie stores nothing and sends nothing more', async () => {
    window.localStorage.setItem(KEY, 'vc-old');
    await boot({ visitor_credential: 'vc-2', visitor_cookie: true });
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(tokenBus().vc).toBe('');
    expect(bodyOf('/api/widget/track').visitor_credential).toBeUndefined();
  });

  it('a new signed-in person on this browser sends no credential, and the stored one is dropped', async () => {
    window.localStorage.setItem(KEY, 'vc-previous-person');
    window.localStorage.setItem('gs:csub:ws-test', 'u-previous');
    await boot({ visitor_credential: 'vc-new-person', visitor_cookie: false }, { 'data-commerce-subject': 'u-next' });
    const sent = bodyOf('/api/widget/boot');
    expect(sent.fresh_visitor).toBe(true);
    expect(sent.visitor_credential).toBeUndefined();
    // The answer's credential is the new person's.
    expect(window.localStorage.getItem(KEY)).toBe('vc-new-person');
  });

  it('an older backend that sends no credential leaves the stored one alone', async () => {
    window.localStorage.setItem(KEY, 'vc-kept');
    await boot({});
    expect(window.localStorage.getItem(KEY)).toBe('vc-kept');
    expect(tokenBus().vc).toBe('vc-kept');
  });

  it('the header form of /track (an older backend) carries it as X-Widget-Visitor', async () => {
    await boot({ visitor_credential: 'vc-3', visitor_cookie: false, protocol: 2 });
    const init = calls('/api/widget/track')[0][1] as Init;
    expect(init.headers?.['X-Widget-Visitor']).toBe('vc-3');
    expect(init.headers?.['X-Widget-Token']).toBe('tok-1');
  });
});
