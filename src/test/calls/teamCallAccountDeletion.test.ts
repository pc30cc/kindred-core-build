// @vitest-environment node
/**
 * Deleting an account ends its colleague calls (DELETE /api/account →
 * endTeamCallsOfMember, server/services/calls/teamCallLifecycle.ts).
 *
 * A member who deletes their account while a colleague call is ringing,
 * connecting or active must not leave the colleague's phones ringing to the
 * expiry, or the colleague in an empty room: each live call they are on is
 * hung up for them through the lifecycle's own move — the ring a cancel or a
 * decline, an answered call completed — with its effects (realtime, the rung
 * phones stopped). Other members' calls and calls already over are left
 * alone. In the route, it runs only once the password and owner checks have
 * passed, and before the sessions are revoked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeDb, type FakeDb } from './teamCallTestDb';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  published: [] as Array<{ users: readonly string[]; payload: Record<string, unknown> }>,
  closed: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => h.db }));
vi.mock('../../../server/services/calls/providerResolver.js', () => ({
  resolveCallProvider: () => ({
    closeRoom: async (_c: unknown, id: string) => { h.closed.push(id); },
  }),
}));
vi.mock('../../../server/services/push/fcm.js', () => ({
  isPushConfigured: () => true,
  sendFcmData: async () => ({ ok: true }),
}));
vi.mock('../../../server/services/push/apnsVoip.js', () => ({
  isVoipConfigured: () => true,
  sendVoipPush: async () => ({ ok: true }),
}));
vi.mock('../../../server/services/push/dispatch.js', () => ({
  notifyTeamCallMissed: async () => {},
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishTeamEvent: async (_c: unknown, users: readonly string[], payload: Record<string, unknown>) => { h.published.push({ users, payload }); },
}));

const { endTeamCallsOfMember } = await import('../../../server/services/calls/teamCallLifecycle.js');

const config = { supabaseUrl: 'http://db.test', supabaseServiceRoleKey: 'service-key', signingSecret: 'signing-secret' } as never;
const WS = '11111111-1111-4111-8111-111111111111';
const LEAVER = '22222222-2222-4222-8222-222222222222';
const COLLEAGUE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

function call(id: string, state: string, caller: string, callee: string, entrySource = 'team_call') {
  h.db.tables.call_sessions.push({
    id, workspace_id: WS, provider: 'livekit', provider_room_id: `room-${id}`, call_type: 'audio', state,
    entry_source: entrySource, initiated_by: caller, context_type: 'internal', context_id: null,
    created_at: new Date(Date.now() - 5_000).toISOString(),
    connected_at: state === 'ringing' ? null : new Date(Date.now() - 3_000).toISOString(),
    ended_at: null,
    metadata: { team_call: {
      caller_user_id: caller, callee_user_id: callee, channel: 'audio', outcome: null,
      answered_device_id: null, answered_at: null, rung_android_device_ids: [], rung_ios_device_ids: [],
    } },
  });
}
const byId = (id: string) => h.db.tables.call_sessions.find((r) => r.id === id) as Record<string, unknown>;
const outcome = (id: string) => (byId(id).metadata as Record<string, Record<string, unknown>>).team_call.outcome;

beforeEach(() => {
  h.db = createFakeDb();
  h.db.tables.call_sessions = [];
  h.db.tables.mobile_push_devices = [];
  h.db.tables.team_messages = [];
  h.published.length = 0;
  h.closed.length = 0;
});

describe('deleting an account ends its colleague calls', () => {
  it('cancels a ring it placed, declines a ring to it, completes an answered call', async () => {
    call('placed', 'ringing', LEAVER, COLLEAGUE);
    call('rung', 'ringing', COLLEAGUE, LEAVER);
    call('talking', 'active', COLLEAGUE, LEAVER);

    expect(await endTeamCallsOfMember(config, LEAVER)).toBe(3);

    expect(byId('placed').state).toBe('cancelled');
    expect(outcome('placed')).toBe('cancelled');
    expect(byId('rung').state).toBe('ended');
    expect(outcome('rung')).toBe('declined');
    expect(byId('talking').state).toBe('ended');
    expect(outcome('talking')).toBe('completed');
    // The colleague hears each of them.
    expect(h.published.some((p) => p.users.includes(COLLEAGUE))).toBe(true);
  });

  it('leaves other members’ calls, calls already over and visitor calls alone', async () => {
    call('others', 'ringing', COLLEAGUE, OTHER);
    call('over', 'ended', LEAVER, COLLEAGUE);
    call('visitor', 'active', LEAVER, COLLEAGUE, 'chat');

    expect(await endTeamCallsOfMember(config, LEAVER)).toBe(0);

    expect(byId('others').state).toBe('ringing');
    expect(byId('over').state).toBe('ended');
    expect(byId('visitor').state).toBe('active');
  });

  it('hangs up again a ring that was answered at the same instant as its decline', async () => {
    call('rung', 'ringing', COLLEAGUE, LEAVER);
    // The callee's other phone answers just as the deletion declines: the
    // first compare-and-set finds the call already connecting.
    const from = h.db.from.bind(h.db) as (table: string) => Record<string, (...args: unknown[]) => unknown>;
    let raced = false;
    (h.db as unknown as { from: unknown }).from = (table: string) => {
      const query = from(table);
      if (table === 'call_sessions' && !raced) {
        const update = query.update.bind(query);
        query.update = (...args: unknown[]) => {
          raced = true;
          Object.assign(byId('rung'), { state: 'connecting', connected_at: new Date().toISOString() });
          return update(...args);
        };
      }
      return query;
    };

    expect(await endTeamCallsOfMember(config, LEAVER)).toBe(1);

    expect(raced).toBe(true);
    expect(byId('rung').state).toBe('ended');
    expect(outcome('rung')).toBe('completed');
  });

  it('runs in DELETE /api/account after the password and owner checks, before the sessions go', () => {
    const route = readFileSync(join(process.cwd(), 'server/routes/account.ts'), 'utf8');
    const handler = route.slice(route.indexOf("accountRouter.delete('/'"));
    const password = handler.indexOf("'Password is incorrect'");
    const owner = handler.indexOf("'owns_workspaces'");
    const end = handler.indexOf('endTeamCallsOfMember(config, user.id)');
    const revoke = handler.indexOf("revokeAllSessions(config, user.id, 'account_deleted')");
    expect(password).toBeGreaterThan(-1);
    expect(owner).toBeGreaterThan(password);
    expect(end).toBeGreaterThan(owner);
    expect(revoke).toBeGreaterThan(end);
  });
});
