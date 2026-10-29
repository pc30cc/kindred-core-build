// @vitest-environment node
/**
 * The public reset and verification forms (POST /api/auth-email/send-reset,
 * /send-verification, /resend-verification) tell nobody whether an account
 * exists, and cannot mail-bomb one:
 *
 *  - every request that names an address gets `{ success: true }` at once,
 *    before the account is even looked up (the lookup is held here until
 *    the answer has arrived), so the answer's time and body are the same for
 *    an unknown address, a known one, a verified one and a disabled one;
 *  - afterwards: an unknown address, a disabled account and (verification)
 *    an already verified one get nothing; the others get their link;
 *  - per account: one link of a kind a minute and five an hour, whoever
 *    asks for them.
 *
 * The router runs in-process; the identity lookup and the link senders are
 * stand-ins, and the data layer's rpc answers nothing (the limits count in
 * memory, as without migration 289d).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createFakeServiceDb, fakeServiceClient } from '../conversations/fakeServiceDb';

type Identity = { id: string; email: string; fullName: string | null; emailVerifiedAt: string | null; status: 'active' | 'disabled' };
const state = vi.hoisted(() => ({
  identities: new Map<string, Identity>(),
  gate: null as Promise<void> | null,
  lookups: [] as string[],
  resets: [] as Array<Record<string, unknown>>,
  verifies: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeServiceClient(createFakeServiceDb()) }));
vi.mock('../../../server/services/auth/identity.js', () => ({
  findIdentityByEmail: async (_c: unknown, email: string) => {
    state.lookups.push(email);
    if (state.gate) await state.gate;
    return state.identities.get(email.trim().toLowerCase()) ?? null;
  },
  findIdentityById: async () => null,
}));
vi.mock('../../../server/services/auth-email.js', () => ({
  issueRecoveryEmail: async (_c: unknown, o: Record<string, unknown>) => { state.resets.push(o); return { success: true }; },
  issueVerificationEmail: async (_c: unknown, o: Record<string, unknown>) => { state.verifies.push(o); return { success: true }; },
}));

const { authEmailRouter } = await import('../../../server/routes/auth-email.js');
const { backgroundTasksSettled } = await import('../../../server/services/jobs/background.js');
const { __resetEmailQuotaMemoryForTests } = await import('../../../server/services/email/sendQuota.js');

const app = express();
app.use((req, _res, next) => { Object.assign(req, { serverConfig: { supabaseUrl: 'https://x.test', supabaseServiceRoleKey: 'k' } }); next(); });
app.use(express.json());
app.use('/api/auth-email', authEmailRouter);
const server = http.createServer(app).listen(0);

function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: `/api/auth-email${path}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: d }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const person = (email: string, over: Partial<Identity> = {}): Identity => ({
  id: `id-${email}`, email, fullName: 'Sara', emailVerifiedAt: null, status: 'active', ...over,
});
const NOW = Date.parse('2026-10-29T09:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) });
  state.identities = new Map([
    ['known@example.com', person('known@example.com')],
    ['verified@example.com', person('verified@example.com', { emailVerifiedAt: '2026-10-01T00:00:00Z' })],
    ['disabled@example.com', person('disabled@example.com', { status: 'disabled' })],
  ]);
  state.gate = null;
  state.lookups.length = 0;
  state.resets.length = 0;
  state.verifies.length = 0;
  __resetEmailQuotaMemoryForTests();
});
afterEach(async () => {
  await backgroundTasksSettled();
  vi.useRealTimers();
});

const ROUTES = ['/send-reset', '/send-verification', '/resend-verification'] as const;
const ADDRESSES = ['nobody@example.com', 'known@example.com', 'verified@example.com', 'disabled@example.com'];

describe('the answer says nothing about the account', () => {
  for (const route of ROUTES) {
    it(`${route}: the same body for every address, sent before the account is looked up`, async () => {
      let open!: () => void;
      state.gate = new Promise<void>((r) => { open = r; });
      const answers = [];
      for (const email of ADDRESSES) answers.push(await post(route, { email, locale: 'fa' }));
      expect(answers.map((a) => [a.status, a.text])).toEqual(ADDRESSES.map(() => [200, '{"success":true}']));
      // Every answer arrived while the lookups were still held.
      open();
      await backgroundTasksSettled();
      expect(state.lookups).toEqual(ADDRESSES);
    });
  }

  it('a request without an address is still a 400', async () => {
    expect((await post('/send-reset', {})).status).toBe(400);
    expect((await post('/send-verification', { email: 42 })).status).toBe(400);
    await backgroundTasksSettled();
    expect(state.lookups).toEqual([]);
  });
});

describe('who gets a link afterwards', () => {
  it('reset: a known account, not an unknown address or a disabled account', async () => {
    for (const email of ADDRESSES) await post('/send-reset', { email, locale: 'fa' });
    await backgroundTasksSettled();
    expect(state.resets.map((o) => o.email)).toEqual(['known@example.com', 'verified@example.com']);
    expect(state.resets[0]).toMatchObject({ userId: 'id-known@example.com', locale: 'fa' });
  });

  it('verification: only an account that still needs it', async () => {
    for (const email of ADDRESSES) await post('/send-verification', { email });
    await backgroundTasksSettled();
    expect(state.verifies.map((o) => o.email)).toEqual(['known@example.com']);
  });
});

describe('per account, whoever asks', () => {
  it('one link a minute', async () => {
    await post('/send-reset', { email: 'known@example.com' });
    await post('/send-reset', { email: 'KNOWN@example.com' });
    await backgroundTasksSettled();
    expect(state.resets).toHaveLength(1);
    vi.setSystemTime(NOW + 61_000);
    await post('/send-reset', { email: 'known@example.com' });
    await backgroundTasksSettled();
    expect(state.resets).toHaveLength(2);
  });

  it('five an hour, then nothing until the hour is over; each kind counted on its own', async () => {
    for (let i = 0; i < 8; i += 1) {
      vi.setSystemTime(NOW + i * 61_000);
      await post('/send-reset', { email: 'known@example.com' });
      await backgroundTasksSettled();
    }
    expect(state.resets).toHaveLength(5);
    // The verification link is its own kind.
    await post('/resend-verification', { email: 'known@example.com' });
    await backgroundTasksSettled();
    expect(state.verifies).toHaveLength(1);
    vi.setSystemTime(NOW + 61 * 60_000);
    await post('/send-reset', { email: 'known@example.com' });
    await backgroundTasksSettled();
    expect(state.resets).toHaveLength(6);
  });
});
