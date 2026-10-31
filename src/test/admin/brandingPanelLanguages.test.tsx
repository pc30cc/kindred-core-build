/**
 * Super Admin → Branding → Platform settings, around the dashboard's
 * languages (shared/panelLanguages.ts):
 *
 *   - clicking the region already chosen changes nothing (Iran's preset,
 *     Persian only without a switcher, would wipe the languages set since);
 *   - the Languages tab says what its list decides: the dashboard only in
 *     Iran, the dashboard and the visitors in Multi, one pinned language in
 *     Türkiye and Global;
 *   - a stored default the dashboard cannot open in (a legacy 'ar', a tagged
 *     'fa-IR') is shown, badged and saved as the one it does open in.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const srv = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  puts: [] as Array<Record<string, unknown>>,
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
vi.mock('@/hooks/use-toast', () => ({ toast: () => undefined }));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
  useTranslation: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
}));
vi.mock('@/lib/native', () => ({ isNativePlatform: () => false, getNativePlatform: () => 'web' }));
vi.mock('@/components/admin/EmailTemplatesTab', () => ({ default: () => null }));

const AdminBrandingPage = (await import('@/pages/admin/BrandingPage')).default;

const K = 'admin.brandingPage.settings';

/** Radix's tab trigger changes tab on a primary mouse down. */
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });

async function openSettings(settings: Record<string, unknown>) {
  srv.settings = { timezone: 'UTC', maintenance_mode: false, ...settings };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminBrandingPage /></QueryClientProvider>);
  openTab('admin.brandingPage.tabs.settings');
  await waitFor(() => expect(screen.getByRole('tab', { name: `${K}.tabs.languages` })).toBeInTheDocument());
}

const settingsTab = (key: string) => openTab(`${K}.tabs.${key}`);

/** Change the time zone (any edit) and save: the payload is what the page holds. */
async function saveWithAnEdit(): Promise<Record<string, unknown>> {
  settingsTab('general');
  fireEvent.change(screen.getByPlaceholderText('UTC'), { target: { value: 'Asia/Tehran' } });
  fireEvent.click(screen.getByRole('button', { name: /admin\.brandingPage\.common\.save/ }));
  await waitFor(() => expect(srv.puts).toHaveLength(1));
  return srv.puts[0];
}

/** The region's card (its title also shows in the "current mode" line under the cards). */
const pickRegionCard = (mode: string) => {
  const titles = screen.getAllByText(`${K}.region.modes.${mode}.title`);
  const card = titles.map((el) => el.closest('button')).find(Boolean) as HTMLElement;
  fireEvent.click(card);
};

const languageCard = (code: string) =>
  screen.getByText(`admin.brandingPage.languages.${code}`).closest('button') as HTMLElement;

beforeEach(() => {
  srv.settings = {};
  srv.puts = [];
  localStorage.clear();
});

describe('the region already chosen', () => {
  it('clicking Iran again keeps the dashboard languages set since', async () => {
    await openSettings({ region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' });
    settingsTab('region');
    pickRegionCard('iran');
    // Nothing changed: nothing to save.
    expect(screen.getByRole('button', { name: /admin\.brandingPage\.common\.save/ })).toBeDisabled();

    const put = await saveWithAnEdit();
    expect(put).toMatchObject({ region_mode: 'iran', active_locales: ['fa', 'en'], default_locale: 'en', site_mode: 'multi_language' });
  });

  it('picking Iran from another region still presets Persian only without a switcher', async () => {
    await openSettings({ region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' });
    settingsTab('region');
    pickRegionCard('iran');
    const put = await saveWithAnEdit();
    expect(put).toMatchObject({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' });
  });
});

describe('the Languages tab says what its list decides', () => {
  it('Iran: the dashboard only, with the note that visitors stay Persian', async () => {
    await openSettings({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' });
    settingsTab('languages');
    expect(screen.getByText(`${K}.languages.description`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`${K}\\.languages\\.iranNote`))).toBeInTheDocument();
    expect(screen.queryByText(`${K}.languages.descriptionMulti`)).toBeNull();
  });

  it('Multi: the dashboard and the visitors, and how to limit the dashboard only', async () => {
    await openSettings({ region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' });
    settingsTab('languages');
    expect(screen.getByText(`${K}.languages.descriptionMulti`)).toBeInTheDocument();
    expect(screen.queryByText(`${K}.languages.description`)).toBeNull();
    expect(screen.queryByText(new RegExp(`${K}\\.languages\\.iranNote`))).toBeNull();
  });

  it('Türkiye: one pinned language for both', async () => {
    await openSettings({ region_mode: 'turkey', active_locales: ['tr'], default_locale: 'tr', site_mode: 'single_language' });
    settingsTab('languages');
    expect(screen.getByText(`${K}.languages.descriptionPinned`)).toBeInTheDocument();
    expect(screen.queryByText(`${K}.languages.descriptionMulti`)).toBeNull();
  });
});

describe('a stored default the dashboard cannot open in', () => {
  it('a legacy text-only default shows, badges and saves the language the dashboard opens in', async () => {
    await openSettings({ region_mode: 'multi', active_locales: ['ar', 'en', 'tr'], default_locale: 'ar', site_mode: 'multi_language' });
    settingsTab('languages');
    expect(within(languageCard('en')).getByText('admin.brandingPage.common.default')).toBeInTheDocument();
    expect(within(languageCard('ar')).queryByText('admin.brandingPage.common.default')).toBeNull();
    const put = await saveWithAnEdit();
    expect(put).toMatchObject({ default_locale: 'en', active_locales: ['ar', 'en', 'tr'] });
  });

  it('a tagged default reads as its language', async () => {
    await openSettings({ region_mode: 'iran', active_locales: ['fa-IR'], default_locale: 'fa-IR', site_mode: 'single_language' });
    settingsTab('languages');
    expect(within(languageCard('fa')).getByText('admin.brandingPage.common.default')).toBeInTheDocument();
    const put = await saveWithAnEdit();
    expect(put).toMatchObject({ default_locale: 'fa' });
  });

  it('a default that is a panel language among the active ones is kept as it is', async () => {
    await openSettings({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' });
    const put = await saveWithAnEdit();
    expect(put).toMatchObject({ region_mode: 'iran', active_locales: ['fa'], default_locale: 'fa', site_mode: 'single_language' });
  });
});
