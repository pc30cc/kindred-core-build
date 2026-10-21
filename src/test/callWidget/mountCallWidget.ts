/**
 * The call widget in a page (jsdom), the one way the call widget's tests
 * mount it: the registry, the core presentation, the panel module and the
 * runtime, as the source has them or as a brand's build ships them.
 *
 * jsdom never loads a <link> or a <script>, so the helper evaluates the panel
 * module itself (unless a test leaves it out) and fires `load` on the shadow
 * root's stylesheet links when asked (`loadLinks`, done by `open`).
 *
 * The bootstrap builder gives today's shape; `legacy: true` gives the one a
 * server at 6f8af41 sends (no presence, launcher style, slots, logo
 * direction or panel asset URLs), which the widget must keep accepting.
 *
 * The page runs on a device (`device`: a desktop by default, a phone, a phone
 * turned to landscape, a touch tablet): matchMedia, the window's size and a
 * visual viewport answer for it, and `m.device()` turns it into another as a
 * rotation does; `m.viewport.set()` is an on-screen keyboard.
 *
 * A call's media is faked as the engine holds it (`media()`: real `<audio>`
 * and `<video>` elements in `_attachedTracks` and `_localVideoEl`), and the
 * engine's audio facade (the ringback) by one the test drives (`fakeAudio()`).
 *
 * The engine's own tests drive it end to end instead: `fakeApi()` answers its
 * requests (and records them), `liveKit` puts a fake media client on the page
 * (a room whose participants, permissions and connection quality the test
 * controls) together with a fake `AudioContext` whose state the test sets,
 * and `context()` hands back what the presentation was given (the audio
 * facade the ringback lends it).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';

export type Brand = 'iran' | 'respok';
export type Locale = 'fa' | 'en' | 'tr';
type Dict = Record<string, unknown>;

const ROOT = process.cwd();
const DIR = 'public/call-widget';
const cache = new Map<string, string>();
const pages: JSDOM[] = [];

/** Closes every page the helper made (their timers stop); for an afterEach. */
export function closeCallWidgets(): void {
  for (const dom of pages.splice(0)) dom.window.close();
}

/** A call-widget file, raw or as `brand`'s build ships it (minified, kits stripped). */
export function widgetSource(name: string, brand?: Brand): string {
  const file = resolve(ROOT, DIR, name);
  if (!brand) return readFileSync(file, 'utf8');
  const key = `${brand}:${name}`;
  if (!cache.has(key)) {
    // esbuild will not run inside jsdom: the transform runs in its own process.
    cache.set(key, execFileSync(process.execPath, [resolve(ROOT, 'scripts/build/widgetBrand.mjs'), brand, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  }
  return cache.get(key)!;
}

const isObj = (v: unknown): v is Dict => !!v && typeof v === 'object' && !Array.isArray(v);
/** Deep merge of plain objects (arrays and values replace). */
function merge(base: Dict, over: Dict): Dict {
  const out: Dict = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k] as Dict, v) : v;
  return out;
}

/** A bootstrap as the server sends it; `legacy` = as 6f8af41's server sent it. */
export function callBootstrap(over: Dict = {}, opts: { legacy?: boolean; locale?: Locale; edition?: 'iran' | 'international' | null } = {}): Dict {
  const locale = opts.locale ?? 'fa';
  const edition = opts.edition === undefined ? 'iran' : opts.edition;
  const intl = edition === 'international';
  const base: Dict = {
    status: 'ok',
    provider_ready: true,
    session: 'preview',
    assets_version: 'abc123',
    ...(edition ? { edition } : {}),
    calendar: intl ? 'gregorian' : 'jalali',
    time_zone: intl ? null : 'Asia/Tehran',
    assets: {
      presentation_registry_url: '/call-widget/presentation-registry.js',
      presentation_script_url: '/call-widget/presentation-default.js',
      presentation_style_url: intl ? '/call-widget/presentation-intl.css' : '/call-widget/presentation-default.css',
      font_style_url: '/widget/presentation-default-fonts.css',
    },
    config: {
      display_name: 'Nilufar',
      avatar_url: null,
      widget_position: 'right',
      widget_template_id: intl ? 'intl' : 'default',
      widget_theme: {},
      pre_call_form_enabled: false,
      pre_call_form_schema: [],
      offline_behavior: 'show_callback',
      recording_consent_required: false,
      custom_texts: {},
    },
    capabilities: { voice: true, video: true, callback: true, recording: false, operator_video_visible: true },
    callback_policy: { enabled: true, show_when_online: true, cooldown_seconds: 0, require_contact: false, min_message_length: 0, honeypot_enabled: true, min_form_seconds: 0 },
    queue_experience: { ringback_enabled: false, show_position: true, show_eta: true, offer_callback_after_seconds: 0 },
    i18n: { default_locale: locale, available_locales: [locale] },
    recording: { effective_enabled: false, consent_required: false },
    departments: { voice: [], video: [], callback: [] },
    visitor: { id: 'v1', contact: null },
    active_call: null,
    workspace_id: '22222222-2222-4222-8222-222222222222',
  };
  if (!opts.legacy) {
    (base.config as Dict).launcher_style = 'round_label';
    if (intl) (base.config as Dict).logoDirection = 'thread';
    (base.assets as Dict).presentation_panel_script_url = '/call-widget/presentation-default-panel.js';
    (base.assets as Dict).presentation_panel_style_url = '/call-widget/presentation-default-panel.css';
    base.presence = { any_available: true };
  }
  return merge(base, over);
}

export interface MountOptions {
  /** Merged over the default bootstrap (deeply, arrays replace). */
  bootstrap?: Dict;
  legacy?: boolean;
  locale?: Locale;
  edition?: 'iran' | 'international' | null;
  /** Evaluate the files as this brand's build ships them. */
  shipped?: Brand;
  /** Put the panel module on the page before mounting (default true). */
  panel?: boolean;
  /** The loader's panel hook (l.js ensurePanel); none by default (the module is on the page). */
  loadPanel?: (cb: (ok: boolean) => void) => void;
  /** A fixed clock for the page (Date.now and `new Date()`). */
  now?: number;
  /** The page's fetch; none = the runtime runs in preview (every request answers 409). */
  fetch?: (url: string, init?: RequestInit) => Promise<unknown>;
  /** Mount options the test adds (activeSessionKey, …). */
  mountExtra?: Dict;
  /** Runs on the page before any widget file is evaluated (seed storage, …). */
  setup?: (win: Mounted['win']) => void;
  /** Puts a fake media client and a fake AudioContext on the page (`m.lk`). */
  liveKit?: boolean | Partial<FakeLiveKitControls>;
  /** The device the page is shown on (default a desktop); `m.device()` turns it into another. */
  device?: Device;
}

/**
 * Devices as the widgets' media queries see them: a desktop (a mouse, wide),
 * a phone upright and turned to landscape (short and coarse: still a phone,
 * #343), and a touch tablet without hover (not a phone).
 */
export type Device = 'desktop' | 'phone' | 'landscape' | 'tablet';
const DEVICES: Record<Device, { width: number; height: number; coarse: boolean; hover: boolean }> = {
  desktop: { width: 1280, height: 900, coarse: false, hover: true },
  phone: { width: 390, height: 844, coarse: true, hover: false },
  landscape: { width: 844, height: 390, coarse: true, hover: false },
  tablet: { width: 820, height: 1180, coarse: true, hover: false },
};

/** The visual viewport (an on-screen keyboard shrinks it); `set` moves it and fires `resize` (and `scroll` when it moved). */
export interface FakeViewport {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  /** How many listeners of `type` it has (a closed panel leaves none of its own). */
  listeners(type: string): number;
  set(fields: Partial<Pick<FakeViewport, 'width' | 'height' | 'offsetTop'>>): void;
}

/** `(max-width:Npx)`, `(max-height:Npx)`, `(pointer:coarse)`, `(hover:none)` and their lists, as the device answers them. */
function mediaMatches(query: string, d: (typeof DEVICES)[Device]): boolean {
  return query.split(',').some((part) => {
    const conds = part.match(/\([^)]*\)/g) || [];
    return conds.length > 0 && conds.every((c) => {
      const [k, v] = c.slice(1, -1).split(':').map((s) => s.trim());
      if (k === 'max-width') return d.width <= parseFloat(v);
      if (k === 'max-height') return d.height <= parseFloat(v);
      if (k === 'pointer') return (v === 'coarse') === d.coarse;
      if (k === 'hover') return (v === 'none') === !d.hover;
      return false;
    });
  });
}

/** matchMedia, the window's size and a visual viewport for a device; `turn` changes the device as a rotation does. */
function installDevice(win: Mounted['win'], initial: Device) {
  let dev = DEVICES[initial];
  type Mql = { query: string; matches: boolean; fns: Array<(e: unknown) => void>; addEventListener(t: string, f: (e: unknown) => void): void; removeEventListener(t: string, f: (e: unknown) => void): void; addListener(f: (e: unknown) => void): void; removeListener(f: (e: unknown) => void): void };
  const lists: Mql[] = [];
  (win as unknown as { matchMedia: unknown }).matchMedia = (query: string) => {
    const mql: Mql = {
      query, fns: [],
      get matches() { return mediaMatches(query, dev); },
      addEventListener(t, f) { if (t === 'change') mql.fns.push(f); },
      removeEventListener(t, f) { mql.fns = mql.fns.filter((x) => x !== f); },
      addListener(f) { mql.fns.push(f); },
      removeListener(f) { mql.fns = mql.fns.filter((x) => x !== f); },
    };
    lists.push(mql);
    return mql;
  };
  for (const k of ['innerWidth', 'innerHeight'] as const) {
    Object.defineProperty(win, k, { configurable: true, get: () => (k === 'innerWidth' ? dev.width : dev.height) });
  }
  const handlers: Record<string, Array<() => void>> = {};
  const vv: FakeViewport = {
    width: dev.width, height: dev.height, offsetTop: 0, offsetLeft: 0, scale: 1,
    addEventListener(t, f) { (handlers[t] ||= []).push(f); },
    removeEventListener(t, f) { handlers[t] = (handlers[t] || []).filter((x) => x !== f); },
    listeners: (t) => (handlers[t] || []).length,
    set(fields) {
      const moved = fields.offsetTop !== undefined && fields.offsetTop !== vv.offsetTop;
      Object.assign(vv, fields);
      for (const f of [...(handlers.resize || [])]) f();
      if (moved) for (const f of [...(handlers.scroll || [])]) f();
    },
  };
  (win as unknown as { visualViewport: FakeViewport }).visualViewport = vv;
  return {
    vv,
    turn(next: Device) {
      const before = lists.map((l) => l.matches);
      dev = DEVICES[next];
      Object.assign(vv, { width: dev.width, height: dev.height, offsetTop: 0 });
      lists.forEach((l, i) => { if (l.matches !== before[i]) for (const f of [...l.fns]) f({ matches: l.matches, media: l.query }); });
      win.dispatchEvent(new win.Event('resize'));
      win.dispatchEvent(new win.Event('orientationchange'));
      for (const f of [...(handlers.resize || [])]) f();
    },
  };
}

export type Controller = Dict & {
  state: string;
  open: boolean;
  locale: string;
  error: string | null;
  formData: Dict & { custom?: Dict };
  render(): void;
  toggleOpen(): void;
  startCall(kind: string): void;
  openCallback(): void;
  reset(): void;
  setLocale(l: string): void;
  t(key: string, vars?: Dict): string;
  position(): string;
  mount(options: Dict): void;
};

/** The engine's members its own tests read and call (contract §3). */
export interface Engine {
  state: string;
  open: boolean;
  locale: string;
  error: string | null;
  errorKey?: string | null;
  callId: string | null;
  session: string | null;
  callbackId: string | null;
  endedCallId: string | null;
  endedDuration: number;
  connectStatus?: string | null;
  micOn?: boolean;
  camOn?: boolean;
  cameraDenied?: boolean;
  connectionQuality?: string | null;
  audioMeterLive?: boolean;
  labelDismissed?: boolean;
  callbackBooking?: { callbackId: string; scheduled_for: string; channel: string; urgency: string } | null;
  transferring: boolean;
  operatorName: string | null;
  callStartedAt: number | null;
  callTimer: unknown;
  ratingSubmitted: boolean;
  callbackCooldownUntil: number;
  formData: Dict;
  _audioCtx?: unknown;
  t(key: string, vars?: Dict): string;
  render(): void;
  reset(): void;
  toggleOpen(): void;
  startCall(kind: string): void;
  submitCall(): void;
  openCallback(): void;
  submitCallback(): void;
  cancelCall(): unknown;
  pollOnce(): void;
  toggleMic(): void;
  toggleCam(): void;
  disconnectRoom(): void;
  skipRating?: () => void;
  retryMicrophone?: () => unknown;
  dismissLabel?: () => void;
}

/** The audio facade the engine lends the presentation (Ringback), as a test drives it. */
export interface FakeAudio {
  active: boolean;
  muted: boolean;
  /** The browser refused to play without a gesture. */
  gesture: boolean;
  /** What the presentation called, in order (`setMuted:true`, `startFromGesture`). */
  calls: string[];
  /** The queue_experience `startFromGesture` received last. */
  cfg: unknown;
}

/** Media elements as the engine attaches them (`_attachedTracks`, `_localVideoEl`). */
export interface FakeMedia {
  audio: HTMLAudioElement;
  video: HTMLVideoElement | null;
  self: HTMLVideoElement | null;
}

export interface Mounted {
  dom: JSDOM;
  win: Window & typeof globalThis & { eval(code: string): unknown; CallCenterWidget: Controller };
  host: HTMLElement;
  shadow: ShadowRoot;
  root: HTMLElement;
  ctrl: Controller;
  /** Fires `load` on every stylesheet link of the shadow root not loaded yet. */
  loadLinks(): void;
  /** Presses the launcher and lets the panel's stylesheet "load". */
  open(): void;
  q<T extends Element = HTMLElement>(sel: string): T | null;
  qa<T extends Element = HTMLElement>(sel: string): T[];
  /** The shown screen (`.scr.on`). */
  screen(): HTMLElement | null;
  /** Its `data-screen`. */
  screenId(): string | null;
  /** Sets controller fields, then renders. */
  set(fields: Dict): void;
  /** Moves the page's clock. */
  setNow(t: number): void;
  /** The helpers the core lent the panel module (null until it was created). */
  H(): Dict & { dig(x: unknown): string; fmtClock(ms: number): string; fmtDay(d: unknown): string; fmtTime(d: unknown): string; fmtWhen(iso: string): string } | null;
  click(sel: string): void;
  /**
   * Hands the presentation a fake audio facade instead of the engine's
   * Ringback (jsdom plays nothing): the test sets `active`, `muted` and
   * `gesture` and reads what was called. Renders.
   */
  fakeAudio(init?: Partial<Pick<FakeAudio, 'active' | 'muted' | 'gesture'>>): FakeAudio;
  /**
   * Media elements as LiveKit's `track.attach()` gives them to the engine: a
   * remote `<audio>` (sid TR_a), a remote `<video>` (TR_v) and the self-view
   * (`_localVideoEl`, track sid TR_self) when asked. Does not render.
   */
  media(opts?: { video?: boolean; self?: boolean }): FakeMedia;
  /** Renders once and returns the context the presentation received (its `audio` facade, …). */
  context(): Dict & { audio: { isActive(): boolean; isMuted(): boolean; needsGesture(): boolean; setMuted(v: boolean): void; startFromGesture(cfg: unknown): void } };
  /** The fake media client (`liveKit` option), else null. */
  lk: FakeLiveKit | null;
  /** Shows the page on another device (a rotation, a resize): media queries change, then `resize` and `orientationchange`. */
  device(d: Device): void;
  /** The visual viewport (an on-screen keyboard: `viewport.set({ height: 500 })`). */
  viewport: FakeViewport;
  /** The elements `scrollIntoView` was called on, in order (jsdom has no layout). */
  scrolledIntoView: Element[];
}

// ─── The engine's server (fakeApi) ─────────────────────────────────────────

export interface ApiRequest {
  /** The URL's path (`/api/call-widget/...`). */
  path: string;
  method: string;
  body: Dict | null;
  headers: Record<string, string>;
}
/** An answer: JSON with a status (200 by default), a refused connection, or a body that is not JSON. */
export type ApiAnswer = { status?: number; body?: unknown } | 'network' | 'html';
export interface FakeApi {
  fetch: (url: string, init?: RequestInit) => Promise<unknown>;
  requests: ApiRequest[];
  /** `METHOD path` of every request so far. */
  log(): string[];
}

/**
 * A server for the engine's `api()`: `route` answers each request (a value, or
 * a promise the test resolves later); unrouted requests answer `200 {}`.
 */
export function fakeApi(route: (req: ApiRequest) => ApiAnswer | Promise<ApiAnswer> | undefined = () => undefined): FakeApi {
  const requests: ApiRequest[] = [];
  return {
    requests,
    log: () => requests.map((r) => `${r.method} ${r.path}`),
    fetch(url, init = {}) {
      const req: ApiRequest = {
        path: new URL(String(url)).pathname,
        method: String(init.method || 'GET'),
        body: typeof init.body === 'string' ? JSON.parse(init.body) as Dict : null,
        headers: { ...(init.headers as Record<string, string> | undefined) },
      };
      requests.push(req);
      return Promise.resolve(route(req)).then((answer) => {
        const a = answer ?? { status: 200, body: {} };
        if (a === 'network') throw new TypeError('Failed to fetch');
        if (a === 'html') return { ok: false, status: 503, json: () => Promise.reject(new SyntaxError('Unexpected token <')) };
        const status = a.status ?? 200;
        return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(a.body ?? {}) };
      });
    },
  };
}

// ─── A fake media client (LiveKit's surface the engine uses) ───────────────

export interface FakeTrack { sid: string; kind: 'audio' | 'video'; attach(): HTMLMediaElement; detach(el?: unknown): void; stop?(): void; stopped?: number }
export interface FakeParticipant { identity: string; isLocal: boolean; trackPublications: Map<string, { track: FakeTrack }> }
export interface FakeLocalParticipant extends FakeParticipant {
  setMicrophoneEnabled(on: boolean): Promise<unknown>;
  setCameraEnabled(on: boolean): Promise<unknown>;
  videoTrackPublications: Map<string, { track: FakeTrack }>;
  /** Every setMicrophoneEnabled / setCameraEnabled argument, in order. */
  micCalls: boolean[];
  camCalls: boolean[];
  /** With `early`: the devices opened before the room connected, and what was published. */
  createTracks?(o: { audio?: unknown; video?: unknown }): Promise<FakeTrack[]>;
  publishTrack?(t: FakeTrack, o: { source?: string }): Promise<unknown>;
  created: Array<{ audio?: unknown; video?: unknown }>;
  published: Array<{ kind: string; source?: string }>;
}
export interface FakeRoom {
  options: unknown;
  url: string | null;
  connected: boolean;
  disconnected: boolean;
  localParticipant: FakeLocalParticipant;
  remoteParticipants: Map<string, FakeParticipant>;
  on(event: string, fn: (...args: unknown[]) => void): FakeRoom;
  emit(event: string, ...args: unknown[]): void;
  /** A remote participant joins with an audio track (+ video): in the room, then ParticipantConnected. */
  join(identity: string, opts?: { video?: boolean }): FakeParticipant;
  /** A remote participant leaves: out of the room, then ParticipantDisconnected. */
  leave(identity: string): void;
  /** The engine's hang-up; `disconnected` follows a moment later, as LiveKit does. */
  disconnect(): void;
}
export interface FakeAudioContext {
  state: 'suspended' | 'running' | 'closed';
  /** Moves the context to `state` and fires `statechange`. */
  set(state: 'suspended' | 'running' | 'closed'): void;
  resumeCalls: number;
  analysed: unknown[];
}
export interface FakeLiveKitControls {
  /** Refusals left for setMicrophoneEnabled(true) / setCameraEnabled(true) (the browser's permission prompt). */
  micDenials: number;
  camDenials: number;
  /** room.connect() rejects with this message. */
  connectError: string | null;
  /** Operators already in the room when the visitor connects. */
  present: string[];
  /** The state a new AudioContext starts in, and whether resume() outside a gesture works. */
  audioState: 'suspended' | 'running';
  resumeWorks: boolean;
  /** The media client has createTracks/publishTrack (the devices open while the room connects). */
  early?: boolean;
  /** Refusals left for the early createTracks (one prompt for the microphone and the camera). */
  earlyDenials?: number;
  /** Every track the early capture opened. */
  earlyTracks?: FakeTrack[];
}
export interface FakeLiveKit extends FakeLiveKitControls {
  rooms: FakeRoom[];
  /** The last room the engine made. */
  room(): FakeRoom;
  audioContexts: FakeAudioContext[];
}

const ROOM_EVENTS = {
  Disconnected: 'disconnected', Reconnecting: 'reconnecting', Reconnected: 'reconnected',
  TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed',
  ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected',
  ConnectionQualityChanged: 'connectionQualityChanged',
};

/** Puts the fake media client (`window.LivekitClient`) and a fake AudioContext on `win`. */
export function installFakeLiveKit(win: Mounted['win'], init: Partial<FakeLiveKitControls> = {}): FakeLiveKit {
  const doc = win.document;
  let n = 0;
  const lk: FakeLiveKit = {
    micDenials: 0, camDenials: 0, connectError: null, present: [], audioState: 'running', resumeWorks: true, ...init,
    rooms: [],
    room() { if (!lk.rooms.length) throw new Error('no room yet'); return lk.rooms[lk.rooms.length - 1]; },
    audioContexts: [],
  };
  const track = (kind: 'audio' | 'video'): FakeTrack => {
    const sid = `TR_${kind}_${++n}`;
    return {
      sid, kind,
      attach() {
        const el = doc.createElement(kind);
        if (kind === 'audio') Object.assign(el, { srcObject: { id: `stream_${sid}` } });
        return el;
      },
      detach() {},
    };
  };
  const participant = (identity: string, kinds: Array<'audio' | 'video'>): FakeParticipant => {
    const pubs = new Map<string, { track: FakeTrack }>();
    for (const k of kinds) { const t = track(k); pubs.set(t.sid, { track: t }); }
    return { identity, isLocal: false, trackPublications: pubs };
  };
  class Room implements FakeRoom {
    options: unknown;
    url: string | null = null;
    connected = false;
    disconnected = false;
    remoteParticipants = new Map<string, FakeParticipant>();
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    localParticipant: FakeLocalParticipant;
    constructor(options: unknown) {
      this.options = options;
      const videos = new Map<string, { track: FakeTrack }>();
      const local: FakeLocalParticipant = {
        identity: 'visitor', isLocal: true, trackPublications: new Map(), videoTrackPublications: videos, micCalls: [], camCalls: [],
        created: [], published: [],
        setMicrophoneEnabled(on) {
          local.micCalls.push(on);
          if (on && lk.micDenials > 0) { lk.micDenials -= 1; return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); }
          return Promise.resolve({ track: null });
        },
        setCameraEnabled(on) {
          local.camCalls.push(on);
          if (on && lk.camDenials > 0) { lk.camDenials -= 1; return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); }
          if (!on) return Promise.resolve(null);
          const t = track('video');
          videos.set(t.sid, { track: t });
          return Promise.resolve({ track: t });
        },
      };
      if (lk.early) {
        local.createTracks = (o) => {
          local.created.push(o);
          if ((lk.earlyDenials ?? 0) > 0) {
            lk.earlyDenials = (lk.earlyDenials ?? 0) - 1;
            return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
          }
          const out: FakeTrack[] = [];
          for (const kind of ['audio', 'video'] as const) {
            if (!o[kind]) continue;
            const t = track(kind);
            t.stopped = 0;
            t.stop = () => { t.stopped = (t.stopped ?? 0) + 1; };
            (lk.earlyTracks ||= []).push(t);
            out.push(t);
          }
          return Promise.resolve(out);
        };
        local.publishTrack = (t, o) => {
          local.published.push({ kind: t.kind, source: o.source });
          if (t.kind === 'video') videos.set(t.sid, { track: t });
          return Promise.resolve({ track: t });
        };
      }
      this.localParticipant = local;
      lk.rooms.push(this);
    }
    on(event: string, fn: (...a: unknown[]) => void) { (this.handlers[event] ||= []).push(fn); return this; }
    emit(event: string, ...args: unknown[]) { for (const fn of this.handlers[event] || []) fn(...args); }
    connect(url: string) {
      this.url = url;
      if (lk.connectError) return Promise.reject(new Error(lk.connectError));
      for (const id of lk.present) this.remoteParticipants.set(id, participant(id, ['audio']));
      this.connected = true;
      return Promise.resolve();
    }
    join(identity: string, opts: { video?: boolean } = {}) {
      const p = participant(identity, opts.video ? ['audio', 'video'] : ['audio']);
      this.remoteParticipants.set(identity, p);
      this.emit(ROOM_EVENTS.ParticipantConnected, p);
      return p;
    }
    leave(identity: string) {
      const p = this.remoteParticipants.get(identity);
      this.remoteParticipants.delete(identity);
      this.emit(ROOM_EVENTS.ParticipantDisconnected, p);
    }
    disconnect() {
      if (this.disconnected) return;
      this.disconnected = true;
      this.connected = false;
      void Promise.resolve().then(() => this.emit(ROOM_EVENTS.Disconnected, 'CLIENT_INITIATED'));
    }
  }
  const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
  const node = () => ({ type: '', frequency: param, gain: param, fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 32, connect: (to: unknown) => to, disconnect() {}, start() {}, stop() {}, addEventListener() {}, getByteFrequencyData() {} });
  class AudioContext {
    state: 'suspended' | 'running' | 'closed' = lk.audioState;
    currentTime = 0;
    destination = node();
    resumeCalls = 0;
    analysed: unknown[] = [];
    onstatechange: (() => void) | null = null;
    listeners: Array<() => void> = [];
    constructor() { lk.audioContexts.push(this); }
    set(state: 'suspended' | 'running' | 'closed') {
      this.state = state;
      this.onstatechange?.();
      for (const fn of this.listeners) fn();
    }
    resume() {
      this.resumeCalls += 1;
      if (!lk.resumeWorks) return new Promise(() => {});
      this.set('running');
      return Promise.resolve();
    }
    addEventListener(type: string, fn: () => void) { if (type === 'statechange') this.listeners.push(fn); }
    removeEventListener(type: string, fn: () => void) { this.listeners = this.listeners.filter((f) => f !== fn); }
    createOscillator() { return node(); }
    createGain() { return node(); }
    createAnalyser() { return node(); }
    createMediaStreamSource(stream: unknown) { this.analysed.push(stream); return node(); }
  }
  Object.assign(win, { LivekitClient: { Room, RoomEvent: ROOM_EVENTS, Track: { Source: { Microphone: 'microphone', Camera: 'camera' } } }, AudioContext });
  return lk;
}

export function mountCallWidget(opts: MountOptions = {}): Mounted {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://customer.example/page',
    runScripts: 'outside-only',
  });
  pages.push(dom);
  const win = dom.window as unknown as Mounted['win'];
  let now = opts.now ?? 0;
  if (opts.now != null) {
    const RealDate = win.Date;
    class FakeDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(now);
        else super(...(args as [string]));
      }
      static now() { return now; }
    }
    (win as unknown as { Date: unknown }).Date = FakeDate;
  }
  if (opts.fetch) (win as unknown as { fetch: unknown }).fetch = opts.fetch;
  const device = installDevice(win, opts.device ?? 'desktop');
  const scrolledIntoView: Element[] = [];
  (win.Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function scrollIntoView(this: Element) { scrolledIntoView.push(this); };
  const lk = opts.liveKit ? installFakeLiveKit(win, opts.liveKit === true ? {} : opts.liveKit) : null;
  opts.setup?.(win);
  const brand = opts.shipped;
  win.eval(widgetSource('presentation-registry.js', brand));
  win.eval(widgetSource('presentation-default.js', brand));
  let helpers: Dict | null = null;
  if (opts.panel !== false) {
    win.eval(widgetSource('presentation-default-panel.js', brand));
    // What the core lends the module (contract §2.2), for the tests to read.
    const mod = (win as unknown as { __ccw_panel: { create(h: Dict): unknown } }).__ccw_panel;
    const create = mod.create;
    mod.create = (h: Dict) => { helpers = h; return create(h); };
  }
  win.eval(widgetSource('runtime.js', brand));
  const edition = opts.edition === undefined ? (opts.shipped === 'respok' ? 'international' : 'iran') : opts.edition;
  win.CallCenterWidget.mount({
    apiBase: 'https://api.example',
    origin: 'https://app.example',
    preview: !opts.fetch,
    bootstrap: callBootstrap(opts.bootstrap ?? {}, { legacy: opts.legacy, locale: opts.locale, edition }),
    ...(opts.loadPanel ? { loadPanel: opts.loadPanel } : {}),
    ...(opts.mountExtra ?? {}),
  });
  const host = win.document.querySelector('#call-center-widget-host') as HTMLElement;
  const shadow = host.shadowRoot!;
  const root = shadow.querySelector('.ccw-root') as HTMLElement;
  const ctrl = win.CallCenterWidget;
  const loaded = new WeakSet<Element>();
  const m: Mounted = {
    dom, win, host, shadow, root, ctrl, lk, scrolledIntoView,
    viewport: device.vv,
    device: (d) => device.turn(d),
    loadLinks() {
      for (const link of [...shadow.querySelectorAll('link')] as Array<HTMLLinkElement & { onload: (() => void) | null }>) {
        if (loaded.has(link)) continue;
        loaded.add(link);
        link.onload?.();
      }
    },
    open() {
      (shadow.querySelector('.ccw-launcher-btn') as HTMLButtonElement).click();
      m.loadLinks();
    },
    q: (sel) => shadow.querySelector(sel),
    qa: (sel) => [...shadow.querySelectorAll(sel)] as never,
    screen: () => shadow.querySelector('.scr.on'),
    screenId: () => shadow.querySelector('.scr.on')?.getAttribute('data-screen') ?? null,
    set(fields) {
      Object.assign(ctrl, fields);
      ctrl.render();
    },
    setNow(t) { now = t; },
    H: () => helpers as never,
    click(sel) {
      const el = shadow.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`nothing matches ${sel}`);
      el.click();
    },
    fakeAudio(init = {}) {
      const state: FakeAudio = { active: false, muted: false, gesture: false, calls: [], cfg: null, ...init };
      const facade = Object.freeze({
        isActive: () => state.active,
        isMuted: () => state.muted,
        needsGesture: () => state.gesture,
        setMuted: (v: boolean) => { state.calls.push(`setMuted:${v}`); state.muted = !!v; },
        startFromGesture: (cfg: unknown) => { state.calls.push('startFromGesture'); state.cfg = cfg; state.gesture = false; state.active = true; },
      });
      // The engine builds its facade in each render(); the presentation reads it from the context.
      type Impl = { update(i: unknown, ctx: Dict): void };
      const c = ctrl as unknown as { presentation: Impl };
      const impl = c.presentation;
      c.presentation = { ...impl, update: (i: unknown, ctx: Dict) => impl.update(i, { ...ctx, audio: facade }) } as Impl;
      ctrl.render();
      return state;
    },
    media(opts = {}) {
      const doc = win.document;
      const audio = doc.createElement('audio');
      audio.autoplay = true;
      const tracks: Record<string, HTMLMediaElement> = { TR_a: audio };
      let video: HTMLVideoElement | null = null;
      let self: HTMLVideoElement | null = null;
      if (opts.video) {
        video = doc.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        tracks.TR_v = video;
      }
      if (opts.self) {
        self = doc.createElement('video');
        self.autoplay = true;
        self.playsInline = true;
        self.muted = true;
      }
      Object.assign(ctrl, { _attachedTracks: tracks, _localVideoEl: self, _localVideoTrack: self ? { sid: 'TR_self' } : null });
      return { audio, video, self };
    },
    context() {
      type Impl = { update(i: unknown, ctx: Dict): void };
      const c = ctrl as unknown as { presentation: Impl };
      const impl = c.presentation;
      let seen: Dict | null = null;
      c.presentation = { ...impl, update: (i: unknown, ctx: Dict) => { seen = ctx; impl.update(i, ctx); } } as Impl;
      try { ctrl.render(); } finally { c.presentation = impl; }
      if (!seen) throw new Error('the engine did not render');
      return seen as never;
    },
  };
  return m;
}

/** Lets every pending promise chain run (fetch answers, a room's connect); needs no timer, so it works under fake timers. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

/** What the fake server says about a call; a test changes it between polls. */
export interface CallServerState {
  state: string;
  type?: 'audio' | 'video';
  /** The call's agent reference (`call.assigned_agent_id`). */
  agent?: string | null;
  name?: string | null;
  startedAt?: string | null;
  position?: number | null;
}

/**
 * Routes for one call: its status (from `s`, read at each poll), a join token
 * for a LiveKit room, cancel and rate answered `{ok:true}`. `more` answers
 * first (undefined: these routes).
 */
export function callRoutes(s: CallServerState, more?: (req: ApiRequest) => ApiAnswer | Promise<ApiAnswer> | undefined) {
  return (req: ApiRequest): ApiAnswer | Promise<ApiAnswer> | undefined => {
    const own = more?.(req);
    if (own !== undefined) return own;
    if (/\/calls\/[^/]+\/status$/.test(req.path)) {
      return {
        body: {
          call: { state: s.state, call_type: s.type ?? 'audio', assigned_agent_id: s.agent ?? null, started_at: s.startedAt ?? null },
          operator_name: s.name ?? null,
          ...(s.position != null ? { position: s.position } : {}),
        },
      };
    }
    if (/\/calls\/[^/]+\/join-token$/.test(req.path)) {
      return { body: { token: 'tok', provider: 'livekit', connect: { supported: true, server_url: 'wss://media.example', provider: 'livekit' } } };
    }
    if (/\/calls\/[^/]+\/(cancel|rate)$/.test(req.path)) return { body: { ok: true } };
    return undefined;
  };
}

/** Lets promise callbacks (the panel's readiness, a failure) run. */
export async function flush(win?: Window): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => (win ? win.setTimeout(r, 0) : setTimeout(r, 0)));
}
