/**
 * The shipped loader.js against current and older backends.
 *
 * Current backend: the first POST goes to /api/widget/boot, CORS-simple (no
 * request headers at all → text/plain, no preflight), asks for
 * `include_config`, and
 * the answer (`protocol: 2`) carries the GET /config body — so the loader
 * makes no /api/widget/config request.
 *
 * Older backend (frontend and backend deploy independently, in any order):
 * it has no /boot route, so it answers before any bootstrap work. Whatever
 * comes back — a network/CORS error, 401/404, 400, a 2xx without `protocol`,
 * or a token for another workspace — is DROPPED and the same body is sent
 * once more as application/json to /api/widget/bootstrap; the loader then
 * continues exactly as before (GET /config with X-Widget-Token).
 *
 * 401/403/404 and `{disabled}` from a current backend are final (no second
 * request), 5xx are retried as before.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOADER_SRC = readFileSync(resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
type Win = Record<string, unknown>;
const win = () => window as unknown as Win;

function response(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    headers: { get: () => null },
  };
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

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

const CONFIG = {
  enabled: true,
  features: { chat: true },
  primaryColor: '#123456',
  templateId: 'default',
};

type Answer = ReturnType<typeof response> | Error;
let fetchMock: ReturnType<typeof vi.fn>;
let readyFired = 0;

/**
 * Boots the loader; `bootstrapAnswers` are returned in order for successive
 * bootstrap requests (the last one repeats).
 */
async function boot(bootstrapAnswers: Answer[], attrs: Record<string, string> = {}) {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const k of ['__gs', '__gs_id', '__gs_api_base', '__gs_loaded', '__gs_loader_injected', '__gs_token', '__gs_runtime', '__gs_policy']) {
    delete win()[k];
  }
  const el = document.createElement('script');
  el.setAttribute('src', 'https://app.test/widget/loader.js');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.head.appendChild(el);
  win().__gs_id = 'ws-test';
  win().__gs_api_base = 'https://api.test';
  readyFired = 0;
  win().__gs = [['onReady', () => { readyFired += 1; }]];
  patchAppendChild(document.head);
  let n = 0;
  fetchMock = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/boot')) {
      const answer = bootstrapAnswers[Math.min(n++, bootstrapAnswers.length - 1)];
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    if (u.includes('/api/widget/config')) return Promise.resolve(response(CONFIG));
    return Promise.resolve(response({}));
  });
  win().fetch = fetchMock;
  new Function(LOADER_SRC).call(window);
  await flush();
}

type Init = { method?: string; credentials?: string; headers?: Record<string, string>; body?: string };
const calls = (part: string) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(part));
const bootstrapInits = () => calls('/api/widget/boot').map((c) => (c[1] || {}) as Init);
const bootstrapUrls = () => calls('/api/widget/boot').map((c) => String(c[0]));
const configCalls = () => calls('/api/widget/config');

const current = (extra: Record<string, unknown> = {}) => response({
  session_token: 'tok-new',
  workspace_id: 'ws-test',
  availability: { state: 'online' },
  protocol: 2,
  ...extra,
});
const legacy = (extra: Record<string, unknown> = {}) => response({
  session_token: 'tok-legacy',
  workspace_id: 'ws-test',
  availability: { state: 'online' },
  ...extra,
});

function expectJsonResend(inits: Init[]) {
  expect(inits).toHaveLength(2);
  // CORS-simple to /boot (an older backend has no such route), JSON to /bootstrap.
  expect(bootstrapUrls()).toEqual(['https://api.test/api/widget/boot', 'https://api.test/api/widget/bootstrap']);
  expect(inits[0].headers).toBeUndefined();
  expect(inits[1].headers).toEqual({ 'Content-Type': 'application/json' });
  expect(inits[1].body).toBe(inits[0].body);
  expect(inits[1].credentials).toBe('include');
}

beforeEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('current backend', () => {
  it('sends the bootstrap CORS-simple: no headers at all, include_config in the JSON body', async () => {
    await boot([current({ config: CONFIG })]);
    const [init] = bootstrapInits();
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init).not.toHaveProperty('headers');
    expect(JSON.parse(String(init.body))).toEqual({
      workspace_id: 'ws-test',
      origin: window.location.origin,
      include_config: true,
    });
  });

  it('uses the inline config: no /api/widget/config request, the launcher is configured, onReady fires', async () => {
    await boot([current({ config: CONFIG })]);
    expect(bootstrapInits()).toHaveLength(1);
    expect(configCalls()).toHaveLength(0);
    expect(readyFired).toBe(1);
    const state = await new Promise<{ ready: boolean }>((res) => (win().__gs as { push: (c: unknown[]) => void }).push(['getState', res]));
    expect(state.ready).toBe(true);
    const shell = document.querySelector('gs-widget') as HTMLElement & { shadowRoot: ShadowRoot | null };
    const styled = Array.from(shell?.shadowRoot?.querySelectorAll('*') || []).some((n) => (n as HTMLElement).style?.getPropertyValue('--gs-primary') === '#123456');
    expect(styled).toBe(true);
  });

  it('without an inline config (not configured) it asks GET /config as before, with the token', async () => {
    await boot([current()]);
    expect(bootstrapInits()).toHaveLength(1);
    expect(configCalls()).toHaveLength(1);
    expect((configCalls()[0][1] as Init).headers).toEqual({ 'X-Widget-Token': 'tok-new' });
    expect(readyFired).toBe(1);
  });

  it.each([
    ['400 MISSING_WORKSPACE', response({ error: 'x', code: 'MISSING_WORKSPACE', protocol: 3 }, 400)],
    ['403 ORIGIN_DENIED', response({ error: 'Origin not authorized', code: 'ORIGIN_DENIED', protocol: 3 }, 403)],
    ['404 workspace not found', response({ disabled: true, error: 'Workspace not found', protocol: 3 }, 404)],
    ['500', response({ error: 'Bootstrap failed', protocol: 3 }, 500)],
  ])('%s from the current handler (it carries `protocol`) is final: one request to /boot, no GET /config, launcher in error mode', async (_label, answer) => {
    await boot([answer]);
    // A 500 is retried by fetchWithRetry first, as always: wait for all of
    // its attempts (so none spills into the next test).
    await new Promise((r) => setTimeout(r, 1200));
    await flush();
    expect(bootstrapUrls().every((u) => u.endsWith('/api/widget/boot'))).toBe(true);
    expect(configCalls()).toHaveLength(0);
    expect(readyFired).toBe(0);
  });

  it('a 429 on /boot is final once fetchWithRetry has waited the server\'s time: no JSON request to /bootstrap (same budget)', async () => {
    await boot([response({ code: 'RATE_LIMITED', retry_after: 1 }, 429)]);
    await new Promise((r) => setTimeout(r, 1700));
    await flush();
    expect(bootstrapUrls()).toEqual(['https://api.test/api/widget/boot', 'https://api.test/api/widget/boot']);
    expect(readyFired).toBe(0);
  });

  it('a disabled widget is final: one request, the shell is removed', async () => {
    await boot([response({ disabled: true, fallback: true, protocol: 2 })]);
    expect(bootstrapInits()).toHaveLength(1);
    expect(configCalls()).toHaveLength(0);
    expect(document.querySelector('gs-widget')).toBeNull();
  });

  it('5xx is retried as before (still CORS-simple)', async () => {
    await boot([response({ error: 'down' }, 503), current({ config: CONFIG })]);
    await new Promise((r) => setTimeout(r, 450));
    await flush();
    const inits = bootstrapInits();
    expect(inits).toHaveLength(2);
    expect(inits.every((i) => i.headers === undefined)).toBe(true);
    expect(readyFired).toBe(1);
  });
});

describe('older backend: the first answer is dropped, the same body is re-sent as JSON once', () => {
  it.each([
    ['401 MISSING_TOKEN (its token gate: no /boot route)', response({ error: 'Missing token', code: 'MISSING_TOKEN' }, 401)],
    ['404', response({ error: 'Not found' }, 404)],
  ])('an error without `protocol` from /boot: %s', async (_label, first) => {
    await boot([first, legacy()]);
    expectJsonResend(bootstrapInits());
    expect(readyFired).toBe(1);
  });

  it('a network / CORS error', async () => {
    await boot([new TypeError('Failed to fetch'), legacy()]);
    expectJsonResend(bootstrapInits());
    expect((configCalls()[0][1] as Init).headers).toEqual({ 'X-Widget-Token': 'tok-legacy' });
    expect(readyFired).toBe(1);
  });

  it('400 (the body was not read: MISSING_WORKSPACE)', async () => {
    await boot([response({ error: 'workspace_id required', code: 'MISSING_WORKSPACE' }, 400), legacy()]);
    expectJsonResend(bootstrapInits());
    expect(readyFired).toBe(1);
  });

  it('200 without `protocol`: that token is never used', async () => {
    await boot([legacy({ session_token: 'tok-from-origin-mapping' }), legacy()]);
    expectJsonResend(bootstrapInits());
    expect(configCalls()).toHaveLength(1);
    expect((configCalls()[0][1] as Init).headers).toEqual({ 'X-Widget-Token': 'tok-legacy' });
    expect((win().__gs_token as { get: () => string }).get()).toBe('tok-legacy');
  });

  it('{disabled} without `protocol` (another workspace via origin mapping) is not believed', async () => {
    await boot([response({ disabled: true, fallback: true }), legacy()]);
    expectJsonResend(bootstrapInits());
    expect(document.querySelector('gs-widget')).not.toBeNull();
    expect(readyFired).toBe(1);
  });

  it('a token for another workspace is dropped', async () => {
    await boot([current({ workspace_id: 'ws-other', session_token: 'tok-other' }), legacy()]);
    expectJsonResend(bootstrapInits());
    expect((configCalls()[0][1] as Init).headers).toEqual({ 'X-Widget-Token': 'tok-legacy' });
  });

  it('a commerce subject reset (fresh_visitor) reaches the older backend in the JSON re-send', async () => {
    window.localStorage.setItem('gs:csub:ws-test', 'ualice');
    await boot([new TypeError('Failed to fetch'), legacy()], { 'data-commerce-subject': 'ubob' });
    const inits = bootstrapInits();
    expectJsonResend(inits);
    expect(JSON.parse(String(inits[1].body)).fresh_visitor).toBe(true);
    // Committed only after the bootstrap that reset both cookies succeeded.
    expect(window.localStorage.getItem('gs:csub:ws-test')).toBe('ubob');
  });

  it('an error from the JSON re-send keeps today\'s handling (one re-send only)', async () => {
    await boot([new TypeError('Failed to fetch'), response({ error: 'x' }, 403)]);
    expect(bootstrapInits()).toHaveLength(2);
    expect(configCalls()).toHaveLength(0);
    expect(readyFired).toBe(0);
  });
});

describe('session manager re-bootstrap (bus.bootstrap)', () => {
  async function rebootstrap(answers: Answer[]) {
    await boot([current({ config: CONFIG })]);
    let n = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/widget/boot')) {
        const a = answers[Math.min(n++, answers.length - 1)];
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
      }
      return Promise.resolve(response({}));
    });
    fetchMock.mockClear();
    const bus = win().__gs_token as { bootstrap: (o: { force: boolean }) => Promise<string | null> };
    return bus.bootstrap({ force: true });
  }

  it('current backend: one CORS-simple request, no include_config', async () => {
    const token = await rebootstrap([current({ session_token: 'tok-re' })]);
    expect(token).toBe('tok-re');
    const inits = bootstrapInits();
    expect(inits).toHaveLength(1);
    expect(inits[0].headers).toBeUndefined();
    expect(JSON.parse(String(inits[0].body))).toEqual({ workspace_id: 'ws-test', origin: window.location.origin });
  });

  it.each([
    ['network error', new TypeError('Failed to fetch')],
    ['400', response({ code: 'MISSING_WORKSPACE' }, 400)],
    ['200 without protocol', legacy({ session_token: 'tok-wrong' })],
  ])('older backend (%s): re-sent once as JSON, that token adopted', async (_label, first) => {
    const token = await rebootstrap([first, legacy({ session_token: 'tok-json' })]);
    expect(token).toBe('tok-json');
    expectJsonResend(bootstrapInits());
  });

  it('an error from the current handler (it carries `protocol`) is final (no second request)', async () => {
    const token = await rebootstrap([response({ code: 'ORIGIN_DENIED', protocol: 3 }, 403)]);
    expect(token).toBeNull();
    expect(bootstrapInits()).toHaveLength(1);
  });

  it('an error without `protocol` (an older backend has no /boot) is re-sent once as JSON', async () => {
    const token = await rebootstrap([response({ code: 'MISSING_TOKEN' }, 401), legacy({ session_token: 'tok-json' })]);
    expect(token).toBe('tok-json');
    expectJsonResend(bootstrapInits());
  });
});
