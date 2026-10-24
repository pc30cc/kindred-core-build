/**
 * The call widget's public presence in GET /api/call-widget/bootstrap (S5,
 * S7; D17, D27): `presence.any_available` always, `presence.operators` only
 * for the launcher styles that draw operators, at most three, named from
 * their profile only, never an e-mail; memoised per workspace and dropped by
 * `callpresence:<workspace>` (an operator's status change).
 */
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { db, log, resetLog, fakeClient } from './fakeDb';
import { startTestServer } from './callWidgetHttp';

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeClient }));
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient }));
vi.mock('../../../server/services/geo/index.js', () => ({ enrichVisitorSessionGeo: async () => {} }));

const WS = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://shop.example';
const U = (n: number) => `0000000${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;

db.platform_call_center_settings = [{ singleton: true, call_center_enabled: true, voice_calls_enabled: true, video_calls_enabled: true, callback_requests_enabled: true, call_recording_enabled: false, departments_enabled: false, ringback_enabled: false, ringback_mode: 'off', ringback_queue_audio_paths: {}, widget_default_locale: 'fa', widget_available_locales: ['fa', 'en'], disabled_message: {} }];
db.app_runtime_config = [
  { key: 'call_control_plane', value: { enabled: true, primary_provider: 'livekit' } },
  { key: 'call_livekit_config', value: { enabled: true, api_key: 'k', api_secret: 's', rtc_url: 'wss://lk.example', egress_enabled: false } },
  { key: 'default_storage_provider', value: { provider: 'local' } },
];
db.platform_settings = [{ region_mode: 'iran' }];

const { callWidgetRouter } = await import('../../../server/routes/callWidget.js');
const { invalidateCallWidgetBootstrapCache } = await import('../../../server/services/callCenter/bootstrapCache.js');
const { invalidatePublicCallPresence } = await import('../../../server/services/callCenter/publicPresence.js');
const { publishCacheInvalidation } = await import('../../../server/lib/cacheBus.js');
const server = startTestServer('/api/call-widget', callWidgetRouter, { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' }, { origin: ORIGIN });
afterAll(() => { server.close(); vi.useRealTimers(); });

type Operator = { name: string | null; avatar_url: string | null };
type Body = { status: string; presence?: { any_available: boolean; operators?: Operator[] } };

function setStyle(style: string | undefined) {
  db.call_center_settings = [{
    id: 'cc1', workspace_id: WS, enabled: true, public_key: 'cck_x', allowed_domains: ['shop.example'], widget_position: 'right',
    widget_theme: {}, display_name: 'Shop', avatar_url: null, avatar_storage_path: null, voice_enabled: true, video_enabled: true,
    callback_enabled: true, recording_enabled: false, pre_call_form_enabled: false, pre_call_form_schema: [], offline_behavior: 'show_callback',
    departments_enabled: false, allow_visitor_department_choice: false, widget_custom_texts: {}, recording_consent_required: false,
    operator_video_visible_to_visitor: true, widget_template_id: null, business_hours: {},
    ...(style ? { launcher_style: style } : {}),
  }];
  invalidateCallWidgetBootstrapCache();
  invalidatePublicCallPresence();
}

async function view() {
  resetLog();
  const res = await server.get<Body>(`/api/call-widget/bootstrap?workspaceId=${WS}`);
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
  return { ...res, ops: [...log] };
}

beforeEach(() => {
  // The memos' clock stands still: a slow machine cannot expire one mid-test.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-19T06:00:00Z'));
  // Joined in order 1..5; 4 is a viewer (not an operator); 2 is busy.
  db.workspace_members = [
    { workspace_id: WS, user_id: U(3), role: 'agent', created_at: '2026-01-03T00:00:00Z' },
    { workspace_id: WS, user_id: U(1), role: 'owner', created_at: '2026-01-01T00:00:00Z' },
    { workspace_id: WS, user_id: U(4), role: 'viewer', created_at: '2026-01-04T00:00:00Z' },
    { workspace_id: WS, user_id: U(2), role: 'admin', created_at: '2026-01-02T00:00:00Z' },
    { workspace_id: WS, user_id: U(5), role: 'support_agent', created_at: '2026-01-05T00:00:00Z' },
    { workspace_id: WS, user_id: U(6), role: 'team_lead', created_at: '2026-01-06T00:00:00Z' },
  ];
  db.call_center_agent_presence = [1, 3, 4, 5, 6].map((n) => ({ workspace_id: WS, user_id: U(n), status: 'available' }))
    .concat([{ workspace_id: WS, user_id: U(2), status: 'busy' }]);
  db.profiles = [
    { id: U(1), full_name: '  Sara Ahmadi ', email: 'sara@shop.example', avatar_storage_key: null },
    { id: U(2), full_name: 'Reza', email: 'reza@shop.example', avatar_storage_key: null },
    { id: U(3), full_name: null, email: 'nameless.operator@shop.example', avatar_storage_key: null },
    { id: U(4), full_name: 'Viewer', email: 'v@shop.example', avatar_storage_key: null },
    { id: U(5), full_name: 'Mina', email: 'mina@shop.example', avatar_storage_key: null },
    { id: U(6), full_name: 'Lead', email: 'lead@shop.example', avatar_storage_key: null },
  ];
});

describe('bootstrap presence', () => {
  it('round_label (and a row without a style): only whether someone is available', async () => {
    setStyle(undefined);
    const { body, ops } = await view();
    expect(body.presence).toEqual({ any_available: true });
    // No profile is read when no operator is published.
    expect(ops).not.toContain('select profiles');
    setStyle('pill');
    expect((await view()).body.presence).toEqual({ any_available: true });
  });

  it('card and operator_face: up to three available operators in the order they joined, by their own names', async () => {
    for (const style of ['card', 'operator_face']) {
      setStyle(style);
      const { body } = await view();
      expect(body.presence).toEqual({
        any_available: true,
        operators: [
          { name: 'Sara Ahmadi', avatar_url: null },
          // No name of their own: null, never anything from the e-mail.
          { name: null, avatar_url: null },
          { name: 'Mina', avatar_url: null },
        ],
      });
    }
  });

  it('publishes no e-mail, no id, no role and no status beyond "available"', async () => {
    setStyle('card');
    const { text } = await view();
    const presence = JSON.stringify(JSON.parse(text).presence);
    expect(presence).not.toContain('@');
    expect(presence).not.toMatch(/nameless|operator@/);
    for (let n = 1; n <= 6; n++) expect(presence).not.toContain(U(n));
    expect(presence).not.toMatch(/role|owner|agent|busy|status|user_id/);
  });

  it('the whole bootstrap: no e-mail, and an operator\'s user id only inside their avatar\'s storage URL', async () => {
    db.profiles[0].avatar_storage_key = `users/${U(1)}/avatar/face.png`;
    setStyle('card');
    const { body, text } = await view();
    const ops = (body.presence?.operators || []) as Operator[];
    expect(ops[0].avatar_url, 'a stored avatar is published').toEqual(expect.any(String));
    expect(ops[0].avatar_url).toContain(U(1));
    // The chat's public team stack publishes the same storage folder (D27).
    const withoutAvatars = text.split(ops[0].avatar_url as string).join('');
    expect(withoutAvatars).not.toContain('@');
    for (let n = 1; n <= 6; n++) expect(withoutAvatars).not.toContain(U(n));
  });

  it('nobody available: any_available false and no operators (calls stay on: the widget decides)', async () => {
    db.call_center_agent_presence.forEach((p) => { p.status = 'away'; });
    setStyle('operator_face');
    expect((await view()).body.presence).toEqual({ any_available: false, operators: [] });
    db.workspace_members = [];
    setStyle('round_label');
    expect((await view()).body.presence).toEqual({ any_available: false });
  });

  it('is memoised: the next page views read no table, until an operator changes status', async () => {
    setStyle('card');
    const first = await view();
    expect(first.ops).toEqual(expect.arrayContaining(['select workspace_members', 'select call_center_agent_presence', 'select profiles']));
    // Everyone goes away: still the memo.
    db.call_center_agent_presence.forEach((p) => { p.status = 'away'; });
    const second = await view();
    expect(second.ops).toEqual([]);
    expect(second.body.presence?.any_available).toBe(true);
    // PUT /api/call-center/agents/me/presence publishes this scope.
    publishCacheInvalidation([`callpresence:${WS}`]);
    const third = await view();
    expect(third.ops).toEqual(['select workspace_members', 'select call_center_agent_presence']);
    expect(third.body.presence).toEqual({ any_available: false, operators: [] });
  });

  it('a name with nothing that shows (only marks or spaces) is no name: null, as the chat team reads it', async () => {
    db.profiles[0].full_name = '‏‌ ';
    setStyle('card');
    const ops = (await view()).body.presence?.operators || [];
    expect(ops[0]).toEqual({ name: null, avatar_url: null });
  });

  it('a profile change during a load is not kept (any spelling of the user id)', async () => {
    setStyle('card');
    const { loadPublicCallPresence } = await import('../../../server/services/callCenter/publicPresence.js');
    resetLog();
    const config = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'a', supabaseServiceRoleKey: 'SERVICE_KEY' };
    const loading = loadPublicCallPresence(config as never, WS, { withOperators: true });
    // The load has read the profiles; it is not stored yet.
    for (let i = 0; i < 200 && !log.includes('select profiles'); i++) await Promise.resolve();
    expect(log).toContain('select profiles');
    db.profiles[0] = { ...db.profiles[0], full_name: 'Sara A.' };
    publishCacheInvalidation([`user:${U(1).toUpperCase()}`]);
    expect((await loading).operators[0].name).toBe('Sara Ahmadi');
    expect((await view()).body.presence?.operators?.[0].name).toBe('Sara A.');
    // A stored entry: dropped by the id in upper case too.
    db.profiles[0] = { ...db.profiles[0], full_name: 'Sara' };
    publishCacheInvalidation([`user:${U(1).toUpperCase()}`]);
    expect((await view()).body.presence?.operators?.[0].name).toBe('Sara');
  });

  it('a settings save (widget:<ws>) or a profile change (user:<id>) drops it too', async () => {
    setStyle('card');
    await view();
    db.profiles[0].full_name = 'Sara A.';
    expect((await view()).body.presence?.operators?.[0].name).toBe('Sara Ahmadi');
    publishCacheInvalidation([`user:${U(1)}`]);
    expect((await view()).body.presence?.operators?.[0].name).toBe('Sara A.');
    db.call_center_agent_presence.forEach((p) => { p.status = 'away'; });
    publishCacheInvalidation([`widget:${WS}`]);
    expect((await view()).body.presence).toEqual({ any_available: false, operators: [] });
  });
});
