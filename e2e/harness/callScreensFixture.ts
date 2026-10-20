/**
 * The call widget's visual QA fixture: one entry per acceptance panel of the
 * owner's handoff (81 per brand, `docs/call-widget-handoff/<brand>/
 * template-1-call-center/screens/panels/`), with what the reference re-render
 * crops (e2e/harness/callReference.ts) and how the live widget is driven into
 * the same state (e2e/harness/callScreens.ts). Data only: no browser here, so
 * src/test/callWidget/callScreensFixture.test.ts can check every demo string
 * against the reference HTML.
 *
 * Kinds (build contract 00-contract §8.2, digest-infra §7.4):
 *   P  full panel crop: the panel ± 24px, 896×1416 at 2x;
 *   M  phone crop: the 390×844 screen, with masks for the board's notch, home
 *      bar and frame corners;
 *   C  component crop: a launcher or minimised bar, aligned on one element;
 *   G  geometry assertions (placements; the boards draw scaled page mocks);
 *   R  review only (Tier B): the film, the 384-wide prototype, the system
 *      sheets, the scaled bottom-bar mock.
 *
 * Demo data is the boards' (digest-webyar §19, digest-respok §4) and the
 * contract's fixture facts (§8.1).
 */

export type Brand = 'webyar' | 'respok';
export type Kind = 'P' | 'M' | 'C' | 'G' | 'R';

export const BRANDS: readonly Brand[] = ['webyar', 'respok'];

export interface BrandInfo {
  /** Call template id (shared/widgetTemplates.ts). */
  template: 'default' | 'intl';
  edition: 'iran' | 'international';
  /** scripts/build/brand.mjs build brand the template ships in. */
  build: 'iran' | 'respok';
  locale: 'fa' | 'en';
  dir: 'rtl' | 'ltr';
  /** Browser context locale and zone (the visitor's). */
  contextLocale: string;
  timezoneId: string;
  /** Skin stylesheet the bootstrap names. */
  skin: string;
}

export const BRAND_INFO: Record<Brand, BrandInfo> = {
  webyar: {
    template: 'default', edition: 'iran', build: 'iran', locale: 'fa', dir: 'rtl',
    contextLocale: 'fa-IR', timezoneId: 'Asia/Tehran', skin: 'presentation-default.css',
  },
  respok: {
    template: 'intl', edition: 'international', build: 'respok', locale: 'en', dir: 'ltr',
    contextLocale: 'en-US', timezoneId: 'Europe/London', skin: 'presentation-intl.css',
  },
};

/** The customer's site (the boards' demo store; screen 12 prints its host) and the platform serving the widget. */
export const SITE_ORIGIN = 'https://nilufar.store';
export const WIDGET_ORIGIN = 'https://widget.test';
export const SITE_HOST = 'nilufar.store';
export const WORKSPACE_ID = 'ws-call-harness';
export const CALL_ID = 'call-harness-1';
/** First 8 characters, upper-cased, are the board's reference code (screen 19). */
export const CALLBACK_ID = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
export const CALLBACK_CODE = 'A1B2C3D4';

// ─── Clock ───────────────────────────────────────────────────────────────
/** Thursday 2026-10-22 11:00 in the context's zone: the day chips read today/tomorrow/Sat/Sun, 10:00 is past, 12:30 open. */
export const CLOCK_WALL = { year: 2026, month: 10, day: 22, hour: 11, minute: 0 } as const;
/** Elapsed times the boards print (ms): 0:47, 1:35, 2:14, 3:05, 2:48. */
export const QUEUE_THIRD_MS = 47_000;
export const QUEUE_NEXT_MS = 95_000;
export const CALL_MS = 134_000;
export const TRANSFER_MS = 185_000;
export const RECONNECT_MS = 168_000;
/** Seconds: «مدت مکالمه ۴:۱۴». */
export const ENDED_DURATION_S = 254;
/** Phone safe-area insets (CSS px) that reproduce board 11 with the README's formulas. */
export const SAFE_AREA = { top: 42, bottom: 22 } as const;
export const DESKTOP_VIEWPORT = { width: 1280, height: 900 } as const;
export const PHONE_VIEWPORT = { width: 390, height: 844 } as const;
/** Tier B of board 04 (and the film): the prototype's page is drawn 648×948. */
export const PROTOTYPE_VIEWPORT = { width: 648, height: 948 } as const;
/** Desktop shots: the harness moves the widget 48px from the corner so a 24px crop margin stays inside the viewport. */
export const SHOT_OFFSET = 48;
export const PANEL_PAD = 24;
export const COMPONENT_PAD = 20;

/** Epoch ms of a wall-clock time in an IANA zone. */
export function zonedInstant(zone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const next = wall - zoneOffsetMs(zone, guess);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** One formatter per zone: building an Intl.DateTimeFormat is the costly part, and every bootstrap needs ~100 offsets. */
const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The zone's offset from UTC at an instant, in ms. */
export function zoneOffsetMs(zone: string, at: number): number {
  let fmt = zoneFormats.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormats.set(zone, fmt);
  }
  const parts = fmt.formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - at;
}

/** ISO 8601 with the zone's offset, as the server writes slot instants (`2026-10-23T16:30:00+03:30`). */
export function isoInZone(at: number, zone: string): string {
  const off = Math.round(zoneOffsetMs(zone, at) / 60_000);
  const local = new Date(at + off * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The frozen "now" of a brand's runs (11:00 on the Thursday, in its zone). */
export function frozenNow(brand: Brand): number {
  const { year, month, day, hour, minute } = CLOCK_WALL;
  return zonedInstant(BRAND_INFO[brand].timezoneId, year, month, day, hour, minute);
}

/** Callback slot starts the boards draw, each day (local wall time). */
export const SLOT_TIMES: ReadonlyArray<[number, number]> = [[10, 0], [12, 30], [16, 30], [18, 0], [19, 30]];
/** The four days the boards' chips show: today (Thu 22), tomorrow, Sat, Sun. */
export const SLOT_DAYS = [22, 23, 24, 25] as const;

export interface Slot { at: string; available: boolean }

/**
 * `callback_policy.slots` as the server computes them (S2): every start of
 * the four days, `available:false` before now + 5 min. Board 17's struck
 * slot is tomorrow's 10:00, which is data (a full slot), not the clock.
 */
export function callbackSlots(brand: Brand): Slot[] {
  const zone = BRAND_INFO[brand].timezoneId;
  const now = frozenNow(brand);
  const slots: Slot[] = [];
  for (const day of SLOT_DAYS) {
    for (const [h, m] of SLOT_TIMES) {
      const at = zonedInstant(zone, CLOCK_WALL.year, CLOCK_WALL.month, day, h, m);
      const full = day === SLOT_DAYS[1] && h === 10 && m === 0;
      slots.push({ at: isoInZone(at, zone), available: !full && at >= now + 5 * 60_000 });
    }
  }
  return slots;
}

/** Tomorrow 16:30, the boards' booked / chosen callback time (17, 18, 19, Sh). */
export function bookedSlot(brand: Brand): string {
  const zone = BRAND_INFO[brand].timezoneId;
  return isoInZone(zonedInstant(zone, CLOCK_WALL.year, CLOCK_WALL.month, SLOT_DAYS[1], 16, 30), zone);
}

// ─── Demo data (the boards' sample store) ────────────────────────────────
export interface Demo {
  displayName: string;
  operatorName: string;
  operatorFirst: string;
  visitorName: string;
  email: string;
  /** Screen 18 draws the e-mail being typed. */
  emailTyping: string;
  phone: string;
  subjectError: string;
  subjectReturning: string;
  departments: [string, string, string];
  serverError: string;
  /** Board 01 L4's three operators (the card draws their initials). */
  team: [string, string, string];
  /** Board 03 Sc's sample logo letter (the face is masked: live data). */
  logoLetter: string;
}

export const DEMO: Record<Brand, Demo> = {
  webyar: {
    displayName: 'پشتیبانی فروشگاه نیلوفر',
    operatorName: 'سارا محمدی',
    operatorFirst: 'سارا',
    visitorName: 'علی رضایی',
    email: 'ali@example.com',
    emailTyping: 'ali@exa',
    phone: '۰۹۱۲۳۴۵۶۷۸۹',
    subjectError: 'سفارش ۴۸۲۱۳',
    subjectReturning: 'مرجوعی کفش، سایز ۴۲',
    departments: ['فروش', 'پشتیبانی فنی', 'مالی'],
    serverError: 'در حال حاضر اپراتوری در دسترس نیست',
    team: ['سارا محمدی', 'مهدی کریمی', 'رضا احمدی'],
    logoLetter: 'ف',
  },
  respok: {
    displayName: 'Nilufar Store Support',
    operatorName: 'Sara Mohammadi',
    operatorFirst: 'Sara',
    visitorName: 'Ali Rezaei',
    email: 'ali@example.com',
    emailTyping: 'ali@exa',
    phone: '+1 555 123 4567',
    subjectError: 'Order #48213',
    subjectReturning: 'Returning shoes, size 42',
    departments: ['Sales', 'Tech support', 'Billing'],
    serverError: 'No operator is available right now',
    team: ['Sara Mohammadi', 'Mehdi Karimi', 'Reza Ahmadi'],
    logoLetter: 'N',
  },
};

export const DEPARTMENT_IDS = ['dep-sales', 'dep-tech', 'dep-billing'] as const;

/** Images the fixture serves from the platform origin (the harness draws them). */
export const MEDIA = {
  /** Sc: the business logo (`config.avatar_url`); its face is masked (§8.3 #7). */
  businessLogo: `${WIDGET_ORIGIN}/media/business-logo.svg`,
  /** L8: the operator's photo (presence); masked inside `.pic` (§8.3 #7). */
  operatorPhoto: `${WIDGET_ORIGIN}/media/operator-photo.svg`,
  /** WebYar panels: the header tile the board draws («ف», the store's logo, not the name's initial «پ»), exported from the reference. */
  headerLogo: `${WIDGET_ORIGIN}/media/header-logo.png`,
} as const;

// ─── Accents and radii (the --matrix runs) ───────────────────────────────
export const DEFAULT_ACCENT: Record<Brand, string> = { webyar: '#0B7D6C', respok: '#16142B' };
export const ACCENT_PRESETS: Record<Brand, string[]> = {
  webyar: ['#0B7D6C', '#2563EB', '#7C3AED', '#DB2777', '#D9480F', '#111827'],
  respok: ['#16142B', '#2F5BFF', '#0F766E', '#C2410C'],
};
/** A light custom accent: `--on-a` must be Ink. */
export const LIGHT_ACCENT = '#F5D90A';
export const RADII = ['sm', 'md', 'lg'] as const;
export type Radius = (typeof RADII)[number];
export const INK = '#16142B';

function relativeLuminance(hex: string): number {
  const v = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** `--on-a` (contract §2.7 step 3): white when its contrast on the accent is at least Ink's, else Ink. */
export function onAccent(accent: string): string {
  const la = relativeLuminance(accent);
  const contrast = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return contrast(1, la) >= contrast(relativeLuminance(INK), la) ? '#FFFFFF' : INK;
}

/**
 * Respok's stage in a workspace colour (owner, 2026-10-19; board 12-02): for
 * a Respok accent other than Ink, the share of the colour the stage keeps
 * (`--a-k`, as presentation-default.js writes it next to the root's `tint`)
 * so that its luminance is at most .15; null when the stage stays Ink (WebYar,
 * no colour, Ink itself).
 */
export const STAGE_TINT_LUMINANCE = 0.15;
export function stageTintK(brand: Brand, accent: string | null | undefined): string | null {
  if (brand !== 'respok' || !accent || accent.toUpperCase() === INK) return null;
  return `${(100 * Math.min(1, Math.cbrt(STAGE_TINT_LUMINANCE / relativeLuminance(accent)))).toFixed(1)}%`;
}

/**
 * WebYar's stage in a colour lighter than its lightest preset (owner,
 * 2026-10-19, round 7b): for a WebYar accent whose luminance is above .195
 * (`#D9480F` is .1942), the share of the colour the stage keeps (`--a-k`, as
 * presentation-default.js writes it next to the root's `hold`) so that it is
 * held at that luminance; null for Respok, no colour, the default and every
 * preset.
 */
export const STAGE_HOLD_LUMINANCE = 0.195;
export function stageHoldK(brand: Brand, accent: string | null | undefined): string | null {
  if (brand !== 'webyar' || !accent) return null;
  const l = relativeLuminance(accent);
  return l > STAGE_HOLD_LUMINANCE ? `${(100 * Math.cbrt(STAGE_HOLD_LUMINANCE / l)).toFixed(1)}%` : null;
}

// ─── Bootstrap ───────────────────────────────────────────────────────────
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** The bootstrap the fixture serves for a brand: today's fields plus the contract's new ones (§5, S6/S7). */
export function baseBootstrap(brand: Brand): JsonObject {
  const info = BRAND_INFO[brand];
  const demo = DEMO[brand];
  const intl = brand === 'respok';
  const dep = (i: number) => ({ id: DEPARTMENT_IDS[i], name: demo.departments[i], sort_order: i });
  return {
    status: 'ok',
    session: 'sess-harness',
    assets_version: 'harness',
    edition: info.edition,
    calendar: intl ? 'gregorian' : 'jalali',
    time_zone: intl ? null : 'Asia/Tehran',
    ...(intl
      ? {
        platform_brand: { names: { en: 'RESPOK', fa: 'RESPOK', tr: 'RESPOK' } },
        powered_by: { brand: 'RESPOK', brands: { en: 'RESPOK' }, url: 'https://respok.app', logo: `${WIDGET_ORIGIN}/brand/intl/respok-thread-horizontal-color.svg` },
      }
      : { powered_by_logo: '/brand/webyar/webyar-logo-fa-color.svg' }),
    assets: {
      font_style_url: '/widget/presentation-default-fonts.css',
      presentation_registry_url: '/call-widget/presentation-registry.js',
      presentation_script_url: '/call-widget/presentation-default.js',
      presentation_style_url: `/call-widget/${info.skin}`,
      presentation_panel_script_url: '/call-widget/presentation-default-panel.js',
      presentation_panel_style_url: '/call-widget/presentation-default-panel.css',
    },
    workspace_id: WORKSPACE_ID,
    visitor: null,
    config: {
      display_name: demo.displayName,
      avatar_url: null,
      widget_position: 'right',
      widget_template_id: info.template,
      widget_theme: {},
      pre_call_form_enabled: true,
      pre_call_form_schema: [],
      offline_behavior: 'show_callback',
      recording_consent_required: true,
      custom_texts: {},
      launcher_style: 'round_label',
      ...(intl ? { logoDirection: 'thread' } : {}),
    },
    capabilities: { voice: true, video: true, callback: true, recording: true, operator_video_visible: true },
    callback_policy: {
      enabled: true, show_when_online: true, cooldown_seconds: 60, require_contact: true,
      min_message_length: 0, honeypot_enabled: true, min_form_seconds: 0,
      slots: callbackSlots(brand) as unknown as Json,
    },
    queue_experience: {
      ringback_enabled: true, ringback_mode: 'tone', ringback_music_url: null,
      ringback_announcement_audio_url: null, ringback_queue_audio_urls: {},
      show_position: true, show_eta: true, eta_seconds_per_position: 60, offer_callback_after_seconds: 0,
    },
    i18n: { default_locale: info.locale, available_locales: [info.locale] },
    recording: { effective_enabled: true, consent_required: true },
    provider_ready: true,
    departments: { voice: [dep(0), dep(1), dep(2)], video: [], callback: [dep(0), dep(1), dep(2)] },
    presence: { any_available: true },
    active_call: null,
  };
}

/** Deep merge for bootstrap patches (objects merge, everything else replaces). */
export function mergeJson(base: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)
      ? mergeJson(cur as JsonObject, v as JsonObject)
      : v;
  }
  return out;
}

// ─── States ──────────────────────────────────────────────────────────────
/**
 * A controller field value. Special forms the harness resolves in the page:
 *   { $ago: ms }   → the frozen now − ms (epoch ms);
 *   { $t: key }    → controller.t(key) (the engine's own string).
 * `formData` merges into controller.formData; everything else is assigned.
 */
export type FieldValue = Json | { $ago: number } | { $t: string };
export type FieldStep = Record<string, FieldValue>;

export interface Action {
  do: 'click' | 'hover' | 'focus' | 'call';
  /** Selector inside the widget's shadow root. */
  sel?: string;
  nth?: number;
  /** `call`: a controller method, called with no argument. */
  method?: string;
  /** Skip the click when the element already reads aria-checked="true" / aria-pressed="true". */
  ifUnchecked?: boolean;
  /** Skip silently when the element is missing (a renderer that has not built it yet). */
  optional?: boolean;
}

export interface LiveSpec {
  mobile?: boolean;
  /** Bootstrap patch (deep-merged into baseBootstrap). */
  boot?: JsonObject;
  /** Controller fields, applied in order; `render()` after each step (the real engine's own fields). */
  steps?: FieldStep[];
  /** Open the panel (P/M) before the actions. */
  open: boolean;
  /** Fake media: a hidden remote `<audio>` (voice) plus remote and self `<video>` (video). */
  media?: 'voice' | 'video';
  /** Which exported feed frame feeds the remote video. */
  feed?: 'desktop' | 'mobile' | 'mvid';
  /** The answer of `GET /api/call-widget/calls/:id/status` (a resumed queued call polls it). */
  status?: JsonObject;
  actions?: Action[];
  /** Keep the focus the actions gave (a field's focus halo is drawn). */
  keepFocus?: boolean;
  /** WebYar panels: `config.avatar_url` = the reference's own header tile, exported per state. */
  headerLogo?: boolean;
  /** Desktop shots move the widget 48px from the corner (P/C); G and M keep production's offsets. */
  shotOffset?: boolean;
  /** The page's size instead of the desktop or phone viewport (Tier B of board 04). */
  viewport?: { width: number; height: number };
}

export interface RefSpec {
  /** File in reference/. */
  page: string;
  /** Frame selector; frames nested in another match do not count. */
  frame: string;
  /** Index among the page's frames, in document order. */
  index: number;
  /** C: the component inside the frame (first match). */
  component?: string;
  /** Hover this element (inside the frame) before the shot. */
  hover?: string;
  /** Add a class to an element inside the frame: [selector, class]. */
  addClass?: [string, string];
}

export interface Pads { top: number; right: number; bottom: number; left: number }

export interface GeometrySpec {
  /** The launcher root the placement is measured on (inside `.ccw-launcher-wrap`). */
  launcher: string;
  /** Classes the wrap must carry. */
  wrapClasses: string[];
  /** Expected distances to the viewport edges (CSS px); `centerX` = centred horizontally; `middleY` = top at 50% − 80px. */
  expect: { right?: number; left?: number; bottom?: number; top?: number; centerX?: true; middleY?: true; fullWidth?: true };
  /** Expected panel transform-origin, as fractions of the panel box ([x, y]); null = not checked. */
  origin: [number, number] | null;
  /**
   * Where the open panel sits (CSS px to the viewport edges; `centerX` = centred; `edgeTop` = beside the edge tab,
   * top at max(20px, 50% − 330px)); its size is the design's 400 × 660 in the desktop viewport. Checked with `origin`.
   */
  panel?: { right?: number; left?: number; bottom?: number; top?: number; centerX?: true; edgeTop?: true };
}

export interface CallState {
  /** Harness id (stable, used in file names). */
  id: string;
  /** Acceptance PNG name (without .png). */
  panel: string;
  kind: Kind;
  ref: RefSpec;
  /** P/M: the live panel's `data-screen`. */
  screen?: string;
  /** C: the class the live launcher root must carry (pending until it does). */
  root?: string;
  /** C: the element both sides align on. */
  anchor?: string;
  /** C: crop margins around the reference component (CSS px; default COMPONENT_PAD, clamped inside the frame). */
  pad?: Partial<Pads>;
  /**
   * Masked on both sides (each match's rect), with the reason. A selector ending in ` ::text` masks only
   * the match's text line (the box of its contents, 2px around), so the element's own box stays compared.
   */
  masks?: Array<{ sel: string; why: string }>;
  /** Masked where the live widget draws them (the reference has none), with the reason. */
  liveMasks?: Array<{ sel: string; why: string }>;
  live: LiveSpec;
  geometry?: GeometrySpec;
  /** Board text the fixture's demo data must reproduce (checked against the reference frame by the unit test). */
  drawn: string[];
  /** Initials the board draws for names the fixture holds in full. */
  initials?: string[];
  /** The round and lane that build this state (pending until then). */
  due: { round: number; lane: string };
  note?: string;
  /** R: a specification sheet with no screen of its own (board 12); Tier B shows the PNG alone. */
  specSheet?: boolean;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
/** Digits as the brand's boards print them (Persian in WebYar's fa). */
export function boardDigits(brand: Brand, s: string): string {
  return brand === 'webyar' ? s.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]) : s;
}
/** m:ss of a duration, as the boards print it. */
export function boardClock(brand: Brand, ms: number): string {
  const s = Math.floor(ms / 1000);
  return boardDigits(brand, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
}

const LIVE_DESKTOP = { open: true, shotOffset: true } as const;

/** The 81 acceptance panels of one brand, in board order. */
export function callStates(brand: Brand): CallState[] {
  const fa = brand === 'webyar';
  const d = DEMO[brand];
  const dg = (s: string) => boardDigits(brand, s);
  const L = (fa_: string, en: string) => (fa ? fa_ : en);
  const states: CallState[] = [];
  const add = (s: CallState) => { states.push(s); };
  const headerLogo = fa;
  const voiceForm = { call_type: 'voice' };
  const operatorTeam = (n: number, photo: boolean) => d.team.slice(0, n).map((name) => ({
    name, initial: Array.from(name)[0], avatar_url: photo ? MEDIA.operatorPhoto : null,
  }));
  const booking = {
    callbackId: CALLBACK_ID, scheduled_for: bookedSlot(brand), channel: 'video', urgency: 'urgent',
  };
  const callbackChoice = {
    callback_channel: 'video', callback_when: 'later', callback_scheduled_for: bookedSlot(brand), callback_urgency: 'urgent',
  };
  const queued = (position: number, agoMs: number, eta: number): Pick<LiveSpec, 'boot' | 'status'> => ({
    boot: {
      active_call: {
        call_id: CALL_ID, session: 'sess-call', call_type: 'voice', state: 'queued',
        created_at: new Date(frozenNow(brand) - agoMs).toISOString(), queue_position: position,
      },
    },
    status: { call: { id: CALL_ID, state: 'queued', call_type: 'voice', assigned_agent_id: null }, position, eta_seconds: eta },
  });
  const inCall = (extra: FieldStep = {}): FieldStep => ({
    state: 'in_call', callId: CALL_ID, connectStatus: 'in_call', operatorName: d.operatorName,
    callStartedAt: { $ago: CALL_MS }, micOn: true, camOn: false,
    call: { id: CALL_ID, call_type: 'voice', state: 'active', recording_state: 'recording' },
    formData: voiceForm, connectionQuality: 'good', audioMeterLive: false, cameraDenied: false, ...extra,
  });
  const videoCall = (): FieldStep => inCall({
    camOn: true, call: { id: CALL_ID, call_type: 'video', state: 'active', recording_state: 'recording' },
    formData: { call_type: 'video' },
  });

  // ── Board 01: launcher styles (C), component crops on the white card ──
  const b01 = (i: number, slug: string, style: string, root: string, anchor: string, extra: Partial<CallState>, due: CallState['due']) => add({
    id: `01-L${i}-${style}`, panel: `01-call-buttons--${i}-${slug}`, kind: 'C',
    ref: { page: '01-call-buttons.html', frame: '.lgc', index: i - 1, component: '.spot > *' },
    root, anchor, live: { ...LIVE_DESKTOP, open: false, boot: { config: { launcher_style: style } } },
    drawn: [], due, ...extra,
  });
  b01(1, 'round', 'round', 'ln-c', '.ln-c', {}, { round: 2, lane: 'L4' });
  b01(2, 'round-with-a-label', 'round_label', 'ln-cl', '.ln-c', {
    drawn: [L('همین حالا تماس بگیرید', 'Talk now'), L('پشتیبانی آنلاین', 'Live support')],
    note: 'Board 01 is the component spec: the online label with its close x (D6), border reset applied (§8.3 #2).',
  }, { round: 1, lane: 'L1' });
  b01(3, 'pill', 'pill', 'ln-p', '.ln-p', { drawn: [L('تماس با پشتیبانی', 'Call support')] }, { round: 2, lane: 'L4' });
  b01(4, 'rectangular', 'card', 'ln-r', '.ln-r', {
    live: { ...LIVE_DESKTOP, open: false, boot: { config: { launcher_style: 'card' }, presence: { any_available: true, operators: operatorTeam(3, false) as unknown as Json } } },
    drawn: [L('با تیم ما صحبت کنید', 'Talk to our team'), L('اپراتورها آماده‌اند', 'Operators available')],
    initials: d.team.map((n) => Array.from(n)[0]),
    note: 'Three named operators (.c1 .c2 .c3), no photos.',
  }, { round: 2, lane: 'L4' });
  b01(5, 'split-voice-and-video', 'split', 'ln-s', '.ln-s', {
    drawn: [L('تماس صوتی', 'Voice call'), L('تصویری', 'Video')],
  }, { round: 2, lane: 'L4' });
  b01(6, 'edge-tab', 'edge_tab', 'ln-t', '.ln-t', {
    pad: { right: 0 },
    live: { open: false, shotOffset: false, boot: { config: { launcher_style: 'edge_tab' } } },
    drawn: [L('تماس با ما', 'Call us')],
    note: 'Flush to the right edge: no margin on that side; production offsets (the tab sits at the middle of the edge).',
  }, { round: 2, lane: 'L4' });
  b01(7, 'dark-square', 'dark_square', 'ln-q', '.ln-q', { note: 'The card is dark (#11141A): the live page takes that colour.' }, { round: 2, lane: 'L4' });
  b01(8, 'operator-face', 'operator_face', 'ln-f', '.ln-f .fp', {
    live: { ...LIVE_DESKTOP, open: false, boot: { config: { launcher_style: 'operator_face' }, presence: { any_available: true, operators: operatorTeam(1, true) as unknown as Json } } },
    masks: [{ sel: '.ln-f .pic', why: '§8.3 #7: the operator photo is live data (the board draws an illustration); the ring and badge stay gated' }],
    drawn: [L('همین حالا تماس بگیرید', 'Talk now'), d.operatorName],
  }, { round: 2, lane: 'L4' });
  add({
    id: '01-L9-mobile_bar', panel: '01-call-buttons--9-mobile-bottom-bar', kind: 'R',
    ref: { page: '01-call-buttons.html', frame: '.lgc', index: 8 },
    live: { open: false, mobile: true, boot: { config: { launcher_style: 'mobile_bar' } } },
    drawn: [L('تماس صوتی', 'Voice call'), L('درخواست تماس', 'Callback')],
    due: { round: 4, lane: 'L7' },
    note: 'The board draws a scaled mock (.mini-ph .mbar: 38px buttons, 12px text); the full-size bar is checked on the phone (02 P8, placement spec).',
  });

  // ── Board 02: placements (G) ──
  const b02 = (i: number, slug: string, style: string, position: string, mobile: boolean, geometry: GeometrySpec, due: CallState['due']) => add({
    id: `02-P${i}-${slug}`, panel: `02-placement-on-the-page--${i}-${slug}`, kind: 'G',
    ref: { page: '02-placement-on-the-page.html', frame: '.pm', index: i - 1 },
    live: { open: false, shotOffset: false, mobile, boot: { config: { launcher_style: style, widget_position: position } } },
    geometry, drawn: [], due,
  });
  b02(1, 'bottom-right-default', 'round_label', 'right', false,
    { launcher: '.ln-cl', wrapClasses: ['right'], expect: { right: 22, bottom: 22 }, origin: [1, 1], panel: { right: 22, bottom: 22 } }, { round: 1, lane: 'L1' });
  b02(2, 'bottom-left', 'pill', 'left', false,
    { launcher: '.ln-p', wrapClasses: ['left'], expect: { left: 22, bottom: 22 }, origin: [0, 1], panel: { left: 22, bottom: 22 } }, { round: 2, lane: 'L4' });
  b02(3, 'top-right', 'card', 'top_right', false,
    { launcher: '.ln-r', wrapClasses: ['right', 'top'], expect: { right: 22, top: 20 }, origin: [1, 0], panel: { right: 22, top: 20 } }, { round: 2, lane: 'L4' });
  b02(4, 'top-left', 'round', 'top_left', false,
    { launcher: '.ln-c', wrapClasses: ['left', 'top'], expect: { left: 22, top: 20 }, origin: [0, 0], panel: { left: 22, top: 20 } }, { round: 2, lane: 'L4' });
  b02(5, 'middle-right-edge', 'edge_tab', 'right', false,
    { launcher: '.ln-t', wrapClasses: ['right', 'edge'], expect: { right: 0, middleY: true }, origin: [1, 0.5], panel: { right: 22, edgeTop: true } }, { round: 2, lane: 'L4' });
  b02(6, 'bottom-center', 'split', 'bottom_center', false,
    { launcher: '.ln-s', wrapClasses: ['center'], expect: { centerX: true, bottom: 22 }, origin: [0.5, 1], panel: { centerX: true, bottom: 22 } }, { round: 2, lane: 'L4' });
  b02(7, 'phone-corner', 'round_label', 'right', true,
    { launcher: '.ln-p', wrapClasses: ['right'], expect: { right: 18, bottom: 18 + SAFE_AREA.bottom }, origin: null }, { round: 4, lane: 'L7' });
  b02(8, 'phone-bottom-bar', 'mobile_bar', 'right', true,
    { launcher: '.mbar', wrapClasses: [], expect: { bottom: 0, fullWidth: true }, origin: null }, { round: 4, lane: 'L7' });

  // ── Board 03: launcher states (C) and the film (R) ──
  const b03 = (letter: string, slug: string, index: number, root: string, anchor: string, live: LiveSpec, extra: Partial<CallState>, due: CallState['due']) => add({
    id: `03-S${letter}-${slug}`, panel: `03-button-states-and-motion--${letter}-${slug}`, kind: 'C',
    ref: { page: '03-button-states-and-motion.html', frame: '.stc', index, component: '.area .ln-cl, .area .ln-c, .area .mc, .area .mvid, .area .sched' },
    root, anchor, live, drawn: [], due, ...extra,
  });
  b03('a', 'ready', 0, 'ln-c', '.ln-c', { ...LIVE_DESKTOP, open: false, boot: { config: { launcher_style: 'round' } } },
    { note: 'The board draws round (L1) at rest.' }, { round: 2, lane: 'L4' });
  b03('b', 'hover', 1, 'ln-cl', '.ln-c', {
    ...LIVE_DESKTOP, open: false, actions: [{ do: 'hover', sel: '.ccw-launcher-wrap .ln-c' }],
  }, {
    ref: { page: '03-button-states-and-motion.html', frame: '.stc', index: 1, component: '.area .ln-cl', hover: '.ln-c' },
    liveMasks: [{ sel: '.lbl .x', why: '§8.3 #4 (D6): production draws the online label close x; the board leaves it out' }],
    drawn: [L('همین حالا تماس بگیرید', 'Talk now'), L('پشتیبانی آنلاین', 'Live support')],
    note: 'Driven as round_label + hover on both sides (the lift applies to both).',
  }, { round: 2, lane: 'L4' });
  b03('c', 'business-logo', 2, 'ln-c', '.ln-c', {
    ...LIVE_DESKTOP, open: false, boot: { config: { launcher_style: 'round', avatar_url: MEDIA.businessLogo } },
  }, {
    masks: [{ sel: '.ln-c.logo .f1', why: '§8.3 #7: the business logo face is live data (the board draws a letter)' }],
    drawn: [d.logoLetter],
  }, { round: 2, lane: 'L4' });
  add({
    id: '03-Sc-business-logo-flipped', panel: '03-button-states-and-motion--c-business-logo-flipped', kind: 'C',
    ref: { page: '03-button-states-and-motion.html', frame: '.stc', index: 2, component: '.area .ln-c', hover: '.ln-c', addClass: ['.fc', 'flipped'] },
    root: 'ln-c', anchor: '.ln-c',
    live: {
      ...LIVE_DESKTOP, open: false, boot: { config: { launcher_style: 'round', avatar_url: MEDIA.businessLogo } },
      actions: [{ do: 'hover', sel: '.ccw-launcher-wrap .ln-c' }],
    },
    liveMasks: [{ sel: '.ln-h .lbl', why: 'D6: round shows its label (no x) on hover; the board draws the flipped face alone' }],
    drawn: [], due: { round: 2, lane: 'L4' },
    note: 'Flip on hover (D37); the reference gets .fc.flipped and the same hover.',
  });
  b03('d', 'offline', 3, 'ln-cl', '.ln-c', {
    ...LIVE_DESKTOP, open: false,
    boot: { capabilities: { voice: false, video: false, callback: true }, config: { offline_behavior: 'show_callback' } },
  }, {
    drawn: [L('درخواست تماس', 'Callback'), L('ثبت اطلاعات', 'Leave details')],
    note: 'The default style offline with show_callback; the offline label has no x (D6).',
  }, { round: 1, lane: 'L1' });
  b03('e', 'in-line-minimized', 4, 'mc', '.mc', {
    ...LIVE_DESKTOP, open: true, ...queued(3, QUEUE_THIRD_MS, 180),
    steps: [{ queueStartedAt: { $ago: QUEUE_THIRD_MS }, queuePosition: 3, queueEta: 180 }],
    actions: [{ do: 'click', sel: '[data-action=minimize]' }],
  }, {
    drawn: [L('نفر ۳ صف', '#3 in line'), `${L('زمان انتظار', 'Waiting time')} ${boardClock(brand, QUEUE_THIRD_MS)}`],
  }, { round: 2, lane: 'L3' });
  b03('f', 'on-a-call-minimized', 5, 'mc', '.mc', {
    ...LIVE_DESKTOP, open: true, media: 'voice', steps: [inCall()],
    actions: [{ do: 'click', sel: '[data-action=minimize]' }],
  }, {
    drawn: [d.operatorFirst, boardClock(brand, CALL_MS)],
    note: 'Level bars frozen (reduced motion; audioMeterLive false).',
  }, { round: 2, lane: 'L3' });
  b03('g', 'video-call-minimized', 6, 'mvid', '.mvid', {
    ...LIVE_DESKTOP, open: true, media: 'video', feed: 'mvid', steps: [videoCall()],
    actions: [{ do: 'click', sel: '[data-action=minimize]' }],
  }, { drawn: [boardClock(brand, CALL_MS)] }, { round: 2, lane: 'L3' });
  b03('h', 'callback-booked', 7, 'sched', '.sched', {
    ...LIVE_DESKTOP, open: false, steps: [{ callbackBooking: booking as unknown as Json }],
  }, {
    drawn: [L('درخواست تماس ثبت شد', 'Callback scheduled'), L('فردا ۱۶:۳۰', 'Tomorrow 4:30')],
    ...(fa ? {} : { masks: [{ sel: '.sched small', why: '§8.3 #9: Intl prints "Tomorrow 4:30 PM" where the board writes "Tomorrow 4:30"' }] }),
  }, { round: 2, lane: 'L4' });
  const film = ['1-closed', '2-opening', '3-open', '4-closing'];
  film.forEach((slug, i) => add({
    id: `03-F${i + 1}-motion`, panel: `03-button-states-and-motion--motion-${slug}`, kind: 'R',
    ref: { page: '03-button-states-and-motion.html', frame: '.frm', index: i },
    live: { open: false }, drawn: [], due: { round: 5, lane: 'L9' },
    note: 'Schematic film frames: acceptance is the motion timing (behaviour spec, §8.4), not pixels.',
  }));

  // ── Board 04: the live prototype (R; 384 wide, not canonical) ──
  const b04 = ['closed', 'open-home', 'queue', 'call', 'minimized-call', 'rating', 'thanks', 'button-c-br', 'button-p-bl', 'button-r-br', 'button-t-tr'];
  for (const v of b04) {
    add({
      id: `04-${v}`, panel: `04-live-prototype--${v}`, kind: 'R',
      ref: { page: v === 'closed' ? '04-live-prototype.html' : `04-live-prototype--${v}.html`, frame: '.site2', index: 0 },
      live: { open: false }, drawn: [], due: { round: 6, lane: 'L11' },
      note: 'Prototype panel drawn 384 wide (D12: 400): review only.',
    });
  }

  // ── Board 05: starting a call (P), with the radius variants ──
  const radiusVariants: Array<Radius | null> = [null, 'sm', 'lg'];
  for (const r of radiusVariants) {
    const suffix = r ? `--radius-${r}` : '';
    const page = `05-starting-a-call${suffix}.html`;
    const theme = r ? { config: { widget_theme: { radius: r } } } : {};
    add({
      id: `05-01-home${suffix}`, panel: `05-starting-a-call--01-home-operators-online${suffix}`, kind: 'P', screen: 'home',
      ref: { page, frame: 'section.cp', index: 0 },
      live: {
        ...LIVE_DESKTOP, headerLogo,
        boot: mergeJson(theme as JsonObject, { i18n: { available_locales: fa ? ['fa', 'en'] : ['en', 'fa'] } }),
      },
      drawn: [d.displayName, L('فا', 'EN'), L('صوتی · تصویری · درخواست تماس', 'Voice · Video · Callback')],
      note: 'Two locales: the .lang pill is drawn on this screen only.',
      due: { round: 1, lane: 'L1' },
    });
    add({
      id: `05-02-precall-error${suffix}`, panel: `05-starting-a-call--02-precall-form-with-an-error${suffix}`, kind: 'P', screen: 'precall',
      ref: { page, frame: 'section.cp', index: 1 },
      live: {
        ...LIVE_DESKTOP, headerLogo, boot: theme as JsonObject,
        steps: [{
          state: 'pre_call_form', error: { $t: 'err_recording_accept' },
          formData: { call_type: 'voice', name: d.visitorName, email: d.email, phone: d.phone, subject: d.subjectError, department_id: DEPARTMENT_IDS[0], consent: false },
        }],
      },
      drawn: [d.departments[0], d.departments[1], d.departments[2], d.visitorName, d.email, d.phone, d.subjectError,
        L('برای شروع تماس لطفاً رضایت ضبط را تأیید کنید.', 'Please accept the recording consent to start the call.')],
      due: { round: 1, lane: 'L1' },
    });
    add({
      id: `05-03-returning${suffix}`, panel: `05-starting-a-call--03-returning-visitor${suffix}`, kind: 'P', screen: 'precall',
      ref: { page, frame: 'section.cp', index: 2 },
      live: {
        ...LIVE_DESKTOP, headerLogo, keepFocus: true,
        boot: mergeJson(theme as JsonObject, { visitor: { id: 'visitor-harness', contact: { id: 'contact-ali', name: d.visitorName, email: d.email, phone: '' } } }),
        steps: [{ state: 'pre_call_form', formData: { call_type: 'video', subject: d.subjectReturning, consent: true } }],
        actions: [{ do: 'focus', sel: '.scr.on .inp input' }],
      },
      drawn: [d.visitorName, d.subjectReturning],
      initials: [Array.from(d.visitorName)[0]],
      note: 'Identified contact; the subject field focused (the board draws its focus halo).',
      due: { round: 1, lane: 'L1' },
    });
  }

  // ── Board 06: waiting in line (P, stage) ──
  add({
    id: '06-04-connecting', panel: '06-waiting-in-line--04-connecting', kind: 'P', screen: 'connecting',
    ref: { page: '06-waiting-in-line.html', frame: 'section.cp', index: 0 },
    live: { ...LIVE_DESKTOP, headerLogo, steps: [{ state: 'loading', formData: { call_type: 'voice', department_id: DEPARTMENT_IDS[0] } }] },
    drawn: [`${L('تماس صوتی', 'Voice call')} · ${d.departments[0]}`],
    due: { round: 2, lane: 'L3' },
  });
  add({
    id: '06-05-queue-third', panel: '06-waiting-in-line--05-in-line-third', kind: 'P', screen: 'queue',
    ref: { page: '06-waiting-in-line.html', frame: 'section.cp', index: 1 },
    live: {
      ...LIVE_DESKTOP, headerLogo, ...queued(3, QUEUE_THIRD_MS, 180),
      steps: [{ queueStartedAt: { $ago: QUEUE_THIRD_MS }, queuePosition: 3, queueEta: 180 }],
    },
    drawn: [boardClock(brand, QUEUE_THIRD_MS), dg('3'), L('حدود ۳ دقیقه', '~3 minutes')],
    note: 'A resumed queued call (bootstrap.active_call): the engine starts the hold ringback, so audio.isActive() draws the pill\'s level bars.',
    due: { round: 2, lane: 'L3' },
  });
  add({
    id: '06-06-queue-next-offer', panel: '06-waiting-in-line--06-next-with-a-callback-offer', kind: 'P', screen: 'queue',
    ref: { page: '06-waiting-in-line.html', frame: 'section.cp', index: 2 },
    live: {
      ...LIVE_DESKTOP, headerLogo, ...queued(1, QUEUE_NEXT_MS, 45),
      boot: mergeJson(queued(1, QUEUE_NEXT_MS, 45).boot as JsonObject, { queue_experience: { offer_callback_after_seconds: 30 } }),
      steps: [{ queueStartedAt: { $ago: QUEUE_NEXT_MS }, queuePosition: 1, queueEta: 45 }],
    },
    drawn: [boardClock(brand, QUEUE_NEXT_MS), L('از انتظار خسته شدید؟ می‌توانیم با شما تماس بگیریم.', 'Tired of waiting? We can call you back instead.')],
    note: 'The timer row\'s second sound toggle is not drawn (§8.3 #3, D7).',
    due: { round: 2, lane: 'L3' },
  });

  // ── Board 07: on a call (P, stage) ──
  add({
    id: '07-07-joining', panel: '07-on-a-call--07-operator-joining', kind: 'P', screen: 'joining',
    ref: { page: '07-on-a-call.html', frame: 'section.cp', index: 0 },
    live: {
      ...LIVE_DESKTOP, headerLogo, media: 'voice',
      steps: [inCall({ connectStatus: 'waiting_for_operator', callStartedAt: null, call: { id: CALL_ID, call_type: 'voice', state: 'active', recording_state: null } })],
    },
    drawn: [d.operatorName],
    initials: [Array.from(d.operatorName)[0]],
    due: { round: 2, lane: 'L3' },
  });
  add({
    id: '07-08-voice', panel: '07-on-a-call--08-voice-call', kind: 'P', screen: 'voice',
    ref: { page: '07-on-a-call.html', frame: 'section.cp', index: 1 },
    live: { ...LIVE_DESKTOP, headerLogo, media: 'voice', steps: [inCall()] },
    drawn: [d.operatorName, boardClock(brand, CALL_MS)],
    due: { round: 2, lane: 'L3' },
  });
  add({
    id: '07-09-video', panel: '07-on-a-call--09-video-call', kind: 'P', screen: 'video',
    ref: { page: '07-on-a-call.html', frame: 'section.cp', index: 2 },
    live: { ...LIVE_DESKTOP, headerLogo, media: 'video', feed: 'desktop', steps: [videoCall()] },
    drawn: [d.operatorName, boardClock(brand, CALL_MS)],
    masks: [{
      sel: '.vtop ::text',
      why: '§8.3 #10: Chromium rasterises the text inside the pill\'s backdrop-filter layer up to 2 device px lower in the live '
        + 'widget (same layout on both sides; 0.19% of Respok\'s panel); the pill itself stays compared and its box probed',
    }],
    note: 'The feed and the self-view are the reference\'s own pictures, exported and played through real <video> elements (§8.3 #5).',
    due: { round: 2, lane: 'L3' },
  });

  // ── Board 08: during the call (P, stage) ──
  add({
    id: '08-10-transfer', panel: '08-during-the-call--10-transferring', kind: 'P', screen: 'transfer',
    ref: { page: '08-during-the-call.html', frame: 'section.cp', index: 0 },
    live: {
      ...LIVE_DESKTOP, headerLogo, media: 'voice',
      // The previous operator is remembered on transferring's rising edge (UI.previousOperatorName).
      steps: [inCall({ callStartedAt: { $ago: TRANSFER_MS } }), { transferring: true, operatorName: null }],
    },
    drawn: [boardClock(brand, TRANSFER_MS)],
    initials: [Array.from(d.operatorName)[0]],
    due: { round: 2, lane: 'L3' },
  });
  add({
    id: '08-11-reconnect', panel: '08-during-the-call--11-reconnecting', kind: 'P', screen: 'reconnect',
    ref: { page: '08-during-the-call.html', frame: 'section.cp', index: 1 },
    live: { ...LIVE_DESKTOP, headerLogo, media: 'voice', steps: [inCall({ connectStatus: 'media_reconnecting', callStartedAt: { $ago: RECONNECT_MS } })] },
    drawn: [d.operatorName, boardClock(brand, RECONNECT_MS)],
    due: { round: 2, lane: 'L3' },
  });
  add({
    id: '08-12-mic-blocked', panel: '08-during-the-call--12-microphone-blocked', kind: 'P', screen: 'mic',
    ref: { page: '08-during-the-call.html', frame: 'section.cp', index: 2 },
    live: {
      ...LIVE_DESKTOP, headerLogo,
      steps: [inCall({ connectStatus: 'microphone_permission_denied', micOn: false, error: { $t: 'mic_denied' } })],
    },
    drawn: [SITE_HOST],
    note: 'The host bar prints location.hostname: the harness serves the page from the demo store\'s host.',
    due: { round: 2, lane: 'L3' },
  });

  // ── Board 09: after the call (P) ──
  const ended = (extra: FieldStep = {}): FieldStep => ({
    state: 'ended', endedCallId: CALL_ID, endedDuration: ENDED_DURATION_S, operatorName: d.operatorName,
    ratingSubmitted: false, ratingValue: 0, ratingComment: '', formData: voiceForm, ...extra,
  });
  add({
    id: '09-13-rating', panel: '09-after-the-call--13-rating-the-call', kind: 'P', screen: 'rating',
    ref: { page: '09-after-the-call.html', frame: 'section.cp', index: 0 },
    live: {
      ...LIVE_DESKTOP, headerLogo, steps: [ended()],
      actions: [{ do: 'click', sel: '[data-action=star][data-value="4"]' }],
    },
    drawn: [`${d.operatorName} · ${L('مدت مکالمه', 'Duration')} ${boardClock(brand, ENDED_DURATION_S * 1000)}`],
    note: 'Four stars by a real click.',
    due: { round: 1, lane: 'L1' },
  });
  add({
    id: '09-14-thanks', panel: '09-after-the-call--14-thank-you', kind: 'P', screen: 'thanks',
    ref: { page: '09-after-the-call.html', frame: 'section.cp', index: 1 },
    live: { ...LIVE_DESKTOP, headerLogo, steps: [ended({ ratingSubmitted: true, ratingValue: 4 })] },
    drawn: [d.operatorName, `${L('مدت مکالمه', 'Duration')} ${boardClock(brand, ENDED_DURATION_S * 1000)}`],
    due: { round: 1, lane: 'L1' },
  });
  add({
    id: '09-15-error', panel: '09-after-the-call--15-error', kind: 'P', screen: 'error',
    ref: { page: '09-after-the-call.html', frame: 'section.cp', index: 2 },
    live: { ...LIVE_DESKTOP, headerLogo, steps: [{ state: 'error', error: d.serverError }] },
    drawn: [d.serverError, L('اپراتورها آماده‌اند', 'Operators available')],
    note: 'Staffed: the header reads online, as drawn.',
    due: { round: 1, lane: 'L1' },
  });

  // ── Board 10: callback (P) ──
  const offline = { capabilities: { voice: false, video: false, callback: true } };
  add({
    id: '10-16-offline', panel: '10-callback--16-team-offline', kind: 'P', screen: 'offline',
    ref: { page: '10-callback.html', frame: 'section.cp', index: 0 },
    live: { ...LIVE_DESKTOP, headerLogo, boot: offline },
    drawn: [L('میز درخواست تماس', 'Callback desk')],
    due: { round: 1, lane: 'L1' },
  });
  const step1: Pick<LiveSpec, 'steps' | 'actions'> = {
    steps: [{ formData: callbackChoice }],
    actions: [
      { do: 'call', method: 'openCallback' },
      { do: 'click', sel: '[data-action=seg][data-field=callback_channel][data-value=video]', ifUnchecked: true, optional: true },
      { do: 'click', sel: '[data-action=seg][data-field=callback_when][data-value=later]', ifUnchecked: true, optional: true },
      { do: 'click', sel: '[data-action=day]', nth: 1, ifUnchecked: true, optional: true },
      { do: 'click', sel: `[data-action=slot][data-value="${bookedSlot(brand)}"]`, ifUnchecked: true, optional: true },
      { do: 'click', sel: '[data-action=seg][data-field=callback_urgency][data-value=urgent]', ifUnchecked: true, optional: true },
    ],
  };
  add({
    id: '10-17-callback-step1', panel: '10-callback--17-callback-step-1', kind: 'P', screen: 'callback',
    ref: { page: '10-callback.html', frame: 'section.cp', index: 1 },
    live: { ...LIVE_DESKTOP, headerLogo, ...step1 },
    drawn: [L('امروز', 'Today'), L('فردا', 'Tomorrow'), L('شنبه', 'Sat'), L('یکشنبه', 'Sun'),
      ...(fa ? ['۱۰:۰۰', '۱۲:۳۰', '۱۶:۳۰', '۱۸:۰۰'] : ['10:00 AM', '12:30 PM', '4:30 PM', '6:00 PM'])],
    note: 'Slots from callback_policy.slots; tomorrow 10:00 is a full slot (available:false), struck.',
    due: { round: 1, lane: 'L1' },
  });
  add({
    id: '10-18-callback-step2', panel: '10-callback--18-callback-step-2', kind: 'P', screen: 'callback',
    ref: { page: '10-callback.html', frame: 'section.cp', index: 2 },
    live: {
      ...LIVE_DESKTOP, headerLogo, keepFocus: true,
      steps: [{ formData: { ...callbackChoice, name: d.visitorName, email: d.emailTyping, phone: d.phone, department_id: DEPARTMENT_IDS[1] } }],
      actions: [
        ...(step1.actions || []),
        { do: 'click', sel: '[data-action=continue]' },
        { do: 'click', sel: `[data-action=dept][data-value=${DEPARTMENT_IDS[1]}]`, ifUnchecked: true, optional: true },
        { do: 'focus', sel: '.scr.on input[type=email]' },
      ],
    },
    drawn: [L('تماس تصویری · فردا، ۱۶:۳۰ · فوری', 'Video · Tomorrow, 4:30 PM · Urgent'), d.departments[1], d.visitorName, d.emailTyping, d.phone],
    note: 'Continue by a real click; the e-mail field focused while typing (the board draws its halo).',
    due: { round: 1, lane: 'L1' },
  });
  add({
    id: '10-19-scheduled', panel: '10-callback--19-callback-scheduled', kind: 'P', screen: 'scheduled',
    ref: { page: '10-callback.html', frame: 'section.cp', index: 3 },
    live: {
      ...LIVE_DESKTOP, headerLogo, boot: offline,
      steps: [{ state: 'ended', callbackId: CALLBACK_ID, formData: callbackChoice, callbackBooking: booking as unknown as Json }],
    },
    drawn: [CALLBACK_CODE, L('فردا، ۱۶:۳۰', 'Tomorrow, 4:30 PM'), L('میز درخواست تماس', 'Callback desk')],
    note: 'Drawn with the offline header (channels off).',
    due: { round: 1, lane: 'L1' },
  });

  // ── Board 11: mobile (M) ──
  const mobileMasks = [
    { sel: '.notch', why: 'board chrome: the phone\'s notch' },
    { sel: '.homebar', why: 'board chrome: the phone\'s home bar' },
  ];
  add({
    id: '11-20-button', panel: '11-mobile--20-button-on-the-page', kind: 'M', screen: '',
    ref: { page: '11-mobile.html', frame: 'section.cp', index: 0 },
    root: 'ln-p',
    live: { open: false, mobile: true },
    masks: mobileMasks,
    drawn: [L('تماس با پشتیبانی', 'Call support')],
    note: 'round_label on a phone renders as the 56px pill (D14).',
    due: { round: 4, lane: 'L7' },
  });
  add({
    id: '11-21-sheet', panel: '11-mobile--21-home-as-a-sheet', kind: 'M', screen: 'home',
    ref: { page: '11-mobile.html', frame: 'section.cp', index: 1 },
    live: { open: true, mobile: true, headerLogo },
    masks: mobileMasks,
    drawn: [d.displayName],
    due: { round: 4, lane: 'L7' },
  });
  add({
    id: '11-22-queue', panel: '11-mobile--22-queue-full-screen', kind: 'M', screen: 'queue',
    ref: { page: '11-mobile.html', frame: 'section.cp', index: 2 },
    live: {
      open: true, mobile: true, headerLogo, ...queued(3, QUEUE_THIRD_MS, 180),
      steps: [{ queueStartedAt: { $ago: QUEUE_THIRD_MS }, queuePosition: 3, queueEta: 180 }],
    },
    masks: mobileMasks,
    drawn: [boardClock(brand, QUEUE_THIRD_MS), L('حدود ۳ دقیقه', '~3 minutes')],
    due: { round: 4, lane: 'L7' },
  });
  add({
    id: '11-23-video', panel: '11-mobile--23-video-call-full-screen', kind: 'M', screen: 'video',
    ref: { page: '11-mobile.html', frame: 'section.cp', index: 3 },
    live: { open: true, mobile: true, headerLogo, media: 'video', feed: 'mobile', steps: [videoCall()] },
    masks: mobileMasks,
    drawn: [d.operatorName, boardClock(brand, CALL_MS)],
    due: { round: 4, lane: 'L7' },
  });

  // ── Board 12: design system (R; token probe later) ──
  const b12 = ['01-color', '02-any-brand-color', '03-type', '04-corners-and-elevation', '05-buttons', '06-form',
    '07-call-controls', '08-status-call', '09-status-presence', '10-rating', '11-motion'];
  b12.forEach((slug, i) => add({
    id: `12-${slug}`, panel: `12-design-system--${slug}`, kind: 'R',
    ref: { page: '12-design-system.html', frame: '.sc', index: i },
    live: { open: false }, drawn: [], due: { round: 6, lane: 'L11' }, specSheet: true,
    note: 'Specification sheets, not product UI: callWidgetScreens.spec.ts probes the tokens (tokens.json, every accent, '
      + 'the radius sets); the components are gated on the P screens that draw them; the sheet is reviewed.',
  }));

  // Tier B (--compare-acceptance) of the review-only panels: what the live widget shows for each. The prototype's
  // states are the P/C states that draw the same screen, on a page of the prototype's size (its panel is 384 wide).
  const liveOf = (id: string): LiveSpec => states.find((x) => x.id === id)!.live;
  const prototype: Record<string, LiveSpec> = {
    closed: { open: false },
    // The prototype's header has no language pill: one locale (05-01's second one draws it).
    'open-home': { open: true },
    queue: liveOf('06-05-queue-third'),
    call: liveOf('07-08-voice'),
    'minimized-call': liveOf('03-Sf-on-a-call-minimized'),
    rating: liveOf('09-13-rating'),
    thanks: liveOf('09-14-thanks'),
    'button-c-br': { open: false, boot: { config: { launcher_style: 'round' } } },
    'button-p-bl': { open: false, boot: { config: { launcher_style: 'pill', widget_position: 'left' } } },
    'button-r-br': { open: false, boot: liveOf('01-L4-card').boot },
    'button-t-tr': { open: false, boot: { config: { launcher_style: 'edge_tab', widget_position: 'top_right' } } },
  };
  for (const st of states) {
    if (st.id.startsWith('04-')) st.live = { ...prototype[st.id.slice(3)], shotOffset: false, viewport: PROTOTYPE_VIEWPORT };
    // The film: closed, the panel open (opening, open), closed again; its timing is the behaviour spec's.
    if (st.id.startsWith('03-F')) st.live = { open: /^03-F[23]-/.test(st.id), shotOffset: false, viewport: PROTOTYPE_VIEWPORT };
  }

  // Respok's skin (presentation-intl.css) is completed in round 2 (L4): the
  // screens round 1 builds carry only its token block until then.
  if (!fa) {
    for (const s of states) {
      if (s.due.round === 1 && PIXEL_KINDS.has(s.kind)) s.due = { round: 2, lane: 'L4' };
    }
  }
  return states;
}

/** The kinds the Tier A gate compares by pixels. */
export const PIXEL_KINDS: ReadonlySet<Kind> = new Set<Kind>(['P', 'M', 'C']);

/** The engine's methods the drawn controls of 12 (Try again) and 13 (Skip) call: the real ones (round 4 removed the fixture's stand-ins). */
export const ENGINE_METHODS = ['retryMicrophone', 'skipRating', 'dismissLabel'] as const;

/** Box probes (§8.2): the same selectors on both sides, panel-relative rects within ±0.5px. */
export const PANEL_PROBES = [
  '.hd', '.bd', '.badge', '.hh', '.opts', '.opt', '.cbr', '.trust', '.pw', '.chips', '.grp', '.fr', '.cons', '.acts', '.btn',
  '.pill', '.orb', '.sh', '.tmr', '.qc', '.dock', '.vtop', '.pip', '.vdock', '.ctr', '.stars', '.kv', '.days', '.slots', '.sumchip',
] as const;
export const PHONE_PROBES = [...PANEL_PROBES, '.sheet', '.grab'] as const;

/** Tier A thresholds (§8.2). */
export const TIER_A = {
  /** A channel difference above this counts as a different pixel (compare.py's threshold). */
  channelThreshold: 28,
  /** Share of different pixels allowed per panel, after masks. */
  maxShare: 0.002,
  /** Shares from here up to maxShare are listed for review. */
  reviewShare: 0.0005,
  /** Box probe tolerance (CSS px). */
  boxTolerance: 0.5,
} as const;
