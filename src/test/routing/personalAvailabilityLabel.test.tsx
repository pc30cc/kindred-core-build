/**
 * Account → Availability (src/components/app/widget/PersonalAvailabilityPanel.tsx),
 * R-07 on the web: the switch stored as `available_when_using_app` is
 * labelled for what it does — "Show me as available to visitors"; off makes
 * the operator invisible (no visitor sees them, no chat is given to them)
 * whatever the schedule says — not "Set me available when using the app".
 * The banner shows the server's status (the widget's own resolver, tested in
 * routingPanelServer.test.ts) and says when chats are given automatically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import fa from '@/i18n/locales/fa';

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { PersonalAvailabilityPanel } = await import('@/components/app/widget/PersonalAvailabilityPanel');

const WEEK = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] }]),
);

let prefs: Record<string, unknown>;
let patches: Array<Record<string, unknown>>;

beforeEach(() => {
  prefs = { force_offline: false, available_when_using_app: false, schedule_enabled: true, timezone: 'UTC', weekly_schedule: WEEK };
  patches = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push(body);
      prefs = { ...prefs, ...body };
    }
    const online = prefs.available_when_using_app === true && prefs.force_offline !== true;
    return new Response(JSON.stringify({
      prefs,
      status: online
        ? { state: 'online', reason: 'within_schedule' }
        : { state: 'offline', reason: 'unavailable_when_using_app' },
    }), { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mount(locale?: 'fa') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider {...(locale ? { initialLocale: locale, initialTranslations: fa } : {})}>
        <PersonalAvailabilityPanel />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('PersonalAvailabilityPanel — R-07', () => {
  it('the switch says what it does, and the banner follows the server', async () => {
    await mount();
    const label = await screen.findByText('Show me as available to visitors');
    expect(screen.queryByText('Set me available when using the app')).toBeNull();
    const row = label.closest('div.flex') as HTMLElement;
    expect(row.textContent).toContain('Off: you are invisible');
    const sw = row.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // Off within the schedule: the banner says Offline, as visitors see it.
    expect(screen.getByText('Offline')).toBeTruthy();
    expect(document.querySelector('[data-availability-routing-note]')!.textContent)
      .toContain('only while you are shown as available here');

    fireEvent.click(sw);
    await waitFor(() => expect(patches).toEqual([{ available_when_using_app: true }]));
    await screen.findByText('Online');
  });

  it('in Persian', async () => {
    await mount('fa');
    expect(await screen.findByText('برای بازدیدکنندگان در دسترس نشانم بده')).toBeTruthy();
    expect(screen.queryByText('وقتی از برنامه استفاده می‌کنم، در دسترس باشم')).toBeNull();
  });
});
