// @vitest-environment node
/**
 * /api/email (server/routes/email.ts): no route sends what a caller
 * composes.
 *
 *  - POST /send and POST /send-channel answer 410 whatever is sent: the
 *    platform template or HTML of the caller's choice to any address, from
 *    the platform's own address, is gone (nothing called send-channel);
 *  - the two test buttons (/test-send, /test-offline-notice) need an owner
 *    or admin, mail only the caller's own VERIFIED address (a `to` in the
 *    body is refused by the schema), within 3 per member in ten minutes and
 *    10 per workspace in a day, and answer the provider's real result: 502
 *    with our error code when it did not take the mail;
 *  - the offline test is in the member's own language unless one is asked for.
 *
 * The router runs in-process; authorization, the identity, the mail service
 * and the data layer (whose rpc answers nothing, so the limits count in
 * memory) are stand-ins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFakeServiceDb, fakeServiceClient, type FakeServiceDb } from '../conversations/fakeServiceDb';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- parsed JSON, asserted on its shape
type Body = Record<string, any>;
const state = vi.hoisted(() => ({
  db: null as unknown as FakeServiceDb,
  role: 'owner' as string,
  user: 'u-1' as string,
  verified: true,
  email: 'me@example.com' as string | null,
  result: { success: true, provider: 'smtp' } as Record<string, unknown>,
  sent: [] as Array<Record<string, unknown>>,
  manageAsked: [] as boolean[],
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(state.db) }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async (_req: unknown, res: { status(n: number): { json(b: unknown): unknown } }, _ws: unknown, opts: { manage?: boolean } = {}) => {
    state.manageAsked.push(opts.manage === true);
    if (opts.manage && !['owner', 'admin'].includes(state.role)) {
      res.status(403).json({ error: 'Insufficient workspace permissions' });
      return null;
    }
    return { userId: state.user, isAdmin: false, role: state.role };
  },
}));
vi.mock('../../../server/services/auth/identity.js', () => ({
  findIdentityById: async (_c: unknown, id: string) => ({
    id, email: state.email, emailVerifiedAt: state.verified ? '2026-10-01T00:00:00Z' : null, status: 'active',
  }),
}));
vi.mock('../../../server/services/email/index.js', () => ({
  sendEmail: async (_c: unknown, request: Record<string, unknown>) => { state.sent.push(request); return state.result; },
}));
vi.mock('../../../server/services/operatorLocale.js', () => ({
  operatorLocale: async (_c: unknown, id: string) => (id === 'u-fa' ? 'fa' : 'en'),
}));
vi.mock('../../../server/services/auth-email.js', () => ({
  resolveWorkspaceAppUrl: async (_c: unknown, _ws: string, path: string) => `https://app.test${path}`,
}));

const { emailRouter } = await import('../../../server/routes/email.js');
const { __resetEmailQuotaMemoryForTests } = await import('../../../server/services/email/sendQuota.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/email', emailRouter);
const server = http.createServer(app).listen(0);

const WS = '11111111-1111-4111-8111-111111111111';
const WS2 = '22222222-2222-4222-8222-222222222222';

function post(path: string, body: unknown): Promise<{ status: number; body: Body; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/email${path}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, body: d ? JSON.parse(d) : null, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-29T09:00:00Z') });
  state.db = createFakeServiceDb();
  state.role = 'owner';
  state.user = 'u-1';
  state.verified = true;
  state.email = 'me@example.com';
  state.result = { success: true, provider: 'smtp' };
  state.sent.length = 0;
  state.manageAsked.length = 0;
  __resetEmailQuotaMemoryForTests();
});
afterEach(() => { vi.useRealTimers(); });

describe('the retired relays', () => {
  for (const path of ['/send', '/send-channel']) {
    it(`${path} answers 410 and sends nothing, whatever is in the body`, async () => {
      const res = await post(path, {
        workspaceId: WS, to: 'victim@example.com, other@example.com',
        templateSlug: 'password_reset', templateData: { action_url: 'https://evil.example/reset' },
        subject: 'Reset your password', html: '<a href="https://evil.example">reset</a>',
      });
      expect(res.status).toBe(410);
      expect(res.body).toEqual({ error: 'ARBITRARY_EMAIL_RELAY_RETIRED' });
      expect(state.sent).toEqual([]);
    });
  }
});

describe.each([
  ['/test-offline-notice', 'offline_message_received'],
  ['/test-send', 'email_test'],
])('POST %s', (path, slug) => {
  it('an owner: their own verified address only, the provider\'s answer, manage rights asked for', async () => {
    const res = await post(path, { workspaceId: WS });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, sent_to: 'me@example.com' });
    expect(state.manageAsked).toEqual([true]);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({ to: 'me@example.com', templateSlug: slug, workspaceId: WS });
  });

  it('a recipient in the body is refused, not used', async () => {
    const res = await post(path, { workspaceId: WS, to: 'stranger@example.com' });
    expect(res.status).toBe(400);
    expect(state.sent).toEqual([]);
  });

  it('a member who may not manage the workspace gets 403', async () => {
    state.role = 'agent';
    expect((await post(path, { workspaceId: WS })).status).toBe(403);
    expect(state.sent).toEqual([]);
  });

  it('an address not verified: 400 verified_email_required, nothing sent', async () => {
    state.verified = false;
    const res = await post(path, { workspaceId: WS });
    expect(res).toMatchObject({ status: 400, body: { error: 'verified_email_required' } });
    expect(state.sent).toEqual([]);
  });

  it('a failure is a failure: 502 with our code and reason, never ok', async () => {
    state.result = { success: false, provider: 'smtp', errorCode: 'auth', permanent: true, error: 'auth: the relay refused the sign-in' };
    const res = await post(path, { workspaceId: WS });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ success: false, sent_to: 'me@example.com', error: 'auth: the relay refused the sign-in', error_code: 'auth' });
  });

  it('3 per member in ten minutes, then 429 with Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) expect((await post(path, { workspaceId: WS })).status).toBe(200);
    const limited = await post(path, { workspaceId: WS2 });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('test_limit_reached');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(state.sent).toHaveLength(3);
    vi.setSystemTime(new Date('2026-10-29T09:11:00Z'));
    expect((await post(path, { workspaceId: WS })).status).toBe(200);
  });

  it('10 per workspace in a day, whoever asks', async () => {
    for (let i = 0; i < 10; i += 1) {
      state.user = `u-${i}`;
      expect((await post(path, { workspaceId: WS })).status).toBe(200);
    }
    state.user = 'u-new';
    expect((await post(path, { workspaceId: WS })).status).toBe(429);
    expect((await post(path, { workspaceId: WS2 })).status).toBe(200);
  });
});

describe('the offline test\'s language', () => {
  it('the member\'s own without one asked for; an explicit one wins', async () => {
    state.user = 'u-fa';
    await post('/test-offline-notice', { workspaceId: WS });
    state.user = 'u-en';
    await post('/test-offline-notice', { workspaceId: WS });
    await post('/test-offline-notice', { workspaceId: WS, locale: 'tr' });
    expect(state.sent.map((m) => m.locale)).toEqual(['fa', 'en', 'tr']);
  });

  it('nothing a visitor could type is offered to the subject: the sample is in the HTML part only', async () => {
    await post('/test-offline-notice', { workspaceId: WS });
    expect(state.sent[0]).toMatchObject({
      templateData: expect.objectContaining({ contact_name: '', message_body: '' }),
      htmlData: expect.objectContaining({ contact_name: 'Test Visitor' }),
    });
  });
});
