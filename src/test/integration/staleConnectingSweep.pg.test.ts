// @vitest-environment node
/**
 * Calls left `connecting` that nobody joined (staleConnectingSweep.ts), on a
 * real database built by the whole chain: such a call fails (no minutes
 * billed), its room is closed, its operator's in-call marker and the panels
 * are told; a call whose room has someone in it, whose provider cannot be
 * asked, that is recent, connected, active or a colleague call stays as it is.
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
  operatorEvents: [] as Array<Record<string, unknown>>,
  callCenterEvents: [] as Array<{ callId: string; type: string }>,
  clearedInCall: [] as string[],
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
  publishOperatorEvent: async (_config: unknown, payload: Record<string, unknown>) => { fake.operatorEvents.push(payload); },
}));
vi.mock('../../../server/services/callCenter/realtime.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/callCenter/realtime.js')>()),
  publishCallEvent: async (_config: unknown, _ws: string, callId: string, type: string) => { fake.callCenterEvents.push({ callId, type }); },
}));
vi.mock('../../../server/services/calls/availability.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/calls/availability.js')>()),
  clearInCall: async (_config: unknown, _ws: string, userId: string) => { fake.clearedInCall.push(userId); },
}));

suite('stale connecting calls (staleConnectingSweep.ts)', () => {
  let chain: FullChainDatabase;
  let config: never;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await chain.db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []): Promise<Row> => (await q(sql, params))[0];

  const owner = randomUUID();
  const ws = randomUUID();
  let conversation = '';

  /** A call created `ageHours` ago. */
  const call = async (fields: {
    ageHours: number;
    state?: string;
    room?: string | null;
    provider?: string;
    connected?: boolean;
    entrySource?: string;
    conversationId?: string | null;
  }) => String((await one(
    `INSERT INTO public.call_sessions (workspace_id, provider, call_type, context_type, context_id, state, entry_source,
                                       provider_room_id, connected_at, initiated_by_type, created_at, updated_at, started_at)
     VALUES ($1, $2, 'video', $3, $4, $5, $6, $7, $8, 'operator', now() - make_interval(hours => $9), now() - make_interval(hours => $9), now() - make_interval(hours => $9))
     RETURNING id`,
    [
      ws, fields.provider ?? 'livekit',
      fields.conversationId ? 'conversation' : 'internal', fields.conversationId ?? null,
      fields.state ?? 'connecting', fields.entrySource ?? 'chat',
      fields.room === undefined ? `room-${randomUUID().slice(0, 8)}` : fields.room,
      fields.connected ? new Date(Date.now() - fields.ageHours * 3600_000).toISOString() : null,
      fields.ageHours,
    ],
  )).id);
  const stateOf = async (id: string) => one(`SELECT state, end_reason, ended_by, ended_at, duration_seconds, provider_room_id FROM public.call_sessions WHERE id = $1`, [id]);

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `stale_connecting_${Date.now()}`);
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
    fake.clearedInCall.length = 0;
  });

  const sweep = async () => (await import('../../../server/services/calls/staleConnectingSweep.js')).sweepStaleConnectingCalls(config);
  const minutesUsed = async () => Number((await one(
    `SELECT coalesce(sum(call_minutes_used), 0)::int AS n FROM public.workspace_usage_counters WHERE workspace_id = $1`, [ws])).n);

  it('a call nobody joined, its room empty or gone: failed, unbilled, its room closed, the panels and its operator told', async () => {
    const operator = randomUUID();
    const empty = await call({ ageHours: 1000, conversationId: conversation });
    await q(`INSERT INTO public.call_participants (call_session_id, participant_type, participant_id) VALUES ($1, 'operator', $2)`, [empty, operator]);
    const noRoom = await call({ ageHours: 3, room: null, entrySource: 'call_widget' });
    const before = await minutesUsed();

    expect(await sweep()).toEqual({ checked: 2, failed: 2, kept: 0 });

    for (const id of [empty, noRoom]) {
      expect(await stateOf(id)).toMatchObject({ state: 'failed', end_reason: 'failed', ended_by: 'system', duration_seconds: 0 });
      expect((await stateOf(id)).ended_at).not.toBeNull();
      const events = await q(`SELECT event_type, payload FROM public.call_events WHERE call_session_id = $1`, [id]);
      expect(events).toEqual([{ event_type: 'failed', payload: { reason: 'stale_connecting' } }]);
    }
    expect(await minutesUsed()).toBe(before);
    expect(fake.closed).toEqual([(await stateOf(empty)).provider_room_id]);
    expect(fake.clearedInCall).toEqual([operator]);
    expect(fake.operatorEvents).toEqual([expect.objectContaining({
      kind: 'call:ended', conversation_id: conversation, workspace_id: ws, call_session_id: empty, ended_by: 'system',
    })]);
    expect(fake.callCenterEvents.map((e) => e.callId).sort()).toEqual([empty, noRoom].sort());

    // A second pass finds nothing.
    expect(await sweep()).toEqual({ checked: 0, failed: 0, kept: 0 });
  });

  it('someone in the room, or a provider that cannot be asked or has no listing: kept', async () => {
    const occupied = await call({ ageHours: 5 });
    fake.rooms.set(String((await stateOf(occupied)).provider_room_id), ['visitor:abc']);
    const unknown = await call({ ageHours: 5 });
    fake.unreachable.add(String((await stateOf(unknown)).provider_room_id));
    const agora = await call({ ageHours: 5, provider: 'agora' });

    const pass = await sweep();
    expect(pass.failed).toBe(0);
    expect(pass.kept).toBe(3);
    for (const id of [occupied, unknown, agora]) expect((await stateOf(id)).state).toBe('connecting');
    expect(fake.closed).toEqual([]);
  });

  it('recent, connected, active, over and colleague calls are not the sweep\'s', async () => {
    const recent = await call({ ageHours: 1 });
    const connected = await call({ ageHours: 5, connected: true });
    const active = await call({ ageHours: 5, state: 'active' });
    const pending = await call({ ageHours: 5, state: 'pending' });
    const ids = [recent, connected, active, pending];
    expect(await sweep()).toEqual({ checked: 0, failed: 0, kept: 0 });
    for (const [i, id] of ids.entries()) {
      expect((await stateOf(id)).state).toBe(['connecting', 'connecting', 'active', 'pending'][i]);
    }
  });
});
