/**
 * POST /api/call-widget/callbacks/request and the callback time (S8, D16):
 * a time in the past or more than 30 days ahead is refused; while the
 * workspace's slots are on, a time must be one of its available slots; while
 * they are off, hours stored or not, no slot is checked; the answer echoes
 * the stored time and channel (the booked-callback launcher keeps them).
 */
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { db, fakeClient } from './fakeDb';
import { startTestServer } from './callWidgetHttp';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: async () => {} }));
vi.mock('../../../server/services/calls/entitlementComposer.js', () => ({
  loadEffectiveCallEntitlements: async () => ({ callbacks_enabled: true, visitor_voice_enabled: true, visitor_video_enabled: true }),
}));
vi.mock('../../../server/services/callCenter/realtime.js', () => ({ publishQueueEvent: async () => {}, publishCallEvent: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyCallbackRequest: async () => {} }));

const WS = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://shop.example';
// Monday 19 October 2026, 09:30 in Tehran.
const NOW = Date.parse('2026-10-19T06:00:00Z');
const HOURS = { enabled: true, timezone: 'Asia/Tehran', weekly: { mon: [{ from: '09:00', to: '12:00' }], tue: [{ from: '09:00', to: '12:00' }] } };
const TUE_10 = '2026-10-20T06:30:00.000Z'; // Tuesday 10:00 in Tehran: a slot

db.platform_call_center_settings = [{
  singleton: true, call_center_enabled: true, voice_calls_enabled: true, video_calls_enabled: true, callback_requests_enabled: true,
  call_recording_enabled: false, departments_enabled: false, ringback_enabled: false, ringback_mode: 'off', ringback_queue_audio_paths: {},
  widget_default_locale: 'fa', widget_available_locales: ['fa', 'en'], disabled_message: {},
  callback_honeypot_enabled: true, callback_min_form_seconds: 0, callback_require_contact: false, callback_min_message_length: 0,
  callback_max_per_ip_per_hour: 0, callback_min_seconds_between_requests: 0,
}];
db.app_runtime_config = [{ key: 'default_storage_provider', value: { provider: 'local' } }];
db.platform_settings = [{ region_mode: 'iran' }];

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { invalidateCallWidgetBootstrapCache } = await import('../../../server/services/callCenter/bootstrapCache.js');
const server = startTestServer('/api/call-widget', callWidgetRouter, { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' }, { origin: ORIGIN });
afterAll(() => { server.close(); vi.useRealTimers(); });

let session = '';
type Answer = { ok?: boolean; error?: string; callback_id?: string; scheduled_for?: string | null; channel?: string };

async function request(body: Record<string, unknown>) {
  return server.post<Answer>('/api/call-widget/callbacks/request', { name: 'Ali', phone: '0912', message: 'call me', ...body }, { 'x-cc-session': session });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db.call_center_settings = [{
    id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'], widget_position: 'right',
    widget_theme: {}, display_name: 'Shop', voice_enabled: true, video_enabled: true, callback_enabled: true, recording_enabled: false,
    pre_call_form_enabled: false, pre_call_form_schema: [], offline_behavior: 'show_callback', departments_enabled: false,
    allow_visitor_department_choice: false, widget_custom_texts: {}, default_department_id: null, business_hours: HOURS,
  }];
  db.callback_requests = [];
  invalidateCallWidgetBootstrapCache();
  const boot = await server.get<{ session: string }>(`/api/call-widget/bootstrap?workspaceId=${WS}`);
  expect(boot.status).toBe(200);
  session = boot.body.session;
});

const slotsOn = (extra: Record<string, unknown> = {}) =>
  Object.assign(db.call_center_settings[0], { callback_slots_enabled: true, callback_slot_minutes: 30, callback_days_ahead: 4, ...extra });

describe('callback time window', () => {
  it('refuses a time in the past (beyond two minutes) and one more than 30 days ahead', async () => {
    for (const at of ['2026-10-19T05:50:00.000Z', '2026-11-19T06:01:00.000Z']) {
      const res = await request({ scheduled_for: at });
      expect(res.status, at).toBe(400);
      expect(res.body.error).toBe('invalid_scheduled_for');
    }
    expect(db.callback_requests).toEqual([]);
  });

  it('accepts a time a minute ago (a slow submit) and the edge of 30 days', async () => {
    expect((await request({ scheduled_for: '2026-10-19T05:59:00.000Z' })).status).toBe(200);
    expect((await request({ scheduled_for: '2026-11-18T06:00:00.000Z' })).status).toBe(200);
  });
});

describe('callback slots', () => {
  it('slots off: any time in the window, hours stored or not, no grid check', async () => {
    Object.assign(db.call_center_settings[0], { callback_slots_enabled: false });
    const res = await request({ scheduled_for: '2026-10-25T13:07:00.000Z', channel: 'video' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, callback_id: expect.any(String), scheduled_for: '2026-10-25T13:07:00.000Z', channel: 'video' });
  });

  it('slots on: an available slot is booked, with its time and channel echoed', async () => {
    slotsOn();
    const res = await request({ scheduled_for: TUE_10, urgency: 'urgent' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, callback_id: expect.any(String), scheduled_for: TUE_10, channel: 'audio' });
    expect(db.callback_requests).toHaveLength(1);
  });

  it('slots on: an off-grid time, a time outside the hours and a slot too soon are slot_unavailable', async () => {
    slotsOn();
    for (const at of ['2026-10-20T06:40:00.000Z', '2026-10-20T12:00:00.000Z', '2026-10-19T06:00:00.000Z']) {
      const res = await request({ scheduled_for: at });
      expect(res.status, at).toBe(409);
      expect(res.body.error).toBe('slot_unavailable');
    }
    expect(db.callback_requests).toEqual([]);
  });

  it('slots on: a slot whose capacity is reached is slot_unavailable', async () => {
    slotsOn({ callback_slot_capacity: 1 });
    expect((await request({ scheduled_for: TUE_10 })).status).toBe(200);
    const again = await request({ scheduled_for: TUE_10 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('slot_unavailable');
    // Unlimited: the same slot again is fine.
    slotsOn({ callback_slot_capacity: null });
    expect((await request({ scheduled_for: TUE_10 })).status).toBe(200);
  });

  it('slots on with legacy hours that fail the strict shape: no slots, so no grid check', async () => {
    slotsOn({ business_hours: { mon: '9-5' } });
    expect((await request({ scheduled_for: '2026-10-25T13:07:00.000Z' })).status).toBe(200);
  });

  it('an ASAP request (no time) is never checked against the slots', async () => {
    slotsOn();
    const res = await request({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, callback_id: expect.any(String), scheduled_for: null, channel: 'audio' });
  });

  it('the honeypot answers as a success, echoing what was sent, and stores nothing', async () => {
    slotsOn();
    const res = await request({ hp_company: 'bots inc', scheduled_for: '2026-10-20T06:40:00.000Z', channel: 'video' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, callback_id: expect.stringMatching(/^hp_/), scheduled_for: '2026-10-20T06:40:00.000Z', channel: 'video' });
    expect(db.callback_requests).toEqual([]);
  });
});
