/**
 * The hourly payment-attempt limit and the gateway's refusal, through the
 * top-up route (routes/billingAccount.ts), as the owner set them on
 * 2026-10-30:
 *   - 50 attempts an hour per workspace; platform admins are not limited;
 *   - an attempt the gateway refused before opening its page (Zibal's 103
 *     while the gateway is not active yet) does not count, but every attempt
 *     stops at 200 an hour (a loop on a refusing gateway);
 *   - a refusal answers 424 with the gateway's reason: Cloudflare replaces an
 *     origin's 502 with its own page, and the owner read "something went
 *     wrong" instead of Zibal's 103.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const WS = '11111111-1111-4111-8111-111111111111';
const PAY = '33333333-3333-4333-8333-333333333333';
const ZIBAL_103 = 'Zibal error: 103: merchant is inactive: درگاه غیرفعال است / عدم امضا قرارداد درگاه مربوطه';

const h = vi.hoisted(() => ({
  isAdmin: false,
  attempts: [] as Array<{ status: string; failure_reason: string | null }>,
  paymentsRead: 0,
  createCheckoutSession: vi.fn(),
  failed: [] as Array<{ id: string; reason: string }>,
}));

vi.mock('../../../../server/lib/workspaceAuth.js', () => ({
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: h.isAdmin, role: h.isAdmin ? null : 'owner' }),
}));
vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'limit']) b[m] = () => b;
      b.maybeSingle = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => {
        if (table === 'billing_account_payments') h.paymentsRead += 1;
        return resolve({ data: table === 'billing_account_payments' ? h.attempts : null, error: null });
      };
      return b;
    },
  }),
}));
vi.mock('../../../../server/services/platformOrigins.js', () => ({ allowedOrigins: () => ['https://app.test'] }));
vi.mock('../../../../server/services/auth-email.js', () => ({ resolveAppBaseUrl: async () => 'https://app.test' }));
vi.mock('../../../../server/services/billing/index.js', () => ({
  logBillingEvent: async () => undefined,
  resolveNamedBillingConfig: async () => null,
}));
vi.mock('../../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: (_req: unknown, _cfg: unknown, url: string) => url.startsWith('https://app.test/'),
  resolvePublicApiOrigin: async () => 'https://api.test',
}));
vi.mock('../../../../server/services/billing/edition.js', () => ({
  editionErrorResponse: () => null,
  getBillingRegion: async () => ({ edition: 'iran', regionMode: 'iran', currency: 'IRR' }),
}));
vi.mock('../../../../server/services/billing/account/index.js', () => ({
  AccountBillingError: class extends Error {},
  UPSTREAM_FAILURE_STATUS: 424,
  accountCurrency: async () => 'IRR',
  accountPaymentNeedsBinding: () => true,
  createAccountPayment: async (_c: unknown, input: Record<string, unknown>) => ({ id: PAY, ...input }),
  failAccountPayment: async (_c: unknown, id: string, _status: string, reason: string) => {
    h.failed.push({ id, reason });
  },
  getBillingSettings: async () => ({ vat_percent: {} }),
  patchAccountPayment: async () => undefined,
  readAccountPayment: async () => null,
}));
vi.mock('../../../../server/services/billing/account/gateways.js', () => ({
  accountGateways: async () => [],
  isIranianGateway: () => true,
  resolveAccountGateway: async () => ({ provider: { name: 'zibal', createCheckoutSession: h.createCheckoutSession }, config: {} }),
}));

const { billingAccountRouter, CHECKOUTS_PER_HOUR, CHECKOUT_ATTEMPTS_PER_HOUR } = await import('../../../../server/routes/billingAccount.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k', corsOrigins: [] };
  next();
});
app.use(express.json());
app.use('/api/billing', billingAccountRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function topup(): Promise<{ status: number; json: Record<string, unknown> }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  const body = JSON.stringify({ amountMinor: 2_000_000, callbackUrl: 'https://app.test/acme/billing' });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/billing/account/${WS}/topup`, method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, json: data ? JSON.parse(data) : {} }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const paid = (n: number) => Array.from({ length: n }, () => ({ status: 'succeeded', failure_reason: null }));
const refused = (n: number) => Array.from({ length: n }, () => ({ status: 'failed', failure_reason: `checkout_failed: ${ZIBAL_103}` }));

beforeEach(() => {
  h.isAdmin = false;
  h.attempts = [];
  h.paymentsRead = 0;
  h.failed = [];
  h.createCheckoutSession.mockReset().mockResolvedValue({ paymentUrl: 'https://gateway.zibal.ir/start/1', sessionId: '1' });
});

describe('the gateway refused the checkout', () => {
  it('answers 424 (never 502, which Cloudflare replaces) with the gateway\'s own reason, and ends the attempt', async () => {
    h.createCheckoutSession.mockRejectedValue(new Error(ZIBAL_103));
    const res = await topup();
    expect(res.status).toBe(424);
    expect(res.json).toMatchObject({ error: 'CHECKOUT_PROVIDER_ERROR', details: { provider: 'zibal', providerMessage: ZIBAL_103 } });
    expect(h.failed).toEqual([{ id: PAY, reason: `checkout_failed: ${ZIBAL_103}` }]);
  });

  it('a checkout without the reference it must be bound to answers 424 too', async () => {
    h.createCheckoutSession.mockResolvedValue({ paymentUrl: 'https://gateway.zibal.ir/start/' });
    const res = await topup();
    expect(res).toEqual({ status: 424, json: { error: 'CHECKOUT_REFERENCE_BINDING_FAILED' } });
  });
});

describe('the hourly limit (owner, 2026-10-30)', () => {
  it('is 50 an hour, and 200 with the refused ones', () => {
    expect(CHECKOUTS_PER_HOUR).toBe(50);
    expect(CHECKOUT_ATTEMPTS_PER_HOUR).toBe(200);
  });

  it('the 50th attempt of the hour goes through; the 51st is refused before the gateway is asked', async () => {
    h.attempts = paid(49);
    expect((await topup()).status).toBe(200);
    h.attempts = paid(50);
    expect(await topup()).toEqual({ status: 429, json: { error: 'TOO_MANY_CHECKOUTS' } });
    expect(h.createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('attempts the gateway refused (Zibal\'s 103 before the gateway was active) do not count', async () => {
    h.attempts = [...refused(120), ...paid(49)];
    expect((await topup()).status).toBe(200);
  });

  it('an attempt that opened the gateway\'s page and then failed still counts', async () => {
    h.attempts = Array.from({ length: 50 }, () => ({ status: 'failed', failure_reason: 'gateway_failed' }));
    expect((await topup()).status).toBe(429);
  });

  it('every attempt, refused ones included, stops at 200 an hour: a loop on a refusing gateway', async () => {
    h.attempts = refused(199);
    expect((await topup()).status).toBe(200);
    h.attempts = refused(200);
    expect(await topup()).toEqual({ status: 429, json: { error: 'TOO_MANY_CHECKOUTS' } });
  });

  it('a platform admin is never limited, and the hour is not even read', async () => {
    h.isAdmin = true;
    h.attempts = [...paid(300), ...refused(300)];
    expect((await topup()).status).toBe(200);
    expect(h.paymentsRead).toBe(0);
  });
});

describe('no billing answer the browser reads is a 502 or a 504', () => {
  // Cloudflare answers an origin's 502 or 504 with its own error page.
  const root = path.resolve(__dirname, '../../../../server');
  const files = [
    'routes/billingAccount.ts',
    'services/billing/account/card.ts',
    'services/billing/account/cardTransfer.ts',
    'services/billing/account/index.ts',
    'services/billing/account/aiPacks.ts',
    'services/billing/account/plans.ts',
  ];
  it.each(files)('%s', (file) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    expect(source).not.toMatch(/AccountBillingError\([^)]*,\s*50[24]\b/);
    expect(source).not.toMatch(/status\(50[24]\)\.json/);
  });
});
