/**
 * The international phone number field: every country with a flag, search
 * in any interface language, the detected default, and the E.164 value.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import {
  DIAL_COUNTRIES,
  countryOfInternationalNumber,
  dialCountry,
  isPossibleNational,
  toE164,
} from '@/lib/dialCountries';
import { countryOfLanguageTags, countryOfTimeZone, detectPhoneCountry } from '@/lib/phoneCountryDefault';
import { PhoneNumberField } from '@/components/phone/PhoneNumberField';
import { buildCountryEntries, filterCountryEntries, foldForSearch } from '@/lib/countrySearch';

const LABELS = { search: 'search', noResults: 'none', suggested: 'suggested', all: 'all', chooseCountry: 'choose' };

// cmdk measures its list; jsdom has no ResizeObserver or scrollIntoView.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('the country table', () => {
  it('lists every country once, each with a flag image', () => {
    expect(DIAL_COUNTRIES.length).toBeGreaterThanOrEqual(240);
    expect(new Set(DIAL_COUNTRIES.map((c) => c.code)).size).toBe(DIAL_COUNTRIES.length);
    for (const c of DIAL_COUNTRIES) {
      expect(c.code).toMatch(/^[A-Z]{2}$/);
      expect(c.dial).toMatch(/^[1-9]\d{0,2}$/);
      expect(existsSync(resolve(process.cwd(), `public/flags/${c.code}.svg`))).toBe(true);
    }
  });

  it('has the right calling codes and trunk rules', () => {
    expect(dialCountry('TR')).toMatchObject({ dial: '90', trunkZero: true });
    expect(dialCountry('GB')).toMatchObject({ dial: '44', trunkZero: true });
    expect(dialCountry('US')).toMatchObject({ dial: '1', trunkZero: false });
    // Italian numbers keep their leading 0.
    expect(dialCountry('IT')).toMatchObject({ dial: '39', trunkZero: false });
  });

  it('builds E.164 without the trunk 0, and checks the length', () => {
    const tr = dialCountry('TR')!;
    expect(toE164(tr, '0530 123 45 83')).toBe('+905301234583');
    expect(toE164(tr, '530-123-4583')).toBe('+905301234583');
    expect(toE164(tr, '۵۳۰۱۲۳۴۵۸۳')).toBe('+905301234583');
    expect(isPossibleNational(tr, '530 123 45 83')).toBe(true);
    expect(isPossibleNational(tr, '530 12')).toBe(false);
    expect(toE164(dialCountry('IT')!, '06 1234 5678')).toBe('+390612345678');
    expect(toE164(tr, '')).toBe('');
  });

  it('finds the country of a pasted international number, preferring the main plan of a shared code', () => {
    expect(countryOfInternationalNumber('+905301234583')?.code).toBe('TR');
    expect(countryOfInternationalNumber('+447700900123')?.code).toBe('GB');
    expect(countryOfInternationalNumber('+12025550123')?.code).toBe('US');
    expect(countryOfInternationalNumber('+12025550123', 'CA')?.code).toBe('CA');
    expect(countryOfInternationalNumber('+971501234567')?.code).toBe('AE');
  });
});

describe('search', () => {
  const en = buildCountryEntries('en');
  const fa = buildCountryEntries('fa');

  it('folds accents, dotless i and Arabic letter forms', () => {
    expect(foldForSearch('Türkiye')).toBe('turkiye');
    expect(foldForSearch('İstanbul')).toBe('istanbul');
    expect(foldForSearch('كويت')).toBe(foldForSearch('کویت'));
  });

  it('by name, English name, ISO code or calling code', () => {
    expect(filterCountryEntries(en, 'turk')[0].country.code).toBe('TR');
    expect(filterCountryEntries(en, 'united king')[0].country.code).toBe('GB');
    expect(filterCountryEntries(en, '+90')[0].country.code).toBe('TR');
    expect(filterCountryEntries(en, '0090')[0].country.code).toBe('TR');
    expect(filterCountryEntries(en, '44')[0].country.code).toBe('GB');
    expect(filterCountryEntries(en, 'de').some((e) => e.country.code === 'DE')).toBe(true);
    // A Persian interface still finds countries by their English name.
    expect(filterCountryEntries(fa, 'germany')[0].country.code).toBe('DE');
    expect(filterCountryEntries(en, 'zzzz')).toHaveLength(0);
  });
});

describe('the country the field opens on', () => {
  it('maps time zones and language regions', () => {
    expect(countryOfTimeZone('Europe/Istanbul')).toBe('TR');
    expect(countryOfTimeZone('Asia/Istanbul')).toBe('TR');
    expect(countryOfTimeZone('Europe/London')).toBe('GB');
    expect(countryOfTimeZone('Mars/Base')).toBeNull();
    expect(countryOfLanguageTags(['en-GB', 'en'])).toBe('GB');
    expect(countryOfLanguageTags(['tr-TR'])).toBe('TR');
    expect(countryOfLanguageTags(['zh-Hant-TW'])).toBe('TW');
    expect(countryOfLanguageTags(['en'])).toBeNull();
  });

  it('remembered pick first, then the time zone; never Iran in the International edition', () => {
    const tz = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'Europe/Istanbul' } as never);
    expect(detectPhoneCountry('en', 'international')).toBe('TR');
    window.localStorage.setItem('phone-field-country', 'DE');
    expect(detectPhoneCountry('en', 'international')).toBe('DE');
    window.localStorage.setItem('phone-field-country', 'IR');
    tz.mockReturnValue({ timeZone: 'Asia/Tehran' } as never);
    expect(detectPhoneCountry('en', 'international')).not.toBe('IR');
    tz.mockRestore();
  });
});

function Harness({ initial = 'GB', onValue }: { initial?: string; onValue?: (v: string) => void }) {
  const [country, setCountry] = useState(initial);
  const [national, setNational] = useState('');
  const c = dialCountry(country)!;
  onValue?.(toE164(c, national));
  return (
    <PhoneNumberField
      country={country}
      national={national}
      onCountryChange={setCountry}
      onNationalChange={setNational}
      locale="en"
      labels={LABELS}
      suggested={['TR']}
    />
  );
}

describe('the field', () => {
  it('shows the flag and calling code, and the country\'s example as placeholder', () => {
    render(<Harness initial="TR" />);
    const trigger = screen.getByTestId('phone-country-trigger');
    expect(trigger).toHaveTextContent('+90');
    expect(trigger.querySelector('img')?.getAttribute('src')).toBe('/flags/TR.svg');
    expect(screen.getByTestId('phone-national-input').getAttribute('placeholder')).toMatch(/\d/);
  });

  it('a pasted international number switches the country', () => {
    let value = '';
    render(<Harness initial="GB" onValue={(v) => { value = v; }} />);
    fireEvent.change(screen.getByTestId('phone-national-input'), { target: { value: '+90 530 123 45 83' } });
    expect(screen.getByTestId('phone-country-trigger')).toHaveTextContent('+90');
    expect(value).toBe('+905301234583');
  });

  it('opens a searchable list and picks a country', async () => {
    render(<Harness initial="GB" />);
    await act(async () => { fireEvent.click(screen.getByTestId('phone-country-trigger')); });
    const search = await screen.findByTestId('phone-country-search');
    await act(async () => { fireEvent.change(search, { target: { value: 'germ' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('phone-country-option-DE')); });
    expect(screen.getByTestId('phone-country-trigger')).toHaveTextContent('+49');
    expect(window.localStorage.getItem('phone-field-country')).toBe('DE');
  });
});
