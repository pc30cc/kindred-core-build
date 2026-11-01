/**
 * WebYar's account currency after the dashboard's language (owner,
 * 2026-11-01, temporary, for Apple's App Review): Toman (IRR) for Persian,
 * US dollars (USD, paid with Apirone) for any other language, chosen by the
 * browser while the account has not moved money.
 *
 *   GET /api/billing/account/:ws → currency_choice
 *     - null outside the Iranian edition, for a member who cannot manage
 *       billing, for a platform admin without a role in the workspace, and
 *       unless both IRR and USD have a gateway listed for this viewer;
 *     - { options: ['IRR', 'USD'], switchable } otherwise; switchable while
 *       the account is open (no account, no balance, no ledger row, no
 *       payment that may still be credited, no card-to-card request waiting).
 *   PUT /api/billing/account/:ws/currency {currency}
 *     - managers only; a platform admin without a role in the workspace 403
 *       (browsing a customer never switches it);
 *     - 400 outside the Iranian edition or for another currency;
 *     - 409 CURRENCY_NOT_AVAILABLE for USD without a listed USD gateway;
 *     - 409 CURRENCY_LOCKED / CURRENCY_PAYMENT_PENDING from the SQL;
 *     - { currency } after billing_account_choose_currency (migration 292).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';

const WS = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international',
  auth: { userId: 'u1', isAdmin: false, role: 'owner' as string | null },
  /** Gateways listed per currency for the viewer (accountGateways). */
  listed: { IRR: ['zibal'], USD: ['apirone'] } as Record<string, string[]>,
  db: {} as Record<string, Row[]>,
  rpc: vi.fn(),
  view: { edition: 'iran', currency: 'IRR', balance_minor: 0, has_account: false } as Row,
}));

/** A query builder over h.db that applies eq / neq / in / gt / not-is-null, enough for these reads. */
function fakeClient() {
  return {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'limit', 'order', 'gte', 'update', 'insert']) b[m] = () => b;
      b.in = (col: string, v: unknown[]) => { filters.push((r) => v.includes(r[col])); return b; };
      b.eq = (col: string, v: unknown) => { filters.push((r) => r[col] === v); return b; };
      b.neq = (col: string, v: unknown) => { filters.push((r) => r[col] !== v); return b; };
      b.gt = (col: string, v: string) => { filters.push((r) => String(r[col]) > v); return b; };
      b.not = (col: string, op: string, v: unknown) => {
        if (op === 'is' && v === null) filters.push((r) => r[col] !== null && r[col] !== undefined);
        return b;
      };
      const rows = () => (h.db[table] ?? []).filter((r) => filters.every((f) => f(r)));
      b.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
      b.single = async () => ({ data: rows()[0] ?? null, error: null });
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
      return b;
    },
    rpc: (...a: unknown[]) => h.rpc(...a),
  };
}

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeClient() }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: () => fakeClient() }));
vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  serverConfigOf: (req: { serverConfig?: unknown }) => req.serverConfig,
  authorizeWorkspaceAccess: async (_req: unknown, res: { status(c: number): { json(b: unknown): void } }, _ws: string, opts: { manage?: boolean } = {}) => {
    if (opts.manage && !h.auth.isAdmin && !['owner', 'admin'].includes(String(h.auth.role))) {
      res.status(403).json({ error: 'Insufficient workspace permissions' });
      return null;
    }
    return { ...h.auth };
  },
}));
vi.mock('../../../server/services/billing/edition.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/edition.js')>()),
  getBillingRegion: async () =>
    h.edition === 'iran'
      ? { edition: 'iran', regionMode: 'iran', currency: 'IRR' }
      : { edition: 'international', regionMode: 'multi', currency: 'USD' },
}));
vi.mock('../../../server/services/billing/account/gateways.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/account/gateways.js')>()),
  accountGateways: async (_cfg: unknown, _ws: string, currency: string) =>
    (h.listed[currency] ?? []).map((name) => ({ provider_name: name, display_name: { en: name }, is_test: false })),
}));
vi.mock('../../../server/services/billing/account/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/account/index.js')>()),
  getAccountView: async () => ({ ...h.view, edition: h.edition }),
}));
vi.mock('../../../server/services/billing/account/plans.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/account/plans.js')>()),
  processDueNow: async () => undefined,
  accountPlanState: async () => ({ paid_period: null }),
}));
vi.mock('../../../server/services/billing/account/cardTransfer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/account/cardTransfer.js')>()),
  cardTransferForAccount: async () => null,
}));

const { billingAccountRouter } = await import('../../../server/routes/billingAccount.js');
const { accountCurrencyOpen } = await import('../../../server/services/billing/account/currencyChoice.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as unknown as { serverConfig: unknown }).serverConfig = { supabaseUrl: 'http://db', supabaseServiceRoleKey: 'k' };
  next();
});
app.use('/api/billing', billingAccountRouter);
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

const recent = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();
const old = () => new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  h.edition = 'iran';
  h.auth = { userId: 'u1', isAdmin: false, role: 'owner' };
  h.listed = { IRR: ['zibal'], USD: ['apirone'] };
  h.db = { workspace_members: [] };
  h.view = { edition: 'iran', currency: 'IRR', balance_minor: 0, has_account: false };
  h.rpc.mockReset().mockImplementation(async (fn: string, args: Row) =>
    fn === 'billing_account_choose_currency' ? { data: { workspace_id: WS, currency: args.p_currency }, error: null } : { data: null, error: null });
});

describe('GET /account: currency_choice', () => {
  it('a manager in WebYar with both currencies payable: IRR or USD, switchable while there is no account', async () => {
    const res = await call('GET', '');
    expect(res.status).toBe(200);
    expect(res.json.currency_choice).toEqual({ options: ['IRR', 'USD'], switchable: true });
  });

  it('not switchable once money moved, or while a payment may still be credited', async () => {
    h.db.billing_accounts = [{ workspace_id: WS, balance_minor: 0 }];
    h.db.billing_account_ledger = [{ id: 'l1', workspace_id: WS }];
    expect((await call('GET', '')).json.currency_choice).toEqual({ options: ['IRR', 'USD'], switchable: false });

    h.db.billing_account_ledger = [];
    h.db.billing_account_payments = [{ id: 'p1', workspace_id: WS, status: 'pending', verified_at: null, created_at: recent() }];
    expect((await call('GET', '')).json.currency_choice).toMatchObject({ switchable: false });

    // An old unpaid attempt no longer holds the currency.
    h.db.billing_account_payments = [{ id: 'p1', workspace_id: WS, status: 'pending', verified_at: null, created_at: old() }];
    expect((await call('GET', '')).json.currency_choice).toMatchObject({ switchable: true });
  });

  it('null outside the Iranian edition', async () => {
    h.edition = 'international';
    h.view = { ...h.view, currency: 'USD' };
    expect((await call('GET', '')).json.currency_choice).toBeNull();
  });

  it('null unless both currencies have a listed gateway for this viewer', async () => {
    h.listed = { IRR: ['zibal'], USD: [] };
    expect((await call('GET', '')).json.currency_choice).toBeNull();
    h.listed = { IRR: [], USD: ['apirone'] };
    expect((await call('GET', '')).json.currency_choice).toBeNull();
  });

  it('null for a member who cannot manage billing, and for a platform admin browsing a customer', async () => {
    h.auth = { userId: 'u2', isAdmin: false, role: 'member' };
    expect((await call('GET', '')).json.currency_choice).toBeNull();
    h.auth = { userId: 'admin', isAdmin: true, role: null };
    expect((await call('GET', '')).json.currency_choice).toBeNull();
    // A platform admin who is also the workspace's owner chooses like one.
    h.db.workspace_members = [{ workspace_id: WS, user_id: 'admin', role: 'owner' }];
    expect((await call('GET', '')).json.currency_choice).toEqual({ options: ['IRR', 'USD'], switchable: true });
  });
});

describe('PUT /account/:ws/currency', () => {
  it('switches an open account (and creates one) through billing_account_choose_currency', async () => {
    const res = await call('PUT', '/currency', { currency: 'usd' });
    expect(res).toEqual({ status: 200, json: { currency: 'USD' } });
    expect(h.rpc).toHaveBeenCalledWith('billing_account_choose_currency', { p_workspace_id: WS, p_currency: 'USD' });
  });

  it('back to Toman needs no gateway check', async () => {
    h.listed = { IRR: [], USD: [] };
    expect(await call('PUT', '/currency', { currency: 'IRR' })).toEqual({ status: 200, json: { currency: 'IRR' } });
  });

  it('managers only; a platform admin without a role in the workspace is refused', async () => {
    h.auth = { userId: 'u2', isAdmin: false, role: 'member' };
    expect((await call('PUT', '/currency', { currency: 'USD' })).status).toBe(403);
    h.auth = { userId: 'admin', isAdmin: true, role: null };
    expect(await call('PUT', '/currency', { currency: 'USD' })).toEqual({ status: 403, json: { error: 'NOT_A_WORKSPACE_MANAGER' } });
    h.db.workspace_members = [{ workspace_id: WS, user_id: 'admin', role: 'member' }];
    expect((await call('PUT', '/currency', { currency: 'USD' })).status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
    h.db.workspace_members = [{ workspace_id: WS, user_id: 'admin', role: 'admin' }];
    expect((await call('PUT', '/currency', { currency: 'USD' })).status).toBe(200);
  });

  it('400 outside the Iranian edition, for another currency, or a malformed body', async () => {
    h.edition = 'international';
    expect(await call('PUT', '/currency', { currency: 'USD' })).toMatchObject({ status: 400, json: { error: 'CURRENCY_NOT_SUPPORTED' } });
    h.edition = 'iran';
    expect(await call('PUT', '/currency', { currency: 'TRY' })).toMatchObject({ status: 400, json: { error: 'CURRENCY_NOT_SUPPORTED' } });
    expect(await call('PUT', '/currency', { currency: 'dollars' })).toMatchObject({ status: 400, json: { error: 'INVALID_REQUEST' } });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('409 CURRENCY_NOT_AVAILABLE for USD while no USD gateway is listed', async () => {
    h.listed = { IRR: ['zibal'], USD: [] };
    expect(await call('PUT', '/currency', { currency: 'USD' })).toMatchObject({ status: 409, json: { error: 'CURRENCY_NOT_AVAILABLE' } });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['billing_account_currency_locked', 'CURRENCY_LOCKED'],
    ['billing_account_payment_pending', 'CURRENCY_PAYMENT_PENDING'],
  ])('the SQL\'s %s is 409 %s', async (sqlError, code) => {
    h.rpc.mockResolvedValue({ data: null, error: { message: sqlError } });
    expect(await call('PUT', '/currency', { currency: 'USD' })).toMatchObject({ status: 409, json: { error: code } });
  });
});

describe('accountCurrencyOpen: the same rule as billing_account_choose_currency', () => {
  it('no account is open; a balance, a ledger row, a recorded confirmation or a waiting card-to-card request closes it', async () => {
    expect(await accountCurrencyOpen({} as never, WS)).toBe(true);
    h.db.billing_accounts = [{ workspace_id: WS, balance_minor: 10 }];
    expect(await accountCurrencyOpen({} as never, WS)).toBe(false);
    h.db.billing_accounts = [{ workspace_id: WS, balance_minor: 0 }];
    expect(await accountCurrencyOpen({} as never, WS)).toBe(true);
    h.db.billing_account_payments = [{ id: 'p', workspace_id: WS, status: 'expired', verified_at: old(), created_at: old() }];
    expect(await accountCurrencyOpen({} as never, WS)).toBe(false);
    h.db.billing_account_payments = [{ id: 'p', workspace_id: WS, status: 'failed', verified_at: null, created_at: recent() }];
    expect(await accountCurrencyOpen({} as never, WS)).toBe(true);
    h.db.billing_card_transfers = [{ id: 't', workspace_id: WS, status: 'pending' }];
    expect(await accountCurrencyOpen({} as never, WS)).toBe(false);
  });

  it('an Apirone payment holds it for two hours from its creation, whatever its status; another gateway\'s for its hour while pending', async () => {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();
    const pay = (provider: string, status: string, minutes: number) =>
      [{ id: 'p', workspace_id: WS, provider, status, verified_at: null, created_at: ago(minutes) }];
    h.db.billing_accounts = [{ workspace_id: WS, balance_minor: 0 }];
    h.db.billing_account_payments = pay('apirone', 'pending', 90);
    expect(await accountCurrencyOpen({} as never, WS)).toBe(false);
    h.db.billing_account_payments = pay('apirone', 'expired', 90);
    expect(await accountCurrencyOpen({} as never, WS)).toBe(false);
    h.db.billing_account_payments = pay('apirone', 'pending', 150);
    expect(await accountCurrencyOpen({} as never, WS)).toBe(true);
    h.db.billing_account_payments = pay('zibal', 'pending', 90);
    expect(await accountCurrencyOpen({} as never, WS)).toBe(true);
    h.db.billing_account_payments = pay('zibal', 'pending', 30);
    expect(await accountCurrencyOpen({} as never, WS)).toBe(false);
  });
});
