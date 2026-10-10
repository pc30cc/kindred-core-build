/**
 * The real translator fills every occurrence of a value: the billing note
 * "renew before {{date}} … moves to Free on {{date}}" names the date twice,
 * in every language.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider, useTranslation } from '@/i18n';
import type { Locale } from '@/i18n/config';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

vi.mock('../../../lib/api', () => ({ API_BASE: 'http://x' }));

function Note() {
  const { t } = useTranslation();
  return <p data-testid="note">{t('billing.account.picker.scheduleNeedsRenewal', { date: 'D-DAY' })}</p>;
}

describe('billing texts through the real translator', () => {
  for (const [locale, messages] of [['en', en], ['fa', fa], ['tr', tr]] as const) {
    it(`${locale}: both dates of the renewal note are filled`, () => {
      render(
        <I18nProvider initialLocale={locale as Locale} initialTranslations={messages}>
          <Note />
        </I18nProvider>,
      );
      const text = screen.getByTestId('note').textContent ?? '';
      expect(text).not.toContain('{{');
      expect(text.split('D-DAY')).toHaveLength(3);
    });
  }
});
