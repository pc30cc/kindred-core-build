// @vitest-environment node
/**
 * Super Admin's test ring (server/services/push/callRing.ts ringTestDevice,
 * POST /api/admin/notifications/test-ring) rings each of the tester's phones
 * with the ring it would get for a real call. An iPhone takes one kind of
 * VoIP push only, the colleague ring (docs/operations/TEAM_CALLS.md, "Ring
 * and its stop"): anything else it reports to CallKit and ends at once, so a
 * test in the call-centre's old shape would read as sent and ring nothing
 * anyone could see. An Android phone keeps the call-centre ring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeDb, type FakeDb } from '../calls/teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  voip: [] as Array<{ token: string; payload: Record<string, unknown>; collapseId?: string; expirationSeconds?: number }>,
  fcm: [] as Array<{ token: string; data: Record<string, string> }>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => true,
  sendVoipPush: async (m: (typeof h.voip)[number]) => { h.voip.push(m); return { ok: true }; },
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmData: async (m: (typeof h.fcm)[number]) => { h.fcm.push(m); return { ok: true }; },
}));

const { ringTestDevice } = await import('../../../server/services/push/callRing.js');

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'k' } as never;
const ADMIN = '22222222-2222-4222-8222-222222222222';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.mobile_push_devices = [
    { id: 'r-ios', user_id: ADMIN, platform: 'ios', transport: 'apns', push_token: 'apns-1', voip_token: 'voip-1', enabled: true },
    { id: 'r-and', user_id: ADMIN, platform: 'android', transport: 'fcm', push_token: 'fcm-1', voip_token: null, enabled: true },
  ];
  h.voip.length = 0;
  h.fcm.length = 0;
});

describe('the test ring', () => {
  it('rings an iPhone with a colleague ring under the test name, for a call that exists nowhere', async () => {
    const result = await ringTestDevice(config, { userId: ADMIN, callerName: 'Webyar test call', channel: 'video' });
    expect(result).toEqual({ devices: 2, sent: 2, failures: [] });

    expect(h.voip).toHaveLength(1);
    const { payload } = h.voip[0];
    expect(payload).toMatchObject({
      kind: 'team_call', event: 'incoming', channel: 'video', caller_name: 'Webyar test call',
      workspace_id: '00000000-0000-0000-0000-000000000000', workspace_name: null, caller_avatar_url: null,
    });
    // What the app's parser needs to take it for a ring (TeamCallRing).
    expect(payload.call_id).toMatch(UUID);
    expect(typeof payload.expires_at).toBe('number');
    expect((payload.expires_at as number) - Date.now() / 1000).toBeGreaterThan(40);
    expect(h.voip[0]).toMatchObject({ collapseId: payload.call_id, expirationSeconds: 45 });
    // Nobody's id: not the tester's.
    expect(JSON.stringify(payload)).not.toContain(ADMIN);
  });

  it('rings an Android phone with the call-centre ring, as before', async () => {
    await ringTestDevice(config, { userId: ADMIN, callerName: 'Webyar test call', channel: 'audio' });
    expect(h.fcm).toHaveLength(1);
    expect(h.fcm[0].data).toMatchObject({ type: 'call_incoming', channel: 'audio' });
    expect(h.fcm[0].data.callId).toBe(h.voip[0].payload.call_id);
  });
});
