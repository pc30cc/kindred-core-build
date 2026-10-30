/**
 * The platform's own help center in the app (app.<brand>/help is the SPA,
 * src/pages/public/kb/*): its head wears the logo the Super Admin uploaded,
 * linked home, as the server-rendered pages do (server/routes/kb.ts,
 * helpCenterBrand). The help center never wore the kit's logo, so without an
 * upload there is nothing, and a customer's help center (the host probe's
 * `platform: false`) never shows the platform's.
 */
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: undefined as unknown, platform: true }));

vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  usePlatformPublicConfig: () => ({ data: state.data }),
  fetchPlatformPublicConfig: () => Promise.resolve(state.data),
}));
vi.mock('@/lib/kb-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/kb-api')>()),
  isPlatformHelpCenter: async () => state.platform,
  fetchKbCategories: async () => [],
  fetchKbArticle: async () => ({ id: 'a', title: 'Start', slug: 'start', content: '<p>x</p>', locale: 'en', updated_at: null }),
  searchKbArticles: async () => [],
}));
vi.mock('@/lib/native', () => ({ isNativePlatform: () => false, getNativePlatform: () => 'web' }));

import HelpIndexPage from '@/pages/public/kb/HelpIndexPage';
import HelpArticlePage from '@/pages/public/kb/HelpArticlePage';
import HelpSearchPage from '@/pages/public/kb/HelpSearchPage';
import { __resetEditionForTests } from '@/lib/edition';

const LOGO = 'https://cdn.example.test/platform/brand/1-logo-light.svg';
const LOGO_DARK = 'https://cdn.example.test/platform/brand/2-logo-dark.svg';
const config = (brandAssets: unknown) => ({
  branding: null,
  localized: [{ locale: 'en', platform_name: 'Acme' }],
  region: { region_mode: 'international', active_locales: null, default_locale: null, site_mode: 'single_language' },
  brand: { edition: 'international', site_url: null, support_email: null },
  brand_assets: brandAssets,
});

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/help/:locale" element={<HelpIndexPage />} />
          <Route path="/help/:locale/a/:slug" element={<HelpArticlePage />} />
          <Route path="/help/:locale/search" element={<HelpSearchPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.data = config({ logo_light: LOGO, logo_dark: LOGO_DARK, symbol: null });
  state.platform = true;
  localStorage.clear();
  __resetEditionForTests();
});

describe('the SPA help center\'s head', () => {
  it.each(['/help/en', '/help/en/a/start', '/help/en/search?q=x'])('the platform\'s own, with an upload: the logo pair, linked home (%s)', async (path) => {
    const { container } = renderAt(path);
    await waitFor(() => expect(container.querySelector('[data-help-brand]')).not.toBeNull());
    const head = container.querySelector('[data-help-brand]') as HTMLAnchorElement;
    expect(head.getAttribute('href')).toBe('/help/en');
    expect([...head.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([LOGO, LOGO_DARK]);
    expect(head.querySelector('img')?.getAttribute('alt')).toBeTruthy();
  });

  it('the platform\'s own without an upload: nothing, as before', async () => {
    state.data = config(null);
    const { container } = renderAt('/help/en');
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-help-brand]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('a customer\'s help center: never the platform\'s logo', async () => {
    state.platform = false;
    const { container } = renderAt('/help/en');
    await waitFor(() => expect(container.querySelector('h1')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-help-brand]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
});
