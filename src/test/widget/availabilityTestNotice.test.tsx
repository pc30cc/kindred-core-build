/**
 * Widget → Availability → "Test offline notification" (notifications:M2,
 * config:CFG-3): the button reaches the server and shows its real answer.
 *
 *   - it posts { workspaceId, locale } to POST /api/email/test-offline-notice
 *     (an /api/email route the panel can reach; the old /api/widget route sat
 *     behind the widget's token gate and always answered 401), with no
 *     recipient: the test goes to the owner's own verified address, which
 *     the success toast names;
 *   - a provider failure (502), an unverified address, too many tests and a
 *     missing provider each show as a failure, with what happened.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { WidgetSettings } from '@/types/models';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'single', allowedLocales: ['en'], canSwitchLanguage: false, currency: 'USD' }),
}));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'international', isInternational: true, ready: true }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast }));

const { AvailabilitySection } = await import('@/components/app/widget/AvailabilitySection');

const A = en.widgetPage.availability;
let testAnswer: { status: number; body: Record<string, unknown> };
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (String(url).includes('/test-offline-notice')) return new Response(JSON.stringify(testAnswer.body), { status: testAnswer.status });
  if (String(url).includes('/availability')) {
    return new Response(JSON.stringify({ state: 'offline', reason: 'outside_hours', next_open_at: null, timezone: 'UTC', offline_mode: 'capture_message', business_hours_allowed: true, operators: { members: 1, available: 0 } }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
});

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
beforeEach(() => {
  toast.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const settings = { business_hours: { enabled: false }, offline_mode: 'capture_message', live_chat_enabled: true } as unknown as WidgetSettings;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <AvailabilitySection workspaceId="ws-1" settings={settings} onChange={vi.fn()} saving={false} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

async function press() {
  fireEvent.click(screen.getByRole('button', { name: A.send }));
  await waitFor(() => expect(toast).toHaveBeenCalled());
  return toast.mock.calls[0][0] as { title: string; description: string; variant?: string };
}

describe('the test notification button', () => {
  it('posts the workspace and language only, and names the address the server mailed', async () => {
    testAnswer = { status: 200, body: { success: true, sent_to: 'owner@example.com' } };
    mount();
    expect(screen.queryByPlaceholderText('you@example.com')).toBeNull();
    const shown = await press();
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/test-offline-notice'))!;
    expect(String(call[0])).toMatch(/\/api\/email\/test-offline-notice$/);
    expect(JSON.parse(String(call[1]!.body))).toEqual({ workspaceId: 'ws-1', locale: 'en' });
    expect(shown).toMatchObject({ title: A.testSent, description: 'Sent to owner@example.com' });
    expect(shown.variant).toBeUndefined();
  });

  const failures: Array<[string, { status: number; body: Record<string, unknown> }, string]> = [
    ['the provider refused it', { status: 502, body: { success: false, error_code: 'auth', error: 'auth: refused' } }, 'The email provider did not take the mail (auth).'],
    ['no provider is set up', { status: 502, body: { success: false, error_code: 'unconfigured' } }, A.testNoProvider],
    ['the address is not verified', { status: 400, body: { error: 'verified_email_required' } }, A.testNeedsVerifiedEmail],
    ['too many tests', { status: 429, body: { error: 'test_limit_reached', retry_after_seconds: 300 } }, A.testTooMany],
    ['not an owner or admin', { status: 403, body: { error: 'Insufficient workspace permissions' } }, A.testNotAllowed],
  ];
  for (const [what, answer, description] of failures) {
    it(`${what}: a failure, with what happened`, async () => {
      testAnswer = answer;
      mount();
      expect(await press()).toEqual({ title: A.testFailed, description, variant: 'destructive' });
    });
  }
});
