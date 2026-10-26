// @vitest-environment node
/**
 * Operator Activity → "Closed automatically" (migration 284), the server's
 * half: GET /api/operator-activity/:ws/stats tells an operator's resolve or
 * close from the system's close after the quiet period
 * (shared/inactivityClose.ts conversationEndOf):
 *
 *   - conversations_resolved counts resolved, closed by an operator (or by
 *     an older server, without markers) and resolved-then-closed-by-the-
 *     system: still that operator's resolve;
 *   - conversations_auto_closed counts the system's closes of open or
 *     pending conversations;
 *   - both per operator and in the totals.
 *
 * The REAL route runs against an in-memory data layer.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb, type Row } from './fakeServiceDb';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Body = Record<string, any>;
const state = vi.hoisted(() => ({ db: null as unknown as FakeServiceDb }));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'owner', isAdmin: false, role: 'owner' }),
}));
vi.mock('../../../server/services/storage/urlResolver.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/storage/urlResolver.js')>()),
  hydrateUserAvatars: async (_c: unknown, rows: Row[]) => rows,
}));

const { operatorActivityRouter } = await import('../../../server/routes/operatorActivity.js');
const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } }); next(); });
app.use('/api/operator-activity', operatorActivityRouter);
const server = http.createServer(app).listen(0);

const WS = randomUUID();
const SARA = randomUUID();
const REZA = randomUUID();

function stats(): Promise<{ status: number; body: Body }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/operator-activity/${WS}/stats?days=7` }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: JSON.parse(d || '{}') }));
    }).on('error', reject);
  });
}
const conversation = (assigned_to: string | null, status: string, metadata: Row = {}): Row => ({
  id: randomUUID(), workspace_id: WS, assigned_to, status, metadata, created_at: new Date(Date.now() - 86_400_000).toISOString(),
});

beforeEach(() => {
  state.db = createFakeServiceDb();
  state.db.tables.workspace_members = [{ workspace_id: WS, user_id: SARA, role: 'agent' }, { workspace_id: WS, user_id: REZA, role: 'agent' }];
  state.db.tables.profiles = [{ id: SARA, full_name: 'Sara', email: 's@x.test' }, { id: REZA, full_name: 'Reza', email: 'r@x.test' }];
});

describe('GET …/stats: resolved and closed automatically', () => {
  it('resolved, closed by an operator, closed by the system from open, and from resolved: resolved 3, closed automatically 1', async () => {
    state.db.tables.conversations = [
      conversation(SARA, 'resolved'),
      conversation(SARA, 'closed', { closed_reason: 'operator', closed_by: 'agent', closed_from: 'open' }),
      conversation(SARA, 'closed', { closed_reason: 'inactivity', closed_by: 'system', closed_from: 'open' }),
      conversation(SARA, 'closed', { closed_reason: 'inactivity', closed_by: 'system', closed_from: 'resolved' }),
      conversation(SARA, 'open'),
      // A pending one the system closed counts as automatic too; a close by
      // an older server (no markers) is the operator's.
      conversation(REZA, 'closed', { closed_reason: 'inactivity', closed_from: 'pending' }),
      conversation(REZA, 'closed'),
      // Nobody's (the AI's): in no operator's row.
      conversation(null, 'closed', { closed_reason: 'inactivity', closed_from: 'open' }),
    ];
    const res = await stats();
    expect(res.status).toBe(200);
    const byId = Object.fromEntries((res.body.operators as Row[]).map((o) => [o.user_id, o]));
    expect(byId[SARA]).toMatchObject({ conversations_assigned: 5, conversations_resolved: 3, conversations_auto_closed: 1 });
    expect(byId[REZA]).toMatchObject({ conversations_assigned: 2, conversations_resolved: 1, conversations_auto_closed: 1 });
    expect(res.body.totals).toMatchObject({ conversations_assigned: 7, conversations_resolved: 4, conversations_auto_closed: 2 });
  });

  it('markers a reopen left behind (status open or resolved) count as nothing automatic', async () => {
    state.db.tables.conversations = [
      conversation(SARA, 'open', { closed_reason: 'inactivity', closed_from: 'open' }),
      conversation(SARA, 'resolved', { closed_reason: 'inactivity', closed_from: 'open' }),
    ];
    const byId = Object.fromEntries(((await stats()).body.operators as Row[]).map((o) => [o.user_id, o]));
    expect(byId[SARA]).toMatchObject({ conversations_resolved: 1, conversations_auto_closed: 0 });
  });
});
