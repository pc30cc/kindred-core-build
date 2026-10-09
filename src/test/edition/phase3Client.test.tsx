/**
 * Editions phase 3, client side (International = region_mode != 'iran').
 *
 *   - Calendar: Persian reads Jalali in the Iranian edition only; in
 *     International Persian is Persian digits on the Gregorian calendar
 *     (src/lib/date.ts, which the global Intl patch and every formatter use,
 *     and the Art chart kit).
 *   - Phone: no Iranian default country, international E.164 input, SMS
 *     verification (Iranian vendors only) hidden — its gate never blocks.
 *   - SMS providers: a neutral "not available" panel instead of Iranian vendors.
 *   - The Persian network-error hint names Iran in the Iranian edition only.
 *
 * Iranian-edition output (and an unknown edition, which behaves as before) is
 * pinned unchanged.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  statusCalls: [] as boolean[],
}));

vi.mock('@/lib/platformPublicConfig', () => ({ usePlatformPublicConfig: () => ({ data: state.data }) }));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'fa', dir: 'rtl', t: (k: string) => k }),
  useTranslation: () => ({ locale: 'fa', dir: 'rtl', t: (k: string) => k }),
}));
vi.mock('@/features/phone-verification/hooks', () => ({
  usePhoneVerificationStatus: (_ctx: unknown, enabled = true) => {
    state.statusCalls.push(enabled);
    return enabled
      ? { data: undefined, isLoading: true, isError: false, refetch: vi.fn() }
      : { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  },
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  adminGetSmsProvider: async () => ({ providerName: 'kavenegar', configured: true, enabled: true, hasApiKey: true }),
}));

import { __resetEditionForTests, rememberEdition } from '@/lib/edition';
import {
  formatDate,
  formatLongDate,
  formatPattern,
  getAppCalendar,
  resolveDateLocale,
  setAppCalendar,
} from '@/lib/date';
import { artDateTag } from '@/themes/art/charts/format';
import { defaultPhoneCountry, isValidIntlPhone, normalizeIntlPhone, sanitizeIntlPhoneInput } from '@/lib/phone-countries';
import { PhoneVerificationGate } from '@/features/phone-verification/PhoneVerificationGate';
import { AdminSmsProviderPanel } from '@/features/providers/AdminSmsProviderCard';
import { billingError } from '@/lib/billing-i18n';

const D = new Date('2026-10-09T12:00:00Z');
const config = (regionMode: string) => ({
  branding: null,
  localized: [],
  region: { region_mode: regionMode, active_locales: null, default_locale: null },
  realtime: null,
});

beforeEach(() => {
  localStorage.clear();
  __resetEditionForTests();
  setAppCalendar(null);
  state.data = undefined;
  state.statusCalls = [];
});

describe('src/lib/date.ts — the Persian calendar follows the edition', () => {
  it('Iran (and an unknown edition): Jalali, exactly as before', () => {
    for (const setup of [() => rememberEdition('iran'), () => undefined]) {
      __resetEditionForTests();
      setup();
      expect(getAppCalendar()).toBe('jalali');
      expect(resolveDateLocale('fa')).toBe('fa-IR-u-ca-persian');
      expect(resolveDateLocale('fa-IR')).toBe('fa-IR-u-ca-persian');
      expect(formatDate(D, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }, 'fa')).toContain('۱۴۰۵');
      expect(formatPattern(D, 'yyyy', 'fa')).toBe('1405');
      expect(artDateTag('fa')).toBe('fa-IR-u-ca-persian');
    }
  });

  it('International: Gregorian with Persian digits; other languages unchanged', () => {
    rememberEdition('international');
    expect(getAppCalendar()).toBe('gregorian');
    expect(resolveDateLocale('fa')).toBe('fa-IR-u-ca-gregory');
    // Even a caller that asks for the Persian calendar explicitly.
    expect(resolveDateLocale('fa-IR-u-ca-persian')).toBe('fa-IR-u-ca-gregory');
    const long = formatDate(D, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }, 'fa');
    expect(long).toContain('۲۰۲۶');
    expect(long).not.toContain('۱۴۰۵');
    expect(formatPattern(D, 'yyyy-MM-dd', 'fa')).toMatch(/^2026-10-(09|10)$/);
    expect(formatLongDate(D, 'fa')).toContain('۲۰۲۶');
    expect(resolveDateLocale('en')).toBe('en-US');
    expect(resolveDateLocale('tr')).toBe('tr-TR');
    expect(artDateTag('fa')).toBe('fa-IR-u-ca-gregory');
    expect(artDateTag('en')).toBe('en-US');
  });

  it('an explicit calendar override wins (tests, previews)', () => {
    rememberEdition('international');
    setAppCalendar('jalali');
    expect(resolveDateLocale('fa')).toBe('fa-IR-u-ca-persian');
  });
});

describe('phone input', () => {
  it('Iran (default): Persian UI defaults to Iran — as before', () => {
    expect(defaultPhoneCountry('fa')).toBe('IR');
    expect(defaultPhoneCountry('fa', 'iran')).toBe('IR');
    expect(defaultPhoneCountry('tr', 'iran')).toBe('TR');
    expect(defaultPhoneCountry('en', 'iran')).toBe('GB');
  });

  it('International: never Iran by default', () => {
    expect(defaultPhoneCountry('fa', 'international')).toBe('GB');
    expect(defaultPhoneCountry('tr', 'international')).toBe('TR');
    expect(defaultPhoneCountry('en', 'international')).toBe('GB');
  });

  it('international numbers are kept in E.164', () => {
    expect(sanitizeIntlPhoneInput('+44 7700-900 123')).toBe('+447700900123');
    expect(sanitizeIntlPhoneInput('۰۰۴۴۷۷۰۰۹۰۰۱۲۳')).toBe('00447700900123');
    expect(normalizeIntlPhone('0044 7700 900123')).toBe('+447700900123');
    expect(normalizeIntlPhone('1 202 555 0143')).toBe('+12025550143');
    expect(normalizeIntlPhone('')).toBe('');
    expect(isValidIntlPhone('+447700900123')).toBe(true);
    expect(isValidIntlPhone('+989121234567')).toBe(true);
    expect(isValidIntlPhone('+0123456789')).toBe(false);
    expect(isValidIntlPhone('+12345')).toBe(false);
    expect(isValidIntlPhone('')).toBe(true);
  });
});

describe('SMS phone verification gate', () => {
  it('Iran: the gate asks the server (and waits for it) — as before', () => {
    state.data = config('iran');
    render(
      <PhoneVerificationGate purpose="widget_access" workspaceId="ws-1">
        <p>widget page</p>
      </PhoneVerificationGate>,
    );
    expect(screen.queryByText('widget page')).toBeNull();
    expect(state.statusCalls).toContain(true);
  });

  it.each(['multi', 'global', 'turkey'])('International (%s): never blocks and never asks', (mode) => {
    state.data = config(mode);
    render(
      <PhoneVerificationGate purpose="widget_access" workspaceId="ws-1">
        <p>widget page</p>
      </PhoneVerificationGate>,
    );
    expect(screen.getByText('widget page')).toBeTruthy();
    expect(state.statusCalls.every((enabled) => enabled === false)).toBe(true);
  });
});

describe('Super Admin → Providers → SMS', () => {
  it('International: a neutral "not available" panel, no Iranian vendor', () => {
    state.data = config('multi');
    const { container } = render(<AdminSmsProviderPanel />);
    expect(screen.getByText('adminProviders.smsUnavailable.title')).toBeTruthy();
    expect(container.textContent).not.toMatch(/Kavenegar|SMS\.ir|کاوه/);
  });

  it('Iran: the Kavenegar / SMS.ir card, as before', async () => {
    state.data = config('iran');
    const { container } = render(<AdminSmsProviderPanel />);
    expect(container.querySelector('[data-sms-unavailable]')).toBeNull();
  });
});

describe('billing network-error hint', () => {
  const network = 'fetch failed';
  it('Iran (and unknown): the Persian hint is unchanged', () => {
    expect(billingError('fa', network)).toContain('خارج از ایران');
    rememberEdition('iran');
    expect(billingError('fa', network)).toContain('خارج از ایران');
  });

  it('International: neutral Persian wording; en/tr unchanged', () => {
    const en = billingError('en', network);
    rememberEdition('international');
    expect(billingError('fa', network)).not.toContain('ایران');
    expect(billingError('fa', network)).toContain('کلید API');
    expect(billingError('en', network)).toBe(en);
  });
});
