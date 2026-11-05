// @vitest-environment node
/**
 * A colleague call's ring and its stop (server/services/push/teamCallRing.ts,
 * docs/operations/TEAM_CALLS.md "Ring and its stop"): the exact payloads the
 * apps read, which phones are rung, and that the stop goes to the rung
 * Android phones only — never to the one that answered, never to an iPhone —
 * and never ahead of its ring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../calls/teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  voipOn: true,
  fcmOn: true,
  voip: [] as Array<{ token: string; payload: Record<string, unknown>; collapseId?: string; expirationSeconds?: number }>,
  fcm: [] as Array<{ token: string; data: Record<string, string>; ttlSeconds: number; collapseKey?: string }>,
  voipOutcome: { ok: true } as Record<string, unknown>,
  fcmOutcome: { ok: true } as Record<string, unknown>,
  /** When set, every FCM ring waits for it: a ring still on its way (a stop does not). */
  fcmGate: null as Promise<void> | null,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => h.voipOn,
  sendVoipPush: async (m: (typeof h.voip)[number]) => { h.voip.push(m); return h.voipOutcome; },
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => h.fcmOn,
  sendFcmData: async (m: (typeof h.fcm)[number]) => {
    if (h.fcmGate && m.data.type === 'team_call_incoming') await h.fcmGate;
    h.fcm.push(m);
    return h.fcmOutcome;
  },
}));

const ring = await import('../../../server/services/push/teamCallRing.js');

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'k' } as never;
const CALLEE = 'user-callee';
const input = {
  callId: 'call-1',
  workspaceId: 'ws-1',
  workspaceName: 'Acme',
  channel: 'audio' as const,
  callerUserId: 'user-caller',
  callerName: 'Sara',
  callerAvatarUrl: 'https://cdn.example/sara.jpg',
  expiresAt: 1_900_000_045,
};

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.mobile_push_devices = [
    { id: 'r-ios', user_id: CALLEE, platform: 'ios', transport: 'apns', push_token: 'apns-1', voip_token: 'voip-1', device_id: 'ios-1', enabled: true },
    { id: 'r-ios-novoip', user_id: CALLEE, platform: 'ios', transport: 'apns', push_token: 'apns-2', voip_token: null, device_id: 'ios-2', enabled: true },
    { id: 'r-ios-off', user_id: CALLEE, platform: 'ios', transport: 'apns', push_token: 'apns-3', voip_token: 'voip-3', device_id: 'ios-3', enabled: false },
    { id: 'r-and-1', user_id: CALLEE, platform: 'android', transport: 'fcm', push_token: 'fcm-1', voip_token: null, device_id: 'and-1', enabled: true },
    { id: 'r-and-2', user_id: CALLEE, platform: 'android', transport: 'fcm', push_token: 'fcm-2', voip_token: null, device_id: 'and-2', enabled: true },
    { id: 'r-and-off', user_id: CALLEE, platform: 'android', transport: 'fcm', push_token: 'fcm-3', voip_token: null, device_id: 'and-3', enabled: false },
    { id: 'r-other', user_id: 'user-other', platform: 'android', transport: 'fcm', push_token: 'fcm-other', voip_token: null, device_id: 'and-other', enabled: true },
  ];
  h.db.tables.call_sessions = [{ id: 'call-1', state: 'ringing' }];
  h.fcmGate = null;
  h.voipOn = true;
  h.fcmOn = true;
  h.voip.length = 0;
  h.fcm.length = 0;
  h.voipOutcome = { ok: true };
  h.fcmOutcome = { ok: true };
});

describe('payloads', () => {
  it('the PushKit ring: kind team_call, event incoming, and nothing but ids and display strings', () => {
    expect(ring.teamCallVoipPayload(input)).toEqual({
      kind: 'team_call', event: 'incoming', call_id: 'call-1', workspace_id: 'ws-1', workspace_name: 'Acme',
      channel: 'audio', caller_name: 'Sara', caller_avatar_url: 'https://cdn.example/sara.jpg',
      caller_user_id: 'user-caller', expires_at: 1_900_000_045,
    });
  });

  it('the Android ring: data-only team_call_incoming, every value a string', () => {
    const data = ring.teamCallAndroidRingData(input);
    expect(data).toEqual({
      type: 'team_call_incoming', callId: 'call-1', workspaceId: 'ws-1', workspaceName: 'Acme', channel: 'audio',
      callerName: 'Sara', callerAvatarUrl: 'https://cdn.example/sara.jpg', callerUserId: 'user-caller', expiresAt: '1900000045',
    });
    for (const value of Object.values(data)) expect(typeof value).toBe('string');
  });

  it('a photo URL too long for a push, or none, is left out: the app draws the silhouette', () => {
    const long = { ...input, callerAvatarUrl: `https://cdn.example/${'x'.repeat(2000)}`, workspaceName: null };
    expect(ring.teamCallVoipPayload(long)).toMatchObject({ caller_avatar_url: null, workspace_name: null });
    expect(ring.teamCallAndroidRingData(long)).not.toHaveProperty('callerAvatarUrl');
    expect(ring.teamCallAndroidRingData(long)).not.toHaveProperty('workspaceName');
  });

  it('the Android stop', () => {
    expect(ring.teamCallAndroidCancelData('call-1', 'answered_elsewhere')).toEqual({ type: 'team_call_cancel', callId: 'call-1', reason: 'answered_elsewhere' });
  });
});

describe('which phones ring', () => {
  it('every enabled iPhone with a VoIP token and every enabled Android phone of the callee', async () => {
    const targets = await ring.teamCallRingTargets(config, CALLEE, 'ws-1');
    expect(targets.ios).toEqual([{ rowId: 'r-ios', deviceId: 'ios-1', voipToken: 'voip-1', sendsRang: false }]);
    expect(targets.android.map((d) => d.deviceId)).toEqual(['and-1', 'and-2']);
  });

  it('a transport that is not configured rings none of its phones', async () => {
    h.voipOn = false;
    expect((await ring.teamCallRingTargets(config, CALLEE, 'ws-1')).ios).toEqual([]);
    h.voipOn = true;
    h.fcmOn = false;
    expect((await ring.teamCallRingTargets(config, CALLEE, 'ws-1')).android).toEqual([]);
  });

  it('rings them: VoIP with a 45 s expiry, FCM high-priority data with a 45 s ttl, collapsed on the call', async () => {
    const targets = await ring.teamCallRingTargets(config, CALLEE, 'ws-1');
    expect(await ring.ringTeamCall(config, input, targets)).toEqual({ sent: 3, devices: 3 });
    expect(h.voip).toEqual([{ token: 'voip-1', payload: ring.teamCallVoipPayload(input), collapseId: 'call-1', expirationSeconds: 45 }]);
    expect(h.fcm.map((m) => m.token)).toEqual(['fcm-1', 'fcm-2']);
    for (const m of h.fcm) {
      expect(m).toMatchObject({ ttlSeconds: 45, collapseKey: 'call-1', data: ring.teamCallAndroidRingData(input) });
    }
  });

  it('a dead PushKit token is forgotten, the phone keeps its notifications', async () => {
    h.voipOutcome = { ok: false, unregistered: true, status: 410 };
    await ring.ringTeamCall(config, input, await ring.teamCallRingTargets(config, CALLEE, 'ws-1'));
    const row = h.db.tables.mobile_push_devices.find((r) => r.id === 'r-ios')!;
    expect(row.voip_token).toBeNull();
    expect(row.enabled).toBe(true);
  });

  it('a dead FCM token disables its phone', async () => {
    h.fcmOutcome = { ok: false, unregistered: true, status: 404 };
    await ring.ringTeamCall(config, input, await ring.teamCallRingTargets(config, CALLEE, 'ws-1'));
    expect(h.db.tables.mobile_push_devices.find((r) => r.id === 'r-and-1')!.enabled).toBe(false);
  });

  it('a call that stopped ringing before its ring went out is not rung', async () => {
    const targets = await ring.teamCallRingTargets(config, CALLEE, 'ws-1');
    for (const state of ['cancelled', 'ended', 'missed']) {
      h.db.tables.call_sessions = [{ id: 'call-1', state }];
      expect(await ring.ringTeamCall(config, input, targets), state).toEqual({ sent: 0, devices: 3 });
    }
    expect(h.voip).toHaveLength(0);
    expect(h.fcm).toHaveLength(0);
  });

  it('a call whose state cannot be read is rung all the same', async () => {
    h.db.failNext('call_sessions');
    expect((await ring.ringTeamCall(config, input, await ring.teamCallRingTargets(config, CALLEE, 'ws-1'))).sent).toBe(3);
  });
});

describe('the stop', () => {
  it('goes to the rung Android phones but the one that answered, and never as VoIP', async () => {
    await ring.cancelTeamCallRing(config, {
      callId: 'call-1', calleeId: CALLEE, androidDeviceIds: ['and-1', 'and-2', 'and-3'], reason: 'answered_elsewhere', exceptDeviceId: 'and-1',
    });
    expect(h.fcm.map((m) => [m.token, m.data])).toEqual([['fcm-2', { type: 'team_call_cancel', callId: 'call-1', reason: 'answered_elsewhere' }]]);
    expect(h.voip).toHaveLength(0);
  });

  it('only to the phones that were rung, and only the callee’s', async () => {
    await ring.cancelTeamCallRing(config, { callId: 'call-1', calleeId: CALLEE, androidDeviceIds: ['and-2', 'and-other'], reason: 'missed' });
    expect(h.fcm.map((m) => m.token)).toEqual(['fcm-2']);
  });

  it('with nothing rung, nothing is sent', async () => {
    await ring.cancelTeamCallRing(config, { callId: 'call-1', calleeId: CALLEE, androidDeviceIds: [], reason: 'declined' });
    expect(h.fcm).toHaveLength(0);
  });

  it('waits for the ring still on its way: a quick cancel never reaches a phone before the ring', async () => {
    const targets = await ring.teamCallRingTargets(config, CALLEE, 'ws-1');
    let open!: () => void;
    h.fcmGate = new Promise<void>((resolve) => { open = resolve; });
    const ringing = ring.ringTeamCall(config, input, targets);
    const cancelling = ring.cancelTeamCallRing(config, {
      callId: 'call-1', calleeId: CALLEE, androidDeviceIds: ['and-1', 'and-2'], reason: 'cancelled',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.fcm).toHaveLength(0);
    open();
    await Promise.all([ringing, cancelling]);
    expect(h.fcm.map((m) => [m.token, m.data.type])).toEqual([
      ['fcm-1', 'team_call_incoming'], ['fcm-2', 'team_call_incoming'],
      ['fcm-1', 'team_call_cancel'], ['fcm-2', 'team_call_cancel'],
    ]);
  });
});
