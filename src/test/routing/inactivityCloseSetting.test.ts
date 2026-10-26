// @vitest-environment node
/**
 * The inactivity close's settings (migration 284) through the real routes:
 *
 *   PATCH /api/widget-settings/:ws {inactivity_close_hours}
 *     1–48 or null (the platform's default), whole hours; anything else 400
 *     naming the field; whatever the plan; before 284 (42703) 409
 *     inactivity_close_migration_required, while a save without the key
 *     still works there;
 *   PATCH /api/widget-settings/platform/config {inactivity_close_enabled,
 *     inactivity_close_default_hours}
 *     the Super Admin's switch and default (1–48), the same 409 before 284;
 *     a save clears the ticker's and the panels' cached copy at once;
 *   GET /api/workspace-departments/:ws/routing-policy
 *     the effective switch and default for the panel (missing or before
 *     284: off, 24);
 *   PUT /api/widget-settings/:ws/prechat
 *     still takes history_continue_window_hours (retired), never writes it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from '../conversations/fakeServiceDb';

const WS = '77777777-7777-4777-8777-777777777777';
const PLATFORM = '88888888-8888-4888-8888-888888888888';
const state = vi.hoisted(() => ({ db: null as unknown as FakeServiceDb, published: [] as string[][] }));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'owner-1', role: 'owner' }),
  requirePlatformAdmin: async () => 'admin-1',
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
}));
vi.mock('../../../server/services/phoneVerification/index.js', () => ({ assertPhoneVerificationSatisfied: async () => {} }));
vi.mock('../../../server/services/widget/public.js', () => ({ invalidateWorkspaceOriginCache: () => {} }));
vi.mock('../../../server/lib/cacheBus.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/cacheBus.js')>()),
  publishCacheInvalidation: (scopes: string[]) => { state.published.push(scopes); },
}));
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => ({
  ...(await orig<object>()),
  // A plan that grants nothing, automatic routing included: the window is not plan gated.
  resolveWidgetEntitlements: async () => ({ features: { widget_assignment_routing: false, widget_prechat_form: true }, maxDomains: 1 }),
}));
vi.mock('../../../server/services/widget/prechatEffective.js', async (orig) => ({
  ...(await orig<object>()),
  prechatPolicyInputs: async () => ({ policy: {} }),
}));

const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');
const { workspaceDepartmentsRouter } = await import('../../../server/routes/workspaceDepartments.js');
const { loadInactivityCloseSettings, __resetInactivityCloseSettingsCache } = await import('../../../server/services/widget/platformSettings.js');

const config = { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' };
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
app.use(express.json());
app.use('/api/widget-settings', widgetSettingsRouter);
app.use('/api/workspace-departments', workspaceDepartmentsRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

type Answer = { status: number; body: Row & { issues?: Array<{ path: string }> } };
function call(method: 'GET' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolveReq, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const rq = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method,
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
const patchWorkspace = (body: unknown) => call('PATCH', `/api/widget-settings/${WS}`, body);
const patchPlatform = (body: Row) => call('PATCH', '/api/widget-settings/platform/config', { id: PLATFORM, ...body });
const policy = () => call('GET', `/api/workspace-departments/${WS}/routing-policy`);
const settings = () => state.db.tables.widget_settings![0];
const platform = () => state.db.tables.widget_platform_settings![0];

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.widget_settings = [{ id: 'row-1', workspace_id: WS, assignment_mode: 'manual', inactivity_close_hours: null }];
  state.db.tables.widget_platform_settings = [{ id: PLATFORM, inactivity_close_enabled: true, inactivity_close_default_hours: 24 }];
  state.db.tables.widget_prechat_settings = [{ workspace_id: WS, ask_name: true, history_continue_window_hours: 72 }];
  state.published = [];
  __resetInactivityCloseSettingsCache();
});

describe('PATCH /api/widget-settings/:ws: inactivity_close_hours', () => {
  it.each([[1], [24], [48], [null]])('stores %j, on a plan without automatic routing too', async (hours) => {
    const res = await patchWorkspace({ inactivity_close_hours: hours });
    expect(res.status).toBe(200);
    expect(settings().inactivity_close_hours).toBe(hours);
  });

  it.each([[0], [49], [24.5], ['24'], [true], [-1]])('refuses %j, naming the field', async (hours) => {
    const res = await patchWorkspace({ inactivity_close_hours: hours });
    expect(res.status).toBe(400);
    expect(res.body.issues?.map((i) => i.path)).toEqual(['inactivity_close_hours']);
    expect(settings().inactivity_close_hours).toBeNull();
  });

  it('before migration 284: 409 inactivity_close_migration_required; a save without the key still works', async () => {
    state.db.missingColumns = { widget_settings: ['inactivity_close_hours'] };
    const res = await patchWorkspace({ inactivity_close_hours: 12 });
    expect(res).toMatchObject({ status: 409, body: { error: 'inactivity_close_migration_required' } });
    const other = await patchWorkspace({ assignment_mode: 'manual' });
    expect(other.status).toBe(200);
  });
});

describe('PATCH /api/widget-settings/platform/config: the switch and the default', () => {
  it('takes them in bounds, refuses anything else, and clears the cached copy at once (here and on the bus)', async () => {
    expect(await loadInactivityCloseSettings(config as never)).toEqual({ enabled: true, defaultHours: 24 });
    const res = await patchPlatform({ inactivity_close_enabled: false, inactivity_close_default_hours: 6 });
    expect(res.status).toBe(200);
    expect(platform()).toMatchObject({ inactivity_close_enabled: false, inactivity_close_default_hours: 6, updated_by: 'admin-1' });
    expect(state.published).toContainEqual(['platform']);
    // No 60 s wait: the ticker and the panels read the new values now.
    expect(await loadInactivityCloseSettings(config as never)).toEqual({ enabled: false, defaultHours: 6 });
    for (const bad of [{ inactivity_close_default_hours: 0 }, { inactivity_close_default_hours: 49 }, { inactivity_close_default_hours: 2.5 },
      { inactivity_close_default_hours: null }, { inactivity_close_enabled: 'yes' }, { inactivity_close_enabled: null }]) {
      const r = await patchPlatform(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.issues?.map((i) => i.path), JSON.stringify(bad)).toEqual(Object.keys(bad));
    }
    expect(platform()).toMatchObject({ inactivity_close_enabled: false, inactivity_close_default_hours: 6 });
  });

  it('before migration 284: 409 inactivity_close_migration_required, the other settings still saved alone', async () => {
    state.db.missingColumns = { widget_platform_settings: ['inactivity_close_enabled', 'inactivity_close_default_hours'] };
    expect(await patchPlatform({ inactivity_close_enabled: true })).toMatchObject({ status: 409, body: { error: 'inactivity_close_migration_required' } });
    expect(await patchPlatform({ inactivity_close_default_hours: 12 })).toMatchObject({ status: 409 });
    expect((await patchPlatform({ powered_by_enabled: true })).status).toBe(200);
  });
});

describe('GET /api/workspace-departments/:ws/routing-policy: what the panel shows', () => {
  it('the stored switch and default; a missing or unreadable row (or before 284) reads off at 24 h', async () => {
    state.db.tables.widget_platform_settings = [{ id: PLATFORM, inactivity_close_enabled: true, inactivity_close_default_hours: 12 }];
    expect((await policy()).body.policy).toMatchObject({ inactivity_close_enabled: true, inactivity_close_default_hours: 12 });
    __resetInactivityCloseSettingsCache();
    state.db.tables.widget_platform_settings = [];
    expect((await policy()).body.policy).toMatchObject({ inactivity_close_enabled: false, inactivity_close_default_hours: 24 });
    __resetInactivityCloseSettingsCache();
    state.db.tables.widget_platform_settings = [{ id: PLATFORM }];
    expect((await policy()).body.policy).toMatchObject({ inactivity_close_enabled: false, inactivity_close_default_hours: 24 });
    __resetInactivityCloseSettingsCache();
    state.db.failing.add('widget_platform_settings');
    expect((await policy()).body.policy).toMatchObject({ inactivity_close_enabled: false, inactivity_close_default_hours: 24 });
    // An out-of-range stored default is read clamped.
    __resetInactivityCloseSettingsCache();
    state.db.failing.clear();
    state.db.tables.widget_platform_settings = [{ id: PLATFORM, inactivity_close_enabled: true, inactivity_close_default_hours: 400 }];
    expect((await policy()).body.policy).toMatchObject({ inactivity_close_enabled: true, inactivity_close_default_hours: 48 });
  });
});

describe('PUT /api/widget-settings/:ws/prechat: history_continue_window_hours is retired', () => {
  it('is still accepted, and never written', async () => {
    const res = await call('PUT', `/api/widget-settings/${WS}/prechat`, { history_continue_window_hours: 5, ask_name: false });
    expect(res.status).toBe(200);
    const writes = state.db.inserts.filter((i) => i.table === 'widget_prechat_settings').map((i) => i.row);
    for (const row of writes) expect(row).not.toHaveProperty('history_continue_window_hours');
    expect(state.db.tables.widget_prechat_settings!.find((r) => r.workspace_id === WS)).toMatchObject({ history_continue_window_hours: 72 });
  });
});
