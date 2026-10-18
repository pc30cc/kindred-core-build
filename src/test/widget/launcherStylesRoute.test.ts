/**
 * PATCH /api/widget-settings/:workspaceId for the launcher's styles (issue
 * #340, g5-1): `fab_shape` is writable (circle | square | pill), `fab_icon`
 * takes only the known icons (shared/launcherStyles.ts: never a free text
 * such as "constructor"), `fab_label` keeps its length cap; both style
 * columns sit under the plan capability widget_launcher_icon (the real
 * guard, server/services/widget/entitlements.ts), and a reset to the
 * default is always allowed.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS_ID = '55555555-5555-4555-8555-555555555555';
type Row = Record<string, unknown>;
let settingsRow: Row;
let features: Record<string, boolean>;

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        update: (patch: Row) => { if (table === 'widget_settings') Object.assign(settingsRow, patch); return b; },
        single: async () => ({ data: table === 'widget_settings' ? { ...settingsRow } : null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
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
  resolveWidgetEntitlements: async () => ({ features, maxDomains: 10 }),
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

function patch(body: unknown): Promise<{ status: number; body: { issues?: Array<{ path: string }>; denied?: string[] } }> {
  return new Promise((resolveReq, reject) => {
    const payload = JSON.stringify(body);
    const rq = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/widget-settings/${WS_ID}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolveReq({ status: res.statusCode || 0, body: d ? JSON.parse(d) : {} }); } catch (e) { reject(e); } });
    });
    rq.on('error', reject);
    rq.write(payload);
    rq.end();
  });
}

beforeEach(() => {
  settingsRow = { id: 'row-1', workspace_id: WS_ID, fab_shape: 'circle', fab_icon: 'chat', fab_label: null };
  features = {};
});

describe('PATCH: the launcher\'s style columns', () => {
  it.each([
    [{ fab_shape: 'pill', fab_label: 'سؤالی دارید؟ بپرسید' }],
    [{ fab_shape: 'square', fab_icon: 'chat' }],
    [{ fab_icon: 'bubble' }], [{ fab_icon: 'duo' }], [{ fab_icon: 'avatar' }], [{ fab_icon: 'headset' }],
    [{ fab_icon: null }],
  ])('saves %j', async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(200);
    expect(settingsRow).toMatchObject(body);
  });

  it.each([
    ['an unknown shape', { fab_shape: 'oval' }, 'fab_shape'],
    ['a shape of another type', { fab_shape: 1 }, 'fab_shape'],
    ['a free-text icon', { fab_icon: 'constructor' }, 'fab_icon'],
    ['a prototype key', { fab_icon: '__proto__' }, 'fab_icon'],
    ['an icon of the help button', { fab_icon: 'help_circle' }, 'fab_icon'],
    ['a pill text too long', { fab_label: 'x'.repeat(101) }, 'fab_label'],
  ])('refuses %s (400, naming the key, writing nothing)', async (_name, body, key) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(res.body.issues!.map((i) => i.path)).toContain(key);
    expect(settingsRow).toMatchObject({ fab_shape: 'circle', fab_icon: 'chat' });
  });

  it('a plan without widget_launcher_icon may not wear a style, but may go back to the chat circle', async () => {
    features = { widget_launcher_icon: false };
    for (const body of [{ fab_shape: 'pill' }, { fab_shape: 'square' }, { fab_icon: 'avatar' }]) {
      const res = await patch(body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body.denied).toEqual(['widget_launcher_icon']);
    }
    expect((await patch({ fab_shape: 'circle', fab_icon: 'chat' })).status).toBe(200);
  });
});
