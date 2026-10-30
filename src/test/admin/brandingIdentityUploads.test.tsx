/**
 * Super Admin → Branding → Visual identity, around the logo uploads
 * (src/components/admin/BrandAssetUploads.tsx, src/pages/admin/BrandingPage.tsx):
 *
 *   - an upload or a reset never throws away the card's edits not saved yet
 *     (the form is not refetched under them), and a save never writes the old
 *     URL fields back;
 *   - the dark logo's row says what dark surfaces wear: the light upload
 *     while no dark one is uploaded, the kit's pair while nothing is; each
 *     tile shows what its surface wears;
 *   - a server error says what can be done about it;
 *   - an address typed before uploads existed is shown, read-only, and can
 *     be cleared.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({
  branding: {} as Record<string, unknown>,
  assets: null as Record<string, unknown> | null,
  calls: [] as Array<{ path: string; method: string; body: unknown }>,
  post: null as null | ((path: string) => unknown),
  toasts: [] as Array<{ title?: string; description?: string }>,
}));

vi.mock('@/hooks/useAdmin', () => ({
  adminFetch: vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    srv.calls.push({ path, method, body });
    if (path === '/api/admin/management/platform-branding' && method === 'GET') return { branding: { ...srv.branding }, assets: srv.assets };
    if (path === '/api/admin/management/platform-branding' && method === 'PUT') {
      srv.branding = { ...srv.branding, ...body, updated_at: `t${srv.calls.length}` };
      return { branding: srv.branding };
    }
    if (path.startsWith('/api/admin/management/platform-branding/assets/')) {
      if (srv.post) return srv.post(path);
      // The route writes the row too: its keys and updated_at change.
      srv.branding = { ...srv.branding, updated_at: `t${srv.calls.length}`, logo_light_storage_key: 'platform/brand/x-logo-light.svg' };
      return { assets: srv.assets };
    }
    return {};
  }),
}));
vi.mock('@/lib/brandRaster', () => ({
  prepareLogoUpload: async () => ({ contentType: 'image/svg+xml', data: 'PHN2Zz4=', png: 'iVBORw0KGgo=' }),
  prepareSymbolUpload: async () => ({ contentType: 'image/png', data: 'iVBORw0KGgo=', icons: {} }),
}));
vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  usePlatformPublicConfig: () => ({ data: { region: { region_mode: 'international' }, brand_assets: null } }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: (t: { title?: string; description?: string }) => { srv.toasts.push(t); } }));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
  useTranslation: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
}));
vi.mock('@/components/admin/EmailTemplatesTab', () => ({ default: () => null }));
vi.mock('@/lib/native', () => ({ isNativePlatform: () => false, getNativePlatform: () => 'web' }));

import AdminBrandingPage from '@/pages/admin/BrandingPage';
import { INTL_BRAND } from '../../../shared/internationalMode';

const CDN = 'https://cdn.example.test/platform/brand';
const ROW = {
  id: 'row-1', logo_url: null, favicon_url: null, pwa_icon_url: null, primary_color: '#3B82F6', secondary_color: '#6366F1',
  pwa_enabled: true, pwa_short_name: null, pwa_background_color: '#ffffff', created_at: null, updated_at: 't0',
};
const uploads = (over: Record<string, unknown> = {}) => ({
  logo_light: null, logo_dark: null, logo_png_light: null, logo_png_dark: null, logo_png_width: null, logo_png_height: null,
  symbol: null, apple_touch_180: null, icon_192: null, icon_512: null, ...over,
});

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
const row = (variant: string) => document.querySelector(`[data-brand-asset="${variant}"]`) as HTMLElement;
const tiles = (variant: string) => [...row(variant).querySelectorAll('img')].map((img) => img.getAttribute('src'));
const upload = (variant: string) => fireEvent.change(row(variant).querySelector('input[type="file"]') as HTMLInputElement, {
  target: { files: [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })] },
});

beforeEach(() => {
  srv.branding = { ...ROW };
  srv.assets = null;
  srv.calls = [];
  srv.post = null;
  srv.toasts = [];
  localStorage.clear();
});

describe('the card keeps what was not saved yet', () => {
  it('an upload leaves the colour edit in place, and Save sends it without the old URL fields', async () => {
    wrap(<AdminBrandingPage />);
    await waitFor(() => expect(row('logo-light')).not.toBeNull());
    const primary = screen.getAllByPlaceholderText('#3B82F6')[0] as HTMLInputElement;
    fireEvent.change(primary, { target: { value: '#112233' } });
    srv.assets = uploads({ logo_light: `${CDN}/a-logo-light.svg` });
    upload('logo-light');
    await waitFor(() => expect(srv.toasts.map((t) => t.title)).toContain('admin.brandingPage.identity.assetSaved'));
    await waitFor(() => expect(tiles('logo-light')[0]).toBe(`${CDN}/a-logo-light.svg`));
    // Not refetched under the edit: the colour and the Save button stay.
    expect(srv.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect((screen.getAllByPlaceholderText('#3B82F6')[0] as HTMLInputElement).value).toBe('#112233');
    const save = screen.getByRole('button', { name: /admin\.brandingPage\.common\.save/ });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(srv.calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = srv.calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>;
    expect(put.primary_color).toBe('#112233');
    for (const field of ['logo_url', 'favicon_url', 'pwa_icon_url']) expect(put, field).not.toHaveProperty(field);
  });
});

describe('the dark logo\'s row', () => {
  it('nothing uploaded: the kit\'s pair, its default named', async () => {
    wrap(<AdminBrandingPage />);
    await waitFor(() => expect(row('logo-dark')).not.toBeNull());
    expect(within(row('logo-dark')).getByText('admin.brandingPage.identity.kitDefault')).toBeTruthy();
    expect(tiles('logo-dark')).toEqual([INTL_BRAND.horizontal.light, INTL_BRAND.horizontal.dark]);
    expect(tiles('logo-light')).toEqual([INTL_BRAND.horizontal.light, INTL_BRAND.horizontal.dark]);
  });

  it('a light logo only: dark surfaces wear it, and the row says so', async () => {
    srv.assets = uploads({ logo_light: `${CDN}/a-logo-light.svg` });
    wrap(<AdminBrandingPage />);
    await waitFor(() => expect(tiles('logo-dark')[0]).toBe(`${CDN}/a-logo-light.svg`));
    expect(within(row('logo-dark')).getByText('admin.brandingPage.identity.usesLightLogo')).toBeTruthy();
    expect(within(row('logo-dark')).queryByText('admin.brandingPage.identity.kitDefault')).toBeNull();
    expect(tiles('logo-dark')).toEqual([`${CDN}/a-logo-light.svg`, `${CDN}/a-logo-light.svg`]);
  });

  it('both uploaded: the light tile wears the light one, the dark tile the dark one', async () => {
    srv.assets = uploads({ logo_light: `${CDN}/a-logo-light.svg`, logo_dark: `${CDN}/b-logo-dark.svg` });
    wrap(<AdminBrandingPage />);
    await waitFor(() => expect(tiles('logo-dark')[1]).toBe(`${CDN}/b-logo-dark.svg`));
    expect(tiles('logo-dark')).toEqual([`${CDN}/a-logo-light.svg`, `${CDN}/b-logo-dark.svg`]);
    expect(tiles('logo-light')).toEqual([`${CDN}/a-logo-light.svg`, `${CDN}/b-logo-dark.svg`]);
    expect(within(row('logo-dark')).queryByText('admin.brandingPage.identity.usesLightLogo')).toBeNull();
  });

  it('a new light logo of another shape: the toast says the dark one was put back', async () => {
    srv.assets = uploads({ logo_light: `${CDN}/a-logo-light.svg`, logo_dark: `${CDN}/b-logo-dark.svg` });
    srv.post = () => ({ assets: uploads({ logo_light: `${CDN}/c-logo-light.svg` }), dark_reset: true });
    wrap(<AdminBrandingPage />);
    await waitFor(() => expect(tiles('logo-light')[0]).toBe(`${CDN}/a-logo-light.svg`));
    upload('logo-light');
    await waitFor(() => expect(srv.toasts).toContainEqual({
      title: 'admin.brandingPage.identity.assetSaved',
      description: 'admin.brandingPage.identity.darkLogoReset',
    }));
  });
});

describe('a refused upload says what can be done', () => {
  it.each([
    ['logo_dark_ratio', 'admin.brandingPage.identity.errorDarkShape'],
    ['global_storage_not_configured', 'admin.brandingPage.identity.errorNoStorage'],
    ['png_wrong_size', 'admin.brandingPage.identity.errorUnreadable'],
  ])('%s', async (code, key) => {
    srv.assets = uploads({ logo_light: `${CDN}/a-logo-light.svg` });
    srv.post = () => { throw new Error(code); };
    wrap(<AdminBrandingPage />);
    await waitFor(() => expect(tiles('logo-dark')[0]).toBe(`${CDN}/a-logo-light.svg`));
    upload('logo-dark');
    await waitFor(() => expect(srv.toasts.map((t) => t.description)).toContain(key));
  });
});

describe('an address typed before uploads existed', () => {
  it('none set: nothing shown', async () => {
    wrap(<AdminBrandingPage />);
    await waitFor(() => expect(row('symbol')).not.toBeNull());
    expect(document.querySelector('[data-legacy-brand-urls]')).toBeNull();
  });

  it('is shown read-only and can be cleared', async () => {
    srv.branding = { ...ROW, favicon_url: 'https://old.example/favicon.ico' };
    wrap(<AdminBrandingPage />);
    await waitFor(() => expect(document.querySelector('[data-legacy-brand-url="favicon_url"]')).not.toBeNull());
    const entry = document.querySelector('[data-legacy-brand-url="favicon_url"]') as HTMLElement;
    expect(entry.textContent).toContain('https://old.example/favicon.ico');
    expect(document.querySelector('[data-legacy-brand-url="logo_url"]')).toBeNull();
    fireEvent.click(within(entry).getByRole('button', { name: /legacyClear/ }));
    await waitFor(() => expect(srv.calls.find((c) => c.method === 'PUT')?.body).toEqual({ favicon_url: null }));
    await waitFor(() => expect(document.querySelector('[data-legacy-brand-urls]')).toBeNull());
  });
});
