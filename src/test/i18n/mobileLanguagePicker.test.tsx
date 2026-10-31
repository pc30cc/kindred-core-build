/**
 * The native (Capacitor) app's language pickers, on its sign-in screen and
 * in Settings, offer only the panel's languages (shared/panelLanguages.ts)
 * and are hidden when the Super Admin hid the switcher or there is one
 * language: WebYar's settings today (Persian only) show no picker, RESPOK's
 * (English and Turkish) show those two.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';

const h = vi.hoisted(() => ({
  region: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  fetchPlatformPublicConfig: () => Promise.resolve({ region: h.region }),
}));
vi.mock('@/lib/native', async (orig) => ({
  ...(await orig<typeof import('@/lib/native')>()),
  isNativePlatform: () => true,
}));
vi.mock('@/features/auth/AuthContext', () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn(), signOut: vi.fn() }),
}));
vi.mock('@/hooks/usePublicBranding', () => ({ usePlatformBrandingForLocale: () => null }));
vi.mock('@/components/brand/BrandLogo', () => ({ BrandImage: () => null }));
vi.mock('@/hooks/useProfile', () => ({ useProfile: () => ({ data: null }) }));
vi.mock('@/components/ui/operator-avatar', () => ({ OperatorAvatar: () => null }));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }));

import MobileLoginPage from '@/mobile/MobileLoginPage';
import MobileSettingsPage from '@/mobile/MobileSettingsPage';

const LABELS = ['English', 'Türkçe', 'فارسی'];

function mount(page: 'login' | 'settings') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <MemoryRouter initialEntries={[page === 'login' ? '/auth/login' : '/acme/settings']}>
          <Routes>
            <Route path="/auth/login" element={<MobileLoginPage />} />
            <Route path="/:slug/settings" element={<MobileSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const shown = (r: ReturnType<typeof render>) => LABELS.filter((label) => r.queryByText(label));

beforeEach(() => {
  localStorage.clear();
  h.region = null;
});

describe.each(['login', 'settings'] as const)('the native %s language picker', (page) => {
  it("RESPOK's settings: English and Turkish only", async () => {
    h.region = { region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' };
    const r = mount(page);
    await waitFor(() => expect(shown(r)).toEqual(['English', 'Türkçe']));
  });

  it("WebYar's settings (Persian only, no switcher): no picker", async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' };
    const r = mount(page);
    // The app, which opens in English, switches to the panel's language and keeps it.
    await waitFor(() => expect(localStorage.getItem('app-locale')).toBe('fa'));
    // The screen again, in Persian once its texts have loaded.
    const title = page === 'login' ? fa.auth.loginTitle : fa.nav.settings;
    await waitFor(() => expect(r.getAllByText(title).length).toBeGreaterThan(0));
    expect(shown(r)).toEqual([]);
  });

  it('the switcher hidden: no picker, whatever the languages', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'single_language' };
    const r = mount(page);
    await waitFor(() => expect(shown(r)).toEqual([]));
  });
});
