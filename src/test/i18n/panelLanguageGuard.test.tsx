/**
 * The dashboard follows the panel's languages (shared/panelLanguages.ts,
 * src/hooks/usePlatformRegion.ts usePanelLanguages): a WebYar (`iran`) panel
 * the Super Admin set to English opens in English, keeps a language someone
 * picked while the switcher offers it, and never touches the languages of
 * what visitors read (still Persian only in `iran`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider, getSiteDefaultLocale, useI18n } from '@/i18n';
import type { Locale } from '@/i18n/config';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';

const h = vi.hoisted(() => ({
  region: null as Record<string, unknown> | null,
  pending: false,
  /** The read fails (a backend redeploy's 503, a network blip). */
  fail: false,
  native: false,
}));

// These tests read which language is active, never its words: the Turkish
// messages are English here, so a switch to Turkish does not import a 580 KB
// module (slow on a loaded runner, and still resolving after a test ends).
vi.mock('@/i18n/locales/tr', async () => ({ default: (await import('@/i18n/locales/en')).default }));

vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  fetchPlatformPublicConfig: () =>
    h.pending
      ? new Promise(() => {})
      : h.fail
        ? Promise.reject(new Error('platform config: HTTP 503'))
        : Promise.resolve({ region: h.region }),
}));

vi.mock('@/lib/native', async (orig) => ({
  ...(await orig<typeof import('@/lib/native')>()),
  isNativePlatform: () => h.native,
}));

import { usePanelLanguages, usePlatformRegion } from '@/hooks/usePlatformRegion';

function Probe() {
  const { locale, setLocale } = useI18n();
  const panel = usePanelLanguages();
  const { allowedLocales, mode } = usePlatformRegion();
  return (
    <div
      data-testid="probe"
      data-locale={locale}
      data-panel={panel.locales.join(',')}
      data-switcher={String(panel.switcher)}
      data-content={allowedLocales.join(',')}
      data-mode={mode}
      data-ready={String(panel.ready)}
    >
      {(['en', 'fa', 'tr'] as const).map((l) => (
        <button key={l} type="button" data-testid={`pick-${l}`} onClick={() => setLocale(l)} />
      ))}
    </div>
  );
}

function mount(initialLocale: Locale) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={initialLocale} initialTranslations={initialLocale === 'fa' ? fa : en}>
        <Probe />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return Object.assign(r, { client });
}

const probe = (r: ReturnType<typeof render>) => r.getByTestId('probe');
// Switching language imports that locale's module, which can take seconds
// on a loaded CI runner.
const WAIT = { timeout: 10_000 };
// A language switch makes I18nProvider render nothing while the new
// language loads; a read after a waitFor waits for the probe to be back.
const now = (r: ReturnType<typeof render>) => waitFor(() => r.getByTestId('probe'), WAIT);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
const REGION_QUERY = { queryKey: ['platform_region_settings'] };

beforeEach(() => {
  localStorage.clear();
  h.region = null;
  h.pending = false;
  h.fail = false;
  h.native = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the panel language guard', () => {
  it('WebYar set to English with the switcher hidden: a browser on Persian opens English, and nothing is kept as a choice', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'single_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.locale).toBe('en'), WAIT);
    expect((await now(r)).dataset.panel).toBe('en');
    expect((await now(r)).dataset.switcher).toBe('false');
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it('a choice the panel no longer offers is forgotten', async () => {
    localStorage.setItem('app-locale', 'fa');
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'single_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.locale).toBe('en'), WAIT);
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it('with the switcher shown, a language someone picked is kept', async () => {
    localStorage.setItem('app-locale', 'fa');
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'), WAIT);
    expect((await now(r)).dataset.locale).toBe('fa');
    expect((await now(r)).dataset.panel).toBe('fa,en');
    expect((await now(r)).dataset.switcher).toBe('true');
    expect(localStorage.getItem('app-locale')).toBe('fa');
  });

  it('with the switcher shown, a browser where nobody picked follows the default', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'tr'], default_locale: 'tr', site_mode: 'multi_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.locale).toBe('tr'), WAIT);
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it("the panel's languages never open the visitors' languages: Iran's content stays Persian", async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' };
    const r = mount('en');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'), WAIT);
    expect((await now(r)).dataset.panel).toBe('fa,en');
    expect((await now(r)).dataset.content).toBe('fa');
    expect((await now(r)).dataset.locale).toBe('en');
  });

  it("WebYar's settings today (Persian only) keep a Persian panel", async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'), WAIT);
    expect((await now(r)).dataset.locale).toBe('fa');
    expect((await now(r)).dataset.switcher).toBe('false');
  });

  it('a failed first read changes nothing: WebYar (cached iran) stays Persian on its cached guess', async () => {
    localStorage.setItem('platform-region-mode', 'iran');
    h.fail = true;
    const r = mount('fa');
    await waitFor(() => expect(r.client.getQueryState(REGION_QUERY.queryKey)?.status).toBe('error'), WAIT);
    await settle();
    expect((await now(r)).dataset.ready).toBe('false');
    expect((await now(r)).dataset.locale).toBe('fa');
    // The cached guess: a Persian panel without a switcher, as WebYar's settings read.
    expect((await now(r)).dataset.panel).toBe('fa');
    expect((await now(r)).dataset.switcher).toBe('false');
    expect(localStorage.getItem('app-locale')).toBeNull();
    // Visitors' languages and the region are the cached ones, never a made-up `multi`.
    expect((await now(r)).dataset.content).toBe('fa');
    expect((await now(r)).dataset.mode).toBe('iran');
    expect(localStorage.getItem('platform-region-mode')).toBe('iran');
  });

  it('a failed refetch after a good read keeps the good settings', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' };
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'), WAIT);
    h.fail = true;
    await act(async () => {
      await r.client.refetchQueries(REGION_QUERY);
    });
    expect(r.client.getQueryState(REGION_QUERY.queryKey)?.status).toBe('error');
    await settle();
    expect((await now(r)).dataset.ready).toBe('true');
    expect((await now(r)).dataset.locale).toBe('fa');
    expect((await now(r)).dataset.panel).toBe('fa');
    expect((await now(r)).dataset.switcher).toBe('false');
    expect((await now(r)).dataset.content).toBe('fa');
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it('a pick holds for the session when the browser cannot store it', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa', site_mode: 'multi_language' };
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'app-locale') throw new DOMException('quota', 'QuotaExceededError');
      setItem.call(this, key, value);
    });
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'), WAIT);
    fireEvent.click(r.getByTestId('pick-en'));
    await settle();
    expect((await now(r)).dataset.locale).toBe('en');
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it('with no storage at all, a pick the panel stops offering still gives way', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa', site_mode: 'multi_language' };
    // Every write fails, the region's cache included: the settings still apply.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const r = mount('fa');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'), WAIT);
    fireEvent.click(r.getByTestId('pick-en'));
    await settle();
    expect((await now(r)).dataset.locale).toBe('en');
    h.region = { region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' };
    await act(async () => {
      await r.client.refetchQueries(REGION_QUERY);
    });
    await waitFor(() => expect(probe(r).dataset.locale).toBe('fa'), WAIT);
  });

  it('the native app: a language outside the panel gives way to the default, which is kept', async () => {
    h.native = true;
    h.region = { region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' };
    const r = mount('en');
    await waitFor(() => expect(probe(r).dataset.locale).toBe('fa'), WAIT);
    expect(localStorage.getItem('app-locale')).toBe('fa');
  });

  it('the native app does not follow the default when nobody picked: English stays while the panel offers it', async () => {
    h.native = true;
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa', site_mode: 'multi_language' };
    const r = mount('en');
    await waitFor(() => expect(probe(r).dataset.ready).toBe('true'), WAIT);
    await settle();
    expect((await now(r)).dataset.locale).toBe('en');
    expect(localStorage.getItem('app-locale')).toBeNull();
  });

  it('changes nothing before the platform settings arrive', async () => {
    localStorage.setItem('platform-region-mode', 'iran');
    h.pending = true;
    const r = mount('en');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await now(r)).dataset.ready).toBe('false');
    expect((await now(r)).dataset.locale).toBe('en');
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
