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
 *   Plans (phase 3): a trial buys a plan from the balance, upgrades at once,
 *   schedules a change and cancels it; a renewal paid online charges only what
 *   the balance is missing; the hourly job starts the prepaid period, then
 *   moves an unpaid plan to Free; a plan paid through Paddle is bought by its
 *   webhook; reminders and trial notices go out once each; every billing
 *   email is a template, filled in the edition's way (Toman, Persian digits).
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

interface EmailRequest { to: string; templateSlug?: string; templateData?: Record<string, string> }
const captured = vi.hoisted(() => ({
  emails: [] as Array<{ to: string; templateSlug?: string; actionUrl: string | null; data: Record<string, string> }>,
}));
vi.mock('../../../server/services/email/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../server/services/email/index.js')>();
  const send = async (_config: unknown, req: EmailRequest) => {
    captured.emails.push({ to: req.to, templateSlug: req.templateSlug, actionUrl: req.templateData?.action_url ?? null, data: req.templateData ?? {} });
    return { success: true, provider: 'test-capture', id: `m-${captured.emails.length}` };
  };
  return { ...actual, sendEmail: send, sendPlatformEmail: send };
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

  // ── Plans (phase 3), Iran ───────────────────────────────────────────────

  const plans = { basic: '', plus: '', usd: '' };
  const mails = (slug: string) => captured.emails.filter((e) => e.templateSlug === slug);
  const loadServerConfig = async () => (await import('../../../server/config.js')).loadConfig();

  it('Iran: plans are listed in the account currency; a trial buys a plan from the balance, once', async () => {
    const insertPlan = async (slug: string, name: string, fa: string, monthly: number, ai: number) => String((await chain.db.query(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order, localized)
       VALUES ($1, $2, $3, $4, true, false, false, 5, $5) RETURNING id`,
      [name, slug, JSON.stringify({ IRR: { monthly, yearly: monthly * 10 } }), JSON.stringify({ included_ai_allowance_irr: ai }),
        JSON.stringify({ fa: { name: fa } })],
    )).rows[0].id);
    plans.basic = await insertPlan('e2e-basic', 'Basic', 'پایه', 2_000_000, 100_000);
    plans.plus = await insertPlan('e2e-plus', 'Plus', 'پلاس', 3_000_000, 200_000);
    expect((await call('GET', `/api/billing/account/${state.iranWs}`)).json.plan).toMatchObject({ status: 'trialing' });

    const list = await call('GET', `/api/billing/account/${state.iranWs}/plans`);
    expect(list.json.currency).toBe('IRR');
    const slugs = (list.json.plans as Array<{ slug: string }>).map((p) => p.slug);
    expect(slugs).toEqual(expect.arrayContaining(['free', 'e2e-basic', 'e2e-plus']));
    expect(slugs).not.toContain('trial');

    const quote = await call('GET', `/api/billing/account/${state.iranWs}/quote?planId=${plans.basic}&interval=monthly`);
    expect(quote.json).toMatchObject({ kind: 'purchase', amount_minor: 2_000_000, shortfall_minor: 0 });
    const bought = await call('POST', `/api/billing/account/${state.iranWs}/plan`, { planId: plans.basic, interval: 'monthly', key: 'buy-basic-0001' });
    expect(bought.status).toBe(200);
    expect(bought.json).toMatchObject({ action: 'purchase', amount_minor: 2_000_000, balance_minor: 3_000_000 });
    const retried = await call('POST', `/api/billing/account/${state.iranWs}/plan`, { planId: plans.basic, interval: 'monthly', key: 'buy-basic-0001' });
    expect(retried.json).toMatchObject({ replayed: true });
    expect(await balance(state.iranWs)).toBe(3_000_000);

    const view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.json.plan).toMatchObject({ slug: 'e2e-basic', status: 'active', billing_interval: 'monthly' });
    expect(view.json.renewal).toMatchObject({ plan_id: plans.basic, billing_interval: 'monthly', price_minor: 2_000_000 });
    expect(Number(view.json.days_left)).toBeGreaterThanOrEqual(27);

    const mail = mails('billing_plan_activated').at(-1)!;
    expect(mail.data.plan_name).toBe('پایه');
    expect(mail.data.amount).toMatch(/^[۰-۹٬]+ تومان$/);
    expect(mail.data.amount).toContain('۲۰۰');
    expect(mail.data.billing_url).toMatch(/\/billing$/);
  });

  it('Iran: an upgrade is charged the difference at once; a change at the period end is scheduled and cancelled', async () => {
    const quote = await call('GET', `/api/billing/account/${state.iranWs}/quote?planId=${plans.plus}&interval=monthly`);
    expect(quote.json).toMatchObject({ kind: 'upgrade', amount_minor: 1_000_000, upgrade_cost_minor: 1_000_000, returned_minor: 0 });
    // An amount other than the one quoted is refused with the new quote, and nothing is charged.
    const moved = await call('POST', `/api/billing/account/${state.iranWs}/upgrade`, { planId: plans.plus, expectedNetMinor: 999 });
    expect(moved.status).toBe(409);
    expect(moved.json).toMatchObject({ error: 'QUOTE_CHANGED', details: { quote: { kind: 'upgrade', amount_minor: 1_000_000 } } });
    expect(await balance(state.iranWs)).toBe(3_000_000);
    const up = await call('POST', `/api/billing/account/${state.iranWs}/upgrade`, { planId: plans.plus, expectedNetMinor: 1_000_000 });
    expect(up.status).toBe(200);
    expect(up.json).toMatchObject({ action: 'upgraded', amount_minor: 1_000_000, balance_minor: 2_000_000 });
    expect((await call('GET', `/api/billing/account/${state.iranWs}`)).json.plan).toMatchObject({ slug: 'e2e-plus' });

    const down = await call('POST', `/api/billing/account/${state.iranWs}/change`, { planId: plans.basic, interval: 'monthly' });
    expect(down.json).toMatchObject({ action: 'change_scheduled' });
    let view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect((view.json.scheduled_plan as { id: string }).id).toBe(plans.basic);
    expect(view.json.renewal).toMatchObject({ plan_id: plans.basic, price_minor: 2_000_000 });
    expect(mails('billing_change_scheduled').at(-1)!.data).toMatchObject({ plan_name: 'پلاس', new_plan_name: 'پایه' });

    const cancel = await call('POST', `/api/billing/account/${state.iranWs}/change`, { planId: plans.plus, interval: 'monthly' });
    expect(cancel.json).toMatchObject({ action: 'change_cancelled' });
    view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.json.scheduled_plan).toBeNull();

    // Choosing the same change again mails nothing new.
    const sent = mails('billing_change_scheduled').length;
    expect((await call('POST', `/api/billing/account/${state.iranWs}/change`, { planId: plans.basic, interval: 'monthly' })).json)
      .toMatchObject({ action: 'change_scheduled' });
    expect(mails('billing_change_scheduled').length).toBe(sent);
    expect((await call('POST', `/api/billing/account/${state.iranWs}/change`, { planId: plans.plus, interval: 'monthly' })).json)
      .toMatchObject({ action: 'change_cancelled' });
  });

  it('Iran: a renewal paid online charges only what the balance is missing, then renews', async () => {
    const short = await call('POST', `/api/billing/account/${state.iranWs}/renew`);
    expect(short.status).toBe(409);
    expect(short.json.error).toBe('INSUFFICIENT_BALANCE');

    const start = await call('POST', `/api/billing/account/${state.iranWs}/checkout`, {
      purpose: 'renewal', providerName: 'internal_test', callbackUrl: `${ORIGIN}/ws/billing`,
    });
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ purpose: 'renewal', net_minor: 1_000_000, tax_minor: 100_000, amount_minor: 1_100_000 });
    const ref = new URL(String(start.json.paymentUrl)).searchParams.get('ref')!;
    const { signOutcome } = await import('../../../server/services/billing/providers/internal-test.js');
    const verify = await call('POST', `/api/billing/account/${state.iranWs}/payments/${start.json.paymentId}/verify`, {
      provider: 'internal_test', params: { authority: ref, status: 'OK', rsig: signOutcome(ref, 'OK') },
    });
    expect(verify.json).toMatchObject({ status: 'succeeded', purpose: 'renewal', purposeResult: { action: 'prepaid' } });
    const status = await call('GET', `/api/billing/account/${state.iranWs}/payments/${start.json.paymentId}`);
    expect(status.json).toMatchObject({ status: 'succeeded', purpose: 'renewal', purpose_result: { action: 'prepaid' } });
    const view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.json).toMatchObject({ balance_minor: 0, next_period_prepaid_minor: 3_000_000 });
    await vi.waitFor(() => expect(mails('billing_payment_receipt').length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(mails('billing_renewed').length).toBeGreaterThan(0));

    const twice = await call('POST', `/api/billing/account/${state.iranWs}/checkout`, {
      purpose: 'renewal', providerName: 'internal_test', callbackUrl: `${ORIGIN}/ws/billing`,
    });
    expect(twice.json.error).toBe('ALREADY_RENEWED');
  });

  it('Iran: the hourly job starts the prepaid period at the due moment, then moves an unpaid plan to Free', async () => {
    const { runSimpleBillingJob } = await import('../../../server/services/billing/account/job.js');
    const config = await loadServerConfig();
    // The prepayment was made for the period that ends: it moves with it.
    const makeDue = async () => {
      await chain.db.query(
        `UPDATE public.workspace_subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 hour'
          WHERE workspace_id = $1`, [state.iranWs]);
      await chain.db.query(
        `UPDATE public.billing_accounts a SET next_period_start = s.current_period_end
           FROM public.workspace_subscriptions s
          WHERE a.workspace_id = $1 AND s.workspace_id = a.workspace_id AND a.next_period_prepaid_minor IS NOT NULL`, [state.iranWs]);
    };

    await makeDue();
    const first = await runSimpleBillingJob(config);
    expect(first.errors).toEqual([]);
    expect(first.due.renewed).toBeGreaterThanOrEqual(1);
    let view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.json.plan).toMatchObject({ slug: 'e2e-plus', status: 'active' });
    expect(view.json.next_period_prepaid_minor).toBeNull();
    expect(Date.parse(String((view.json.plan as { current_period_end: string }).current_period_end))).toBeGreaterThan(Date.now());

    expect((await call('PUT', `/api/billing/account/${state.iranWs}/auto-renew`, { enabled: true })).json).toEqual({ auto_renew: true });
    await makeDue();
    const second = await runSimpleBillingJob(config);
    expect(second.due.expired).toBeGreaterThanOrEqual(1);
    view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.json.plan).toMatchObject({ slug: 'free', is_free: true });
    expect(view.json.paid_period).toBeNull();
    expect(mails('billing_expired').at(-1)!.data.plan_name).toBe('پلاس');
  });

  it('Iran: the page offers the plan that ran out, renews only the period it saw, and starts a period that ended before the job', async () => {
    await chain.db.query(`SELECT public.billing_account_admin_adjust($1, 6000000, 'IRR', 'e2e credit', NULL, 'e2e-credit-lapsed')`, [state.iranWs]);
    let view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.json.lapsed).toMatchObject({ plan_id: plans.plus, billing_interval: 'monthly', price_minor: 3_000_000, name: 'Plus' });
    const bought = await call('POST', `/api/billing/account/${state.iranWs}/plan`, {
      planId: plans.plus, interval: 'monthly', key: 'buy-plus-again-0001', expectedNetMinor: 3_000_000,
    });
    expect(bought.json).toMatchObject({ action: 'purchase', balance_minor: 3_000_000 });
    view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.json.lapsed).toBeNull();
    const end = String((view.json.paid_period as { current_period_end: string }).current_period_end);

    // A renewal for a period that is not the running one renews nothing.
    const other = await call('POST', `/api/billing/account/${state.iranWs}/renew`, { expectedPeriodEnd: new Date(Date.parse(end) - 86_400_000).toISOString() });
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('PERIOD_CHANGED');
    const renewed = await call('POST', `/api/billing/account/${state.iranWs}/renew`, { expectedPeriodEnd: end });
    expect(renewed.json).toMatchObject({ action: 'prepaid', amount_minor: 3_000_000 });
    const again = await call('POST', `/api/billing/account/${state.iranWs}/renew`, { expectedPeriodEnd: end });
    expect(again.status).toBe(409);
    expect(await balance(state.iranWs)).toBe(0);

    // The period ends and the job has not run yet: opening the page starts the prepaid period.
    await chain.db.query(
      `UPDATE public.workspace_subscriptions SET current_period_start = now() - interval '31 days', current_period_end = now() - interval '1 minute'
        WHERE workspace_id = $1`, [state.iranWs]);
    await chain.db.query(
      `UPDATE public.billing_accounts a SET next_period_start = s.current_period_end FROM public.workspace_subscriptions s
        WHERE a.workspace_id = $1 AND s.workspace_id = a.workspace_id`, [state.iranWs]);
    view = await call('GET', `/api/billing/account/${state.iranWs}`);
    expect(view.json.plan).toMatchObject({ slug: 'e2e-plus', status: 'active' });
    expect(view.json.next_period_prepaid_minor).toBeNull();
    expect(Date.parse(String((view.json.paid_period as { current_period_end: string }).current_period_end))).toBeGreaterThan(Date.now());

    // The history names what each charge paid for.
    const history = await call('GET', `/api/billing/account/${state.iranWs}/ledger`);
    const renewal = (history.json.items as Array<Record<string, unknown>>).find((i) => i.kind === 'renewal')!;
    expect(renewal).toMatchObject({ plan_id: plans.plus, plan_name: 'Plus', plan_localized: { fa: { name: 'پلاس' } } });
    expect(renewal.period_start).toBeTruthy();
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

  it('Multi Region: a plan paid through Paddle is bought by its signed webhook', async () => {
    plans.usd = String((await chain.db.query(
      `INSERT INTO public.billing_plans (name, slug, prices, limits, is_active, is_free, is_hidden, sort_order)
       VALUES ('Team', 'e2e-usd', '{"USD":{"monthly":2900,"yearly":29000}}', '{}', true, false, false, 6) RETURNING id`,
    )).rows[0].id);
    const before = await balance(state.intlWs);
    const start = await call('POST', `/api/billing/account/${state.intlWs}/checkout`, {
      purpose: 'plan', planId: plans.usd, interval: 'monthly', providerName: 'paddle_sandbox', callbackUrl: `${ORIGIN}/ws2/billing`,
    });
    expect(start.status).toBe(200);
    expect(start.json).toMatchObject({ purpose: 'plan', net_minor: 2900 - before });
    const checkout = start.json.clientCheckout as { transactionId: string };
    const txn = paddle.transactions.get(checkout.transactionId)!;
    txn.status = 'paid';
    const body = JSON.stringify({
      event_id: 'evt_plan_1',
      event_type: 'transaction.paid',
      data: { id: checkout.transactionId, status: 'paid', currency_code: 'USD', custom_data: txn.custom, details: { totals: { total: txn.amount } } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const h1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${body}`).digest('hex');
    expect((await call('POST', '/api/billing/webhook/paddle_sandbox', body, { 'paddle-signature': `ts=${ts};h1=${h1}` })).status).toBe(200);
    const view = await call('GET', `/api/billing/account/${state.intlWs}`);
    expect(view.json.plan).toMatchObject({ slug: 'e2e-usd', status: 'active' });
    expect(view.json.balance_minor).toBe(0);
    await vi.waitFor(() => expect(mails('billing_plan_activated').some((m) => m.data.amount === '$29.00')).toBe(true));
  });

  it('Multi Region: renewal reminders go out before the due date, once each', async () => {
    const { runSimpleBillingJob } = await import('../../../server/services/billing/account/job.js');
    const config = await loadServerConfig();
    const endIn = (hours: number) => chain.db.query(
      `UPDATE public.workspace_subscriptions
          SET current_period_end = now() + make_interval(hours => $2),
              current_period_start = public.billing_add_months(now() + make_interval(hours => $2), -1)
        WHERE workspace_id = $1`, [state.intlWs, hours]);
    await endIn(50);
    const count = () => mails('billing_renewal_reminder').length;
    const before = count();
    expect((await runSimpleBillingJob(config)).reminders).toBe(1);
    expect(mails('billing_renewal_reminder').at(-1)!.data).toMatchObject({ days_left: '3', amount: '$29.00', plan_name: 'Team' });
    await runSimpleBillingJob(config);
    expect(count()).toBe(before + 1);
    await endIn(20);
    expect((await runSimpleBillingJob(config)).reminders).toBe(1);
    expect(count()).toBe(before + 2);
  });

  it('a trial is reminded before it ends, then ended, once', async () => {
    const { runSimpleBillingJob } = await import('../../../server/services/billing/account/job.js');
    const config = await loadServerConfig();
    const owner = crypto.randomUUID();
    const ws = crypto.randomUUID();
    await chain.db.query(`INSERT INTO public.profiles (id, email) VALUES ($1, 'trial-owner@example.test')`, [owner]);
    await chain.db.query(`INSERT INTO public.workspaces (id, name, slug, owner_id) VALUES ($1, 'Trial WS', $2, $3)`, [ws, `trial-${ws.slice(0, 8)}`, owner]);
    const trialPlan = (await chain.db.query(`SELECT id FROM public.billing_plans WHERE slug = 'trial'`)).rows[0].id;
    await chain.db.query(
      `INSERT INTO public.workspace_subscriptions (workspace_id, plan_id, status, trial_end, current_period_start, current_period_end)
       VALUES ($1, $2, 'trialing', now() + interval '40 hours', now() - interval '5 days', now() + interval '40 hours')`, [ws, trialPlan]);
    expect((await runSimpleBillingJob(config)).trials.reminded).toBe(1);
    expect(mails('billing_trial_ending').at(-1)).toMatchObject({ to: 'trial-owner@example.test' });
    expect((await runSimpleBillingJob(config)).trials.reminded).toBe(0);

    await chain.db.query(`UPDATE public.workspace_subscriptions SET trial_end = now() - interval '1 hour' WHERE workspace_id = $1`, [ws]);
    expect((await runSimpleBillingJob(config)).trials.ended).toBe(1);
    expect(mails('billing_trial_ended').at(-1)).toMatchObject({ to: 'trial-owner@example.test' });
    expect((await chain.db.query(`SELECT status FROM public.workspace_subscriptions WHERE workspace_id = $1`, [ws])).rows[0].status).toBe('expired');
    expect((await runSimpleBillingJob(config)).trials.ended).toBe(0);
  });

  it('a workspace starts at most 10 payment attempts an hour', async () => {
    const { rows } = await chain.db.query(
      `SELECT count(*)::int AS n FROM public.billing_account_payments WHERE workspace_id = $1 AND created_at > now() - interval '1 hour'`,
      [state.iranWs]);
    for (let i = rows[0].n; i < 10; i += 1) {
      await chain.db.query(
        `INSERT INTO public.billing_account_payments (workspace_id, provider, currency, amount_minor, net_minor, tax_minor, purpose, status, failure_reason)
         VALUES ($1, 'internal_test', 'IRR', 1100000, 1000000, 100000, 'topup', 'failed', 'e2e')`, [state.iranWs]);
    }
    const refused = await call('POST', `/api/billing/account/${state.iranWs}/topup`, {
      amountMinor: 1_000_000, currency: 'IRR', providerName: 'internal_test', callbackUrl: `${ORIGIN}/ws/billing`,
    });
    expect(refused.status).toBe(429);
    expect(refused.json.error).toBe('TOO_MANY_CHECKOUTS');
  });

  it('nothing left this machine except to the local Paddle fake', () => {
    expect(blocked).toEqual([]);
  });
});
