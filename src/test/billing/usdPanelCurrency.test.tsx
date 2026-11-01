/**
 * WebYar (the Iranian edition), for Apple's App Review (owner, 2026-11-01):
 * a panel that is not in Persian pays in dollars — USDT on TRON through
 * Apirone — and a Persian panel in Toman through the Iranian gateways.
 *
 * - While the account has not moved money (view.currency_choice.switchable),
 *   the billing page asks the server once to take the panel language's
 *   currency, before it shows the account; a refusal is logged, never shown
 *   and never asked again on a reload of the view.
 * - A switch that runs while the page is shown keeps every payment button
 *   disabled, so nothing is started in the currency that is going away.
 * - Dollars read as dollars in the Iranian edition: balance, history,
 *   top-up dialog (with the crypto gateway's fee note).
 * - Back from Apirone, a payment the network has not confirmed yet is said
 *   calmly and checked every 15 s for five minutes; one that arrived short of
 *   a plan's price says the money is in the balance and the plan unchanged.
 * - The Overview's AI credit tile shows a dollar account's credit in dollars.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const i18n = vi.hoisted(() => ({
  locale: 'en',
  // Stable, like the real provider's useCallback: the page's loader keys on it.
  t: (k: string, vars?: Record<string, string>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
}));
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: i18n.t, locale: i18n.locale, dir: i18n.locale === 'fa' ? 'rtl' : 'ltr' }),
}));
vi.mock('@/hooks/useAdmin', () => ({ useIsGlobalAdmin: () => ({ data: false }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('@/lib/edition', async (orig) => ({ ...(await orig<object>()), currentEdition: () => 'iran' }));

const api = vi.hoisted(() => ({
  view: vi.fn(),
  ledger: vi.fn(),
  setCurrency: vi.fn(),
  verify: vi.fn(),
  payment: vi.fn(),
  topup: vi.fn(),
  ai: vi.fn(),
  cardTransfers: vi.fn(),
}));
vi.mock('@/lib/accountBillingApi', () => ({ accountBillingApi: api }));

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const AccountBillingPage = (await import('@/pages/app/billing/account/AccountBillingPage')).default;
const { money } = await import('@/pages/app/billing/shared');
const { panelCurrencySwitch, isCryptoGateway } = await import('@/pages/app/billing/account/accountUi');
const { aiCreditTileText } = await import('@/hooks/useAiWalletSummary');

const ZIBAL = { provider_name: 'zibal', display_name: { fa: 'زیبال', en: 'Zibal' }, is_test: false };
const APIRONE = { provider_name: 'apirone', display_name: { en: 'Crypto (USDT · TRON)' }, is_test: false };
const BOTH = { options: ['IRR', 'USD'], switchable: true };

const BASE = {
  edition: 'iran',
  auto_renew: false,
  billing_profile: {},
  vat_percent: null as number | null,
  plan: {
    plan_id: 'free', slug: 'free', name: 'Free', localized: {}, is_free: true, status: 'active',
    billing_interval: null, current_period_start: null, current_period_end: null, trial_end: null,
  },
  has_account: true,
  can_manage: true,
  paid_period: null,
  scheduled_plan: null,
  scheduled_interval: null,
  next_period_prepaid_minor: null,
  renewal: null,
  lapsed: null,
  days_left: null,
  card: null,
  card_available: false,
  card_providers: [],
  card_transfer: null,
};
/** An account that never moved money, in Toman (Webyar Demo before its first visit: no account yet). */
const TOMAN_OPEN = { ...BASE, has_account: false, currency: 'IRR', balance_minor: 0, vat_percent: 10, gateways: [ZIBAL], currency_choice: BOTH };
const DOLLAR_OPEN = { ...BASE, currency: 'USD', balance_minor: 0, gateways: [APIRONE], currency_choice: BOTH };

const EMPTY_LEDGER = { items: [], total: 0, page: 1, pageSize: 20 };

function pageAt(url = '/acme/billing') {
  return (
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/:slug/billing" element={<AccountBillingPage workspaceId="ws-1" slug="acme" />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderAt(url = '/acme/billing') {
  return render(pageAt(url));
}

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const topupButton = () => screen.getByText('billing.account.balance.topup').closest('button')!;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  window.sessionStorage.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  i18n.locale = 'en';
  api.ledger.mockResolvedValue(EMPTY_LEDGER);
  api.ai.mockRejectedValue(new Error('no AI section here'));
  api.cardTransfers.mockResolvedValue({ items: [] });
  api.setCurrency.mockResolvedValue({});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  warn.mockRestore();
});

describe('the account currency follows the panel language while no money moved', () => {
  it('an English panel switches an open Toman account to dollars once, before the page shows it', async () => {
    const put = deferred<Record<string, unknown>>();
    api.setCurrency.mockReturnValue(put.promise);
    api.view.mockResolvedValueOnce(TOMAN_OPEN).mockResolvedValue(DOLLAR_OPEN);
    renderAt();
    await waitFor(() => expect(api.setCurrency).toHaveBeenCalledWith('ws-1', 'USD'));
    // Meanwhile nothing is shown, so nothing can be paid in Toman.
    expect(screen.queryByText('billing.account.balance.topup')).toBeNull();
    expect(screen.queryByTestId('account-balance')).toBeNull();

    put.resolve({ currency: 'USD' });
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('$0.00'));
    expect(topupButton()).toBeEnabled();
    expect(api.setCurrency).toHaveBeenCalledTimes(1);
    expect(api.view).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('a Persian panel leaves an open Toman account alone', async () => {
    i18n.locale = 'fa';
    api.view.mockResolvedValue(TOMAN_OPEN);
    renderAt();
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('تومان'));
    expect(api.setCurrency).not.toHaveBeenCalled();
    expect(api.view).toHaveBeenCalledTimes(1);
  });

  it('a Persian panel switches an open dollar account back to Toman', async () => {
    i18n.locale = 'fa';
    api.view.mockResolvedValueOnce(DOLLAR_OPEN).mockResolvedValue({ ...TOMAN_OPEN, has_account: true });
    renderAt();
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('تومان'));
    expect(api.setCurrency).toHaveBeenCalledTimes(1);
    expect(api.setCurrency).toHaveBeenCalledWith('ws-1', 'IRR');
  });

  it.each([
    ['no choice (the International edition, or only one currency payable)', { currency_choice: null }],
    ['no choice field at all (an older server)', { currency_choice: undefined }],
    ['money moved or a payment is pending', { currency_choice: { options: ['IRR', 'USD'], switchable: false } }],
    ['dollars not payable', { currency_choice: { options: ['IRR'], switchable: true } }],
    ['a member who cannot manage billing', { can_manage: false, gateways: [] }],
  ])('does nothing when there is %s', async (_label, patch) => {
    api.view.mockResolvedValue({ ...TOMAN_OPEN, ...patch });
    renderAt();
    await screen.findByTestId('account-balance');
    expect(api.setCurrency).not.toHaveBeenCalled();
    expect(api.view).toHaveBeenCalledTimes(1);
  });

  it('a refused switch is logged, not shown, and never asked again when the view reloads', async () => {
    api.view.mockResolvedValue(TOMAN_OPEN);
    api.ledger.mockResolvedValue({ ...EMPTY_LEDGER, total: 45 });
    api.setCurrency.mockRejectedValue(Object.assign(new Error('CURRENCY_LOCKED'), { code: 'CURRENCY_LOCKED', status: 409 }));
    renderAt();
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('Toman'));
    expect(topupButton()).toBeEnabled();
    expect(api.setCurrency).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();

    // Another page of the history reloads the view: still the one attempt.
    fireEvent.click(screen.getByText('›'));
    await waitFor(() => expect(api.ledger).toHaveBeenCalledWith('ws-1', 2, 20));
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
    expect(api.setCurrency).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('account-balance')).toHaveTextContent('Toman');
  });

  it('a switch while the page is shown keeps the payment buttons disabled until it is done', async () => {
    // Shown in dollars; on the next read another member had moved it to Toman.
    api.view.mockResolvedValueOnce(DOLLAR_OPEN).mockResolvedValueOnce(TOMAN_OPEN).mockResolvedValue(DOLLAR_OPEN);
    api.ledger.mockResolvedValue({ ...EMPTY_LEDGER, total: 45 });
    renderAt();
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('$0.00'));
    expect(api.setCurrency).not.toHaveBeenCalled();
    expect(topupButton()).toBeEnabled();
    expect(within(screen.getByTestId('plan-card')).getByText('billing.account.plan.choose').closest('button')).toBeEnabled();

    const put = deferred<Record<string, unknown>>();
    api.setCurrency.mockReturnValue(put.promise);
    fireEvent.click(screen.getByText('›'));
    await waitFor(() => expect(api.setCurrency).toHaveBeenCalledWith('ws-1', 'USD'));
    expect(topupButton()).toBeDisabled();
    expect(within(screen.getByTestId('plan-card')).getByText('billing.account.plan.choose').closest('button')).toBeDisabled();

    put.resolve({});
    await waitFor(() => expect(topupButton()).toBeEnabled());
    expect(within(screen.getByTestId('plan-card')).getByText('billing.account.plan.choose').closest('button')).toBeEnabled();
    expect(screen.getByTestId('account-balance')).toHaveTextContent('$0.00');
  });

  it('the language switched back and forth: each mismatch asks again (a switch that went through is not remembered)', async () => {
    // The server's account: whatever currency was last chosen.
    let server = 'IRR';
    api.view.mockImplementation(async () => (server === 'USD' ? DOLLAR_OPEN : TOMAN_OPEN));
    api.setCurrency.mockImplementation(async (_ws: string, currency: string) => {
      server = currency;
      return { currency };
    });
    const { rerender } = renderAt();
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('$0.00'));

    i18n.locale = 'fa';
    rerender(pageAt());
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('تومان'));

    i18n.locale = 'en';
    rerender(pageAt());
    await waitFor(() => expect(api.setCurrency).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('$0.00'));
    expect(api.setCurrency.mock.calls.map((c) => c[1])).toEqual(['USD', 'IRR', 'USD']);
    expect(topupButton()).toBeEnabled();
    // Each load read the view twice (before and after its switch), never more.
    expect(api.view).toHaveBeenCalledTimes(6);
  });

  it('the payment buttons stay disabled until the page shows the switched account, not only until the switch answers', async () => {
    api.view.mockResolvedValueOnce(DOLLAR_OPEN).mockResolvedValueOnce(TOMAN_OPEN);
    api.ledger.mockResolvedValue({ ...EMPTY_LEDGER, total: 45 });
    renderAt();
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('$0.00'));

    const reread = deferred<typeof DOLLAR_OPEN>();
    api.view.mockReturnValueOnce(reread.promise);
    const put = deferred<Record<string, unknown>>();
    api.setCurrency.mockReturnValue(put.promise);
    // Another page of the history: the view now reads Toman (another member's switch), so the page asks for dollars.
    fireEvent.click(screen.getByText('›'));
    await waitFor(() => expect(api.setCurrency).toHaveBeenCalledWith('ws-1', 'USD'));
    expect(topupButton()).toBeDisabled();

    put.resolve({ currency: 'USD' });
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(3));
    // Switched on the server, the account not shown again yet: still nothing can be paid.
    await new Promise((r) => setTimeout(r, 20));
    expect(topupButton()).toBeDisabled();
    expect(within(screen.getByTestId('plan-card')).getByText('billing.account.plan.choose').closest('button')).toBeDisabled();

    reread.resolve(DOLLAR_OPEN);
    await waitFor(() => expect(topupButton()).toBeEnabled());
    expect(screen.getByTestId('account-balance')).toHaveTextContent('$0.00');
  });

  it('panelCurrencySwitch: Persian asks for IRR, any other language for USD, only when switchable and offered', () => {
    const view = { currency: 'IRR', can_manage: true, currency_choice: BOTH };
    expect(panelCurrencySwitch(view, 'en')).toBe('USD');
    expect(panelCurrencySwitch(view, 'tr')).toBe('USD');
    expect(panelCurrencySwitch(view, 'fa')).toBeNull();
    expect(panelCurrencySwitch({ ...view, currency: 'USD' }, 'fa')).toBe('IRR');
    expect(panelCurrencySwitch({ ...view, currency: 'USD' }, 'en')).toBeNull();
    expect(panelCurrencySwitch({ ...view, currency_choice: { options: ['IRR', 'USD'], switchable: false } }, 'en')).toBeNull();
    expect(panelCurrencySwitch({ ...view, currency_choice: null }, 'en')).toBeNull();
    expect(panelCurrencySwitch({ ...view, can_manage: false }, 'en')).toBeNull();
  });
});

describe('dollars in the Iranian edition', () => {
  it('money(): a USD amount reads as dollars, IRR as Toman', () => {
    expect(money(2900, 'en', 'USD')).toBe('$29.00');
    expect(money(29000, 'en', 'USD')).toBe('$290.00');
    expect(money(2900, 'tr', 'USD')).toBe('$29,00');
    expect(money(2900, 'fa', 'USD')).toContain('$');
    expect(money(2900, 'fa', 'USD')).not.toMatch(/تومان/);
    expect(money(1_000_000, 'en', 'IRR')).toBe('100,000 Toman');
  });

  it('the balance, the history and the top-up dialog show dollars, with the crypto fee note and no VAT', async () => {
    api.view.mockResolvedValue({ ...DOLLAR_OPEN, balance_minor: 2900, currency_choice: { options: ['IRR', 'USD'], switchable: false } });
    api.ledger.mockResolvedValue({
      items: [{
        id: 'l1', kind: 'topup', amount_minor: 2900, balance_after: 2900, currency: 'USD', plan_id: null, billing_interval: null,
        period_start: null, period_end: null, payment_id: 'p1', receipt_number: 'WY2026-000010', net_minor: 2900, tax_minor: 0,
        tax_percent: null, buyer: null, seller: null, description: {}, created_at: '2026-11-01T08:00:00Z',
      }],
      total: 1, page: 1, pageSize: 20,
    });
    renderAt();
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('$29.00'));
    expect(screen.getAllByText('+$29.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Toman|تومان/)).toBeNull();

    fireEvent.click(topupButton());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('$10.00')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('billing.account.topup.amount'), { target: { value: '25' } });
    expect(within(dialog).queryByText(/billing\.account\.topup\.vat/)).toBeNull();
    expect(within(dialog).getByText('billing.account.topup.total').nextElementSibling).toHaveTextContent('$25.00');
    expect(dialog.querySelector('[data-crypto-fee-note]')).toHaveTextContent('billing.account.topup.cryptoAtCheckout');
  });

  it('the crypto fee note is only for a crypto gateway', () => {
    expect(isCryptoGateway('apirone')).toBe(true);
    expect(isCryptoGateway(' Apirone ')).toBe(true);
    expect(isCryptoGateway('zibal')).toBe(false);
    expect(isCryptoGateway(undefined)).toBe(false);
  });

  it('the Overview AI tile: Toman (no label) for a Toman account, dollars for a dollar account', () => {
    const wallet = { cycleRemainingIrr: 500_000, purchasedRemainingIrr: 0, totalRemainingIrr: 500_000 };
    expect(aiCreditTileText({ ...wallet, currency: 'IRR', availableMinor: 500_000 }, true, 'en')).toBe('50,000');
    expect(aiCreditTileText({ ...wallet, currency: 'USD', availableMinor: null }, true, 'en')).toBe('50,000');
    expect(aiCreditTileText({ ...wallet, currency: 'USD', availableMinor: 123 }, true, 'en')).toBe('$1.23');
  });
});

describe('back from Apirone', () => {
  it('a payment the network has not confirmed yet is said calmly and checked every 15 s for five minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.view.mockResolvedValue({ ...DOLLAR_OPEN, currency_choice: { options: ['IRR', 'USD'], switchable: false } });
      api.verify.mockResolvedValue({ status: 'pending' });
      api.payment.mockResolvedValue({ id: 'pay9', status: 'pending', purpose: 'plan', currency: 'USD', amount_minor: 2900, net_minor: 2900, tax_minor: 0, ledger_id: null, failure_reason: null });
      renderAt('/acme/billing?payment=pay9&provider=apirone');
      await waitFor(() => expect(api.verify).toHaveBeenCalledWith('ws-1', 'pay9', 'apirone', {}));
      expect(await screen.findByTestId('payment-checking')).toHaveTextContent('billing.account.result.cryptoPending');

      // Not every 3 s, as for a bank: every 15 s.
      await vi.advanceTimersByTimeAsync(3000);
      expect(api.verify).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(12_000);
      await waitFor(() => expect(api.verify).toHaveBeenCalledTimes(2));

      for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(15_000);
      await waitFor(() => expect(screen.getByTestId('payment-result')).toHaveTextContent('billing.account.result.cryptoPending'));
      expect(screen.getByTestId('payment-result')).not.toHaveTextContent('billing.account.result.failed');
      expect(screen.getByText('billing.account.result.checkAgain')).toBeInTheDocument();
      expect(api.verify.mock.calls.length + api.payment.mock.calls.length).toBe(20);

      // Confirmed later: "check again" shows it.
      api.verify.mockResolvedValue({ status: 'succeeded', ledgerId: 'l3', purpose: 'plan', purposeResult: { action: 'purchase' } });
      api.payment.mockResolvedValue({ id: 'pay9', status: 'succeeded', purpose: 'plan', currency: 'USD', amount_minor: 2900, net_minor: 2900, tax_minor: 0, ledger_id: 'l3', failure_reason: null });
      fireEvent.click(screen.getByText('billing.account.result.checkAgain'));
      await waitFor(() => expect(screen.getByTestId('payment-result')).toHaveTextContent('billing.account.result.purposeDone.plan'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a payment short of the plan\'s price: in the balance, the plan unchanged', async () => {
    api.view.mockResolvedValue({ ...DOLLAR_OPEN, balance_minor: 2000, currency_choice: { options: ['IRR', 'USD'], switchable: false } });
    api.verify.mockResolvedValue({ status: 'succeeded', ledgerId: 'l4', purpose: 'plan', purposeResult: { error: 'billing_insufficient_balance' } });
    api.payment.mockResolvedValue({ id: 'pay10', status: 'succeeded', purpose: 'plan', currency: 'USD', amount_minor: 2900, net_minor: 2000, tax_minor: 0, ledger_id: 'l4', failure_reason: null, purpose_result: { error: 'billing_insufficient_balance' } });
    renderAt('/acme/billing?payment=pay10&provider=apirone');
    await waitFor(() => expect(screen.getByTestId('payment-result')).toHaveTextContent('billing.account.result.purposeShort'));
    expect(screen.getByTestId('payment-result')).not.toHaveTextContent('billing.account.result.purposeFailed');
  });

  it('a bank gateway keeps its own wording and pace', async () => {
    api.view.mockResolvedValue({ ...TOMAN_OPEN, currency_choice: null });
    const pending = deferred<{ status: string }>();
    api.verify.mockReturnValue(pending.promise);
    i18n.locale = 'fa';
    renderAt('/acme/billing?payment=pay11&provider=zibal&trackId=7&success=1');
    expect(await screen.findByTestId('payment-checking')).toHaveTextContent('billing.account.result.checking');
    pending.resolve({ status: 'failed' });
    await waitFor(() => expect(screen.getByTestId('payment-result')).toHaveTextContent('billing.account.result.failed'));
  });
});
