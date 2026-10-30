/**
 * Super Admin → Notifications → Email, the provider choice
 * (src/components/admin/notifications/NotificationEmailTab.tsx): the warning
 * under it follows the choice on screen. The server's provider_configured
 * describes the choice saved when the page was read, and a save replaces
 * only the settings, so a warning drawn from it said the provider just
 * chosen could not send when it could, and said nothing when the new choice
 * could not.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));

import { NotificationEmailTab } from '@/components/admin/notifications/NotificationEmailTab';

const words = (en as unknown as { admin: { notifications: { email: Record<string, string> } } }).admin.notifications.email;

const SETTINGS = {
  enabled: true,
  unread_messages_enabled: false,
  transcripts_enabled: true,
  paid_invoices_enabled: true,
  weekly_summary_enabled: false,
  product_updates_enabled: true,
  provider_override: null as string | null,
  unread_after_minutes: 15,
  digest_every_minutes: 60,
  weekly_summary_dow: 1,
  weekly_summary_hour: 8,
};

function stateWith(override: string | null, stored: { provider_name: string | null; configured: boolean }) {
  return {
    settings: { ...SETTINGS, provider_override: override },
    providers: ['resend', 'sendgrid', 'smtp'],
    notification_provider: stored,
    provider_configured: Boolean(override && stored.configured && stored.provider_name === override),
    announcements: [],
    announcements_per_hour: 500,
    types: [],
  };
}

let current: ReturnType<typeof stateWith>;
const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
  if ((init?.method ?? 'GET') === 'PATCH') {
    const patch = JSON.parse(String(init?.body ?? '{}'));
    // The server answers a save with the settings only, as it does.
    return { ok: true, status: 200, json: async () => ({ settings: { ...current.settings, ...patch } }) };
  }
  return { ok: true, status: 200, json: async () => current };
});

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <NotificationEmailTab />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the provider warning', () => {
  it('choosing the provider the notification slot is set up with: no warning after the save', async () => {
    current = stateWith(null, { provider_name: 'smtp', configured: true });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'smtp' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: 'smtp' }).className).toMatch(/\bbg-primary\b/));
    expect(screen.queryByText(words.providerMissing)).toBeNull();
    expect(screen.queryByText(words.providerMismatch.replace('{name}', 'smtp'))).toBeNull();
  });

  it('moving away from a working choice to one that is not set up: the warning shows at once', async () => {
    current = stateWith('smtp', { provider_name: 'smtp', configured: true });
    renderTab();
    await screen.findByRole('button', { name: 'resend' });
    expect(screen.queryByText(words.providerMismatch.replace('{name}', 'smtp'))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'resend' }));
    expect(await screen.findByText(words.providerMismatch.replace('{name}', 'smtp'))).toBeTruthy();
  });

  it('a stored provider that cannot send: the warning stays, whatever the server said at first', async () => {
    current = stateWith(null, { provider_name: 'smtp', configured: false });
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'smtp' }));
    expect(await screen.findByText(words.providerMissing)).toBeTruthy();
  });
});
