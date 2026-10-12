/**
 * Billing v2's code is removed (simple billing phase 7A):
 *
 *   - its customer, Super Admin and AI top-up routes answer 404 (nothing of
 *     them is mounted any more), while what simple billing keeps still answers;
 *   - Super Admin → assign plan (POST /api/plans/admin/assign) goes through
 *     simple billing's SQL only: billing_account_write_subscription, then
 *     billing_account_admin_replaced, then billing_account_grant_month, and
 *     refuses any status but 'active';
 *   - a gateway webhook naming a billing v2 intent is acknowledged (200) and
 *     logged REVIEW, never applied;
 *   - the dashboard's AI credit comes from the account AI section;
 *   - the client has no v2 page, route or module left.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import express from 'express';
import cookieParser from 'cookie-parser';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Row = Record<string, unknown>;

const WS = '11111111-1111-4111-8111-111111111111';
const PLAN = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  rpcs: [] as Array<{ name: string; args: Record<string, unknown> }>,
  tables: [] as string[],
  plans: [] as Array<Record<string, unknown>>,
  rpcError: null as null | { message: string },
  entitlementChanged: vi.fn(async (..._a: unknown[]) => ({ ok: true })),
  stripeVerify: vi.fn(),
  readAccountPayment: vi.fn(async (..._a: unknown[]) => null as unknown),
  accountWebhook: vi.fn(async (..._a: unknown[]) => 'settled'),
  claim: vi.fn(async (..._a: unknown[]) => ({ claimed: true, eventRowId: 'row-1' })),
  ai: vi.fn(),
}));

function fakeClient() {
  return {
    from(table: string) {
      h.tables.push(table);
      const filters: Record<string, unknown> = {};
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'limit', 'in', 'neq', 'gte', 'lte', 'range', 'update', 'insert', 'upsert', 'delete']) b[m] = () => b;
      b.eq = (col: string, value: unknown) => {
        filters[col] = value;
        return b;
      };
      b.maybeSingle = async () => {
        if (table === 'billing_plans') return { data: h.plans.find((p) => p.id === filters.id) ?? null, error: null };
        if (table === 'workspace_subscriptions') return { data: { workspace_id: filters.workspace_id, plan_id: PLAN, status: 'active' }, error: null };
        return { data: null, error: null };
      };
      b.single = async () => ({ data: null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null, count: 0 });
      return b;
    },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      h.rpcs.push({ name, args });
      if (name === 'has_role') return { data: true, error: null };
      if (name === 'billing_account_write_subscription' && h.rpcError) return { data: null, error: h.rpcError };
      return { data: null, error: null };
    },
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('no') }) },
  };
}

vi.mock('../../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../../server/services/auth/sessions.js', () => ({
  SESSION_COOKIE_NAME: 'gs_session',
  validateSessionToken: async (_c: unknown, token: string | undefined) => (token ? { sessionId: 's', userId: 'admin-1', email: 'a@x.test' } : null),
  verifyOriginForMutation: () => true,
}));
vi.mock('../../../../server/middleware/adminBypass.js', () => ({
  isGlobalAdmin: async () => true,
  logGateBypass: async () => {},
}));
vi.mock('../../../../server/lib/workspaceAuth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/lib/workspaceAuth.js')>()),
  authorizeWorkspaceAccess: async () => ({ userId: 'u1', isAdmin: false, role: 'owner' }),
  requirePlatformAdmin: async () => 'admin-1',
  requireUser: async () => 'u1',
}));
vi.mock('../../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/platformRegion.js')>()),
  getPlatformEdition: async () => 'iran',
  getPlatformEditionOrNull: async () => 'iran',
}));
vi.mock('../../../../server/services/billing/entitlementChange.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/entitlementChange.js')>()),
  handleWorkspaceEntitlementChanged: h.entitlementChanged,
}));
vi.mock('../../../../server/services/billing/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/index.js')>()),
  getProvider: (name: string) => (name === 'stripe' ? { name, capabilities: {}, verifyWebhook: h.stripeVerify } : null),
  resolvePlatformBillingConfig: async (_u: string, _k: string, name: string) =>
    name === 'stripe' ? { provider: 'stripe', webhook_secret: 'whsec' } : null,
  claimBillingWebhookEvent: h.claim,
  finalizeBillingWebhookEvent: async () => undefined,
}));
vi.mock('../../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../server/services/billing/account/index.js')>()),
  readAccountPayment: h.readAccountPayment,
  findAccountPaymentByProviderPayment: async () => null,
  handleAccountPaymentWebhook: h.accountWebhook,
}));
vi.mock('@/lib/accountBillingApi', () => ({ accountBillingApi: { ai: h.ai } }));

const { billingRouter, billingWebhookRouter } = await import('../../../../server/routes/billing.js');
const { adminBillingRouter } = await import('../../../../server/routes/adminBilling.js');
const { aiBillingRouter } = await import('../../../../server/routes/aiBilling.js');
const { plansRouter, adminAssignmentEnd } = await import('../../../../server/routes/plans.js');
const { useAiWalletSummary } = await import('@/hooks/useAiWalletSummary');

const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { serverConfig: Row }).serverConfig = {
    supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'],
  };
  next();
});
app.use('/api/billing/webhook', billingWebhookRouter);
app.use(cookieParser());
app.use(express.json());
app.use('/api/billing', billingRouter);
app.use('/api/admin/billing', adminBillingRouter);
app.use('/api/ai-billing', aiBillingRouter);
app.use('/api/plans', plansRouter);
const server = http.createServer(app).listen(0);
afterAll(() => server.close());

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Row }> {
  const port = (server.address() as import('node:net').AddressInfo).port;
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers: Record<string, string> = { connection: 'close', cookie: 'gs_session=admin' };
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: Row = {};
        try {
          json = JSON.parse(data || '{}');
        } catch {
          json = { html: data }; // Express's own 404 page
        }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.rpcs.length = 0;
  h.tables.length = 0;
  h.plans = [{ id: PLAN, name: 'Pro' }];
  h.rpcError = null;
  h.entitlementChanged.mockClear();
  h.stripeVerify.mockReset();
  h.readAccountPayment.mockReset().mockResolvedValue(null);
  h.accountWebhook.mockClear();
  h.claim.mockClear();
  warn?.mockRestore();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('billing v2 routes are gone', () => {
  it.each([
    ['GET', `/api/billing/status/${WS}`],
    ['GET', `/api/billing/events/${WS}`],
    ['GET', '/api/billing/providers'],
    ['POST', '/api/billing/checkout'],
    ['GET', '/api/billing/return?intent=x'],
    ['POST', '/api/billing/verify-callback'],
    ['GET', '/api/billing/payment-intent/x'],
    ['POST', '/api/billing/subscription/cancel'],
    ['POST', '/api/billing/portal'],
    ['POST', '/api/billing/test'],
    ['GET', '/api/billing/entitlement'],
    ['GET', '/api/billing/admin/overview'],
    ['GET', '/api/billing/admin/finance-report'],
    ['POST', '/api/billing/admin/grant'],
    ['GET', `/api/billing/workspaces/${WS}/plans`],
    ['POST', `/api/billing/workspaces/${WS}/ai-credit/invoice`],
    ['GET', '/api/admin/billing/currencies'],
    ['GET', '/api/admin/billing/overview'],
    ['GET', '/api/admin/billing/invoices'],
    ['POST', '/api/admin/billing/reset'],
    ['GET', `/api/ai-billing/workspaces/${WS}/summary`],
    ['POST', `/api/ai-billing/workspaces/${WS}/topup/checkout`],
    ['GET', '/api/ai-billing/admin/topup-config'],
  ])('%s %s answers 404 and touches nothing', async (method, path) => {
    const res = await call(method, path, method === 'POST' ? {} : undefined);
    expect(res.status).toBe(404);
    expect(h.rpcs.filter((r) => r.name !== 'has_role')).toEqual([]);
    expect(h.tables).toEqual([]);
  });

  it('the public plan list stays (the landing page reads it)', async () => {
    expect((await call('GET', '/api/billing/plans?locale=fa')).status).toBe(200);
  });

  it('the server mounts no v2 router, scheduler or flag', () => {
    const src = readFileSync(join(process.cwd(), 'server', 'index.ts'), 'utf8');
    expect(src).not.toMatch(/billingCustomer|adminBillingV2|scheduler\/ticker|startBillingV2|billingMode/);
    expect(src).toMatch(/SIMPLE_BILLING_JOB/);
  });
});

describe('Super Admin → assign plan goes through simple billing', () => {
  const sql = () => h.rpcs.map((r) => r.name).filter((n) => n !== 'has_role');

  it('writes the subscription, returns a replaced prepayment, then grants the month — in that order', async () => {
    const res = await call('POST', '/api/plans/admin/assign', { workspaceId: WS, planId: PLAN });
    expect(res.status).toBe(200);
    expect(sql()).toEqual(['billing_account_write_subscription', 'billing_account_admin_replaced', 'billing_account_grant_month']);
    const write = h.rpcs.find((r) => r.name === 'billing_account_write_subscription')!.args;
    expect(write).toMatchObject({
      p_workspace_id: WS, p_plan_id: PLAN, p_interval: 'monthly', p_status: 'active', p_change: 'admin_assign',
      p_details: { source: 'admin_assign' },
    });
    // No expiresAt: one calendar month from now.
    const start = new Date(String(write.p_start));
    expect(write.p_end).toBe(adminAssignmentEnd(start, 'monthly').toISOString());
    const grant = h.rpcs.find((r) => r.name === 'billing_account_grant_month')!.args;
    expect(grant).toMatchObject({ p_workspace_id: WS, p_plan_id: PLAN, p_period_start: write.p_start, p_period_end: write.p_end, p_at: write.p_start });
    expect(h.entitlementChanged).toHaveBeenCalledTimes(1);
    expect(res.json.subscription).toMatchObject({ workspace_id: WS, plan_id: PLAN });
  });

  it('an expiresAt in the future sets the end; yearly is kept', async () => {
    const end = new Date(Date.now() + 90 * 86_400_000).toISOString();
    expect((await call('POST', '/api/plans/admin/assign', { workspaceId: WS, planId: PLAN, expiresAt: end, interval: 'yearly' })).status).toBe(200);
    expect(h.rpcs.find((r) => r.name === 'billing_account_write_subscription')!.args).toMatchObject({ p_end: end, p_interval: 'yearly' });
  });

  it.each(['paused', 'trialing', 'canceled'])('refuses status %s (400 INVALID_STATUS) and writes nothing', async (status) => {
    const res = await call('POST', '/api/plans/admin/assign', { workspaceId: WS, planId: PLAN, status });
    expect(res).toMatchObject({ status: 400, json: { error: 'INVALID_STATUS' } });
    expect(sql()).toEqual([]);
  });

  it('refuses an end in the past, an unknown plan, and bad ids, writing nothing', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect((await call('POST', '/api/plans/admin/assign', { workspaceId: WS, planId: PLAN, expiresAt: past })).json.error).toBe('INVALID_EXPIRES_AT');
    h.plans = [];
    expect((await call('POST', '/api/plans/admin/assign', { workspaceId: WS, planId: PLAN })).status).toBe(404);
    expect((await call('POST', '/api/plans/admin/assign', { workspaceId: 'nope', planId: PLAN })).status).toBe(400);
    expect(sql()).toEqual([]);
  });

  it('a failed subscription write stops before anything else', async () => {
    h.rpcError = { message: 'boom' };
    expect((await call('POST', '/api/plans/admin/assign', { workspaceId: WS, planId: PLAN })).status).toBe(500);
    expect(sql()).toEqual(['billing_account_write_subscription']);
    expect(h.entitlementChanged).not.toHaveBeenCalled();
  });
});

describe('a webhook naming a billing v2 intent', () => {
  it('is acknowledged (200), logged REVIEW, and nothing is applied', async () => {
    h.stripeVerify.mockResolvedValue({
      type: 'payment_succeeded', providerEventId: 'evt_v2', intentId: '44444444-4444-4444-8444-444444444444',
      amount: 15_000_000, currency: 'IRR', raw: {},
    });
    const port = (server.address() as import('node:net').AddressInfo).port;
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/billing/webhook/stripe', method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' } },
        (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve({ status: r.statusCode || 0, body: data }));
        },
      );
      req.on('error', reject);
      req.write('{"id":"evt_v2"}');
      req.end();
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true, ignored: true });
    expect(h.accountWebhook).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    const review = warn.mock.calls.find((c) => String(c[0]).includes('[billing] REVIEW'));
    expect(review?.[1]).toMatchObject({ provider: 'stripe', ref: '44444444-4444-4444-8444-444444444444', amount: 15_000_000, currency: 'IRR' });
  });
});

describe('the dashboard AI credit reads the account AI section', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, children);

  it('maps plan_remaining and purchased_remaining', async () => {
    h.ai.mockResolvedValue({ wallet: { plan_remaining: 300_000, purchased_remaining: 50_000 } });
    const { result } = renderHook(() => useAiWalletSummary(WS), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(h.ai).toHaveBeenCalledWith(WS);
    expect(result.current.data).toEqual({ cycleRemainingIrr: 300_000, purchasedRemainingIrr: 50_000, totalRemainingIrr: 350_000 });
  });

  it('is null when billing cannot be read (403 or any other error)', async () => {
    h.ai.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const { result } = renderHook(() => useAiWalletSummary(WS), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});

describe('the client has no billing v2 left', () => {
  it('no v2 page, component or module exists', () => {
    for (const file of [
      'src/pages/app/billing/WorkspaceBillingPage.tsx',
      'src/pages/app/billing/PaymentPage.tsx',
      'src/components/billing/RetiredV2PaymentRoute.tsx',
      'src/lib/billingApi.ts',
      'src/lib/billing-i18n.ts',
      'src/pages/admin/BillingPage.tsx',
      'src/pages/admin/finance/FinanceLedgerTabs.tsx',
      'shared/billingMode.ts',
    ]) expect(existsSync(join(process.cwd(), file)), file).toBe(false);
  });

  it('the app has no /billing/pay route and the billing page is the account page', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(app).not.toMatch(/billing\/pay/);
    const page = readFileSync(join(process.cwd(), 'src', 'pages', 'app', 'BillingPage.tsx'), 'utf8');
    expect(page).toMatch(/AccountBillingPage/);
  });
});
