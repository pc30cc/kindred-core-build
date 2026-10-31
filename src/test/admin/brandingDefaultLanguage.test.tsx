/**
 * Super Admin → Branding → General → Default language (owner, 2026-10-31:
 * "I pick a language for WebYar and it does not become the default").
 *
 *   - every language the dashboard is translated into can be picked as the
 *     default; one that is not active is turned on with it, so the choice
 *     always takes;
 *   - saving a new default forgets the Super Admin's own earlier pick, so
 *     the panel guard moves their dashboard to it once the new settings are
 *     read (switching before would be undone by the old ones), and says so,
 *     in the words that fit the switcher being shown or hidden;
 *   - in Multi the list keeps to the active languages (they are the
 *     visitors' too); a language turned on for a default picked and then
 *     changed before saving goes off again;
 *   - a save that leaves the default as it was changes nobody's language.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  puts: [] as Array<Record<string, unknown>>,
  setLocale: vi.fn(),
  toasts: [] as Array<{ title?: string; description?: string }>,
}));

vi.mock('@/hooks/useAdmin', () => ({
  adminFetch: vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    if (path === '/api/admin/management/platform-settings') {
      if (method === 'PUT') {
        srv.puts.push(JSON.parse(String(options?.body)));
        return {};
      }
      return { settings: { ...srv.settings } };
    }
    if (path === '/api/admin/management/platform-branding-localized') return { branding: [] };
    return {};
  }),
}));
vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  usePlatformPublicConfig: () => ({ data: { region: { region_mode: 'iran' }, brand_assets: null } }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: (t: { title?: string; description?: string }) => srv.toasts.push(t) }));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'fa', dir: 'rtl', t: (key: string) => key, setLocale: srv.setLocale }),
  useTranslation: () => ({ locale: 'fa', dir: 'rtl', t: (key: string) => key }),
}));
vi.mock('@/lib/native', () => ({ isNativePlatform: () => false, getNativePlatform: () => 'web' }));
vi.mock('@/components/admin/EmailTemplatesTab', () => ({ default: () => null }));
// Native <select>s in place of Radix's, which jsdom cannot open.
vi.mock('@/components/ui/select', () => ({
  Select: ({ value, onValueChange, disabled, children }: { value: string; onValueChange: (v: string) => void; disabled?: boolean; children: ReactNode }) => (
    <select data-testid="select" value={value} disabled={disabled} onChange={(e) => onValueChange(e.target.value)}>{children}</select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => <option value={value}>{children}</option>,
}));

const AdminBrandingPage = (await import('@/pages/admin/BrandingPage')).default;

const K = 'admin.brandingPage.settings';
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });

async function openGeneral(settings: Record<string, unknown>) {
  srv.settings = { timezone: 'UTC', maintenance_mode: false, ...settings };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminBrandingPage /></QueryClientProvider>);
  openTab('admin.brandingPage.tabs.settings');
  await waitFor(() => expect(screen.getByRole('tab', { name: `${K}.tabs.languages` })).toBeInTheDocument());
  openTab(`${K}.tabs.general`);
  return client;
}

/** The General tab's first select is the default language. */
const defaultSelect = () => screen.getAllByTestId('select')[0] as HTMLSelectElement;
const save = async () => {
  fireEvent.click(screen.getByRole('button', { name: /admin\.brandingPage\.common\.save/ }));
  await waitFor(() => expect(srv.puts).toHaveLength(1));
  return srv.puts[0];
};

beforeEach(() => {
  // The page keeps its tabs for the session (useSessionTab): each test starts on the first.
  sessionStorage.clear();
  srv.puts = [];
  srv.toasts = [];
  srv.setLocale.mockReset();
});

describe('the default language', () => {
  it('offers every language the dashboard is translated into, the active ones first', async () => {
    await openGeneral({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' });
    expect([...defaultSelect().options].map((o) => o.value)).toEqual(['fa', 'en', 'tr']);
  });

  it('picking one that is not active turns it on, so it can be the default', async () => {
    await openGeneral({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' });
    fireEvent.change(defaultSelect(), { target: { value: 'tr' } });
    const put = await save();
    expect(put).toMatchObject({ default_locale: 'tr', active_locales: ['fa', 'tr'] });
  });

  it("saving a new default forgets the Super Admin's own pick (the guard then moves them) and says so", async () => {
    await openGeneral({ region_mode: 'iran', active_locales: ['fa', 'tr', 'en'], default_locale: 'fa', site_mode: 'multi_language' });
    fireEvent.change(defaultSelect(), { target: { value: 'en' } });
    await save();
    // The page stays in its language until the guard reads the new default.
    expect(srv.setLocale).toHaveBeenCalledWith('fa', { remember: false });
    await waitFor(() => expect(srv.toasts.at(-1)?.description).toBe(`${K}.general.defaultApplied`));
  });

  it("the saved settings go straight to the panel guard's cache, so a failed re-read cannot bring the old default back", async () => {
    const client = await openGeneral({ region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa', site_mode: 'multi_language' });
    fireEvent.change(defaultSelect(), { target: { value: 'en' } });
    await save();
    await waitFor(() =>
      expect(client.getQueryData(['platform_region_settings'])).toMatchObject({
        mode: 'iran',
        activeLocales: ['fa', 'en'],
        defaultLocale: 'en',
        siteMode: 'multi_language',
      }),
    );
  });

  it('the page comes back on the tab it was on when the app re-mounts for the new language', async () => {
    await openGeneral({ region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa', site_mode: 'multi_language' });
    openTab(`${K}.tabs.languages`);
    cleanup();
    render(<QueryClientProvider client={new QueryClient()}><AdminBrandingPage /></QueryClientProvider>);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: `${K}.tabs.languages` })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getByRole('tab', { name: 'admin.brandingPage.tabs.settings' })).toHaveAttribute('aria-selected', 'true');
  });

  it('with the switcher hidden, the toast says everyone sees the new default', async () => {
    await openGeneral({ region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'fa', site_mode: 'single_language' });
    fireEvent.change(defaultSelect(), { target: { value: 'en' } });
    await save();
    await waitFor(() => expect(srv.toasts.at(-1)?.description).toBe(`${K}.general.defaultAppliedAll`));
  });

  it('Multi: only the active languages are offered (they are the visitors\' too)', async () => {
    await openGeneral({ region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' });
    expect([...defaultSelect().options].map((o) => o.value)).toEqual(['en', 'tr']);
  });

  it('a language turned on for a default picked and then changed before saving goes off again', async () => {
    await openGeneral({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' });
    fireEvent.change(defaultSelect(), { target: { value: 'tr' } });
    fireEvent.change(defaultSelect(), { target: { value: 'en' } });
    const put = await save();
    expect(put).toMatchObject({ default_locale: 'en', active_locales: ['fa', 'en'] });
  });

  it("a save that keeps the default changes nobody's language", async () => {
    await openGeneral({ region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' });
    fireEvent.change(screen.getByPlaceholderText('UTC'), { target: { value: 'Asia/Tehran' } });
    await save();
    expect(srv.setLocale).not.toHaveBeenCalled();
    expect(srv.toasts.at(-1)?.description).toBeUndefined();
  });

  it('Türkiye keeps its one language: nothing else is offered', async () => {
    await openGeneral({ region_mode: 'turkey', active_locales: ['tr'], default_locale: 'tr', site_mode: 'single_language' });
    expect([...defaultSelect().options].map((o) => o.value)).toEqual(['tr']);
    expect(defaultSelect().disabled).toBe(true);
  });
});
