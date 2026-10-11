/**
 * Buying AI credit packs (phase 5): the workspace routes
 * (server/routes/billingAccountAi.ts, the 'ai_pack' checkout in
 * billingAccount.ts) over the real service (services/billing/account/aiPacks.ts).
 * The SQL is migration 265's (simpleBillingAiPacks.pg.test.ts); here the
 * database is a fake that records what it is asked:
 *
 *   - GET /ai: the AI wallet in the account currency (rounded down), packs
 *     only while sellable (ENFORCED, packs saved, a rate);
 *   - POST /ai-pack: MANAGE only, the body validated, METER_ONLY refused
 *     before the database, the key prefixed with the workspace, RPC errors
 *     mapped (QUOTE_CHANGED and AI_PACK_NOT_AVAILABLE carry the fresh AI
 *     section), the mail once and never for a replay;
 *   - checkout 'ai_pack': the shortfall (at least the top-up minimum),
 *     BALANCE_SUFFICIENT, CARD_SETUP_PURPOSE with autoRenew, and the pack's
 *     detail stored on the payment.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';
const PAY = '33333333-3333-4333-8333-333333333333';
const LEDGER = '44444444-4444-4444-8444-444444444444';
const CALLBACK = 'https://app.test/acme/billing';

type Lot = { source_type: string; remaining_amount: number; reserved_amount: number; expires_at: string | null };

const h = vi.hoisted(() => ({
  role: 'owner' as string,
  mode: 'ENFORCED' as 'ENFORCED' | 'METER_ONLY',
  account: { workspace_id: '', currency: 'USD', balance_minor: 0 } as Record<string, unknown> | null,
  packs: {} as Record<string, unknown>,
  rate: 600_000 as number | null,
  lots: [] as Lot[],
  ledgerLabel: null as unknown,
  /** rpc name → answer ({data} or {error}); billing_ai_wallet_rate answers h.rate. */
  rpcAnswer: {} as Record<string, { data?: unknown; error?: { message: string } }>,
  rpcCalls: [] as Array<[string, Record<string, unknown>]>,
  mails: [] as Array<{ slug: string; vars: Record<string, string> }>,
  createPayment: vi.fn(),
  createCheckoutSession: vi.fn(),
}));

vi.mock('../../../../server/lib/workspaceAuth.js', () => ({
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  authorizeWorkspaceAccess: async (_req: unknown, res: { status(c: number): { json(b: unknown): void } }, _ws: string, opts: { manage?: boolean } = {}) => {
    if (opts.manage && !['owner', 'admin'].includes(h.role)) {
      res.status(403).json({ error: 'FORBIDDEN' });
      return null;
    }
    return { userId: 'u1', isAdmin: false, role: h.role };
  },
}));

vi.mock('../../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'order', 'limit']) b[m] = () => b;
      b.maybeSingle = async () => {
        if (table === 'billing_account_ledger') return { data: h.ledgerLabel === null ? null : { description: { label: h.ledgerLabel } }, error: null };
        if (table === 'profiles') return { data: { email: 'owner@acme.test' }, error: null };
        return { data: null, error: null };
      };
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve(table === 'workspace_ai_balance_lots' ? { data: h.lots, error: null } : { data: null, error: null, count: 0 });
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push([name, args]);
      if (name === 'billing_ai_wallet_rate') return { data: h.rate, error: null };
      return h.rpcAnswer[name] ?? { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  }),
}));
vi.mock('../../../../server/services/ai-billing/mode.js', () => ({ getBillingMode: async () => h.mode }));
vi.mock('../../../../server/services/billing/index.js', () => ({
  logBillingEvent: async () => undefined,
  resolveNamedBillingConfig: async () => null,
  getProvider: () => null,
}));
vi.mock('../../../../server/services/billing/callbackUrl.js', () => ({
  isAllowedBillingCallbackUrl: (_req: unknown, _cfg: unknown, url: string) => url.startsWith('https://app.test/'),
  resolvePublicApiOrigin: async () => 'https://api.test',
}));
vi.mock('../../../../server/services/billing/edition.js', () => ({
  editionErrorResponse: () => null,
  getBillingRegion: async () => ({ edition: 'international', regionMode: 'multi', currency: 'USD' }),
}));
vi.mock('../../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/index.js')>()),
  readAccount: async () => (h.account ? { ...h.account, workspace_id: WS } : null),
  getBillingSettings: async () => ({ edition: 'international', seller: {}, vat_percent: { USD: 10 }, receipt_prefix: 'R', ai_packs: h.packs }),
  createAccountPayment: async (_c: unknown, input: Record<string, unknown>) => {
    h.createPayment(input);
    return { id: PAY, ...input };
  },
  patchAccountPayment: async () => undefined,
  failAccountPayment: async () => undefined,
}));
vi.mock('../../../../server/services/billing/account/gateways.js', () => ({
  accountGateways: async () => [],
  isIranianGateway: () => false,
  resolveAccountGateway: async (_c: unknown, _ws: string, _cur: string, name: string | undefined) => ({
    provider: { name: name ?? 'stripe', createCheckoutSession: h.createCheckoutSession },
    config: {},
  }),
}));
vi.mock('../../../../server/services/billing/account/card.js', () => ({
  assertCardAllowsPlanChange: async () => undefined,
  cardAvailability: async () => ({ available: false, providers: [] }),
  cardUpdateCheckout: async () => ({}),
  cardView: async () => null,
  chargeCardForUpgrade: async () => ({}),
  prepareCardSetup: async () => ({}),
  removeCard: async () => ({}),
  renewWithCard: async () => ({}),
  syncWorkspaceCard: async () => undefined,
  readLiveCard: async () => null,
  cardLabel: () => '',
  cancelCardNow: async () => undefined,
  pullCardRenewal: async () => undefined,
  setCardAutoRenew: async () => false,
}));
vi.mock('../../../../server/services/billing/account/notify.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../server/services/billing/account/notify.js')>();
  return {
    ...real,
    sendBillingEmail: async (_c: unknown, _ws: string, slug: string, build: (ctx: unknown) => Record<string, string>) => {
      const ctx = {
        edition: 'international',
        locale: 'en',
        money: (minor: number | null | undefined, currency: string) => (minor == null ? '' : real.formatBillingMoney('international', 'en', currency, minor)),
        date: (iso: string) => iso,
        number: (n: number) => String(n),
      };
      h.mails.push({ slug, vars: build(ctx) });
      return { sent: true };
    },
  };
});

const { billingAccountRouter } = await import('../../../../server/routes/billingAccount.js');
const { billingAccountAiRouter } = await import('../../../../server/routes/billingAccountAi.js');

const app = express();
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use(express.json());
app.use('/api/billing', billingAccountRouter);
app.use('/api/billing', billingAccountAiRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: `/api/billing/account/${WS}${path}`, method, headers: { 'content-type': 'application/json', connection: 'close' } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(data || '{}') }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const SMALL = { id: 's', price_minor: 500, credit_minor: 600, label: { en: 'Small' } };
const BIG = { id: 'b', price_minor: 2000, credit_minor: 2400 };
const BOUGHT = {
  action: 'ai_pack', replayed: false, pack_ledger_id: LEDGER, lot_id: 'lot-1', pack_id: 's',
  price_minor: 500, credit_minor: 600, currency: 'USD', wallet_amount: 3_600_000, balance_minor: 1500,
};
const rpcNames = () => h.rpcCalls.map(([name]) => name);

beforeEach(() => {
  h.role = 'owner';
  h.mode = 'ENFORCED';
  h.account = { currency: 'USD', balance_minor: 2000 };
  h.packs = { USD: [SMALL, { ...BIG, active: false }, BIG], TRY: [{ id: 't', price_minor: 20_000, credit_minor: 20_000 }] };
  h.rate = 600_000;
  h.lots = [];
  h.ledgerLabel = { en: 'Small' };
  h.rpcAnswer = {};
  h.rpcCalls.length = 0;
  h.mails.length = 0;
  h.createPayment.mockReset();
  h.createCheckoutSession.mockReset().mockResolvedValue({ paymentUrl: 'https://pay.test/x', sessionId: 'cs_1' });
});

describe('GET /ai', () => {
  it('shows the wallet in the account currency, rounded down, and the active packs', async () => {
    const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const sooner = new Date(Date.now() + 3 * 86_400_000).toISOString();
    h.lots = [
      { source_type: 'PLAN_ALLOWANCE', remaining_amount: 1_200_000, reserved_amount: 200_000, expires_at: future },
      { source_type: 'PLAN_ALLOWANCE', remaining_amount: 5_999, reserved_amount: 0, expires_at: sooner },
      // Past its end: spent by nothing, not shown.
      { source_type: 'PLAN_ALLOWANCE', remaining_amount: 9_000_000, reserved_amount: 0, expires_at: '2020-01-01T00:00:00Z' },
      { source_type: 'PURCHASED', remaining_amount: 3_000_000, reserved_amount: 0, expires_at: null },
    ];
    const res = await call('GET', '/ai');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      mode: 'ENFORCED',
      currency: 'USD',
      rate_available: true,
      wallet: { available: 4_005_999, reserved: 200_000, plan_remaining: 1_005_999, purchased_remaining: 3_000_000 },
      // 1,005,999 / 600,000 = $1.6766… → $1.67; 4,005,999 → $6.67.
      display: { available_minor: 667, plan_remaining_minor: 167, purchased_remaining_minor: 500 },
      plan_expires_at: sooner,
      packs: [{ ...SMALL, active: true }, { ...BIG, active: true }],
      sellable: true,
      reason: null,
      can_manage: true,
    });
    expect(rpcNames()).toEqual(['billing_ai_wallet_rate']);
    expect(h.rpcCalls[0][1]).toEqual({ p_currency: 'USD' });
  });

  it('credit that ends (a refund compensation lot) is not shown as never-expiring; admin credit with no end is', async () => {
    const monthEnd = new Date(Date.now() + 5 * 86_400_000).toISOString();
    h.lots = [
      { source_type: 'REFUND_COMPENSATION', remaining_amount: 600_000, reserved_amount: 0, expires_at: monthEnd },
      { source_type: 'ADJUSTMENT', remaining_amount: 1_200_000, reserved_amount: 0, expires_at: null },
    ];
    const res = await call('GET', '/ai');
    expect(res.json).toMatchObject({
      wallet: { available: 1_800_000, reserved: 0, plan_remaining: 600_000, purchased_remaining: 1_200_000 },
      display: { available_minor: 300, plan_remaining_minor: 100, purchased_remaining_minor: 200 },
      plan_expires_at: monthEnd,
    });
  });

  it('packs are hidden unless sellable: METER_ONLY, no packs, or no rate', async () => {
    h.mode = 'METER_ONLY';
    expect((await call('GET', '/ai')).json).toMatchObject({ sellable: false, reason: 'mode', packs: [], rate_available: true });
    h.mode = 'ENFORCED';
    h.packs = { USD: [{ ...SMALL, active: false }] };
    expect((await call('GET', '/ai')).json).toMatchObject({ sellable: false, reason: 'no_packs', packs: [] });
    h.packs = { USD: [SMALL] };
    h.rate = null;
    expect((await call('GET', '/ai')).json).toMatchObject({ sellable: false, reason: 'no_rate', packs: [], display: null, rate_available: false });
  });

  it('a member reads it (cannot manage); a workspace with no account uses the region currency', async () => {
    h.role = 'member';
    h.account = null;
    const res = await call('GET', '/ai');
    expect(res.json).toMatchObject({ currency: 'USD', can_manage: false, wallet: { available: 0 } });
  });
});

describe('POST /ai-pack', () => {
  const body = (over: Record<string, unknown> = {}) => ({ packId: 's', expectedPriceMinor: 500, key: 'click-123456', ...over });

  it('buys from the balance with the workspace-prefixed key, and mails once', async () => {
    h.rpcAnswer.billing_account_buy_ai_pack = { data: BOUGHT };
    const res = await call('POST', '/ai-pack', body());
    expect(res.status).toBe(200);
    expect(res.json).toEqual(BOUGHT);
    const buy = h.rpcCalls.find(([name]) => name === 'billing_account_buy_ai_pack');
    expect(buy?.[1]).toEqual({ p_workspace_id: WS, p_pack_id: 's', p_expected_price_minor: 500, p_key: `${WS}:click-123456`, p_actor: 'u1' });
    expect(h.mails).toEqual([{
      slug: 'billing_ai_pack_purchased',
      vars: { pack_name: 'Small', credit: '$6.00', amount: '$5.00', balance: '$15.00', ai_balance: '$0.00' },
    }]);
  });

  it('a key is made when the browser sends none; an unnamed pack is named generically in the mail (not by its credit, which follows it)', async () => {
    h.rpcAnswer.billing_account_buy_ai_pack = { data: BOUGHT };
    h.ledgerLabel = null;
    h.rate = null;
    await call('POST', '/ai-pack', body({ key: undefined }));
    const key = String(h.rpcCalls.find(([name]) => name === 'billing_account_buy_ai_pack')?.[1].p_key);
    expect(key).toMatch(new RegExp(`^${WS}:[0-9a-f-]{36}$`));
    // No rate: no AI balance in the mail.
    expect(h.mails[0].vars).toMatchObject({ pack_name: 'AI credit pack', credit: '$6.00', ai_balance: '' });
  });

  it('a replay answers the same purchase and sends no mail', async () => {
    h.rpcAnswer.billing_account_buy_ai_pack = { data: { ...BOUGHT, replayed: true } };
    const res = await call('POST', '/ai-pack', body());
    expect(res.json).toMatchObject({ replayed: true, lot_id: 'lot-1' });
    expect(h.mails).toEqual([]);
  });

  it('a member cannot buy (403); nothing is asked of the database', async () => {
    h.role = 'member';
    expect((await call('POST', '/ai-pack', body())).status).toBe(403);
    expect(h.rpcCalls).toEqual([]);
  });

  it('METER_ONLY answers 409 AI_PACKS_UNAVAILABLE before anything is bought', async () => {
    h.mode = 'METER_ONLY';
    const res = await call('POST', '/ai-pack', body());
    expect(res).toMatchObject({ status: 409, json: { error: 'AI_PACKS_UNAVAILABLE' } });
    expect(rpcNames()).not.toContain('billing_account_buy_ai_pack');
  });

  it('validates the body', async () => {
    for (const bad of [
      { expectedPriceMinor: 500 },
      body({ packId: 'Big Pack' }),
      body({ packId: 'a'.repeat(25) }),
      body({ expectedPriceMinor: 0 }),
      body({ expectedPriceMinor: 5.5 }),
      { packId: 's' },
      body({ key: 'short' }),
      body({ key: 'k'.repeat(101) }),
    ]) {
      expect((await call('POST', '/ai-pack', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(h.rpcCalls).toEqual([]);
  });

  it('maps the SQL errors', async () => {
    const cases: Array<[string, number, string]> = [
      ['billing_insufficient_balance', 409, 'INSUFFICIENT_BALANCE'],
      ['billing_ai_fx_unavailable', 409, 'AI_CREDIT_UNAVAILABLE'],
      ['billing_idempotency_conflict', 409, 'IDEMPOTENCY_CONFLICT'],
      ['billing_key_required', 400, 'INVALID_REQUEST'],
      ['something else', 500, 'INTERNAL_ERROR'],
    ];
    for (const [message, status, code] of cases) {
      h.rpcAnswer.billing_account_buy_ai_pack = { error: { message } };
      const res = await call('POST', '/ai-pack', body());
      expect(res.status, message).toBe(status);
      expect(res.json.error, message).toBe(code);
      expect(res.json.details ?? null, message).toBeNull();
    }
    expect(h.mails).toEqual([]);
  });

  it('QUOTE_CHANGED and AI_PACK_NOT_AVAILABLE carry the AI section as it is now', async () => {
    for (const [message, code] of [['billing_quote_changed', 'QUOTE_CHANGED'], ['billing_ai_pack_not_available', 'AI_PACK_NOT_AVAILABLE']]) {
      h.rpcAnswer.billing_account_buy_ai_pack = { error: { message } };
      const res = await call('POST', '/ai-pack', body());
      expect(res.status).toBe(409);
      expect(res.json.error).toBe(code);
      expect(res.json.details).toMatchObject({
        section: { currency: 'USD', sellable: true, packs: [{ id: 's', price_minor: 500 }, { id: 'b', price_minor: 2000 }] },
      });
    }
  });
});

describe('POST /checkout with purpose ai_pack', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    purpose: 'ai_pack', packId: 'b', expectedPriceMinor: 2000, currency: 'USD', providerName: 'stripe', callbackUrl: CALLBACK, ...over,
  });

  it('charges what the balance is missing, never below the top-up minimum, with the pack on the payment', async () => {
    // $20 pack, $2 in the balance: $18 missing.
    h.account = { currency: 'USD', balance_minor: 200 };
    const res = await call('POST', '/checkout', body());
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ purpose: 'ai_pack', net_minor: 1800, tax_minor: 180, amount_minor: 1980 });
    expect(h.createPayment).toHaveBeenCalledTimes(1);
    expect(h.createPayment.mock.calls[0][0]).toMatchObject({
      purpose: 'ai_pack',
      netMinor: 1800,
      purposeDetail: { pack_id: 'b', price_minor: 2000, credit_minor: 2400, credit_currency: 'USD', label: null },
    });
    expect(h.createPayment.mock.calls[0][0]).not.toHaveProperty('source');
    expect(h.createCheckoutSession.mock.calls[0][1]).toMatchObject({ description: 'AI credit', currency: 'USD' });

    // $19 in the balance: $1 missing, but a top-up is at least $5.
    h.account = { currency: 'USD', balance_minor: 1900 };
    await call('POST', '/checkout', body());
    expect(h.createPayment.mock.calls[1][0]).toMatchObject({ netMinor: 500 });
  });

  it('a balance that covers the pack answers BALANCE_SUFFICIENT', async () => {
    h.account = { currency: 'USD', balance_minor: 2000 };
    expect((await call('POST', '/checkout', body())).json).toEqual({ error: 'BALANCE_SUFFICIENT' });
    expect(h.createPayment).not.toHaveBeenCalled();
  });

  it('no card is saved for a pack (CARD_SETUP_PURPOSE); a pack is named', async () => {
    expect((await call('POST', '/checkout', body({ autoRenew: true, expectedNetMinor: 2000 }))).json).toEqual({ error: 'CARD_SETUP_PURPOSE' });
    expect((await call('POST', '/checkout', body({ packId: undefined }))).status).toBe(400);
    expect((await call('POST', '/checkout', body({ packId: 'BAD ID' }))).status).toBe(400);
    expect(h.createPayment).not.toHaveBeenCalled();
  });

  it('refuses a pack that changed, is gone, is not sold, or has no rate; nothing is created', async () => {
    h.account = { currency: 'USD', balance_minor: 0 };
    const changed = await call('POST', '/checkout', body({ expectedPriceMinor: 1500 }));
    expect(changed).toMatchObject({ status: 409, json: { error: 'QUOTE_CHANGED', details: { pack: { id: 'b', price_minor: 2000 } } } });
    expect((await call('POST', '/checkout', body({ packId: 'gone' }))).json).toMatchObject({ error: 'AI_PACK_NOT_AVAILABLE' });
    h.rate = null;
    expect((await call('POST', '/checkout', body())).json).toMatchObject({ error: 'AI_CREDIT_UNAVAILABLE' });
    h.rate = 600_000;
    h.mode = 'METER_ONLY';
    expect((await call('POST', '/checkout', body())).json).toMatchObject({ error: 'AI_PACKS_UNAVAILABLE' });
    h.mode = 'ENFORCED';
    expect((await call('POST', '/checkout', body({ currency: 'TRY' }))).json).toMatchObject({ error: 'CURRENCY_CHANGED' });
    expect(h.createPayment).not.toHaveBeenCalled();
  });
});
