/**
 * Widget → Availability on the server (server/routes/widgetSettings.ts):
 *
 *   - GET /:workspaceId/availability answers with the widget's own resolver
 *     (the "Now" card): business hours off with nobody available is offline,
 *     not "always online"; it counts the operators visitors may consider
 *     reachable; it says when the plan does not apply the hours;
 *   - PATCH refuses business hours the resolver would never match while
 *     they are on (an end before its start, a time that is not HH:mm, an
 *     unknown time zone; too many intervals a day at any time) with 400
 *     naming the field, never refuses turning them off, and stores a valid
 *     schedule with keys it does not read dropped;
 *   - the panel's caps: an availability label over 100 characters or an
 *     offline message over 2000 is refused (the fields carry the same caps);
 *   - a plan without widget_business_hours may not choose an offline
 *     behaviour other than the form (403), and may go back to it.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS_ID = '55555555-5555-4555-8555-555555555555';
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  settingsRow: {} as Record<string, unknown>,
  members: [] as Array<Record<string, unknown>>,
  prefs: [] as Array<Record<string, unknown>>,
  features: {} as Record<string, boolean>,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const rows = () => (table === 'widget_settings' ? [state.settingsRow] : table === 'workspace_members' ? state.members : table === 'user_availability_prefs' ? state.prefs : []);
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        in: () => b,
        is: () => b,
        update: (patch: Row) => { if (table === 'widget_settings') Object.assign(state.settingsRow, patch); return b; },
        single: async () => ({ data: table === 'widget_settings' ? { ...state.settingsRow } : null, error: null }),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(ok),
      };
      return b;
    },
  }),
}));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => ({ userId: 'owner-1' }),
  requirePlatformAdmin: async () => null,
}));
vi.mock('../../../server/services/phoneVerification/index.js', () => ({ assertPhoneVerificationSatisfied: async () => {} }));
vi.mock('../../../server/services/phoneVerification/types.js', () => ({ PhoneVerificationError: class extends Error {} }));
vi.mock('../../../server/services/widget/public.js', () => ({ invalidateWorkspaceOriginCache: () => {} }));
vi.mock('../../../server/lib/cacheBus.js', async (orig) => ({ ...(await orig<object>()), publishCacheInvalidation: () => {} }));
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => ({
  ...(await orig<object>()),
  resolveWidgetEntitlements: async () => ({ features: state.features, maxDomains: 10 }),
  widgetBusinessHoursAllowed: async () => state.features.widget_business_hours !== false,
}));

const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');
const app = express();
app.use((req, _res, next) => {
  Object.assign(req, { serverConfig: { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } });
  next();
});
app.use(express.json());
app.use('/api/widget-settings', widgetSettingsRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

type Answer = { status: number; body: Record<string, unknown> & { issues?: Array<{ path: string; message: string }>; denied?: string[] } };
function call(method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolveReq, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const rq = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/widget-settings/${WS_ID}${path}`, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolveReq({ status: res.statusCode || 0, body: d ? JSON.parse(d) : {} }); } catch (e) { reject(e); } });
    });
    rq.on('error', reject);
    if (payload) rq.write(payload);
    rq.end();
  });
}

const person = (user_id: string, over: Row = {}) => ({
  user_id, force_offline: false, available_when_using_app: true, schedule_enabled: false, timezone: 'UTC', weekly_schedule: null, ...over,
});

beforeEach(() => {
  state.settingsRow = {
    id: 'row-1', workspace_id: WS_ID, offline_mode: 'capture_message', live_chat_enabled: true,
    business_hours: { enabled: false, timezone: 'UTC' }, availability_labels: {}, offline_message_localized: {},
  };
  state.members = [{ user_id: 'a' }, { user_id: 'b' }];
  state.prefs = [person('a'), person('b', { force_offline: true })];
  state.features = {};
});

describe('GET /:workspaceId/availability (the "Now" card)', () => {
  it('hours off, an operator available: online, one of two reachable', async () => {
    const res = await call('GET', '/availability?locale=fa');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      state: 'online', reason: 'disabled', offline_mode: 'capture_message', business_hours_allowed: true,
      operators: { members: 2, available: 1 },
    });
    expect(typeof res.body.checked_at).toBe('string');
  });

  it('hours off and nobody available: offline (the offline behaviour applies), not "always online"', async () => {
    state.prefs = [person('a', { available_when_using_app: false }), person('b', { force_offline: true })];
    state.settingsRow.offline_mode = 'hide_widget';
    const res = await call('GET', '/availability');
    expect(res.body).toMatchObject({ state: 'offline', reason: 'no_operators_online', offline_mode: 'hide_widget', operators: { members: 2, available: 0 } });
  });

  it('a plan without business hours: the stored schedule is not applied, and it says so', async () => {
    state.features = { widget_business_hours: false };
    state.settingsRow.business_hours = { enabled: true, timezone: 'UTC', weekly: {} };
    state.settingsRow.offline_mode = 'show_offline_message';
    const res = await call('GET', '/availability');
    expect(res.body).toMatchObject({ state: 'online', reason: 'disabled', offline_mode: 'capture_message', business_hours_allowed: false });
  });
});

describe('PATCH business_hours', () => {
  const hours = (over: Row = {}) => ({ enabled: true, timezone: 'Asia/Tehran', weekly: { sat: [{ from: '09:00', to: '17:00' }] }, overrides: [], ...over });

  it('stores a valid schedule (special-day intervals included), dropping keys the resolver does not read', async () => {
    const res = await call('PATCH', '', {
      business_hours: {
        ...hours(),
        schedule: [],
        overrides: [{ date: '2026-10-29', closed: false, intervals: [{ from: '10:00', to: '13:00' }], label: 'Half day', note: 'x' }],
      },
    });
    expect(res.status).toBe(200);
    expect(state.settingsRow.business_hours).toEqual({
      ...hours(),
      overrides: [{ date: '2026-10-29', closed: false, intervals: [{ from: '10:00', to: '13:00' }], label: 'Half day' }],
    });
  });

  it.each([
    ['an end before its start (overnight)', hours({ weekly: { mon: [{ from: '22:00', to: '02:00' }] } }), 'business_hours.weekly.mon.0', 'interval_end_before_start'],
    ['an empty interval', hours({ weekly: { mon: [{ from: '09:00', to: '09:00' }] } }), 'business_hours.weekly.mon.0', 'interval_end_before_start'],
    ['a time that is not HH:mm', hours({ weekly: { mon: [{ from: '9am', to: '17:00' }] } }), 'business_hours.weekly.mon.0', 'invalid_time'],
    ['an override interval the wrong way round', hours({ overrides: [{ date: '2026-10-29', intervals: [{ from: '18:00', to: '10:00' }] }] }), 'business_hours.overrides.0.intervals.0', 'interval_end_before_start'],
    ['an unknown time zone', hours({ timezone: 'Mars/Olympus' }), 'business_hours.timezone', 'invalid_timezone'],
    ['a bad override date', hours({ overrides: [{ date: '29/10/2026', closed: true }] }), 'business_hours.overrides.0.date', undefined],
  ])('refuses %s (400, naming the field, writing nothing)', async (_name, business_hours, path, message) => {
    const before = JSON.stringify(state.settingsRow.business_hours);
    const res = await call('PATCH', '', { business_hours });
    expect(res.status).toBe(400);
    const issue = res.body.issues!.find((i) => i.path === path);
    expect(issue, JSON.stringify(res.body.issues)).toBeTruthy();
    if (message) expect(issue!.message).toBe(message);
    expect(JSON.stringify(state.settingsRow.business_hours)).toBe(before);
  });

  it('hours that are off apply to nothing: turning them off is never refused for what they hold', async () => {
    const res = await call('PATCH', '', {
      business_hours: hours({ enabled: false, timezone: 'Mars/Olympus', weekly: { mon: [{ from: '22:00', to: '02:00' }] } }),
    });
    expect(res.status).toBe(200);
    expect(state.settingsRow.business_hours).toMatchObject({ enabled: false, weekly: { mon: [{ from: '22:00', to: '02:00' }] } });
  });

  it('refuses a seventh interval a day', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` }));
    expect((await call('PATCH', '', { business_hours: hours({ weekly: { mon: seven } }) })).status).toBe(400);
    expect((await call('PATCH', '', { business_hours: hours({ weekly: { mon: seven.slice(0, 6) } }) })).status).toBe(200);
  });
});

describe('PATCH availability copy and offline mode', () => {
  it('caps a label at 100 characters and an offline message at 2000', async () => {
    expect((await call('PATCH', '', { availability_labels: { fa: { online: 'x'.repeat(100) } } })).status).toBe(200);
    const label = await call('PATCH', '', { availability_labels: { fa: { online: 'x'.repeat(101) } } });
    expect(label.status).toBe(400);
    expect(label.body.issues!.map((i) => i.path)).toContain('availability_labels.fa.online');
    expect((await call('PATCH', '', { offline_message_localized: { fa: 'x'.repeat(2000) } })).status).toBe(200);
    expect((await call('PATCH', '', { offline_message_localized: { fa: 'x'.repeat(2001) } })).status).toBe(400);
  });

  it('each offline mode the panel offers is accepted', async () => {
    for (const offline_mode of ['hide_widget', 'show_offline_message', 'capture_message']) {
      expect((await call('PATCH', '', { offline_mode })).status, offline_mode).toBe(200);
      expect(state.settingsRow.offline_mode).toBe(offline_mode);
    }
  });

  it('a plan without widget_business_hours: only the form', async () => {
    state.features = { widget_business_hours: false };
    for (const offline_mode of ['hide_widget', 'show_offline_message']) {
      const res = await call('PATCH', '', { offline_mode });
      expect(res.status, offline_mode).toBe(403);
      expect(res.body.denied).toEqual(['widget_business_hours']);
    }
    expect((await call('PATCH', '', { offline_mode: 'capture_message' })).status).toBe(200);
  });
});
