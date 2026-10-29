// @vitest-environment node
/**
 * Invitation mails are limited (platform:M6): each one is a mail From the
 * platform's own address to a person the inviter chose, so a workspace may
 * send 50 a day and one inviter 20 an hour, new invitations and resends
 * together (server/routes/workspaceInvitations.ts).
 *
 *  - the 21st invitation of one inviter in an hour is 429
 *    INVITATION_RATE_LIMITED with Retry-After, and the RPC is not called;
 *  - only invitations that were made count: a create the RPC refuses (a
 *    member who may not invite, a duplicate) and a replay use up nothing;
 *  - a resend counts like a new invitation;
 *  - the workspace's 50 a day hold across inviters.
 *
 * The router runs in-process; the session, the e-mail verification gate and
 * the idempotent RPC are stand-ins, and the data layer's rpc answers nothing
 * (the limits count in memory, as without migration 289d).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb } from '../conversations/fakeServiceDb';

const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  user: 'actor-1',
  outcome: 'ok' as 'ok' | 'refused' | 'replayed',
  calls: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({ requireUser: async () => state.user }));
vi.mock('../../../server/services/auth/sessions.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/auth/sessions.js')>()),
  verifyOriginForMutation: () => true,
}));
vi.mock('../../../server/services/auth/identity.js', () => ({ isEmailVerified: async () => true }));
vi.mock('../../../server/services/invitations/tokens.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/invitations/tokens.js')>()),
  resolveAppBaseUrl: async () => 'https://app.test',
}));
vi.mock('../../../server/services/invitations/idempotency.js', async (orig) => ({
  ...(await orig<typeof import('../../../server/services/invitations/idempotency.js')>()),
  runIdempotent: async (_c: unknown, call: { operation: string }) => {
    state.calls.push(call.operation);
    if (state.outcome === 'refused') {
      return { replayed: false, resultCode: 'ERROR', safeResult: {}, result: null, error: { message: 'FORBIDDEN_ROLE_ESCALATION' } };
    }
    if (state.outcome === 'replayed') return { replayed: true, resultCode: 'COMMITTED', safeResult: { id: 'i' }, result: null };
    return { replayed: false, resultCode: 'COMMITTED', safeResult: {}, result: { invitation_id: randomUUID(), status: 'pending' } };
  },
}));

const { workspaceInvitationsRouter } = await import('../../../server/routes/workspaceInvitations.js');
const { __resetEmailQuotaMemoryForTests } = await import('../../../server/services/email/sendQuota.js');

const app = express();
app.use((req, _res, next) => {
  Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k', corsOrigins: ['http://127.0.0.1'] } });
  next();
});
app.use(express.json());
app.use('/api/workspace-invitations', workspaceInvitationsRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';
const INVITATION = '33333333-3333-4333-8333-333333333333';

function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/workspace-invitations${path}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Origin: 'http://127.0.0.1' },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : {}, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const invite = (workspaceId = WS) => post('/', {
  workspaceId,
  firstName: 'Ana',
  lastName: 'Lee',
  email: `ana.${randomUUID().slice(0, 8)}@example.com`,
  memberType: 'staff',
  role: 'agent',
  requestId: randomUUID(),
});
const resend = () => post(`/${INVITATION}/resend`, { requestId: randomUUID() });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-29T09:00:00Z') });
  state.db = createFakeServiceDb();
  state.db.tables.workspace_invitations = [{ id: INVITATION, workspace_id: WS, invited_email_normalized: 'ana@example.com' }];
  state.user = 'actor-1';
  state.outcome = 'ok';
  state.calls.length = 0;
  __resetEmailQuotaMemoryForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe('invitation mails per inviter and per workspace', () => {
  it('20 an hour for one inviter, then 429 INVITATION_RATE_LIMITED without calling the RPC', async () => {
    for (let i = 0; i < 20; i += 1) expect((await invite()).status).toBe(201);
    const limited = await invite();
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: 'INVITATION_RATE_LIMITED' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(state.calls).toHaveLength(20);
    // Another inviter of the same workspace still may.
    state.user = 'actor-2';
    expect((await invite()).status).toBe(201);
  });

  it('a create the RPC refuses, and a replay, use up nothing', async () => {
    state.outcome = 'refused';
    for (let i = 0; i < 25; i += 1) expect((await invite()).status).toBe(403);
    state.outcome = 'replayed';
    for (let i = 0; i < 5; i += 1) expect((await invite()).status).toBe(409);
    state.outcome = 'ok';
    for (let i = 0; i < 20; i += 1) expect((await invite()).status).toBe(201);
    expect((await invite()).status).toBe(429);
  });

  it('a resend counts like a new invitation', async () => {
    for (let i = 0; i < 10; i += 1) expect((await invite()).status).toBe(201);
    for (let i = 0; i < 10; i += 1) expect((await resend()).status).toBe(200);
    expect((await resend()).status).toBe(429);
    expect((await invite()).status).toBe(429);
  });

  it('50 a day for the workspace, across inviters; another workspace is not touched', async () => {
    for (let i = 0; i < 50; i += 1) {
      state.user = `actor-${Math.floor(i / 10)}`;
      expect((await invite()).status).toBe(201);
    }
    state.user = 'actor-new';
    expect((await invite()).status).toBe(429);
    expect((await invite('22222222-2222-4222-8222-222222222222')).status).toBe(201);
  });
});
