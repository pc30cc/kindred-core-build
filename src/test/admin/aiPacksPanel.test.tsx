/**
 * Super Admin → Plans → Billing settings → AI credit packs (phase 5). Prices
 * and credit are typed as people read them and saved in minor units (Toman
 * typed, Rial stored); a currency without an AI exchange rate is flagged per
 * pack; packs are offered only while AI billing is Enforced; and the save
 * sends exactly the packs, checked by the server's own rules first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import type { Locale } from '@/i18n/config';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';

vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));

import AiPacksPanel, { type AiPacksView } from '@/components/admin/AiPacksPanel';

const IRAN: AiPacksView = {
  edition: 'iran',
  currencies: ['IRR'],
  packs: { IRR: [{ id: 's', price_minor: 2_000_000, credit_minor: 2_200_000, active: true, label: { fa: 'بسته‌ی کوچک' } }] },
  rates: { IRR: 1 },
  mode: 'METER_ONLY',
  vat_percent: { IRR: 10 },
};

const ABROAD: AiPacksView = {
  edition: 'international',
  currencies: ['USD', 'TRY'],
  packs: {
    USD: [{ id: 'm', price_minor: 500, credit_minor: 600, active: true }],
    TRY: [{ id: 't', price_minor: 20_000, credit_minor: 20_000, active: false }],
  },
  rates: { USD: 600_000, TRY: null },
  mode: 'ENFORCED',
  vat_percent: { USD: null, TRY: 20 },
};

type Reply = { status: number; body: unknown };
let replies: Reply[];
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
  const next = replies.shift() ?? { status: 500, body: { error: 'NO_REPLY' } };
  return { ok: next.status < 400, status: next.status, json: async () => next.body };
});

function puts(): Array<{ packs: Record<string, unknown[]> }> {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(String(init?.body)));
}

async function renderPanel(view: AiPacksView, locale: Locale = 'en') {
  replies.unshift({ status: 200, body: view });
  render(
    <I18nProvider initialLocale={locale} initialTranslations={locale === 'fa' ? fa : en}>
      <AiPacksPanel />
    </I18nProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('ai-packs-panel')).toBeInTheDocument());
}

const row = (at: string) => within(screen.getByTestId(`ai-pack-row-${at}`));
const p = en.admin.billingSettings.aiPacks;

describe('Super Admin AI credit packs', () => {
  beforeEach(() => {
    replies = [];
    fetchMock.mockClear();
    toast.success.mockClear();
    toast.error.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads and writes the pack editor endpoint', async () => {
    await renderPanel(IRAN);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/simple-billing/ai-packs');
  });

  it('shows Iranian prices in Toman, saves them in Rial, and keeps a saved id fixed', async () => {
    await renderPanel(IRAN);
    const price = row('IRR.0').getByLabelText(/^Price/) as HTMLInputElement;
    const credit = row('IRR.0').getByLabelText(/^AI credit/) as HTMLInputElement;
    expect(price.value).toBe('200000');
    expect(credit.value).toBe('220000');
    expect((row('IRR.0').getByLabelText('ID') as HTMLInputElement).readOnly).toBe(true);
    expect(row('IRR.0').getByTestId('ai-pack-bonus').textContent).toBe('+10% bonus');
    expect(row('IRR.0').getByTestId('ai-pack-wallet').textContent).toBe('≈ 2,200,000 AI wallet units');

    // Persian digits and separators are read as typed.
    fireEvent.change(price, { target: { value: '۳۰۰٬۰۰۰' } });
    fireEvent.click(screen.getByRole('button', { name: p.add }));
    const added = row('IRR.1');
    expect((added.getByLabelText('ID') as HTMLInputElement).value).toBe('p1');
    expect((added.getByLabelText('ID') as HTMLInputElement).readOnly).toBe(false);
    fireEvent.change(added.getByLabelText(/^Price/), { target: { value: '50000' } });
    fireEvent.change(added.getByLabelText(/^AI credit/), { target: { value: '50000' } });

    replies.push({ status: 200, body: { ...IRAN, packs: { IRR: [] } } });
    fireEvent.click(screen.getByRole('button', { name: p.save }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(p.saved));
    expect(puts()).toEqual([{
      packs: {
        IRR: [
          { id: 's', price_minor: 3_000_000, credit_minor: 2_200_000, active: true, label: { fa: 'بسته‌ی کوچک' } },
          { id: 'p1', price_minor: 500_000, credit_minor: 500_000, active: true },
        ],
      },
    }]);
  });

  it('warns while AI billing is not Enforced', async () => {
    await renderPanel(IRAN);
    expect(screen.getByTestId('ai-packs-mode-warning').textContent).toContain(p.modeWarning);
  });

  it('abroad: no mode warning when Enforced, the FX warning with USD packs, and the no-rate hint per pack', async () => {
    await renderPanel(ABROAD);
    expect(screen.queryByTestId('ai-packs-mode-warning')).toBeNull();
    expect(screen.getByTestId('ai-packs-fx-warning').textContent).toContain(p.fxWarning);
    // $5.00 buys $6.00 of credit: 6 × 600,000 wallet units.
    expect((row('USD.0').getByLabelText(/^Price/) as HTMLInputElement).value).toBe('5');
    expect(row('USD.0').getByTestId('ai-pack-wallet').textContent).toBe('≈ 3,600,000 AI wallet units');
    expect(row('USD.0').getByTestId('ai-pack-bonus').textContent).toBe('+20% bonus');
    expect(row('TRY.0').getByTestId('ai-pack-no-rate').textContent).toBe('No exchange rate for TRY: this pack will not be offered.');
    expect(row('TRY.0').queryByTestId('ai-pack-bonus')).toBeNull();
    expect(row('TRY.0').getByRole('switch').getAttribute('aria-checked')).toBe('false');

    // Removing the only USD pack drops the FX warning; the save keeps TRY as it is.
    fireEvent.click(row('USD.0').getByRole('button', { name: p.remove }));
    expect(screen.queryByTestId('ai-packs-fx-warning')).toBeNull();
    replies.push({ status: 200, body: ABROAD });
    fireEvent.click(screen.getByRole('button', { name: p.save }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual({ packs: { USD: [], TRY: [{ id: 't', price_minor: 20_000, credit_minor: 20_000, active: false }] } });
  });

  it('reorders packs and opens the names', async () => {
    await renderPanel({ ...ABROAD, packs: { USD: [...ABROAD.packs.USD, { id: 'l', price_minor: 2000, credit_minor: 2500 }], TRY: [] } });
    fireEvent.click(row('USD.1').getByRole('button', { name: p.up }));
    expect((row('USD.0').getByLabelText('ID') as HTMLInputElement).value).toBe('l');
    fireEvent.click(row('USD.0').getByRole('button', { name: p.labels }));
    fireEvent.change(row('USD.0').getByLabelText('Turkish'), { target: { value: '  Büyük  ' } });
    replies.push({ status: 200, body: ABROAD });
    fireEvent.click(screen.getByRole('button', { name: p.save }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0].packs.USD).toEqual([
      { id: 'l', price_minor: 2000, credit_minor: 2500, active: true, label: { tr: 'Büyük' } },
      { id: 'm', price_minor: 500, credit_minor: 600, active: true },
    ]);
  });

  it('checks the rules before saving: a duplicate id or an IRR price below a Toman is not sent', async () => {
    await renderPanel(IRAN);
    fireEvent.click(screen.getByRole('button', { name: p.add }));
    const added = row('IRR.1');
    fireEvent.change(added.getByLabelText('ID'), { target: { value: 's' } });
    fireEvent.change(added.getByLabelText(/^Price/), { target: { value: '1000' } });
    fireEvent.change(added.getByLabelText(/^AI credit/), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: p.save }));
    expect(screen.getByRole('alert').textContent).toBe('Two packs in IRR have the same ID.');
    expect(added.getByLabelText('ID').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(added.getByLabelText('ID'), { target: { value: 'b' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.change(added.getByLabelText(/^Price/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: p.save }));
    expect(screen.getByRole('alert').textContent).toBe(p.errors.invalid);
    expect(added.getByLabelText(/^Price/).getAttribute('aria-invalid')).toBe('true');
    expect(puts()).toEqual([]);
  });

  it('highlights the field the server names in a 400', async () => {
    await renderPanel(IRAN);
    replies.push({ status: 400, body: { error: 'AI_PACKS_INVALID', field: 'IRR.0.credit_minor', reason: 'invalid' } });
    fireEvent.click(screen.getByRole('button', { name: p.save }));
    await waitFor(() => expect(row('IRR.0').getByLabelText(/^AI credit/).getAttribute('aria-invalid')).toBe('true'));
    expect(toast.error).toHaveBeenCalledWith(p.errors.invalid);
    expect(puts()).toHaveLength(1);
  });

  it('a server-named wrong name opens the names of its pack', async () => {
    await renderPanel(IRAN);
    replies.push({ status: 400, body: { error: 'AI_PACKS_INVALID', field: 'IRR.0.label.fa', reason: 'invalid' } });
    fireEvent.click(screen.getByRole('button', { name: p.save }));
    await waitFor(() => expect(row('IRR.0').getByLabelText('Persian').getAttribute('aria-invalid')).toBe('true'));
  });

  it('stops adding at the limit of packs per currency', async () => {
    await renderPanel({ ...IRAN, packs: { IRR: [] } });
    expect(screen.getByText(p.empty)).toBeInTheDocument();
    const add = screen.getByRole('button', { name: p.add });
    for (let i = 0; i < 8; i++) fireEvent.click(add);
    expect(add).toBeDisabled();
    expect((row('IRR.7').getByLabelText('ID') as HTMLInputElement).value).toBe('p8');
  });

  it('speaks Persian with Toman units', async () => {
    await renderPanel(IRAN, 'fa');
    expect(screen.getByText(fa.admin.billingSettings.aiPacks.title)).toBeInTheDocument();
    expect(row('IRR.0').getByTestId('ai-pack-wallet').textContent).toBe('≈ ۲٬۲۰۰٬۰۰۰ واحد کیف پول هوش مصنوعی');
    expect(row('IRR.0').getByLabelText(/^قیمت/).closest('div')?.textContent).toContain('تومان');
  });
});
