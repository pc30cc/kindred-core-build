/**
 * The runtime's lazy modules (runtime-chat, runtime-kb, the realtime
 * resolver and drivers) load by the content-hashed URL /config names in
 * `config.modules`, which nginx and the CDN keep for a year; a page that
 * outlived a deploy (its hashed name is gone, a no-store 404) retries ONCE by
 * the canonical name; a backend that names none gets exactly the canonical
 * URL, versioned by the build (config.loaderVersion), not by the loader's
 * fixed constant.
 *
 * Boots the SHIPPED runtime in jsdom and records every <script> it asks for.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const CDN = 'https://cdn.test';
const HASHED = {
  chat: `${CDN}/widget/runtime-chat.abcdef12.js`,
  kb: `${CDN}/widget/runtime-kb.abcdef12.js`,
  rt_resolver: `${CDN}/widget/runtime-rt-resolver.abcdef12.js`,
};

interface Script { src: string; fire: (ok: boolean) => void }

function json(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)), headers: { get: () => null } });
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

/**
 * Boots the runtime. `failing` lists script URLs that answer like a 404
 * (onerror); every other script "loads" (onload) after a tick. `connect`
 * lets a test hold POST /api/realtime/connect.
 */
function boot(config: Record<string, unknown>, opts: { failing?: string[]; connect?: Promise<unknown> } = {}) {
  const scripts: Script[] = [];
  vi.spyOn(document.head, 'appendChild').mockImplementation(((node: HTMLScriptElement) => {
    if (node && node.tagName === 'SCRIPT') {
      const s: Script = {
        src: node.src,
        fire: (ok) => { const h = ok ? node.onload : node.onerror; if (typeof h === 'function') (h as () => void).call(node); },
      };
      scripts.push(s);
      setTimeout(() => {
        const ok = !(opts.failing || []).includes(node.src);
        // What the real resolver script does when it runs: register itself.
        if (ok && node.src.includes('runtime-rt-resolver')) {
          (window as unknown as Record<string, unknown>).__gs_mod_rt_resolver = { isDriverVendor: () => false, resolveDriverDescriptor: () => null };
        }
        s.fire(ok);
      }, 0);
      return node;
    }
    return node;
  }) as never);
  (window as unknown as Record<string, unknown>).fetch = vi.fn((url: string) => {
    const u = String(url);
    if (u.includes('/api/realtime/connect')) return (opts.connect || json({ vendor: 'polling_builtin' })).then((b) => (b && typeof (b as { json?: unknown }).json === 'function' ? b : json(b)));
    if (u.includes('/identity/me')) return json({ identified: false, visitor: null });
    return json({});
  });
  for (const f of ['presentation-registry.js', 'presentation-default.js', 'runtime.js']) {
    new Function(read(`public/widget/${f}`)).call(window);
  }
  const host = document.createElement('gs-widget-test');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const launcher = document.createElement('button');
  shadow.appendChild(launcher);
  const runtime = (window as unknown as { __gs_runtime: { init: (c: unknown, s: unknown) => { open: () => void } } }).__gs_runtime.init(
    {
      workspaceId: 'ws', _apiBase: 'https://api.test', _assetBase: CDN, _sessionToken: 't', locale: 'en',
      features: { chat: true, knowledgeBase: true },
      loaderVersion: 'build123', _loaderVersion: 'loader-constant',
      ...config,
    },
    { shadowRoot: shadow, shellEl: host, launcher, setUnread() {} },
  );
  return { runtime, srcs: () => scripts.map((s) => s.src) };
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const key of Object.keys(window)) if (key.startsWith('__gs')) delete (window as unknown as Record<string, unknown>)[key];
  (window as unknown as Record<string, unknown>).__GS_WIDGET_TEST_HOOKS__ = true;
  // The modules' own globals: jsdom never runs the injected scripts.
  const w = window as unknown as Record<string, unknown>;
  w.__gs_mod_chat = { loadHistory() {}, loadConversationHistory() {}, sendMessage() {}, startPolling: () => ({ stop() {} }) };
  w.__gs_mod_kb = { loadCategories(o: { onResult: (r: unknown) => void }) { o.onResult({ ok: true, categories: [], articles: [] }); } };
});
afterEach(() => { vi.restoreAllMocks(); });

describe('lazy modules load by the hashed URLs /config names', () => {
  it('uses config.modules for chat, kb and the realtime resolver, and never their canonical names', async () => {
    const h = boot({ modules: { ...HASHED } });
    await flush();
    h.runtime.open();
    await flush();
    const srcs = h.srcs();
    for (const url of Object.values(HASHED)) expect(srcs).toContain(url);
    expect(srcs.filter((s) => /\/widget\/runtime-(chat|kb|rt-resolver)\.js/.test(s))).toEqual([]);
  });

  it('a backend that names none gets the canonical URL, versioned by the build, not the loader constant', async () => {
    const h = boot({});
    await flush();
    h.runtime.open();
    await flush();
    const srcs = h.srcs();
    expect(srcs).toContain(`${CDN}/widget/runtime-chat.js?v=build123`);
    expect(srcs).toContain(`${CDN}/widget/runtime-kb.js?v=build123`);
    expect(srcs).toContain(`${CDN}/widget/runtime-rt-resolver.js?v=build123`);
    expect(srcs.join(' ')).not.toContain('loader-constant');
  });

  it('a hashed name that is gone (404) is retried exactly once by its canonical name', async () => {
    const h = boot({ modules: { ...HASHED } }, { failing: [HASHED.chat] });
    await flush();
    h.runtime.open();
    await flush();
    const chat = h.srcs().filter((s) => s.includes('runtime-chat'));
    expect(chat).toEqual([HASHED.chat, `${CDN}/widget/runtime-chat.js?v=build123`]);
  });

  it('a module whose hashed AND canonical copies both fail is given up after those two requests', async () => {
    const canonical = `${CDN}/widget/runtime-chat.js?v=build123`;
    const h = boot({ modules: { ...HASHED } }, { failing: [HASHED.chat, canonical] });
    await flush();
    h.runtime.open();
    await flush();
    await flush();
    expect(h.srcs().filter((s) => s.includes('runtime-chat'))).toEqual([HASHED.chat, canonical]);
  });

  it('the realtime resolver is requested alongside POST /api/realtime/connect, not after it', async () => {
    let answer!: (v: unknown) => void;
    const connect = new Promise((r) => { answer = r; });
    const h = boot({ modules: { ...HASHED } }, { connect });
    await flush();
    h.runtime.open();
    await flush();
    expect(h.srcs()).toContain(HASHED.rt_resolver); // connect still unanswered
    answer({ vendor: 'polling_builtin' });
    await flush();
    expect(h.srcs().filter((s) => s.includes('runtime-rt-resolver'))).toHaveLength(1);
  });
});
