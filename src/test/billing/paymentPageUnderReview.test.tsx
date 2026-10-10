/**
 * The payment page after a card payment that arrived but could not be applied
 * (the server recorded it for review): it must say "received — under review"
 * on the return AND after a reload, never "payment failed" with a retry
 * button that would charge the customer a second time.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => k, locale: 'en', dir: 'ltr' }),
}));
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' }, isLoading: false }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/paddleCheckout', () => ({ openPaddleCheckout: vi.fn() }));

const verifyCallback = vi.fn();
const getPaymentIntent = vi.fn();
vi.mock('@/lib/api', () => ({
  billingVerifyCallback: (...a: unknown[]) => verifyCallback(...a),
  billingGetPaymentIntent: (...a: unknown[]) => getPaymentIntent(...a),
}));
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
  billingGateways: async () => ({ currency: 'USD', gateways: [{ provider_name: 'stripe', display_name: 'Card' }] }),
  billingPayInvoiceFromWallet: vi.fn(),
  billingInvoiceCheckout: vi.fn(),
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

function renderAt(url: string) {
  window.history.replaceState({}, '', url);
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/:slug/billing/pay/:kind/:id" element={<PaymentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const PAGE = '/acme/billing/pay/invoice/inv-1';

beforeEach(() => {
  verifyCallback.mockReset();
  getPaymentIntent.mockReset();
  window.sessionStorage.clear();
});

describe('PaymentPage — money recorded for review', () => {
  it('the return from the provider shows "under review", not "failed", and offers no retry', async () => {
    verifyCallback.mockRejectedValue(new Error('PAYMENT_UNDER_REVIEW'));
    renderAt(`${PAGE}?intent=pi-1&provider=stripe&session_id=cs_1`);
    await waitFor(() => expect(screen.getByText('billing.paymentResult.reviewTitle')).toBeInTheDocument());
    expect(screen.getByText('billing.errors.PAYMENT_UNDER_REVIEW')).toBeInTheDocument();
    expect(screen.queryByText('billing.paymentResult.failedTitle')).not.toBeInTheDocument();
    expect(screen.queryByText('billing.common.retry')).not.toBeInTheDocument();
  });

  it('a reload that resumes from the saved attempt asks the server and shows "under review" too', async () => {
    window.sessionStorage.setItem('billing:pending:invoice:inv-1', JSON.stringify({ intentId: 'pi-1', provider: 'stripe' }));
    getPaymentIntent.mockResolvedValue({ status: 'failed', pending: false, receipt: null, failureReason: 'PAYMENT_UNDER_REVIEW' });
    renderAt(PAGE);
    await waitFor(() => expect(screen.getByText('billing.paymentResult.reviewTitle')).toBeInTheDocument());
    expect(verifyCallback).not.toHaveBeenCalled();
    expect(screen.queryByText('billing.paymentResult.failedTitle')).not.toBeInTheDocument();
  });

  it('an attempt that is polled until it ends under review shows "under review"', async () => {
    verifyCallback.mockResolvedValue({ success: true, verified: false, pending: true });
    getPaymentIntent.mockResolvedValue({ status: 'failed', pending: false, receipt: null, failureReason: 'PAYMENT_UNDER_REVIEW' });
    renderAt(`${PAGE}?intent=pi-1&provider=stripe&session_id=cs_1`);
    await waitFor(() => expect(screen.getByText('billing.paymentResult.reviewTitle')).toBeInTheDocument(), { timeout: 5000 });
    expect(verifyCallback).toHaveBeenCalledTimes(1);
    expect(getPaymentIntent).toHaveBeenCalledWith('pi-1');
  });

  it('a genuinely failed payment is still shown as failed, with a retry', async () => {
    verifyCallback.mockResolvedValue({ success: true, verified: false, status: 'canceled' });
    renderAt(`${PAGE}?intent=pi-1&provider=stripe&canceled=1`);
    await waitFor(() => expect(screen.getByText('billing.paymentResult.failedTitle')).toBeInTheDocument());
    expect(screen.getByText('billing.common.retry')).toBeInTheDocument();
  });
});

describe('PaymentPage — a successful payment', () => {
  it('shows a translated title (successTitle, never the raw succeededTitle key) and the invoice\'s own number', async () => {
    verifyCallback.mockResolvedValue({
      success: true, verified: true, pending: false,
      receipt: { invoiceNumber: 'EY70602889', orderId: 'pi-1', amountIrr: 2900, currency: 'USD', providerRef: 'txn_1', paidAt: '2026-10-10T08:30:00Z', planName: 'Startup', purchaseType: 'subscription' },
    });
    renderAt(`${PAGE}?intent=pi-1&provider=paddle_sandbox&_ptxn=txn_1`);
    await waitFor(() => expect(screen.getByText('billing.paymentResult.successTitle')).toBeInTheDocument());
    expect(screen.queryByText('billing.paymentResult.succeededTitle')).not.toBeInTheDocument();
    // The result card names the invoice on this page, not the payment's own number.
    expect(screen.getAllByText('AB12345678').length).toBeGreaterThan(1);
    expect(screen.queryByText('EY70602889')).not.toBeInTheDocument();
  });
});
