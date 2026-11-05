// @vitest-environment node
/**
 * Calls left `active` after everyone left, their `room_finished` lost
 * (staleActiveSweep.ts), on a real database built by the whole chain: such a
 * call ends at its last participant's leave (never at the pass), is billed
 * the minutes up to that leave once, its room is closed, its operator's
 * in-call marker cleared and the operators (only) told; a call whose room has
 * someone in it, whose provider cannot be asked, that showed life recently,
 * or a colleague call stays as it is; a second pass or a late room_finished
 * bills nothing again.
 *
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

type Row = Record<string, unknown>;

const fake = vi.hoisted(() => ({
  /** Identities in each room; a room missing here lists as empty. */
  rooms: new Map<string, string[]>(),
  /** Rooms whose listing throws (the provider cannot be asked). */
  unreachable: new Set<string>(),
  closed: [] as string[],
  operatorEvents: [] as Array<{ payload: Record<string, unknown>; opts?: { skipConversationChannel?: boolean } }>,
  callCenterEvents: [] as Array<{ callId: string; type: string; payload: Record<string, unknown> }>,
}));

vi.mock('../../../server/services/calls/providerResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/calls/providerResolver.js')>()),
  resolveCallProvider: (id: string) => ({
    id,
    listRoomIdentities: id === 'livekit'
      ? async (_config: unknown, room: string) => {
        if (fake.unreachable.has(room)) throw new Error('livekit unreachable');
        return fake.rooms.get(room) ?? [];
      }
      : undefined,
    closeRoom: async (_config: unknown, room: string) => { fake.closed.push(room); },
  }),
}));
vi.mock('../../../server/services/realtime/publish.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/realtime/publish.js')>()),
  publishOperatorEvent: async (_config: unknown, payload: Record<string, unknown>, opts?: { skipConversationChannel?: boolean }) => {
    fake.operatorEvents.push({ payload, opts });
  },
}));
vi.mock('../../../server/services/callCenter/realtime.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/callCenter/realtime.js')>()),
  publishCallEvent: async (_config: unknown, _ws: string, callId: string, type: string, payload: Record<string, unknown>) => {
    fake.callCenterEvents.push({ callId, type, payload });
  },
}));

suite('stale active calls (staleActiveSweep.ts)', () => {
  let chain: FullChainDatabase;
  let config: never;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const ws = randomUUID();
  let conversation = '';

  /** A call created `ageMin` minutes ago, connected `connectedMin` minutes ago (null: not connected). */
  const call = async (fields: {
    ageMin: number;
    connectedMin?: number | null;
    state?: string;
    room?: string | null;
    provider?: string;
    entrySource?: string;
    conversationId?: string | null;
    agent?: string | null;
  }) => String((await one(
    `INSERT INTO public.call_sessions (workspace_id, provider, call_type, context_type, context_id, state, entry_source,
                                       provider_room_id, connected_at, initiated_by_type, assigned_agent_id,
                                       created_at, updated_at, started_at)
     VALUES ($1, $2, 'video', $3, $4, $5, $6, $7,
             CASE WHEN $8::float8 IS NULL THEN NULL ELSE now() - make_interval(secs => $8::float8 * 60) END,
             'operator', $10,
             now() - make_interval(secs => $9::float8 * 60), now() - make_interval(secs => $9::float8 * 60),
             now() - make_interval(secs => $9::float8 * 60))
     RETURNING id`,
    [
      ws, fields.provider ?? 'livekit',
      fields.conversationId ? 'conversation' : 'internal', fields.conversationId ?? null,
      fields.state ?? 'active', fields.entrySource ?? 'chat',
      fields.room === undefined ? `room-${randomUUID().slice(0, 8)}` : fields.room,
      fields.connectedMin === undefined ? fields.ageMin : fields.connectedMin,
      fields.ageMin,
      fields.agent ?? null,
    ],
  )).id);

  /** A call event `agoMin` minutes ago. */
  const event = async (callId: string, type: string, agoMin: number, payload: Record<string, unknown> = {}) => {
    await q(`INSERT INTO public.call_events (call_session_id, event_type, actor_type, payload, created_at)
             VALUES ($1, $2, 'internal', $3, now() - make_interval(secs => $4::float8 * 60))`, [callId, type, payload, agoMin]);
  };
  const stateOf = async (id: string) => one(
    `SELECT state, end_reason, ended_by, ended_at, duration_seconds, provider_room_id, connected_at FROM public.call_sessions WHERE id = $1`, [id]);
  const eventAt = async (id: string, type: string, filter = 'true') => (await one(
    `SELECT max(created_at) AS t FROM public.call_events WHERE call_session_id = $1 AND event_type = $2 AND ${filter}`, [id, type])).t as Date;

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `stale_active_${Date.now()}`);
    await q(`INSERT INTO public.profiles (id, email, full_name) VALUES ($1, $2, 'Owner')`, [owner, `o-${owner.slice(0, 8)}@test.local`]);
    await q(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Acme', $2, $3)`, [ws, `ws-${ws.slice(0, 8)}`, owner]);
    await q(`INSERT INTO public.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [ws, owner]);
    conversation = String((await one(`INSERT INTO public.conversations (workspace_id, status) VALUES ($1, 'open') RETURNING id`, [ws])).id);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: 'http://127.0.0.1',
    });
    delete process.env.DATABASE_MODE;
    config = (await import('../../../server/config.js')).loadConfig() as never;
  }, 600_000);

  afterAll(async () => {
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer().catch(() => undefined);
    await chain?.drop();
  });

  beforeEach(async () => {
    await q(`DELETE FROM public.call_sessions WHERE workspace_id = $1`, [ws]);
    fake.rooms.clear();
    fake.unreachable.clear();
    fake.closed.length = 0;
    fake.operatorEvents.length = 0;
    fake.callCenterEvents.length = 0;
    (await import('../../../server/services/calls/staleActiveSweep.js')).resetStaleActiveCursor();
  });

  const sweep = async () => (await import('../../../server/services/calls/staleActiveSweep.js')).sweepStaleActiveCalls(config);
  const minutesUsed = async () => Number((await one(
    `SELECT coalesce(sum(call_minutes_used), 0)::int AS n FROM public.workspace_usage_counters WHERE workspace_id = $1`, [ws])).n);
  const roomFinished = async (room: string) => {
    const { applyEvent } = await import('../../../server/routes/livekitWebhook.js');
    return applyEvent(config, { event: 'room_finished', id: `ev-${randomUUID()}`, room: { name: room, sid: 'RM_x' } } as never);
  };

  it('ends at the last real leave, billed the minutes up to it (never to now), with every side effect of an end', async () => {
    const agent = randomUUID();
    await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [agent, `a-${agent.slice(0, 8)}@test.local`]);
    // Connected 90 minutes ago; the visitor left at -55, the operator at
    // -50.5; a replaced connection's leave (DUPLICATE_IDENTITY, a late retry)
    // at -30 is not a leave.
    const id = await call({ ageMin: 95, connectedMin: 90, conversationId: conversation, agent });
    await event(id, 'lk.room_started', 95);
    await event(id, 'lk.participant_joined', 90, { identity: 'visitor:v1' });
    await event(id, 'lk.participant_joined', 89, { identity: 'operator:o1' });
    await event(id, 'lk.participant_left', 55, { identity: 'visitor:v1' });
    await event(id, 'lk.participant_left', 50.5, { identity: 'operator:o1' });
    await event(id, 'lk.participant_left', 30, { identity: 'operator:o1', disconnect_reason: 'DUPLICATE_IDENTITY' });
    // The operator's marker still points at the call; another's at a newer one.
    const newer = await call({ ageMin: 1 });
    const other = randomUUID();
    await q(`INSERT INTO public.profiles (id, email) VALUES ($1, $2)`, [other, `u-${other.slice(0, 8)}@test.local`]);
    for (const [user, callId] of [[agent, id], [other, newer]]) {
      await q(`INSERT INTO public.operator_call_availability (workspace_id, user_id, status, in_call, active_call_session_id)
               VALUES ($1, $2, 'busy', true, $3)`, [ws, user, callId]);
    }
    const before = await minutesUsed();
    const lastLeave = await eventAt(id, 'lk.participant_left', `coalesce(payload->>'disconnect_reason', '') <> 'DUPLICATE_IDENTITY'`);

    expect(await sweep()).toEqual({ checked: 1, ended: 1, kept: 0 });

    const row = await stateOf(id);
    expect(row).toMatchObject({ state: 'ended', end_reason: 'system_ended', ended_by: 'system' });
    expect((row.ended_at as Date).getTime()).toBe(lastLeave.getTime());
    const expectedSeconds = Math.round((lastLeave.getTime() - (row.connected_at as Date).getTime()) / 1000);
    expect(row.duration_seconds).toBe(expectedSeconds);
    expect(expectedSeconds).toBeGreaterThanOrEqual(39 * 60);
    expect(expectedSeconds).toBeLessThanOrEqual(40 * 60);
    // CEIL(39.5 min) = 40, not the ~90 minutes up to now.
    expect(await minutesUsed()).toBe(before + 40);

    expect(fake.closed).toEqual([row.provider_room_id]);
    const ended = await q(`SELECT event_type, actor_type, payload FROM public.call_events WHERE call_session_id = $1 AND event_type = 'ended'`, [id]);
    expect(ended).toEqual([{
      event_type: 'ended',
      actor_type: 'internal',
      payload: expect.objectContaining({ reason: 'stale_active', end_reason: 'system_ended', end_time_source: 'participant_left', duration_seconds: expectedSeconds }),
    }]);
    const markers = await q(`SELECT user_id, in_call, active_call_session_id FROM public.operator_call_availability WHERE workspace_id = $1`, [ws]);
    expect(markers.find((m) => m.user_id === agent)).toMatchObject({ in_call: false, active_call_session_id: null });
    expect(markers.find((m) => m.user_id === other)).toMatchObject({ in_call: true, active_call_session_id: newer });
    expect(fake.operatorEvents).toEqual([{
      payload: expect.objectContaining({
        kind: 'call:ended', conversation_id: conversation, workspace_id: ws, call_session_id: id,
        ended_by: 'system', reason: 'stale_active', duration_seconds: expectedSeconds,
      }),
      opts: { skipConversationChannel: true },
    }]);
    expect(fake.callCenterEvents).toEqual([{ callId: id, type: 'call_ended', payload: { call_id: id, state: 'ended', reason: 'stale_active' } }]);

    // Run again, then a late room_finished: nothing moves, nothing is billed again.
    expect(await sweep()).toEqual({ checked: 0, ended: 0, kept: 0 });
    expect((await roomFinished(String(row.provider_room_id))).applied).toBe(true);
    const after = await stateOf(id);
    expect(after).toMatchObject({ state: 'ended', end_reason: 'system_ended', duration_seconds: expectedSeconds });
    expect((after.ended_at as Date).getTime()).toBe(lastLeave.getTime());
    expect(await minutesUsed()).toBe(before + 40);
  });

  it('a room_finished that came first wins: the sweep finds nothing to end', async () => {
    const id = await call({ ageMin: 60, connectedMin: 58 });
    await event(id, 'lk.participant_left', 40, { identity: 'visitor:v1' });
    const before = await minutesUsed();
    await roomFinished(String((await stateOf(id)).provider_room_id));
    const billed = await minutesUsed();
    expect(billed).toBeGreaterThan(before);
    expect(await sweep()).toEqual({ checked: 0, ended: 0, kept: 0 });
    expect(await minutesUsed()).toBe(billed);
  });

  it('a join after the last leave (its leave lost too) ends at that join; no leave at all: the last sign of life, else connected_at', async () => {
    const rejoined = await call({ ageMin: 80, connectedMin: 80 });
    await event(rejoined, 'lk.participant_left', 70, { identity: 'visitor:v1' });
    await event(rejoined, 'lk.participant_joined', 65, { identity: 'visitor:v1' });
    const noLeave = await call({ ageMin: 80, connectedMin: 80 });
    await event(noLeave, 'lk.participant_joined', 79, { identity: 'visitor:v1' });
    await event(noLeave, 'recording_config_ready', 60);
    const silent = await call({ ageMin: 80, connectedMin: 75 });
    const before = await minutesUsed();

    expect(await sweep()).toEqual({ checked: 3, ended: 3, kept: 0 });

    expect((await stateOf(rejoined)).ended_at).toEqual(await eventAt(rejoined, 'lk.participant_joined'));
    expect((await stateOf(noLeave)).ended_at).toEqual(await eventAt(noLeave, 'recording_config_ready'));
    const s = await stateOf(silent);
    expect(s.ended_at).toEqual(s.connected_at);
    expect(s.duration_seconds).toBe(0);
    // 15 + 20 + 0 minutes.
    expect(await minutesUsed()).toBe(before + 35);
  });

  it('someone in the room, or LiveKit unreachable: kept, nothing billed; a provider with no listing is not read', async () => {
    const occupied = await call({ ageMin: 120 });
    await event(occupied, 'lk.participant_left', 100, { identity: 'visitor:v1' });
    fake.rooms.set(String((await stateOf(occupied)).provider_room_id), ['operator:o1']);
    const unknown = await call({ ageMin: 120 });
    await event(unknown, 'lk.participant_left', 100, { identity: 'visitor:v1' });
    fake.unreachable.add(String((await stateOf(unknown)).provider_room_id));
    const agora = await call({ ageMin: 120, provider: 'agora' });
    const before = await minutesUsed();

    expect(await sweep()).toEqual({ checked: 2, ended: 0, kept: 2 });
    for (const id of [occupied, unknown, agora]) expect((await stateOf(id)).state).toBe('active');
    expect(fake.closed).toEqual([]);
    expect(fake.operatorEvents).toEqual([]);
    expect(await minutesUsed()).toBe(before);
  });

  it('a recent sign of life keeps the call; recent, colleague and non-active calls are not the sweep\'s', async () => {
    const recentLeave = await call({ ageMin: 60 });
    await event(recentLeave, 'lk.participant_left', 5, { identity: 'visitor:v1' });
    const recentEvent = await call({ ageMin: 60 });
    await event(recentEvent, 'lk.participant_left', 30, { identity: 'visitor:v1' });
    await event(recentEvent, 'egress_updated', 2);
    const young = await call({ ageMin: 5 });
    const team = await call({ ageMin: 120, entrySource: 'team_call' });
    const connecting = await call({ ageMin: 120, state: 'connecting', connectedMin: null });
    const ids = [recentLeave, recentEvent, young, team, connecting];

    expect(await sweep()).toEqual({ checked: 2, ended: 0, kept: 2 });
    for (const [i, id] of ids.entries()) {
      expect((await stateOf(id)).state).toBe(['active', 'active', 'active', 'active', 'connecting'][i]);
    }
  });

  it('the leased pass runs the sweep', async () => {
    const id = await call({ ageMin: 40, room: null });
    await event(id, 'lk.participant_left', 20, { identity: 'visitor:v1' });
    const { runStaleActiveSweepOnce } = await import('../../../server/services/calls/staleActiveSweep.js');
    expect(await runStaleActiveSweepOnce(config)).toEqual({ checked: 1, ended: 1, kept: 0 });
  });
});
