/**
 * The legal links under the sign-in pages: International edition only, on
 * the site address Super Admin sets (the brand tokens' siteUrl).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const state = { international: true, siteUrl: 'https://respok.app' };
vi.mock('@/lib/internationalMode', () => ({ useInternationalMode: () => state.international }));
vi.mock('@/lib/brand', async (orig) => ({
  ...(await orig<typeof import('@/lib/brand')>()),
  useBrandTokens: () => ({ brand: 'RESPOK', brandLatin: 'RESPOK', brandPlugin: 'RESPOK', supportEmail: '', siteUrl: state.siteUrl, fill: (s: string) => s }),
}));

import { AuthLegalLinks } from '@/components/auth/AuthLegalLinks';

function show() {
  return render(<I18nProvider initialLocale="en" initialTranslations={en}><AuthLegalLinks /></I18nProvider>);
}

beforeEach(() => { cleanup(); state.international = true; state.siteUrl = 'https://respok.app'; });

describe('AuthLegalLinks', () => {
  it('links the four policies on the site address from Super Admin', () => {
    show();
    const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href');
    expect(href('Terms of Use')).toBe('https://respok.app/terms');
    expect(href('Privacy Policy')).toBe('https://respok.app/privacy');
    expect(href('Refund Policy')).toBe('https://respok.app/refund');
    expect(href('Service Level Agreement')).toBe('https://respok.app/sla');
  });

  it('follows a changed site address', () => {
    state.siteUrl = 'https://new-site.example/';
    show();
    expect(screen.getByRole('link', { name: 'Refund Policy' }).getAttribute('href')).toBe('https://new-site.example/refund');
  });

  it('shows nothing in the Iranian edition', () => {
    state.international = false;
    show();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
