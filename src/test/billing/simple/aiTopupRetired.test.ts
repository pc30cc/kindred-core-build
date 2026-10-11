/**
 * The legacy Rial AI top-up (routes/aiBilling.ts) is retired while the simple
 * billing owns money: AI credit is bought as a pack there (phase 5, decision
 * D13). Its config, preview and checkout answer 410 BILLING_V2_RETIRED before
 * authorization or any database access. verify-callback stays mounted, so an
 * intent already paid is still credited; the AI summary still answers.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';

const spies = vi.hoisted(() => ({
  db: [] as string[],
  authorize: vi.fn(async (..._a: unknown[]) => ({ userId: 'u1', isAdmin: false, role: 'owner' as string | null })),
}));

function fakeClient() {
  const builder: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
        if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: null, error: null });
        return () => builder;
      },
    },
  );
  return {
    from(table: string) {
      spies.db.push(table);
      return builder;
    },
    rpc: async (name: string) => {
      spies.db.push(`rpc:${name}`);
      return { data: null, error: null };
    },
  };
}

vi.mock('../../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: spies.authorize,
}));

const { LEGACY_BILLING_ENABLED } = await import('../../../../shared/billingMode.js');
const { aiBillingRouter } = await import('../../../../server/routes/aiBilling.js');
const { billingRouter } = await import('../../../../server/routes/billing.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/ai-billing', aiBillingRouter);
app.use('/api/billing', billingRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

beforeEach(() => {
  spies.db.length = 0;
  spies.authorize.mockClear();
});

const RETIRED: Array<[method: string, path: string, body?: unknown]> = [
  ['GET', `/api/ai-billing/workspaces/${WS}/topup/config`],
  ['POST', `/api/ai-billing/workspaces/${WS}/topup/preview`, { amountToman: 100_000 }],
  ['POST', `/api/ai-billing/workspaces/${WS}/topup/checkout`, { amountToman: 100_000, callbackUrl: 'https://app.test/x' }],
];

describe('the legacy AI top-up is retired', () => {
  it('the flag is off', () => {
    expect(LEGACY_BILLING_ENABLED).toBe(false);
  });

  it.each(RETIRED)('%s %s answers 410 without authorizing or touching the database', async (method, path, body) => {
    const res = await call(method, path, body);
    expect(res.status).toBe(410);
    expect(JSON.parse(res.text)).toEqual({ error: 'BILLING_V2_RETIRED' });
    expect(spies.authorize).not.toHaveBeenCalled();
    expect(spies.db).toEqual([]);
  });
});

describe('what stays open', () => {
  it('verify-callback is still mounted: an intent already paid is still credited', async () => {
    const verify = await call('POST', '/api/billing/verify-callback', {});
    expect(verify.status).toBe(400);
    expect(JSON.parse(verify.text)).toEqual({ error: 'Missing workspaceId or provider' });
  });

  it('the AI routes that are not the top-up are not retired', async () => {
    // Authorization is reached (here it refuses), so the route is not the retired 410.
    spies.authorize.mockImplementationOnce(async (_req: unknown, res: unknown) => {
      (res as { status(c: number): { json(b: unknown): void } }).status(403).json({ error: 'FORBIDDEN' });
      return null as never;
    });
    const summary = await call('GET', `/api/ai-billing/workspaces/${WS}/summary`);
    expect(summary.status).toBe(403);
    expect(spies.authorize).toHaveBeenCalledTimes(1);
  });
});
