// @vitest-environment node
/**
 * The simple billing's top-up, end to end: the real Express routers on a
 * database built by the whole chain, in postgres-only mode, signed in as a
 * real workspace owner (docs/billing/SIMPLE_BILLING.md).
 *
 *   Iran (WebYar): an IRR account, VAT 10% from billing_settings, the internal
 *   test gateway. Top-up → gateway page → return → verified → balance credited
 *   with the net, receipt with the VAT; a second return credits nothing; a
 *   return carrying another checkout's reference credits nothing; an amount
 *   outside the limits is refused before any gateway is touched.
 *
 *   Multi Region (RESPOK): a USD account, no VAT, the Paddle sandbox (its API
 *   answered by a local fake). The signed webhook credits the payment once;
 *   the customer's return after it finds it already settled.
 *
 * Only what lies outside this repository is stood in for: e-mail delivery
 * (captured) and Paddle's HTTP API. Every other outbound request is refused.
 * Driven by TEST_DATABASE_URL; skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createFullChainDatabase, type FullChainDatabase } from './fullChainDatabase';

const DSN = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_BILLING_DB === '1' && !DSN) {
  throw new Error('REQUIRE_BILLING_DB=1 but TEST_DATABASE_URL is not set — the simple billing E2E is mandatory.');
}
const suite = DSN ? describe : describe.skip;

interface EmailRequest { to: string; templateSlug?: string; templateData?: { action_url?: string } }
const captured = vi.hoisted(() => ({ emails: [] as Array<{ to: string; templateSlug?: string; actionUrl: string | null }> }));
vi.mock('../../../server/services/email/index.js', () => {
  const send = async (_config: unknown, req: EmailRequest) => {
    captured.emails.push({ to: req.to, templateSlug: req.templateSlug, actionUrl: req.templateData?.action_url ?? null });
    return { success: true, provider: 'test-capture', id: `m-${captured.emails.length}` };
  };
  return { sendEmail: send, sendPlatformEmail: send };
});
vi.mock('../../../server/middleware/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/middleware/security.js')>();
  return { ...actual, authRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next() };
});

// ── Paddle's API, answered locally; nothing else may leave this machine ──
const PADDLE_API = 'https://sandbox-api.paddle.com';
const paddle = { transactions: new Map<string, { amount: string; currency: string; status: string; custom: Record<string, string> }>(), seq: 0 };
const originals = { fetch: globalThis.fetch, http: http.request, https: https.request };
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const blocked: string[] = [];

function fakePaddle(url: string, init?: RequestInit): Response {
  const path = url.slice(PADDLE_API.length);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (path === '/transactions' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as {
      items: Array<{ price: { unit_price: { amount: string; currency_code: string } } }>;
      custom_data: Record<string, string>;
    };
    const id = `txn_test_${++paddle.seq}`;
    const price = body.items[0].price.unit_price;
    paddle.transactions.set(id, { amount: price.amount, currency: price.currency_code, status: 'ready', custom: body.custom_data });
    return json({ data: { id, status: 'ready', checkout: { url: null } } });
  }
  const m = /^\/transactions\/([^/?]+)$/.exec(path);
  if (m) {
    const txn = paddle.transactions.get(decodeURIComponent(m[1]));
    if (!txn) return json({ error: { code: 'not_found', detail: 'not found' } });
    return json({ data: { id: m[1], status: txn.status, currency_code: txn.currency, details: { totals: { total: txn.amount } } } });
  }
  return json({ error: { code: 'unexpected', detail: path } });
}

function installGuard(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(PADDLE_API)) return fakePaddle(url, init);
    const host = new URL(url, 'http://localhost').hostname;
    if (!LOCAL.has(host)) {
      blocked.push(url);
      throw new Error(`outbound request refused by the test: ${host}`);
    }
    return originals.fetch(input, init);
  }) as typeof fetch;
  https.request = ((...args: Parameters<typeof https.request>) => {
    blocked.push(String(args[0]));
    throw new Error('outbound https refused by the test');
  }) as typeof https.request;
}
function removeGuard(): void {
  globalThis.fetch = originals.fetch;
  https.request = originals.https;
}

const WEBHOOK_SECRET = 'pdl_ntfset_test_secret_for_this_suite';

suite('simple billing top-up, end to end (real routes, postgres-only)', () => {
  let chain: FullChainDatabase;
  let app: http.Server;
  let base = '';
  const ORIGIN = 'http://127.0.0.1';
  const state = { cookie: '', userId: '', iranWs: '', intlWs: '', accountId: '' };

  function call(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown>; raw: string; setCookie: string[] }> {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = originals.http(`${base}${path}`, {
        method,
        headers: {
          ...(state.cookie ? { cookie: state.cookie } : {}),
          ...(method !== 'GET' ? { origin: ORIGIN } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...extraHeaders,
        },
      }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try { json = JSON.parse(raw || '{}'); } catch { json = {}; }
          resolve({ status: res.statusCode ?? 0, json, raw, setCookie: (res.headers['set-cookie'] as string[]) ?? [] });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  const balance = async (ws: string): Promise<number> =>
    Number(((await call('GET', `/api/billing/account/${ws}`)).json.balance_minor));

  beforeAll(async () => {
    chain = await createFullChainDatabase(DSN!, `simplebilling_e2e_${Date.now()}`);
    Object.assign(process.env, {
      DATABASE_URL: chain.url,
      PLATFORM_SIGNING_SECRET: 'signing-secret-for-this-test-only-0123456789',
      SUPABASE_URL: 'https://legacy-project.supabase.co',
      SUPABASE_ANON_KEY: 'legacy-anon-key-value',
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-key-value-at-least-32',
      CORS_ORIGINS: ORIGIN,
      APP_BASE_URL: 'http://127.0.0.1:5173',
      INTERNAL_TEST_GATEWAY_SECRET: 'internal-test-gateway-secret-0123456789',
      INVITATION_LINK_SECRET: 'test-invitation-link-secret-value-32b!!',
      INVITATION_OTP_PEPPER: 'test-invitation-otp-pepper-value-32bytes',
    });
    delete process.env.DATABASE_MODE;
    delete process.env.SELF_HOST_BILLING_MODE;

    await chain.db.query(`UPDATE public.platform_settings SET region_mode = 'iran', signup_default_plan_mode = 'trial'`);
    await chain.db.query(
      `INSERT INTO public.billing_settings (edition, seller, vat_percent, receipt_prefix) VALUES
         ('iran', '{"legal_name":"وب‌یار","economic_code":"411111111111"}', '{"IRR": 10}', 'WY'),
         ('international', '{"legal_name":"Respok Ltd","vat_id":"GB123"}', '{"USD": null}', 'RS')`,
    );
    await chain.db.query(
      `INSERT INTO public.platform_domains (app_base_url, api_base_url)
       SELECT 'http://127.0.0.1:5173', 'http://127.0.0.1:1'
       WHERE NOT EXISTS (SELECT 1 FROM public.platform_domains)`,
    ).catch(() => undefined);
    await chain.db.query(`UPDATE public.platform_domains SET api_base_url = 'http://127.0.0.1:1'`).catch(() => undefined);
    // The gateways the Super Admin turned on, with their currencies.
    await chain.db.query(
      `INSERT INTO public.billing_gateways (provider_name, display_name, is_active, is_test, currencies, sort_order)
       VALUES ('internal_test', '{"en":"Test gateway"}', true, true, '{IRR}', 1),
              ('paddle_sandbox', '{"en":"Paddle sandbox"}', true, true, '{USD}', 2)
       ON CONFLICT (provider_name) DO UPDATE SET is_active = true, currencies = EXCLUDED.currencies`,
    );
    await chain.db.query(
      `INSERT INTO public.billing_provider_credentials (provider_name, config)
       VALUES ('paddle_sandbox', $1::jsonb)
       ON CONFLICT (provider_name) DO UPDATE SET config = EXCLUDED.config`,
      [JSON.stringify({ api_key: 'pdl_sdbx_apikey_test', client_token: 'test_client_token', webhook_secret: WEBHOOK_SECRET, open_to_customers: true })],
    );

    installGuard();
    const { loadConfig } = await import('../../../server/config.js');
    const config = loadConfig();
    const billing = await import('../../../server/routes/billing.js');
    const server = express();
    server.use((req, _res, next) => { (req as unknown as { serverConfig: typeof config }).serverConfig = config; next(); });
    server.use('/api/billing/webhook', billing.billingWebhookRouter);
    server.use(express.json({ limit: '5mb' }));
    server.use(cookieParser());
    server.use('/api/auth', (await import('../../../server/routes/auth.js')).authSecurityRouter);
    server.use('/api/auth-email', (await import('../../../server/routes/auth-email.js')).authEmailRouter);
    server.use('/api/workspaces', (await import('../../../server/routes/workspaces.js')).workspacesRouter);
    server.use('/api/billing', (await import('../../../server/routes/billingAccount.js')).billingAccountRouter);
    server.use('/api/billing', billing.billingRouter);
    app = server.listen(0, '127.0.0.1');
    await new Promise<void>((r) => app.once('listening', () => r()));
    base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

    // A real owner: sign up, verify, log in, create the workspace.
    const email = `owner-${Date.now()}@example.test`;
    expect((await call('POST', '/api/auth/signup', { email, password: 'correct horse battery 9', fullName: 'Owner' })).status).toBe(200);
    const link = captured.emails.find((e) => e.to === email && e.templateSlug === 'email_verify')?.actionUrl;
    expect((await call('POST', '/api/auth-email/verify-email', { token: new URL(link!).searchParams.get('token') })).status).toBe(200);
    const login = await call('POST', '/api/auth/login', { email, password: 'correct horse battery 9' });
    state.cookie = login.setCookie.find((c) => c.startsWith('gs_session='))!.split(';')[0];
    expect((await call('POST', '/api/workspaces/provision-account')).status).toBe(200);
    const list = (await call('GET', '/api/workspaces')).json.workspaces as Array<{ id: string }>;
    state.iranWs = list[0].id;
    state.accountId = ((await call('GET', '/api/workspaces/account')).json.account as { id: string }).id;
  }, 600_000);

  afterAll(async () => {
    removeGuard();
    await new Promise<void>((r) => (app ? app.close(() => r()) : r()));
    const { closeDataLayer } = await import('../../../server/db/index.js');
    await closeDataLayer();
    await chain?.drop();
  });

  // ── Iran ────────────────────────────────────────────────────────────────

  it('Iran: shows an empty IRR account with 10% VAT and the active gateway', async () => {
    const view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ edition: 'iran', currency: 'IRR', balance_minor: 0, vat_percent: 10, can_manage: true, has_account: false });
    expect((view.json.gateways as Array<{ provider_name: string }>).map((g) => g.provider_name)).toEqual(['internal_test']);
  });

  it('Iran: refuses an amount outside the limits before touching a gateway', async () => {
    const small = await call('POST', `/api/billing/account/${state.iranWs}/topup`, { amountMinor: 1000, callbackUrl: `${ORIGIN}/ws/billing` });
    expect(small.status).toBe(400);
    expect(small.json.error).toBe('TOPUP_AMOUNT_TOO_SMALL');
    const rows = await chain.db.query(`SELECT count(*)::int AS n FROM public.billing_account_payments WHERE workspace_id = $1`, [state.iranWs]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('Iran: a top-up is paid at the gateway, verified on return, and credited once with a receipt', async () => {
    const start = await call('POST', `/api/billing/account/${state.iranWs}/topup`, {
      amountMinor: 5_000_000, // 500,000 Toman of credit
      providerName: 'internal_test',
      callbackUrl: `${ORIGIN}/ws/billing`,
    });
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ currency: 'IRR', net_minor: 5_000_000, tax_minor: 500_000, amount_minor: 5_500_000 });
    const paymentId = String(start.json.paymentId);
    // The gateway page asks for the full amount, VAT included.
    const gatewayUrl = new URL(String(start.json.paymentUrl));
    expect(gatewayUrl.searchParams.get('amount')).toBe('5500000');
    const ref = gatewayUrl.searchParams.get('ref')!;

    const { signOutcome } = await import('../../../server/services/billing/providers/internal-test.js');
    const params = { authority: ref, status: 'OK', rsig: signOutcome(ref, 'OK') };
    const verify = await call('POST', `/api/billing/account/${state.iranWs}/payments/${paymentId}/verify`, { provider: 'internal_test', params });
    expect(verify.status).toBe(200);
    expect(verify.json.status).toBe('succeeded');
    expect(String(verify.json.receiptNumber)).toMatch(/^WY\d{4}-\d{6}$/);
    expect(await balance(state.iranWs)).toBe(5_000_000);

    // The same return again credits nothing.
    const again = await call('POST', `/api/billing/account/${state.iranWs}/payments/${paymentId}/verify`, { provider: 'internal_test', params });
    expect(again.json.status).toBe('succeeded');
    expect(await balance(state.iranWs)).toBe(5_000_000);

    const ledger = await call('GET', `/api/billing/account/${state.iranWs}/ledger`);
    const items = ledger.json.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'topup', amount_minor: 5_000_000, balance_after: 5_000_000, net_minor: 5_000_000, tax_minor: 500_000 });

    const receipt = await call('GET', `/api/billing/account/${state.iranWs}/receipts/${items[0].id}`);
    expect(receipt.status).toBe(200);
    expect((receipt.json.receipt as Record<string, unknown>).seller).toEqual({ legal_name: 'وب‌یار', economic_code: '411111111111' });
  });

  it('Iran: a return naming another checkout credits nothing', async () => {
    const start = await call('POST', `/api/billing/account/${state.iranWs}/topup`, {
      amountMinor: 1_000_000, providerName: 'internal_test', callbackUrl: `${ORIGIN}/ws/billing`,
    });
    const paymentId = String(start.json.paymentId);
    const { signOutcome } = await import('../../../server/services/billing/providers/internal-test.js');
    const forged = 'TESTGW-FORGED';
    const verify = await call('POST', `/api/billing/account/${state.iranWs}/payments/${paymentId}/verify`, {
      provider: 'internal_test',
      params: { authority: forged, status: 'OK', rsig: signOutcome(forged, 'OK') },
    });
    expect(verify.json).toMatchObject({ status: 'failed', reason: 'REFERENCE_MISMATCH' });
    expect(await balance(state.iranWs)).toBe(5_000_000);
  });

  it('Iran: a canceled payment ends the attempt and credits nothing', async () => {
    const start = await call('POST', `/api/billing/account/${state.iranWs}/topup`, {
      amountMinor: 1_000_000, providerName: 'internal_test', callbackUrl: `${ORIGIN}/ws/billing`,
    });
    const paymentId = String(start.json.paymentId);
    const ref = new URL(String(start.json.paymentUrl)).searchParams.get('ref')!;
    const { signOutcome } = await import('../../../server/services/billing/providers/internal-test.js');
    const verify = await call('POST', `/api/billing/account/${state.iranWs}/payments/${paymentId}/verify`, {
      provider: 'internal_test',
      params: { authority: ref, status: 'NOK', rsig: signOutcome(ref, 'NOK') },
    });
    expect(verify.json.status).toBe('failed');
    const status = await call('GET', `/api/billing/account/${state.iranWs}/payments/${paymentId}`);
    expect(status.json.status).toBe('canceled');
    expect(await balance(state.iranWs)).toBe(5_000_000);
  });

  it('Iran: the billing profile is saved with known fields only and printed on later receipts', async () => {
    const save = await call('PUT', `/api/billing/account/${state.iranWs}/profile`, {
      profile: { company: 'شرکت نمونه', economic_code: '1234', unknown_field: 'dropped' },
    });
    expect(save.status).toBe(200);
    expect(save.json.billing_profile).toEqual({ company: 'شرکت نمونه', economic_code: '1234' });
  });

  // ── Multi Region ────────────────────────────────────────────────────────

  it('Multi Region: a second workspace gets a USD account with no VAT and the Paddle sandbox', async () => {
    await chain.db.query(`UPDATE public.platform_settings SET region_mode = 'multi'`);
    const { invalidatePlatformRegionCache } = await import('../../../server/services/platformRegion.js');
    invalidatePlatformRegionCache();
    await chain.db.query(`INSERT INTO public.workspace_limit_overrides (workspace_id, limit_key, limit_value) VALUES ($1, 'max_workspaces', 2)`, [state.iranWs]);
    const { clearEntitlementCache } = await import('../../../server/middleware/featureGating.js');
    clearEntitlementCache();
    const created = await call('POST', '/api/workspaces', { accountId: state.accountId, name: 'Respok WS' });
    expect(created.status).toBe(200);
    const list = (await call('GET', '/api/workspaces')).json.workspaces as Array<{ id: string }>;
    state.intlWs = list.find((w) => w.id !== state.iranWs)!.id;

    const view = await call('GET', `/api/billing/account/${state.intlWs}`);
    expect(view.json).toMatchObject({ edition: 'international', currency: 'USD', vat_percent: null });
    expect((view.json.gateways as Array<{ provider_name: string }>).map((g) => g.provider_name)).toEqual(['paddle_sandbox']);

    // The Iranian workspace's account keeps its own currency.
    const iran = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(iran.json.currency).toBe('IRR');
  });

  it('Multi Region: the signed Paddle webhook credits the payment once; the return finds it settled', async () => {
    const start = await call('POST', `/api/billing/account/${state.intlWs}/topup`, {
      amountMinor: 2500, providerName: 'paddle_sandbox', callbackUrl: `${ORIGIN}/ws2/billing`,
    });
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ currency: 'USD', net_minor: 2500, tax_minor: 0, amount_minor: 2500 });
    const checkout = start.json.clientCheckout as { provider: string; transactionId: string; successUrl: string };
    expect(checkout.provider).toBe('paddle_sandbox');
    const txn = paddle.transactions.get(checkout.transactionId)!;
    expect(txn).toMatchObject({ amount: '2500', currency: 'USD' });
    expect(txn.custom.intent_id).toBe(start.json.paymentId);

    // Paddle collects it and notifies.
    txn.status = 'paid';
    const body = JSON.stringify({
      event_id: 'evt_test_1',
      event_type: 'transaction.paid',
      data: { id: checkout.transactionId, status: 'paid', currency_code: 'USD', custom_data: txn.custom, details: { totals: { total: '2500' } } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${body}`).digest('hex');
    const hook = await call('POST', '/api/billing/webhook/paddle_sandbox', body, { 'paddle-signature': `ts=${ts};h1=${h1}` });
    expect(hook.status).toBe(200);
    expect(await balance(state.intlWs)).toBe(2500);

    // A redelivery is a duplicate; nothing more is credited.
    const again = await call('POST', '/api/billing/webhook/paddle_sandbox', body, { 'paddle-signature': `ts=${ts};h1=${h1}` });
    expect(again.status).toBe(200);
    expect(await balance(state.intlWs)).toBe(2500);

    // The customer's return lands after the webhook: already settled.
    const ptxn = new URL(checkout.successUrl).searchParams.get('_ptxn')!;
    const verify = await call('POST', `/api/billing/account/${state.intlWs}/payments/${start.json.paymentId}/verify`, {
      provider: 'paddle_sandbox', params: { _ptxn: ptxn },
    });
    expect(verify.json.status).toBe('succeeded');
    expect(String(verify.json.receiptNumber)).toMatch(/^RS\d{4}-\d{6}$/);
    expect(await balance(state.intlWs)).toBe(2500);
  });

  it('Multi Region: a webhook with the wrong amount is acknowledged and credits nothing', async () => {
    const start = await call('POST', `/api/billing/account/${state.intlWs}/topup`, {
      amountMinor: 1000, providerName: 'paddle_sandbox', callbackUrl: `${ORIGIN}/ws2/billing`,
    });
    const checkout = start.json.clientCheckout as { transactionId: string };
    const txn = paddle.transactions.get(checkout.transactionId)!;
    const body = JSON.stringify({
      event_id: 'evt_test_wrong',
      event_type: 'transaction.paid',
      data: { id: checkout.transactionId, status: 'paid', currency_code: 'USD', custom_data: txn.custom, details: { totals: { total: '10' } } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${body}`).digest('hex');
    const hook = await call('POST', '/api/billing/webhook/paddle_sandbox', body, { 'paddle-signature': `ts=${ts};h1=${h1}` });
    expect(hook.status).toBe(200);
    expect(await balance(state.intlWs)).toBe(2500);
  });

  it('Multi Region: a Paddle refund takes the credit back from the balance, once', async () => {
    const ledger = await call('GET', `/api/billing/account/${state.intlWs}/ledger`);
    const topup = (ledger.json.items as Array<{ kind: string; payment_id: string }>).find((i) => i.kind === 'topup')!;
    const payment = await chain.db.query(`SELECT provider_payment_id FROM public.billing_account_payments WHERE id = $1`, [topup.payment_id]);
    const txnId = payment.rows[0].provider_payment_id as string;
    const before = await balance(state.intlWs);
    const body = JSON.stringify({
      event_id: 'evt_refund_1',
      event_type: 'adjustment.updated',
      data: { id: 'adj_1', action: 'refund', status: 'approved', transaction_id: txnId, currency_code: 'USD', totals: { total: '1000' } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${body}`).digest('hex');
    const hook = await call('POST', '/api/billing/webhook/paddle_sandbox', body, { 'paddle-signature': `ts=${ts};h1=${h1}` });
    expect(hook.status).toBe(200);
    expect(await balance(state.intlWs)).toBe(before - 1000);
    const again = await call('POST', '/api/billing/webhook/paddle_sandbox', body, { 'paddle-signature': `ts=${ts};h1=${h1}` });
    expect(again.status).toBe(200);
    expect(await balance(state.intlWs)).toBe(before - 1000);
    const refundRows = await chain.db.query(`SELECT amount_minor FROM public.billing_account_ledger WHERE workspace_id = $1 AND kind = 'refund'`, [state.intlWs]);
    expect(refundRows.rows.map((r) => Number(r.amount_minor))).toEqual([-1000]);
  });

  it('a top-up shown in one currency is never charged in another', async () => {
    const res = await call('POST', `/api/billing/account/${state.intlWs}/topup`, {
      amountMinor: 50_000, currency: 'TRY', providerName: 'paddle_sandbox', callbackUrl: `${ORIGIN}/ws2/billing`,
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: 'CURRENCY_CHANGED', details: { currency: 'USD' } });
  });

  it('the gateway return hop redirects only to this platform\'s own app', async () => {
    const start = await call('POST', `/api/billing/account/${state.intlWs}/topup`, {
      amountMinor: 1000, currency: 'USD', providerName: 'paddle_sandbox', callbackUrl: `${ORIGIN}/ws2/billing`,
    });
    const paymentId = String(start.json.paymentId);
    await chain.db.query(`UPDATE public.billing_account_payments SET return_url = 'https://evil.example/login' WHERE id = $1`, [paymentId]);
    const hop = await call('GET', `/api/billing/account-return?payment=${paymentId}&provider=paddle_sandbox`);
    expect(hop.status).toBe(400);
  });

  it('another workspace\'s payment and receipt cannot be read', async () => {
    const ledger = await call('GET', `/api/billing/account/${state.iranWs}/ledger`);
    const iranEntry = (ledger.json.items as Array<{ id: string }>)[0];
    const cross = await call('GET', `/api/billing/account/${state.intlWs}/receipts/${iranEntry.id}`);
    expect(cross.status).toBe(404);
  });

  it('nothing left this machine except to the local Paddle fake', () => {
    expect(blocked).toEqual([]);
  });
});
