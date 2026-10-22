// @vitest-environment node
/**
 * The workspace's visitor privacy settings (P-01, migration 281) through
 * server/routes/widgetSettings.ts:
 *
 *   - PATCH takes "wait for consent", "keep query strings" and the retention
 *     period (30..1095 days, or null for the platform's), whatever the plan;
 *     a period out of range is refused, naming the field;
 *   - GET also says the platform's period (data_retention_policies), which
 *     the panel offers as "the default"; null when it cannot be read.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS_ID = '77777777-7777-4777-8777-777777777777';
type Row = Record<string, unknown>;
let settingsRow: Row;
let policy: { data: Row | null; error: { message: string } | null };

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        update: (patch: Row) => { if (table === 'widget_settings') Object.assign(settingsRow, patch); return b; },
        single: async () => ({ data: table === 'widget_settings' ? { ...settingsRow } : null, error: null }),
        maybeSingle: async () => (table === 'data_retention_policies' ? policy : { data: null, error: null }),
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
  // A plan that grants nothing: the privacy settings are not plan gated.
  resolveWidgetEntitlements: async () => ({ features: {}, maxDomains: 1 }),
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

function call(method: 'GET' | 'PATCH', body?: unknown): Promise<{ status: number; body: Row & { issues?: Array<{ path: string }> } }> {
  return new Promise((resolveReq, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const rq = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/widget-settings/${WS_ID}`, method,
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

beforeEach(() => {
  settingsRow = { id: 'row-1', workspace_id: WS_ID, tracking_requires_consent: false, tracking_keep_query: false, visitor_data_retention_days: null };
  policy = { data: { hot_retention_days: 395, enabled: true }, error: null };
});

describe('PATCH: visitor privacy', () => {
  it.each([
    [{ tracking_requires_consent: true }],
    [{ tracking_keep_query: true }],
    [{ visitor_data_retention_days: 30 }],
    [{ visitor_data_retention_days: 1095 }],
    [{ visitor_data_retention_days: null }],
  ])('saves %j whatever the plan', async (body) => {
    const res = await call('PATCH', body);
    expect(res.status).toBe(200);
    expect(settingsRow).toMatchObject(body);
  });

  it.each([[29], [1096], [90.5], ['90']])('refuses a period of %j, naming the field', async (days) => {
    const res = await call('PATCH', { visitor_data_retention_days: days });
    expect(res.status).toBe(400);
    expect(res.body.issues?.map((i) => i.path)).toEqual(['visitor_data_retention_days']);
    expect(settingsRow.visitor_data_retention_days).toBeNull();
  });
});

describe('GET: the platform\'s period', () => {
  it('is said beside the settings; null when it cannot be read', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect(res.body.visitor_retention).toEqual({ default_days: 395, enabled: true });
    policy = { data: null, error: { message: 'relation does not exist' } };
    expect((await call('GET')).body.visitor_retention).toBeNull();
    policy = { data: null, error: null };
    expect((await call('GET')).body.visitor_retention).toBeNull();
  });
});
