// @vitest-environment node
/**
 * The store-signed routes (/api/commerce/events, /api/commerce/connection/*)
 * limit by client address before the signature is checked, and by
 * installation only after it checks out. Keyed on the unverified header, a
 * shopper who read a store's installation id from its pages could spend the
 * store's budget with bad requests (its real events then answered 429 until
 * the plugin dead-lettered them), and random ids escaped every limit.
 */
import type { AddressInfo } from 'node:net';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const verdict = vi.hoisted(() => ({ secret: null as string | null, ok: false }));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: { id: 'conn-1', workspace_id: 'ws-1', revoked_at: null, provider_type: 'woocommerce' }, error: null });
      return b;
    },
  }),
}));
vi.mock('../../../server/services/commerce/credentials.js', () => ({
  readInstallationSecret: async () => verdict.secret,
}));
vi.mock('../../../server/services/commerce/events.js', () => ({
  ingestCommerceEvent: async () => ({ status: 'processed' }),
}));
vi.mock('../../../server/services/commerce/pairing.js', () => ({
  runCapabilityHandshake: async () => {},
}));
vi.mock('../../../server/services/commerce/signing.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyIncomingSignature: async () => (verdict.ok ? { ok: true } : { ok: false, reason: 'bad_signature' }),
}));

// Fresh routers (and so fresh limiter counts) for every test.
let commerceEventsRouter: express.Router;
let commercePluginActionsRouter: express.Router;

async function withServer<T>(mount: (app: express.Express) => void, run: (url: string) => Promise<T>): Promise<T> {
  const app = express();
  mount(app);
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

function signedHeaders(installation: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-WebYar-Installation': installation,
    'X-WebYar-Timestamp': String(Math.floor(Date.now() / 1000)),
    'X-WebYar-Nonce': `nonce-${Math.random().toString(36).slice(2)}`,
    'X-WebYar-Signature': 'deadbeef',
    'X-WebYar-Protocol': 'webyar-commerce/1',
  };
}

async function hit(url: string, installation: string, times: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const res = await fetch(url, { method: 'POST', headers: signedHeaders(installation), body: '{"a":1}' });
    statuses.push(res.status);
    await res.arrayBuffer();
  }
  return statuses;
}

beforeEach(async () => {
  verdict.secret = null;
  verdict.ok = false;
  vi.resetModules();
  ({ commerceEventsRouter } = await import('../../../server/routes/commerce/events.js'));
  ({ commercePluginActionsRouter } = await import('../../../server/routes/commerce/pluginActions.js'));
});

describe('commerce event ingestion limits', () => {
  it('bad requests under a store\'s installation id do not spend that store\'s budget', async () => {
    verdict.secret = 'secret';
    await withServer((app) => app.use('/api/commerce/events', commerceEventsRouter), async (base) => {
      const statuses = await hit(`${base}/api/commerce/events`, 'inst-victim', 130);
      expect(statuses.every((s) => s === 400)).toBe(true);
    });
  });

  it('counts a store\'s own (verified) requests per installation', async () => {
    verdict.secret = 'secret';
    verdict.ok = true;
    await withServer((app) => app.use('/api/commerce/events', commerceEventsRouter), async (base) => {
      const statuses = await hit(`${base}/api/commerce/events`, 'inst-busy', 121);
      // Valid events pass the signature; the body is not an event (400).
      expect(statuses.slice(0, 120).every((s) => s === 400)).toBe(true);
      expect(statuses[120]).toBe(429);
    });
  });

  it('bounds one address however many installation ids it makes up', async () => {
    await withServer((app) => app.use('/api/commerce/events', commerceEventsRouter), async (base) => {
      const statuses: number[] = [];
      for (let i = 0; i < 601; i += 1) {
        const res = await fetch(`${base}/api/commerce/events`, { method: 'POST', headers: signedHeaders(`random-${i}`), body: '{}' });
        statuses.push(res.status);
        await res.arrayBuffer();
      }
      expect(statuses.slice(0, 600).every((s) => s === 401)).toBe(true);
      expect(statuses[600]).toBe(429);
    });
  }, 30_000);
});

describe('plugin action limits', () => {
  it('bad requests under a store\'s installation id do not spend that store\'s budget', async () => {
    verdict.secret = 'secret';
    await withServer((app) => app.use('/api/commerce/connection', commercePluginActionsRouter), async (base) => {
      const statuses = await hit(`${base}/api/commerce/connection/sync`, 'inst-victim', 15);
      expect(statuses.every((s) => s === 401)).toBe(true);
    });
  });

  it('counts verified requests per installation', async () => {
    verdict.secret = 'secret';
    verdict.ok = true;
    await withServer((app) => app.use('/api/commerce/connection', commercePluginActionsRouter), async (base) => {
      const statuses = await hit(`${base}/api/commerce/connection/test`, 'inst-busy', 11);
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });
});
