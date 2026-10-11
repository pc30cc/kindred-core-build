/**
 * Choosing a plan with a saved card (Multi Region): an upgrade is charged to
 * the card for exactly the quoted difference ("charge $X to Visa •••• 4242"),
 * with paying from the balance as the second choice when it covers it. A
 * charge Paddle has not confirmed yet (202) is asked about every few seconds
 * for up to a minute; a declined card (402) offers a top-up or the online
 * checkout; a failed renewal or a renewal under way holds every plan change,
 * and the dialog says why. Below Paddle's minimum the card is not offered.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

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
const { AccountApiError } = await import('@/lib/accountBillingApi');
const { accountErrorText } = await import('@/pages/app/billing/account/accountUi');

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const PERIOD_END = inDays(20);

const CARD = {
  id: 'card-1', provider: 'paddle', status: 'active' as 'active' | 'past_due',
  brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2031,
  auto_renew: true, next_charge_at: inDays(19), next_charge_minor: 2900,
  next_charge_plan: { plan_id: 'pro', name: 'Pro', localized: {} }, next_charge_interval: 'monthly',
  scheduled_cancel_at: null, last_failure: null as null | { at: string; code: string | null },
  frozen_until: null as string | null, expires_before_next_charge: false, chargeable: true,
};

const VIEW = {
  edition: 'international',
  currency: 'USD',
  balance_minor: 1000,
  auto_renew: true,
  billing_profile: {},
  vat_percent: null as number | null,
  plan: {
    plan_id: 'pro', slug: 'pro', name: 'Pro', localized: {}, is_free: false, status: 'active',
    billing_interval: 'monthly', current_period_start: inDays(-10), current_period_end: PERIOD_END, trial_end: null,
  },
  has_account: true,
  can_manage: true,
  gateways: [{ provider_name: 'paddle', display_name: { en: 'Card (Paddle)' }, is_test: false }],
  paid_period: { plan_id: 'pro', billing_interval: 'monthly', current_period_start: inDays(-10), current_period_end: PERIOD_END },
  scheduled_plan: null,
  scheduled_interval: null,
  next_period_prepaid_minor: null,
  renewal: { plan_id: 'pro', name: 'Pro', localized: {}, billing_interval: 'monthly', price_minor: 2900 },
  lapsed: null,
  days_left: 20,
  card: CARD as typeof CARD | null,
  card_available: true,
  card_providers: ['paddle'],
};

const PLANS = [
  { id: 'free', slug: 'free', name: 'Free', description: null, localized: {}, is_free: true, sort_order: 0, limits: {}, entitlements: {}, price_monthly_minor: 0, price_yearly_minor: 0 },
  { id: 'pro', slug: 'pro', name: 'Pro', description: null, localized: {}, is_free: false, sort_order: 1, limits: {}, entitlements: {}, price_monthly_minor: 2900, price_yearly_minor: 29000 },
  { id: 'biz', slug: 'biz', name: 'Business', description: null, localized: {}, is_free: false, sort_order: 2, limits: {}, entitlements: {}, price_monthly_minor: 9900, price_yearly_minor: null },
];

/** The upgrade to Business: $70 now, $10 in the balance. */
const UPGRADE = {
  kind: 'upgrade', plan_id: 'biz', billing_interval: 'monthly', currency: 'USD', amount_minor: 7000, returned_minor: 0,
  period_price_minor: 9900, upgrade_cost_minor: 7000, effective_at: inDays(0), period_end: PERIOD_END, months_left: null,
  balance_minor: 1000, shortfall_minor: 6000, prepaid_minor: null, next_period_price_minor: null, auto_renew: true,
  next_period_option: false, next_period_amount_minor: 0, next_period_returned_minor: 0,
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/acme/billing']}>
      <Routes>
        <Route path="/:slug/billing" element={<AccountBillingPage workspaceId="ws-1" slug="acme" />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Opens the picker on Business and waits for its quote. */
async function pickBusiness() {
  renderPage();
  fireEvent.click(await screen.findByText('billing.account.plan.change'));
  fireEvent.click(await screen.findByTestId('plan-option-biz'));
  return screen.findByTestId('plan-quote');
}

const chargeButton = (quote: HTMLElement) => within(quote).findByText(/billing\.account\.picker\.chargeCard/);

beforeEach(() => {
  window.sessionStorage.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  openPaddle.mockReset();
  api.view.mockResolvedValue(VIEW);
  api.ledger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  api.plans.mockResolvedValue({ currency: 'USD', plans: PLANS });
  api.quote.mockResolvedValue(UPGRADE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('an upgrade with a saved card', () => {
  it('charges the card the quoted difference and closes; the balance is not offered when it does not cover it', async () => {
    api.chargeCardUpgrade.mockResolvedValue({ status: 'succeeded', paymentId: 'pay-c1', purpose_result: { action: 'upgrade' } });
    const quote = await pickBusiness();
    const charge = await chargeButton(quote);
    expect(charge).toHaveTextContent('$70.00');
    expect(charge).toHaveTextContent('Visa •••• 4242');
    // The card replaces "pay online"; $10 in the balance does not cover $70.
    expect(within(quote).queryByText('billing.account.picker.payOnline')).toBeNull();
    expect(within(quote).queryByText(/billing\.account\.picker\.upgradeFromBalance/)).toBeNull();

    fireEvent.click(charge);
    fireEvent.click(charge);
    await waitFor(() => expect(api.chargeCardUpgrade).toHaveBeenCalledWith('ws-1', { planId: 'biz', expectedNetMinor: 7000, expectedTotalMinor: 7000 }));
    expect(api.chargeCardUpgrade).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
  });

  it('paying from the balance stays the second choice when it covers the upgrade', async () => {
    api.view.mockResolvedValue({ ...VIEW, balance_minor: 10000 });
    api.quote.mockResolvedValue({ ...UPGRADE, balance_minor: 10000, shortfall_minor: 0 });
    api.upgrade.mockResolvedValue({ action: 'upgrade' });
    const quote = await pickBusiness();
    expect(await chargeButton(quote)).toBeInTheDocument();
    fireEvent.click(within(quote).getByText(/billing\.account\.picker\.upgradeFromBalance/));
    await waitFor(() => expect(api.upgrade).toHaveBeenCalledWith('ws-1', 'biz', 7000));
    expect(api.chargeCardUpgrade).not.toHaveBeenCalled();
  });

  it('a charge Paddle confirms later (202) is asked about until it settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.chargeCardUpgrade.mockResolvedValue({ status: 'processing', paymentId: 'pay-c2' });
    api.payment
      .mockResolvedValueOnce({ id: 'pay-c2', status: 'pending', purpose: 'upgrade' })
      .mockResolvedValue({ id: 'pay-c2', status: 'succeeded', purpose: 'upgrade', purpose_result: { action: 'upgrade' } });
    const quote = await pickBusiness();
    fireEvent.click(await chargeButton(quote));
    expect(await within(quote).findByTestId('card-charging')).toHaveTextContent('billing.account.picker.cardProcessing');
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.payment).toHaveBeenCalledWith('ws-1', 'pay-c2');
    expect(api.payment).toHaveBeenCalledTimes(2);
  });

  it('after a minute without Paddle\'s answer it says the plan is upgraded once it comes, and never charges again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.chargeCardUpgrade.mockResolvedValue({ status: 'processing', paymentId: 'pay-c3' });
    api.payment.mockResolvedValue({ id: 'pay-c3', status: 'pending', purpose: 'upgrade' });
    const quote = await pickBusiness();
    fireEvent.click(await chargeButton(quote));
    for (let i = 0; i < 21; i += 1) await vi.advanceTimersByTimeAsync(3000);
    expect(await within(quote).findByTestId('card-charge-pending')).toHaveTextContent('billing.account.picker.cardPending');
    expect(api.payment).toHaveBeenCalledTimes(20);
    expect(api.chargeCardUpgrade).toHaveBeenCalledTimes(1);
  });

  it('the dialog may be left while Paddle confirms: asking stops, the page refreshes, and it opens again unlocked', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.chargeCardUpgrade.mockResolvedValue({ status: 'processing', paymentId: 'pay-c6' });
    api.payment.mockResolvedValue({ id: 'pay-c6', status: 'pending', purpose: 'upgrade' });
    const quote = await pickBusiness();
    fireEvent.click(await chargeButton(quote));
    await within(quote).findByTestId('card-charging');
    await vi.advanceTimersByTimeAsync(3000);
    const views = api.view.mock.calls.length;
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(api.view.mock.calls.length).toBeGreaterThan(views));
    const asked = api.payment.mock.calls.length;
    for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(3000);
    expect(api.payment).toHaveBeenCalledTimes(asked);

    fireEvent.click(screen.getByText('billing.account.plan.change'));
    fireEvent.click(await screen.findByTestId('plan-option-biz'));
    expect(await chargeButton(await screen.findByTestId('plan-quote'))).not.toBeDisabled();
  });

  it('a declined card (402) says why and offers a top-up or paying online instead', async () => {
    api.chargeCardUpgrade.mockRejectedValue(new AccountApiError('CARD_DECLINED', 402, { code: 'not_enough_balance' }));
    const quote = await pickBusiness();
    fireEvent.click(await chargeButton(quote));
    const declined = await within(quote).findByTestId('card-declined');
    expect(declined).toHaveTextContent('billing.account.picker.cardDeclined');
    expect(declined).toHaveTextContent('billing.account.card.failure.funds');
    expect(within(quote).queryByText(/billing\.account\.picker\.chargeCard/)).toBeNull();

    fireEvent.click(within(declined).getByText(/billing\.account\.picker\.topupShort/));
    const topup = await screen.findByRole('dialog');
    expect(within(topup).getByLabelText('billing.account.topup.amount')).toHaveValue('60');
  });

  it('declined: paying online opens the checkout for the upgrade', async () => {
    api.chargeCardUpgrade.mockRejectedValue(new AccountApiError('CARD_DECLINED', 402, { code: 'declined' }));
    const quote = await pickBusiness();
    fireEvent.click(await chargeButton(quote));
    await within(quote).findByTestId('card-declined');
    fireEvent.click(within(quote).getByText('billing.account.picker.payOnline'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('billing.account.picker.upgradeTitle {"plan":"Business"}')).toBeInTheDocument();
    // An upgrade never saves a card.
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('a decline reported while Paddle confirmed it later is shown the same way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.chargeCardUpgrade.mockResolvedValue({ status: 'processing', paymentId: 'pay-c4' });
    api.payment.mockResolvedValue({ id: 'pay-c4', status: 'failed', purpose: 'upgrade', failure_reason: 'card_declined' });
    const quote = await pickBusiness();
    fireEvent.click(await chargeButton(quote));
    await vi.advanceTimersByTimeAsync(3000);
    expect(await within(quote).findByTestId('card-declined')).toHaveTextContent('billing.account.picker.cardDeclined');
  });

  it('a payment that went through while the plan changed meanwhile says the money is in the balance', async () => {
    api.chargeCardUpgrade.mockResolvedValue({ status: 'succeeded', paymentId: 'pay-c5', purpose_result: { error: 'billing_period_changed' } });
    const quote = await pickBusiness();
    fireEvent.click(await chargeButton(quote));
    expect(await within(quote).findByTestId('card-charge-kept')).toHaveTextContent('billing.account.picker.cardKept');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
  });

  it('a price that moved is refused and the new quote shown; another charge under way is said so', async () => {
    api.chargeCardUpgrade.mockRejectedValueOnce(new AccountApiError('QUOTE_CHANGED', 409, { quote: { ...UPGRADE, amount_minor: 8000, upgrade_cost_minor: 8000 } }));
    const quote = await pickBusiness();
    fireEvent.click(await chargeButton(quote));
    await waitFor(() => expect(within(screen.getByTestId('plan-quote')).getByRole('alert')).toBeInTheDocument());
    expect(await chargeButton(screen.getByTestId('plan-quote'))).toHaveTextContent('$80.00');
    expect(api.quote).toHaveBeenCalledTimes(1);

    api.chargeCardUpgrade.mockRejectedValueOnce(new AccountApiError('CARD_CHARGE_IN_PROGRESS', 409, null));
    fireEvent.click(await chargeButton(screen.getByTestId('plan-quote')));
    await waitFor(() => expect(api.chargeCardUpgrade).toHaveBeenCalledTimes(2));
    expect(api.chargeCardUpgrade).toHaveBeenLastCalledWith('ws-1', { planId: 'biz', expectedNetMinor: 8000, expectedTotalMinor: 8000 });
    await waitFor(() => expect(within(screen.getByTestId('plan-quote')).getByRole('alert')).toBeInTheDocument());
  });

  it('a card whose gateway no longer offers card renewal is not charged: paying online is offered instead', async () => {
    api.view.mockResolvedValue({ ...VIEW, card: { ...CARD, chargeable: false }, card_available: false, card_providers: [] });
    const quote = await pickBusiness();
    expect(await within(quote).findByText('billing.account.picker.payOnline')).toBeInTheDocument();
    expect(within(quote).queryByText(/billing\.account\.picker\.chargeCard/)).toBeNull();
    expect(api.chargeCardUpgrade).not.toHaveBeenCalled();
  });

  it('charges only the total the button showed (VAT included); a VAT the page has not seen is refused and the page reloads it', async () => {
    api.view.mockResolvedValueOnce({ ...VIEW, vat_percent: null }).mockResolvedValue({ ...VIEW, vat_percent: 10 });
    api.chargeCardUpgrade.mockRejectedValueOnce(new AccountApiError('QUOTE_CHANGED', 409, { quote: UPGRADE, vat_percent: 10 }));
    const quote = await pickBusiness();
    const charge = await chargeButton(quote);
    expect(charge).toHaveTextContent('$70.00');
    fireEvent.click(charge);
    await waitFor(() => expect(api.chargeCardUpgrade).toHaveBeenCalledWith('ws-1', { planId: 'biz', expectedNetMinor: 7000, expectedTotalMinor: 7000 }));
    // The page reloads its view (and VAT): the button now shows what the card would really be charged.
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
    await waitFor(async () => expect(await chargeButton(screen.getByTestId('plan-quote'))).toHaveTextContent('$77.00'));
    api.chargeCardUpgrade.mockResolvedValue({ status: 'succeeded', paymentId: 'pay-c7', purpose_result: { action: 'upgrade' } });
    fireEvent.click(await chargeButton(screen.getByTestId('plan-quote')));
    await waitFor(() => expect(api.chargeCardUpgrade).toHaveBeenLastCalledWith('ws-1', { planId: 'biz', expectedNetMinor: 7000, expectedTotalMinor: 7700 }));
  });

  it('below Paddle\'s minimum the card is not offered', async () => {
    api.view.mockResolvedValue({ ...VIEW, balance_minor: 0 });
    api.quote.mockResolvedValue({ ...UPGRADE, amount_minor: 50, upgrade_cost_minor: 50, balance_minor: 0, shortfall_minor: 50 });
    const quote = await pickBusiness();
    expect(await within(quote).findByText('billing.account.picker.payOnline')).toBeInTheDocument();
    expect(within(quote).queryByText(/billing\.account\.picker\.chargeCard/)).toBeNull();
  });

  it('a failed renewal holds every plan change, and says why', async () => {
    api.view.mockResolvedValue({ ...VIEW, balance_minor: 10000, card: { ...CARD, status: 'past_due', last_failure: { at: inDays(0), code: 'declined' } } });
    api.quote.mockResolvedValue({ ...UPGRADE, balance_minor: 10000, shortfall_minor: 0 });
    const quote = await pickBusiness();
    expect(await within(quote).findByTestId('plan-card-blocked')).toHaveTextContent('billing.account.picker.cardPastDue');
    expect(within(quote).queryByText(/billing\.account\.picker\.chargeCard/)).toBeNull();
    expect(within(quote).getByText(/billing\.account\.picker\.upgradeFromBalance/).closest('button')).toBeDisabled();
  });

  it('while Paddle is charging the renewal, plan changes wait until the time it says', async () => {
    api.view.mockResolvedValue({ ...VIEW, card: { ...CARD, frozen_until: inDays(0.1) } });
    api.quote.mockResolvedValue({ ...UPGRADE, kind: 'schedule', plan_id: 'biz', amount_minor: 0, upgrade_cost_minor: null, shortfall_minor: 0 });
    const quote = await pickBusiness();
    expect(await within(quote).findByTestId('plan-card-blocked')).toHaveTextContent('billing.account.picker.cardFrozen');
    expect(within(quote).getByText('billing.account.picker.confirmChange').closest('button')).toBeDisabled();
  });

  it('a freeze that has passed holds nothing', async () => {
    api.view.mockResolvedValue({ ...VIEW, card: { ...CARD, frozen_until: inDays(-0.01) } });
    const quote = await pickBusiness();
    expect(await chargeButton(quote)).not.toBeDisabled();
    expect(within(quote).queryByTestId('plan-card-blocked')).toBeNull();
  });

  it('a plan bought online carries its full price, so its card can be saved', async () => {
    api.view.mockResolvedValue({ ...VIEW, plan: { ...VIEW.plan, plan_id: 'free', is_free: true }, paid_period: null, renewal: null, card: null });
    api.quote.mockResolvedValue({ ...UPGRADE, kind: 'purchase', plan_id: 'pro', amount_minor: 2900, period_price_minor: 2900, upgrade_cost_minor: null, shortfall_minor: 1900 });
    renderPage();
    fireEvent.click(await screen.findByText('billing.account.plan.choose'));
    fireEvent.click(await screen.findByTestId('plan-option-pro'));
    fireEvent.click(await screen.findByText('billing.account.picker.payOnline'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
    expect(within(dialog).getByTestId('pay-online-total')).toHaveTextContent('$29.00');
  });
});

describe('the card errors', () => {
  const CODES = [
    'CARD_NOT_AVAILABLE', 'CARD_ALREADY_SAVED', 'CARD_SETUP_IN_PROGRESS', 'CARD_SETUP_PURPOSE', 'CARD_PAYS_RENEWAL',
    'CARD_PAST_DUE', 'CARD_RENEWAL_IN_PROGRESS', 'CARD_CHARGE_IN_PROGRESS', 'CARD_CHARGE_BELOW_MINIMUM', 'CARD_DECLINED',
    'CARD_PROVIDER_ERROR', 'CARD_NOT_FOUND',
  ];
  const real = (messages: unknown) => (key: string) => {
    const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
    return typeof value === 'string' ? value : key;
  };

  for (const [name, messages] of [['en', en], ['fa', fa], ['tr', tr]] as const) {
    it(`each reads as its own message in ${name}`, () => {
      const t = real(messages);
      const generic = t('billing.account.errors.generic');
      for (const code of CODES) {
        const text = accountErrorText(new AccountApiError(code, 400, null), t as never);
        expect(text, code).not.toBe(generic);
        expect(text, code).not.toContain('billing.account');
      }
      // A decline names Paddle's reason when it gave one.
      const declined = accountErrorText(new AccountApiError('CARD_DECLINED', 402, { code: 'expired_card' }), t as never);
      expect(declined).toContain(t('billing.account.card.failure.expired'));
    });
  }
});
