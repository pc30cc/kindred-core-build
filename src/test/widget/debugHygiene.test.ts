/**
 * P0 — production console silence + explicit debug opt-in + PII redaction.
 *
 * Root-cause context: a production visitor was seeing verbose
 * `[Widget]`/`[Widget Runtime]` console output with NO browser-side debug
 * flag set (localStorage `gs:debug` absent, `window.__gs_debug` undefined,
 * the loader script's `data-debug` attribute absent). The cause was
 * `widget_settings.debug_mode` being true for that one workspace row,
 * reaching the visitor via the bootstrap config response's
 * `debugMode: ws.debug_mode ?? false` (server/routes/widget.ts) and OR'd
 * into both loader.js's `DEBUG` and runtime.js's `Util.debug`.
 *
 * This suite boots the REAL shipped loader.js and runtime.js inside jsdom
 * (not source-string assertions) and proves, behaviorally:
 *   - with debug OFF everywhere (no browser flags, and a normal
 *     `debugMode: false` config — the only server-driven path left after
 *     server/routes/widgetSettings.ts's fix), NOT ONE console.info/warn/
 *     log/debug call happens across loader bootstrap, config load, and
 *     runtime init/identity-resolve/transport-connect
 *   - each of the three approved explicit opt-ins (window.__gs_debug,
 *     localStorage 'gs:debug', the loader script's data-debug attribute)
 *     turns logging back on
 *   - even WITH debug explicitly enabled, a contact carrying email/phone
 *     never appears in any captured console output — the redacted
 *     `identity resolved` summary replaces the old full-object dump
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

function loadAsset(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(read(path)).call(window);
}

/** Captures every argument passed to console.log/info/warn/debug as flat
 *  strings, so tests can assert on substrings without caring which method
 *  a given log line used. */
function spyConsole() {
  const calls: string[] = [];
  const record = (...args: any[]) => {
    calls.push(args.map((a) => {
      try { return typeof a === 'string' ? a : JSON.stringify(a); }
      catch { return String(a); }
    }).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'debug').mockImplementation(record),
  ];
  return { calls, restore: () => spies.forEach((s) => s.mockRestore()) };
}

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
  document.head.querySelectorAll('script,link,style').forEach((n) => n.remove());
  try { localStorage.clear(); } catch { /* ignore */ }
  for (const key of Object.keys(window as any)) {
    if (key.indexOf('__gs') === 0) delete (window as any)[key];
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────
// Loader-level: bootstrap + config load
// ─────────────────────────────────────────────────────────────────────────

function autoLoad(node: any) {
  if (!node || (node.tagName !== 'SCRIPT' && node.tagName !== 'LINK')) return;
  if (node.getAttribute && node.getAttribute('data-gs-runtime-call') === 'true') return;
  setTimeout(() => { if (typeof node.onload === 'function') node.onload(); }, 0);
}
function patchAppendChild(target: any) {
  const real = target.appendChild.bind(target);
  return vi.spyOn(target, 'appendChild').mockImplementation((node: any) => {
    autoLoad(node);
    return real(node);
  });
}

const BOOTSTRAP_RESPONSE = { session_token: 'tok-1', workspace_id: 'ws-test', is_new_visitor: false, availability: { state: 'online' } };
const CONFIG_RESPONSE = { enabled: true, features: { chat: true }, primaryColor: '#3B82F6', debugMode: false };

async function bootLoader() {
  (window as any).__gs_id = 'ws-test';
  (window as any).__gs_api_base = 'https://api.test';
  patchAppendChild(document.head);
  (window as any).fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/widget/bootstrap')) return Promise.resolve(jsonResponse(BOOTSTRAP_RESPONSE));
    if (u.includes('/api/widget/config')) return Promise.resolve(jsonResponse(CONFIG_RESPONSE));
    return Promise.resolve(jsonResponse({}));
  });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(LOADER_SRC).call(window);
  await flush();
}

describe('loader.js — production default is a silent console', () => {
  it('zero console.log/info/warn/debug calls with no browser flags and debugMode:false', async () => {
    const spy = spyConsole();
    await bootLoader();
    (window as any).__gs.push(['open']);
    (window as any).__gs.push(['close']);
    await flush();
    expect(spy.calls).toEqual([]);
    spy.restore();
  });
});

describe('loader.js — explicit browser opt-ins turn logging back on', () => {
  it('window.__gs_debug = true', async () => {
    const spy = spyConsole();
    (window as any).__gs_debug = true;
    await bootLoader();
    expect(spy.calls.some((c) => c.includes('Loader version'))).toBe(true);
    spy.restore();
  });

  it('localStorage.setItem("gs:debug", "1")', async () => {
    const spy = spyConsole();
    localStorage.setItem('gs:debug', '1');
    await bootLoader();
    expect(spy.calls.some((c) => c.includes('Loader version'))).toBe(true);
    spy.restore();
  });

  it('a <script data-debug="true"> loader tag', async () => {
    const spy = spyConsole();
    const scriptEl = document.createElement('script');
    scriptEl.src = 'https://cdn.test/widget/loader.js';
    scriptEl.setAttribute('data-debug', 'true');
    document.body.appendChild(scriptEl);
    await bootLoader();
    // The data-debug attribute is read (and DEBUG flipped on) synchronously
    // at IIFE top-level — BEFORE the very first "Loader version:" log call
    // even fires, so that line is never a valid marker for this opt-in.
    // "workspace:" logs later, inside bootstrap(), after data-debug takes
    // effect.
    expect(spy.calls.some((c) => c.includes('workspace:'))).toBe(true);
    spy.restore();
  });

  it('debugMode:true from a normal (non-debug-flagged) browser still enables logging — the ONE server-driven opt-in, unchanged by design', async () => {
    // This is deliberately still supported (see server/routes/widgetSettings.ts's
    // new dedicated, platform-admin-only PATCH .../debug endpoint) — the
    // fix is WHO can set ws.debug_mode, not whether config.debugMode still
    // works as a documented opt-in once set. config.debugMode is only
    // applied once the /config fetch resolves — after "workspace:" already
    // logged — so the marker here has to be something that only happens
    // once DEBUG is confirmed on: pushing a command that hits a warn() path
    // (no runtimeUrl/styleUrl configured in this test's CONFIG_RESPONSE).
    const spy = spyConsole();
    (window as any).__gs_id = 'ws-test';
    (window as any).__gs_api_base = 'https://api.test';
    patchAppendChild(document.head);
    (window as any).fetch = vi.fn((url: string) => {
      const u = String(url);
      if (u.includes('/api/widget/bootstrap')) return Promise.resolve(jsonResponse(BOOTSTRAP_RESPONSE));
      if (u.includes('/api/widget/config')) return Promise.resolve(jsonResponse({ ...CONFIG_RESPONSE, debugMode: true }));
      return Promise.resolve(jsonResponse({}));
    });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(LOADER_SRC).call(window);
    await flush();
    (window as any).__gs.push(['open']);
    await flush();
    expect(spy.calls.some((c) => c.includes('No presentation template URLs'))).toBe(true);
    spy.restore();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Runtime-level: init, identity resolve, transport connect
// ─────────────────────────────────────────────────────────────────────────

interface RuntimeHarness {
  runtime: any;
  chat: { polls: any[] };
}

function bootRuntime(opts: { debug?: boolean; contact?: { name?: string; email?: string; phone?: string } } = {}): RuntimeHarness {
  const chatState = { polls: [] as any[] };
  (window as any).__gs_mod_chat = {
    sendMessage() {},
    loadHistory() {},
    loadConversationHistory() {},
    startPolling(opts2: any) {
      chatState.polls.push(opts2);
      return { stop() {} };
    },
  };
  const realAppend = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: any) => {
    if (node && node.tagName === 'SCRIPT') {
      setTimeout(() => { if (typeof node.onload === 'function') node.onload(); }, 0);
      return node;
    }
    return realAppend(node);
  }) as any);

  (window as any).fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/realtime/connect')) return Promise.resolve(jsonResponse({ vendor: 'polling_builtin' }));
    if (u.includes('/api/widget/identity/me')) {
      if (opts.contact) {
        return Promise.resolve(jsonResponse({ identity_state: 'identified', contact: opts.contact }));
      }
      return Promise.resolve(jsonResponse({ identified: false, visitor: null }));
    }
    if (u.includes('/api/widget/ai-agent/intro')) return Promise.resolve(jsonResponse({ sent: false }));
    return Promise.resolve(jsonResponse({}));
  });

  if (opts.debug) (window as any).__gs_debug = true;
  (window as any).__GS_WIDGET_TEST_HOOKS__ = true;

  loadAsset('public/widget/presentation-registry.js');
  loadAsset('public/widget/presentation-default.js');
  loadAsset('public/widget/runtime.js');

  const host = document.createElement('gs-widget-test');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const launcher = document.createElement('button');
  shadow.appendChild(launcher);

  const runtime = (window as any).__gs_runtime.init(
    {
      workspaceId: 'ws-test',
      _apiBase: 'https://api.test',
      _assetBase: 'https://cdn.test',
      _sessionToken: 'tok',
      locale: 'en',
      debugMode: !!opts.debug,
      aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
      features: { chat: true },
      prechatEnabled: false,
    },
    { shadowRoot: shadow, shellEl: host, launcher, setUnread() {} },
  );

  return { runtime, chat: chatState };
}

describe('runtime.js — production default is a silent console', () => {
  it('zero console.log/info/warn/debug calls across init, identity resolve, and transport connect', async () => {
    const spy = spyConsole();
    bootRuntime({ debug: false });
    await flush();
    expect(spy.calls).toEqual([]);
    spy.restore();
  });
});

describe('runtime.js — explicit debug (window.__gs_debug) turns logging back on', () => {
  it('at least one runtime log fires once debug is enabled', async () => {
    const spy = spyConsole();
    bootRuntime({ debug: true });
    await flush();
    expect(spy.calls.length).toBeGreaterThan(0);
    expect(spy.calls.some((c) => c.includes('Runtime init'))).toBe(true);
    spy.restore();
  });
});

describe('runtime.js — PII redaction: even WITH debug explicitly enabled, contact details never reach the console', () => {
  it('email and phone are absent from every captured log line; the redacted summary shape is present instead', async () => {
    const spy = spyConsole();
    bootRuntime({
      debug: true,
      contact: { name: 'Jane Visitor', email: 'jane.visitor@example.com', phone: '+15551234567' },
    });
    await flush();

    const joined = spy.calls.join('\n');
    expect(joined).not.toContain('jane.visitor@example.com');
    expect(joined).not.toContain('+15551234567');
    expect(joined).not.toContain('Jane Visitor');

    // The fixed log line: a redacted {loaded, identityState, hasContact}
    // summary, never the raw contact object.
    expect(spy.calls.some((c) => c.includes('identity resolved') && c.includes('hasContact'))).toBe(true);
  });
});
