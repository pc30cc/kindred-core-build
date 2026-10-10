/**
 * The payment page with the Paddle sandbox gateway: the customer sees that it
 * is a test (the gateway's "(test)" name, the test-gateway mark, and the test
 * card note — shown for this gateway only), and its checkout opens with
 * Paddle.js like live Paddle.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, string>) => (vars?.card ? `${k} ${vars.card}` : k),
    locale: 'en',
    dir: 'ltr',
  }),
}));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' }, isLoading: false }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const openPaddleCheckout = vi.fn(async () => undefined);
vi.mock('@/lib/paddleCheckout', () => ({ openPaddleCheckout: (...a: unknown[]) => openPaddleCheckout(...(a as [])) }));
vi.mock('@/lib/api', () => ({ billingVerifyCallback: vi.fn(), billingGetPaymentIntent: vi.fn() }));

const gateways = vi.fn();
const invoiceCheckout = vi.fn();
vi.mock('@/lib/billingApi', () => ({
  billingInvoiceDetail: async () => ({
    invoice: {
      id: 'inv-1', invoiceNumber: 'AB12345678', status: 'open', currency: 'USD',
      issuedAt: '2026-10-08T10:00:00Z', createdAt: '2026-10-08T10:00:00Z', dueAt: null, workspaceName: 'Acme',
    },
    lines: [{ id: 'l1', description: 'Pro (monthly)', quantity: 1, amountIrr: 2900 }],
    totals: { subtotalIrr: 2900, discountIrr: 0, taxIrr: 0, paidIrr: 0, dueIrr: 2900 },
    actions: { payable: true, blockedReason: null },
  }),
  billingGateways: (...a: unknown[]) => gateways(...a),
  billingPayInvoiceFromWallet: vi.fn(),
  billingInvoiceCheckout: (...a: unknown[]) => invoiceCheckout(...a),
  billingDepositDetail: vi.fn(),
  billingDepositCheckout: vi.fn(),
}));

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const PaymentPage = (await import('@/pages/app/billing/PaymentPage')).default;
const { EDITION_CACHE_KEY } = await import('@/lib/edition');
const PAGE = '/acme/billing/pay/invoice/inv-1';

function renderPage() {
  window.history.replaceState({}, '', PAGE);
  return render(
    <MemoryRouter initialEntries={[PAGE]}>
      <Routes>
        <Route path="/:slug/billing/pay/:kind/:id" element={<PaymentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const SANDBOX = { provider_name: 'paddle_sandbox', display_name: { en: 'Paddle — Sandbox (test)' }, is_test: true, currencies: [] };
const STRIPE = { provider_name: 'stripe', display_name: { en: 'Card' }, is_test: false, currencies: [] };

beforeEach(() => {
  gateways.mockReset();
  invoiceCheckout.mockReset();
  openPaddleCheckout.mockClear();
  window.sessionStorage.clear();
  // RESPOK: the International edition, where the sandbox gateway exists.
  window.localStorage.setItem(EDITION_CACHE_KEY, 'international');
});

describe('PaymentPage — Paddle sandbox', () => {
  it('shows the gateway as a test, with the test card note while it is selected', async () => {
    gateways.mockResolvedValue({ currency: 'USD', gateways: [SANDBOX, STRIPE] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Paddle — Sandbox (test)')).toBeInTheDocument());
    expect(screen.getByText('billing.checkout.testGateway')).toBeInTheDocument();
    expect(screen.getByTestId('paddle-sandbox-note')).toHaveTextContent('billing.checkout.paddleSandboxNote 4242 4242 4242 4242');
    fireEvent.click(screen.getByText('Card'));
    expect(screen.queryByTestId('paddle-sandbox-note')).not.toBeInTheDocument();
  });

  it('never shows the note for another gateway', async () => {
    gateways.mockResolvedValue({ currency: 'USD', gateways: [STRIPE] });
    renderPage();
    await waitFor(() => expect(screen.getByText('Card')).toBeInTheDocument());
    expect(screen.queryByTestId('paddle-sandbox-note')).not.toBeInTheDocument();
    expect(screen.queryByText('billing.checkout.testGateway')).not.toBeInTheDocument();
  });

  it('opens the sandbox checkout with Paddle.js on the page', async () => {
    gateways.mockResolvedValue({ currency: 'USD', gateways: [SANDBOX] });
    const clientCheckout = {
      provider: 'paddle_sandbox', environment: 'sandbox', transactionId: 'txn_sbx',
      clientToken: 'test_token', successUrl: 'https://app.test/acme/billing/pay/invoice/inv-1?_ptxn=txn_sbx',
    };
    invoiceCheckout.mockResolvedValue({ success: true, paymentUrl: 'https://app.test/x', clientCheckout, intentId: 'pi-1', invoiceNumber: 'AB1' });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('paddle-sandbox-note')).toBeInTheDocument());
    fireEvent.click(screen.getByText(/billing\.checkout\.payNow/));
    await waitFor(() => expect(openPaddleCheckout).toHaveBeenCalledTimes(1));
    expect(invoiceCheckout).toHaveBeenCalledWith('ws-1', 'inv-1', expect.any(String), 'paddle_sandbox');
    expect((openPaddleCheckout.mock.calls[0] as unknown[])[0]).toEqual(clientCheckout);
  });
});
