/**
 * The AI credit card of the billing page (simple billing phase 5): hidden
 * while AI billing is METER_ONLY; the AI balance and its plan / purchased
 * parts in the account currency (Toman in Iran); a pack is confirmed with
 * the balance after, or paid online when the balance is short; a refusal
 * because the pack changed redraws the card from the section the server
 * sent. On the page: the card is mounted, a returning ai_pack payment says
 * what happened, and the history names the pack bought.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const i18n = vi.hoisted(() => ({
  locale: 'en',
  t: (k: string, vars?: Record<string, string | number>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
}));
const edition = vi.hoisted(() => ({ current: 'international' }));
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: i18n.t, locale: i18n.locale, dir: 'ltr' }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('@/lib/paddleCheckout', () => ({ openPaddleCheckout: vi.fn() }));
vi.mock('@/lib/edition', async (orig) => ({ ...(await orig<object>()), currentEdition: () => edition.current }));
const api = vi.hoisted(() => ({
  ai: vi.fn(),
  buyAiPack: vi.fn(),
  view: vi.fn(),
  ledger: vi.fn(),
  verify: vi.fn(),
  payment: vi.fn(),
  checkout: vi.fn(),
}));
vi.mock('@/lib/accountBillingApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/accountBillingApi')>()),
  accountBillingApi: api,
}));
vi.mock('@/hooks/useEntitlements', () => ({ refreshEffectiveEntitlements: vi.fn(() => Promise.resolve()) }));

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const { AccountApiError } = await import('@/lib/accountBillingApi');
type AiSection = import('@/lib/accountBillingApi').AiSection;
const AiCreditCard = (await import('@/pages/app/billing/account/AiCreditCard')).default;
const AccountBillingPage = (await import('@/pages/app/billing/account/AccountBillingPage')).default;

/** RESPOK: $3.21 of AI credit ($1.20 plan credit until Nov 1, $2.01 purchased), two packs. */
const SECTION: AiSection = {
  mode: 'ENFORCED',
  currency: 'USD',
  rate_available: true,
  wallet: { available: 1_926_000, reserved: 0, plan_remaining: 720_000, purchased_remaining: 1_206_000 },
  display: { available_minor: 321, plan_remaining_minor: 120, purchased_remaining_minor: 201 },
  plan_expires_at: '2026-11-01T00:00:00Z',
  packs: [
    { id: 's', price_minor: 500, credit_minor: 500, active: true },
    { id: 'm', price_minor: 2000, credit_minor: 2400, active: true, label: { en: 'Medium', fa: 'متوسط' } },
  ],
  sellable: true,
  reason: null,
};

const BOUGHT = {
  action: 'ai_pack', replayed: false, pack_ledger_id: 'led-1', lot_id: 'lot-1', pack_id: 'm',
  price_minor: 2000, credit_minor: 2400, currency: 'USD', wallet_amount: 14_400_000, balance_minor: 500,
};

function card(props: { balance?: number; canManage?: boolean; currency?: string } = {}) {
  const onChanged = vi.fn();
  const onPayOnline = vi.fn();
  const utils = render(
    <AiCreditCard
      workspaceId="ws-1"
      view={{ balance_minor: props.balance ?? 2500, can_manage: props.canManage ?? true, currency: props.currency ?? 'USD' }}
      onChanged={onChanged}
      onPayOnline={onPayOnline}
    />,
  );
  return { ...utils, onChanged, onPayOnline };
}

beforeEach(() => {
  edition.current = 'international';
  for (const fn of Object.values(api)) fn.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  window.sessionStorage.clear();
  api.ai.mockResolvedValue(SECTION);
});

describe('AiCreditCard', () => {
  it('is not shown while AI billing only meters (METER_ONLY)', async () => {
    api.ai.mockResolvedValue({ ...SECTION, mode: 'METER_ONLY', packs: [], sellable: false, reason: 'mode' });
    const { container } = card();
    await waitFor(() => expect(api.ai).toHaveBeenCalledWith('ws-1'));
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('is not shown when the section cannot be read (the rest of the page works without it)', async () => {
    api.ai.mockRejectedValue(new AccountApiError('HTTP_500', 500, null));
    const { container } = card();
    await waitFor(() => expect(api.ai).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the AI balance in the account currency, the plan part until its end and the purchased part', async () => {
    card();
    expect(await screen.findByTestId('ai-available')).toHaveTextContent('$3.21');
    expect(screen.getByTestId('ai-plan-part')).toHaveTextContent('billing.account.ai.planPart');
    expect(screen.getByTestId('ai-plan-part')).toHaveTextContent('"amount":"$1.20"');
    expect(screen.getByTestId('ai-plan-part')).toHaveTextContent(/"date":"November 1, 2026"/);
    expect(screen.getByTestId('ai-purchased-part')).toHaveTextContent('billing.account.ai.purchasedPart {"amount":"$2.01"}');
  });

  it('a plan part without an end date reads without one; no plan credit, no plan line', async () => {
    api.ai.mockResolvedValue({ ...SECTION, plan_expires_at: null });
    const first = card();
    expect(await screen.findByTestId('ai-plan-part')).toHaveTextContent('billing.account.ai.planPartNoDate {"amount":"$1.20"}');
    first.unmount();
    api.ai.mockResolvedValue({ ...SECTION, display: { ...SECTION.display!, plan_remaining_minor: 0 } });
    card();
    await screen.findByTestId('ai-purchased-part');
    expect(screen.queryByTestId('ai-plan-part')).toBeNull();
  });

  it('without an exchange rate shows no amount and offers nothing', async () => {
    api.ai.mockResolvedValue({ ...SECTION, rate_available: false, display: null, packs: [], sellable: false, reason: 'no_rate' });
    card();
    expect(await screen.findByTestId('ai-unavailable')).toHaveTextContent('billing.account.ai.unavailable');
    expect(screen.queryByTestId('ai-available')).toBeNull();
    expect(screen.queryByTestId('ai-pack-s')).toBeNull();
  });

  it('lists the packs with their name or credit, price and bonus', async () => {
    card();
    const small = await screen.findByTestId('ai-pack-s');
    expect(small).toHaveTextContent('billing.account.ai.packCredit {"credit":"$5.00"}');
    expect(small).toHaveTextContent('$5.00');
    // No bonus when the credit is the price.
    expect(screen.queryByTestId('ai-pack-bonus-s')).toBeNull();
    const medium = screen.getByTestId('ai-pack-m');
    expect(medium).toHaveTextContent('Medium');
    expect(medium).toHaveTextContent('billing.account.ai.packCredit {"credit":"$24.00"}');
    expect(medium).toHaveTextContent('$20.00');
    expect(screen.getByTestId('ai-pack-bonus-m')).toHaveTextContent('billing.account.ai.bonus {"percent":"20"}');
  });

  it('in Persian the bonus reads in Persian digits, as the amounts beside it', async () => {
    i18n.locale = 'fa';
    try {
      card();
      expect(await screen.findByTestId('ai-pack-bonus-m')).toHaveTextContent('billing.account.ai.bonus {"percent":"۲۰"}');
    } finally {
      i18n.locale = 'en';
    }
  });

  it('members who cannot manage billing see the balance but no packs', async () => {
    card({ canManage: false });
    await screen.findByTestId('ai-available');
    expect(screen.queryByTestId('ai-pack-s')).toBeNull();
    expect(screen.queryByText('billing.account.ai.packsTitle')).toBeNull();
  });

  it('a pack is confirmed with the balance after, then bought once with one key and the price shown', async () => {
    api.buyAiPack.mockResolvedValue(BOUGHT);
    api.ai.mockResolvedValueOnce(SECTION).mockResolvedValueOnce({ ...SECTION, display: { ...SECTION.display!, available_minor: 2721 } });
    const { onChanged } = card({ balance: 2500 });
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('billing.account.ai.confirmBody {"price":"$20.00","credit":"$24.00"}')).toBeInTheDocument();
    expect(within(dialog).getByTestId('ai-pack-balance-after')).toHaveTextContent('billing.account.ai.balanceAfter {"amount":"$5.00"}');
    expect(within(dialog).queryByTestId('ai-pack-pay-online')).toBeNull();
    fireEvent.click(within(dialog).getByTestId('ai-pack-buy'));
    await waitFor(() => expect(api.buyAiPack).toHaveBeenCalledTimes(1));
    const [ws, input] = api.buyAiPack.mock.calls[0] as [string, { packId: string; expectedPriceMinor: number; key: string }];
    expect(ws).toBe('ws-1');
    expect(input).toMatchObject({ packId: 'm', expectedPriceMinor: 2000 });
    expect(input.key.length).toBeGreaterThanOrEqual(8);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('billing.account.ai.bought {"credit":"$24.00"}'));
    expect(onChanged).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The card reads its section again.
    await waitFor(() => expect(screen.getByTestId('ai-available')).toHaveTextContent('$27.21'));
  });

  it('a retry after a failed request reuses the key (the server buys once)', async () => {
    api.buyAiPack.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(BOUGHT);
    card();
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('ai-pack-buy'));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('billing.account.errors.generic');
    fireEvent.click(within(dialog).getByTestId('ai-pack-buy'));
    await waitFor(() => expect(api.buyAiPack).toHaveBeenCalledTimes(2));
    const keys = api.buyAiPack.mock.calls.map((c) => (c[1] as { key: string }).key);
    expect(keys[0]).toBe(keys[1]);
  });

  it('opening the pack again is another purchase (a new key)', async () => {
    api.buyAiPack.mockRejectedValue(new TypeError('Failed to fetch'));
    card();
    fireEvent.click(await screen.findByTestId('ai-pack-s'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('ai-pack-buy'));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByText('billing.common.cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByTestId('ai-pack-s'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('ai-pack-buy'));
    await waitFor(() => expect(api.buyAiPack).toHaveBeenCalledTimes(2));
    const keys = api.buyAiPack.mock.calls.map((c) => (c[1] as { key: string }).key);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('a short balance pays the difference online, through the page, with the pack and its price', async () => {
    const { onPayOnline } = card({ balance: 500 });
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('ai-pack-buy')).toBeNull();
    expect(within(dialog).queryByTestId('ai-pack-balance-after')).toBeNull();
    const pay = within(dialog).getByTestId('ai-pack-pay-online');
    // No amount on the button: the next dialog shows what the gateway charges (the top-up minimum, VAT).
    expect(pay).toHaveTextContent(/^billing\.account\.ai\.payOnline$/);
    fireEvent.click(pay);
    expect(onPayOnline).toHaveBeenCalledWith({
      purpose: 'ai_pack',
      packId: 'm',
      priceMinor: 2000,
      balanceMinor: 500,
      expectedPriceMinor: 2000,
      title: 'billing.account.ai.payOnlineTitle {"pack":"Medium"}',
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.buyAiPack).not.toHaveBeenCalled();
  });

  it('INSUFFICIENT_BALANCE (the balance went down meanwhile) switches the dialog to paying online', async () => {
    api.buyAiPack.mockRejectedValue(new AccountApiError('INSUFFICIENT_BALANCE', 409, null));
    const { onChanged } = card({ balance: 2500 });
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByTestId('ai-pack-buy'));
    expect(await within(dialog).findByTestId('ai-pack-pay-online')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('QUOTE_CHANGED closes the dialog, says so, and redraws the card from the section the server sent', async () => {
    const fresh: AiSection = { ...SECTION, packs: [{ id: 'm', price_minor: 2500, credit_minor: 3000, active: true, label: { en: 'Medium' } }] };
    api.buyAiPack.mockRejectedValue(new AccountApiError('QUOTE_CHANGED', 409, { section: fresh }));
    card();
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('ai-pack-buy'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByTestId('ai-pack-s')).toBeNull();
    expect(screen.getByTestId('ai-pack-m')).toHaveTextContent('$25.00');
    // Redrawn from the refusal: no second read.
    expect(api.ai).toHaveBeenCalledTimes(1);
  });

  it('AI_PACK_NOT_AVAILABLE without a section reads the card again', async () => {
    api.buyAiPack.mockRejectedValue(new AccountApiError('AI_PACK_NOT_AVAILABLE', 409, { pack: null }));
    api.ai.mockResolvedValueOnce(SECTION).mockResolvedValueOnce({ ...SECTION, packs: [SECTION.packs[0]] });
    card();
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('ai-pack-buy'));
    await waitFor(() => expect(api.ai).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('ai-pack-m')).toBeNull());
    expect(screen.getByTestId('ai-pack-s')).toBeInTheDocument();
  });

  it('in Iran amounts read in Toman', async () => {
    edition.current = 'iran';
    api.ai.mockResolvedValue({
      ...SECTION,
      currency: 'IRR',
      display: { available_minor: 25_000_000, plan_remaining_minor: 5_000_000, purchased_remaining_minor: 20_000_000 },
      packs: [{ id: 's', price_minor: 2_000_000, credit_minor: 2_200_000, active: true, label: { fa: 'بسته‌ی کوچک' } }],
    });
    card({ balance: 10_000_000, currency: 'IRR' });
    const available = await screen.findByTestId('ai-available');
    const { money } = await import('@/pages/app/billing/shared');
    expect(money(25_000_000, 'en', 'IRR')).toMatch(/2,500,000/);
    expect(available).toHaveTextContent(money(25_000_000, 'en', 'IRR'));
    expect(screen.getByTestId('ai-pack-s')).toHaveTextContent(money(2_000_000, 'en', 'IRR'));
    fireEvent.click(screen.getByTestId('ai-pack-s'));
    expect(within(await screen.findByRole('dialog')).getByTestId('ai-pack-balance-after'))
      .toHaveTextContent(money(8_000_000, 'en', 'IRR'));
  });
});

// ─── On the billing page ──────────────────────────────────────────────────

const VIEW = {
  edition: 'international',
  currency: 'USD',
  balance_minor: 2500,
  auto_renew: false,
  billing_profile: {},
  vat_percent: null as number | null,
  plan: {
    plan_id: 'p1', slug: 'pro', name: 'Pro', localized: {}, is_free: false, status: 'active',
    billing_interval: 'monthly', current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2026-11-01T00:00:00Z', trial_end: null,
  },
  has_account: true,
  can_manage: true,
  gateways: [{ provider_name: 'stripe', display_name: { en: 'Stripe' }, is_test: false }],
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
};

const row = (over: Record<string, unknown>) => ({
  id: 'l1', kind: 'topup', amount_minor: 2500, balance_after: 2500, currency: 'USD', plan_id: null, billing_interval: null,
  period_start: null, period_end: null, payment_id: null, receipt_number: null, net_minor: null, tax_minor: null,
  tax_percent: null, buyer: null, seller: null, description: {}, created_at: '2026-10-10T08:00:00Z', ...over,
});

function renderPage(url = '/acme/billing') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/:slug/billing" element={<AccountBillingPage workspaceId="ws-1" slug="acme" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('the AI card on the billing page', () => {
  beforeEach(() => {
    api.view.mockResolvedValue(VIEW);
    api.ledger.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  it('is mounted, and a short balance opens the page\'s pay-online dialog for the pack', async () => {
    api.view.mockResolvedValue({ ...VIEW, balance_minor: 500 });
    api.checkout.mockResolvedValue({ success: true, paymentId: 'pay-1', provider: 'stripe', currency: 'USD', net_minor: 1500, tax_minor: 0, amount_minor: 1500, paymentUrl: `${window.location.href.split('#')[0]}#pay` });
    renderPage();
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('ai-pack-pay-online'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('billing.account.ai.payOnlineTitle {"pack":"Medium"}')).toBeInTheDocument();
    expect(within(dialog).getByTestId('pay-online-total')).toHaveTextContent('$15.00');
    fireEvent.click(within(dialog).getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      purpose: 'ai_pack', packId: 'm', expectedPriceMinor: 2000, currency: 'USD',
    })));
  });

  it('a pack refused at online checkout (its price changed) reads the AI card again, so the stale pack is not offered again', async () => {
    api.view.mockResolvedValue({ ...VIEW, balance_minor: 500 });
    api.checkout.mockRejectedValue(new AccountApiError('QUOTE_CHANGED', 409, null));
    renderPage();
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('ai-pack-pay-online'));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(api.ai).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialog).getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.ai).toHaveBeenCalledTimes(2));
  });

  it('a pack bought from the balance reloads the balance and the history', async () => {
    api.buyAiPack.mockResolvedValue(BOUGHT);
    renderPage();
    fireEvent.click(await screen.findByTestId('ai-pack-m'));
    fireEvent.click(within(await screen.findByRole('dialog')).getByTestId('ai-pack-buy'));
    await waitFor(() => expect(api.view).toHaveBeenCalledTimes(2));
    expect(api.ledger).toHaveBeenCalledTimes(2);
  });

  it('the history names the pack bought, and a returned pack has its own kind', async () => {
    api.ledger.mockResolvedValue({
      items: [
        row({ id: 'l3', kind: 'ai_pack_return', amount_minor: 1000, balance_after: 1500, description: { pack_ledger_id: 'l2' } }),
        row({
          id: 'l2', kind: 'ai_pack', amount_minor: -2000, balance_after: 500,
          description: { pack_id: 'm', credit_minor: 2400, credit_currency: 'USD', label: { en: 'Medium' }, wallet_amount: 14_400_000 },
        }),
        row({ id: 'l4', kind: 'ai_pack', amount_minor: -500, balance_after: 0, description: { pack_id: 's', credit_minor: 500, credit_currency: 'USD', label: null } }),
      ],
      total: 3, page: 1, pageSize: 20,
    });
    renderPage();
    expect(await screen.findByText('billing.account.history.kinds.ai_pack_return')).toBeInTheDocument();
    expect(screen.getAllByText('billing.account.history.kinds.ai_pack')).toHaveLength(2);
    const details = screen.getAllByTestId('ledger-detail').map((d) => d.textContent);
    expect(details).toEqual([
      'Medium · billing.account.ai.packCredit {"credit":"$24.00"}',
      'billing.account.ai.packCredit {"credit":"$5.00"}',
    ]);
  });

  it.each([
    ['the pack was added', { action: 'ai_pack', pack_ledger_id: 'l2' }, 'billing.account.ai.return.done'],
    ['the pack changed, the money stayed in the balance', { error: 'billing_quote_changed' }, 'billing.account.ai.return.kept'],
  ])('a returning ai_pack payment says so: %s', async (_name, purposeResult, text) => {
    api.verify.mockResolvedValue({ status: 'succeeded', ledgerId: 'l1', purpose: 'ai_pack', purposeResult });
    api.payment.mockResolvedValue({ id: 'pay-1', status: 'succeeded', purpose: 'ai_pack', currency: 'USD', amount_minor: 1500, net_minor: 1500, tax_minor: 0, ledger_id: 'l1', failure_reason: null });
    renderPage('/acme/billing?payment=pay-1&provider=stripe&session_id=cs_1');
    expect(await screen.findByTestId('payment-result')).toHaveTextContent(text);
    // The AI card reads its section again after the payment settled.
    await waitFor(() => expect(api.ai.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
