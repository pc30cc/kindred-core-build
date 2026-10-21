/**
 * Widget → Appearance on the server (server/routes/widgetSettings.ts):
 *
 *   - PATCH stores a colour only as #RRGGBB, upper-case, or null ("Brand
 *     colour"); the seeded #3B82F6 is stored as null, the colour the widget
 *     reads it as (W-10); "red", "#12" and the like are refused with 400
 *     naming the field (W-14);
 *   - the widget's language is 'auto' or one language; the legacy logo link
 *     can only be cleared (W-16);
 *   - a launcher image is refused (403) without the launcher style's
 *     capability, as the icon is (W-13);
 *   - GET /:workspaceId/welcome says what visitors read while the welcome is
 *     empty and whether the AI agent greets instead (W-07).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const WS_ID = '66666666-6666-4666-8666-666666666666';
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  settingsRow: {} as Record<string, unknown>,
  features: {} as Record<string, boolean>,
  platformWelcome: null as string | null,
  aiGreets: false,
  uploads: 0,
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        update: (patch: Row) => { if (table === 'widget_settings') Object.assign(state.settingsRow, patch); return b; },
        single: async () => ({ data: table === 'widget_settings' ? { ...state.settingsRow } : null, error: null }),
        maybeSingle: async () => ({ data: table === 'widget_settings' ? { ...state.settingsRow } : null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
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
vi.mock('../../../server/services/storage/index.js', () => ({
  uploadForOwner: async () => { state.uploads += 1; return { ok: true, key: 'k' }; },
  deleteForOwner: async () => ({ ok: true }),
}));
vi.mock('../../../server/services/widget/entitlements.js', async (orig) => ({
  ...(await orig<object>()),
  resolveWidgetEntitlements: async () => ({ features: state.features, maxDomains: 10 }),
}));
vi.mock('../../../server/services/widget/configSnapshot.js', async (orig) => ({
  ...(await orig<object>()),
  getWidgetPlatformSnapshot: async () => ({ widget: { default_welcome_message: state.platformWelcome } }),
  getWorkspaceWidgetSnapshot: async () => ({ aiAgent: { suppressGreeting: state.aiGreets } }),
}));

const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');
const app = express();
app.use((req, _res, next) => {
  Object.assign(req, { serverConfig: { supabaseUrl: 'x', supabaseAnonKey: 'y', supabaseServiceRoleKey: 'z' } });
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use('/api/widget-settings', widgetSettingsRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

type Answer = { status: number; body: Record<string, unknown> & { issues?: Array<{ path: string; message: string }>; denied?: string[] } };
function call(method: 'GET' | 'PATCH' | 'POST', path: string, body?: unknown): Promise<Answer> {
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

beforeEach(() => {
  state.settingsRow = { id: 'row-1', workspace_id: WS_ID, primary_color: '#112233', widget_language: 'auto', logo_url: 'https://cdn.example/l.png' };
  state.features = {};
  state.platformWelcome = null;
  state.aiGreets = false;
  state.uploads = 0;
});

describe('PATCH primary_color', () => {
  it('a colour is stored #RRGGBB, upper-case; null is "Brand colour"', async () => {
    expect((await call('PATCH', '', { primary_color: '#0ea5e9' })).status).toBe(200);
    expect(state.settingsRow.primary_color).toBe('#0EA5E9');
    expect((await call('PATCH', '', { primary_color: ' #10B981 ' })).status).toBe(200);
    expect(state.settingsRow.primary_color).toBe('#10B981');
    expect((await call('PATCH', '', { primary_color: null })).status).toBe(200);
    expect(state.settingsRow.primary_color).toBeNull();
  });

  it('the seeded #3B82F6 is stored as null, what the widget reads it as', async () => {
    for (const seed of ['#3B82F6', '#3b82f6']) {
      state.settingsRow.primary_color = '#112233';
      expect((await call('PATCH', '', { primary_color: seed })).status).toBe(200);
      expect(state.settingsRow.primary_color, seed).toBeNull();
    }
  });

  it('anything else is refused, naming the field, and nothing is stored', async () => {
    for (const bad of ['red', '#12', '#12345', '#1234567', '12AB3C', 'red;background:url(x)', '']) {
      const res = await call('PATCH', '', { primary_color: bad });
      expect(res.status, bad).toBe(400);
      expect(res.body.issues?.[0]?.path, bad).toBe('primary_color');
    }
    expect(state.settingsRow.primary_color).toBe('#112233');
  });
});

describe('PATCH widget_language and logo_url', () => {
  it('the language: auto or one language', async () => {
    expect((await call('PATCH', '', { widget_language: 'fa' })).status).toBe(200);
    expect(state.settingsRow.widget_language).toBe('fa');
    expect((await call('PATCH', '', { widget_language: 'auto', locale: 'en' })).status).toBe(200);
    expect(state.settingsRow.widget_language).toBe('auto');
    expect((await call('PATCH', '', { widget_language: 'english' })).status).toBe(400);
  });

  it('the legacy logo link can only be cleared', async () => {
    expect((await call('PATCH', '', { logo_url: 'https://evil.example/x.png' })).status).toBe(400);
    expect(state.settingsRow.logo_url).toBe('https://cdn.example/l.png');
    expect((await call('PATCH', '', { logo_url: null })).status).toBe(200);
    expect(state.settingsRow.logo_url).toBeNull();
  });
});

describe('POST /:workspaceId/fab-image', () => {
  const png = { contentType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), fileName: 'fab.png' };

  it('without the launcher style\'s capability: 403, nothing uploaded', async () => {
    state.features = { widget_launcher_icon: false };
    const res = await call('POST', '/fab-image', png);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'plan_upgrade_required', denied: ['widget_launcher_icon'] });
    expect(state.uploads).toBe(0);
  });
});

describe('GET /:workspaceId/welcome', () => {
  it('the platform\'s default when it wrote one; else the built-in one in the language asked', async () => {
    state.platformWelcome = 'به فروشگاه ما خوش آمدید';
    expect((await call('GET', '/welcome?locale=fa')).body).toEqual({ default_text: 'به فروشگاه ما خوش آمدید', ai_greeting: false });
    state.platformWelcome = 'Hello! How can we help you?';
    expect((await call('GET', '/welcome?locale=tr')).body.default_text).toBe('Merhaba! Size nasıl yardımcı olabiliriz?');
    state.platformWelcome = null;
    expect((await call('GET', '/welcome?locale=xx')).body.default_text).toBe('Hello! How can we help you?');
  });

  it('says when the AI agent greets first', async () => {
    state.aiGreets = true;
    expect((await call('GET', '/welcome?locale=en')).body.ai_greeting).toBe(true);
  });
});
