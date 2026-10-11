/**
 * Pay online (simple billing). Where a card can be saved (Multi Region, a
 * Paddle gateway with automatic renewal on) a plan or a renewal offers
 * "renew automatically with this card", ticked by default: the card pays
 * the full price, only the gateways that can save it are listed, and the
 * dialog says what is charged every period after. Unticked, or anywhere
 * else, it is the dialog it was; the Iranian edition renders exactly as
 * before phase 3b.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const i18n = vi.hoisted(() => ({
  t: (k: string, vars?: Record<string, string>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
}));
const edition = vi.hoisted(() => ({ current: 'iran' }));
vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: i18n.t, locale: 'en', dir: 'ltr' }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/paddleCheckout', () => ({ openPaddleCheckout: vi.fn() }));
vi.mock('@/lib/edition', async (orig) => ({ ...(await orig<object>()), currentEdition: () => edition.current }));
const api = { checkout: vi.fn() };
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

const PayOnlineDialog = (await import('@/pages/app/billing/account/PayOnlineDialog')).default;
type Request = NonNullable<Parameters<typeof PayOnlineDialog>[0]['request']>;

const GATEWAYS = [
  { provider_name: 'stripe', display_name: { en: 'Stripe' }, is_test: false },
  { provider_name: 'paddle', display_name: { en: 'Card (Paddle)' }, is_test: false },
  { provider_name: 'paddle_sandbox', display_name: { en: 'Paddle sandbox' }, is_test: true },
];

/** A plan bought online in Multi Region: $29 a month, $10 already in the balance. */
const PLAN: Request = {
  purpose: 'plan', planId: 'pro', interval: 'monthly', priceMinor: 2900, balanceMinor: 1000, expectedNetMinor: 2900,
  fullPriceMinor: 2900, title: 'Buy Pro',
};

function open(request: Request, props: { cardAvailable?: boolean; cardProviders?: string[]; vatPercent?: number | null; onStale?: () => void } = {}) {
  return render(
    <PayOnlineDialog
      request={request}
      onOpenChange={() => undefined}
      onCurrencyChanged={props.onStale}
      workspaceId="ws-1"
      slug="acme"
      currency="USD"
      vatPercent={props.vatPercent ?? null}
      gateways={GATEWAYS}
      cardAvailable={props.cardAvailable ?? true}
      cardProviders={props.cardProviders ?? ['paddle', 'paddle_sandbox']}
    />,
  );
}

const listed = () => within(screen.getByRole('radiogroup')).getAllByRole('radio').map((r) => r.id.replace(/^gw-/, ''));

beforeEach(() => {
  edition.current = 'international';
  api.checkout.mockReset();
  api.checkout.mockResolvedValue({
    success: true, paymentId: 'pay-1', provider: 'paddle', currency: 'USD', net_minor: 2900, tax_minor: 0, amount_minor: 2900,
    clientCheckout: { provider: 'paddle', transactionId: 'txn_1' },
  });
});

describe('PayOnlineDialog with automatic card renewal', () => {
  it('is ticked by default for a plan: the full price, the card gateways only, and what follows every month', async () => {
    open(PLAN);
    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('data-state', 'checked');
    expect(listed()).toEqual(['paddle', 'paddle_sandbox']);
    // The card pays the full price; the balance is neither used nor shown.
    expect(screen.getByTestId('pay-online-total')).toHaveTextContent('$29.00');
    expect(screen.queryByText('billing.account.payOnline.fromBalance')).toBeNull();
    expect(screen.queryByText('billing.account.payOnline.minimum')).toBeNull();
    expect(screen.getByText('billing.account.payOnline.descriptionCard')).toBeInTheDocument();
    expect(screen.getByTestId('pay-online-card-note')).toHaveTextContent('billing.account.payOnline.autoRenewMonthly {"amount":"$29.00"}');

    fireEvent.click(screen.getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledTimes(1));
    expect(api.checkout).toHaveBeenCalledWith('ws-1', {
      purpose: 'plan', planId: 'pro', interval: 'monthly', currency: 'USD', providerName: 'paddle',
      callbackUrl: `${window.location.origin}/acme/billing?card=setup`, expectedNetMinor: 2900, autoRenew: true,
    });
  });

  it('unticked, it is the plain payment again: every gateway, what the balance is missing, no autoRenew', async () => {
    open(PLAN);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked');
    expect(listed()).toEqual(['stripe', 'paddle', 'paddle_sandbox']);
    expect(screen.getByText('billing.account.payOnline.description')).toBeInTheDocument();
    expect(screen.getByTestId('pay-online-card-note')).toHaveTextContent('billing.account.payOnline.autoRenewOff');
    // $19 missing is above the $5 minimum.
    expect(screen.getByTestId('pay-online-total')).toHaveTextContent('$19.00');
    expect(screen.getByText('billing.account.payOnline.fromBalance')).toBeInTheDocument();
    fireEvent.click(screen.getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledTimes(1));
    const body = api.checkout.mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('autoRenew');
    expect(body).toMatchObject({ providerName: 'stripe', expectedNetMinor: 2900, callbackUrl: `${window.location.origin}/acme/billing` });
  });

  it('a renewal renews on its own interval, with VAT in the amount charged every year', () => {
    open(
      { purpose: 'renewal', priceMinor: 29000, balanceMinor: 0, expectedNetMinor: 29000, fullPriceMinor: 29000, cardInterval: 'yearly', title: 'Renew' },
      { vatPercent: 10 },
    );
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
    expect(screen.getByTestId('pay-online-total')).toHaveTextContent('$319.00');
    expect(screen.getByTestId('pay-online-card-note')).toHaveTextContent('billing.account.payOnline.autoRenewYearly {"amount":"$319.00"}');
  });

  it('the card setup itself ("Turn on automatic card payments") cannot be unticked into a one-time payment', async () => {
    open({ purpose: 'renewal', priceMinor: 2900, balanceMinor: 0, expectedNetMinor: 2900, fullPriceMinor: 2900, autoRenew: true, title: 'Renew Pro automatically' });
    const box = screen.getByRole('checkbox');
    expect(box).toHaveAttribute('data-state', 'checked');
    expect(box).toBeDisabled();
    fireEvent.click(box);
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'checked');
    fireEvent.click(screen.getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.checkout).toHaveBeenCalledTimes(1));
    expect(api.checkout.mock.calls[0][1]).toMatchObject({ autoRenew: true });
  });

  it.each(['CARD_ALREADY_SAVED', 'CARD_PAYS_RENEWAL', 'CARD_SETUP_IN_PROGRESS', 'CURRENCY_CHANGED'])(
    'a refusal because the page is stale (%s) reloads it',
    async (code) => {
      const { AccountApiError } = await import('@/lib/accountBillingApi');
      api.checkout.mockRejectedValue(new AccountApiError(code, 409, null));
      const onStale = vi.fn();
      open(PLAN, { onStale });
      fireEvent.click(screen.getByText('billing.account.topup.pay'));
      await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('alert')).toBeInTheDocument();
    },
  );

  it('opens unticked when asked to', () => {
    open({ ...PLAN, autoRenew: false });
    expect(screen.getByRole('checkbox')).toHaveAttribute('data-state', 'unchecked');
    expect(listed()).toEqual(['stripe', 'paddle', 'paddle_sandbox']);
  });

  it('is not offered for an upgrade, without a full price, below Paddle\'s minimum, or with no gateway that can save a card', () => {
    const cases: Array<[Request, Parameters<typeof open>[1]]> = [
      [{ ...PLAN, purpose: 'upgrade', fullPriceMinor: null }, {}],
      [{ ...PLAN, fullPriceMinor: undefined }, {}],
      [{ ...PLAN, priceMinor: 50, expectedNetMinor: 50, fullPriceMinor: 50 }, {}],
      [PLAN, { cardProviders: [] }],
      [PLAN, { cardAvailable: false }],
    ];
    for (const [request, props] of cases) {
      const view = open(request, props);
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByTestId('pay-online-card')).toBeNull();
      expect(listed()).toEqual(['stripe', 'paddle', 'paddle_sandbox']);
      view.unmount();
    }
  });
});

/** The dialog's markup with Radix's generated ids made stable. */
function markup(): string {
  const html = screen.getByRole('dialog').outerHTML;
  const ids = new Map<string, string>();
  return html.replace(/radix-[:«»\w-]+/g, (id) => {
    if (!ids.has(id)) ids.set(id, `radix-${ids.size}`);
    return ids.get(id) as string;
  });
}

describe('PayOnlineDialog in the Iranian edition', () => {
  it('renders exactly as before automatic card renewal existed', async () => {
    edition.current = 'iran';
    render(
      <PayOnlineDialog
        request={{ purpose: 'renewal', priceMinor: 5_000_000, balanceMinor: 1_000_000, expectedNetMinor: 5_000_000, title: 'Renew Pro' }}
        onOpenChange={() => undefined}
        workspaceId="ws-ir"
        slug="acme"
        currency="IRR"
        vatPercent={10}
        gateways={[
          { provider_name: 'zarinpal', display_name: { fa: 'زرین‌پال', en: 'Zarinpal' }, is_test: false },
          { provider_name: 'zibal', display_name: { en: 'Zibal' }, is_test: true },
        ]}
      />,
    );
    await expect(markup()).toMatchFileSnapshot('./__snapshots__/payOnlineDialog.iran.html');
  });
});
