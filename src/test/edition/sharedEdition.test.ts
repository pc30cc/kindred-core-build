/**
 * shared/edition.ts — one rule for the server and the client:
 * the edition is `iran` iff platform_settings.region_mode === 'iran'.
 */
import { describe, expect, it } from 'vitest';
import {
  EDITION_PROFILE,
  IRANIAN_PAYMENT_PROVIDERS,
  editionCurrency,
  isCurrencyAllowedInEdition,
  isIranianPaymentProvider,
  isIranianVendor,
  isProviderAllowedInEdition,
  isRialCurrency,
  parseEdition,
  resolveEdition,
} from '../../../shared/edition';
import { IRAN_PROVIDERS } from '../../../server/services/billing/paymentIntent';

describe('resolveEdition', () => {
  it('is iran only for the exact region mode iran', () => {
    expect(resolveEdition('iran')).toBe('iran');
    for (const mode of ['multi', 'global', 'turkey', 'IRAN', ' iran', '', null, undefined, 42]) {
      expect(resolveEdition(mode), String(mode)).toBe('international');
    }
  });

  it('parses only stored edition values', () => {
    expect(parseEdition('iran')).toBe('iran');
    expect(parseEdition('international')).toBe('international');
    for (const v of ['multi', 'IRAN', '', null, undefined]) expect(parseEdition(v)).toBeNull();
  });
});

describe('EDITION_PROFILE', () => {
  it('keeps the Iranian edition exactly as before', () => {
    expect(EDITION_PROFILE.iran).toEqual({
      currency: 'IRR',
      calendar: 'jalali',
      phoneCountry: 'IR',
      allowsIranianProviders: true,
      wallet: true,
      aiCreditTopup: true,
    });
    expect(editionCurrency('iran')).toBe('IRR');
  });

  it('is USD, Gregorian, no Iranian providers and no Rial wallet internationally', () => {
    expect(EDITION_PROFILE.international).toEqual({
      currency: 'USD',
      calendar: 'gregorian',
      phoneCountry: null,
      allowsIranianProviders: false,
      wallet: false,
      aiCreditTopup: false,
    });
    expect(editionCurrency('international')).toBe('USD');
  });
});

describe('Iranian providers', () => {
  it('has one canonical payment list, shared with the server', () => {
    expect([...IRAN_PROVIDERS].sort()).toEqual([...IRANIAN_PAYMENT_PROVIDERS].sort());
    expect(IRANIAN_PAYMENT_PROVIDERS).toEqual(
      expect.arrayContaining(['zarinpal', 'idpay', 'nextpay', 'payping', 'zibal', 'sep_shaparak', 'internal_test']),
    );
  });

  it('recognises payment, SMS, CDN and storage vendors (and the legacy "sep" alias)', () => {
    for (const name of ['zarinpal', 'ZarinPal', 'sep', 'internal_test']) expect(isIranianPaymentProvider(name), name).toBe(true);
    for (const name of ['kavenegar', 'smsir', 'arvancloud', 'arvan_storage', 'parspack_cdn']) expect(isIranianVendor(name), name).toBe(true);
    for (const name of ['stripe', 'paypal', 'paddle', 'lemon_squeezy', 'iyzico', 'twilio', 'cloudflare', '', null]) {
      expect(isIranianVendor(name), String(name)).toBe(false);
    }
  });

  it('allows every provider in Iran and no Iranian one internationally', () => {
    for (const name of [...IRANIAN_PAYMENT_PROVIDERS, 'kavenegar', 'arvan_storage', 'stripe']) {
      expect(isProviderAllowedInEdition(name, 'iran'), name).toBe(true);
    }
    for (const name of [...IRANIAN_PAYMENT_PROVIDERS, 'sep', 'kavenegar', 'arvancloud', 'arvan_storage']) {
      expect(isProviderAllowedInEdition(name, 'international'), name).toBe(false);
    }
    for (const name of ['stripe', 'paypal', 'paddle', 'lemon_squeezy', 'iyzico']) {
      expect(isProviderAllowedInEdition(name, 'international'), name).toBe(true);
    }
  });
});

describe('currencies', () => {
  it('knows every Rial/Toman spelling', () => {
    for (const c of ['IRR', 'irr', 'IRT', 'TOMAN', 'RIAL', 'TMN']) expect(isRialCurrency(c), c).toBe(true);
    for (const c of ['USD', 'EUR', 'TRY', '', null]) expect(isRialCurrency(c), String(c)).toBe(false);
  });

  it('allows every currency in Iran and no Rial internationally', () => {
    for (const c of ['IRR', 'USD', 'EUR', 'TRY']) expect(isCurrencyAllowedInEdition(c, 'iran')).toBe(true);
    expect(isCurrencyAllowedInEdition('IRR', 'international')).toBe(false);
    expect(isCurrencyAllowedInEdition('IRT', 'international')).toBe(false);
    for (const c of ['USD', 'EUR', 'TRY']) expect(isCurrencyAllowedInEdition(c, 'international')).toBe(true);
  });
});
