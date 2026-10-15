/**
 * The RESPOK build (scripts/build/brand.mjs → shared/buildBrand.ts
 * SHIPS_IRAN_KIT = false) carries nothing of the Iran region's brand: no
 * name in any spelling, no domain, no kit file. Here the build constant is
 * false, as Vite's `define` makes it in that build, and the browser even
 * remembers the Iranian edition (the worst case): the brand components, the
 * brand words and the Iran-only values still read nothing of it.
 *
 * The built files themselves are checked by scripts/build/brandAudit.mjs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IRAN_BRAND_PATTERNS } from '../../../scripts/build/brandAudit.mjs';
import { brandIndexHtml } from '../../../scripts/build/brandIndexHtml.mjs';

vi.mock('../../../shared/buildBrand', () => ({
  BUILD_BRAND: 'respok',
  SHIPS_IRAN_KIT: false,
  SHIPS_INTL_KIT: true,
}));

const state = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock('@/lib/platformPublicConfig', () => ({
  usePlatformPublicConfig: () => ({ data: state.data }),
  fetchPlatformPublicConfig: () => Promise.resolve(state.data),
}));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'fa', dir: 'rtl', t: (key: string) => key }),
  useTranslation: () => ({ locale: 'fa', dir: 'rtl', t: (key: string) => key }),
}));
vi.mock('@/lib/native', () => ({ isNativePlatform: () => false, getNativePlatform: () => 'web' }));

import { BrandLockup, BrandLogo } from '@/components/brand/BrandLogo';
import { BrandFooter, BrandLoader, BrandLoaderScreen, BrandWordmark } from '@/components/brand/BrandLoader';
import ReceiptDocument from '@/pages/app/billing/account/ReceiptDocument';
import { WEBYAR_BRAND } from '@/lib/webyarBrand';
import { __resetEditionForTests, cachedEdition, currentEdition, knownEdition } from '@/lib/edition';
import { __resetBrandForTests, brandTokens } from '@/lib/brand';
import { notificationIcon } from '@/features/notifications/operatorBrowserNotification';
import { isAdsProduction } from '@/lib/googleAds';
import { LEGAL_CONTACT_EMAIL } from '@/pages/public/legal/legalDocuments';
import { androidApkFile, androidReleaseCommands, appReviewAccountFallback, iosBuildCommands } from '@/components/admin/mobile/nativeBuild';
import { macosDefaultAppcastUrl } from '@/hooks/useMacosApp';
import { brandTokensFor } from '../../../shared/brand';
import { nativeAppBrand } from '../../../shared/nativeAppBrands';

const IRAN_DOMAIN = /webyar\.(?:ai|app)/i;

function expectBrandFree(text: string, what: string) {
  for (const re of IRAN_BRAND_PATTERNS) expect(re.test(text), `${what}: ${text.slice(0, 300)}`).toBe(false);
  expect(IRAN_DOMAIN.test(text), what).toBe(false);
}

const RECEIPT = {
  id: 'l-topup', kind: 'topup', amount_minor: 1500, balance_after: 1500, currency: 'USD', plan_id: null, billing_interval: null,
  period_start: null, period_end: null, payment_id: 'pay-1', receipt_number: 'RS2026-000042', net_minor: 1500, tax_minor: 0, tax_percent: null,
  buyer: { company: 'Acme Ltd' }, seller: { legal_name: 'Platform Inc.' }, description: { provider: 'paddle', provider_name: { en: 'Card (Paddle)' } },
  created_at: '2026-10-01T09:00:00Z',
};

function renderHtml(ui: ReactElement): string {
  const client = new QueryClient();
  const { container, unmount } = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  const html = container.innerHTML;
  unmount();
  return html;
}

const editions = [
  ['the Iranian edition remembered', () => localStorage.setItem('wy-edition', 'iran')],
  ['an edition not known yet', () => undefined],
] as const;

beforeEach(() => {
  state.data = undefined;
  localStorage.clear();
  __resetEditionForTests();
  __resetBrandForTests();
});

describe.each(editions)('a build without the Iranian kit, with %s', (_label, remember) => {
  beforeEach(() => remember());

  it('is the International edition from the first paint', () => {
    expect(cachedEdition()).toBe('international');
    expect(knownEdition()).toBe('international');
    expect(currentEdition()).toBe('international');
  });

  it('draws every brand component without the Iranian brand', () => {
    const parts: Array<[string, ReactElement]> = [
      ['BrandLogo', <BrandLogo />],
      ['BrandLogo with src', <BrandLogo src="/operator.png" />],
      ['BrandLockup', <BrandLockup name="Platform" />],
      ['BrandLockup keepMark', <BrandLockup keepMark />],
      ['BrandLoader', <BrandLoader />],
      ['BrandFooter', <BrandFooter />],
      ['BrandWordmark', <BrandWordmark />],
      ['BrandLoaderScreen', <BrandLoaderScreen />],
      ['ReceiptDocument', <ReceiptDocument receipt={RECEIPT as never} locale="fa" dir="rtl" />],
    ];
    for (const [name, ui] of parts) {
      const html = renderHtml(ui);
      expectBrandFree(html, name);
      expect(html, name).not.toContain('/brand/webyar');
      expect(html, name).not.toMatch(/\bWEBYAR\b/);
    }
  });

  it('fills the brand words with the platform, never the Iranian strings', () => {
    for (const locale of ['en', 'fa', 'tr']) expectBrandFree(JSON.stringify(brandTokens(locale)), `brandTokens(${locale})`);
    for (const edition of ['iran', 'international', null] as const) {
      expectBrandFree(JSON.stringify(brandTokensFor(edition, 'fa', null)), `brandTokensFor(${edition})`);
    }
  });

  it('has no Iranian value in the kit, the apps, the legal pages, notifications or ads', () => {
    expectBrandFree(JSON.stringify(WEBYAR_BRAND), 'WEBYAR_BRAND');
    for (const edition of ['iran', 'international', null] as const) {
      expectBrandFree(JSON.stringify(nativeAppBrand(edition)), `nativeAppBrand(${edition})`);
      expectBrandFree(iosBuildCommands({ marketing_version: '1.0.0', build_number: 1 }, edition).join('\n'), 'iosBuildCommands');
      expectBrandFree(androidReleaseCommands({ android_version_name: '1.0.0', android_version_code: 1 }, edition), 'androidReleaseCommands');
      expectBrandFree(androidApkFile(edition), 'androidApkFile');
      expectBrandFree(macosDefaultAppcastUrl(edition), 'macosDefaultAppcastUrl');
      expect(appReviewAccountFallback(edition)).toBe('');
    }
    expect(LEGAL_CONTACT_EMAIL).toBe('');
    expectBrandFree(notificationIcon(), 'notificationIcon');
    expect(isAdsProduction()).toBe(false);
  });
});

describe('index.html per build brand', () => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  it('the RESPOK build: no Iranian name, file or kit, and the splash already RESPOK’s', () => {
    const out = brandIndexHtml(html, 'respok');
    expectBrandFree(out, 'index.html (respok)');
    expect(out).not.toContain('/brand/webyar');
    expect(out).not.toContain('wy-kit-');
    expect(out).not.toContain('@iran-kit');
    expect(out).not.toContain('@respok-build');
    expect(out).toContain('<div class="wy-loader wy-intl" aria-hidden="true">');
    expect(out).toContain('/brand/intl/respok-thread-horizontal-color.svg');
    expect(out).toContain('window.__wyApplySplash();');
  });

  it('every other build: the page exactly as written, without the markers', () => {
    for (const brand of ['iran', 'both']) {
      const out = brandIndexHtml(html, brand);
      expect(out).not.toMatch(/@iran-kit|@end-iran-kit|@respok-build|@end-respok-build/);
      expect(out).toContain('aria-label="WEBYAR AI"');
      expect(out).toContain('function applyWebyarKit()');
      expect(out).toContain("if (!splash || splash.querySelector('.wy-loader.wy-intl')) return;");
      expect(out).not.toContain('class="wy-loader wy-intl"');
    }
  });
});
