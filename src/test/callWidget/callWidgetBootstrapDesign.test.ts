/**
 * GET /api/call-widget/bootstrap: what the 2026-10 call widget design adds
 * (S6, migration 277), on the real router with an in-memory database
 * (./fakeDb.ts): the resolved launcher style and placement, the panel module's
 * asset paths, the callback slots (only while turned on), the International
 * logo direction, and the defaults for a database 277 has not reached.
 */
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { db, log, resetLog, fakeClient } from './fakeDb';
import { startTestServer } from './callWidgetHttp';
import { INTL_BRAND } from '../../../shared/internationalMode';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: async () => {} }));

const edition = vi.hoisted(() => ({ value: 'iran' as 'iran' | 'international' }));
vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformEditionOrNull: async () => edition.value,
}));
const chatTemplate = vi.hoisted(() => ({ options: {} as Record<string, unknown>, fail: false, calls: 0 }));
vi.mock('../../../server/services/widget/configSnapshot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/configSnapshot.js')>()),
  workspaceChatTemplate: async () => {
    chatTemplate.calls++;
    if (chatTemplate.fail) throw new Error('snapshot down');
    return { id: 't1-intl', descriptor: null, options: chatTemplate.options };
  },
}));

const WS = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://shop.example';
// Monday 19 October 2026, 09:30 in Tehran.
const NOW = Date.parse('2026-10-19T06:00:00Z');
const HOURS = { enabled: true, timezone: 'Asia/Tehran', weekly: { mon: [{ from: '09:00', to: '12:00' }], tue: [{ from: '09:00', to: '12:00' }] } };

/** A row as it is before migration 277 (none of its columns). */
function baseRow(): Record<string, unknown> {
  return {
    id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'],
    widget_position: 'bottom-left', widget_theme: {}, display_name: 'Shop', avatar_url: null, avatar_storage_path: null,
    voice_enabled: true, video_enabled: true, callback_enabled: true, recording_enabled: false, pre_call_form_enabled: false,
    pre_call_form_schema: [], offline_behavior: 'show_callback', departments_enabled: false, allow_visitor_department_choice: false,
    widget_custom_texts: {}, recording_consent_required: false, operator_video_visible_to_visitor: true, widget_template_id: null,
    business_hours: HOURS,
  };
}

db.platform_call_center_settings = [{ singleton: true, call_center_enabled: true, voice_calls_enabled: true, video_calls_enabled: true, callback_requests_enabled: true, call_recording_enabled: false, departments_enabled: false, ringback_enabled: false, ringback_mode: 'off', ringback_queue_audio_paths: {}, widget_default_locale: 'fa', widget_available_locales: ['fa', 'en'], disabled_message: {} }];
db.app_runtime_config = [
  { key: 'call_control_plane', value: { enabled: true, primary_provider: 'livekit' } },
  { key: 'call_livekit_config', value: { enabled: true, api_key: 'k', api_secret: 's', rtc_url: 'wss://lk.example', egress_enabled: false } },
  { key: 'default_storage_provider', value: { provider: 'local' } },
];
db.widget_platform_settings = [{ powered_by_enabled: true, powered_by_text: 'Powered by', powered_by_brand_text: 'RESPOK', powered_by_url: null }];
db.platform_branding_localized = [{ locale: 'en', platform_name: 'RESPOK' }];

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { invalidateCallWidgetBootstrapCache } = await import('../../../server/services/callCenter/bootstrapCache.js');
const { invalidatePublicCallPresence } = await import('../../../server/services/callCenter/publicPresence.js');
const server = startTestServer('/api/call-widget', callWidgetRouter, { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' }, { origin: ORIGIN });
afterAll(() => { server.close(); vi.useRealTimers(); });

type Body = {
  status: string;
  config: Record<string, unknown>;
  assets: Record<string, unknown>;
  callback_policy: Record<string, unknown> & { slots?: Array<{ at: string; available: boolean }> };
  powered_by?: { logo?: string };
};

async function bootstrap() {
  invalidateCallWidgetBootstrapCache();
  invalidatePublicCallPresence();
  resetLog();
  const res = await server.get<Body>(`/api/call-widget/bootstrap?workspaceId=${WS}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
  return { ...res, ops: [...log] };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  edition.value = 'iran';
  chatTemplate.options = {};
  chatTemplate.fail = false;
  chatTemplate.calls = 0;
  db.call_center_settings = [baseRow()];
  db.callback_requests = [];
});

describe('bootstrap: launcher, placement and panel assets', () => {
  it('a row from before 277: round_label, its placement normalised, no slots', async () => {
    const { body } = await bootstrap();
    expect(body.config.launcher_style).toBe('round_label');
    // A stored bottom-left is the left placement (it showed on the right before).
    expect(body.config.widget_position).toBe('left');
    expect(body.callback_policy).not.toHaveProperty('slots');
    expect(body.config).not.toHaveProperty('logoDirection');
  });

  it('sends the stored style, and round_label for one this build does not know', async () => {
    Object.assign(db.call_center_settings[0], { launcher_style: 'operator_face', widget_position: 'top-right' });
    let { body } = await bootstrap();
    expect(body.config.launcher_style).toBe('operator_face');
    expect(body.config.widget_position).toBe('top_right');
    Object.assign(db.call_center_settings[0], { launcher_style: 'hologram', widget_position: 'middle' });
    ({ body } = await bootstrap());
    expect(body.config.launcher_style).toBe('round_label');
    expect(body.config.widget_position).toBe('right');
  });

  it('names the panel module and its stylesheet', async () => {
    const { body } = await bootstrap();
    expect(body.assets.presentation_panel_script_url).toBe('/call-widget/presentation-default-panel.js');
    expect(body.assets.presentation_panel_style_url).toBe('/call-widget/presentation-default-panel.css');
  });
});

describe('bootstrap: callback slots', () => {
  it('none while slots are off, even with hours stored', async () => {
    Object.assign(db.call_center_settings[0], { callback_slots_enabled: false });
    const { body, text } = await bootstrap();
    expect(body.callback_policy).not.toHaveProperty('slots');
    expect(text).not.toContain('business_hours');
    expect(text).not.toContain('weekly');
  });

  it('slots from the hours once turned on, in the business zone, never the hours themselves', async () => {
    Object.assign(db.call_center_settings[0], { callback_slots_enabled: true, callback_slot_minutes: 60, callback_days_ahead: 2 });
    const { body, text, ops } = await bootstrap();
    expect(body.callback_policy.slots).toEqual([
      { at: '2026-10-19T09:00:00+03:30', available: false },
      { at: '2026-10-19T10:00:00+03:30', available: true },
      { at: '2026-10-19T11:00:00+03:30', available: true },
      { at: '2026-10-20T09:00:00+03:30', available: true },
      { at: '2026-10-20T10:00:00+03:30', available: true },
      { at: '2026-10-20T11:00:00+03:30', available: true },
    ]);
    expect(text).not.toContain('business_hours');
    expect(text).not.toContain('weekly');
    // No capacity: no booking is counted, so no query for them.
    expect(ops.filter((o) => o.includes('callback_requests'))).toEqual([]);
  });

  it('counts bookings in one query only when a capacity is set, and reveals no count', async () => {
    Object.assign(db.call_center_settings[0], { callback_slots_enabled: true, callback_slot_minutes: 60, callback_days_ahead: 1, callback_slot_capacity: 1 });
    // Ids with a '#': the body also carries random hex and base64url (the visitor id, the session), which a short
    // id such as 'cb1' can occur in by chance; '#' occurs in neither.
    db.callback_requests = [
      { id: 'booking#1', workspace_id: WS, status: 'requested', scheduled_for: '2026-10-19T07:30:00+00:00' }, // 11:00 Tehran
      { id: 'booking#2', workspace_id: WS, status: 'cancelled', scheduled_for: '2026-10-19T06:30:00+00:00' }, // 10:00, cancelled
    ];
    const { body, text, ops } = await bootstrap();
    expect(ops.filter((o) => o.includes('callback_requests'))).toEqual(['select callback_requests']);
    expect(body.callback_policy.slots).toEqual([
      { at: '2026-10-19T09:00:00+03:30', available: false },
      { at: '2026-10-19T10:00:00+03:30', available: true },
      { at: '2026-10-19T11:00:00+03:30', available: false },
    ]);
    expect(text).not.toContain('booking#1');
    expect(text).not.toMatch(/capacity|booked/);
  });

  it('none for hours that fail the strict shape (a legacy value), or that name no interval', async () => {
    Object.assign(db.call_center_settings[0], { callback_slots_enabled: true, business_hours: { mon: '9-5' } });
    expect((await bootstrap()).body.callback_policy).not.toHaveProperty('slots');
    Object.assign(db.call_center_settings[0], { business_hours: {} });
    expect((await bootstrap()).body.callback_policy).not.toHaveProperty('slots');
  });

  it('none when callbacks are off', async () => {
    Object.assign(db.call_center_settings[0], { callback_slots_enabled: true, callback_enabled: false });
    expect((await bootstrap()).body.callback_policy).not.toHaveProperty('slots');
  });

  it('the International edition counts in UTC when the hours name no zone', async () => {
    edition.value = 'international';
    Object.assign(db.call_center_settings[0], {
      callback_slots_enabled: true, callback_slot_minutes: 60, callback_days_ahead: 1,
      business_hours: { weekly: { mon: [{ from: '09:00', to: '10:00' }] } },
    });
    expect((await bootstrap()).body.callback_policy.slots).toEqual([{ at: '2026-10-19T09:00:00+00:00', available: true }]);
  });
});

describe('bootstrap: logo direction (International edition)', () => {
  it('follows the chat widget\'s template option, with the Open lockup in the credit', async () => {
    edition.value = 'international';
    chatTemplate.options = { logoDirection: 'open' };
    const { body } = await bootstrap();
    expect(body.config.logoDirection).toBe('open');
    expect(body.powered_by?.logo?.endsWith(INTL_BRAND.horizontalOpen.light)).toBe(true);
  });

  it('is thread otherwise, and when the chat template cannot be read', async () => {
    edition.value = 'international';
    chatTemplate.options = { logoDirection: 'sideways' };
    let { body } = await bootstrap();
    expect(body.config.logoDirection).toBe('thread');
    expect(body.powered_by?.logo?.endsWith(INTL_BRAND.horizontal.light)).toBe(true);
    chatTemplate.fail = true;
    ({ body } = await bootstrap());
    expect(body.config.logoDirection).toBe('thread');
    expect(body.status).toBe('ok');
  });

  it('is not sent, nor read, in the Iranian edition', async () => {
    const { body } = await bootstrap();
    expect(body.config).not.toHaveProperty('logoDirection');
    expect(chatTemplate.calls).toBe(0);
  });
});
