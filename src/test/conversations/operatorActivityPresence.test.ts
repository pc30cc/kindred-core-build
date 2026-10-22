// @vitest-environment node
/**
 * The presence dashboards say what is true (R-25, server side):
 *
 *   - Operator Activity: "online now" counts who has a panel or the app
 *     connected right now (live presence, as routing reads it), not merely
 *     who is "available" in their settings; each operator carries their
 *     `presence_state`; and the report says its online time is not recorded
 *     (`online_time_tracked: false`) instead of showing zeros as accurate.
 *   - The AI Agent's activation page: the availability carries `status` (the
 *     page reads it; only `state` was sent, so it always said "Unknown") and
 *     how many of the members who receive chats are available, of how many.
 *
 * The REAL route and services run against an in-memory data layer; live
 * presence is a fake.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  presence: new Map<string, string>(),
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'owner', isAdmin: false, role: 'owner' }),
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => rows,
}));
vi.mock('../../../server/services/widget/operatorPresence.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/widget/operatorPresence.js')>()),
  readRoutingPresence: async (_c: unknown, _ws: string, ids: string[]) =>
    new Map(ids.filter((id) => state.presence.has(id)).map((id) => [id, { state: state.presence.get(id)!, lastActivityAt: Date.now() }])),
}));
vi.mock('../../../server/services/billing/locks/state.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({ enabled: false, kb: null, contact: null, member: null, conversation: null }),
}));

const { operatorActivityRouter } = await import('../../../server/routes/operatorActivity.js');
const { describeOperatorAvailability } = await import('../../../server/services/ai-agent/availability.js');

const config = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: config }); next(); });
app.use('/api/operator-activity', operatorActivityRouter);
const server = http.createServer(app).listen(0);

const WS = randomUUID();
const SARA = randomUUID();
const REZA = randomUUID();
const NIMA = randomUUID();
const SEO = randomUUID();

function stats(): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/operator-activity/${WS}/stats?days=7` }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(d || '{}') }));
    }).on('error', reject);
  });
}

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.presence.clear();
  state.db.tables.workspace_members = [
    { workspace_id: WS, user_id: SARA, role: 'agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: REZA, role: 'agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: NIMA, role: 'support_agent', suspended_at: null, receives_chats: true },
    { workspace_id: WS, user_id: SEO, role: 'seo_manager', suspended_at: null, receives_chats: true },
  ];
  state.db.tables.profiles = [SARA, REZA, NIMA, SEO].map((id) => ({ id, full_name: id.slice(0, 4), email: null }));
  // Nobody set a status: everyone is "available" by their settings.
  state.db.tables.user_availability_prefs = [];
});

describe('Operator Activity: who is online now', () => {
  it('counts the connected (active or away), not everyone available in their settings; says online time is not recorded', async () => {
    state.presence.set(SARA, 'active');
    state.presence.set(REZA, 'away');
    state.presence.set(NIMA, 'disconnected');
    const res = await stats();
    expect(res.status).toBe(200);
    expect(res.body.online_time_tracked).toBe(false);
    expect(res.body.totals).toMatchObject({ online_now: 2, available_now: 4 });
    const byId = Object.fromEntries((res.body.operators as Row[]).map((o) => [o.user_id, o]));
    expect(byId[SARA]).toMatchObject({ presence_state: 'active', current_state: 'online' });
    expect(byId[REZA]).toMatchObject({ presence_state: 'away' });
    expect(byId[NIMA]).toMatchObject({ presence_state: 'disconnected', current_state: 'online' });
    expect(byId[SEO]).toMatchObject({ presence_state: 'offline' });
  });
});

describe('the AI activation page\'s availability', () => {
  it('carries `status` as well as `state`, and how many of the members who receive chats are available, of how many', async () => {
    const online = await describeOperatorAvailability(config, WS);
    expect(online).toMatchObject({ state: 'online', status: 'online', online_count: 3, total_count: 3 });
    // Two go offline by hand; the SEO manager never counts.
    state.db.tables.user_availability_prefs = [SARA, REZA].map((user_id) => ({ user_id, workspace_id: null, force_offline: true }));
    expect(await describeOperatorAvailability(config, WS)).toMatchObject({ status: 'online', online_count: 1, total_count: 3 });
    state.db.tables.user_availability_prefs!.push({ user_id: NIMA, workspace_id: null, force_offline: true });
    expect(await describeOperatorAvailability(config, WS)).toMatchObject({ state: 'offline', status: 'offline', online_count: 0, total_count: 3 });
  });
});
