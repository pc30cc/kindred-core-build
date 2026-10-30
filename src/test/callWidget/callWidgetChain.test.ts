/**
 * The 2026-10 call widget, end to end in one process (contract §10, L12):
 *
 *   the dashboard's Settings page (its real hooks and API client)
 *     → PUT /api/call-center/settings (the real router and settings service)
 *     → the stored row (./fakeDb.ts) and the bootstrap memo it drops
 *     → GET /api/call-widget/bootstrap (the real router)
 *     → the engine (runtime.js) → the presentation (core + panel module),
 *
 * for every setting the design added, in both editions: the launcher style,
 * the placement and its older spellings, the International logo direction,
 * the presence a style is sent (and only that), callback slots on and off
 * with the 409 of a slot taken meanwhile, the booking the answer echoes, the
 * panel module's asset paths, the status endpoint's privacy, and E19 (screen
 * 10) against the writes of the real `transferCall`. The engine's requests
 * go to the real visitor routes (status, join token, callbacks, cancel); only
 * `calls/request` is answered here (its plan, entitlement and routing checks
 * are not this chain's), with a row and a session exactly as it makes them.
 *
 * Rolling deploy (§5.1): the pairings that need no earlier release's files:
 * the 6f8af41 dashboard's save payload against the new PUT, the new
 * dashboard's payload against the 6f8af41 PUT's strict keys, and a bootstrap
 * of the 6f8af41 server (its shape, as that router answers) in the new widget.
 */
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import { db, fakeClient } from './fakeDb';
import { startTestServer, type TestServer } from './callWidgetHttp';
import { closeCallWidgets, fakeApi, mountCallWidget, type ApiRequest, type Engine, type Mounted } from './mountCallWidget';
import { z } from 'zod';
import { callbackMatchesSearch, callbackReference, type CallbackRequest } from '@/lib/call-center-api';
import { INTL_BRAND } from '../../../shared/internationalMode';
import { CALL_WIDGET_TEMPLATES } from '../../../shared/widgetTemplates';
import { avatarFace, avatarFaces } from '../widget/avatarFace';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

type Row = Record<string, unknown>;
type Dict = Record<string, unknown>;

const h = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international',
  logoDirection: null as string | null,
  rings: [] as Array<Record<string, unknown>>,
  toasts: [] as Array<Record<string, unknown>>,
}));

/**
 * The service client: ./fakeDb.ts, with an upsert that honours `onConflict`
 * (an operator's presence row is updated, not added twice) and the role RPC
 * the call-center routes ask, answered from workspace_members.
 */
const client = {
  from: (table: string) => {
    const q = fakeClient.from(table);
    const insert = q.upsert;
    return Object.assign(q, {
      upsert: (payload: Row | Row[], opts?: { onConflict?: string }) => {
        const cols = opts?.onConflict?.split(',').map((c) => c.trim()) ?? [];
        const one = Array.isArray(payload) ? payload[0] : payload;
        if (cols.length && !Array.isArray(payload) && (db[table] || []).some((r) => cols.every((c) => r[c] === one[c]))) {
          return cols.reduce((u, c) => u.eq(c, one[c]), q.update(one));
        }
        return insert(payload);
      },
    });
  },
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    if (fn === 'get_workspace_role') {
      const m = (db.workspace_members || []).find((r) => r.workspace_id === args._workspace_id && r.user_id === args._user_id);
      return { data: m ? m.role : null, error: null };
    }
    return fakeClient.rpc(fn);
  },
};
vi.mock('@supabase/supabase-js', () => ({ createClient: () => client }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => client }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: async () => {} }));
vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({
  loadEffectiveCallEntitlements: async () => ({ callbacks_enabled: true, visitor_voice_enabled: true, visitor_video_enabled: true }),
}));
vi.mock('../../../server/services/callCenter/realtime.js', () => ({ publishQueueEvent: async () => {}, publishCallEvent: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyCallbackRequest: async () => {} }));
vi.mock('../../../server/services/push/callRing.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/push/callRing.js')>()),
  ringOperators: async (_c: unknown, args: Record<string, unknown>) => { h.rings.push(args); },
  cancelRing: async () => {},
}));
// The media server's room is made on its API (a network call): here it is named; tokens are minted for real.
vi.mock('../../../server/services/calls/providerResolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../server/services/calls/providerResolver.js')>();
  return {
    ...real,
    resolveEffectiveCallProvider: async (...args: Parameters<typeof real.resolveEffectiveCallProvider>) => {
      const r = await real.resolveEffectiveCallProvider(...args);
      return { ...r, provider: { ...r.provider, createRoom: async (_c: unknown, input: { callSessionId: string }) => ({ providerRoomId: `room-${input.callSessionId}` }) } };
    },
  };
});
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => h.edition,
}));
// The chat widget's template (its own lane): the logo direction it wears.
vi.mock('../../../server/services/widget/configSnapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/configSnapshot.js')>()),
  workspaceChatTemplate: async () => ({ id: 't1-intl', descriptor: null, options: h.logoDirection ? { logoDirection: h.logoDirection } : {} }),
}));
vi.mock('../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async (req: { authUser?: { id: string } }) => ({ userId: req.authUser?.id, isAdmin: false, role: 'member' }),
}));
vi.mock('../../../server/middleware/adminBypass.js', () => ({ isGlobalAdmin: async () => false }));
// The dashboard page's own surroundings (the call-center hooks and API client stay real).
vi.mock('@/hooks/useWorkspace', () => ({ useActiveWorkspace: () => ({ workspace: { id: WS, name: 'Shop' }, notFound: false }) }));
vi.mock('@/lib/workspace-departments-api', () => ({ listDepartments: async () => [] }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'multi', allowedLocales: ['en', 'fa', 'tr'], canSwitchLanguage: true, currency: 'USD' }),
}));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: h.edition, isInternational: h.edition === 'international', ready: true }),
  useKnownEdition: () => h.edition,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: (t: Record<string, unknown>) => { h.toasts.push(t); } }));
vi.mock('@/hooks/useWidgetSettings', () => ({ useWidgetSettings: () => ({ data: null }) }));
vi.mock('@/hooks/useWorkspaceMembers', () => ({ useWorkspaceMembers: () => ({ data: [] }) }));

const WS = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://shop.example';
const OWNER = '00000000-0000-4000-8000-0000000000a0';
/** Operators: A and B by name; C has no full name (never their e-mail). */
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const DEPT = '33333333-3333-4333-8333-333333333333';
// Monday 19 October 2026, 09:30 in Tehran (10:00 would be the first slot of a 09:00–12:00 day).
const NOW = Date.parse('2026-10-19T06:00:00Z');
const HOURS = { enabled: true, timezone: 'Asia/Tehran', weekly: { mon: [{ from: '09:00', to: '12:00' }], tue: [{ from: '09:00', to: '12:00' }] } };
const CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };
/** Waits for real HTTP round trips and React renders: generous, so a loaded CI machine never fails a correct chain. */
const SLOW = 15_000;
vi.setConfig({ testTimeout: 60_000 });

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { callCenterRouter } = await import('../../../server/routes/callCenter.js');
const { invalidateCallWidgetBootstrapCache } = await import('../../../server/services/callCenter/bootstrapCache.js');
const { invalidatePublicCallPresence } = await import('../../../server/services/callCenter/publicPresence.js');
const { signWidgetSession, verifyWidgetSession } = await import('../../../server/services/callCenter/widgetSession.js');
const { publishCacheInvalidation } = await import('../../../server/lib/cacheBus.js');
const SettingsPage = (await import('@/pages/app/call-center/SettingsPage')).default;

/** The visitor's browser on the customer's site. */
const site = startTestServer('/api/call-widget', callWidgetRouter, CONFIG, { origin: ORIGIN });
/** The workspace owner in the dashboard, and operator A at the console. */
const dashboard = startTestServer('/api/call-center', callCenterRouter, CONFIG, { authUserId: OWNER });
const consoles = new Map<string, TestServer>();
/** An operator's console (the call-center API as that user). */
function consoleOf(user: string): TestServer {
  if (!consoles.has(user)) consoles.set(user, startTestServer('/api/call-center', callCenterRouter, CONFIG, { authUserId: user }));
  return consoles.get(user)!;
}
afterAll(() => { site.close(); dashboard.close(); for (const c of consoles.values()) c.close(); });

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

function settingsRow(over: Row = {}): Row {
  return {
    id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'], widget_position: 'right',
    widget_theme: {}, display_name: 'Shop', avatar_url: null, avatar_storage_path: null, voice_enabled: true, video_enabled: true,
    callback_enabled: true, recording_enabled: false, pre_call_form_enabled: false, pre_call_form_schema: [], offline_behavior: 'show_callback',
    departments_enabled: false, allow_visitor_department_choice: false, widget_custom_texts: {}, default_department_id: null,
    business_hours: {}, recording_consent_required: false, operator_video_visible_to_visitor: true, widget_template_id: null,
    routing_mode: 'broadcast', widget_default_locale: null, widget_enabled_locales: null,
    // Migration 277's columns with their defaults.
    launcher_style: 'round_label', callback_slots_enabled: false, callback_slot_minutes: 30, callback_days_ahead: 4, callback_slot_capacity: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.edition = 'iran';
  h.logoDirection = null;
  h.rings = [];
  h.toasts = [];
  site.clearCookies();
  db.platform_call_center_settings = [{
    singleton: true, call_center_enabled: true, voice_calls_enabled: true, video_calls_enabled: true, callback_requests_enabled: true,
    call_recording_enabled: false, departments_enabled: false, ringback_enabled: false, ringback_mode: 'off', ringback_queue_audio_paths: {},
    widget_default_locale: 'fa', widget_available_locales: ['fa', 'en', 'tr'], disabled_message: {},
    callback_honeypot_enabled: true, callback_min_form_seconds: 0, callback_require_contact: false, callback_min_message_length: 0,
    callback_max_per_ip_per_hour: 0, callback_min_seconds_between_requests: 0,
  }];
  db.app_runtime_config = [
    { key: 'call_control_plane', value: { enabled: true, primary_provider: 'livekit' } },
    { key: 'call_livekit_config', value: { enabled: true, api_key: 'k', api_secret: 's', rtc_url: 'wss://lk.example', egress_enabled: false } },
    { key: 'default_storage_provider', value: { provider: 'local' } },
  ];
  db.platform_settings = [{ region_mode: 'iran' }];
  db.widget_platform_settings = [{ powered_by_enabled: true, powered_by_text: 'Powered by', powered_by_brand_text: 'RESPOK', powered_by_url: null }];
  db.platform_branding_localized = [{ locale: 'en', platform_name: 'RESPOK' }];
  db.call_center_settings = [settingsRow()];
  db.workspace_members = [
    { workspace_id: WS, user_id: OWNER, role: 'owner', created_at: '2026-01-01T00:00:00Z' },
    { workspace_id: WS, user_id: A, role: 'agent', created_at: '2026-01-02T00:00:00Z' },
    { workspace_id: WS, user_id: B, role: 'agent', created_at: '2026-01-03T00:00:00Z' },
    { workspace_id: WS, user_id: C, role: 'agent', created_at: '2026-01-04T00:00:00Z' },
  ];
  db.call_center_agent_presence = [A, B].map((user_id) => ({ workspace_id: WS, user_id, status: 'available', active_call_count: 0, last_seen_at: null }));
  db.profiles = [
    { id: OWNER, full_name: null, email: 'owner@shop.example', avatar_storage_key: null },
    { id: A, full_name: 'Sara Ahmadi', email: 'sara@shop.example', avatar_storage_key: null },
    { id: B, full_name: 'Reza Karimi', email: 'reza@shop.example', avatar_storage_key: null },
    { id: C, full_name: null, email: 'c.agent@shop.example', avatar_storage_key: null },
  ];
  db.workspace_departments = [];
  db.workspace_department_members = [];
  db.callback_requests = [];
  db.call_sessions = [];
  db.call_queue_entries = [];
  db.call_events = [];
  invalidateCallWidgetBootstrapCache();
  invalidatePublicCallPresence();
});
afterEach(() => {
  cleanup();
  closeCallWidgets();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── The dashboard ─────────────────────────────────────────────────────────

/** A backend as the dashboard's fetch sees it. */
type Backend = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>;

/** The dashboard's fetch: its API client's requests to the real call-center router. */
function dashboardFetch(server: TestServer): Backend {
  return async (url: string, init: RequestInit = {}) => {
    const u = new URL(String(url), 'https://app.example');
    const path = u.pathname + u.search;
    const method = String(init.method || 'GET');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const r = method === 'PUT' ? await server.put(path, body) : method === 'POST' ? await server.post(path, body) : await server.get(path);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.text, json: async () => r.body };
  };
}

/** The Settings page as the owner sees it, loaded from the real GET; `act` changes it like the admin; Save → the real PUT. */
async function dashboardSave(
  edit: () => Promise<void> | void,
  backend: Backend = dashboardFetch(dashboard),
): Promise<{ status: number; sent: Dict }> {
  const sent: Dict[] = [];
  const statuses: number[] = [];
  const relay = backend;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const r = await relay(url, init);
    if (String(init.method || 'GET') === 'PUT') { sent.push(JSON.parse(String(init.body))); statuses.push(r.status); }
    return r;
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client: qc },
    createElement(MemoryRouter, null,
      createElement(I18nProvider, { initialLocale: 'en', initialTranslations: en, children: createElement(SettingsPage) }))));
  await screen.findByRole('tab', { name: en.callCenter.settingsPage.tabs.general }, { timeout: SLOW });
  await edit();
  fireEvent.click(await screen.findByRole('button', { name: en.callCenter.common.saveChanges }, { timeout: SLOW }));
  await waitFor(() => expect(statuses).toHaveLength(1), { timeout: SLOW });
  return { status: statuses[0], sent: sent[0] };
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

async function choose(trigger: HTMLElement, option: string) {
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }, { timeout: SLOW }));
}

const S = en.callCenter.settingsPage;

// ─── The visitor ───────────────────────────────────────────────────────────

async function bootstrap(): Promise<Dict> {
  const res = await site.get<Dict>(`/api/call-widget/bootstrap?workspaceId=${WS}`);
  expect(res.status).toBe(200);
  return res.body;
}

interface Relay {
  requests: ApiRequest[];
  /** What the real routes answered, in order. */
  answers: Array<{ path: string; status: number; body: unknown }>;
  fetch: (url: string, init?: RequestInit) => Promise<unknown>;
}

/**
 * The engine's api() through the real visitor router (the page's cookies,
 * the engine's own headers); `own` answers a request first.
 */
function relay(own?: (req: ApiRequest) => { status?: number; body?: unknown } | undefined | Promise<{ status?: number; body?: unknown } | undefined>): Relay {
  const answers: Relay['answers'] = [];
  const api = fakeApi(async (req) => {
    const mine = own ? await own(req) : undefined;
    if (mine) return mine;
    const headers = ccHeaders(req);
    // A POST without a body is sent without one (the engine's join token, cancel).
    const r = req.method === 'POST' ? await site.post(req.path, req.body ?? undefined, headers) : await site.get(req.path, headers);
    answers.push({ path: req.path, status: r.status, body: r.body });
    return { status: r.status, body: r.body };
  });
  return { ...api, answers };
}

/** The engine's own headers (its session, its active call). */
function ccHeaders(req: ApiRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (k.toLowerCase().startsWith('x-cc-')) headers[k] = v;
  return headers;
}

const relays = new WeakMap<Mounted, Relay>();
/** The widget on the page, mounted with exactly what the server answered (the helper's own bootstrap is replaced, not merged). */
function visit(body: Dict, opts: { relay?: Relay; locale?: 'fa' | 'en'; liveKit?: boolean; shipped?: 'iran' | 'respok' } = {}): Mounted {
  const r = opts.relay ?? relay();
  const m = mountCallWidget({
    now: NOW,
    shipped: opts.shipped,
    locale: opts.locale ?? (h.edition === 'international' ? 'en' : 'fa'),
    edition: h.edition,
    fetch: r.fetch,
    liveKit: opts.liveKit,
    mountExtra: { bootstrap: body },
  });
  relays.set(m, r);
  return m;
}
/** The requests the widget's engine sent. */
const relayLog = (m: Mounted) => relays.get(m)!.requests;

async function until(fn: () => boolean, what: string, ms = SLOW) {
  const t0 = performance.now();
  while (!fn()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const launcherOf = (m: Mounted) => m.q('.ccw-launcher-wrap');

// ─── Settings → widget ─────────────────────────────────────────────────────

describe('settings chain: dashboard → PUT → bootstrap → widget (Iranian edition)', () => {
  it('a launcher style and a placement chosen in the dashboard are what the visitor\'s widget wears, at once (the save drops the bootstrap memo)', async () => {
    // The widget before: the default launcher at the right.
    const before = visit(await bootstrap());
    expect(launcherOf(before)!.classList.contains('right')).toBe(true);
    expect(before.q('.ln-cl')).not.toBeNull();

    const { status, sent } = await dashboardSave(async () => {
      openTab(S.tabs.presentation);
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-call-launcher-style="card"]')!);
      openTab(S.tabs.general);
      await choose(document.querySelector<HTMLElement>('[data-call-position]')!, S.positionOptions.left);
    });
    expect(status).toBe(200);
    expect(sent).toMatchObject({ launcher_style: 'card', widget_position: 'left' });
    expect(db.call_center_settings[0]).toMatchObject({ launcher_style: 'card', widget_position: 'left' });

    const body = await bootstrap();
    expect((body.config as Dict).launcher_style).toBe('card');
    expect((body.config as Dict).widget_position).toBe('left');
    const m = visit(body);
    expect(launcherOf(m)!.classList.contains('left')).toBe(true);
    expect(m.q('.ln-r.ccw-launcher-btn')).not.toBeNull();
    // card draws the available operators (presence is sent for it): a
    // silhouette each without a photo, never their initials.
    expect(avatarFaces(m.qa('.ln-r .avs .av'))).toEqual(['person', 'person']);
  });

  it('a placement stored in any older spelling reaches the dashboard and the widget as its placement', async () => {
    for (const [stored, canonical, classes] of [
      ['bottom-left', 'left', ['left']], ['bottom_left', 'left', ['left']], ['bottom-right', 'right', ['right']],
      ['top-right', 'top_right', ['right', 'top']], ['top-left', 'top_left', ['left', 'top']],
      ['bottom-center', 'bottom_center', ['center']], ['center', 'bottom_center', ['center']], ['middle', 'right', ['right']],
    ] as const) {
      db.call_center_settings = [settingsRow({ widget_position: stored })];
      invalidateCallWidgetBootstrapCache();
      const loaded = await dashboard.get<{ settings: Dict }>(`/api/call-center/settings?workspaceId=${WS}`);
      expect(loaded.body.settings.widget_position, stored).toBe(canonical);
      const body = await bootstrap();
      expect((body.config as Dict).widget_position, stored).toBe(canonical);
      const m = visit(body);
      expect(m.ctrl.position(), stored).toBe(canonical);
      expect([...launcherOf(m)!.classList].filter((c) => c !== 'ccw-launcher-wrap'), stored).toEqual(classes);
      closeCallWidgets();
    }
  });

  it('presence: names only (never an initial) for card and operator_face, "anyone available" for every style; an operator going away reaches the widget through the presence memo', async () => {
    const plain = await bootstrap();
    expect(plain.presence).toEqual({ any_available: true });

    db.call_center_settings = [settingsRow({ launcher_style: 'operator_face' })];
    invalidateCallWidgetBootstrapCache();
    const face = await bootstrap();
    expect(face.presence).toEqual({
      any_available: true,
      operators: [{ name: 'Sara Ahmadi', avatar_url: null }, { name: 'Reza Karimi', avatar_url: null }],
    });
    // Nothing that names a user: no id, no e-mail.
    const text = JSON.stringify(face);
    for (const id of [OWNER, A, B, C]) expect(text).not.toContain(id);
    expect(text).not.toMatch(/@|sara@|reza@/);
    const m = visit(face);
    // operator_face: the first named operator's silhouette (no photo; the
    // presence's `initial` is not drawn) and name.
    expect(m.q('.ln-f > button.fp.ccw-launcher-btn')).not.toBeNull();
    expect(avatarFace(m.q('.ln-f .pic .av.c1'))).toBe('person');
    expect(m.q('.ln-f .lbl small')!.textContent).toBe('Sara Ahmadi');

    // Both operators step away at the console: the next page view says nobody is available.
    for (const op of [A, B]) {
      const r = await consoleOf(op).put(`/api/call-center/agents/me/presence?workspaceId=${WS}`, { status: 'away' });
      expect(r.status).toBe(200);
    }
    const away = await bootstrap();
    expect(away.presence).toEqual({ any_available: false, operators: [] });
    const m2 = visit(away);
    // Nobody available: the widget is offline (owner 2026-10-21), the default launcher's dot off.
    expect(m2.q('.ln-cl')).not.toBeNull();
    expect(m2.q('.ln-cl .ls.off')).not.toBeNull();
    m2.open();
    expect(m2.screenId()).toBe('offline');
    expect(m2.q('[data-action="voice"]')).toBeNull();

    // The Call Center header's "Set available" (POST /agent-status) is the
    // status routing and the widget read: the next page view is online again,
    // and the header reads it back.
    db.operator_call_availability = db.operator_call_availability || [];
    const set = await consoleOf(A).post(`/api/call-center/agent-status?workspaceId=${WS}`, { status: 'available' });
    expect(set.status).toBe(200);
    const back = await bootstrap();
    expect((back.presence as { any_available: boolean }).any_available).toBe(true);
    const m3 = visit(back);
    m3.open();
    expect(m3.screenId()).toBe('home');
    const header = await consoleOf(A).get(`/api/call-center/agent-status?workspaceId=${WS}`);
    expect((header.body as { agents: { user_id: string; status: string }[] }).agents.find((x) => x.user_id === A)?.status).toBe('available');
  });
});

describe('callback slots: dashboard → bootstrap → widget → POST /callbacks/request (Iranian edition)', () => {
  /** Step 1 of the callback form, "later", the slot buttons. */
  function laterSlots(m: Mounted) {
    m.open();
    m.click('[data-action="callback"]');
    expect(m.screenId()).toBe('callback');
    m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
    return m.qa<HTMLButtonElement>('[data-screen="callback"] [data-action="slot"]');
  }
  function submitStep2(m: Mounted) {
    m.click('[data-action="continue"]');
    Object.assign(m.ctrl.formData as Dict, { name: 'Ali', phone: '09120000000', message: 'Please call me' });
    m.q('[data-screen="callback"] form')!.dispatchEvent(new m.win.Event('submit', { bubbles: true, cancelable: true }));
  }
  const open = (b: HTMLButtonElement) => !b.disabled && b.getAttribute('aria-disabled') !== 'true';

  it('slots turned on with one callback per slot: the visitor books one (the answer\'s echo becomes the booking on the button); a slot taken meanwhile is 409 → step 1 with the error', async () => {
    const { status, sent } = await dashboardSave(async () => {
      openTab(S.tabs.availability);
      fireEvent.click(document.querySelector<HTMLElement>('[data-callback-slots]')!);
      fireEvent.change(document.querySelector<HTMLInputElement>('[data-callback-capacity]')!, { target: { value: '1' } });
    });
    expect(status).toBe(200);
    expect(sent).toMatchObject({ callback_slots_enabled: true, callback_slot_capacity: 1, business_hours: { timezone: 'Asia/Tehran' } });
    // The hours never reach the visitor; the slots do.
    const body = await bootstrap();
    const slots = (body.callback_policy as { slots?: Array<{ at: string; available: boolean }> }).slots!;
    expect(slots.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('business_hours');
    expect(slots[0].at).toMatch(/\+03:30$/);

    const first = visit(body);
    const second = visit(body);
    const buttons = laterSlots(first);
    const pick = buttons.find(open)!;
    const at = pick.getAttribute('data-value')!;
    expect(slots.find((s) => s.at === at)?.available).toBe(true);
    pick.click();
    expect((first.ctrl.formData as Dict).callback_scheduled_for).toBe(at);
    submitStep2(first);
    await until(() => first.ctrl.state === 'ended' && !!first.ctrl.callbackId, 'the booking');
    expect(first.screenId()).toBe('scheduled');
    expect(db.callback_requests).toHaveLength(1);
    expect(Date.parse(String(db.callback_requests[0].scheduled_for))).toBe(Date.parse(at));
    // The answer echoes the time as stored and the channel; that is the booking the button keeps.
    const answer = relays.get(first)!.answers.find((a) => a.path.endsWith('/callbacks/request'))!;
    expect(answer).toMatchObject({ status: 200, body: { ok: true, callback_id: db.callback_requests[0].id, scheduled_for: new Date(Date.parse(at)).toISOString(), channel: 'audio' } });
    expect(first.ctrl.callbackBooking).toMatchObject({ callbackId: db.callback_requests[0].id, scheduled_for: new Date(Date.parse(at)).toISOString(), channel: 'audio' });
    // The reference the visitor reads out (screen 19) is the one the dashboard's Callbacks page shows and finds.
    const code = first.q('[data-screen="scheduled"] .kv .code')!.textContent!;
    expect(code).toBe(callbackReference(String(db.callback_requests[0].id)));
    expect(callbackMatchesSearch(db.callback_requests[0] as unknown as CallbackRequest, code.toLowerCase())).toBe(true);
    first.click('[data-screen="scheduled"] [data-action="done"]');
    await until(() => !!first.q('.ccw-launcher-wrap .sched'), 'the booked callback on the button');
    expect(first.q('.sched .tx small')!.textContent).toMatch(/[۰-۹]{2}:[۰-۹]{2}$/);

    // The second page still offers that slot (booked after it loaded): the server re-checks it.
    laterSlots(second);
    second.click(`[data-screen="callback"] [data-action="slot"][data-value="${at}"]`);
    submitStep2(second);
    await until(() => !!second.ctrl.errorKey, 'the refusal');
    expect(relays.get(second)!.answers.find((a) => a.path.endsWith('/callbacks/request'))).toMatchObject({ status: 409, body: { error: 'slot_unavailable' } });
    expect(second.ctrl.errorKey).toBe('err_future_time');
    expect(second.ctrl.state).toBe('callback_form');
    expect(second.qa('[data-screen="callback"] .stp .bars .on')).toHaveLength(1);
    expect(second.q('[data-screen="callback"] [data-error]')!.textContent).toBe(second.ctrl.t('err_future_time'));
    expect(db.callback_requests).toHaveLength(1);
  });

  it('slots off (the default, even with valid hours stored): no slots in the bootstrap, the native picker, and any future time is taken', async () => {
    db.call_center_settings = [settingsRow({ business_hours: HOURS })];
    const body = await bootstrap();
    expect((body.callback_policy as Dict).slots).toBeUndefined();
    const m = visit(body);
    m.open();
    m.click('[data-action="callback"]');
    m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
    expect(m.qa('[data-screen="callback"] [data-action="slot"]')).toHaveLength(0);
    const picker = m.q<HTMLInputElement>('[data-screen="callback"] input[type="datetime-local"]')!;
    // Tomorrow at 10:07 (off any 30-minute grid) in the page's own zone.
    const local = new Date(NOW + 86_400_000);
    const value = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}T10:07`;
    picker.value = value;
    picker.dispatchEvent(new m.win.Event('input', { bubbles: true }));
    submitStep2(m);
    await until(() => m.ctrl.state === 'ended' && !!m.ctrl.callbackId, 'the booking');
    const sentAt = String(relayLog(m).find((r) => r.path.endsWith('/callbacks/request'))!.body!.scheduled_for);
    expect(new Date(sentAt).getTime()).toBe(new Date(value).getTime());
    expect(db.callback_requests).toHaveLength(1);
    expect((m.ctrl.callbackBooking as Dict).scheduled_for).toBe(new Date(value).toISOString());
  });
});

describe('settings chain (International edition)', () => {
  beforeEach(() => { h.edition = 'international'; });

  it('a style and a top placement from the dashboard; the logo direction the chat widget wears, and its change (the chat\'s save drops the call bootstrap too)', async () => {
    h.logoDirection = 'open';
    const { status, sent } = await dashboardSave(async () => {
      openTab(S.tabs.presentation);
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-call-launcher-style="pill"]')!);
      openTab(S.tabs.general);
      await choose(document.querySelector<HTMLElement>('[data-call-position]')!, S.positionOptions.top_left);
    });
    expect(status).toBe(200);
    expect(sent).toMatchObject({ launcher_style: 'pill', widget_position: 'top_left', widget_template_id: 'intl' });

    const body = await bootstrap();
    expect(body.config).toMatchObject({ launcher_style: 'pill', widget_position: 'top_left', widget_template_id: 'intl', logoDirection: 'open' });
    expect((body.powered_by as Dict).logo).toBe(INTL_BRAND.horizontalOpen.light);
    const m = visit(body);
    expect(m.root.classList.contains('ccw-presentation-intl')).toBe(true);
    expect(m.root.classList.contains('lg-open')).toBe(true);
    expect(m.q('.ln-p.ccw-launcher-btn')).not.toBeNull();
    expect([...launcherOf(m)!.classList].filter((c) => c !== 'ccw-launcher-wrap')).toEqual(['left', 'top']);
    m.open();
    expect(m.q('.scr.on .ccw-footer svg.lk')).not.toBeNull();

    // The chat widget back on Thread: its settings save publishes widget:<ws>, which the call bootstrap listens to.
    h.logoDirection = null;
    publishCacheInvalidation([`widget:${WS}`]);
    const after = await bootstrap();
    expect((after.config as Dict).logoDirection).toBe('thread');
    expect((after.powered_by as Dict).logo).toBe(INTL_BRAND.horizontal.light);
    expect(visit(after).root.classList.contains('lg-thread')).toBe(true);
  });

  it('slots turned on abroad: the hours are in the admin\'s zone, the slots carry it, the visitor books one and keeps it', async () => {
    const { status, sent } = await dashboardSave(async () => {
      openTab(S.tabs.availability);
      fireEvent.click(document.querySelector<HTMLElement>('[data-callback-slots]')!);
    });
    expect(status).toBe(200);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect((sent.business_hours as Dict).timezone).toBe(zone);
    const body = await bootstrap();
    expect(body).toMatchObject({ calendar: 'gregorian', time_zone: null });
    const slots = (body.callback_policy as { slots: Array<{ at: string; available: boolean }> }).slots;
    expect(slots.some((x) => x.available)).toBe(true);
    const m = visit(body);
    m.open();
    m.click('[data-action="callback"]');
    m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
    const pick = m.qa<HTMLButtonElement>('[data-screen="callback"] [data-action="slot"]').find((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')!;
    pick.click();
    m.click('[data-action="continue"]');
    Object.assign(m.ctrl.formData as Dict, { name: 'Alex', email: 'alex@example.com', message: 'Call me' });
    m.q('[data-screen="callback"] form')!.dispatchEvent(new m.win.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => m.ctrl.state === 'ended' && !!m.ctrl.callbackId, 'the booking');
    expect(Date.parse(String(db.callback_requests[0].scheduled_for))).toBe(Date.parse(pick.getAttribute('data-value')!));
    expect((m.ctrl.callbackBooking as Dict).channel).toBe('audio');
  });
});

describe('the panel module\'s files (lazy, contract §2.1–2.3)', () => {
  it.each(['iran', 'international'] as const)('%s: the bootstrap names the descriptor\'s panel pair; the core links that stylesheet before the skin on the first intent', async (edition) => {
    h.edition = edition;
    const body = await bootstrap();
    const id = (body.config as Dict).widget_template_id as keyof typeof CALL_WIDGET_TEMPLATES;
    expect(id).toBe(edition === 'iran' ? 'default' : 'intl');
    const assets = body.assets as Dict;
    expect(assets.presentation_panel_script_url).toBe(`/call-widget/${CALL_WIDGET_TEMPLATES[id].panel.script}`);
    expect(assets.presentation_panel_style_url).toBe(`/call-widget/${CALL_WIDGET_TEMPLATES[id].panel.style}`);
    const m = visit(body);
    const hrefs = () => m.qa<HTMLLinkElement>('link[rel="stylesheet"]').map((l) => new URL(l.href).pathname);
    expect(hrefs()).not.toContain(assets.presentation_panel_style_url);
    m.q('.ccw-launcher-wrap')!.dispatchEvent(new m.win.Event('focusin', { bubbles: true }));
    const list = hrefs();
    expect(list.indexOf(String(assets.presentation_panel_style_url))).toBe(list.indexOf(String(assets.presentation_style_url)) - 1);
  });
});

describe('each brand\'s shipped files (minified, the other brand\'s kit stripped) on the same chain', () => {
  it.each([['iran', 'iran'], ['international', 'respok']] as const)('%s edition, %s build: a card launcher from the dashboard, the credit, a booked slot', async (edition, brand) => {
    h.edition = edition;
    db.call_center_settings = [settingsRow({ business_hours: HOURS })];
    const { status } = await dashboardSave(() => {
      openTab(S.tabs.presentation);
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-call-launcher-style="card"]')!);
      openTab(S.tabs.availability);
      fireEvent.click(document.querySelector<HTMLElement>('[data-callback-slots]')!);
    });
    expect(status).toBe(200);
    const m = visit(await bootstrap(), { shipped: brand });
    expect(m.q('.ln-r.ccw-launcher-btn')).not.toBeNull();
    expect(avatarFaces(m.qa('.ln-r .avs .av'))).toEqual(['person', 'person']);
    m.open();
    expect(m.screenId()).toBe('home');
    // The credit of this edition: WebYar's mark (the Iran kit) or the International lockup, never the other's.
    expect(!!m.q('.scr.on .ccw-footer svg.wm')).toBe(brand === 'iran');
    expect(!!m.q('.scr.on .ccw-footer svg.lk')).toBe(brand === 'respok');
    m.click('[data-action="callback"]');
    m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
    const pick = m.qa<HTMLButtonElement>('[data-screen="callback"] [data-action="slot"]').find((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true')!;
    pick.click();
    m.click('[data-action="continue"]');
    Object.assign(m.ctrl.formData as Dict, { name: 'Ali', phone: '09120000000', email: 'ali@example.com', message: 'Please call me' });
    m.q('[data-screen="callback"] form')!.dispatchEvent(new m.win.Event('submit', { bubbles: true, cancelable: true }));
    await until(() => m.ctrl.state === 'ended' && !!m.ctrl.callbackId, 'the booking');
    expect(m.screenId()).toBe('scheduled');
    expect(Date.parse(String(db.callback_requests[0].scheduled_for))).toBe(Date.parse(pick.getAttribute('data-value')!));
  });
});

// ─── A call ────────────────────────────────────────────────────────────────

/** The participant identity a LiveKit token carries (the JWT's subject). */
function identityOf(token: string): string {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub as string;
}

let callSeq = 0;
/**
 * `calls/request`, as the real route makes it (a queued call_widget session
 * with its queue entry, and a session bound to the call), without the plan,
 * entitlement and routing checks this chain is not about.
 */
function requestCall(req: ApiRequest): Dict {
  const visitor = verifyWidgetSession(CONFIG as never, req.headers['x-cc-session'] || '');
  const id = `c0ffee00-0000-4000-8000-${String(++callSeq).padStart(12, '0')}`;
  db.call_sessions.push({
    id, workspace_id: WS, entry_source: 'call_widget', state: 'queued', call_type: req.body?.call_type === 'video' ? 'video' : 'audio',
    provider: 'livekit', provider_room_id: null, assigned_agent_id: null, department_id: null, recording_enabled: false,
    recording_state: 'disabled', started_at: null, connected_at: null, ended_at: null, end_reason: null, duration_seconds: null,
    created_at: new Date().toISOString(), metadata: { call_center: true },
  });
  db.call_queue_entries.push({ workspace_id: WS, entry_source: 'call_widget', channel: 'audio', state: 'queued', call_session_id: id, priority: 100, created_at: new Date().toISOString() });
  const session = signWidgetSession(CONFIG as never, { workspace_id: WS, public_key: 'cck_x', call_id: id, visitor_id: visitor?.visitor_id ?? null, origin: ORIGIN });
  return { status: 'queued', call_id: id, queue_position: 1, session, contact: null };
}

/**
 * A status answer as the 6f8af41 backend gave it for the same row: the
 * operator's user id itself in `assigned_agent_id`, the provider and its room.
 */
function statusAs6f8af41(body: Dict): Dict {
  const call = body.call as Dict;
  const row = db.call_sessions.find((r) => r.id === call.id)!;
  return { ...body, call: { ...call, assigned_agent_id: row.assigned_agent_id ?? null, provider: row.provider, provider_room_id: row.provider_room_id } };
}

/**
 * A visitor on a voice call that operator A answered (the real accept) and is
 * in. `oldBackend`: while it says so, the status answers come from a 6f8af41
 * backend (a deploy of this release happens during the call).
 */
async function answeredCall(opts: { oldBackend?: () => boolean } = {}) {
  const statuses: Dict[] = [];
  const r = relay(async (req) => {
    if (req.path === '/api/call-widget/calls/request') return { body: requestCall(req) };
    if (/\/calls\/[^/]+\/status$/.test(req.path)) {
      const res = await site.get(req.path, ccHeaders(req));
      const body = res.status === 200 && opts.oldBackend?.() ? statusAs6f8af41(res.body as Dict) : res.body as Dict;
      statuses.push(body);
      return { status: res.status, body };
    }
    return undefined;
  });
  const m = visit(await bootstrap(), { relay: r, liveKit: true });
  const c = m.ctrl as unknown as Engine;
  const poll = () => Promise.resolve(c.pollOnce() as unknown);
  m.open();
  m.click('[data-screen="home"] [data-action="voice"]');
  await until(() => c.state === 'queue_waiting' && !!c.callId, 'the queue');
  const id = c.callId!;
  const accepted = await consoleOf(A).post<{ token: string }>(`/api/call-center/calls/${id}/accept?workspaceId=${WS}`, {});
  expect(accepted.status).toBe(200);
  const operatorA = identityOf(accepted.body.token);
  m.lk!.present = [operatorA];
  await poll();
  await until(() => m.screenId() === 'voice', 'the call screen');
  return { m, c, id, poll, statuses, operatorA, room: () => m.lk!.room() };
}

/** What every status answer the visitor got may carry: no user id, no e-mail, no provider or room. */
function expectPrivate(statuses: Dict[]) {
  expect(statuses.length).toBeGreaterThan(0);
  for (const body of statuses) {
    const text = JSON.stringify(body);
    for (const id of [OWNER, A, B, C]) expect(text).not.toContain(id);
    // Names only from full_name: never an e-mail or its local part (C has no name, only c.agent@…).
    expect(text).not.toMatch(/@|shop\.example|c\.agent/);
    const call = body.call as Dict;
    // What RT and the presentation read, nothing more (no provider, room, workspace or entry source).
    for (const key of Object.keys(call)) {
      expect(['assigned_agent_id', 'call_type', 'duration_seconds', 'end_reason', 'ended_at', 'id', 'recording_enabled', 'recording_state', 'started_at', 'state']).toContain(key);
    }
    expect(call.assigned_agent_id === null || /^[0-9a-f]{16}$/.test(String(call.assigned_agent_id))).toBe(true);
  }
}

describe('a call through the real visitor routes: status privacy and E19 against transferCall\'s writes', () => {
  it('A → B by name: screen 10 from the poll that sees B until B is in the room; A leaving meanwhile is no failure; the time runs on; B\'s name', async () => {
    const { m, c, id, poll, statuses, operatorA, room } = await answeredCall();
    expect(c.operatorName).toBe('Sara Ahmadi');
    const started = c.callStartedAt;
    expect(started).toBeTruthy();
    const refA = (statuses[statuses.length - 1].call as Dict).assigned_agent_id;

    const t = await consoleOf(A).post(`/api/call-center/calls/${id}/transfer?workspaceId=${WS}`, { to_agent_id: B, reason: 'billing' });
    expect(t.status).toBe(200);
    expect(db.call_sessions[0]).toMatchObject({ assigned_agent_id: B, transfer_from_agent_id: A, transfer_to_agent_id: B });
    expect(h.rings.map((x) => x.agentId)).toContain(B);
    await poll();
    expect(c.transferring).toBe(true);
    expect(m.screenId()).toBe('transfer');
    const refB = (statuses[statuses.length - 1].call as Dict).assigned_agent_id;
    expect(refB).not.toBe(refA);

    room().leave(operatorA);
    await poll();
    expect(c.connectStatus).not.toBe('operator_left');
    expect(m.screenId()).toBe('transfer');

    const acceptedB = await consoleOf(B).post<{ token: string }>(`/api/call-center/calls/${id}/accept?workspaceId=${WS}`, {});
    expect(acceptedB.status).toBe(200);
    room().join(identityOf(acceptedB.body.token));
    expect(c.transferring).toBe(false);
    expect(c.operatorName).toBe('Reza Karimi');
    expect(m.screenId()).toBe('voice');
    expect(c.callStartedAt).toBe(started);
    await poll();
    expect((statuses[statuses.length - 1].call as Dict).assigned_agent_id).toBe(refB);

    // Privacy, and the 6f8af41 engine's transfer rule (a reference that changes between two polls) on these answers:
    // the same reference while one operator has the call, another for the next one.
    expectPrivate(statuses);
    const refs = statuses.map((b) => (b.call as Dict).assigned_agent_id).filter(Boolean);
    const changes = refs.filter((ref, i) => i > 0 && ref !== refs[i - 1]);
    expect(changes).toEqual([refB]);
  });

  it('A → a department nobody has picked yet (the reference goes to none) → C answers: the transfer lasts until C is in; C has no name, so the operator label', async () => {
    db.workspace_departments = [{ id: DEPT, workspace_id: WS, name: 'Sales', enabled: true, cc_voice_enabled: true, cc_video_enabled: false, cc_callback_enabled: false, cc_routing_mode: 'broadcast', cc_fallback_department_id: null, cc_routing_state: null }];
    db.workspace_department_members = [A, C].map((user_id) => ({ workspace_id: WS, department_id: DEPT, user_id, call_center_enabled: true, call_center_priority: 100 }));
    const { m, c, id, poll, statuses, operatorA, room } = await answeredCall();

    expect((await consoleOf(A).post(`/api/call-center/calls/${id}/transfer?workspaceId=${WS}`, { to_department_id: DEPT })).status).toBe(200);
    expect(db.call_sessions[0]).toMatchObject({ assigned_agent_id: null, department_id: DEPT });
    await poll();
    expect((statuses[statuses.length - 1].call as Dict).assigned_agent_id).toBeNull();
    expect(c.transferring).toBe(true);
    expect(m.screenId()).toBe('transfer');
    room().leave(operatorA);

    const acceptedC = await consoleOf(C).post<{ token: string }>(`/api/call-center/calls/${id}/accept?workspaceId=${WS}`, {});
    expect(acceptedC.status).toBe(200);
    await poll();
    // Assigned again, but not in the room yet: still the transfer.
    expect(c.transferring).toBe(true);
    expect(statuses[statuses.length - 1].operator_name).toBeNull();
    room().join(identityOf(acceptedC.body.token));
    expect(c.transferring).toBe(false);
    expect(c.operatorName).toBeNull();
    expect(m.screenId()).toBe('voice');
    // D34: no name line; the operator label stands alone.
    expect(m.screen()!.textContent).toContain(m.ctrl.t('operator_label'));
    expectPrivate(statuses);
  });

  it('the backend deploys during the call (6f8af41 → this release, and a rollback): the operator\'s id becomes the opaque reference of the same operator, which is no transfer; a transfer after it still is', async () => {
    let old = true;
    const { m, c, id, poll, statuses } = await answeredCall({ oldBackend: () => old });
    const last = () => (statuses[statuses.length - 1].call as Dict).assigned_agent_id;
    expect(last()).toBe(A);
    const started = c.callStartedAt;

    // The new backend answers from now on: A's reference, A still in the room and talking.
    old = false;
    await poll();
    expect(last()).toMatch(/^[0-9a-f]{16}$/);
    expect(c.transferring).toBe(false);
    expect(m.screenId()).toBe('voice');
    expect(c.operatorName).toBe('Sara Ahmadi');
    expect(c.callStartedAt).toBe(started);
    await poll();
    expect(c.transferring).toBe(false);

    // A rollback (ROLLBACK=1): the id again, the same operator.
    old = true;
    await poll();
    expect(last()).toBe(A);
    expect(c.transferring).toBe(false);
    expect(m.screenId()).toBe('voice');
    old = false;
    await poll();
    expect(c.transferring).toBe(false);

    // A real transfer afterwards is still screen 10.
    expect((await consoleOf(A).post(`/api/call-center/calls/${id}/transfer?workspaceId=${WS}`, { to_agent_id: B })).status).toBe(200);
    await poll();
    expect(c.transferring).toBe(true);
    expect(m.screenId()).toBe('transfer');
  });
});

// ─── Rolling deploy (§5.1) ─────────────────────────────────────────────────

/** 6f8af41's `settingsPatchSchema` (server/routes/callCenter.ts at that commit): strict, its keys only. */
const PUT_6F8AF41 = z.object({
  enabled: z.boolean().optional(),
  allowed_domains: z.array(z.string()).optional(),
  widget_position: z.string().optional(),
  widget_template_id: z.enum(['default', 'intl']).optional(),
  widget_theme: z.record(z.unknown()).optional(),
  display_name: z.string().nullable().optional(),
  voice_enabled: z.boolean().optional(),
  video_enabled: z.boolean().optional(),
  callback_enabled: z.boolean().optional(),
  pre_call_form_enabled: z.boolean().optional(),
  pre_call_form_schema: z.array(z.unknown()).optional(),
  business_hours: z.record(z.unknown()).optional(),
  offline_behavior: z.enum(['show_callback', 'show_message', 'hide']).optional(),
  recording_enabled: z.boolean().optional(),
  recording_consent_required: z.boolean().optional(),
  operator_video_visible_to_visitor: z.boolean().optional(),
  routing_mode: z.string().optional(),
  default_department_id: z.string().uuid().nullable().optional(),
  widget_default_locale: z.enum(['en', 'fa', 'tr']).nullable().optional(),
  widget_enabled_locales: z.array(z.enum(['en', 'fa', 'tr'])).nullable().optional(),
  widget_custom_texts: z.record(z.record(z.string().max(200))).nullable().optional(),
}).strict();

/**
 * GET /api/call-center/settings as the 6f8af41 backend answers it (the row
 * as stored: no placement normalised, the 277 columns only when the database
 * has them), and its PUT (the strict schema above).
 */
function backend6f8af41(row: Row): Backend {
  const settings = { ...row, widget_template_id: row.widget_template_id || 'default' };
  delete (settings as Row).avatar_storage_path;
  const getBody = {
    settings,
    platform: db.platform_call_center_settings[0],
    effective: { call_center_enabled: true, workspace_call_center_visible: true, voice_enabled: true, video_enabled: true, callback_enabled: true, recording_enabled: false },
    recording: { enabled_by_platform: false, enabled_by_plan: true, enabled_by_workspace: false, consent_required: false, provider_supported: true, provider_configured: false, effective_enabled: false, reason: 'platform_disabled' },
  };
  return async (_url: string, init: RequestInit = {}) => {
    let status = 200;
    let body: unknown = getBody;
    if (String(init.method || 'GET') === 'PUT') {
      const parsed = PUT_6F8AF41.safeParse(JSON.parse(String(init.body)));
      if (parsed.success) body = { settings: { ...settings, ...parsed.data } };
      else { status = 400; body = { error: 'invalid_body', details: parsed.error.flatten() }; }
    }
    const text = JSON.stringify(body);
    return { ok: status === 200, status, text: async () => text, json: async () => body };
  };
}

describe('rolling deploy: dashboards, backends and widgets of either release', () => {
  it('the 6f8af41 dashboard\'s save (every key it sends, resent as it loaded them from the new backend) is accepted and changes only what it meant', async () => {
    for (const stored of [
      { widget_position: 'bottom-left', business_hours: {} },
      { widget_position: 'top_right', business_hours: { legacy: true, note: 'free text from the API', days: ['sat'] } },
      { widget_position: 'right', business_hours: HOURS, callback_slots_enabled: true, launcher_style: 'card' },
    ]) {
      db.call_center_settings = [settingsRow(stored)];
      invalidateCallWidgetBootstrapCache();
      const before = await bootstrap();
      const s = (await dashboard.get<{ settings: Dict }>(`/api/call-center/settings?workspaceId=${WS}`)).body.settings;
      // 6f8af41's save(), field by field.
      const payload = {
        enabled: s.enabled, display_name: 'Help desk',
        voice_enabled: s.voice_enabled, video_enabled: s.video_enabled,
        callback_enabled: s.callback_enabled, pre_call_form_enabled: s.pre_call_form_enabled,
        offline_behavior: s.offline_behavior, recording_enabled: s.recording_enabled,
        recording_consent_required: s.recording_consent_required, routing_mode: s.routing_mode,
        widget_position: s.widget_position, business_hours: s.business_hours,
        widget_template_id: s.widget_template_id || 'default',
        widget_theme: s.widget_theme || {},
        pre_call_form_schema: s.pre_call_form_schema || [],
        default_department_id: s.default_department_id ?? null,
        widget_default_locale: s.widget_default_locale ?? null,
        widget_enabled_locales: s.widget_enabled_locales ?? null,
        widget_custom_texts: s.widget_custom_texts ?? {},
        operator_video_visible_to_visitor: s.operator_video_visible_to_visitor !== false,
      };
      const res = await dashboard.put(`/api/call-center/settings?workspaceId=${WS}`, payload);
      expect(res.status, JSON.stringify(stored)).toBe(200);
      const row = db.call_center_settings[0];
      expect(row.display_name).toBe('Help desk');
      expect(row.business_hours).toEqual(stored.business_hours);
      expect(row).toMatchObject({ launcher_style: stored.launcher_style ?? 'round_label', callback_slots_enabled: stored.callback_slots_enabled ?? false });
      const after = await bootstrap();
      expect(after.config).toMatchObject({ widget_position: (before.config as Dict).widget_position, launcher_style: (before.config as Dict).launcher_style, display_name: 'Help desk' });
      expect((after.callback_policy as Dict).slots).toEqual((before.callback_policy as Dict).slots);
    }
  });

  it('the new dashboard on the 6f8af41 backend, its database without 277: the save carries only the keys that backend takes', async () => {
    const row = { ...settingsRow({ widget_position: 'bottom-left' }) };
    for (const k of ['launcher_style', 'callback_slots_enabled', 'callback_slot_minutes', 'callback_days_ahead', 'callback_slot_capacity']) delete row[k];
    const { status, sent } = await dashboardSave(async () => {
      fireEvent.change(screen.getByDisplayValue('Shop'), { target: { value: 'Help desk' } });
      await choose(document.querySelector<HTMLElement>('[data-call-position]')!, S.positionOptions.top_left);
    }, backend6f8af41(row));
    expect(status).toBe(200);
    expect(PUT_6F8AF41.safeParse(sent).success).toBe(true);
    expect(sent).toMatchObject({ display_name: 'Help desk', widget_position: 'top_left' });
    expect(sent).not.toHaveProperty('business_hours');
  });

  it('the new dashboard on the 6f8af41 backend after 277 was applied (WebYar\'s order): untouched design settings are not sent; a changed one is refused and the page says "try again in a few minutes"', async () => {
    const row = settingsRow({ widget_position: 'bottom-left' });
    const quiet = await dashboardSave(() => {
      fireEvent.change(screen.getByDisplayValue('Shop'), { target: { value: 'Help desk' } });
    }, backend6f8af41(row));
    expect(quiet.status).toBe(200);
    expect(PUT_6F8AF41.safeParse(quiet.sent).success).toBe(true);
    // The stored older spelling goes back as loaded (that backend's widget reads it).
    expect(quiet.sent.widget_position).toBe('bottom-left');
    cleanup();
    vi.unstubAllGlobals();

    const changed = await dashboardSave(() => {
      openTab(S.tabs.presentation);
      fireEvent.click(document.querySelector<HTMLButtonElement>('[data-call-launcher-style="card"]')!);
    }, backend6f8af41(row));
    expect(changed.status).toBe(400);
    expect(changed.sent.launcher_style).toBe('card');
    await waitFor(() => expect(h.toasts).toContainEqual(expect.objectContaining({ title: S.migrationPending, variant: 'destructive' })), { timeout: SLOW });
  });

  it('the new backend and dashboard on a database 277 has not reached yet (RESPOK\'s migrator runs beside them): no design key is loaded or sent, the save works, the widget wears the defaults', async () => {
    h.edition = 'international';
    const row = settingsRow({ widget_position: 'bottom-left' });
    for (const k of ['launcher_style', 'callback_slots_enabled', 'callback_slot_minutes', 'callback_days_ahead', 'callback_slot_capacity']) delete row[k];
    db.call_center_settings = [row];
    const { status, sent } = await dashboardSave(() => {
      fireEvent.change(screen.getByDisplayValue('Shop'), { target: { value: 'Help desk' } });
    });
    expect(status).toBe(200);
    for (const k of ['launcher_style', 'callback_slots_enabled', 'callback_slot_minutes', 'callback_days_ahead', 'callback_slot_capacity', 'business_hours']) expect(sent).not.toHaveProperty(k);
    // The placement goes back canonical (the new GET normalises it): what both widgets read the same way.
    expect(db.call_center_settings[0]).toMatchObject({ display_name: 'Help desk', widget_position: 'left' });
    const body = await bootstrap();
    expect(body.config).toMatchObject({ launcher_style: 'round_label', widget_position: 'left', logoDirection: 'thread' });
    expect((body.callback_policy as Dict).slots).toBeUndefined();
    const m = visit(body);
    expect(m.q('.ln-cl .ccw-launcher-btn')).not.toBeNull();
  });

  it('a bootstrap of the 6f8af41 server (its exact shape) in the new widget, in both editions', async () => {
    for (const edition of ['iran', 'international'] as const) {
      h.edition = edition;
      const intl = edition === 'international';
      // As the 6f8af41 router answers this row (captured from it): none of the design's fields.
      const old: Dict = {
        status: 'ok', assets_version: '438a4181fed3', edition, calendar: intl ? 'gregorian' : 'jalali', time_zone: intl ? null : 'Asia/Tehran',
        ...(intl ? {
          platform_brand: { names: { en: 'RESPOK' } },
          powered_by: { brand: 'RESPOK', brands: {}, url: null, logo: '/brand/intl/respok-thread-horizontal-color.svg' },
        } : { powered_by_logo: '/brand/webyar/webyar-logo-fa-color.svg' }),
        assets: {
          font_style_url: '/widget/presentation-default-fonts.css', presentation_registry_url: '/call-widget/presentation-registry.js',
          presentation_script_url: '/call-widget/presentation-default.js', presentation_style_url: intl ? '/call-widget/presentation-intl.css' : '/call-widget/presentation-default.css',
        },
        workspace_id: WS,
        config: {
          display_name: 'Shop', avatar_url: null, widget_position: 'bottom-left', widget_template_id: intl ? 'intl' : 'default', widget_theme: {},
          pre_call_form_enabled: false, pre_call_form_schema: [], offline_behavior: 'show_callback', recording_consent_required: false, custom_texts: {},
        },
        capabilities: { voice: true, video: true, callback: true, recording: false, operator_video_visible: true },
        callback_policy: { enabled: true, cooldown_seconds: 0, require_contact: false, min_message_length: 0, honeypot_enabled: true, min_form_seconds: 0 },
        queue_experience: { ringback_enabled: false, ringback_mode: 'off', ringback_music_url: null, ringback_announcement_audio_url: null, ringback_queue_audio_urls: {} },
        i18n: { default_locale: 'fa', available_locales: ['fa', 'en', 'tr'] },
        recording: { enabled_by_platform: false, enabled_by_plan: true, enabled_by_workspace: false, consent_required: false, provider_supported: true, provider_configured: false, effective_enabled: false, reason: 'platform_disabled' },
        provider_ready: true,
        departments: { voice: [], video: [], callback: [] },
        visitor: { id: 'ed49f2c8-c94b-49bc-a689-55a40108ca70', contact: null },
        active_call: null,
        session: signWidgetSession(CONFIG as never, { workspace_id: WS, public_key: 'cck_x', origin: ORIGIN }),
      };
      const m = visit(old, { locale: 'fa' });
      // The default launcher; a stored bottom-left at the left (E1; the 6f8af41 widget drew it on the right).
      expect(m.q('.ln-cl .ccw-launcher-btn')).not.toBeNull();
      expect([...launcherOf(m)!.classList].filter((c) => c !== 'ccw-launcher-wrap')).toEqual(['left']);
      expect(m.q('.ln-cl .ls.off')).toBeNull();
      expect(m.root.classList.contains('ccw-presentation-intl')).toBe(intl);
      if (intl) expect(m.root.classList.contains('lg-thread')).toBe(true);
      // The panel module and its stylesheet by their fixed names.
      m.open();
      expect(m.screenId()).toBe('home');
      expect(m.qa<HTMLLinkElement>('link[rel="stylesheet"]').map((l) => new URL(l.href).pathname)).toContain('/call-widget/presentation-default-panel.css');
      // No slots: the native picker.
      m.click('[data-action="callback"]');
      m.click('[data-action="seg"][data-field="callback_when"][data-value="later"]');
      expect(m.q('[data-screen="callback"] input[type="datetime-local"]')).not.toBeNull();
      closeCallWidgets();
    }
  });
});

describe('the logo the Super Admin uploaded (Super Admin → Branding): bootstrap → widget, both editions', () => {
  const KEY = 'platform/brand/0b7d6c00-0000-4000-8000-000000000002-logo-light.svg';
  const URL_OF_KEY = `https://cdn.example.test/${KEY}`;
  beforeEach(() => {
    db.app_runtime_config = db.app_runtime_config.map((row) => (row.key === 'default_storage_provider'
      ? { key: row.key, value: { provider: 'local', public_url: 'https://cdn.example.test' } }
      : row));
    db.platform_branding = [{ id: 'b1', logo_light_storage_key: KEY }];
    // What the upload route publishes: every process forgets the logo it showed.
    publishCacheInvalidation(['platform']);
  });
  afterEach(() => {
    db.platform_branding = [];
    publishCacheInvalidation(['platform']);
  });

  it.each(['iran', 'international'] as const)('%s: the credit is the upload, drawn as an image over the kit\'s art', async (edition) => {
    h.edition = edition;
    h.logoDirection = 'open';
    const body = await bootstrap();
    if (edition === 'iran') expect(body).toMatchObject({ powered_by_logo: URL_OF_KEY, powered_by_logo_custom: true });
    else expect(body.powered_by).toMatchObject({ logo: URL_OF_KEY, custom: true });
    const m = visit(body);
    m.open();
    expect(m.q('.scr.on .ccw-footer img.ccw-powered-logo')?.getAttribute('src')).toBe(URL_OF_KEY);
    expect(m.q('.scr.on .ccw-footer svg')).toBeNull();

    // Reset to the brand's default: the kit's own credit, as before.
    db.platform_branding = [{ id: 'b1', logo_light_storage_key: null }];
    publishCacheInvalidation(['platform']);
    const after = await bootstrap();
    expect(after).not.toHaveProperty('powered_by_logo_custom');
    if (edition === 'international') expect(after.powered_by).not.toHaveProperty('custom');
    const kit = visit(after);
    kit.open();
    expect(kit.q('.scr.on .ccw-footer img')).toBeNull();
    expect(kit.q('.scr.on .ccw-footer svg')).not.toBeNull();
  });

  it('iran: a workspace\'s own "powered by" words that name the brand stay words, never over the kit\'s art', async () => {
    h.edition = 'iran';
    const body = await bootstrap();
    expect(body).toMatchObject({ powered_by_logo: URL_OF_KEY, powered_by_logo_custom: true });
    const own = 'ساخته‌شده با وب‌یار';
    (body.config as Dict).custom_texts = { fa: { powered_by: own } };
    const m = visit(body);
    m.open();
    const credit = m.q('.scr.on .ccw-footer .ccw-powered');
    expect(credit?.textContent).toBe(own);
    expect(m.q('.scr.on .ccw-footer svg')).toBeNull();

    // Without an upload, the kit's own mark stands for the kit, as before.
    db.platform_branding = [{ id: 'b1', logo_light_storage_key: null }];
    publishCacheInvalidation(['platform']);
    const kitBody = await bootstrap();
    (kitBody.config as Dict).custom_texts = { fa: { powered_by: own } };
    const kit = visit(kitBody);
    kit.open();
    expect(kit.q('.scr.on .ccw-footer svg.wm')).not.toBeNull();
  });
});
