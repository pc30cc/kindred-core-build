/**
 * The platform's public help center on app.* (src/App.tsx /help): /help, and
 * a help page asked for in an unknown language, open in the VISITORS'
 * default language (src/components/help/useHelpDefaultLocale.ts). It used to
 * send everyone to /help/en: on WebYar (visitors: Persian only) that was the
 * English help center, whatever the platform's language.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  region: null as Record<string, unknown> | null,
  pending: false,
  fail: false,
}));

vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  fetchPlatformPublicConfig: () => {
    if (h.pending) return new Promise(() => {});
    if (h.fail) return Promise.reject(new Error('platform config: HTTP 503'));
    return Promise.resolve({ region: h.region });
  },
}));

const { HelpDefaultRedirect } = await import('@/components/help/HelpDefaultRedirect');

function Landed() {
  const { locale } = useParams();
  return <div data-testid="landed">{locale}</div>;
}

function open(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/help" element={<HelpDefaultRedirect />} />
          <Route path="/help/:locale" element={<Landed />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  h.region = null;
  h.pending = false;
  h.fail = false;
});

describe('/help opens in the visitors\' default language', () => {
  it('WebYar, its dashboard set to English: Persian, the visitors\' only language', async () => {
    h.region = { region_mode: 'iran', active_locales: ['fa', 'tr', 'en'], default_locale: 'en', site_mode: 'multi_language' };
    open('/help');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toBe('fa'));
  });

  it('RESPOK: its default language, which visitors have (as before)', async () => {
    h.region = { region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'en', site_mode: 'multi_language' };
    open('/help');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toBe('en'));
  });

  it('a Multi platform whose default is Turkish opens in Turkish', async () => {
    h.region = { region_mode: 'multi', active_locales: ['en', 'tr'], default_locale: 'tr', site_mode: 'multi_language' };
    open('/help');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toBe('tr'));
  });

  it('waits for the settings rather than guessing', async () => {
    h.pending = true;
    open('/help');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('landed')).toBeNull();
  });

  it('settings that cannot be read: the region this browser last saw (Iran: Persian)', async () => {
    localStorage.setItem('platform-region-mode', 'iran');
    h.fail = true;
    open('/help');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toBe('fa'));
  });

  it('settings that cannot be read on a first visit: English', async () => {
    h.fail = true;
    open('/help');
    await waitFor(() => expect(screen.getByTestId('landed').textContent).toBe('en'));
  });
});
