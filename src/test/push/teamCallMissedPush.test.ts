// @vitest-environment node
/**
 * A colleague's call nobody answered leaves a notification behind
 * (`team_call_missed`, docs/operations/TEAM_CALLS.md "Missed"): on the
 * phones of the member it rang, in their language, under the same
 * preferences as a colleague's message — the colleague-chat switch
 * included — once per call, opening that colleague's thread.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb, type FakeDb, type Row } from '../calls/teamCallTestDb';

interface Sent { token: string; title: string; body: string; data: Record<string, string>; apns?: { threadId?: string } }

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  fcm: [] as Sent[],
  apns: [] as Sent[],
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmMessage: async (msg: Sent) => { h.fcm.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/push/apns.js', () => ({
  isApnsConfigured: () => true,
  nativeBundleId: () => 'com.webyar.ai',
  sendApnsAlert: async (msg: Sent) => { h.apns.push(msg); return { ok: true }; },
}));
vi.mock('../../../server/services/widget/operatorPresenceSource.js', () => ({
  getConnectedOperators: async () => ({ mode: 'realtime', connected: new Set(), lastSeen: new Map(), degraded: false }),
}));
vi.mock('../../../server/services/billing/locks/state.js', () => ({
  resolveLockState: async () => ({ enabled: false }),
}));
vi.mock('../../../server/services/push/platformSettings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/push/platformSettings.js')>();
  return {
    ...actual,
    loadPushPlatformSettings: async () => ({ ...actual.PUSH_PLATFORM_DEFAULTS, badge_enabled: false }),
  };
});

const { notifyTeamCallMissed, renderTeamCallMissedContent } = await import('../../../server/services/push/dispatch.js');
// The transport is a stand-in above; the drawer tag is its real rule.
const { androidNotificationTag } = await vi.importActual<typeof import('../../../server/services/push/fcm.js')>(
  '../../../server/services/push/fcm.js',
);

const CONFIG = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'k' } as never;
const RLM = '‏';
const WS = 'ws-1';
const CALLER = 'user-sara';
const CALLEE = 'user-reza';

function prefs(userId: string, overrides: Row = {}): Row {
  return {
    user_id: userId, workspace_id: null, platform: 'mobile',
    disable_all: false, play_sound: true, push_scope: 'all', push_preview: true, push_internal_notes: true,
    push_when_online: true, push_when_offline: true, quiet_hours_enabled: false,
    quiet_hours_start: null, quiet_hours_end: null, quiet_hours_timezone: null,
    push_team_chat: true, push_assignments: true, push_email: true,
    ...overrides,
  };
}

function device(userId: string, transport: 'fcm' | 'apns'): Row {
  return {
    id: `d-${userId}-${transport}`, user_id: userId, platform: transport === 'fcm' ? 'android' : 'ios',
    push_token: `token-${userId}-${transport}`, transport, device_id: `device-${userId}-${transport}`, enabled: true,
  };
}

const missed = (overrides: Record<string, unknown> = {}) => notifyTeamCallMissed(CONFIG, {
  workspaceId: WS, callerId: CALLER, calleeId: CALLEE, callId: 'call-1', channel: 'video', ...overrides,
});

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.workspace_members = [
    { workspace_id: WS, user_id: CALLER, suspended_at: null, role: 'agent' },
    { workspace_id: WS, user_id: CALLEE, suspended_at: null, role: 'agent' },
  ];
  h.db.tables.profiles = [
    { id: CALLER, full_name: 'Sara', preferred_locale: 'en' },
    { id: CALLEE, full_name: 'Reza', preferred_locale: 'fa' },
  ];
  h.db.tables.user_notification_prefs = [];
  h.db.tables.mobile_push_devices = [device(CALLER, 'fcm'), device(CALLEE, 'fcm'), device(CALLEE, 'apns')];
  h.db.tables.push_dispatch_log = [];
  h.fcm.length = 0;
  h.apns.length = 0;
});

describe('a missed colleague call', () => {
  it('reaches every phone of the member it rang, and not the caller', async () => {
    await missed();
    expect(h.fcm.map((m) => m.token)).toEqual([`token-${CALLEE}-fcm`]);
    expect(h.apns.map((m) => m.token)).toEqual([`token-${CALLEE}-apns`]);
  });

  it('opens the colleague’s thread: ids and the channel only', async () => {
    await missed();
    expect(h.fcm[0].data).toEqual({ type: 'team_call_missed', workspaceId: WS, peerId: CALLER, callId: 'call-1', channel: 'video' });
    expect(androidNotificationTag(h.fcm[0].data)).toBe('team_call:call-1');
  });

  it('in the member’s language, with the caller’s name and the kind of call', async () => {
    await missed();
    expect(h.fcm[0].title).toBe(`${RLM}Sara · همکار`);
    expect(h.fcm[0].body).toBe('تماس تصویری بی‌پاسخ');
    expect(renderTeamCallMissedContent({ callerName: 'Sara', channel: 'audio' }, true, 'en'))
      .toEqual({ title: 'Sara · colleague', body: 'Missed voice call' });
    expect(renderTeamCallMissedContent({ callerName: 'Sara', channel: 'video' }, true, 'tr'))
      .toEqual({ title: 'Sara · iş arkadaşı', body: 'Cevapsız görüntülü arama' });
  });

  it('with previews off, the name stays on the server', async () => {
    h.db.tables.user_notification_prefs = [prefs(CALLEE, { push_preview: false })];
    await missed();
    expect(`${h.fcm[0].title} ${h.fcm[0].body}`).not.toContain('Sara');
    expect(h.fcm[0].body).toBe('تماس بی‌پاسخ از همکار');
  });

  it('is silenced by the colleague-chat switch, like a colleague’s message', async () => {
    h.db.tables.user_notification_prefs = [prefs(CALLEE, { push_team_chat: false })];
    await missed();
    expect(h.fcm).toHaveLength(0);
    expect(h.apns).toHaveLength(0);
  });

  it('and by "disable all"', async () => {
    h.db.tables.user_notification_prefs = [prefs(CALLEE, { disable_all: true })];
    await missed();
    expect(h.fcm).toHaveLength(0);
  });

  it('reaches a member who follows only mentions: it is addressed to them', async () => {
    h.db.tables.user_notification_prefs = [prefs(CALLEE, { push_scope: 'mentions' })];
    await missed();
    expect(h.fcm).toHaveLength(1);
  });

  it('never a suspended member', async () => {
    h.db.tables.workspace_members[1].suspended_at = '2026-10-01T00:00:00.000Z';
    await missed();
    expect(h.fcm).toHaveLength(0);
  });

  it('once per call', async () => {
    await missed();
    await missed();
    expect(h.fcm).toHaveLength(1);
    expect(h.db.tables.push_dispatch_log.map((r) => r.dedupe_key)).toEqual(['team_call_missed:call-1']);
  });
});
