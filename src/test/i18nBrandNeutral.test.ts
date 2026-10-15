/**
 * The locale texts ship in every client build, the RESPOK one included
 * (scripts/build/brandAudit.mjs), so none may name the Iran region's brand or
 * its domains. Where the Iranian edition needs its name, a text carries a
 * brand token ({{brand}}, {{brandLatin}}, …, shared/brand.ts) or a parameter
 * its component fills per edition (e.g. {{iosDir}},
 * src/components/admin/mobile/iosProjectText.ts).
 */
import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { IRAN_BRAND_PATTERNS } from '../../scripts/build/brandAudit.mjs';
import { brandTokensFor, fillBrandTokens } from '../../shared/brand';
import { iosProjectText } from '@/components/admin/mobile/iosProjectText';

function* strings(value: unknown, path: string[] = []): Generator<[string, string]> {
  if (typeof value === 'string') {
    yield [path.join('.'), value];
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* strings(v, [...path, k]);
  }
}

const LOCALES = { en, fa, tr } as const;
const brandHits = (text: string) => IRAN_BRAND_PATTERNS.some((re: RegExp) => re.test(text));

describe('locale texts never name the Iran brand', () => {
  it.each(Object.keys(LOCALES) as Array<keyof typeof LOCALES>)('%s: raw values', (locale) => {
    const offenders = [...strings(LOCALES[locale])]
      .filter(([, text]) => brandHits(text))
      .map(([key, text]) => `${key}: ${text}`);
    expect(offenders).toEqual([]);
  });

  it.each(Object.keys(LOCALES) as Array<keyof typeof LOCALES>)('%s: filled for the International edition', (locale) => {
    const tokens = brandTokensFor('international', locale, {
      names: { en: 'RESPOK' }, siteUrl: 'https://respok.app', supportEmail: 'support@respok.app',
    });
    const ios = iosProjectText('international');
    const offenders = [...strings(LOCALES[locale])]
      .map(([key, text]): [string, string] => [
        key,
        Object.entries(ios).reduce((t, [k, v]) => t.split(`{{${k}}}`).join(v), fillBrandTokens(text, tokens)),
      ])
      .filter(([, text]) => brandHits(text))
      .map(([key, text]) => `${key}: ${text}`);
    expect(offenders).toEqual([]);
  });
});

describe('iOS project names per edition', () => {
  it('Iran (and an unknown edition) reads the project exactly as before', () => {
    for (const edition of ['iran', null] as const) {
      expect(iosProjectText(edition)).toEqual({
        iosDir: 'ios/Webyar', iosProject: 'Webyar.xcodeproj', iosScheme: 'Webyar', urlSchemeExample: 'webyar',
      });
    }
    expect(fillBrandTokens(en.admin.mobileApp.privacy.manifestPreview, brandTokensFor('iran', 'en')).split('{{iosDir}}').join('ios/Webyar'))
      .toBe('The app’s privacy manifest (ios/Webyar/Resources/PrivacyInfo.xcprivacy)');
  });

  it('the International edition never names the Iran brand', () => {
    const text = Object.values(iosProjectText('international')).join(' ');
    expect(brandHits(text)).toBe(false);
  });
});
