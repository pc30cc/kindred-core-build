/**
 * Super Admin → Widget settings → Advanced routing
 * (src/components/admin/widget/AdvancedRoutingSection.tsx), over a stubbed
 * GET / PATCH /api/admin/advanced-routing:
 *
 *   - the copy says what each switch does now (R-15): the owner fallback is
 *     a last resort (for chats, an owner who receives chats and is online);
 *     "Use the general pool" is chats only — a department with nobody
 *     available hands its chats to the whole team, calls are not affected;
 *     the description no longer claims to choose how conversations are
 *     assigned (each workspace picks its own mode);
 *   - the platform switch "Return returning visitors to the same operator"
 *     shows the stored value (on when an older server does not send it) and
 *     saves last_agent_routing_enabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import fa from '@/i18n/locales/fa';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { AdvancedRoutingSection } = await import('@/components/admin/widget/AdvancedRoutingSection');

let policy: Record<string, boolean>;
let patches: Array<Record<string, unknown>>;

beforeEach(() => {
  policy = {
    owner_fallback_enabled: true,
    owner_fallback_for_chat: true,
    owner_fallback_for_audio: true,
    owner_fallback_for_video: true,
    general_pool_enabled: true,
    last_agent_routing_enabled: true,
  };
  patches = [];
  toastMock.success.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, boolean>;
      patches.push(body);
      policy = { ...policy, ...body };
    }
    return new Response(JSON.stringify({ policy }), { status: 200 });
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
        <AdvancedRoutingSection />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await screen.findAllByRole('switch');
}

const switchNamed = (label: string) =>
  screen.getByText(label).closest('div.rounded-md')!.querySelector('[role="switch"]') as HTMLButtonElement;

describe('AdvancedRoutingSection', () => {
  it('says what each switch really does', async () => {
    await mount();
    expect(screen.queryByText('Choose how new widget conversations are assigned.')).toBeNull();
    expect(screen.getByText(/Each workspace chooses its own assignment mode/)).toBeTruthy();
    const pool = screen.getByText(/^Chats only\. On: when the department a visitor chose has nobody available/);
    expect(pool.textContent).toContain('Calls are not affected.');
    expect(screen.getByText(/Chats go to the owner only if the owner receives chats and is online/)).toBeTruthy();
  });

  it('the platform returning-visitor switch saves last_agent_routing_enabled', async () => {
    await mount();
    const sw = switchNamed('Return returning visitors to the same operator');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    await waitFor(() => expect(patches).toEqual([{ last_agent_routing_enabled: false }]));
    await waitFor(() => expect(switchNamed('Return returning visitors to the same operator').getAttribute('aria-checked')).toBe('false'));
    expect(screen.getByText(/Off: no workspace sends a returning visitor back/)).toBeTruthy();
  });

  it('an older server without the field: shown on, as it behaves', async () => {
    delete policy.last_agent_routing_enabled;
    await mount();
    expect(switchNamed('Return returning visitors to the same operator').getAttribute('aria-checked')).toBe('true');
  });

  it('in Persian', async () => {
    await mount('fa');
    expect(screen.getByText('بازدیدکنندهٔ بازگشتی به همان اپراتور قبلی برسد')).toBeTruthy();
    expect(screen.getByText(/روی تماس‌ها اثری ندارد/)).toBeTruthy();
  });
});
