/**
 * Workspace → Billing (simple billing): the balance, the plan, the history
 * with receipts, the top-up dialog's VAT line (only when VAT is set), and the
 * return from a gateway — confirmed with the server, shown, address cleaned.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, string>) => (vars ? `${k} ${JSON.stringify(vars)}` : k),
    locale: 'en',
    dir: 'ltr',
  }),
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
  gateways: [{ provider_name: 'paddle', display_name: { en: 'Card (Paddle)' }, is_test: false }],
};

const LEDGER = {
  items: [{
    id: 'l1', kind: 'topup', amount_minor: 2500, balance_after: 2500, currency: 'USD', plan_id: null, billing_interval: null,
    period_start: null, period_end: null, payment_id: 'p1', receipt_number: 'RS2026-000001', net_minor: 2500, tax_minor: 0,
    tax_percent: null, buyer: null, seller: null, description: {}, created_at: '2026-10-10T08:00:00Z',
  }],
  total: 1, page: 1, pageSize: 20,
};

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/:slug/billing" element={<><AccountBillingPage workspaceId="ws-1" slug="acme" /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  for (const fn of Object.values(api)) fn.mockReset();
  openPaddle.mockReset();
  api.view.mockResolvedValue(VIEW);
  api.ledger.mockResolvedValue(LEDGER);
});

describe('AccountBillingPage', () => {
  it('shows the balance, the plan and the history with its receipt', async () => {
    renderAt('/acme/billing');
    await waitFor(() => expect(screen.getByTestId('account-balance')).toHaveTextContent('$25.00'));
    expect(screen.getByText('Pro')).toBeInTheDocument();
    expect(screen.getByText('billing.account.plan.interval.monthly')).toBeInTheDocument();
    expect(screen.getByText('billing.account.history.kinds.topup')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /RS2026-000001/ });
    expect(link).toHaveAttribute('href', '/acme/billing/receipts/l1');
  });

  it('has no VAT line when the edition has none, and opens Paddle with the server checkout', async () => {
    api.topup.mockResolvedValue({
      success: true, paymentId: 'pay1', provider: 'paddle', currency: 'USD', net_minor: 5000, tax_minor: 0, amount_minor: 5000,
      clientCheckout: { provider: 'paddle', transactionId: 'txn_1', clientToken: 'tok', successUrl: 'x' },
    });
    renderAt('/acme/billing');
    fireEvent.click(await screen.findByText('billing.account.balance.topup'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('billing.account.topup.amount'), { target: { value: '50' } });
    expect(within(dialog).queryByText(/billing\.account\.topup\.vat/)).not.toBeInTheDocument();
    expect(within(dialog).getAllByText('$50.00').length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByText('billing.account.topup.pay'));
    await waitFor(() => expect(api.topup).toHaveBeenCalledWith('ws-1', expect.objectContaining({ amountMinor: 5000, currency: 'USD', providerName: 'paddle' })));
    await waitFor(() => expect(openPaddle).toHaveBeenCalled());
    // The dialog is closed before Paddle's own overlay opens.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the VAT line and the total when the edition has VAT', async () => {
    api.view.mockResolvedValue({ ...VIEW, vat_percent: 10 });
    renderAt('/acme/billing');
    fireEvent.click(await screen.findByText('billing.account.balance.topup'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('billing.account.topup.amount'), { target: { value: '100' } });
    const vatLabel = within(dialog).getByText(/billing\.account\.topup\.vat/);
    expect(vatLabel.nextElementSibling).toHaveTextContent('$10.00');
    const totalLabel = within(dialog).getByText('billing.account.topup.total');
    expect(totalLabel.nextElementSibling).toHaveTextContent('$110.00');
  });

  it('refuses an amount below the minimum before calling the server', async () => {
    renderAt('/acme/billing');
    fireEvent.click(await screen.findByText('billing.account.balance.topup'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('billing.account.topup.amount'), { target: { value: '1' } });
    expect(within(dialog).getByText('billing.account.errors.TOPUP_AMOUNT_TOO_SMALL')).toBeInTheDocument();
    expect(within(dialog).getByText('billing.account.topup.pay').closest('button')).toBeDisabled();
  });

  it('confirms a return from the gateway, shows it, and cleans the address bar', async () => {
    api.verify.mockResolvedValue({ status: 'succeeded', ledgerId: 'l1', receiptNumber: 'RS2026-000001', balanceMinor: 2500 });
    api.payment.mockResolvedValue({ id: 'pay1', status: 'succeeded', net_minor: 2500, ledger_id: 'l1' });
    renderAt('/acme/billing?payment=pay1&provider=paddle&_ptxn=txn_1');
    await waitFor(() => expect(api.verify).toHaveBeenCalledWith('ws-1', 'pay1', 'paddle', { _ptxn: 'txn_1' }));
    await waitFor(() => expect(screen.getByTestId('payment-result')).toHaveTextContent('billing.account.result.succeeded'));
    expect(screen.getByTestId('payment-result')).toHaveTextContent('$25.00');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/acme\/billing$/);
    expect(api.verify).toHaveBeenCalledTimes(1);
  });

  it('a return still pending can be checked again, and a reload resumes the check', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.verify.mockResolvedValue({ status: 'pending' });
      api.payment.mockResolvedValue({ id: 'pay3', status: 'pending', net_minor: 5000, ledger_id: null });
      const first = renderAt('/acme/billing?payment=pay3&provider=zarinpal&Authority=A3&Status=OK');
      await waitFor(() => expect(api.verify).toHaveBeenCalledWith('ws-1', 'pay3', 'zarinpal', { Authority: 'A3', Status: 'OK' }));
      for (let i = 0; i < 25; i += 1) await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(screen.getByTestId('payment-result')).toHaveTextContent('billing.account.result.pending'));
      // The gateway's parameters survived the cleaned address bar.
      expect(JSON.parse(window.sessionStorage.getItem('billing:account-return:ws-1')!)).toMatchObject({ paymentId: 'pay3', params: { Authority: 'A3' } });

      api.verify.mockReset();
      api.verify.mockResolvedValue({ status: 'succeeded', ledgerId: 'l9' });
      api.payment.mockResolvedValue({ id: 'pay3', status: 'succeeded', net_minor: 5000, ledger_id: 'l9' });
      fireEvent.click(screen.getByText('billing.account.result.checkAgain'));
      await waitFor(() => expect(screen.getByTestId('payment-result')).toHaveTextContent('billing.account.result.succeeded'));
      expect(api.verify).toHaveBeenCalledWith('ws-1', 'pay3', 'zarinpal', { Authority: 'A3', Status: 'OK' });
      expect(window.sessionStorage.getItem('billing:account-return:ws-1')).toBeNull();
      first.unmount();

      // A reload with a check still stored resumes it.
      window.sessionStorage.setItem('billing:account-return:ws-1', JSON.stringify({ paymentId: 'pay4', provider: 'zarinpal', params: { Authority: 'A4' } }));
      api.verify.mockResolvedValue({ status: 'succeeded', ledgerId: 'l10' });
      renderAt('/acme/billing');
      await waitFor(() => expect(api.verify).toHaveBeenCalledWith('ws-1', 'pay4', 'zarinpal', { Authority: 'A4' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed return says nothing was charged', async () => {
    api.verify.mockResolvedValue({ status: 'failed', reason: 'gateway_canceled' });
    renderAt('/acme/billing?payment=pay2&provider=zarinpal&Authority=A1&Status=NOK');
    await waitFor(() => expect(screen.getByTestId('payment-result')).toHaveTextContent('billing.account.result.failed'));
  });

  it('a member who cannot manage billing sees no top-up button', async () => {
    api.view.mockResolvedValue({ ...VIEW, can_manage: false, gateways: [] });
    renderAt('/acme/billing');
    await screen.findByTestId('account-balance');
    expect(screen.queryByText('billing.account.balance.topup')).not.toBeInTheDocument();
  });
});
