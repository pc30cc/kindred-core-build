// @vitest-environment node
/**
 * Ringback for old builds (docs/operations/TEAM_CALLS.md, "Ringback for old
 * builds"; server/services/push/teamCallRing.ts): a callee's phone whose app
 * cannot say `POST /:id/rang` would leave every caller on a silent
 * "Calling…" for the whole ring, so an accepted ring push to such a phone
 * stamps `rang_at` itself (platform `push`), once, and both members hear it.
 * A phone that says `rang` is never stamped by its push, a real `rang` that
 * came first wins, and the stamp never moves the call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFakeDb, type FakeDb } from '../calls/teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  edition: 'iran' as 'iran' | 'international' | null,
  voipOutcome: { ok: true } as Record<string, unknown>,
  fcmOutcome: { ok: true } as Record<string, unknown>,
  published: [] as Array<{ users: readonly string[]; payload: Record<string, unknown> }>,
  fcm: [] as Array<{ token: string; data: Record<string, string> }>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/services/platformRegion.js', () => ({
  getPlatformEditionOrNull: async () => h.edition,
}));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => true,
  sendVoipPush: async () => h.voipOutcome,
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmData: async (m: { token: string; data: Record<string, string> }) => {
    h.fcm.push(m);
    return m.data.type === 'team_call_incoming' ? h.fcmOutcome : { ok: true };
  },
}));
vi.mock('../../../server/services/push/dispatch.js', () => ({ notifyTeamCallMissed: async () => {} }));
vi.mock('../../../server/services/calls/teamCallChat.js', () => ({ writeTeamCallLine: async () => {} }));
vi.mock('../../../server/services/calls/providerResolver.js', () => ({
  resolveCallProvider: () => ({ closeRoom: async () => {} }),
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishTeamEvent: async (_c: unknown, users: readonly string[], payload: Record<string, unknown>) => {
    h.published.push({ users, payload });
  },
}));

const ring = await import('../../../server/services/push/teamCallRing.js');
const lifecycle = await import('../../../server/services/calls/teamCallLifecycle.js');
const { readTeamCallMeta } = await import('../../../server/services/calls/teamCall.js');

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'k' } as never;
const CALLER = 'user-caller';
const CALLEE = 'user-callee';
const input = {
  callId: 'call-1', workspaceId: 'ws-1', workspaceName: 'Acme', channel: 'audio' as const,
  callerUserId: CALLER, callerName: 'Sara', callerAvatarUrl: null, expiresAt: 1_900_000_045,
};

function device(id: string, platform: 'ios' | 'android', appVersion: string | null) {
  return {
    id: `r-${id}`, user_id: CALLEE, platform, transport: platform === 'ios' ? 'apns' : 'fcm',
    push_token: platform === 'android' ? `fcm-${id}` : `apns-${id}`,
    voip_token: platform === 'ios' ? `voip-${id}` : null,
    device_id: id, enabled: true, app_version: appVersion,
  };
}

function seedCall(over: Record<string, unknown> = {}) {
  const createdAt = new Date().toISOString();
  h.db.tables.call_sessions = [{
    id: 'call-1', workspace_id: 'ws-1', provider: 'livekit', provider_room_id: 'room-1', call_type: 'audio',
    state: 'ringing', entry_source: 'team_call', initiated_by: CALLER, created_at: createdAt,
    connected_at: null, ended_at: null,
    metadata: {
      team_call: {
        caller_user_id: CALLER, callee_user_id: CALLEE, channel: 'audio', outcome: null,
        answered_device_id: null, answered_at: null, rung_android_device_ids: [], rung_ios_device_ids: [],
        rang_at: null, rang_device_id: null, rang_platform: null, ...over,
      },
    },
  }];
}

const meta = () => readTeamCallMeta(h.db.tables.call_sessions[0] as never);

async function ringWith(devices: ReturnType<typeof device>[]) {
  h.db.tables.mobile_push_devices = devices;
  const targets = await ring.teamCallRingTargets(config, CALLEE, 'ws-1');
  const sent = await ring.ringTeamCall(config, input, targets);
  await ring.teamCallPushStampSettled(input.callId);
  return sent;
}

beforeEach(() => {
  h.db = createFakeDb();
  h.edition = 'iran';
  h.voipOutcome = { ok: true };
  h.fcmOutcome = { ok: true };
  h.published = [];
  h.fcm = [];
  seedCall();
});

describe('which builds say rang themselves', () => {
  it('reads the build number of "<name> (<build>)", as both apps register it', () => {
    expect(ring.teamCallAppBuild('1.9 (30)')).toBe(30);
    expect(ring.teamCallAppBuild('1.0.0 (5)')).toBe(5);
    expect(ring.teamCallAppBuild('1.9')).toBeNull();
    expect(ring.teamCallAppBuild('')).toBeNull();
    expect(ring.teamCallAppBuild(null)).toBeNull();
    expect(ring.teamCallAppBuild(undefined)).toBeNull();
  });

  const stamps = (platform: 'ios' | 'android', v: string | null | undefined, e: 'iran' | 'international' | null = 'iran') =>
    ring.teamCallPushStampsRang(platform, v, e);

  it('Android, WebYar: 1.7 (28) and 1.8 (29, Cafe Bazaar); not 1.9 (30) and later, which say rang', () => {
    expect(stamps('android', '1.7 (28)')).toBe(true);
    expect(stamps('android', '1.8 (29)')).toBe(true);
    expect(stamps('android', '1.9 (30)')).toBe(false);
    expect(stamps('android', '2.0 (31)')).toBe(false);
  });

  it('Android, WebYar: never below the floor, 1.6 (27) and earlier, which have no colleague calls to ring', () => {
    expect(stamps('android', '1.6 (27)')).toBe(false);
    expect(stamps('android', '0.1.0 (1)')).toBe(false);
  });

  it('Android, RESPOK: 1.0.3 (4) and 1.0.4 (5); not 1.0.5 (6) and later; never 1.0.2 (3) and earlier', () => {
    expect(stamps('android', '1.0.3 (4)', 'international')).toBe(true);
    expect(stamps('android', '1.0.4 (5)', 'international')).toBe(true);
    expect(stamps('android', '1.0.5 (6)', 'international')).toBe(false);
    expect(stamps('android', '1.0.2 (3)', 'international')).toBe(false);
    expect(stamps('android', '1.0.0 (1)', 'international')).toBe(false);
  });

  it('Android with the edition unread: WebYar\'s numbers, which stamp no RESPOK build', () => {
    expect(stamps('android', '1.8 (29)', null)).toBe(true);
    expect(stamps('android', '1.9 (30)', null)).toBe(false);
    for (const code of [1, 3, 4, 5, 6, 7]) expect(stamps('android', `1.0.x (${code})`, null)).toBe(false);
  });

  it('iOS, both brands: builds 3 to 5 (colleague calls, no rang); not 6 and later; never 1 or 2', () => {
    for (const edition of ['iran', 'international', null] as const) {
      expect(stamps('ios', '1.0.0 (3)', edition)).toBe(true);
      expect(stamps('ios', '1.0.0 (5)', edition)).toBe(true);
      expect(stamps('ios', '1.0.0 (6)', edition)).toBe(false);
      expect(stamps('ios', '1.1.0 (12)', edition)).toBe(false);
      expect(stamps('ios', '1.0.0 (2)', edition)).toBe(false);
    }
  });

  it('a phone with no app_version, or none with a build number, is never stamped (it could predate colleague calls)', () => {
    expect(stamps('android', null)).toBe(false);
    expect(stamps('ios', undefined)).toBe(false);
    expect(stamps('android', '1.8')).toBe(false);
  });

  it('every iOS build cut from main says rang: the project is at the first such build or above', () => {
    const project = readFileSync(resolve(process.cwd(), 'ios/Webyar/project.yml'), 'utf8');
    const build = project.match(/CURRENT_PROJECT_VERSION: "(\d+)"/);
    expect(Number(build?.[1])).toBeGreaterThanOrEqual(ring.TEAM_CALL_PUSH_STAMP_BUILDS.ios.first);
    expect(project.match(/CURRENT_PROJECT_VERSION:/g)).toHaveLength(1);
  });

  it('the targets carry it, read from each phone\'s app_version and the platform\'s edition', async () => {
    h.db.tables.mobile_push_devices = [
      device('ios-old', 'ios', '1.0.0 (5)'), device('ios-new', 'ios', '1.0.0 (6)'),
      device('and-old', 'android', '1.8 (29)'), device('and-new', 'android', '1.9 (30)'),
      device('and-none', 'android', null), device('and-ancient', 'android', '1.6 (27)'),
    ];
    const targets = await ring.teamCallRingTargets(config, CALLEE, 'ws-1');
    expect(Object.fromEntries([...targets.ios, ...targets.android].map((d) => [d.deviceId, d.pushStampsRang]))).toEqual({
      'ios-old': true, 'ios-new': false, 'and-old': true, 'and-new': false, 'and-none': false, 'and-ancient': false,
    });
    h.edition = 'international';
    h.db.tables.mobile_push_devices = [device('respok', 'android', '1.0.4 (5)')];
    expect((await ring.teamCallRingTargets(config, CALLEE, 'ws-1')).android[0].pushStampsRang).toBe(true);
  });
});

describe('an accepted ring to an old build stamps rang_at', () => {
  it('Android 1.8: rang_at now, platform push, its device, and both members hear it', async () => {
    const before = Date.now();
    await ringWith([device('and-old', 'android', '1.8 (29)')]);
    const m = meta();
    expect(m.rang_platform).toBe('push');
    expect(m.rang_device_id).toBe('and-old');
    expect(Date.parse(m.rang_at!)).toBeGreaterThanOrEqual(before - 1000);
    expect(h.published).toEqual([{
      users: [CALLER, CALLEE],
      payload: { kind: 'team_call', workspace_id: 'ws-1', call_id: 'call-1', state: 'ringing', outcome: null, rang_at: m.rang_at },
    }]);
    // Not a move: the call still rings, with the same ring.
    const row = h.db.tables.call_sessions[0];
    expect(row.state).toBe('ringing');
    expect(row.connected_at).toBeNull();
    expect(row.ended_at).toBeNull();
  });

  it('an old iPhone (build 5) through PushKit', async () => {
    await ringWith([device('ios-old', 'ios', '1.0.0 (5)')]);
    expect(meta()).toMatchObject({ rang_platform: 'push', rang_device_id: 'ios-old' });
    expect(h.published).toHaveLength(1);
  });

  it('never for a phone that registered no app_version, nor a build from before colleague calls', async () => {
    await ringWith([device('and-none', 'android', null), device('and-ancient', 'android', '1.6 (27)'), device('ios-ancient', 'ios', '1.0.0 (2)')]);
    expect(meta().rang_at).toBeNull();
    expect(h.published).toEqual([]);
  });

  it('once per call, however many old phones took the ring', async () => {
    await ringWith([
      device('and-old', 'android', '1.8 (29)'), device('and-older', 'android', '1.7 (28)'),
      device('ios-old', 'ios', '1.0.0 (5)'),
    ]);
    expect(meta().rang_platform).toBe('push');
    expect(h.published).toHaveLength(1);
  });

  it('never for a build that says rang itself: its own rang stamps it', async () => {
    await ringWith([device('and-new', 'android', '1.9 (30)'), device('ios-new', 'ios', '1.0.0 (6)')]);
    expect(meta().rang_at).toBeNull();
    expect(h.published).toEqual([]);
  });

  it('never for a push the transport refused', async () => {
    h.fcmOutcome = { ok: false, status: 500 };
    h.voipOutcome = { ok: false, status: 500, reason: 'InternalServerError' };
    await ringWith([device('and-old', 'android', '1.8 (29)'), device('ios-old', 'ios', '1.0.0 (5)')]);
    expect(meta().rang_at).toBeNull();
    expect(h.published).toEqual([]);
  });

  it('a real rang that came first wins', async () => {
    seedCall({ rang_at: '2026-11-05T10:00:00.000Z', rang_device_id: 'web-1', rang_platform: 'web' });
    await ringWith([device('and-old', 'android', '1.8 (29)')]);
    expect(meta()).toMatchObject({ rang_at: '2026-11-05T10:00:00.000Z', rang_device_id: 'web-1', rang_platform: 'web' });
    expect(h.published).toEqual([]);
  });

  it('a push stamp is the first one, which a later real rang does not change', async () => {
    await ringWith([device('and-old', 'android', '1.8 (29)')]);
    const stamped = meta().rang_at;
    const later = await lifecycle.markTeamCallRang(config, h.db.tables.call_sessions[0] as never, { deviceId: 'web-1', platform: 'web' });
    expect(later.stamped).toBe(false);
    expect(meta()).toMatchObject({ rang_at: stamped, rang_platform: 'push', rang_device_id: 'and-old' });
    expect(h.published).toHaveLength(1);
  });

  it('a ring accepted after the ring ran out: the stamp marks it missed and its stop still goes out (no wait on itself)', async () => {
    seedCall({ rung_android_device_ids: ['and-old'] });
    const row = h.db.tables.call_sessions[0];
    row.created_at = new Date(Date.now() - 60_000).toISOString();
    h.db.tables.mobile_push_devices = [device('and-old', 'android', '1.8 (29)')];
    const targets = await ring.teamCallRingTargets(config, CALLEE, 'ws-1');
    const ringing = ring.ringTeamCall(config, input, targets);
    const settled = await Promise.race([
      ringing.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('stuck'), 2_000)),
    ]);
    expect(settled).toBe('resolved');
    await ring.teamCallPushStampSettled('call-1');
    await vi.waitFor(() => expect(h.fcm.map((m) => m.data.type)).toEqual(['team_call_incoming', 'team_call_cancel']));
    expect(h.fcm[1].data).toEqual({ type: 'team_call_cancel', callId: 'call-1', reason: 'missed' });
    expect(row.state).toBe('missed');
    expect(meta().rang_at).toBeNull();
  });

  it('a call that no longer rings is neither rung nor stamped', async () => {
    h.db.tables.call_sessions[0].state = 'cancelled';
    expect(await ringWith([device('and-old', 'android', '1.8 (29)')])).toEqual({ sent: 0, devices: 1 });
    expect(meta().rang_at).toBeNull();
    expect(h.published).toEqual([]);
  });
});
