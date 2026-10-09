/**
 * The client side of the edition (src/lib/edition.ts, src/hooks/useEdition.ts,
 * src/lib/money.ts, src/lib/region.ts, the billing money() helper and the
 * provider catalogue).
 *
 * Iranian edition: Toman exactly as before (guards below).
 * International edition: USD — Persian included — and no Toman, no Iranian
 * gateway or vendor anywhere.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: undefined as unknown, locale: 'fa' }));

vi.mock('@/lib/platformPublicConfig', () => ({ usePlatformPublicConfig: () => ({ data: state.data }) }));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: state.locale, dir: state.locale === 'fa' ? 'rtl' : 'ltr', t: (k: string) => k }),
  useTranslation: () => ({ locale: state.locale, dir: state.locale === 'fa' ? 'rtl' : 'ltr', t: (k: string) => k }),
}));

import { useEdition } from '@/hooks/useEdition';
import {
  EDITION_CACHE_KEY,
  __resetEditionForTests,
  cachedEdition,
  currentCurrency,
  currentEdition,
  rememberEdition,
  rememberRegionMode,
} from '@/lib/edition';
import { formatAmountForEdition, formatMoney as libFormatMoney, formatToman } from '@/lib/money';
import { displayCurrency, formatMoney as regionFormatMoney } from '@/lib/region';
import { money } from '@/pages/app/billing/shared';
import { PROVIDER_SCHEMAS, getSchemaForEdition, getVendorsForEdition } from '@/features/providers/schemas';

const config = (regionMode: string) => ({
  branding: null,
  localized: [],
  region: { region_mode: regionMode, active_locales: null, default_locale: null },
  realtime: null,
});

const fa = (n: number, digits = 0) => new Intl.NumberFormat('fa-IR', { minimumFractionDigits: 0, maximumFractionDigits: digits }).format(n);

beforeEach(() => {
  localStorage.clear();
  __resetEditionForTests();
  state.data = undefined;
  state.locale = 'fa';
});

describe('src/lib/region.ts', () => {
  it('Iran: Persian reads Toman exactly as before', () => {
    expect(displayCurrency('iran', 'fa')).toBe('IRT');
    expect(regionFormatMoney(1_000_000, 'fa', 'iran')).toBe(`${fa(100_000)} تومان`);
    expect(regionFormatMoney(1_000_000, 'en', 'iran')).toBe('100,000 Toman');
  });

  it('International: Persian reads USD, never Toman', () => {
    for (const mode of ['multi', 'global'] as const) {
      expect(displayCurrency(mode, 'fa')).toBe('USD');
      const text = regionFormatMoney(2900, 'fa', mode, { currency: 'USD' });
      expect(text).toBe(`${fa(29, 2)} دلار`);
      expect(text).not.toContain('تومان');
    }
    expect(displayCurrency('multi', 'en')).toBe('USD');
  });

  it('region currency × locale: Toman only in iran, Lira only in turkey, USD in multi/global for every language', () => {
    const expected = { iran: 'IRT', turkey: 'TRY', multi: 'USD', global: 'USD' } as const;
    for (const mode of ['iran', 'turkey', 'multi', 'global'] as const) {
      for (const locale of ['fa', 'en', 'tr'] as const) {
        expect(displayCurrency(mode, locale), `${mode}/${locale}`).toBe(expected[mode]);
      }
    }
    // A record with no currency reads the region's; one with its own keeps it (never relabelled).
    expect(regionFormatMoney(2900, 'tr', 'multi')).toBe('29 USD');
    expect(regionFormatMoney(2900, 'tr', 'turkey')).toBe('29 TL');
    expect(regionFormatMoney(2900, 'tr', 'turkey', { currency: 'USD' })).toBe('29 USD');
    expect(regionFormatMoney(2900, 'en', 'multi', { currency: 'TRY' })).toBe('29 TRY');
    // Legacy Rial outside Iran: plain IRR, never Toman.
    expect(regionFormatMoney(1_000_000, 'fa', 'multi', { currency: 'IRR' })).not.toMatch(/تومان|Toman/);
    // Iran pins Toman whatever the record says (as before).
    expect(regionFormatMoney(1_000_000, 'fa', 'iran', { currency: 'USD' })).toBe(`${fa(100_000)} تومان`);
  });
});

describe('src/lib/money.ts and the billing money() helper', () => {
  it('Iran (also while the edition is unknown): Toman, unchanged', () => {
    for (const setup of [() => rememberEdition('iran'), () => undefined]) {
      __resetEditionForTests();
      localStorage.clear();
      setup();
      expect(currentEdition()).toBe('iran');
      expect(libFormatMoney(1_000_000, 'IRR', 'fa-IR')).toBe(formatToman(1_000_000, 'fa-IR'));
      expect(libFormatMoney(1_000_000, null, 'fa-IR')).toBe(`${fa(100_000)} تومان`);
      // Historic Iranian behaviour kept as is: non-Rial amounts are shown raw.
      expect(libFormatMoney(2900, 'USD', 'en-US')).toBe('2,900 USD');
      expect(money(1_000_000, 'fa')).toBe(formatToman(1_000_000, 'fa'));
      expect(money(2900, 'en', 'USD')).toBe('$29.00');
      expect(currentCurrency()).toBe('IRR');
    }
  });

  it('International: USD by default, minor units, Persian included, never Toman', () => {
    rememberEdition('international');
    expect(libFormatMoney(2900, null, 'en-US')).toBe('$29.00');
    expect(libFormatMoney(2900, 'USD', 'en-US')).toBe('$29.00');
    expect(money(2900, 'en')).toBe('$29.00');
    const persian = money(2900, 'fa');
    expect(persian).not.toMatch(/تومان|Toman/);
    expect(persian).toContain(fa(29, 2));
    // A Turkish-only site: amounts with no currency are Lira; Multi Region stays USD.
    rememberRegionMode('turkey');
    expect(money(2900, 'tr')).toBe(formatAmountForEdition(2900, 'TRY', 'tr', 'international'));
    expect(currentCurrency()).toBe('TRY');
    rememberRegionMode('multi');
    expect(money(2900, 'tr')).toBe(formatAmountForEdition(2900, 'USD', 'tr', 'international'));
    expect(currentCurrency()).toBe('USD');
    // Legacy Rial data is labelled IRR, never relabelled as dollars or Toman.
    expect(formatAmountForEdition(1_000_000, 'IRR', 'en-US', 'international')).toBe('1,000,000 IRR');
    expect(libFormatMoney(1_000_000, 'IRR', 'en-US')).not.toMatch(/Toman|\$/);
  });
});

describe('the edition cache', () => {
  it('remembers the edition; old caches are hints only', () => {
    expect(cachedEdition()).toBeNull();
    localStorage.setItem('wy-site-mode', 'multi_language');
    expect(cachedEdition()).toBe('international');
    localStorage.setItem('platform-region-mode', 'iran');
    expect(cachedEdition()).toBe('iran');
    rememberEdition('international');
    expect(localStorage.getItem(EDITION_CACHE_KEY)).toBe('international');
    expect(cachedEdition()).toBe('international');
  });
});

describe('useEdition()', () => {
  it('Iran: Toman, Iranian gateways, wallet and AI top-up', () => {
    state.data = config('iran');
    const { result } = renderHook(() => useEdition());
    expect(result.current).toMatchObject({
      edition: 'iran', isIran: true, ready: true, regionMode: 'iran', currency: 'IRR', calendar: 'jalali', phoneCountry: 'IR',
      features: { wallet: true, aiCreditTopup: true, iranianProviders: true, smsVerification: true, bale: true },
    });
    expect(result.current.allowsProvider('zarinpal')).toBe(true);
    expect(result.current.allowsCurrency('IRR')).toBe(true);
    expect(result.current.formatAmount(1_000_000)).toBe(formatToman(1_000_000, 'fa'));
    expect(localStorage.getItem(EDITION_CACHE_KEY)).toBe('iran');
  });

  it.each([
    ['multi', 'USD'],
    ['global', 'USD'],
    ['turkey', 'TRY'],
  ])('International (%s): %s, no Iranian gateway, no wallet, no SMS verification, no Bale', (mode, currency) => {
    state.data = config(mode);
    const { result } = renderHook(() => useEdition());
    expect(result.current).toMatchObject({
      edition: 'international', isInternational: true, regionMode: mode, currency, calendar: 'gregorian', phoneCountry: null,
      features: { wallet: false, aiCreditTopup: false, iranianProviders: false, smsVerification: false, bale: false },
    });
    expect(result.current.allowsProvider('zarinpal')).toBe(false);
    expect(result.current.allowsProvider('stripe')).toBe(true);
    expect(result.current.allowsCurrency('IRR')).toBe(false);
    expect(result.current.formatAmount(2900)).not.toMatch(/تومان|Toman/);
  });

  it('before the config arrives: the cached edition, else (not ready) the historic Iranian behaviour', () => {
    expect(renderHook(() => useEdition()).result.current).toMatchObject({ edition: 'iran', ready: false });
    localStorage.setItem(EDITION_CACHE_KEY, 'international');
    expect(renderHook(() => useEdition()).result.current).toMatchObject({ edition: 'international', ready: true });
  });
});

describe('provider catalogue', () => {
  it('Iran: every vendor, the very same schema objects', () => {
    for (const type of Object.keys(PROVIDER_SCHEMAS)) {
      expect(getSchemaForEdition(type, 'iran')).toBe(PROVIDER_SCHEMAS[type]);
    }
  });

  it('International: no Iranian payment, SMS, CDN or storage vendor', () => {
    const iranian = ['zarinpal', 'zarinpal_test', 'idpay', 'idpay_test', 'internal_test', 'iranpardakht_sandbox', 'nextpay', 'payping', 'zibal', 'sep_shaparak',
      'kavenegar', 'melipayamak', 'ghasedak', 'farazsms', 'smsir', 'payamresan', 'arvancloud', 'iranserver_cdn', 'parspack_cdn', 'derakcloud', 'arvan_storage'];
    const all = Object.keys(PROVIDER_SCHEMAS).flatMap((type) => getVendorsForEdition(type, 'international').map((v) => v.name));
    for (const name of iranian) expect(all, name).not.toContain(name);
    // Nothing tagged as a Rial vendor survives either.
    for (const type of Object.keys(PROVIDER_SCHEMAS)) {
      for (const v of getVendorsForEdition(type, 'international')) expect(v.currency, `${type}/${v.name}`).not.toBe('IRR');
    }
    expect(getVendorsForEdition('billing', 'international').map((v) => v.name)).toEqual(expect.arrayContaining(['stripe', 'paypal']));
  });
});
