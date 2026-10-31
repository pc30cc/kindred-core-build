/**
 * The dashboard follows the panel's languages (shared/panelLanguages.ts,
 * src/hooks/usePlatformRegion.ts usePanelLanguages): a WebYar (`iran`) panel
 * the Super Admin set to English opens in English, keeps a language someone
 * picked while the switcher offers it, and never touches the languages of
 * what visitors read (still Persian only in `iran`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, getSiteDefaultLocale, useI18n } from '@/i18n';
import type { Locale } from '@/i18n/config';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';

const h = vi.hoisted(() => ({
  region: null as Record<string, unknown> | null,
  pending: false,
}));

vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  fetchPlatformPublicConfig: () => (h.pending ? new Promise(() => {}) : Promise.resolve({ region: h.region })),
}));

import { usePanelLanguages, usePlatformRegion } from '@/hooks/usePlatformRegion';

function Probe() {
  const { locale } = useI18n();
  const panel = usePanelLanguages();
  const { allowedLocales } = usePlatformRegion();
  return (
    <div
      data-testid="probe"
      data-locale={locale}
      data-panel={panel.locales.join(',')}
      data-switcher={String(panel.switcher)}
      data-content={allowedLocales.join(',')}
      data-ready={String(panel.ready)}
    />
  );
}

function mount(initialLocale: Locale) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider initialLocale={initialLocale} initialTranslations={initialLocale === 'fa' ? fa : en}>
        <Probe />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const probe = (r: ReturnType<typeof render>) => r.getByTestId('probe');

beforeEach(() => {
  localStorage.clear();
  h.region = null;
  h.pending = false;
});

describe('the panel language guard', () => {
  it('WebYar set to English with the switcher hidden: a browser on Persian opens English, and nothing is kept as a choice', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'single_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.locale).toBe('en'));
    expect(probe(r).dataset.panel).toBe('en');
    expect(probe(r).dataset.switcher).toBe('false');
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it('a choice the panel no longer offers is forgotten', async () => {
    localStorage.setItem('app-locale', 'fa');
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'single_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.locale).toBe('en'));
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it('with the switcher shown, a language someone picked is kept', async () => {
    localStorage.setItem('app-locale', 'fa');
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'));
    expect(probe(r).dataset.locale).toBe('fa');
    expect(probe(r).dataset.panel).toBe('fa,en');
    expect(probe(r).dataset.switcher).toBe('true');
    expect(localStorage.getItem('app-locale')).toBe('fa');
  });

  it('with the switcher shown, a browser where nobody picked follows the default', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'tr'], default_locale: 'tr', site_mode: 'multi_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.locale).toBe('tr'));
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it("the panel's languages never open the visitors' languages: Iran's content stays Persian", async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' };
    const r = mount('en');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'));
    expect(probe(r).dataset.panel).toBe('fa,en');
    expect(probe(r).dataset.content).toBe('fa');
    expect(probe(r).dataset.locale).toBe('en');
  });

  it("WebYar's settings today (Persian only) keep a Persian panel", async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'));
    expect(probe(r).dataset.locale).toBe('fa');
    expect(probe(r).dataset.switcher).toBe('false');
  });

  it('changes nothing before the platform settings arrive', async () => {
    localStorage.setItem('platform-region-mode', 'iran');
    h.pending = true;
    const r = mount('en');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(probe(r).dataset.ready).toBe('false');
    expect(probe(r).dataset.locale).toBe('en');
    expect(localStorage.getItem('app-locale')).toBeNull();
  });
});

describe("the first paint's language", () => {
  it("the Iranian edition opens in the panel's default once this browser knows it", () => {
    localStorage.setItem('wy-edition', 'iran');
    localStorage.setItem('wy-default-locale', 'en');
    expect(getSiteDefaultLocale()).toBe('en');
    localStorage.setItem('wy-default-locale', 'tr');
    expect(getSiteDefaultLocale()).toBe('tr');
  });

  it("the International edition never opens in the deployment file's Persian", () => {
    (window as Window & { __APP_RUNTIME_CONFIG__?: Record<string, unknown> }).__APP_RUNTIME_CONFIG__ = { defaultLocale: 'fa' };
    localStorage.setItem('wy-edition', 'international');
    expect(getSiteDefaultLocale()).toBe('en');
    localStorage.setItem('wy-default-locale', 'tr');
    expect(getSiteDefaultLocale()).toBe('tr');
    delete (window as Window & { __APP_RUNTIME_CONFIG__?: unknown }).__APP_RUNTIME_CONFIG__;
  });

  it("before that, the deployment file's language, as before", () => {
    (window as Window & { __APP_RUNTIME_CONFIG__?: Record<string, unknown> }).__APP_RUNTIME_CONFIG__ = { defaultLocale: 'fa' };
    localStorage.setItem('wy-edition', 'iran');
    expect(getSiteDefaultLocale()).toBe('fa');
    localStorage.removeItem('wy-edition');
    localStorage.setItem('wy-default-locale', 'en');
    expect(getSiteDefaultLocale()).toBe('fa');
    delete (window as Window & { __APP_RUNTIME_CONFIG__?: unknown }).__APP_RUNTIME_CONFIG__;
  });
});
