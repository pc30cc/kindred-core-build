/**
 * The generic provider workspace (src/features/providers/
 * AdminProviderWorkspace.tsx) opens on the vendor that is configured, also
 * when its answer is already cached. It used to set the vendor from two
 * effects on mount, and the second ("the first vendor") won whenever the
 * saved provider was cached: reopening a panel landed on another vendor's
 * empty form with "Save & activate". A stored credential shows as saved,
 * never filled in.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const saved = vi.hoisted(() => ({
  value: { provider_name: 'anthropic', config: { model: 'claude-x' }, secretKeysSet: ['api_key'] } as Record<string, unknown> | null,
}));

vi.mock('@/hooks/useEdition', () => ({ useEdition: () => ({ edition: 'iran' }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/providers', () => ({
  useProviderSummary: () => ({}),
  useRegisteredProviders: () => [],
  providerRegistry: { getResolutionChain: () => [], checkAllHealth: async () => ({}) },
  getGlobalDefaultProvider: async () => saved.value,
  setGlobalDefaultProvider: async () => ({ error: null }),
  removeGlobalDefaultProvider: async () => ({ error: null }),
  testProviderConnection: async () => ({ status: 'unknown', message: '', checkedAt: 0 }),
  getFallbackLog: () => [],
}));

import { AdminProviderWorkspace } from '@/features/providers/AdminProviderWorkspace';

function renderWorkspace(qc: QueryClient) {
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <AdminProviderWorkspace type="ai" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** The vendor rail's tabs (the section tabs above it are tabs too). */
const vendorTabs = () => within(document.querySelector('[role="tablist"][aria-orientation="vertical"]') as HTMLElement).getAllByRole('tab');
const selectedTab = () => vendorTabs().find((t) => t.getAttribute('aria-selected') === 'true');

afterEach(() => cleanup());

describe('the provider workspace opens on the configured vendor', () => {
  it('on first open, once the saved provider has loaded', async () => {
    renderWorkspace(new QueryClient());
    await waitFor(() => expect(selectedTab()?.textContent).toContain('Anthropic'));
    expect(screen.getByText(en.adminProviders.form.savedSecret)).toBeTruthy();
  });

  it('when opened again with the answer cached', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['global-provider', 'ai'], saved.value);
    renderWorkspace(qc);
    expect(selectedTab()?.textContent).toContain('Anthropic');
    // and it stays there after the mount's effects ran
    await new Promise((r) => setTimeout(r, 20));
    expect(selectedTab()?.textContent).toContain('Anthropic');
  });

  it('a vendor picked on the rail stays picked', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['global-provider', 'ai'], saved.value);
    renderWorkspace(qc);
    fireEvent.click(vendorTabs().find((t) => t.textContent?.startsWith('OpenAI'))!);
    expect(selectedTab()?.textContent).toContain('OpenAI');
    expect(screen.queryByText(en.adminProviders.form.savedSecret)).toBeNull();
  });
});
