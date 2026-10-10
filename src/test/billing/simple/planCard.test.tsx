/**
 * Workspace → Billing, the plan (simple billing, phase 3): the period and the
 * next one's price, the warning in the last 7 days of an unpaid period,
 * renewing from the balance or online, a scheduled change and its cancel,
 * auto-renew, and choosing a plan — every amount comes from the server's
 * quote; the page only shows it and asks to confirm.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Like the real provider, the translator keeps its identity between renders.
const i18n = vi.hoisted(() => ({
  t: (k: string, vars?: Record<string, string>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
}));
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: i18n.t, locale: 'en', dir: 'ltr' }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const openPaddle = vi.fn();
vi.mock('@/lib/paddleCheckout', () => ({ openPaddleCheckout: (...a: unknown[]) => openPaddle(...a) }));
vi.mock('@/lib/edition', async (orig) => ({ ...(await orig<object>()), currentEdition: () => 'international' }));

const api = {
  view: vi.fn(),
  ledger: vi.fn(),
  receipt: vi.fn(),
  saveProfile: vi.fn(),
  topup: vi.fn(),
  verify: vi.fn(),
  payment: vi.fn(),
  plans: vi.fn(),
  quote: vi.fn(),
  buyPlan: vi.fn(),
  renew: vi.fn(),
  upgrade: vi.fn(),
  change: vi.fn(),
  setAutoRenew: vi.fn(),
  checkout: vi.fn(),
};
vi.mock('@/lib/accountBillingApi', () => ({ accountBillingApi: api }));

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const AccountBillingPage = (await import('@/pages/app/billing/account/AccountBillingPage')).default;

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const PAID = {
  edition: 'international',
  currency: 'USD',
  balance_minor: 5000,
  auto_renew: false,
  billing_profile: {},
  vat_percent: 10 as number | null,
  plan: {
    plan_id: 'pro', slug: 'pro', name: 'Pro', localized: {}, is_free: false, status: 'active',
    billing_interval: 'monthly', current_period_start: inDays(-27), current_period_end: inDays(3), trial_end: null,
  },
  has_account: true,
  can_manage: true,
  gateways: [{ provider_name: 'paddle', display_name: { en: 'Card (Paddle)' }, is_test: false }],
  paid_period: { plan_id: 'pro', billing_interval: 'monthly', current_period_start: inDays(-27), current_period_end: inDays(3) },
  scheduled_plan: null as null | { id: string; name: string; localized: Record<string, unknown>; is_free: boolean },
  scheduled_interval: null as null | string,
  next_period_prepaid_minor: null as number | null,
  renewal: { plan_id: 'pro', billing_interval: 'monthly', price_minor: 2900 },
  days_left: 3,
};

const FREE = {
  ...PAID,
  balance_minor: 1000,
  plan: { plan_id: 'free', slug: 'free', name: 'Free', localized: {}, is_free: true, status: null, billing_interval: null,
    current_period_start: null, current_period_end: null, trial_end: null },
  paid_period: null,
  renewal: null,
  days_left: null,
};

const PLANS = [
  { id: 'free', slug: 'free', name: 'Free', description: null, localized: {}, is_free: true, sort_order: 0, limits: {}, entitlements: {}, price_monthly_minor: 0, price_yearly_minor: 0 },
  { id: 'pro', slug: 'pro', name: 'Pro', description: null, localized: {}, is_free: false, sort_order: 1, limits: { max_agents: 5 }, entitlements: {}, price_monthly_minor: 2900, price_yearly_minor: 29000 },
  { id: 'biz', slug: 'biz', name: 'Business', description: null, localized: {}, is_free: false, sort_order: 2, limits: {}, entitlements: {}, price_monthly_minor: 9900, price_yearly_minor: null },
];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/acme/billing']}>
      <Routes>
        <Route path="/:slug/billing" element={<AccountBillingPage workspaceId="ws-1" slug="acme" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  openPaddle.mockReset();
  api.ledger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  api.plans.mockResolvedValue({ currency: 'USD', plans: PLANS });
});

describe('the plan card', () => {
  it('warns in the last days of an unpaid period and renews from the balance', async () => {
    api.view.mockResolvedValue(PAID);
    api.renew.mockResolvedValue({ action: 'prepaid' });
    renderPage();
    const card = await screen.findByTestId('plan-card');
    expect(within(card).getByTestId('plan-warning')).toHaveTextContent('billing.account.plan.endsSoon {"days":"3"}');
    expect(within(card).getByTestId('plan-renewal')).toHaveTextContent('$29.00');
    fireEvent.click(within(card).getByText(/billing\.account\.plan\.renewFromBalance/));
    await waitFor(() => expect(api.renew).toHaveBeenCalledWith('ws-1'));
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
  });

  it('with too little balance, renews online: the rest plus VAT, at the chosen gateway', async () => {
    api.view.mockResolvedValue({ ...PAID, balance_minor: 1000 });
    api.checkout.mockResolvedValue({
      success: true, paymentId: 'pay1', provider: 'paddle', purpose: 'renewal', currency: 'USD', net_minor: 1900, tax_minor: 190, amount_minor: 2090,
      clientCheckout: { provider: 'paddle', transactionId: 'txn_1' },
    });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.renewOnline'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('pay-online-total')).toHaveTextContent('$20.90');
    fireEvent.click(within(dialog).getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledWith('ws-1', expect.objectContaining({ purpose: 'renewal', currency: 'USD', providerName: 'paddle' })));
    await waitFor(() => expect(openPaddle).toHaveBeenCalled());
  });

  it('a paid next period shows no warning and no renew button', async () => {
    api.view.mockResolvedValue({ ...PAID, next_period_prepaid_minor: 2900 });
    renderPage();
    const card = await screen.findByTestId('plan-card');
    expect(within(card).queryByTestId('plan-warning')).toBeNull();
    expect(within(card).getByText('billing.account.plan.nextPaid')).toBeInTheDocument();
    expect(within(card).queryByText(/renewFromBalance/)).toBeNull();
  });

  it('shows a scheduled change, which can be cancelled', async () => {
    api.view.mockResolvedValue({ ...PAID, scheduled_plan: { id: 'free', name: 'Free', localized: {}, is_free: true } });
    api.change.mockResolvedValue({ action: 'change_cancelled' });
    renderPage();
    const scheduled = await screen.findByTestId('plan-scheduled');
    fireEvent.click(within(scheduled).getByText('billing.account.plan.cancelChange'));
    await waitFor(() => expect(api.change).toHaveBeenCalledWith('ws-1', 'pro', 'monthly'));
  });

  it('turns auto-renew on', async () => {
    api.view.mockResolvedValue(PAID);
    api.setAutoRenew.mockResolvedValue({ auto_renew: true });
    renderPage();
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(api.setAutoRenew).toHaveBeenCalledWith('ws-1', true));
  });
});

describe('choosing a plan', () => {
  it('on Free: picks a plan, shows the server quote, and buys it from the balance once', async () => {
    api.view.mockResolvedValue({ ...FREE, balance_minor: 5000 });
    api.quote.mockResolvedValue({
      kind: 'purchase', plan_id: 'pro', billing_interval: 'monthly', currency: 'USD', amount_minor: 2900, returned_minor: 0,
      period_price_minor: 2900, effective_at: inDays(0), months_left: null, balance_minor: 5000, shortfall_minor: 0, next_period_option: false,
    });
    api.buyPlan.mockResolvedValue({ action: 'purchase' });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.choose'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByTestId('plan-option-pro'));
    await waitFor(() => expect(api.quote).toHaveBeenCalledWith('ws-1', 'pro', 'monthly'));
    const quote = await within(dialog).findByTestId('plan-quote');
    fireEvent.click(await within(quote).findByText(/billing\.account\.picker\.payFromBalance/));
    await waitFor(() => expect(api.buyPlan).toHaveBeenCalledWith('ws-1', expect.objectContaining({ planId: 'pro', interval: 'monthly', key: expect.any(String) })));
  });

  it('a plan the balance cannot cover is paid online for what is missing', async () => {
    api.view.mockResolvedValue(FREE);
    api.quote.mockResolvedValue({
      kind: 'purchase', plan_id: 'pro', billing_interval: 'monthly', currency: 'USD', amount_minor: 2900, returned_minor: 0,
      period_price_minor: 2900, effective_at: inDays(0), months_left: null, balance_minor: 1000, shortfall_minor: 1900, next_period_option: false,
    });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.choose'));
    fireEvent.click(await screen.findByTestId('plan-option-pro'));
    fireEvent.click(await screen.findByText('billing.account.picker.payOnline'));
    const dialog = await screen.findByRole('dialog');
    // $19.00 missing + 10% VAT.
    expect(within(dialog).getByTestId('pay-online-total')).toHaveTextContent('$20.90');
  });

  it('an upgrade near the period end may also start from the next period instead', async () => {
    api.view.mockResolvedValue(PAID);
    api.quote.mockResolvedValue({
      kind: 'upgrade', plan_id: 'biz', billing_interval: 'monthly', currency: 'USD', amount_minor: 7000, returned_minor: 0,
      period_price_minor: 9900, effective_at: inDays(0), months_left: null, balance_minor: 5000, shortfall_minor: 2000, next_period_option: true,
    });
    api.change.mockResolvedValue({ action: 'change_scheduled' });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.change'));
    fireEvent.click(await screen.findByTestId('plan-option-biz'));
    const quote = await screen.findByTestId('plan-quote');
    expect(await within(quote).findByText(/billing\.account\.picker\.upgradeNow/)).toHaveTextContent('$70.00');
    fireEvent.click(within(quote).getByText('billing.account.picker.fromNextPeriod'));
    await waitFor(() => expect(api.change).toHaveBeenCalledWith('ws-1', 'biz', 'monthly'));
  });
});
