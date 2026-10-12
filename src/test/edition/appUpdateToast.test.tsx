/**
 * The "new version available" toast (src/lib/pwa.ts) is in the page's
 * current language, and follows a language switch while it is open.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { I18nProvider, useI18n } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import { Toaster } from '@/components/ui/toaster';
import { toast } from '@/hooks/use-toast';
import { AppUpdateAction, AppUpdateDescription, AppUpdateTitle } from '@/components/common/AppUpdateToast';

let switchTo: ((l: 'en' | 'fa') => void) | null = null;
function LocaleSwitch() {
  const { setLocale } = useI18n();
  switchTo = setLocale;
  return null;
}

function showUpdateToast() {
  act(() => {
    toast({
      // `title` is typed `string` (Radix's HTML attribute); the Toaster renders any node.
      title: createElement(AppUpdateTitle) as never,
      description: createElement(AppUpdateDescription),
      duration: Infinity,
      action: createElement(AppUpdateAction, { onClick: () => {} }) as never,
    });
  });
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('app update toast language', () => {
  it('reads English on an English page even when Persian was stored', () => {
    localStorage.setItem('app-locale', 'fa');
    render(<I18nProvider initialLocale="en" initialTranslations={en}><Toaster /></I18nProvider>);
    showUpdateToast();
    expect(screen.getByText(en.appUpdate.title)).toBeTruthy();
    expect(screen.getByText(en.appUpdate.description)).toBeTruthy();
    expect(screen.getByText(en.appUpdate.refresh)).toBeTruthy();
    expect(screen.queryByText(fa.appUpdate.title)).toBeNull();
  });

  it('reads Persian on a Persian page and follows a switch to English', async () => {
    render(<I18nProvider initialLocale="fa" initialTranslations={fa}><LocaleSwitch /><Toaster /></I18nProvider>);
    showUpdateToast();
    expect(screen.getByText(fa.appUpdate.title)).toBeTruthy();
    expect(screen.getByText(fa.appUpdate.refresh)).toBeTruthy();
    await act(async () => { switchTo!('en'); });
    expect(await screen.findByText(en.appUpdate.title)).toBeTruthy();
    expect(screen.getByText(en.appUpdate.refresh)).toBeTruthy();
    expect(screen.queryByText(fa.appUpdate.title)).toBeNull();
  });
});
