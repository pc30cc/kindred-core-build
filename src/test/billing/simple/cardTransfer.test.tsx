/**
 * Card-to-card top-up: the bank account checks (shared/cardTransfer.ts) and
 * the top-up dialog's card-to-card path (the method choice, the bank card
 * with its numbers, the receipt form and what it submits).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import {
  cardTransferReady,
  cleanCardTransferSettings,
  formatCardNumber,
  formatIban,
  luhnValid,
  normalizeCardNumber,
  normalizeIban,
  readCardTransferSettings,
} from '../../../../shared/cardTransfer';

const CARD = '6037997599102317';
const IBAN = 'IR820540102680020817909002';

describe('bank account checks', () => {
  it('card numbers: 16 digits with a valid checksum, Persian digits and spaces accepted', () => {
    expect(luhnValid(CARD)).toBe(true);
    expect(normalizeCardNumber('۶۰۳۷ ۹۹۷۵ ۹۹۱۰ ۲۳۱۷')).toBe(CARD);
    expect(normalizeCardNumber('6037-9975-9910-2317')).toBe(CARD);
    expect(normalizeCardNumber('6037997599102312')).toBeNull();
    expect(normalizeCardNumber('603799759910231')).toBeNull();
    expect(formatCardNumber(CARD)).toBe('6037 9975 9910 2317');
  });

  it('IBANs: IR and 24 digits with a valid mod-97 checksum', () => {
    expect(normalizeIban('ir82 0540 1026 8002 0817 9090 02')).toBe(IBAN);
    expect(normalizeIban('820540102680020817909002')).toBe(IBAN);
    expect(normalizeIban('IR830540102680020817909002')).toBeNull();
    expect(normalizeIban('IR8205401026800208179090')).toBeNull();
    expect(formatIban(IBAN)).toBe('IR82 0540 1026 8002 0817 9090 02');
  });

  it('settings: an enabled method needs every field; stored junk reads as not set', () => {
    expect(cleanCardTransferSettings({ enabled: true, holder_name: 'Ali', card_number: CARD, iban: IBAN, bank: 'بلوبانک' }))
      .toEqual({ ok: true, value: { enabled: true, holder_name: 'Ali', card_number: CARD, iban: IBAN, bank: 'بلوبانک' } });
    expect(cleanCardTransferSettings({ enabled: true, holder_name: 'Ali', card_number: '', iban: IBAN }))
      .toEqual({ ok: false, problem: 'CARD_TRANSFER_CARD_INVALID' });
    expect(cleanCardTransferSettings({ enabled: false, holder_name: '', card_number: '', iban: '' }))
      .toMatchObject({ ok: true, value: { enabled: false } });
    expect(readCardTransferSettings({ enabled: true, card_number: 'junk' })).toMatchObject({ enabled: false, card_number: '' });
    expect(cardTransferReady(readCardTransferSettings({ enabled: true, holder_name: 'Ali', card_number: CARD, iban: IBAN }))).toBe(true);
    expect(cardTransferReady(readCardTransferSettings({ enabled: false, holder_name: 'Ali', card_number: CARD, iban: IBAN }))).toBe(false);
  });
});

// ─── The dialog ─────────────────────────────────────────────────────────────

const api = { submit: vi.fn(), topup: vi.fn() };
vi.mock('@/lib/accountBillingApi', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    accountBillingApi: {
      submitCardTransfer: (ws: string, input: unknown) => api.submit(ws, input),
      topup: (ws: string, input: unknown) => api.topup(ws, input),
    },
  };
});
vi.mock('@/i18n', () => {
  const t = (k: string, vars?: Record<string, unknown>) => (vars ? `${k}:${Object.values(vars).join(',')}` : k);
  return { useI18n: () => ({ locale: 'fa', dir: 'rtl', t }), useTranslation: () => ({ locale: 'fa', dir: 'rtl', t }) };
});
vi.mock('@/hooks/useAdmin', () => ({ useIsGlobalAdmin: () => ({ data: false }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: TopupDialog } = await import('@/pages/app/billing/account/TopupDialog');

const ACCOUNT = { holder_name: 'علی رضایی', card_number: CARD, iban: IBAN, bank: 'بلوبانک' };

function renderDialog(gateways: Array<{ provider_name: string; display_name: Record<string, string>; is_test: boolean }> = []) {
  const onSubmitted = vi.fn();
  render(
    <TopupDialog
      open
      onOpenChange={() => undefined}
      workspaceId="ws-1"
      slug="shop"
      currency="IRR"
      edition="iran"
      vatPercent={10}
      gateways={gateways}
      cardTransfer={ACCOUNT}
      onCardTransferSubmitted={onSubmitted}
    />,
  );
  return { onSubmitted };
}

// jsdom has no object URLs (the receipt preview).
URL.createObjectURL ??= (() => 'blob:preview') as typeof URL.createObjectURL;
URL.revokeObjectURL ??= (() => undefined) as typeof URL.revokeObjectURL;

beforeEach(() => {
  cleanup();
  api.submit.mockReset().mockResolvedValue({ item: { id: 'r1' } });
  api.topup.mockReset();
});

describe('top-up dialog: card to card', () => {
  it('without an online gateway, card to card is the method; the card shows both numbers', async () => {
    renderDialog();
    expect(screen.getByTestId('topup-method-card')).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('topup-method-online')).toBeNull();
    fireEvent.change(screen.getByLabelText('billing.account.topup.amount'), { target: { value: '500000' } });
    await act(async () => { fireEvent.click(screen.getByTestId('topup-card-next')); });
    expect(screen.getByTestId('bank-card-number')).toHaveTextContent('6037 9975 9910 2317');
    expect(screen.getByTestId('bank-card-iban')).toHaveTextContent('IR82 0540 1026 8002 0817 9090 02');
    expect(screen.getByTestId('bank-card-holder')).toHaveTextContent('علی رضایی');
    expect(screen.getByTestId('bank-card-bank')).toHaveTextContent('بلوبانک');
    // 500,000 Toman credit + 10% VAT = 550,000 Toman to transfer.
    expect(screen.getByTestId('card-transfer-total').textContent).toMatch(/۵۵۰[٬,]۰۰۰|550,000/);
  });

  it('submits the amount, tracking number, time, last four digits and the receipt', async () => {
    const { onSubmitted } = renderDialog([{ provider_name: 'zarinpal', display_name: { fa: 'زرین‌پال' }, is_test: false }]);
    expect(screen.getByTestId('topup-method-online')).toHaveAttribute('aria-checked', 'true');
    await act(async () => { fireEvent.click(screen.getByTestId('topup-method-card')); });
    fireEvent.change(screen.getByLabelText('billing.account.topup.amount'), { target: { value: '200000' } });
    await act(async () => { fireEvent.click(screen.getByTestId('topup-card-next')); });

    expect(screen.getByTestId('ct-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('ct-reference'), { target: { value: '۱۲۳۴۵۶۷۸۹' } });
    fireEvent.change(screen.getByTestId('ct-last4'), { target: { value: '4321' } });
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], 'fish.png', { type: 'image/png' });
    await act(async () => { fireEvent.change(screen.getByTestId('ct-file'), { target: { files: [file] } }); });
    expect(screen.getByTestId('ct-dropzone')).toHaveTextContent('fish.png');
    await act(async () => { fireEvent.click(screen.getByTestId('ct-submit')); });

    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1));
    const [ws, input] = api.submit.mock.calls[0] as [string, Record<string, unknown>];
    expect(ws).toBe('ws-1');
    expect(input).toMatchObject({ amountMinor: 2_000_000, reference: '123456789', payerCardLast4: '4321', note: null });
    expect(input.receipt).toMatchObject({ fileName: 'fish.png', mimeType: 'image/png' });
    expect(String((input.receipt as Record<string, string>).dataBase64)).toMatch(/^data:image\/png;base64,/);
    expect(new Date(String(input.paidAt)).getTime()).toBeLessThanOrEqual(Date.now());
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    expect(api.topup).not.toHaveBeenCalled();
  });

  it('refuses a file that is not an image or a PDF before sending', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('billing.account.topup.amount'), { target: { value: '200000' } });
    await act(async () => { fireEvent.click(screen.getByTestId('topup-card-next')); });
    const file = new File(['hello'], 'fish.txt', { type: 'text/plain' });
    await act(async () => { fireEvent.change(screen.getByTestId('ct-file'), { target: { files: [file] } }); });
    expect(screen.getByRole('alert')).toHaveTextContent('billing.account.cardTransfer.err_receiptType');
    expect(api.submit).not.toHaveBeenCalled();
  });
});
