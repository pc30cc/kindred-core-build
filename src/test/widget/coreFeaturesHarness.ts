/**
 * Boots the SHIPPED runtime.js in jsdom with a renderer of the test's
 * choosing, for the tests of Core's renderer-declared features
 * (coreFeatures.test.ts) and of `default` keeping today's behaviour
 * (coreFeaturesDefaultInert.test.ts).
 *
 *  - `renderer: 'default'` mounts presentation-default.js through the real
 *    registry, every surface wrapped so the test sees the view-models Core
 *    passed (behaviour unchanged: each wrapper calls the real function).
 *  - `renderer: <factory>` mounts default's renderer extended by the factory
 *    (features, extra markup, new surfaces), as a t1/t2 renderer would be.
 *  - `renderer: 't1' | 't2'` mounts that template's real renderer through
 *    the real registry, wrapped the same way.
 *
 * Network: an in-memory fake of the widget API (`fetch`), the chat module
 * replaced by a fake, the KB module the real runtime-kb.js (it fetches), the
 * renderer features the real runtime-ext.js (a script the runtime requests
 * only for a renderer that declares features; `ext` decides when it answers),
 * the late pack (the renderer's extras and the real runtime-late.js, which
 * runtime-ext.js requests after the first paint; `late` decides how they
 * answer) and an optional realtime driver whose typing events the test fires.
 */
import { vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const SOURCES: Record<string, string> = {};
function loadAsset(path: string) {
  SOURCES[path] = SOURCES[path] || read(path);
  new Function(SOURCES[path]).call(window);
}

export type Dict = Record<string, unknown>;
export const win = window as unknown as Dict;

/** A renderer surface: view-model(s) in, HTML out. */
export type Surface = (...args: unknown[]) => string;
/** What a renderer returns from create(): surfaces, `features`, `format`, … */
export type Renderer = Dict;
/** default's renderer, as a test factory extends it. */
export type BaseRenderer = Record<string, Surface>;
export type RendererFactory = (base: BaseRenderer, env: Dict) => Renderer;

interface PresentationModule { id?: string; create: (env: Dict) => Renderer; prepare?: () => Promise<void> }

export interface RuntimeInstance {
  open: () => boolean;
  setTab: (key: string, articleSlug?: string) => void;
  __test: {
    startNew: () => void;
    openConversation: (cid: string) => void;
    setConnectionState: (state: string) => void;
    chatState: () => { drafts: Record<string, string>; aiThinking: boolean; freshIntent: boolean } & Dict;
  };
}
interface RuntimeGlobal { init: (config: Dict, shell: Dict) => RuntimeInstance }
interface ChatModuleCall { conversationId: string; onResult: (r: Dict) => void }
interface DriverHooks { onTyping: (e: unknown) => void; onConnectionState?: (state: string) => void }

export interface Call { surface: string; args: unknown[] }

export interface ConversationSeed {
  id: string;
  status?: string;
  unreadCount?: number;
  outbound?: boolean;
  operatorName?: string | null;
  operatorAvatar?: string | null;
  operatorOnline?: boolean;
}

export interface BootOptions {
  renderer?: 'default' | 't1' | 't2' | RendererFactory;
  /** The extras a factory renderer's registry descriptor names (none by default); t1 and t2 name their own. */
  extras?: string;
  /**
   * How the late pack's requests (the extras and runtime-late.js) answer:
   * 'load' (when asked, default), 'hold' (until releaseLate()), 'fail'
   * (onerror for both names, like a 404), 'fail-extras' / 'fail-late' (only
   * that file's, both names) or 'fail-hashed' (only the hashed URLs: the
   * canonical names answer).
   */
  late?: 'load' | 'hold' | 'fail' | 'fail-extras' | 'fail-late' | 'fail-hashed';
  /** What the extras request leaves as window.__gs_mod_extras: default the template's real file (a factory: nothing). */
  extrasModule?: unknown;
  /** What the runtime-late.js request leaves as window.__gs_mod_late: default the real file. */
  lateModule?: unknown;
  config?: Record<string, unknown>;
  conversations?: ConversationSeed[];
  /** Keeps the thread list's answer until releaseConversations() (home paints its skeleton meanwhile). */
  holdConversations?: boolean;
  /** Messages of a thread when its history loads. */
  history?: Record<string, Array<Record<string, unknown>>>;
  assignedOperator?: Record<string, unknown> | null;
  identity?: Record<string, unknown>;
  kb?: { categories?: unknown[]; articles?: unknown[]; article?: Record<string, unknown> };
  /** query -> results; a query not listed answers []. `hold` keeps answers until release(). */
  kbSearch?: Record<string, unknown[]>;
  holdKbSearch?: boolean;
  /** Use a realtime driver (typing events) instead of polling. */
  realtime?: boolean;
  /** A microphone and MediaRecorder (jsdom has neither), and uploads that succeed. */
  media?: boolean;
  open?: boolean;
  /** Seed the per-tab view hint (a reload inside a thread). */
  hint?: { tab: string; conversationId: string | null };
  /**
   * How the runtime-ext.js request answers: 'load' (at once, default: the
   * module is in before any data, so a test sees the features from the
   * start), 'tick' (after a tick, as a network answers: data may come
   * first), 'hold' (until releaseExt()) or 'fail' (onerror, like a 404).
   */
  ext?: 'load' | 'tick' | 'hold' | 'fail';
}

export interface Harness {
  runtime: RuntimeInstance;
  shadow: ShadowRoot;
  panel: HTMLElement;
  body: HTMLElement;
  env: () => Dict;
  calls: Call[];
  lastCall: (surface: string) => unknown[] | undefined;
  fetches: string[];
  posts: Array<{ url: string; body: Dict }>;
  emitTyping: () => void;
  releaseKbSearch: () => void;
  /** Every <script> src the runtime asked for, in order. */
  scripts: string[];
  /** Answers a held runtime-ext.js request (`ext: 'hold'`). */
  releaseExt: () => void;
  /** Answers the held late pack requests (`late: 'hold'`). */
  releaseLate: () => void;
  /** Answers the held thread list requests (`holdConversations`). */
  releaseConversations: () => void;
  q: <T extends Element = HTMLElement>(sel: string) => T | null;
}

export const flush = async (n = 12) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok, status,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
    blob: () => Promise.resolve(new Blob()),
    headers: { get: () => null },
  };
}

function wrapSurfaces(r: Renderer, calls: Call[]): Renderer {
  const out: Renderer = {};
  for (const key of Object.keys(r)) {
    const v = r[key];
    out[key] = typeof v === 'function'
      ? (...args: unknown[]) => { calls.push({ surface: key, args }); return (v as Surface).apply(r, args); }
      : v;
  }
  return out;
}

export function resetWindow() {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  try { sessionStorage.clear(); } catch { /* jsdom */ }
  for (const key of Object.keys(win)) if (key.startsWith('__gs')) delete win[key];
  win.__GS_WIDGET_TEST_HOOKS__ = true;
}

export function boot(opts: BootOptions = {}): Harness {
  const calls: Call[] = [];
  const fetches: string[] = [];
  const posts: Array<{ url: string; body: Dict }> = [];
  let capturedEnv: Dict = {};
  let typingHook: ((e: unknown) => void) | null = null;
  const heldSearches: Array<() => void> = [];

  if (opts.hint) sessionStorage.setItem('gs:view:ws-test', JSON.stringify(opts.hint));

  win.__gs_mod_chat = {
    sendMessage(o: Dict) {
      posts.push({ url: 'chat:sendMessage', body: o });
    },
    loadHistory(o: ChatModuleCall) { o.onResult({ conversationId: null, messages: [] }); },
    loadConversationHistory(o: ChatModuleCall) {
      o.onResult({
        conversationId: o.conversationId,
        messages: (opts.history || {})[o.conversationId] || [],
        assignedOperator: opts.assignedOperator ?? null,
      });
    },
    startPolling() { return { stop() {}, pollNow() {} }; },
  };
  if (opts.realtime) {
    win.__gs_mod_rt_centrifugo = {
      create(_ctx: unknown, _resolved: unknown, hooks: DriverHooks) {
        typingHook = hooks.onTyping;
        return {
          connect() { if (hooks.onConnectionState) hooks.onConnectionState('connected'); },
          disconnect() {},
          subscribeConversation() {},
          unsubscribeConversation() {},
          sendTyping() {},
          getCapabilities() { return { supportsTyping: true }; },
          hasCapability(k: string) { return k === 'supportsTyping'; },
          getDriverName() { return 'centrifugo'; },
        };
      },
    };
  }

  if (opts.media) {
    class FakeRecorder extends EventTarget {
      mimeType = 'audio/webm';
      constructor(_stream: unknown) { super(); }
      start() {}
      stop() {
        const chunk = new Event('dataavailable') as Event & { data?: Blob };
        chunk.data = new Blob(['voice'], { type: 'audio/webm' });
        this.dispatchEvent(chunk);
        this.dispatchEvent(new Event('stop'));
      }
    }
    win.MediaRecorder = FakeRecorder;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) },
    });
    const url = URL as unknown as Dict;
    url.createObjectURL = () => 'blob:voice';
    url.revokeObjectURL = () => {};
  }

  const scripts: string[] = [];
  const heldExt: Array<() => void> = [];
  const heldLate: Array<() => void> = [];
  const heldConversations: Array<() => void> = [];
  const realTemplate = opts.renderer === 't1' || opts.renderer === 't2' ? opts.renderer : null;
  const realAppend = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    const script = node as unknown as HTMLScriptElement;
    if (script && script.tagName === 'SCRIPT') {
      scripts.push(script.src);
      const load = () => { if (typeof script.onload === 'function') script.onload(new Event('load')); };
      if (/runtime-ext\b/.test(script.src)) {
        // The module itself is already on window (loadAsset below), as the
        // script would leave it; only the moment the request answers varies.
        if (opts.ext === 'fail') {
          setTimeout(() => { if (typeof script.onerror === 'function') script.onerror(new Event('error')); }, 0);
          return node;
        }
        if (opts.ext === 'hold') { heldExt.push(load); return node; }
        if (opts.ext !== 'tick') { load(); return node; }
      }
      const extrasReq = /\/presentation-[a-z0-9-]+-x\b/.test(script.src);
      if (extrasReq || /runtime-late\b/.test(script.src)) {
        const fails = opts.late === 'fail' || opts.late === (extrasReq ? 'fail-extras' : 'fail-late') ||
          (opts.late === 'fail-hashed' && !/\?v=/.test(script.src));
        if (fails) {
          setTimeout(() => { if (typeof script.onerror === 'function') script.onerror(new Event('error')); }, 0);
          return node;
        }
        // The file runs when its request answers, as a script would.
        const answer = () => {
          if (extrasReq) {
            if (opts.extrasModule !== undefined) win.__gs_mod_extras = opts.extrasModule;
            else if (realTemplate) new Function(read(`public/widget/presentation-${realTemplate}-x.js`)).call(window);
          } else if (opts.lateModule !== undefined) win.__gs_mod_late = opts.lateModule;
          else new Function(read('public/widget/runtime-late.js')).call(window);
          load();
        };
        if (opts.late === 'hold') heldLate.push(answer);
        else setTimeout(answer, 0);
        return node;
      }
      setTimeout(load, 0);
      return node;
    }
    return realAppend(node);
  });

  win.fetch = vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    fetches.push(u);
    if (init && init.method === 'POST' && init.body) {
      try { posts.push({ url: u, body: JSON.parse(String(init.body)) as Dict }); } catch { posts.push({ url: u, body: { raw: init.body } }); }
    }
    if (u.includes('/api/widget/conversations') && u.includes('/read')) return Promise.resolve(jsonResponse({ ok: true }));
    if (u.includes('/api/widget/conversations')) {
      const answer = () => jsonResponse({
        conversations: (opts.conversations || []).map((c) => ({
          id: c.id,
          status: c.status || 'open',
          preview: 'preview ' + c.id,
          unreadCount: c.unreadCount || 0,
          outbound: !!c.outbound,
          updatedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          operatorName: c.operatorName ?? null,
          operatorAvatar: c.operatorAvatar ?? null,
          operatorOnline: !!c.operatorOnline,
        })),
      });
      if (opts.holdConversations) return new Promise((res) => heldConversations.push(() => res(answer())));
      return Promise.resolve(answer());
    }
    if (u.includes('/api/realtime/connect')) {
      return Promise.resolve(jsonResponse(opts.realtime
        ? { vendor: 'centrifugo', token: 't', ws_url: 'wss://rt.test', capabilities: { supportsTyping: true, supportsRealtime: true } }
        : { vendor: 'polling_builtin' }));
    }
    if (u.includes('/api/widget/identity/me')) {
      return Promise.resolve(jsonResponse(opts.identity || { identity_state: 'anonymous', contact: null }));
    }
    if (u.includes('/api/widget/identity/prechat')) {
      return Promise.resolve(jsonResponse({ ok: true, contact_id: 'contact-1' }));
    }
    if (u.includes('/api/widget/ai-agent/qna-suggestions')) return Promise.resolve(jsonResponse({ questions: [] }));
    if (u.includes('/api/widget/ai-agent/intro')) return Promise.resolve(jsonResponse({ sent: false }));
    if (u.includes('/api/widget/kb/categories')) {
      return Promise.resolve(jsonResponse({ categories: opts.kb?.categories || [], articles: opts.kb?.articles || [] }));
    }
    if (u.includes('/api/widget/kb/article?')) {
      return Promise.resolve(jsonResponse({ article: opts.kb?.article || null }));
    }
    if (u.includes('/api/widget/kb/search')) {
      const q = new URL(u).searchParams.get('q') || '';
      const answer = () => jsonResponse({ results: (opts.kbSearch || {})[q] || [] });
      if (opts.holdKbSearch) return new Promise((res) => heldSearches.push(() => res(answer())));
      return Promise.resolve(answer());
    }
    if (u.includes('/feedback')) return Promise.resolve(jsonResponse({ ok: true, rating: 'neutral' }));
    if (u.includes('/api/widget/attachments/init')) return Promise.resolve(jsonResponse({ attachment_id: 'att-1' }));
    if (/\/api\/widget\/attachments\/[^/]+\/upload/.test(u)) return Promise.resolve(jsonResponse({ ok: true }));
    return Promise.resolve(jsonResponse({}));
  });

  loadAsset('public/widget/presentation-registry.js');
  loadAsset('public/widget/presentation-default.js');
  loadAsset('public/widget/runtime-kb.js');
  loadAsset('public/widget/runtime-ext.js');
  loadAsset('public/widget/runtime-rt-resolver.js');
  loadAsset('public/widget/runtime.js');

  const base = win.__gs_presentation_default as PresentationModule;
  let templateId = 'default';
  if (realTemplate) {
    loadAsset(`public/widget/presentation-${realTemplate}.js`);
    templateId = realTemplate;
    const key = `__gs_presentation_${realTemplate}`;
    const real = win[key] as PresentationModule;
    win[key] = Object.assign({}, real, {
      create(env: Dict) { capturedEnv = env; return wrapSurfaces(real.create(env), calls); },
    });
  } else if (typeof opts.renderer === 'function') {
    const factory = opts.renderer;
    templateId = 'tx';
    win.__gs_presentation_tx = {
      id: 'tx',
      create(env: Dict) {
        capturedEnv = env;
        const r = base.create(env);
        return wrapSurfaces(Object.assign({}, r, factory(r as BaseRenderer, env)), calls);
      },
    };
    const extras = opts.extras;
    win.__gs_presentation_registry = { resolve: () => ({ id: 'tx', globalKey: '__gs_presentation_tx', extras }) };
  } else {
    const realCreate = base.create;
    win.__gs_presentation_default = Object.assign({}, base, {
      create(env: Dict) { capturedEnv = env; return wrapSurfaces(realCreate(env), calls); },
    });
  }

  const host = document.createElement('gs-widget-test');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const launcher = document.createElement('button');
  shadow.appendChild(launcher);

  const runtime = (win.__gs_runtime as RuntimeGlobal).init(
    {
      workspaceId: 'ws-test',
      _apiBase: 'https://api.test',
      _assetBase: 'https://cdn.test',
      _sessionToken: 'tok',
      locale: 'fa',
      templateId,
      workspaceName: 'فروشگاه نیلوفر',
      aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
      features: { chat: true, knowledgeBase: true },
      prechatEnabled: false,
      teamMembers: [
        { name: 'سارا', avatar: null, online: true },
        { name: 'مهدی', avatar: null, online: false },
      ],
      ...(opts.config || {}),
    },
    { shadowRoot: shadow, shellEl: host, launcher, setUnread() {}, setOperatorTyping() {} },
  );
  if (opts.open !== false) runtime.open();

  const panel = shadow.querySelector('.panel') as HTMLElement;
  return {
    runtime,
    shadow,
    panel,
    body: panel.querySelector('[data-body]') as HTMLElement,
    env: () => capturedEnv,
    calls,
    lastCall: (surface: string) => {
      for (let i = calls.length - 1; i >= 0; i--) if (calls[i].surface === surface) return calls[i].args;
      return undefined;
    },
    fetches,
    posts,
    emitTyping: () => { if (typingHook) typingHook({ payload: { actor: 'agent' } }); },
    releaseKbSearch: () => { while (heldSearches.length) heldSearches.shift()!(); },
    scripts,
    releaseExt: () => { while (heldExt.length) heldExt.shift()!(); },
    releaseLate: () => { while (heldLate.length) heldLate.shift()!(); },
    releaseConversations: () => { while (heldConversations.length) heldConversations.shift()!(); },
    q: <T extends Element = HTMLElement>(sel: string) => shadow.querySelector(sel) as T | null,
  };
}

/** Types into a field the way a browser does: value, then an input event. */
export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function click(el: Element | null) {
  if (!el) throw new Error('nothing to click');
  (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

export function key(el: Element, k: string, extra: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
}
