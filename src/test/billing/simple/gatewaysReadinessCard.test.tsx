/**
 * Finance → Gateways' readiness card: a gateway whose settings are
 * incomplete (`not_configured`) says what is missing, and links to the
 * provider's settings where it is fixed.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { GatewayReadinessReport } from '../../../../shared/simpleBillingAdmin';

vi.mock('@/i18n', async () => {
  const en = (await import('@/i18n/locales/en')).default as unknown;
  const lookup = (key: string): unknown =>
    key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), en);
  const t = (key: string) => {
    const value = lookup(key);
    return typeof value === 'string' ? value : key;
  };
  return { useTranslation: () => ({ t, locale: 'en', dir: 'ltr' }) };
});

const report: GatewayReadinessReport = {
  edition: 'international',
  currencies: ['USD'],
  gateways: [{
    provider_name: 'paddle',
    display_name: { en: 'Paddle' },
    is_active: true,
    is_test: false,
    implemented: true,
    currencies: ['USD'],
    listing: { USD: { listed: false, reasons: ['not_configured'], problem: 'Paddle: Webhook Secret Key is empty.' } },
    card_auto_renew: true,
  }, {
    provider_name: 'sep_shaparak',
    display_name: { en: 'SEP' },
    is_active: false,
    is_test: false,
    implemented: true,
    currencies: ['IRR'],
    listing: { USD: { listed: false, reasons: ['not_in_edition', 'inactive'] } },
    note: 'SEP (Saman) did not answer from the production server (Canada) within 15 s.',
  }],
};

vi.mock('@/lib/adminSimpleBillingApi', () => ({
  useGatewayReadiness: () => ({ data: report, isLoading: false, isError: false, refetch: vi.fn() }),
}));

const GatewaysReadinessCard = (await import('@/pages/admin/finance/GatewaysReadinessCard')).default;

describe('GatewaysReadinessCard', () => {
  it('names the missing setting and links to the provider settings', () => {
    render(<MemoryRouter><GatewaysReadinessCard /></MemoryRouter>);
    expect(screen.getByTestId('gateway-settings-problem').textContent).toBe('Paddle: Webhook Secret Key is empty.');
    const link = screen.getByText('Settings incomplete').closest('a');
    expect(link?.getAttribute('href')).toBe('/admin/providers?type=billing&provider=paddle');
  });

  it('shows a gateway\'s caveat (Part C: SEP and IDPay did not answer from the production server)', () => {
    render(<MemoryRouter><GatewaysReadinessCard /></MemoryRouter>);
    const notes = screen.getAllByTestId('gateway-note');
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toMatch(/did not answer from the production server/);
  });
});
