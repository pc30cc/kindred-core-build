/**
 * The privacy policy and terms of use at /privacy and /terms: the three
 * languages are one text. A section added to the Persian and not to the
 * translations — or an address dropped from one of them — reads as a
 * different promise in each language.
 */
import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES } from '@/i18n/config';
import { LEGAL_DOCUMENTS, LEGAL_LOCALES, LEGAL_DEFAULT_LOCALE } from '@/pages/public/legal/legalDocuments';

const LATIN = '0123456789';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';
const toLatin = (s: string) => s.replace(/[۰-۹]/g, (d) => LATIN[PERSIAN.indexOf(d)]);

describe.each(Object.entries(LEGAL_DOCUMENTS))('%s', (_, byLocale) => {
  const reference = byLocale[LEGAL_DEFAULT_LOCALE];

  it('is written in every language the app speaks', () => {
    expect(Object.keys(byLocale).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(LEGAL_LOCALES.map((l) => l.locale).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it('numbers its sections 1, 2, 3… in each language', () => {
    for (const doc of Object.values(byLocale)) {
      doc.sections.forEach((section, index) => {
        expect(toLatin(section.heading)).toMatch(new RegExp(`^${index + 1}\\. `));
      });
    }
  });

  it('has the same sections and paragraphs in every language', () => {
    for (const doc of Object.values(byLocale)) {
      expect(doc.sections.map((s) => s.paragraphs.length)).toEqual(
        reference.sections.map((s) => s.paragraphs.length),
      );
    }
  });

  it('gives the contact address in the same places in every language', () => {
    const places = (doc: typeof reference) =>
      doc.sections.flatMap((s) => s.paragraphs.map((p) => p.split('{email}').length - 1));
    for (const doc of Object.values(byLocale)) {
      expect(places(doc)).toEqual(places(reference));
    }
    expect(places(reference).some((n) => n > 0)).toBe(true);
  });
});
