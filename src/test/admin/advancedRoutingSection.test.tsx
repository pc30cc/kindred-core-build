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
 *     saves last_agent_routing_enabled;
 *   - "Quiet conversations" (migration 284): the inactivity close's platform
 *     switch and default window are widget_platform_settings columns, so they
 *     save through PATCH /api/widget-settings/platform/config (never the
 *     advanced-routing endpoint); the hours save on blur within 1..48 and are
 *     greyed out while the switch is off; an older server without the fields
 *     reads on and 24.
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
let platform: Record<string, unknown>;
let platformPatches: Array<Record<string, unknown>>;
let platformAnswer: { status: number; body: unknown } | null;

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
  platform = { id: '00000000-0000-4000-8000-000000000001', inactivity_close_enabled: true, inactivity_close_default_hours: 24 };
  platformPatches = [];
  platformAnswer = null;
  toastMock.success.mockReset();
  toastMock.error.mockReset();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes('/api/widget-settings/platform/config')) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        platformPatches.push(body);
        if (platformAnswer) return new Response(JSON.stringify(platformAnswer.body), { status: platformAnswer.status });
        const { id: _id, ...updates } = body;
        platform = { ...platform, ...updates };
      }
      return new Response(JSON.stringify({ settings: platform }), { status: 200 });
    }
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

const quietGroup = () => document.querySelector('[data-routing-inactivity]') as HTMLElement;
const hoursField = () => screen.getByLabelText('Default for every workspace') as HTMLInputElement;

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

  describe('quiet conversations', () => {
    it('the switch saves inactivity_close_enabled through the platform settings, and greys the hours out', async () => {
      await mount();
      await waitFor(() => expect(quietGroup().textContent).toContain('Close quiet website chats automatically'));
      expect(quietGroup().textContent).toContain('never Telegram, Bale, WhatsApp, Instagram, email or platform support');
      expect(quietGroup().textContent).toContain('never the AI');
      const sw = switchNamed('Close quiet website chats automatically');
      expect(sw.getAttribute('aria-checked')).toBe('true');
      expect(hoursField().disabled).toBe(false);
      fireEvent.click(sw);
      await waitFor(() => expect(platformPatches).toEqual([{ id: platform.id, inactivity_close_enabled: false }]));
      // Not through /api/admin/advanced-routing.
      expect(patches).toEqual([]);
      await waitFor(() => expect(switchNamed('Close quiet website chats automatically').getAttribute('aria-checked')).toBe('false'));
      expect(hoursField().disabled).toBe(true);
      expect(toastMock.success).toHaveBeenCalled();
    });

    it('the default hours save on blur within 1..48; 0 and 49 are refused', async () => {
      await mount();
      await waitFor(() => expect(hoursField().value).toBe('24'));
      for (const bad of ['0', '49']) {
        fireEvent.focus(hoursField());
        fireEvent.change(hoursField(), { target: { value: bad } });
        fireEvent.blur(hoursField());
        expect(quietGroup().querySelector('[role="alert"]')!.textContent, bad).toBe('Enter a whole number from 1 to 48.');
      }
      expect(platformPatches).toEqual([]);
      fireEvent.focus(hoursField());
      fireEvent.change(hoursField(), { target: { value: '36' } });
      fireEvent.blur(hoursField());
      await waitFor(() => expect(platformPatches).toEqual([{ id: platform.id, inactivity_close_default_hours: 36 }]));
      await waitFor(() => expect(hoursField().value).toBe('36'));
    });

    it('an older server without the fields: on, 24 hours', async () => {
      delete platform.inactivity_close_enabled;
      delete platform.inactivity_close_default_hours;
      await mount();
      await waitFor(() => expect(hoursField().value).toBe('24'));
      expect(switchNamed('Close quiet website chats automatically').getAttribute('aria-checked')).toBe('true');
    });

    it('a database without migration 284: the refusal is said in words', async () => {
      platformAnswer = { status: 409, body: { error: 'inactivity_close_migration_required' } };
      await mount();
      await waitFor(() => expect(hoursField().value).toBe('24'));
      fireEvent.click(switchNamed('Close quiet website chats automatically'));
      await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Saving this needs database migration 284.'));
      // Refused: the switch and the hours show the stored values again.
      expect(switchNamed('Close quiet website chats automatically').getAttribute('aria-checked')).toBe('true');
      fireEvent.focus(hoursField());
      fireEvent.change(hoursField(), { target: { value: '36' } });
      fireEvent.blur(hoursField());
      await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(hoursField().value).toBe('24'));
    });

    it('in Persian, without «بی‌فعالیت»', async () => {
      await mount('fa');
      await waitFor(() => expect(quietGroup().textContent).toContain('بستن خودکار گفتگوهای بی‌پیام ویجت'));
      expect(quietGroup().textContent).toContain('گفتگوهای بی‌پیام');
      expect(quietGroup().textContent).not.toContain('بی‌فعالیت');
    });
  });
});
