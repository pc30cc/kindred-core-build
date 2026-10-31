/**
 * I18nProvider drops a language load that finishes after a newer switch:
 * two switches in a row (a Super Admin's new default, then a pick) must end
 * on the newer language's words, never the slower chunk's.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, useI18n } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';

// The Turkish chunk arrives late.
vi.mock('@/i18n/locales/tr', async () => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { default: { ...(await import('@/i18n/locales/en')).default, common: { ...(await import('@/i18n/locales/en')).default.common, save: 'KAYDET-TR' } } };
});

let api: ReturnType<typeof useI18n> | null = null;
function Probe() {
  api = useI18n();
  return <div data-testid="probe" data-locale={api.locale}>{api.t('common.save' as never)}</div>;
}

describe('a late language load', () => {
  it('is dropped when a newer switch came first', async () => {
    render(
      <I18nProvider initialLocale="fa" initialTranslations={fa}>
        <Probe />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('probe')).toBeTruthy());
    act(() => api!.setLocale('tr'));
    act(() => api!.setLocale('en'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    const probe = await screen.findByTestId('probe');
    expect(probe.dataset.locale).toBe('en');
    expect(probe.textContent).toBe(en.common.save);
    expect(probe.textContent).not.toBe('KAYDET-TR');
  });
});
