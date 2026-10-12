/**
 * The payment gateways' webhook (server/routes/billing.ts) is public, so it
 * fails closed:
 *
 *   - an unknown provider, a provider with no signed webhook contract, an
 *     empty body or a signature no config verifies is refused, untouched;
 *   - the exact raw bytes are verified;
 *   - an event is pinned to the workspace whose config verified it; a payload
 *     naming another workspace, or two configs that both verify, are refused;
 *   - a stable provider event id is required, the event is claimed before any
 *     money moves, a replay is acknowledged as a duplicate, and a failure is
 *     marked failed so the provider retries;
 *   - an event naming no account payment and no card (for example a late
 *     event about a billing v2 payment intent, removed in phase 7A) is
 *     acknowledged and logged REVIEW, and nothing is applied.
 *
 * Billing v2's customer and admin routes, which this suite used to cover,
 * were removed in phase 7A (v2Removed.test.ts checks they answer 404).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const PAY = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  stripeVerify: vi.fn(),
  claimed: new Set<string>(),
  claimThrows: false,
  claimInFlight: false,
  claimSpy: vi.fn(),
  finalizeSpy: vi.fn(),
  accountWebhook: vi.fn(async (..._a: unknown[]) => 'settled'),
  readAccountPayment: vi.fn(async (..._a: unknown[]) => null as unknown),
  workspaceConfigs: [] as Array<{ workspace_id: string | null; config: unknown }>,
  platformConfig: null as Record<string, unknown> | null,
}));

function fakeClient() {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === 'provider_configs' ? h.workspaceConfigs : [], error: null });
      return b;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../server/services/billing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/index.js')>()),
  getProvider: (name: string) =>
    name === 'stripe'
      ? { name, capabilities: {}, verifyWebhook: h.stripeVerify }
      : name === 'zarinpal'
        ? { name, capabilities: {}, verifyWebhook: vi.fn() }
        : name === 'paytr'
          ? { name, capabilities: {}, webhookAckBody: 'OK', verifyWebhook: h.stripeVerify }
          : null,
  resolvePlatformBillingConfig: async (_u: string, _k: string, name: string) =>
    h.platformConfig && h.platformConfig.provider === name ? h.platformConfig : null,
  claimBillingWebhookEvent: async (_u: string, _k: string, input: { providerName: string; providerEventId: string }) => {
    h.claimSpy(input);
    if (h.claimThrows) throw new Error('claim failed');
    if (h.claimInFlight) return { claimed: false, inFlight: true };
    const key = `${input.providerName}:${input.providerEventId}`;
    if (h.claimed.has(key)) return { claimed: false, duplicate: true };
    h.claimed.add(key);
    return { claimed: true, eventRowId: `row_${h.claimed.size}` };
  },
  finalizeBillingWebhookEvent: async (...a: unknown[]) => {
    h.finalizeSpy(...a);
  },
}));
vi.mock('../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/account/index.js')>()),
  readAccountPayment: h.readAccountPayment,
  findAccountPaymentByProviderPayment: async () => null,
  handleAccountPaymentWebhook: h.accountWebhook,
}));

const { billingWebhookRouter } = await import('../../../server/routes/billing.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use('/api/billing/webhook', billingWebhookRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

const BODY = JSON.stringify({ id: 'evt_1' });

function call(provider: string, body: string | null = BODY, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/billing/webhook/${provider}`, method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A payment of one of our account payments, as a provider maps it. */
const paid = (id = 'evt_1', over: Record<string, unknown> = {}) => ({
  type: 'payment_succeeded', providerEventId: id, intentId: PAY, amount: 2900, currency: 'USD', raw: {}, ...over,
});

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.stripeVerify.mockReset();
  h.claimed = new Set();
  h.claimThrows = false;
  h.claimInFlight = false;
  h.claimSpy.mockClear();
  h.finalizeSpy.mockClear();
  h.accountWebhook.mockReset().mockResolvedValue('settled');
  h.readAccountPayment.mockReset().mockImplementation(async (_cfg: unknown, id: unknown) =>
    id === PAY ? { id: PAY, workspace_id: WS, provider: 'stripe', status: 'pending' } : null);
  h.workspaceConfigs = [{ workspace_id: WS, config: { webhook_secret: 'a' } }];
  h.platformConfig = null;
  warn?.mockRestore();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('billing webhooks: only a verified event gets in', () => {
  it('rejects unknown providers', async () => {
    expect((await call('nope')).status).toBe(404);
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  it('rejects providers without a signed webhook contract', async () => {
    expect((await call('zarinpal')).status).toBe(400);
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    expect((await call('stripe', null)).status).toBe(400);
    expect(h.stripeVerify).not.toHaveBeenCalled();
  });

  it('rejects when no config verifies the signature', async () => {
    h.stripeVerify.mockRejectedValue(new Error('Invalid Stripe webhook signature'));
    expect((await call('stripe')).status).toBe(400);
    expect(h.claimSpy).not.toHaveBeenCalled();
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('passes the exact raw bytes to verifyWebhook', async () => {
    const raw = '{"id":"evt_1",   "spaced":true}';
    h.stripeVerify.mockResolvedValue(paid());
    await call('stripe', raw);
    expect(h.stripeVerify.mock.calls[0][2]).toBe(raw);
  });

  it('requires no authentication header but never trusts one', async () => {
    h.stripeVerify.mockRejectedValue(new Error('Invalid Stripe webhook signature'));
    expect((await call('stripe', BODY, { authorization: 'Bearer SERVICE_KEY' })).status).toBe(400);
    expect(h.claimSpy).not.toHaveBeenCalled();
  });
});

describe('billing webhooks: the workspace', () => {
  it('binds the event to the workspace that owns the verifying config', async () => {
    h.stripeVerify.mockResolvedValue(paid());
    expect((await call('stripe')).status).toBe(200);
    expect(h.claimSpy.mock.calls[0][0]).toMatchObject({ workspaceId: WS, providerEventId: 'evt_1' });
    expect(h.accountWebhook.mock.calls[0][1]).toMatchObject({ workspaceId: WS, providerName: 'stripe' });
  });

  it('rejects a payload claiming a workspace other than the config owner', async () => {
    h.stripeVerify.mockResolvedValue(paid('evt_1', { workspaceId: OTHER_WS }));
    expect((await call('stripe')).status).toBe(400);
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  it('rejects an account payment of another workspace than the verifying config', async () => {
    h.workspaceConfigs = [{ workspace_id: OTHER_WS, config: { webhook_secret: 'a' } }];
    h.stripeVerify.mockResolvedValue(paid());
    expect((await call('stripe')).status).toBe(400);
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('a platform-config event finds its workspace through our account payment', async () => {
    h.workspaceConfigs = [];
    h.platformConfig = { provider: 'stripe', webhook_secret: 'a' };
    h.stripeVerify.mockResolvedValue(paid());
    expect((await call('stripe')).status).toBe(200);
    expect(h.accountWebhook.mock.calls[0][1]).toMatchObject({ workspaceId: WS });
  });

  it('rejects ambiguous candidates that both verify the signature', async () => {
    h.workspaceConfigs = [
      { workspace_id: WS, config: { webhook_secret: 'a' } },
      { workspace_id: OTHER_WS, config: { webhook_secret: 'a' } },
    ];
    h.stripeVerify.mockResolvedValue(paid('evt_ambiguous', { intentId: undefined }));
    expect((await call('stripe')).status).toBe(400);
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  it('still accepts a later matching candidate after an earlier mismatch', async () => {
    h.workspaceConfigs = [
      { workspace_id: OTHER_WS, config: { webhook_secret: 'a' } },
      { workspace_id: WS, config: { webhook_secret: 'b' } },
    ];
    h.stripeVerify.mockImplementation(async (cfg: { webhook_secret?: string }) => {
      if (cfg.webhook_secret !== 'b') throw new Error('Invalid signature');
      return paid('evt_late', { workspaceId: WS });
    });
    expect((await call('stripe')).status).toBe(200);
    expect(h.accountWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('billing webhooks: idempotency', () => {
  it('claims before any money moves', async () => {
    h.stripeVerify.mockResolvedValue(paid());
    expect((await call('stripe')).status).toBe(200);
    expect(h.claimSpy).toHaveBeenCalledTimes(1);
    expect(h.claimSpy.mock.invocationCallOrder[0]).toBeLessThan(h.accountWebhook.mock.invocationCallOrder[0]);
    expect(h.finalizeSpy.mock.calls[0][3]).toBe('success');
  });

  it('acknowledges a replay without applying it again', async () => {
    h.stripeVerify.mockResolvedValue(paid('evt_dup'));
    expect((await call('stripe')).status).toBe(200);
    const second = await call('stripe');
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ received: true, duplicate: true });
    expect(h.accountWebhook).toHaveBeenCalledTimes(1);
  });

  it('applies exactly once under a concurrent double delivery', async () => {
    h.stripeVerify.mockResolvedValue(paid('evt_race'));
    const [a, b] = await Promise.all([call('stripe'), call('stripe')]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a, b].filter((r) => JSON.parse(r.body).duplicate === true)).toHaveLength(1);
    expect(h.accountWebhook).toHaveBeenCalledTimes(1);
  });

  it('a delivery another request is still processing is not acknowledged (409)', async () => {
    h.claimInFlight = true;
    h.stripeVerify.mockResolvedValue(paid());
    expect((await call('stripe')).status).toBe(409);
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('rejects a verified event with no stable provider event id', async () => {
    h.stripeVerify.mockResolvedValue(paid('   '));
    expect((await call('stripe')).status).toBe(400);
    expect(h.claimSpy).not.toHaveBeenCalled();
  });

  it('fails closed with a generic 500 when the claim errors', async () => {
    h.claimThrows = true;
    h.stripeVerify.mockResolvedValue(paid());
    const res = await call('stripe');
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'Webhook processing failed' });
    expect(h.accountWebhook).not.toHaveBeenCalled();
  });

  it('marks the claimed event failed when applying it throws, so the retry applies it', async () => {
    h.accountWebhook.mockRejectedValueOnce(new Error('boom'));
    h.stripeVerify.mockResolvedValue(paid('evt_fail'));
    expect((await call('stripe')).status).toBe(500);
    expect(h.finalizeSpy.mock.calls[0][3]).toBe('failed');
  });

  it('answers PayTR with the plain-text OK it requires', async () => {
    h.workspaceConfigs = [];
    h.platformConfig = { provider: 'paytr', webhook_secret: 'a' };
    h.readAccountPayment.mockResolvedValue({ id: PAY, workspace_id: WS, provider: 'paytr', status: 'pending' });
    h.stripeVerify.mockResolvedValue(paid('evt_paytr'));
    const res = await call('paytr');
    expect(res.status).toBe(200);
    expect(res.body).toBe('OK');
  });
});

describe('billing webhooks: an event naming nothing of ours', () => {
  it('a billing v2 intent id this database has no account payment for is acknowledged, logged REVIEW, nothing applied', async () => {
    h.workspaceConfigs = [];
    h.platformConfig = { provider: 'stripe', webhook_secret: 'a' };
    h.stripeVerify.mockResolvedValue(paid('evt_old', { intentId: '44444444-4444-4444-8444-444444444444' }));
    const res = await call('stripe');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true, ignored: true });
    expect(h.accountWebhook).not.toHaveBeenCalled();
    expect(h.claimSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[billing] REVIEW'))).toBe(true);
  });

  it('with its workspace known, it is kept in billing_events for review (claimed, then finalized)', async () => {
    h.stripeVerify.mockResolvedValue(paid('evt_review', { intentId: undefined, workspaceId: WS }));
    const res = await call('stripe');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true, ignored: true });
    expect(h.claimSpy.mock.calls[0][0]).toMatchObject({ workspaceId: WS, metadata: { review: 'no_account_payment_or_card' } });
    expect(h.finalizeSpy.mock.calls[0][3]).toBe('success');
    expect(h.accountWebhook).not.toHaveBeenCalled();
    // A replay is a duplicate, not a second review entry.
    expect(JSON.parse((await call('stripe')).body)).toEqual({ received: true, duplicate: true });
  });
});
