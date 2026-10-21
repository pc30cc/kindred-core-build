// @vitest-environment node
/**
 * The workspace panel's pre-chat save and the policy it is shown
 * (server/routes/widgetSettings.ts):
 *
 *   PUT /api/widget-settings/:workspaceId/prechat stores the WHOLE row, each
 *   field required only while asked (V-01): turning a field off can no longer
 *   leave its "required" on, and a first save never takes the table's
 *   defaults (name and email required) for what it leaves out. A field the
 *   Super Admin locked keeps the workspace's own choice (the lock applies
 *   when the form is served, shared/prechatPolicy.ts).
 *
 *   GET /api/widget-settings/platform/public carries the pre-chat policy, so
 *   an owner (not a platform admin) sees the locks (S-02).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  prechat: null as Row | null,
  upserts: [] as Row[],
  platform: {} as Row,
  policy: null as unknown,
  planAllowsForm: true,
}));

function builder(table: string) {
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    limit: () => b,
    upsert: (row: Row) => {
      state.upserts.push(row);
      state.prechat = { ...(state.prechat || {}), ...row };
      return b;
    },
    single: async () => ({ data: table === 'widget_prechat_settings' ? { ...state.prechat } : { ...state.platform }, error: null }),
    maybeSingle: async () => ({
      data: table === 'widget_prechat_settings' ? (state.prechat ? { ...state.prechat } : null) : { ...state.platform },
      error: null,
    }),
  };
  return b;
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => ({ from: (t: string) => builder(t) }) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'owner-1' }),
  requirePlatformAdmin: async () => null,
}));
vi.mock('../../../server/services/phoneVerification/index.js', () => ({ assertPhoneVerificationSatisfied: async () => {} }));
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/entitlements.js')>()),
  resolveWidgetEntitlements: async () => ({ features: { widget_prechat_form: state.planAllowsForm }, maxDomains: 1 }),
}));
vi.mock('../../../server/services/widget/configSnapshot.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/configSnapshot.js')>()),
  getWidgetPlatformSnapshot: async () => ({ preChatPolicy: state.policy }),
  getWorkspaceWidgetSnapshot: async () => ({ entitlements: { features: { widget_prechat_form: state.planAllowsForm }, maxDomains: 1 } }),
}));

const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } }); next(); });
app.use(express.json());
app.use('/api/widget-settings', widgetSettingsRouter);
const server = http.createServer(app).listen(0);

const WS = '55555555-5555-4555-8555-555555555555';
function request(method: string, path: string, body?: unknown): Promise<{ status: number; body: Row }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = payload !== undefined
      ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {};
    const req = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
const put = (body: Row) => request('PUT', `/api/widget-settings/${WS}/prechat`, body);

beforeEach(() => {
  state.prechat = null;
  state.upserts.length = 0;
  state.platform = { id: 'p1', prechat_name_policy: 'default_on', prechat_email_policy: 'force_on', prechat_phone_policy: 'force_off' };
  state.policy = { name: 'default_on', email: 'default_on', phone: 'default_off' };
  state.planAllowsForm = true;
});

describe('PUT /api/widget-settings/:workspaceId/prechat', () => {
  it('a first save turning the name off stores the whole row: the name neither asked nor required, the rest as the visitor had it', async () => {
    const res = await put({ ask_name: false });
    expect(res.status).toBe(200);
    expect(state.upserts).toEqual([{
      workspace_id: WS,
      ask_name: false, require_name: false,
      ask_email: true, require_email: true,
      ask_phone: false, require_phone: false,
      verify_email: false, verify_phone: false,
      prechat_timing: 'after_handoff',
    }]);
  });

  it('turning a field off on a stored row clears its "required"; "required" without "asked" is never stored', async () => {
    state.prechat = { workspace_id: WS, ask_name: true, require_name: true, ask_email: true, require_email: true, ask_phone: true, require_phone: true, prechat_timing: 'always' };
    await put({ ask_phone: false });
    expect(state.prechat).toMatchObject({ ask_phone: false, require_phone: false, ask_name: true, require_name: true, prechat_timing: 'always' });
    await put({ require_email: true, ask_email: false });
    expect(state.prechat).toMatchObject({ ask_email: false, require_email: false });
  });

  it('a field the Super Admin locked keeps the workspace\'s own choice (the lock is applied when the form is served)', async () => {
    state.policy = { name: 'default_on', email: 'force_on', phone: 'force_off' };
    state.prechat = { workspace_id: WS, ask_name: true, require_name: true, ask_email: false, require_email: false, ask_phone: false, require_phone: false };
    await put({ ask_phone: true, require_phone: true, ask_email: true, prechat_timing: 'never' });
    expect(state.prechat).toMatchObject({ ask_phone: false, require_phone: false, ask_email: false, require_email: false, prechat_timing: 'never' });
  });

  it('a plan without the pre-chat form still refuses the save (403)', async () => {
    state.planAllowsForm = false;
    expect(await put({ ask_name: false })).toMatchObject({ status: 403, body: { error: 'plan_upgrade_required' } });
    expect(state.upserts).toEqual([]);
  });
});

describe('GET /api/widget-settings/platform/public', () => {
  it('carries the three pre-chat policies', async () => {
    const res = await request('GET', '/api/widget-settings/platform/public');
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ prechat_name_policy: 'default_on', prechat_email_policy: 'force_on', prechat_phone_policy: 'force_off' });
  });
});
