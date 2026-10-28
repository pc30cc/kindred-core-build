/**
 * The page a call-widget visitor sends (`page_url`): POST /calls/request and
 * POST /callbacks/request take it from the request body, which the visitor
 * writes, and the Call Center links to it. The server keeps it only as an
 * http(s) address on the request's Origin, the site the widget runs on (same
 * scheme and host, shared/callCenter/visitorPageUrl.ts); anything else is
 * stored as null, and the call or callback goes ahead.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, fakeClient } from './fakeDb';
import { startTestServer } from './callWidgetHttp';
import { httpPageUrl, pageLinkLabel, visitorPageUrl } from '../../../shared/callCenter/visitorPageUrl';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: async () => {} }));
vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({
  loadEffectiveCallEntitlements: async () => ({ callbacks_enabled: true, visitor_voice_enabled: true, visitor_video_enabled: true }),
}));
vi.mock('../../../server/services/callCenter/realtime.js', () => ({ publishQueueEvent: async () => {}, publishCallEvent: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyCallbackRequest: async () => {} }));
// What /calls/request asks beyond the page: a provider, the plan's ceilings, recording, routing.
vi.mock('../../../server/services/calls/providerResolver.js', () => ({ resolveEffectiveCallProvider: async () => ({ id: 'livekit' }) }));
vi.mock('../../../server/services/calls/concurrencyLimit.js', () => ({
  checkPlanConcurrencyCeiling: async () => ({ allowed: true }),
  planConcurrencyDenialBody: () => ({}),
}));
vi.mock('../../../server/services/calls/monthlyMinutesLimit.js', () => ({
  checkPlanMonthlyMinutesCeiling: async () => ({ allowed: true }),
  planMinutesDenialBody: () => ({}),
}));
vi.mock('../../../server/services/callCenter/recording.js', () => ({
  computeRecordingCapability: async () => ({ effective_enabled: false, consent_required: false, provider_supported: false, provider_configured: false }),
}));
vi.mock('../../../server/services/callCenter/routing.js', () => ({ routeIncomingCall: async () => {} }));

const WS = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://shop.example';
const LEGIT = 'https://shop.example/checkout?step=2#pay';
/** What a visitor can send as the page; none of it may be stored. */
const HOSTILE = [
  '/\\evil.example',
  '/\\t/evil.example',
  '/\t/evil.example',
  '//evil.example',
  'https://evil.example',
  'javascript:alert(1)',
  'x',
  'https://shop.example.evil.example/checkout',
  'https://evil.example/?shop.example',
  'http://shop.example/checkout',
  'https://shop.example:8443/checkout',
];

describe('visitorPageUrl (the rule)', () => {
  it('keeps an http(s) address on the same scheme and host', () => {
    expect(visitorPageUrl(LEGIT, ORIGIN)?.href).toBe(LEGIT);
    expect(visitorPageUrl('https://shop.example/', ORIGIN)?.href).toBe('https://shop.example/');
    expect(visitorPageUrl('http://localhost:5173/p', 'http://localhost:5173')?.href).toBe('http://localhost:5173/p');
    // Normalized as a browser would: the address that was checked is the one stored.
    expect(visitorPageUrl('https://SHOP.example/a b', ORIGIN)?.href).toBe('https://shop.example/a%20b');
    // No user name or password is kept: `shop.example@` must not read as the shop.
    expect(visitorPageUrl('https://user:pw@shop.example/a', ORIGIN)?.href).toBe('https://shop.example/a');
    expect(visitorPageUrl('https://shop.example@evil.example/x', 'https://evil.example')?.href).toBe('https://evil.example/x');
  });

  it('pageLinkLabel reads the real host, whatever the address says before it', () => {
    expect(pageLinkLabel(visitorPageUrl(LEGIT, ORIGIN)!)).toBe('shop.example');
    expect(pageLinkLabel(httpPageUrl('https://shop.example:pw@evil.example:8443/shop.example')!)).toBe('evil.example');
  });

  it.each(HOSTILE)('drops %j', (raw) => {
    expect(visitorPageUrl(raw, ORIGIN)).toBeNull();
  });

  it('drops a page when there is no site to compare with, or the site is not http(s)', () => {
    for (const origin of [null, undefined, '', 'null', 'capacitor://localhost']) {
      expect(visitorPageUrl(LEGIT, origin), String(origin)).toBeNull();
    }
    expect(visitorPageUrl(null, ORIGIN)).toBeNull();
    expect(visitorPageUrl(42, ORIGIN)).toBeNull();
  });

  it('httpPageUrl takes any absolute http(s) address and never throws', () => {
    expect(httpPageUrl('https://evil.example/x')?.hostname).toBe('evil.example');
    for (const raw of ['/\\evil.example', '//evil.example', 'javascript:alert(1)', 'x', 'https://', '', null]) {
      expect(httpPageUrl(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

db.platform_call_center_settings = [{
  singleton: true, call_center_enabled: true, voice_calls_enabled: true, video_calls_enabled: true, callback_requests_enabled: true,
  call_recording_enabled: false, departments_enabled: false, ringback_enabled: false, ringback_mode: 'off', ringback_queue_audio_paths: {},
  widget_default_locale: 'fa', widget_available_locales: ['fa', 'en'], disabled_message: {},
  max_concurrent_calls_per_workspace: 10, max_queue_size_per_workspace: 10,
  callback_honeypot_enabled: true, callback_min_form_seconds: 0, callback_require_contact: false, callback_min_message_length: 0,
  callback_max_per_ip_per_hour: 0, callback_min_seconds_between_requests: 0,
}];
db.app_runtime_config = [{ key: 'default_storage_provider', value: { provider: 'local' } }];
db.platform_settings = [{ region_mode: 'iran' }];

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { invalidateCallWidgetBootstrapCache } = await import('../../../server/services/callCenter/bootstrapCache.js');
const server = startTestServer('/api/call-widget', callWidgetRouter, { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' }, { origin: ORIGIN });
afterAll(() => server.close());

let session = '';

beforeEach(async () => {
  db.call_center_settings = [{
    id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'], widget_position: 'right',
    widget_theme: {}, display_name: 'Shop', voice_enabled: true, video_enabled: true, callback_enabled: true, recording_enabled: false,
    pre_call_form_enabled: false, pre_call_form_schema: [], offline_behavior: 'show_callback', departments_enabled: false,
    allow_visitor_department_choice: false, widget_custom_texts: {}, default_department_id: null,
  }];
  db.call_sessions = [];
  db.call_queue_entries = [];
  db.call_events = [];
  db.callback_requests = [];
  db.visitor_sessions = [];
  server.clearCookies();
  invalidateCallWidgetBootstrapCache();
  const boot = await server.get<{ session: string }>(`/api/call-widget/bootstrap?workspaceId=${WS}`);
  expect(boot.status).toBe(200);
  session = boot.body.session;
});

async function requestCall(pageUrl: string) {
  const res = await server.post<{ status?: string; call_id?: string; error?: string }>(
    '/api/call-widget/calls/request',
    { call_type: 'voice', page_url: pageUrl, page_title: 'https://shop.example/checkout' },
    { 'x-cc-session': session },
  );
  expect(res.status, res.text).toBe(200);
  expect(res.body.status).toBe('queued');
  const call = db.call_sessions.find((c) => c.id === res.body.call_id);
  const event = db.call_events.find((e) => e.call_session_id === res.body.call_id && e.event_type === 'call_requested');
  return { stored: call?.page_url, logged: (event?.payload as { page_url?: unknown } | undefined)?.page_url, origin: call?.origin };
}

async function requestCallback(pageUrl: string) {
  const res = await server.post<{ ok?: boolean; callback_id?: string }>(
    '/api/call-widget/callbacks/request',
    { name: 'Ali', phone: '0912', message: 'call me', page_url: pageUrl },
    { 'x-cc-session': session },
  );
  expect(res.status, res.text).toBe(200);
  const row = db.callback_requests.find((c) => c.id === res.body.callback_id);
  return (row?.metadata as { page_url?: unknown } | undefined)?.page_url;
}

describe('POST /calls/request', () => {
  it('stores the page the widget sends, with the call\'s origin', async () => {
    expect(await requestCall(LEGIT)).toEqual({ stored: LEGIT, logged: LEGIT, origin: ORIGIN });
  });

  it.each(HOSTILE)('stores no page for %j, and the call still starts', async (pageUrl) => {
    expect(await requestCall(pageUrl)).toEqual({ stored: null, logged: null, origin: ORIGIN });
  });
});

describe('POST /callbacks/request', () => {
  it('stores the page the widget sends', async () => {
    expect(await requestCallback(LEGIT)).toBe(LEGIT);
  });

  it.each(HOSTILE)('stores no page for %j, and the callback is still taken', async (pageUrl) => {
    expect(await requestCallback(pageUrl)).toBeNull();
  });
});
