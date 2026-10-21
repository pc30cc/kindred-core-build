/**
 * Widget page tabs the plan does not include (W-04): they stay in the strip,
 * marked with a lock, and open read-only with the upgrade notice, instead of
 * vanishing after a downgrade while their settings stayed in force.
 *
 * WidgetPage itself is rendered, its data hooks stubbed (the plan snapshot
 * denies the Availability and Domains tabs) and the heavy children (the
 * live preview, the smart studio, the template card) replaced by markers.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const WS = { id: 'ws-1', name: 'Acme', slug: 'acme' };
const denied = new Set(['widget_business_hours', 'widget_domain_allowlist']);
const capabilityKeys = [
  'widget_appearance', 'widget_behavior', 'widget_smart_engagement', 'widget_prechat_form', 'widget_business_hours',
  'widget_domain_allowlist', 'chat', 'knowledge_base', 'visitor_tracking', 'widget_attachments', 'widget_voice_notes',
  'widget_emoji', 'widget_raw_ip_storage', 'widget_assignment_routing',
];
const ents = { features: Object.fromEntries(capabilityKeys.map((k) => [k, { value: !denied.has(k) }])), modules: {}, limits: {} };

vi.mock('@/features/phone-verification/PhoneVerificationGate', () => ({ PhoneVerificationGate: ({ children }: { children: unknown }) => children }));
vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => WS,
  useActiveWorkspace: () => ({ workspace: WS }),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));
vi.mock('@/hooks/useWidgetSettings', async (orig) => ({
  ...(await orig<object>()),
  useWidgetSettings: () => ({
    data: {
      enabled: true, chat_enabled: true, allowed_domains: ['shop.example'], allow_subdomains: false, offline_mode: 'hide_widget',
      live_chat_enabled: true, business_hours: { enabled: true, timezone: 'Asia/Tehran', weekly: { sat: [{ from: '09:00', to: '17:00' }] } },
      welcome_message: 'Hello', locale: 'en',
    },
    isLoading: false,
  }),
  useWidgetWelcome: () => ({ data: { default_text: 'Hello! How can we help you?', ai_greeting: false } }),
  useUploadWidgetFabImage: () => ({ mutateAsync: vi.fn() }),
  useRemoveWidgetFabImage: () => ({ mutateAsync: vi.fn() }),
  // The server's answer for this plan: the stored hours are not applied.
  useWidgetAvailabilityNow: () => ({
    data: {
      state: 'online', reason: 'disabled', next_open_at: null, timezone: 'Asia/Tehran', offline_mode: 'capture_message',
      business_hours_allowed: false, operators: { members: 1, available: 1 }, checked_at: '2026-10-21T10:00:00Z',
    },
    isError: false,
  }),
}));
vi.mock('@/hooks/useEntitlements', () => ({
  useWorkspaceEffectiveEntitlements: () => ({ data: ents, loading: false, error: null, reload: vi.fn() }),
}));
vi.mock('@/features/branding/BrandingContext', () => ({ useBrandingContext: () => ({ branding: null, platformName: 'WebYar' }) }));
vi.mock('@/hooks/useWidgetPlatformSettings', () => ({ useWidgetPlatformPublicSettings: () => ({ data: null }) }));
vi.mock('@/hooks/useWidgetCatalog', () => ({
  useWorkspaceWidgetCatalog: () => ({ data: undefined, refetch: vi.fn() }),
  effectiveWorkspaceTemplate: () => ({ id: 'default', options: {} }),
  templateCardVisible: () => false,
}));
vi.mock('@/hooks/useKnowledgeBase', () => ({ useKBArticles: () => ({ data: [] }), useKBCategories: () => ({ data: [] }) }));
vi.mock('@/hooks/useWorkspaceMembers', () => ({ useWorkspaceMembers: () => ({ data: [] }) }));
vi.mock('@/hooks/useWorkspaceDomains', () => ({ useWorkspaceDomains: () => ({ data: [] }) }));
vi.mock('@/hooks/useTeamPresence', () => ({ useTeamPresence: () => ({ data: undefined }) }));
vi.mock('@/hooks/useWidgetIdentity', () => ({ useWidgetPrechatSettings: () => ({ data: undefined }) }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'single', allowedLocales: ['en'], canSwitchLanguage: false, currency: 'USD' }),
}));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'iran', isInternational: false, ready: true }),
  useKnownEdition: () => 'iran',
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/app/widget/WidgetLivePreview', () => ({ WidgetLivePreview: () => <div data-stub="preview" />, FAB_ICONS: {} }));
vi.mock('@/components/app/widget/smart/SmartRulesTab', () => ({ SmartRulesTab: () => <div data-stub="smart" /> }));
vi.mock('@/components/app/widget/PrechatSection', () => ({ PrechatSection: () => <div data-stub="prechat" /> }));
vi.mock('@/components/app/widget/LauncherStylePicker', () => ({ LauncherStylePicker: () => <div data-stub="launcher" /> }));

const { default: WidgetPage } = await import('@/pages/app/WidgetPage');

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en" initialTranslations={en}>
          <WidgetPage />
        </I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(name) });
/** Radix tabs switch on mousedown (activationMode automatic). */
const open = (name: string) => fireEvent.mouseDown(tab(name), { button: 0 });

describe('WidgetPage: plan-locked tabs', () => {
  it('every tab stays in the strip; the locked ones carry the lock', () => {
    mount();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(7);
    const T = en.widgetPage.tabs;
    for (const name of [T.appearance, T.behavior, T.smart, T.prechat, T.install]) {
      expect(within(tab(name)).queryByLabelText(en.plan.locked.upgradeHint), name).toBeNull();
    }
    for (const name of [T.availability, T.domains]) {
      expect(within(tab(name)).getByLabelText(en.plan.locked.upgradeHint), name).toBeTruthy();
    }
  });

  it('a locked tab opens read-only: the upgrade notice, the stored settings, every control disabled', () => {
    const view = mount();
    open(en.widgetPage.tabs.domains);
    const section = view.container.querySelector<HTMLElement>('[data-plan-read-only="widget_domain_allowlist"]')!;
    expect(section).not.toBeNull();
    expect(section.textContent).toContain(en.widgetPage.locked.title.replace('{{feature}}', 'Widget Domain Allowlist'));
    expect(within(section).getByRole('link', { name: new RegExp(en.plan.locked.action) }).getAttribute('href')).toBe('/acme/billing');
    // The stored list is shown, not hidden.
    expect(section.textContent).toContain('shop.example');
    const fieldset = section.querySelector('fieldset')!;
    expect(fieldset.disabled).toBe(true);
    for (const control of fieldset.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) {
      expect(control.matches(':disabled'), control.outerHTML.slice(0, 80)).toBe(true);
    }
  });

  it('the Availability tab says what visitors get meanwhile (once, from the server\'s answer)', () => {
    const view = mount();
    open(en.widgetPage.tabs.availability);
    const section = view.container.querySelector<HTMLElement>('[data-plan-read-only="widget_business_hours"]')!;
    expect(section.textContent!.split(en.widgetPage.availability.planNotApplied)).toHaveLength(2);
    expect(section.textContent).toContain(en.widgetPage.availability.reasonDisabled);
    // The stored offline behaviour is visible (read-only).
    const radios = [...section.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.find((r) => r.checked)?.value).toBe('hide_widget');
    for (const r of radios) expect(r.matches(':disabled')).toBe(true);
  });

  it('a tab the plan includes is editable, with no notice; the save status is announced politely', () => {
    const view = mount();
    expect(view.container.querySelector('[data-plan-read-only]')).toBeNull();
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    const brand = [...view.container.querySelectorAll<HTMLInputElement>('input')].find((i) => i.maxLength === 200);
    expect(brand).toBeTruthy();
    expect(brand!.matches(':disabled')).toBe(false);
  });
});
