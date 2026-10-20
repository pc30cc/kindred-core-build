/**
 * A live call widget on a customer's page, kept open for a spec to drive
 * (build contract 00-contract §8.4: e2e/callWidgetBehaviour.spec.ts and
 * e2e/callWidgetPlacement.spec.ts). The visual harness (callScreens.ts)
 * shoots one state and closes its page; this one hands the page over.
 *
 * The page is the demo store (https://nilufar.store), the widget comes from
 * the platform's origin (https://widget.test) through the real l.js, exactly
 * as callScreens.ts serves it (source, shipped or built files). Every request
 * is answered in memory:
 *   - the bootstrap from the fixture (callScreensFixture.ts), patched per test;
 *   - a small call server (FakeCallServer): the start request, the status
 *     polls (from `server.call`, which a test changes between polls), the
 *     join token, cancel, rating and callback requests, every call logged;
 *   - a fake LiveKit client on the page (window.LivekitClient), whose room a
 *     test drives through window.__lk: operators join and leave, the camera
 *     or the microphone is refused, the connection quality changes; remote
 *     and local tracks attach real <video>/<audio> elements fed by canvas and
 *     oscillator streams;
 *   - the chat widget's real loader (public/widget/loader.js) with an
 *     in-memory /config, for the two-widget checks;
 * every other host is aborted and logged (`log.foreign` must stay empty).
 */
import type { Browser, BrowserContext, Locator, Page, Route } from '@playwright/test';
import { AssetServer, CORS, applyStep, attachFakeMedia, runAction, typeOf, type Mode } from './callScreens';
import {
  BRAND_INFO, CALL_ID, DEMO, DESKTOP_VIEWPORT, PHONE_VIEWPORT, SAFE_AREA, SITE_ORIGIN, WIDGET_ORIGIN, WORKSPACE_ID,
  baseBootstrap, frozenNow, mergeJson,
  type Brand, type CallState, type FieldStep, type JsonObject,
} from './callScreensFixture';
import { NAME_SHIM } from './callReference';
import { chatWidgetTemplate } from '../../shared/widgetTemplates';

// ─── The call server ─────────────────────────────────────────────────────
export interface ServerCall {
  state: 'queued' | 'ringing' | 'active' | 'ended' | 'cancelled' | 'missed';
  call_type: 'voice' | 'video';
  /** `call.assigned_agent_id`: the opaque per-call operator reference (D27). */
  agent: string | null;
  /** `operator_name` (the operator's full name, or null). */
  name: string | null;
  started_at: string | null;
  position: number | null;
  eta: number | null;
  recording_state: string | null;
}

export interface ApiCall { method: string; path: string; body: unknown }

/** What a request may be answered with instead of the defaults. */
export type Answer =
  | { status?: number; json?: unknown; body?: string | Buffer; contentType?: string }
  | 'abort';

export interface InterceptRequest { method: string; path: string; search: string; body: unknown }

export class FakeCallServer {
  /** The call the status endpoint describes (null: none). */
  call: ServerCall | null = null;
  /** How POST calls/request answers: queued (the default) or straight to ringing. */
  requestState: 'queued' | 'ringing' = 'queued';
  /** Holds the start request until released (E21: a cancel while it is on its way). */
  private holdRequest: { promise: Promise<void>; release: () => void } | null = null;
  readonly api: ApiCall[] = [];

  /** Every API call whose `METHOD path` matches. */
  calls(method: string, path: RegExp): ApiCall[] {
    return this.api.filter((c) => c.method === method && path.test(c.path));
  }

  /** The next start request waits until the returned function is called. */
  holdNextRequest(): () => void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.holdRequest = { promise, release };
    return () => release();
  }

  async answer(method: string, p: string, body: unknown): Promise<unknown> {
    if (method === 'POST' && p === '/api/call-widget/calls/request') {
      const hold = this.holdRequest;
      this.holdRequest = null;
      if (hold) await hold.promise;
      const b = (body || {}) as { call_type?: string };
      const type = b.call_type === 'video' ? 'video' : 'voice';
      this.call = {
        state: this.requestState, call_type: type, agent: null, name: null, started_at: null,
        position: this.requestState === 'queued' ? 2 : null, eta: this.requestState === 'queued' ? 120 : null, recording_state: null,
      };
      return {
        call_id: CALL_ID, session: 'sess-call', call_type: type, call_state: this.requestState,
        queue_position: this.call.position,
      };
    }
    const status = /^\/api\/call-widget\/calls\/([^/]+)\/status$/.exec(p);
    if (status) {
      const c = this.call;
      if (!c) return { call: null };
      return {
        call: { id: status[1], state: c.state, call_type: c.call_type, assigned_agent_id: c.agent, started_at: c.started_at, recording_state: c.recording_state },
        operator_name: c.name,
        ...(c.position != null ? { position: c.position } : {}),
        ...(c.eta != null ? { eta_seconds: c.eta } : {}),
      };
    }
    if (/\/calls\/[^/]+\/join-token$/.test(p)) {
      return { token: 'tok', provider: 'livekit', connect: { supported: true, provider: 'livekit', server_url: 'wss://media.widget.test' } };
    }
    if (/\/calls\/[^/]+\/cancel$/.test(p)) {
      if (this.call) this.call.state = 'cancelled';
      return { ok: true };
    }
    if (/\/calls\/[^/]+\/rate$/.test(p)) return { ok: true };
    if (p === '/api/call-widget/callbacks/request') {
      const b = (body || {}) as { scheduled_for?: string | null; channel?: string };
      return { callback_id: 'c0ffee00-1111-4222-8333-944455556666', scheduled_for: b.scheduled_for || null, channel: b.channel || 'audio' };
    }
    return {};
  }
}

// ─── The chat widget (its real loader) ───────────────────────────────────
export interface ChatOptions {
  position?: 'bottom-right' | 'bottom-left';
  /** `config.fab`: the launcher's size, shape, icon, label. */
  fab?: Record<string, unknown>;
  /** Wear a launcher style (runtime-fab.css, as /config names it for one). */
  fabStyle?: boolean;
}

const CHAT_WS = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';
const MEDIA_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#7E8C92"/></svg>';

function chatConfig(brand: Brand, o: ChatOptions): JsonObject {
  const intl = brand === 'respok';
  const t = chatWidgetTemplate(intl ? 'intl' : 'default')!;
  const w = (f: string | null | undefined) => (f ? `${WIDGET_ORIGIN}/widget/${f}` : null);
  const locale = BRAND_INFO[brand].locale;
  return {
    enabled: true, workspaceId: CHAT_WS, edition: intl ? 'international' : 'iran', templateId: t.id, templateOptions: {},
    locale, primaryColor: '#8B5CF6', workspaceName: DEMO[brand].displayName, brandName: DEMO[brand].displayName,
    welcomeMessage: 'Hi', teamMembers: [{ name: 'Sara', avatar: null, online: true }],
    availability: { state: 'online', liveChatEnabled: true, next_open_at: null },
    features: { chat: true, knowledgeBase: false },
    attachments: { enabled: false, maxSizeMb: 10, allowedMimes: [], voiceNotesEnabled: false },
    composer: { emojiEnabled: false },
    aiAgent: { visitorFacing: false, providerReady: false, introCapable: false },
    prechatEnabled: false,
    position: o.position || 'bottom-right',
    ...(o.fab ? { fab: o.fab as JsonObject } : {}),
    ...(o.fabStyle ? { fabStyleUrl: w('runtime-fab.css') } : {}),
    runtimeUrl: w('runtime.js'), styleUrl: w('runtime.css'), callRuntimeUrl: w('runtime-call.js'),
    presentationRegistryUrl: w('presentation-registry.js'), presentationUrl: w(t.script), presentationStyleUrl: w(t.style),
    presentationSkinUrl: w(t.skin), presentationFontsUrl: w(t.fonts),
    modules: { chat: w('runtime-chat.js'), kb: w('runtime-kb.js') },
  };
}

function chatTags(): string {
  return `<script>window.__gs_id=${JSON.stringify(CHAT_WS)};window.__gs_api_base=${JSON.stringify(WIDGET_ORIGIN)};</script>`
    + `<script src="${WIDGET_ORIGIN}/widget/loader.js"></script>`;
}
function callTag(): string {
  return `<script async src="${WIDGET_ORIGIN}/call-widget/l.js" workspace-id="${WORKSPACE_ID}"></script>`;
}

// ─── The fake media client (runs in the page) ───────────────────────────
interface LiveKitInit { present: Array<{ id: string; video?: boolean }>; micDenials: number; camDenials: number }

/** window.LivekitClient (the surface runtime.js uses) and its controls, window.__lk. */
function installFakeLiveKit(init: LiveKitInit): void {
  type Handler = (...a: unknown[]) => void;
  interface Track { sid: string; kind: 'audio' | 'video'; mediaStreamTrack?: MediaStreamTrack; attach(): HTMLMediaElement; detach(): void }
  interface Participant { identity: string; isLocal: boolean; trackPublications: Map<string, { track: Track }> }
  const EV = {
    Disconnected: 'disconnected', Reconnecting: 'reconnecting', Reconnected: 'reconnected',
    TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed',
    ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected',
    ConnectionQualityChanged: 'connectionQualityChanged',
  };
  let n = 0;
  const rooms: Room[] = [];
  /** A moving picture: a canvas stream (an operator's or the visitor's camera). */
  function picture(hue: number): MediaStream {
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    const cx = cv.getContext('2d')!;
    let f = 0;
    const draw = () => {
      cx.fillStyle = `hsl(${hue} 45% 40%)`; cx.fillRect(0, 0, 320, 240);
      cx.fillStyle = '#fff'; cx.fillRect((f++ * 7) % 320, 100, 40, 40);
    };
    draw();
    setInterval(draw, 66);
    return cv.captureStream(15);
  }
  /** A quiet tone: an operator's voice for the level meter. */
  function voice(): MediaStream {
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0.02;
    const dst = ac.createMediaStreamDestination();
    osc.connect(gain); gain.connect(dst); osc.start();
    return dst.stream;
  }
  function track(kind: 'audio' | 'video', hue: number): Track {
    const sid = `TR_${kind}_${++n}`;
    const stream = kind === 'video' ? picture(hue) : voice();
    return {
      sid, kind, mediaStreamTrack: stream.getTracks()[0],
      attach() {
        const el = document.createElement(kind);
        el.autoplay = true;
        if (kind === 'video') { (el as HTMLVideoElement).playsInline = true; el.muted = true; }
        el.srcObject = stream;
        void el.play().catch(() => undefined);
        return el;
      },
      detach() {},
    };
  }
  function participant(id: string, video: boolean): Participant {
    const pubs = new Map<string, { track: Track }>();
    const a = track('audio', 0);
    pubs.set(a.sid, { track: a });
    if (video) { const v = track('video', 200); pubs.set(v.sid, { track: v }); }
    return { identity: id, isLocal: false, trackPublications: pubs };
  }
  class Room {
    handlers: Record<string, Handler[]> = {};
    remoteParticipants = new Map<string, Participant>();
    connected = false;
    disconnected = false;
    micCalls: boolean[] = [];
    camCalls: boolean[] = [];
    localParticipant: {
      identity: string; isLocal: boolean; trackPublications: Map<string, unknown>; videoTrackPublications: Map<string, { track: Track }>;
      setMicrophoneEnabled(on: boolean): Promise<unknown>; setCameraEnabled(on: boolean): Promise<unknown>;
    };
    constructor() {
      const videos = new Map<string, { track: Track }>();
      this.localParticipant = {
        identity: 'visitor', isLocal: true, trackPublications: new Map(), videoTrackPublications: videos,
        setMicrophoneEnabled: (on: boolean) => {
          this.micCalls.push(on);
          if (on && lk.micDenials > 0) { lk.micDenials -= 1; return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); }
          return Promise.resolve({ track: null });
        },
        setCameraEnabled: (on: boolean) => {
          this.camCalls.push(on);
          if (on && lk.camDenials > 0) { lk.camDenials -= 1; return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); }
          if (!on) return Promise.resolve(null);
          const t = track('video', 30);
          videos.set(t.sid, { track: t });
          return Promise.resolve({ track: t });
        },
      };
      rooms.push(this);
    }
    on(ev: string, fn: Handler) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev: string, ...args: unknown[]) { for (const fn of this.handlers[ev] || []) fn(...args); }
    connect() {
      for (const p of lk.present) this.remoteParticipants.set(p.id, participant(p.id, !!p.video));
      this.connected = true;
      return Promise.resolve();
    }
    disconnect() {
      if (this.disconnected) return;
      this.disconnected = true;
      this.connected = false;
      void Promise.resolve().then(() => this.emit(EV.Disconnected, 'CLIENT_INITIATED'));
    }
  }
  const lk = {
    micDenials: init.micDenials, camDenials: init.camDenials, present: init.present.slice(),
    rooms,
    room(): Room | null { return rooms.length ? rooms[rooms.length - 1] : null; },
    /** An operator joins the last room (with a camera: `video`). */
    join(id: string, video = false) {
      const r = lk.room()!;
      const p = participant(id, video);
      r.remoteParticipants.set(id, p);
      r.emit(EV.ParticipantConnected, p);
      return p.identity;
    },
    /** An operator leaves the last room. */
    leave(id: string) {
      const r = lk.room()!;
      const p = r.remoteParticipants.get(id);
      r.remoteParticipants.delete(id);
      r.emit(EV.ParticipantDisconnected, p);
    },
    /** The visitor's own connection quality (E12). */
    quality(q: string) { const r = lk.room()!; r.emit(EV.ConnectionQualityChanged, q, r.localParticipant); },
    reconnecting() { lk.room()!.emit(EV.Reconnecting); },
    reconnected() { lk.room()!.emit(EV.Reconnected); },
  };
  const w = window as unknown as Record<string, unknown>;
  w.LivekitClient = { Room, RoomEvent: EV };
  w.__lk = lk;
}

// ─── The session ─────────────────────────────────────────────────────────
export interface SessionOptions {
  brand: Brand;
  mode?: Mode;
  /** --built: the scratch build's dist/ (buildCallWidgetScratch). */
  dist?: string;
  mobile?: boolean;
  viewport?: { width: number; height: number };
  /** Bootstrap patch, deep-merged into the fixture's (baseBootstrap). */
  boot?: JsonObject;
  /** Animations as a visitor sees them (default: reduced motion, as the visual harness). */
  motion?: boolean;
  /**
   * 'install' (default): fake timers from the frozen Thursday 11:00, time flowing, `page.clock.runFor` available;
   * 'fixed': Date frozen (timers real); 'real': the machine's clock.
   */
  clock?: 'install' | 'fixed' | 'real';
  /** The chat widget on the page too. */
  chat?: ChatOptions;
  /** Which widget is on the page first; the other comes once it shows (both load orders). */
  first?: 'call' | 'chat';
  /** A fake LiveKit client (operators already in the room, permission refusals). */
  liveKit?: Partial<LiveKitInit>;
  /** Set before the page's scripts run (a remembered call session, a booking). */
  sessionStorage?: Record<string, string>;
  localStorage?: Record<string, string>;
  /** Answers first (undefined: the defaults). A file of the widget too: `path` is the URL path. */
  intercept?: (req: InterceptRequest) => Answer | undefined | Promise<Answer | undefined>;
  /** A long host page, with a text field (scroll locks and focus outside the widget show). */
  tall?: boolean;
  /** The call the server knows from the start (a resumed call's first poll reads it). */
  call?: ServerCall;
}

export interface SessionLog {
  /** Paths (with query) requested from the platform's origin, in order. */
  requests: string[];
  /** Requests to any other host (aborted). */
  foreign: string[];
  /** pageerror and console.error. */
  errors: string[];
}

/** The page globals the specs read (typed for page.evaluate callbacks). */
export interface CallWin {
  CallCenterWidget: Record<string, unknown> & {
    open: boolean; state: string; render(): void; toggleOpen(): void; t(k: string, v?: Record<string, unknown>): string;
  };
  __lk: {
    room(): { remoteParticipants: Map<string, unknown>; micCalls: boolean[]; camCalls: boolean[] } | null;
    join(id: string, video?: boolean): string; leave(id: string): void; quality(q: string): void;
    reconnecting(): void; reconnected(): void; micDenials: number; camDenials: number;
  };
  __ccwAudio?: { isActive(): boolean; isMuted(): boolean; needsGesture(): boolean };
}

export const ACTIVE_SESSION_KEY = `ccw_active_call_session:${WORKSPACE_ID}:${WIDGET_ORIGIN}`;

export class CallSession {
  readonly server = new FakeCallServer();
  readonly log: SessionLog = { requests: [], foreign: [], errors: [] };
  page!: Page;
  context!: BrowserContext;
  private readonly assets: AssetServer;

  constructor(private readonly browser: Browser, readonly opts: SessionOptions) {
    this.assets = new AssetServer(opts.mode || 'source', opts.brand, opts.dist);
  }

  get brand(): Brand { return this.opts.brand; }

  /** The bootstrap this page is served. */
  bootstrap(): JsonObject {
    const base = baseBootstrap(this.opts.brand);
    return this.opts.boot ? mergeJson(base, this.opts.boot) : base;
  }

  async start(): Promise<this> {
    const o = this.opts;
    if (o.call) this.server.call = { ...o.call };
    const mobile = !!o.mobile;
    const info = BRAND_INFO[o.brand];
    this.context = await this.browser.newContext({
      viewport: o.viewport || (mobile ? PHONE_VIEWPORT : DESKTOP_VIEWPORT),
      deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile,
      locale: info.contextLocale, timezoneId: info.timezoneId,
      reducedMotion: o.motion ? 'no-preference' : 'reduce',
    });
    const page = this.page = await this.context.newPage();
    await page.addInitScript(NAME_SHIM);
    page.on('pageerror', (e) => this.log.errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') this.log.errors.push(`console.error: ${m.text()}`); });
    if (mobile) {
      const cdp = await this.context.newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { left: 0, right: 0, ...SAFE_AREA } } as never);
    }
    const clock = o.clock || 'install';
    if (clock === 'install') await page.clock.install({ time: frozenNow(o.brand) });
    else if (clock === 'fixed') await page.clock.setFixedTime(frozenNow(o.brand));
    if (o.liveKit) {
      await page.addInitScript(installFakeLiveKit, {
        present: o.liveKit.present || [], micDenials: o.liveKit.micDenials || 0, camDenials: o.liveKit.camDenials || 0,
      });
    }
    if (o.sessionStorage || o.localStorage) {
      await page.addInitScript(({ s, l }) => {
        if (location.origin !== 'https://nilufar.store') return;
        for (const [k, v] of Object.entries(s)) sessionStorage.setItem(k, v);
        for (const [k, v] of Object.entries(l)) localStorage.setItem(k, v);
      }, { s: o.sessionStorage || {}, l: o.localStorage || {} });
    }
    await page.route('**/*', (route) => this.serve(route));
    await page.goto(`${SITE_ORIGIN}/`);
    const first = o.chat ? (o.first || 'call') : 'call';
    if (first === 'chat') {
      await this.waitChat();
      await this.addCall();
    } else {
      await this.waitCall();
      if (o.chat) await this.addChat();
    }
    return this;
  }

  private hostPage(): string {
    const info = BRAND_INFO[this.opts.brand];
    const first = this.opts.chat ? (this.opts.first || 'call') : 'call';
    const tall = this.opts.tall
      ? `${Array.from({ length: 5 }, (_, i) => `<section style="height:600px;padding:16px;border-bottom:1px solid #bbb">Section ${i + 1}</section>`).join('')}`
        + '<label style="display:block;padding:16px">Search <input id="site-search" type="search"></label>'
      : '';
    return `<!doctype html><html lang="${info.locale}" dir="${info.dir}"><head><meta charset="utf-8">`
      + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Nilufar Store</title>'
      + '<style>html,body{margin:0;min-height:100%;background:#E7EAEE;font:16px sans-serif}</style></head>'
      + `<body>${tall}${first === 'chat' ? chatTags() : callTag()}</body></html>`;
  }

  /** The call loader, added to the page now (the chat came first). */
  async addCall(): Promise<void> {
    await this.page.evaluate(({ src, ws }) => {
      const s = document.createElement('script');
      s.async = true; s.src = src; s.setAttribute('workspace-id', ws);
      document.body.appendChild(s);
    }, { src: `${WIDGET_ORIGIN}/call-widget/l.js`, ws: WORKSPACE_ID });
    await this.waitCall();
  }

  /** The chat loader, added to the page now (the call came first). */
  async addChat(): Promise<void> {
    await this.page.evaluate(({ ws, api, src }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__gs_id = ws; w.__gs_api_base = api;
      const s = document.createElement('script');
      s.src = src;
      document.body.appendChild(s);
    }, { ws: CHAT_WS, api: WIDGET_ORIGIN, src: `${WIDGET_ORIGIN}/widget/loader.js` });
    await this.waitChat();
  }

  async waitCall(): Promise<void> {
    await this.page.waitForFunction(() => {
      const w = window as unknown as { CallCenterWidget?: { root?: unknown } };
      const host = document.getElementById('call-center-widget-host');
      return !!(w.CallCenterWidget && w.CallCenterWidget.root && host && getComputedStyle(host).display !== 'none');
    }, undefined, { timeout: 15_000 });
  }

  /** The chat launcher shows (revealed, its entrance over, its style sheet in). */
  async waitChat(): Promise<void> {
    await this.page.waitForFunction(() => {
      const l = document.querySelector('gs-widget')?.shadowRoot?.querySelector('.launcher');
      return !!l && l.classList.contains('revealed') && !l.classList.contains('enter') && (l as HTMLElement).style.visibility !== 'hidden';
    }, undefined, { timeout: 15_000 });
    await this.frames(3);
  }

  private async serve(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === SITE_ORIGIN) {
      if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: this.hostPage() });
      return route.fulfill({ status: 404, body: '' });
    }
    if (url.origin !== WIDGET_ORIGIN) {
      this.log.foreign.push(req.url());
      return route.abort();
    }
    if (req.method() === 'OPTIONS') {
      const asked = req.headers()['access-control-request-headers'];
      return route.fulfill({ status: 204, headers: { ...CORS, ...(asked ? { 'access-control-allow-headers': asked } : {}) }, body: '' });
    }
    this.log.requests.push(url.pathname + url.search);
    let body: unknown = null;
    try { body = req.postData() ? JSON.parse(req.postData()!) : null; } catch { body = req.postData(); }
    const p = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    if (this.opts.intercept) {
      const a = await this.opts.intercept({ method: req.method(), path: p, search: url.search, body });
      if (a === 'abort') return route.abort();
      if (a) {
        if (a.json !== undefined) return json(a.json, a.status ?? 200);
        return route.fulfill({ status: a.status ?? 200, headers: { ...CORS, 'content-type': a.contentType || typeOf(p) }, body: a.body ?? '' });
      }
    }
    if (p.startsWith('/api/call-widget/')) {
      this.server.api.push({ method: req.method(), path: p, body });
      if (p === '/api/call-widget/bootstrap') return json(this.bootstrap());
      return json(await this.server.answer(req.method(), p, body));
    }
    if (p === '/api/widget/boot' || p === '/api/widget/bootstrap') {
      return json({
        session_token: 't', workspace_id: CHAT_WS, protocol: 3, availability: { state: 'online' },
        config: chatConfig(this.opts.brand, this.opts.chat || {}),
      });
    }
    if (p.includes('/api/widget/conversations')) return json({ conversations: [] });
    if (p.includes('/api/realtime/connect')) return json({ vendor: 'polling_builtin' });
    if (p.includes('/api/widget/identity/me')) return json({ identified: false, visitor: null });
    if (p.startsWith('/api/')) return json({});
    // The fixture's pictures (a business logo, an operator's photo): any small picture does here.
    if (p.startsWith('/media/')) return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/svg+xml' }, body: MEDIA_SVG });
    const bytes = await this.assets.get(p);
    if (!bytes) return route.fulfill({ status: 404, headers: CORS, body: '' });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': typeOf(p) }, body: bytes });
  }

  // ─── reading and driving the widget ──────────────────────────────────
  /** An element inside the call widget's shadow root (locators pierce it). */
  w(sel: string): Locator {
    return this.page.locator('#call-center-widget-host').locator(sel);
  }

  /** The chat widget's element (its open shadow root). */
  chat(sel: string): Locator {
    return this.page.locator('gs-widget').locator(sel);
  }

  /** The `data-screen` the panel shows, or null. */
  screen(): Promise<string | null> {
    return this.page.evaluate(() => {
      const sr = document.getElementById('call-center-widget-host')?.shadowRoot;
      return sr?.querySelector('.ccw-panel .scr.on')?.getAttribute('data-screen') ?? null;
    });
  }

  async waitScreen(id: string, timeout = 8_000): Promise<void> {
    await this.page.waitForFunction((want) => {
      const sr = document.getElementById('call-center-widget-host')?.shadowRoot;
      const s = sr?.querySelector('.ccw-panel .scr.on');
      return !!s && s.getAttribute('data-screen') === want && !!s.firstElementChild;
    }, id, { timeout });
  }

  isOpen(): Promise<boolean> {
    return this.page.evaluate(() => !!document.getElementById('call-center-widget-host')?.shadowRoot?.querySelector('.ccw-root.ccw-is-open'));
  }

  async waitOpen(open = true, timeout = 8_000): Promise<void> {
    await this.page.waitForFunction((want) => {
      const sr = document.getElementById('call-center-widget-host')?.shadowRoot;
      return !!sr?.querySelector('.ccw-root.ccw-is-open') === want;
    }, open, { timeout });
  }

  /** Opens the panel the way a script does (no pointer), and waits until it shows. */
  async open(): Promise<void> {
    await this.page.evaluate(() => {
      const c = (window as unknown as CallWin).CallCenterWidget;
      if (!c.open) c.toggleOpen();
    });
    await this.waitOpen(true);
  }

  /** Controller fields (formData merges; { $ago }, { $t } resolve in the page), then render(). */
  async set(step: FieldStep): Promise<void> {
    await this.page.evaluate(applyStep, step as Record<string, unknown>);
  }

  /** Reads a controller field. */
  field<T = unknown>(name: string): Promise<T> {
    return this.page.evaluate((k) => (window as unknown as CallWin).CallCenterWidget[k], name) as Promise<T>;
  }

  /** The engine's ring as the renderer sees it (the render context's audio facade). */
  async audio(): Promise<{ active: boolean; muted: boolean; needsGesture: boolean }> {
    return this.page.evaluate(() => {
      const w = window as unknown as CallWin & { CallCenterWidget: { presentation: Record<string, unknown> } };
      const c = w.CallCenterWidget;
      if (!w.__ccwAudio) {
        const impl = c.presentation as { update(i: unknown, ctx: { audio: CallWin['__ccwAudio'] }): void };
        c.presentation = { ...impl, update(i: unknown, ctx: { audio: CallWin['__ccwAudio'] }) { w.__ccwAudio = ctx.audio; impl.update(i, ctx); } };
        c.render();
      }
      const a = w.__ccwAudio!;
      return { active: !!a.isActive(), muted: !!a.isMuted(), needsGesture: !!a.needsGesture() };
    });
  }

  /** A box in CSS px (viewport), or null when the element is missing. */
  rect(sel: string, root: 'call' | 'chat' = 'call'): Promise<{ x: number; y: number; width: number; height: number; right: number; bottom: number } | null> {
    return this.page.evaluate(({ sel: s, root: r }) => {
      const sr = r === 'call' ? document.getElementById('call-center-widget-host')?.shadowRoot : document.querySelector('gs-widget')?.shadowRoot;
      const el = sr?.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height, right: b.right, bottom: b.bottom };
    }, { sel, root });
  }

  /** Lets `n` animation frames pass (the stacking measure is rAF-throttled). */
  async frames(n = 2): Promise<void> {
    for (let i = 0; i < n; i++) await this.page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
    await this.page.waitForTimeout(50);
  }

  /** The panel pair's requests so far (hashed or fixed names). */
  panelRequests(): string[] {
    return this.log.requests.filter((r) => /\/call-widget\/presentation-default-panel(\.[0-9a-f]{12})?\.(js|css)/.test(r));
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** Starts a session (the widget shown, the chat too when asked). */
export async function openCallSession(browser: Browser, opts: SessionOptions): Promise<CallSession> {
  return new CallSession(browser, opts).start();
}

/**
 * A session driven into one of the visual fixture's states exactly as the
 * visual harness drives it (its bootstrap, the status a resumed call polls,
 * controller fields, the panel open, the real clicks), without the shot.
 * Video states need the reference's feed frames: not here (their text is the
 * voice layout's, which this covers).
 */
export async function openFixtureState(browser: Browser, brand: Brand, state: CallState, extra: Partial<SessionOptions> = {}): Promise<CallSession> {
  if (state.live.media === 'video') throw new Error(`${state.id}: video states need the reference feed frames (callScreens.ts)`);
  const status = state.live.status;
  const s = await openCallSession(browser, {
    brand, mobile: !!state.live.mobile, boot: state.live.boot, clock: 'fixed',
    intercept: status ? (r) => (r.path === `/api/call-widget/calls/${CALL_ID}/status` ? { json: status } : undefined) : undefined,
    ...extra,
  });
  if (state.live.media) await attachFakeMedia(s.page, state.live.media, undefined, 'desktop');
  for (const step of state.live.steps || []) await s.set(step);
  await s.page.evaluate((open) => {
    const c = (window as unknown as CallWin).CallCenterWidget;
    if (!!c.open !== open) c.toggleOpen();
  }, state.live.open);
  if (state.live.open) await s.waitOpen(true);
  for (const a of state.live.actions || []) {
    const err = await runAction(s.page, a);
    if (err) throw new Error(`${state.id}: ${err}`);
  }
  await s.page.evaluate(() => document.fonts.ready.then(() => undefined));
  await s.page.waitForTimeout(300);
  return s;
}
