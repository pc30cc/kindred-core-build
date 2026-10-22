// @vitest-environment node
/**
 * "Away from desk" chosen by the operator (R-26, migration 282), server side:
 *
 *   - PATCH /api/availability stores `manual_away` and GET returns it; the
 *     live status says offline with the reason `manual_away`; a client that
 *     writes only force_offline (the desktop and phone apps) ends the away;
 *   - customer-facing availability reads it as unavailable ("Appear offline"
 *     and invisible still win), so the widget is not "online" because of an
 *     away operator;
 *   - live presence: teammates see a connected away operator as away (and the
 *     legacy `state` as offline), routing reads `manualAway` and gives them no
 *     tier at all, whatever their activity.
 *
 * The REAL route and services run against an in-memory data layer; the live
 * connection is a fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb } from '../conversations/fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  user: '',
  connected: new Set<string>(),
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  requireUser: async () => state.user,
}));
vi.mock('../../../server/lib/cacheBus.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/cacheBus.js')>()),
  publishCacheInvalidation: () => undefined,
}));
vi.mock('../../../server/services/widget/operatorPresenceSource.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresenceSource.js')>()),
  getConnectedOperators: async (_c: unknown, _ws: string, ids: string[]) => ({
    mode: 'realtime', connected: new Set(ids.filter((id) => state.connected.has(id))), lastSeen: new Map(), degraded: false,
  }),
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({ enabled: false, kb: null, contact: null, member: null, conversation: null }),
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  createStorageUrlResolver: () => ({}),
  userAvatarUrlMap: async () => new Map(),
}));

const { availabilityRouter, availabilityPatchOf } = await import('../../../server/routes/availability.js');
const { computeCustomerAvailability, listCustomerAvailableOperators } = await import('../../../server/services/widget/customerAvailability.js');
const { readRoutingPresence, listWorkspacePresence } = await import('../../../server/services/widget/operatorPresence.js');
const { recordOperatorActivity, resetOperatorActivity } = await import('../../../server/services/widget/operatorActivity.js');
const { routingTierOf, splitPresenceTiers } = await import('../../../server/services/chatRouting.js');

const config = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
app.use('/api/availability', availabilityRouter);

const WS = randomUUID();
const SARA = randomUUID();
const REZA = randomUUID();
const open = { force_offline: false, available_when_using_app: true, schedule_enabled: false, timezone: 'UTC', weekly_schedule: {} };

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: SARA, role: 'agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: REZA, role: 'support_agent', suspended_at: null, receives_chats: true },
  ];
  state.db.tables.profiles = [{ id: SARA, full_name: 'Sara' }, { id: REZA, full_name: 'Reza' }];
  state.db.tables.user_availability_prefs = [];
  state.user = SARA;
  state.connected = new Set([SARA, REZA]);
  resetOperatorActivity();
});

const prefsOf = (user: string) =>
  state.db.tables.user_availability_prefs.find((r) => r.user_id === user && r.workspace_id === null);

describe('PATCH /api/availability: "Away from desk"', () => {
  it('is stored and returned, and the live status says offline because of it', async () => {
    const res = await request(app).patch('/api/availability').send({ force_offline: false, available_when_using_app: true, manual_away: true });
    expect(res.status).toBe(200);
    expect(res.body.prefs.manual_away).toBe(true);
    expect(res.body.status).toEqual({ state: 'offline', reason: 'manual_away' });
    expect(prefsOf(SARA)?.manual_away).toBe(true);
    const read = await request(app).get('/api/availability');
    expect(read.body.prefs.manual_away).toBe(true);
    expect(read.body.status.reason).toBe('manual_away');
  });

  it('Online from the menu ends it', async () => {
    await request(app).patch('/api/availability').send({ manual_away: true });
    const res = await request(app).patch('/api/availability').send({ force_offline: false, available_when_using_app: true, manual_away: false });
    expect(res.body.prefs.manual_away).toBe(false);
    expect(res.body.status).toEqual({ state: 'online', reason: 'available_when_using_app' });
  });

  it('a client that knows only force_offline (desktop, phone, "Appear offline") ends it either way', async () => {
    await request(app).patch('/api/availability').send({ manual_away: true });
    const online = await request(app).patch('/api/availability').send({ force_offline: false });
    expect(online.body.prefs.manual_away).toBe(false);
    expect(online.body.status.state).toBe('online');
    await request(app).patch('/api/availability').send({ manual_away: true });
    const offline = await request(app).patch('/api/availability').send({ force_offline: true });
    expect(offline.body.prefs).toMatchObject({ force_offline: true, manual_away: false });
    // A schedule change leaves it alone.
    await request(app).patch('/api/availability').send({ force_offline: false, manual_away: true });
    const schedule = await request(app).patch('/api/availability').send({ schedule_enabled: true });
    expect(schedule.body.prefs.manual_away).toBe(true);
  });

  it('refuses a value that is not a boolean', async () => {
    expect((await request(app).patch('/api/availability').send({ manual_away: 'yes' })).status).toBe(400);
  });

  it('availabilityPatchOf: force_offline without manual_away clears it; with it, both are kept', () => {
    expect(availabilityPatchOf({ force_offline: false })).toEqual({ force_offline: false, manual_away: false });
    expect(availabilityPatchOf({ force_offline: false, manual_away: true })).toEqual({ force_offline: false, manual_away: true });
    expect(availabilityPatchOf({ schedule_enabled: true })).toEqual({ schedule_enabled: true });
  });
});

describe('customer-facing availability', () => {
  it('away is unavailable; "Appear offline" and invisible still win over it', () => {
    expect(computeCustomerAvailability({ ...open, manual_away: true })).toEqual({ availability: 'unavailable', manual: 'away', reason: 'manual_away' });
    expect(computeCustomerAvailability({ ...open, manual_away: true, force_offline: true }).reason).toBe('manual_offline');
    expect(computeCustomerAvailability({ ...open, manual_away: true, available_when_using_app: false }).reason).toBe('manual_invisible');
    expect(computeCustomerAvailability({ ...open, manual_away: false }).availability).toBe('available');
    // A row from before 282 (no column): as before.
    expect(computeCustomerAvailability(open).availability).toBe('available');
  });

  it('an away operator does not make the widget "online"', async () => {
    state.db.tables.user_availability_prefs = [
      { user_id: SARA, workspace_id: null, ...open, manual_away: true },
      { user_id: REZA, workspace_id: null, ...open, force_offline: true },
    ];
    const { memberCount, available } = await listCustomerAvailableOperators(config, WS);
    expect(memberCount).toBe(2);
    expect(available).toEqual([]);
    state.db.tables.user_availability_prefs[1].force_offline = false;
    expect((await listCustomerAvailableOperators(config, WS)).available.map((a) => a.user_id)).toEqual([REZA]);
  });
});

describe('live presence and routing', () => {
  it('teammates see a connected away operator as away (legacy state offline); routing gives them no tier', async () => {
    state.db.tables.user_availability_prefs = [{ user_id: SARA, workspace_id: null, ...open, manual_away: true }];
    // Sara is interacting right now: still away by her own choice.
    recordOperatorActivity(WS, SARA, Date.now());
    recordOperatorActivity(WS, REZA, Date.now());
    const team = await listWorkspacePresence(config, WS);
    const sara = team.find((p) => p.user_id === SARA)!;
    expect(sara).toMatchObject({ presence_state: 'away', reason: 'manual_away', manual: 'away', customer_availability: 'unavailable', state: 'offline', connected: true });
    expect(team.find((p) => p.user_id === REZA)).toMatchObject({ presence_state: 'active', state: 'online' });

    const routing = await readRoutingPresence(config, WS, [SARA, REZA]);
    expect(routing.get(SARA)).toMatchObject({ state: 'away', manualAway: true });
    expect(routing.get(REZA)?.manualAway).toBeUndefined();
    expect(routingTierOf(routing.get(SARA))).toBeNull();
    expect(routingTierOf(routing.get(REZA))).toBe('active');
    expect(splitPresenceTiers([SARA, REZA], routing)).toEqual({ active: [REZA], away: [] });
  });

  it('not connected and away: offline', async () => {
    state.db.tables.user_availability_prefs = [{ user_id: SARA, workspace_id: null, ...open, manual_away: true }];
    state.connected = new Set([REZA]);
    const team = await listWorkspacePresence(config, WS);
    expect(team.find((p) => p.user_id === SARA)).toMatchObject({ presence_state: 'offline', reason: 'manual_away' });
    expect(routingTierOf((await readRoutingPresence(config, WS, [SARA])).get(SARA))).toBeNull();
  });

  it('routingTierOf: manualAway wins over any state', () => {
    const now = Date.now();
    expect(routingTierOf({ state: 'active', lastActivityAt: now, manualAway: true }, now)).toBeNull();
    expect(routingTierOf({ state: 'away', lastActivityAt: now - 60_000, manualAway: true }, now)).toBeNull();
    expect(routingTierOf({ state: 'away', lastActivityAt: now - 60_000 }, now)).toBe('away');
  });
});
