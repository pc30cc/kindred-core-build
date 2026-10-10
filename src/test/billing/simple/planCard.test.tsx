/**
 * Workspace → Billing, the plan (simple billing, phase 3): the period and the
 * next one's price, the warning in the last 7 days of an unpaid period,
 * renewing from the balance (for the period shown) or online, a scheduled
 * change and its cancel (through the picker, which shows what it moves),
 * auto-renew, renewing a plan that ran out, and choosing a plan — every
 * amount comes from the server's quote; the page only shows it, asks to
 * confirm, and sends the amount it showed back.
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
const edition = vi.hoisted(() => ({ current: 'international' }));
vi.mock('@/lib/edition', async (orig) => ({ ...(await orig<object>()), currentEdition: () => edition.current }));

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
  chargeCardUpgrade: vi.fn(),
  updateCard: vi.fn(),
  removeCard: vi.fn(),
};
vi.mock('@/lib/accountBillingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/accountBillingApi')>()),
  accountBillingApi: api,
}));

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const AccountBillingPage = (await import('@/pages/app/billing/account/AccountBillingPage')).default;
const { billingDate } = await import('@/pages/app/billing/shared');

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const PERIOD_END = inDays(3);

const PAID = {
  edition: 'international',
  currency: 'USD',
  balance_minor: 5000,
  auto_renew: false,
  billing_profile: {},
  vat_percent: 10 as number | null,
  plan: {
    plan_id: 'pro', slug: 'pro', name: 'Pro', localized: {}, is_free: false, status: 'active',
    billing_interval: 'monthly', current_period_start: inDays(-27), current_period_end: PERIOD_END, trial_end: null,
  },
  has_account: true,
  can_manage: true,
  gateways: [{ provider_name: 'paddle', display_name: { en: 'Card (Paddle)' }, is_test: false }],
  paid_period: { plan_id: 'pro', billing_interval: 'monthly', current_period_start: inDays(-27), current_period_end: PERIOD_END },
  scheduled_plan: null as null | { id: string; name: string; localized: Record<string, unknown>; is_free: boolean },
  scheduled_interval: null as null | string,
  next_period_prepaid_minor: null as number | null,
  renewal: { plan_id: 'pro', name: 'Pro', localized: {}, billing_interval: 'monthly', price_minor: 2900 } as
    null | { plan_id: string; name: string; localized: Record<string, unknown>; billing_interval: string; price_minor: number | null },
  lapsed: null as null | { plan_id: string; name: string; localized: Record<string, unknown>; billing_interval: string; price_minor: number | null },
  days_left: 3,
};

const FREE = {
  ...PAID,
  balance_minor: 1000,
  plan: { plan_id: 'free', slug: 'free', name: 'Free', localized: {}, is_free: true, status: null as string | null, billing_interval: null,
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

/** A server quote: the fields the page reads, with neutral defaults. */
const quoteOf = (q: Record<string, unknown>) => ({
  plan_id: 'pro', billing_interval: 'monthly', currency: 'USD', amount_minor: 0, returned_minor: 0,
  period_price_minor: 2900, upgrade_cost_minor: null, effective_at: inDays(0), period_end: null, months_left: null,
  balance_minor: 5000, shortfall_minor: 0, prepaid_minor: null, next_period_price_minor: null, auto_renew: false,
  next_period_option: false, next_period_amount_minor: 0, next_period_returned_minor: 0,
  ...q,
});

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
  edition.current = 'international';
  window.sessionStorage.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  openPaddle.mockReset();
  api.ledger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  api.plans.mockResolvedValue({ currency: 'USD', plans: PLANS });
});

describe('the plan card', () => {
  it('warns in the last days of an unpaid period and renews from the balance, for the period it shows', async () => {
    api.view.mockResolvedValue(PAID);
    api.renew.mockResolvedValue({ action: 'prepaid' });
    renderPage();
    const card = await screen.findByTestId('plan-card');
    expect(within(card).getByTestId('plan-warning')).toHaveTextContent('billing.account.plan.endsSoon {"days":"3"}');
    expect(within(card).getByTestId('plan-renewal')).toHaveTextContent('$29.00');
    fireEvent.click(within(card).getByText(/billing\.account\.plan\.renewFromBalance/));
    await waitFor(() => expect(api.renew).toHaveBeenCalledWith('ws-1', PERIOD_END, 2900));
    expect(api.renew).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
  });

  it('says "1 day" in the singular', async () => {
    api.view.mockResolvedValue({ ...PAID, days_left: 1 });
    renderPage();
    expect(await screen.findByTestId('plan-warning')).toHaveTextContent('billing.account.plan.endsSoonOne');
  });

  it('with too little balance, renews online: the rest plus VAT, at the chosen gateway, named after the plan it pays for', async () => {
    api.view.mockResolvedValue({
      ...PAID,
      balance_minor: 1000,
      scheduled_plan: { id: 'biz', name: 'Business', localized: {}, is_free: false },
      renewal: { plan_id: 'biz', name: 'Business', localized: {}, billing_interval: 'monthly', price_minor: 2900 },
    });
    api.checkout.mockResolvedValue({
      success: true, paymentId: 'pay1', provider: 'paddle', purpose: 'renewal', currency: 'USD', net_minor: 1900, tax_minor: 190, amount_minor: 2090,
      clientCheckout: { provider: 'paddle', transactionId: 'txn_1' },
    });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.renewOnline'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('billing.account.plan.renewOnlineTitle {"plan":"Business"}')).toBeInTheDocument();
    expect(within(dialog).getByTestId('pay-online-total')).toHaveTextContent('$20.90');
    fireEvent.click(within(dialog).getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      purpose: 'renewal', currency: 'USD', providerName: 'paddle', expectedNetMinor: 2900,
    })));
    await waitFor(() => expect(openPaddle).toHaveBeenCalled());
  });

  it('a next period already paid through billing v2 shows as paid, with no renew button', async () => {
    api.view.mockResolvedValue({ ...PAID, next_period_paid: true });
    renderPage();
    const card = await screen.findByTestId('plan-card');
    expect(within(card).queryByTestId('plan-warning')).toBeNull();
    expect(within(card).getByText('billing.account.plan.nextPaid')).toBeInTheDocument();
    expect(within(card).queryByText(/renewFromBalance|renewOnline/)).toBeNull();
  });

  it('a plan that still applies (canceled at the period end, past due) is not offered as one that ran out', async () => {
    api.view.mockResolvedValue({
      ...FREE,
      plan: { ...PAID.plan, status: 'canceled' },
      lapsed: { plan_id: 'pro', name: 'Pro', localized: {}, billing_interval: 'monthly', price_minor: 2900 },
    });
    renderPage();
    await screen.findByTestId('plan-card');
    expect(screen.queryByTestId('plan-lapsed')).toBeNull();
    expect(screen.queryByText(/billing\.account\.plan\.renewLapsed/)).toBeNull();
  });

  it('when Paddle cannot open, says so (the dialog is already closed)', async () => {
    const { toast } = await import('@/lib/toast');
    api.view.mockResolvedValue({ ...PAID, balance_minor: 1000 });
    api.checkout.mockResolvedValue({
      success: true, paymentId: 'pay1', provider: 'paddle', purpose: 'renewal', currency: 'USD', net_minor: 1900, tax_minor: 190, amount_minor: 2090,
      clientCheckout: { provider: 'paddle', transactionId: 'txn_1' },
    });
    openPaddle.mockRejectedValue(new Error('Paddle.js failed to load'));
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.renewOnline'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByText('billing.account.topup.pay'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('billing.account.errors.CHECKOUT_PROVIDER_ERROR')));
  });

  it('a paid next period shows no warning and no renew button', async () => {
    api.view.mockResolvedValue({ ...PAID, next_period_prepaid_minor: 2900 });
    renderPage();
    const card = await screen.findByTestId('plan-card');
    expect(within(card).queryByTestId('plan-warning')).toBeNull();
    expect(within(card).getByText('billing.account.plan.nextPaid')).toBeInTheDocument();
    expect(within(card).queryByText(/renewFromBalance/)).toBeNull();
  });

  it('a scheduled change is cancelled through the picker, which first shows what it moves in the balance', async () => {
    api.view.mockResolvedValue({
      ...PAID,
      next_period_prepaid_minor: 900,
      scheduled_plan: { id: 'free', name: 'Free', localized: {}, is_free: true },
    });
    api.quote.mockResolvedValue(quoteOf({ kind: 'cancel_change', amount_minor: 2000, prepaid_minor: 900, next_period_price_minor: 2900, period_end: PERIOD_END }));
    api.change.mockResolvedValue({ action: 'change_cancelled' });
    renderPage();
    const scheduled = await screen.findByTestId('plan-scheduled');
    fireEvent.click(within(scheduled).getByText('billing.account.plan.cancelChange'));
    await waitFor(() => expect(api.quote).toHaveBeenCalledWith('ws-1', 'pro', 'monthly'));
    expect(api.change).not.toHaveBeenCalled();
    const quote = await screen.findByTestId('plan-quote');
    expect(within(quote).getByText(/billing\.account\.picker\.prepaidMore/)).toHaveTextContent('$20.00');
    fireEvent.click(within(quote).getByText('billing.account.plan.cancelChange'));
    await waitFor(() => expect(api.change).toHaveBeenCalledWith('ws-1', 'pro', 'monthly', 2000));
  });

  it('turns auto-renew on', async () => {
    api.view.mockResolvedValue(PAID);
    api.setAutoRenew.mockResolvedValue({ auto_renew: true });
    renderPage();
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(api.setAutoRenew).toHaveBeenCalledWith('ws-1', true));
  });

  it('a plan that ran out is offered again, on its own interval', async () => {
    api.view.mockResolvedValue({
      ...FREE,
      balance_minor: 30000,
      plan: { ...FREE.plan, status: 'expired' },
      lapsed: { plan_id: 'pro', name: 'Pro', localized: {}, billing_interval: 'yearly', price_minor: 29000 },
    });
    api.quote.mockResolvedValue(quoteOf({ kind: 'purchase', billing_interval: 'yearly', amount_minor: 29000, period_price_minor: 29000, balance_minor: 30000 }));
    api.buyPlan.mockResolvedValue({ action: 'purchase' });
    renderPage();
    expect(await screen.findByTestId('plan-lapsed')).toHaveTextContent('billing.account.plan.lapsedNote {"plan":"Pro"}');
    fireEvent.click(screen.getByText('billing.account.plan.renewLapsed {"plan":"Pro"}'));
    await waitFor(() => expect(api.quote).toHaveBeenCalledWith('ws-1', 'pro', 'yearly'));
    const quote = await screen.findByTestId('plan-quote');
    fireEvent.click(await within(quote).findByText(/billing\.account\.picker\.payFromBalance/));
    await waitFor(() => expect(api.buyPlan).toHaveBeenCalledWith('ws-1', expect.objectContaining({ planId: 'pro', interval: 'yearly', expectedNetMinor: 29000 })));
  });
});

describe('choosing a plan', () => {
  it('on Free: picks a plan, shows the server quote, and buys it from the balance once', async () => {
    api.view.mockResolvedValue({ ...FREE, balance_minor: 5000 });
    api.quote.mockResolvedValue(quoteOf({ kind: 'purchase', amount_minor: 2900 }));
    let finish: (v: unknown) => void = () => {};
    api.buyPlan.mockReturnValue(new Promise((r) => { finish = r; }));
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.choose'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('plan-option-free')).toHaveTextContent('billing.account.picker.current');
    fireEvent.click(await within(dialog).findByTestId('plan-option-pro'));
    await waitFor(() => expect(api.quote).toHaveBeenCalledWith('ws-1', 'pro', 'monthly'));
    const quote = await within(dialog).findByTestId('plan-quote');
    const pay = await within(quote).findByText(/billing\.account\.picker\.payFromBalance/);
    fireEvent.click(pay);
    fireEvent.click(pay);
    finish({ action: 'purchase' });
    await waitFor(() => expect(api.buyPlan).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      planId: 'pro', interval: 'monthly', key: expect.any(String), expectedNetMinor: 2900,
    })));
    expect(api.buyPlan).toHaveBeenCalledTimes(1);
  });

  it('during a trial the free plan is not the current one', async () => {
    api.view.mockResolvedValue({ ...FREE, plan: { ...FREE.plan, plan_id: 'trial', slug: 'trial', is_free: false, status: 'trialing', trial_end: inDays(5) } });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.choose'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('plan-option-free')).not.toHaveTextContent('billing.account.picker.current');
  });

  it('a plan the balance cannot cover is paid online for what is missing', async () => {
    api.view.mockResolvedValue(FREE);
    api.quote.mockResolvedValue(quoteOf({ kind: 'purchase', amount_minor: 2900, balance_minor: 1000, shortfall_minor: 1900 }));
    api.checkout.mockResolvedValue({ success: true, paymentId: 'p', provider: 'paddle', currency: 'USD', net_minor: 1900, tax_minor: 190, amount_minor: 2090, clientCheckout: { provider: 'paddle' } });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.choose'));
    fireEvent.click(await screen.findByTestId('plan-option-pro'));
    fireEvent.click(await screen.findByText('billing.account.picker.payOnline'));
    const dialog = await screen.findByRole('dialog');
    // $19.00 missing + 10% VAT.
    expect(within(dialog).getByTestId('pay-online-total')).toHaveTextContent('$20.90');
    fireEvent.click(within(dialog).getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledWith('ws-1', expect.objectContaining({ purpose: 'plan', planId: 'pro', expectedNetMinor: 2900 })));
  });

  it('an upgrade shows what a prepaid next period now costs, and near the period end may start from the next period instead', async () => {
    api.view.mockResolvedValue({ ...PAID, next_period_prepaid_minor: 2900 });
    api.quote.mockResolvedValue(quoteOf({
      kind: 'upgrade', plan_id: 'biz', amount_minor: 14000, upgrade_cost_minor: 7000, period_price_minor: 9900,
      prepaid_minor: 2900, next_period_price_minor: 9900, period_end: PERIOD_END, balance_minor: 20000,
      next_period_option: true, next_period_amount_minor: 7000,
    }));
    api.change.mockResolvedValue({ action: 'change_scheduled' });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.change'));
    fireEvent.click(await screen.findByTestId('plan-option-biz'));
    const quote = await screen.findByTestId('plan-quote');
    expect(await within(quote).findByText(/billing\.account\.picker\.upgradeNow/)).toHaveTextContent('$70.00');
    expect(within(quote).getByText(/billing\.account\.picker\.prepaidMore/)).toHaveTextContent('$70.00');
    expect(within(quote).getByText(/billing\.account\.picker\.upgradeFromBalance/)).toHaveTextContent('$140.00');
    const later = within(quote).getByTestId('next-period-option');
    expect(later).toHaveTextContent(billingDate(PERIOD_END, 'en'));
    expect(later).toHaveTextContent('billing.account.picker.nextPeriodOptionMore');
    fireEvent.click(within(later).getByText('billing.account.picker.fromNextPeriod'));
    await waitFor(() => expect(api.change).toHaveBeenCalledWith('ws-1', 'biz', 'monthly', 7000));
  });

  it('a change at the period end without auto-renew says it needs the next period paid; a shortfall can be topped up', async () => {
    api.view.mockResolvedValue({ ...PAID, balance_minor: 0, next_period_prepaid_minor: null });
    api.quote.mockResolvedValue(quoteOf({ kind: 'schedule', plan_id: 'pro', billing_interval: 'yearly', period_price_minor: 29000, period_end: PERIOD_END, balance_minor: 0 }));
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.change'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'billing.account.plan.interval.yearly' }));
    fireEvent.click(await within(dialog).findByTestId('plan-option-pro'));
    const quote = await screen.findByTestId('plan-quote');
    expect(await within(quote).findByTestId('schedule-renewal-note')).toBeInTheDocument();

    // A prepaid next period that costs more now, with an empty balance: top up what is missing.
    api.quote.mockResolvedValue(quoteOf({
      kind: 'schedule', plan_id: 'pro', billing_interval: 'yearly', period_price_minor: 29000, period_end: PERIOD_END,
      amount_minor: 26100, prepaid_minor: 2900, next_period_price_minor: 29000, balance_minor: 0, shortfall_minor: 26100,
    }));
    fireEvent.click(within(dialog).getByTestId('plan-option-pro'));
    await waitFor(() => expect(api.quote).toHaveBeenCalledTimes(2));
    const topup = await within(await screen.findByTestId('plan-quote')).findByText(/billing\.account\.picker\.topupShort/);
    expect(within(screen.getByTestId('plan-quote')).getByText('billing.account.picker.confirmChange').closest('button')).toBeDisabled();
    fireEvent.click(topup);
    const topupDialog = await screen.findByRole('dialog');
    expect(within(topupDialog).getByLabelText('billing.account.topup.amount')).toHaveValue('261');
  });

  it('a yearly subscriber whose plans are not sold yearly sees the monthly ones', async () => {
    api.view.mockResolvedValue({ ...PAID, paid_period: { ...PAID.paid_period, billing_interval: 'yearly' } });
    api.plans.mockResolvedValue({ currency: 'USD', plans: PLANS.map((p) => ({ ...p, price_yearly_minor: p.is_free ? 0 : null })) });
    api.quote.mockResolvedValue(quoteOf({ kind: 'schedule', plan_id: 'biz' }));
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.change'));
    fireEvent.click(await screen.findByTestId('plan-option-biz'));
    await waitFor(() => expect(api.quote).toHaveBeenCalledWith('ws-1', 'biz', 'monthly'));
  });

  it('during a trial, Free is what follows the trial, not the current plan', async () => {
    const trialEnd = inDays(5);
    api.view.mockResolvedValue({ ...FREE, plan: { ...FREE.plan, plan_id: 'trial', slug: 'trial', is_free: false, status: 'trialing', trial_end: trialEnd } });
    api.quote.mockResolvedValue(quoteOf({ kind: 'unavailable', plan_id: 'free', reason: 'trial_running', effective_at: trialEnd }));
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.choose'));
    fireEvent.click(await screen.findByTestId('plan-option-free'));
    const quote = await screen.findByTestId('plan-quote');
    expect(await within(quote).findByText(/billing\.account\.picker\.freeAfterTrial/)).toHaveTextContent(billingDate(trialEnd, 'en'));
    expect(within(quote).queryByText('billing.account.picker.isCurrent')).toBeNull();
  });

  it('a monthly upgrade over a longer window names the months it pays for', async () => {
    api.view.mockResolvedValue(PAID);
    api.quote.mockResolvedValue(quoteOf({ kind: 'upgrade', plan_id: 'biz', amount_minor: 21000, upgrade_cost_minor: 21000, months_left: 3 }));
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.change'));
    fireEvent.click(await screen.findByTestId('plan-option-biz'));
    const quote = await screen.findByTestId('plan-quote');
    expect(await within(quote).findByText(/billing\.account\.picker\.upgradeMonths/)).toHaveTextContent('"months":"3"');
  });

  it('cancelling a change of a yearly plan stays yearly, even when nothing is sold yearly any more', async () => {
    api.view.mockResolvedValue({
      ...PAID,
      paid_period: { ...PAID.paid_period, billing_interval: 'yearly' },
      scheduled_interval: 'monthly',
    });
    api.plans.mockResolvedValue({ currency: 'USD', plans: PLANS.map((p) => ({ ...p, price_yearly_minor: p.is_free ? 0 : null })) });
    api.quote.mockResolvedValue(quoteOf({ kind: 'cancel_change', billing_interval: 'yearly' }));
    renderPage();
    fireEvent.click(within(await screen.findByTestId('plan-scheduled')).getByText('billing.account.plan.cancelChange'));
    await waitFor(() => expect(api.quote).toHaveBeenCalledWith('ws-1', 'pro', 'yearly'));
    await screen.findByTestId('plan-quote');
    expect(api.quote).not.toHaveBeenCalledWith('ws-1', 'pro', 'monthly');
    // The interval stays reachable for a yearly subscriber.
    expect(screen.getByRole('radio', { name: 'billing.account.plan.interval.monthly' })).toBeInTheDocument();
  });

  it('a price that moved since the quote is refused and the new quote shown', async () => {
    const { AccountApiError } = await import('@/lib/accountBillingApi');
    api.view.mockResolvedValue({ ...FREE, balance_minor: 5000 });
    api.quote.mockResolvedValue(quoteOf({ kind: 'purchase', amount_minor: 2900 }));
    api.buyPlan.mockRejectedValue(new AccountApiError('QUOTE_CHANGED', 409, { quote: quoteOf({ kind: 'purchase', amount_minor: 3900 }) }));
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.choose'));
    fireEvent.click(await screen.findByTestId('plan-option-pro'));
    const quote = await screen.findByTestId('plan-quote');
    fireEvent.click(await within(quote).findByText(/billing\.account\.picker\.payFromBalance/));
    // (The test translator returns keys, so the message reads as the generic one.)
    await waitFor(() => expect(within(screen.getByTestId('plan-quote')).getByRole('alert')).toBeInTheDocument());
    expect(within(screen.getByTestId('plan-quote')).getByText(/billing\.account\.picker\.payFromBalance/)).toHaveTextContent('$39.00');
    expect(api.quote).toHaveBeenCalledTimes(1);
  });
});

describe('the saved card (Multi Region)', () => {
  const NEXT_CHARGE = inDays(2);
  const CARD = {
    id: 'card-1', provider: 'paddle', status: 'active' as 'active' | 'past_due',
    brand: 'visa' as string | null, last4: '4242' as string | null, exp_month: 8 as number | null, exp_year: 2031 as number | null,
    auto_renew: true,
    next_charge_at: NEXT_CHARGE as string | null,
    next_charge_minor: 2900 as number | null,
    next_charge_plan: { plan_id: 'pro', name: 'Pro', localized: {} },
    next_charge_interval: 'monthly',
    scheduled_cancel_at: null as string | null,
    last_failure: null as null | { at: string; code: string | null },
    frozen_until: null as string | null,
    expires_before_next_charge: false,
  };
  const WITH_CARD = { ...PAID, auto_renew: true, card: CARD, card_available: true, card_providers: ['paddle'] };
  const cardText = (key: string) => new RegExp(`billing\\.account\\.card\\.${key}\\b`);

  it('says when the card is charged and how much, and that the plan renews; no warning and no online renewal', async () => {
    api.view.mockResolvedValue({ ...WITH_CARD, balance_minor: 0 });
    renderPage();
    const block = await screen.findByTestId('plan-card-block');
    expect(within(block).getByTestId('card-label')).toHaveTextContent('Visa •••• 4242');
    expect(block).toHaveTextContent('billing.account.card.expires');
    expect(block).toHaveTextContent('08/31');
    const next = within(block).getByTestId('card-next');
    expect(next).toHaveTextContent(cardText('charge'));
    expect(next).toHaveTextContent('$29.00');
    expect(next).toHaveTextContent(billingDate(NEXT_CHARGE, 'en'));
    expect(next).toHaveTextContent(billingDate(PERIOD_END, 'en'));
    const card = screen.getByTestId('plan-card');
    // The card pays: the plan renews, nothing warns, nothing asks to pay online.
    expect(card).toHaveTextContent('billing.account.plan.renewsOn');
    expect(within(card).queryByTestId('plan-warning')).toBeNull();
    expect(within(card).queryByText('billing.account.plan.renewOnline')).toBeNull();
    expect(within(card).queryByTestId('card-setup')).toBeNull();
  });

  it('a renewal already paid: the card is charged for the period after it', async () => {
    api.view.mockResolvedValue({ ...WITH_CARD, next_period_prepaid_minor: 2900 });
    renderPage();
    expect(await screen.findByTestId('card-next')).toHaveTextContent(cardText('chargeLater'));
  });

  it('the auto-renew switch is the card\'s, and turning it off asks the server (which asks Paddle)', async () => {
    api.view.mockResolvedValue(WITH_CARD);
    api.setAutoRenew.mockResolvedValue({ auto_renew: false, card: { ...CARD, auto_renew: false } });
    renderPage();
    const toggle = await screen.findByRole('switch');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText(/billing\.account\.card\.autoRenewHint/)).toHaveTextContent('Visa •••• 4242');
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setAutoRenew).toHaveBeenCalledWith('ws-1', false));
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
  });

  it('auto-renew off: the card is removed on Paddle\'s date, and the last days warn again', async () => {
    const removal = inDays(2);
    api.view.mockResolvedValue({
      ...WITH_CARD,
      auto_renew: false,
      balance_minor: 0,
      card: { ...CARD, auto_renew: false, next_charge_at: null, scheduled_cancel_at: removal },
    });
    renderPage();
    const next = await screen.findByTestId('card-next');
    expect(next).toHaveTextContent(cardText('removedOn'));
    expect(next).toHaveTextContent(billingDate(removal, 'en'));
    expect(screen.getByRole('switch')).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByTestId('plan-warning')).toBeInTheDocument();
    expect(screen.getByTestId('plan-card')).toHaveTextContent('billing.account.plan.endsOn');
    // Paying online for a renewal is refused while the card is live.
    expect(screen.queryByText('billing.account.plan.renewOnline')).toBeNull();
  });

  it('a failed renewal shows a red alert: update the card and pay, or renew from the balance (which removes the card)', async () => {
    api.view.mockResolvedValue({
      ...WITH_CARD,
      card: { ...CARD, status: 'past_due', last_failure: { at: inDays(-0.1), code: 'expired_card' } },
    });
    api.updateCard.mockResolvedValue({ clientCheckout: { provider: 'paddle', transactionId: 'txn_due' }, transactionId: 'txn_due' });
    api.renew.mockResolvedValue({ action: 'prepaid' });
    renderPage();
    const alert = await screen.findByTestId('card-past-due');
    expect(alert).toHaveTextContent('billing.account.card.pastDueTitle');
    expect(alert).toHaveTextContent('billing.account.card.failure.expired');
    expect(alert).toHaveTextContent(billingDate(PERIOD_END, 'en'));
    expect(alert).toHaveTextContent('billing.account.card.renewFromBalanceRemoves');
    expect(screen.queryByTestId('card-next')).toBeNull();
    // The red alert replaces the "ends soon" warning, and there is no second renew button.
    expect(screen.queryByTestId('plan-warning')).toBeNull();
    expect(screen.getAllByText(/billing\.account\.plan\.renewFromBalance/)).toHaveLength(1);

    fireEvent.click(within(alert).getByText('billing.account.card.updateAndPay'));
    await waitFor(() => expect(api.updateCard).toHaveBeenCalledWith('ws-1', expect.stringMatching(/\/acme\/billing\?card=paid$/)));
    await waitFor(() => expect(openPaddle).toHaveBeenCalledWith(
      { provider: 'paddle', transactionId: 'txn_due' },
      expect.objectContaining({ locale: 'en', onClosed: expect.any(Function) }),
    ));

    fireEvent.click(within(alert).getByText(/billing\.account\.plan\.renewFromBalance/));
    await waitFor(() => expect(api.renew).toHaveBeenCalledWith('ws-1', PERIOD_END, 2900));
  });

  it('changing the card opens Paddle, remembers the card as it was, and a closed overlay refreshes the page', async () => {
    api.view.mockResolvedValue(WITH_CARD);
    api.updateCard.mockResolvedValue({ clientCheckout: { provider: 'paddle', transactionId: 'txn_pm' }, transactionId: 'txn_pm' });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.card.change'));
    await waitFor(() => expect(api.updateCard).toHaveBeenCalledWith('ws-1', expect.stringMatching(/\/acme\/billing\?card=updated$/)));
    await waitFor(() => expect(openPaddle).toHaveBeenCalled());
    expect(JSON.parse(window.sessionStorage.getItem('billing:card-return:ws-1')!)).toMatchObject({ id: 'card-1', last4: '4242' });
    const views = api.view.mock.calls.length;
    const { onClosed } = openPaddle.mock.calls[0][1] as { onClosed: () => void };
    onClosed();
    await waitFor(() => expect(api.view.mock.calls.length).toBeGreaterThan(views));
  });

  it('removing the card asks first, and only then asks the server', async () => {
    api.view.mockResolvedValue(WITH_CARD);
    api.removeCard.mockResolvedValue({ removed: true });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.card.remove'));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('billing.account.card.removeConfirm');
    expect(confirm).toHaveTextContent('Visa •••• 4242');
    fireEvent.click(within(confirm).getByText('billing.common.cancel'));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.removeCard).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('billing.account.card.remove'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('billing.account.card.remove'));
    await waitFor(() => expect(api.removeCard).toHaveBeenCalledWith('ws-1'));
    expect(api.removeCard).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
  });

  it('a refused removal says why and keeps the card', async () => {
    const { AccountApiError } = await import('@/lib/accountBillingApi');
    api.view.mockResolvedValue(WITH_CARD);
    api.removeCard.mockRejectedValue(new AccountApiError('CARD_PROVIDER_ERROR', 502, null));
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.card.remove'));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByText('billing.account.card.remove'));
    // (The test translator returns keys, so the message reads as the generic one.)
    await waitFor(() => expect(within(screen.getByTestId('plan-card')).getByRole('alert')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('plan-card-block')).toBeInTheDocument();
    expect(api.view).toHaveBeenCalledTimes(1);
  });

  it('warns when the card expires before its next charge', async () => {
    api.view.mockResolvedValue({ ...WITH_CARD, card: { ...CARD, expires_before_next_charge: true } });
    renderPage();
    expect(await screen.findByTestId('card-expiring')).toHaveTextContent(cardText('expiresSoon'));
  });

  it('while Paddle is charging the renewal, renewing from the balance waits and says until when', async () => {
    api.view.mockResolvedValue({ ...WITH_CARD, card: { ...CARD, frozen_until: inDays(0.2) } });
    renderPage();
    expect(await screen.findByTestId('card-frozen')).toHaveTextContent(cardText('frozen'));
    expect(screen.getByText(/billing\.account\.plan\.renewFromBalance/).closest('button')).toBeDisabled();
  });

  it('an unknown brand reads as "card"', async () => {
    api.view.mockResolvedValue({ ...WITH_CARD, card: { ...CARD, brand: 'unknown' } });
    renderPage();
    expect(await screen.findByTestId('card-label')).toHaveTextContent('billing.account.card.genericBrand •••• 4242');
  });

  it('without a card, "turn on automatic card payments" pays the next period now with the box ticked and Paddle only', async () => {
    api.view.mockResolvedValue({
      ...PAID,
      card: null,
      card_available: true,
      card_providers: ['paddle'],
      gateways: [
        { provider_name: 'stripe', display_name: { en: 'Stripe' }, is_test: false },
        { provider_name: 'paddle', display_name: { en: 'Card (Paddle)' }, is_test: false },
      ],
    });
    api.checkout.mockResolvedValue({
      success: true, paymentId: 'pay-card', provider: 'paddle', purpose: 'renewal', currency: 'USD', net_minor: 2900, tax_minor: 290, amount_minor: 3190,
      clientCheckout: { provider: 'paddle', transactionId: 'txn_setup' },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('card-setup'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('billing.account.card.setupTitle {"plan":"Pro"}')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
    // The full price plus VAT, whatever the balance; then the same every month.
    expect(within(dialog).getByTestId('pay-online-total')).toHaveTextContent('$31.90');
    expect(within(dialog).getByTestId('pay-online-card-note')).toHaveTextContent('billing.account.payOnline.autoRenewMonthly');
    expect(within(dialog).getByTestId('pay-online-card-note')).toHaveTextContent('$31.90');
    expect(within(dialog).queryByText('Stripe')).toBeNull();
    fireEvent.click(within(dialog).getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      purpose: 'renewal', providerName: 'paddle', expectedNetMinor: 2900, autoRenew: true,
      callbackUrl: expect.stringMatching(/\/acme\/billing\?card=setup$/),
    })));
  });

  it('is not offered where no card can be saved, nor when the next period is already paid', async () => {
    api.view.mockResolvedValue({ ...PAID, card: null, card_available: false, card_providers: [] });
    const first = renderPage();
    await screen.findByTestId('plan-card');
    expect(screen.queryByTestId('card-setup')).toBeNull();
    first.unmount();

    api.view.mockResolvedValue({ ...PAID, card: null, card_available: true, card_providers: ['paddle'], next_period_prepaid_minor: 2900 });
    renderPage();
    await screen.findByTestId('plan-card');
    expect(screen.queryByTestId('card-setup')).toBeNull();
  });
});

describe('the Iranian edition', () => {
  /** The card's markup with Radix's generated ids made stable. */
  const markup = (el: HTMLElement) => {
    const ids = new Map<string, string>();
    return el.outerHTML.replace(/radix-[:«»\w-]+/g, (id) => {
      if (!ids.has(id)) ids.set(id, `radix-${ids.size}`);
      return ids.get(id) as string;
    });
  };

  it('renders the plan card exactly as before automatic card renewal existed', async () => {
    edition.current = 'iran';
    const PlanCard = (await import('@/pages/app/billing/account/PlanCard')).default;
    const end = '2026-11-01T00:00:00.000Z';
    const view = {
      ...PAID,
      edition: 'iran',
      currency: 'IRR',
      balance_minor: 1_000_000,
      auto_renew: true,
      vat_percent: 10,
      gateways: [{ provider_name: 'zarinpal', display_name: { en: 'Zarinpal' }, is_test: false }],
      plan: { ...PAID.plan, current_period_start: '2026-10-01T00:00:00.000Z', current_period_end: end },
      paid_period: { plan_id: 'pro', billing_interval: 'monthly', current_period_start: '2026-10-01T00:00:00.000Z', current_period_end: end },
      renewal: { plan_id: 'pro', name: 'Pro', localized: {}, billing_interval: 'monthly', price_minor: 5_000_000 },
      days_left: 3,
    };
    render(
      <PlanCard
        workspaceId="ws-ir"
        slug="acme"
        view={view as never}
        onChanged={() => undefined}
        onChoosePlan={() => undefined}
        onPayOnline={() => undefined}
      />,
    );
    await expect(markup(screen.getByTestId('plan-card'))).toMatchFileSnapshot('./__snapshots__/planCard.iran.html');
  });
});
