/**
 * Database round trips of GET /api/call-widget/bootstrap per page view, on the
 * real router with an in-memory client that logs every PostgREST call
 * (from()/rpc(), ./fakeDb.ts).
 *
 * The bootstrap runs on every page view of every site that embeds the call
 * widget. It used to cost 13-19 sequential queries each time (14 with an
 * UPDATE for an identified visitor). Now:
 *  - the workspace-level part is one memo per workspace per 30 s per process
 *    (server/services/callCenter/bootstrapCache.ts);
 *  - a visitor seen under a minute ago on the same network carries a signed
 *    presence ticket (server/services/callCenter/presenceTicket.ts): no
 *    visitor query, or one primary-key read of the contact to pre-fill;
 *  - a visitor id minted on this request skips the contact and call lookups;
 *  - a page view never creates the workspace's settings row.
 */
import { afterAll, describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { db, log, resetLog, fakeClient } from './fakeDb';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: async () => {} }));

const WS = '22222222-2222-4222-8222-222222222222';
const WS_WITHOUT_ROW = '33333333-3333-4333-8333-333333333333';
const ORIGIN = 'https://shop.example';
db.platform_call_center_settings = [{ singleton: true, call_center_enabled: true, voice_calls_enabled: true, video_calls_enabled: true, callback_requests_enabled: true, call_recording_enabled: true, departments_enabled: false, ringback_enabled: true, ringback_mode: 'music', ringback_music_path: 'platform/ringback/m.mp3', ringback_announcement_audio_path: null, ringback_queue_audio_paths: {}, widget_default_locale: 'fa', widget_available_locales: ['fa', 'en'], disabled_message: {} }];
db.call_center_settings = [{ id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'], widget_position: 'right', widget_theme: {}, display_name: 'Shop', avatar_url: null, avatar_storage_path: null, voice_enabled: true, video_enabled: true, callback_enabled: true, recording_enabled: true, pre_call_form_enabled: true, pre_call_form_schema: [], offline_behavior: 'show_callback', departments_enabled: false, allow_visitor_department_choice: false, widget_custom_texts: {}, recording_consent_required: false, operator_video_visible_to_visitor: true, widget_template_id: null }];
db.app_runtime_config = [
  { key: 'call_control_plane', value: { enabled: true, primary_provider: 'livekit' } },
  { key: 'call_livekit_config', value: { enabled: true, api_key: 'k', api_secret: 's', rtc_url: 'wss://lk.example', egress_enabled: false } },
  { key: 'default_storage_provider', value: { provider: 'local' } },
];
db.platform_settings = [{ region_mode: 'iran' }];

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const app = express();
app.use((req, _res, next) => { (req as unknown as { serverConfig: object }).serverConfig = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' }; next(); });
app.use(cookieParser());
app.use('/api/call-widget', callWidgetRouter);
const server = http.createServer(app).listen(0);
afterAll(() => { server.close(); });

type Contact = { id: string; name: string | null; email: string | null; phone: string | null };
/** The fields of a bootstrap answer these tests read. */
type BootstrapBody = {
  status?: string;
  reason?: string;
  error?: string;
  visitor: { id: string; contact: Contact | null };
  assets: Record<string, unknown>;
  config: Record<string, unknown>;
  active_call: unknown;
  workspace_id?: string;
};

let jar: Record<string, string> = {};
let lastSetCookies: string[] = [];
function boot(query = `workspaceId=${WS}`, ip = '203.0.113.7'): Promise<{ status: number; body: BootstrapBody }> {
  return new Promise((resolve, reject) => {
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    const req = http.request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/call-widget/bootstrap?${query}`, method: 'GET', headers: { origin: ORIGIN, cookie, 'x-forwarded-for': ip } }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => {
        lastSetCookies = ([] as string[]).concat(res.headers['set-cookie'] || []);
        for (const sc of lastSetCookies) {
          const [kv, ...attrs] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1);
          if (/max-age=0/i.test(attrs.join(';')) || v === '') delete jar[k]; else jar[k] = v;
        }
        resolve({ status: res.statusCode || 0, body: JSON.parse(d) });
      });
    });
    req.on('error', reject); req.end();
  });
}
/** One page view: its status, body and every database call it made. */
async function pageView(query?: string) {
  resetLog();
  const r = await boot(query);
  await new Promise((done) => setTimeout(done, 30)); // fire-and-forget work
  const ops = [...log];
  return { ...r, ops, writes: ops.filter((o) => !o.startsWith('select')) };
}

describe('call widget bootstrap: database work per page view', () => {
  const base = Date.now();
  afterAll(() => { vi.useRealTimers(); });

  it('a new visitor: no contact or call lookup, and a presence ticket for the next page views', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(base);
    const first = await pageView();
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('ok');
    expect(first.ops.filter((o) => /contacts|call_sessions/.test(o))).toEqual([]);
    const ticket = lastSetCookies.find((c) => c.startsWith('dvccp='));
    expect(ticket).toMatch(/; Path=\/api\/call-widget\/bootstrap; HttpOnly; Max-Age=60; /);
  });

  it('the same visitor\'s next page views inside the minute touch no table at all', async () => {
    vi.setSystemTime(base + 10_000);
    expect((await pageView()).ops).toEqual([]);
    vi.setSystemTime(base + 20_000);
    expect((await pageView()).ops).toEqual([]);
    // The memo is keyed by the workspace only: another loader origin (a
    // query parameter anyone can vary) or the id in upper case is the same
    // entry, and the URLs that carry the origin are built per request.
    const other = await pageView(`workspaceId=${WS.toUpperCase()}&loader_origin=${encodeURIComponent('https://cdn.example')}`);
    expect(other.ops).toEqual([]);
    expect(other.body.workspace_id).toBe(WS);
  });

  it('after the minute, the full pass still keeps the Online Visitors row fresh', async () => {
    vi.setSystemTime(base + 85_000);
    const touch = await pageView();
    expect(touch.writes).toEqual(expect.arrayContaining(['update visitor_sessions', 'update visitor_presence']));
    // A known visitor's calls are looked up on the full pass (resume after navigation).
    expect(touch.ops).toContain('select call_sessions');
  });

  it('an identified visitor costs one primary-key read of the contact to pre-fill', async () => {
    db.contacts = [{ id: 'c1', workspace_id: WS, name: 'Ali', email: 'a@x.ir', phone: null, metadata: {} }];
    (db.visitor_sessions || []).forEach((s) => { s.contact_id = 'c1'; });
    vi.setSystemTime(base + 150_000); // ticket and memo expired: full pass, the contact found
    const full = await pageView();
    expect(full.body.visitor.contact?.id).toBe('c1');
    vi.setSystemTime(base + 160_000);
    const repeat = await pageView();
    expect(repeat.ops).toEqual(['select contacts']);
    expect(repeat.body.visitor.contact).toEqual({ id: 'c1', name: 'Ali', email: 'a@x.ir', phone: null });
  });

  it('a browser without third-party cookies: no contact or call lookup for its fresh visitor id', async () => {
    jar = {};
    vi.setSystemTime(base + 165_000);
    const cookieless = await pageView();
    expect(cookieless.body.status).toBe('ok');
    expect(cookieless.ops.filter((o) => /contacts|call_sessions/.test(o))).toEqual([]);
  });

  it('a page view never creates the settings row, and a malformed id costs no query', async () => {
    const noRow = await pageView(`workspaceId=${WS_WITHOUT_ROW}`);
    expect(noRow.body).toEqual({ status: 'disabled', reason: 'workspace_disabled', message: null });
    expect(noRow.ops.filter((o) => o.includes('call_center_settings') && !o.startsWith('select'))).toEqual([]);
    expect(db.call_center_settings.some((r) => r.workspace_id === WS_WITHOUT_ROW)).toBe(false);
    for (const query of ['workspaceId=not-a-uuid', 'publicKey=x', `publicKey=${encodeURIComponent('cck_<script>')}`, '']) {
      const bad = await pageView(query);
      expect(bad.status, query).toBe(404);
      expect(bad.body).toEqual({ error: 'workspace_not_found' });
      expect(bad.ops, query).toEqual([]);
    }
  });

  it('answers the same fields as before (the response contract the runtime reads)', async () => {
    jar = {};
    const { body } = await pageView();
    expect(Object.keys(body).sort()).toEqual([
      'active_call', 'assets', 'assets_version', 'calendar', 'callback_policy', 'capabilities', 'config',
      'departments', 'edition', 'i18n', 'powered_by_logo', 'provider_ready', 'queue_experience', 'recording',
      'session', 'status', 'time_zone', 'visitor', 'workspace_id',
    ]);
    expect(Object.keys(body.assets).sort()).toEqual(['font_style_url', 'presentation_registry_url', 'presentation_script_url', 'presentation_style_url']);
    expect(Object.keys(body.config).sort()).toEqual([
      'avatar_url', 'custom_texts', 'display_name', 'offline_behavior', 'pre_call_form_enabled', 'pre_call_form_schema',
      'recording_consent_required', 'widget_position', 'widget_template_id', 'widget_theme',
    ]);
    expect(body.config.widget_template_id).toBe('default');
    expect(body.visitor).toEqual({ id: expect.any(String), contact: null });
    expect(body.active_call).toBeNull();
  });
});
