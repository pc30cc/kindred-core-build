/**
 * Widget → Appearance and Domains say what visitors get, and write only what
 * the owner does (W-03, W-07, W-10, W-11, W-13, W-14, W-15, W-16).
 *
 * WidgetPage itself is rendered with its data hooks stubbed; every save goes
 * through the page's real draft layer to a recorded PATCH.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const WS = { id: 'ws-1', name: 'Acme', slug: 'acme' };
const capabilityKeys = [
  'widget_appearance', 'widget_behavior', 'widget_smart_engagement', 'widget_prechat_form', 'widget_business_hours',
  'widget_domain_allowlist', 'chat', 'knowledge_base', 'visitor_tracking', 'widget_attachments', 'widget_voice_notes',
  'widget_emoji', 'widget_raw_ip_storage', 'widget_assignment_routing', 'widget_reply_time_text', 'widget_welcome_message',
  'widget_launcher_label', 'widget_launcher_size', 'widget_launcher_icon', 'widget_composer_placeholder',
  'widget_team_avatars', 'widget_workspace_logo', 'widget_powered_by', 'widget_powered_by_toggle',
];
const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  denied: new Set<string>(),
  welcome: { default_text: 'Hello! How can we help you?', ai_greeting: false },
  domains: [] as Array<{ id: string; domain: string; verified: boolean; is_primary: boolean }>,
  locales: ['en'] as string[],
  patches: [] as Array<Record<string, unknown>>,
  previewProps: null as Record<string, unknown> | null,
  pickerProps: null as Record<string, unknown> | null,
  platform: null as Record<string, unknown> | null,
}));

vi.mock('@/features/phone-verification/PhoneVerificationGate', () => ({ PhoneVerificationGate: ({ children }: { children: unknown }) => children }));
vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => WS,
  useActiveWorkspace: () => ({ workspace: WS }),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));
vi.mock('@/hooks/useWidgetSettings', async (orig) => ({
  ...(await orig<object>()),
  useWidgetSettings: () => ({ data: state.row, isLoading: false }),
  useUpdateWidgetSettings: () => {
    const save = async (patch: Record<string, unknown>) => { state.patches.push(patch); return { ...state.row, ...patch }; };
    return { mutateAsync: save, mutate: save };
  },
  useWidgetWelcome: () => ({ data: state.welcome }),
  useUploadWidgetFabImage: () => ({ mutateAsync: vi.fn() }),
  useRemoveWidgetFabImage: () => ({ mutateAsync: vi.fn() }),
  useWidgetAvailabilityNow: () => ({ data: { state: 'offline', reason: 'no_operators_online', offline_mode: 'capture_message', business_hours_allowed: true, operators: { members: 1, available: 0 }, next_open_at: null, timezone: 'UTC', checked_at: '' } }),
}));
vi.mock('@/hooks/useEntitlements', () => ({
  useWorkspaceEffectiveEntitlements: () => ({
    data: { features: Object.fromEntries(capabilityKeys.map((k) => [k, { value: !state.denied.has(k) }])), modules: {}, limits: {} },
    loading: false, error: null, reload: vi.fn(),
  }),
}));
vi.mock('@/features/branding/BrandingContext', () => ({ useBrandingContext: () => ({ branding: { primary_color: '#3B82F6' }, platformName: 'WebYar' }) }));
vi.mock('@/hooks/useWidgetPlatformSettings', () => ({ useWidgetPlatformPublicSettings: () => ({ data: state.platform }) }));
vi.mock('@/hooks/useWidgetCatalog', () => ({
  useWorkspaceWidgetCatalog: () => ({ data: undefined, refetch: vi.fn() }),
  effectiveWorkspaceTemplate: (_v: unknown, _e: unknown, id: string | null) => ({ id: id || 'default', options: {} }),
  templateCardVisible: () => false,
}));
vi.mock('@/hooks/useKnowledgeBase', () => ({ useKBArticles: () => ({ data: [] }), useKBCategories: () => ({ data: [] }) }));
vi.mock('@/hooks/useWorkspaceMembers', () => ({ useWorkspaceMembers: () => ({ data: [] }) }));
vi.mock('@/hooks/useWorkspaceDomains', () => ({ useWorkspaceDomains: () => ({ data: state.domains }) }));
vi.mock('@/hooks/useTeamPresence', () => ({ useTeamPresence: () => ({ data: undefined }) }));
vi.mock('@/hooks/useWidgetIdentity', () => ({ useWidgetPrechatSettings: () => ({ data: undefined }) }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'single', allowedLocales: state.locales, canSwitchLanguage: state.locales.length > 1, currency: 'USD' }),
}));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: 'iran', isInternational: false, ready: true }),
  useKnownEdition: () => 'iran',
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/app/widget/WidgetLivePreview', () => ({
  WidgetLivePreview: (props: Record<string, unknown>) => { state.previewProps = props; return <div data-stub="preview" />; },
  FAB_ICONS: { chat: '', message: '', help: '', headset: '', phone: '', sparkles: '', smile: '' },
}));
vi.mock('@/components/app/widget/smart/SmartRulesTab', () => ({ SmartRulesTab: () => <div data-stub="smart" /> }));
vi.mock('@/components/app/widget/PrechatSection', () => ({ PrechatSection: () => <div data-stub="prechat" /> }));
vi.mock('@/components/app/widget/LauncherStylePicker', () => ({
  LauncherStylePicker: (props: Record<string, unknown>) => { state.pickerProps = props; return <div data-stub="launcher" />; },
}));

const { default: WidgetPage } = await import('@/pages/app/WidgetPage');

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});
beforeEach(() => {
  state.row = { enabled: true, chat_enabled: true, allowed_domains: [], allow_subdomains: false, locale: 'en', primary_color: null, welcome_message: null, brand_name: null, reply_time_text: null };
  state.denied = new Set();
  state.welcome = { default_text: 'Hello! How can we help you?', ai_greeting: false };
  state.domains = [];
  state.locales = ['en'];
  state.patches = [];
  state.previewProps = null;
  state.pickerProps = null;
  state.platform = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

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
const A = en.widgetPage.appearance;
/** Let the page's debounced saves go out. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 650)); });
}
const tabOpen = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name: new RegExp(name) }), { button: 0 });

describe('the welcome message (W-07)', () => {
  it('opening the page writes nothing: an unset or seeded welcome stays empty, its placeholder is what visitors read', async () => {
    for (const welcome of [null, '', 'Hello! How can we help you?']) {
      state.row.welcome_message = welcome;
      state.patches = [];
      const view = mount();
      await settle();
      expect(state.patches, String(welcome)).toEqual([]);
      const field = view.container.querySelector<HTMLTextAreaElement>('#widget-welcome')!;
      expect(field.value).toBe('');
      expect(field.placeholder).toBe('Hello! How can we help you?');
      cleanup();
    }
  });

  it('the placeholder is the server\'s default (the platform\'s welcome); emptying the field saves null', async () => {
    state.welcome = { default_text: 'Welcome to our store', ai_greeting: false };
    state.row.welcome_message = 'Hi!';
    const view = mount();
    const field = view.container.querySelector<HTMLTextAreaElement>('#widget-welcome')!;
    expect(field.value).toBe('Hi!');
    expect(field.placeholder).toBe('Welcome to our store');
    fireEvent.change(field, { target: { value: '' } });
    await settle();
    expect(state.patches).toEqual([{ welcome_message: null }]);
    expect(state.previewProps!.defaultWelcome).toBe('Welcome to our store');
  });

  it('a text being typed stays as typed, an English seed too ("How can we help you?"), with a note that visitors read the default for it', async () => {
    const view = mount();
    const field = () => view.container.querySelector<HTMLTextAreaElement>('#widget-welcome')!;
    fireEvent.change(field(), { target: { value: 'How can we help you' } });
    expect(field().value).toBe('How can we help you');
    expect(view.container.querySelector('[data-welcome-seed-note]')).toBeNull();
    fireEvent.change(field(), { target: { value: 'How can we help you?' } });
    expect(field().value).toBe('How can we help you?');
    expect(view.container.querySelector('[data-welcome-seed-note]')!.textContent).toBe(A.welcomeSeedHint);
    fireEvent.change(field(), { target: { value: 'How can we help you? Ask away.' } });
    expect(field().value).toBe('How can we help you? Ask away.');
    expect(view.container.querySelector('[data-welcome-seed-note]')).toBeNull();
    await settle();
    expect(state.patches).toEqual([{ welcome_message: 'How can we help you? Ask away.' }]);
  });

  it('says when the AI agent\'s greeting replaces it, and the preview draws none', () => {
    state.welcome = { default_text: 'Hello! How can we help you?', ai_greeting: true };
    const view = mount();
    expect(view.container.querySelector('[data-welcome-ai-note]')!.textContent).toBe(A.welcomeAiNote);
    expect(state.previewProps!.aiGreets).toBe(true);
  });
});

describe('the display name and the reply-time note (W-11)', () => {
  it('empty follows the default (null); the switch hides the line (\'\'); "Use the default" goes back', async () => {
    state.row.brand_name = 'Old name';
    const view = mount();
    const input = view.container.querySelector<HTMLInputElement>('#widget-brand-name')!;
    expect(input.value).toBe('Old name');
    expect(input.placeholder).toBe('Acme');
    fireEvent.change(input, { target: { value: '' } });
    await settle();
    expect(state.patches.at(-1)).toEqual({ brand_name: null });
    fireEvent.click(screen.getByRole('switch', { name: A.brandNameShow }));
    await settle();
    expect(state.patches.at(-1)).toEqual({ brand_name: '' });
    expect(input.disabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: A.brandNameShow }));
    await settle();
    expect(state.patches.at(-1)).toEqual({ brand_name: null });
  });

  it('the reply-time note: a typed one has "Use the default", which saves null', async () => {
    state.row.reply_time_text = 'Back in 5';
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: A.useDefault })[0]);
    await settle();
    expect(state.patches.at(-1)).toEqual({ reply_time_text: null });
  });
});

describe('the colour (W-10, W-14)', () => {
  it('no colour of its own is "Brand colour", chosen; a swatch is a real colour, the blue one too', async () => {
    const view = mount();
    const brand = view.container.querySelector<HTMLButtonElement>('[data-swatch-brand]')!;
    expect(brand.getAttribute('aria-pressed')).toBe('true');
    const blue = screen.getByRole('button', { name: A.colorSwatch.replace('{{hex}}', '#6366F1') });
    expect(blue.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(blue);
    await settle();
    expect(state.patches.at(-1)).toEqual({ primary_color: '#6366F1' });
    fireEvent.click(brand);
    await settle();
    expect(state.patches.at(-1)).toEqual({ primary_color: null });
    // The seeded #3B82F6 is the brand colour (shared/widgetColor.ts): no swatch claims it; the blue is its neighbour.
    expect(screen.queryByRole('button', { name: A.colorSwatch.replace('{{hex}}', '#3B82F6') })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: A.colorSwatch.replace('{{hex}}', '#2563EB') }));
    await settle();
    expect(state.patches.at(-1)).toEqual({ primary_color: '#2563EB' });
  });

  it('a stored seed reads as "Brand colour"; the picker draws the kit\'s ground', () => {
    state.row.primary_color = '#3B82F6';
    const view = mount();
    expect(view.container.querySelector('[data-swatch-brand]')!.getAttribute('aria-pressed')).toBe('true');
    expect(state.pickerProps!.primaryColor).toBeNull();
    // The workspace branding's seed is no colour either: the preview gets none.
    expect((state.previewProps!.settings as Record<string, unknown>).primary_color).toBeNull();
  });

  it('a half-typed colour is shown, said, and never saved; a complete one is saved upper-case', async () => {
    const view = mount();
    const input = view.container.querySelector<HTMLInputElement>('#widget-color')!;
    fireEvent.change(input, { target: { value: '#12' } });
    await settle();
    expect(state.patches).toEqual([]);
    expect(input.value).toBe('#12');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe(A.colorInvalid);
    fireEvent.change(input, { target: { value: '#12ab3c' } });
    await settle();
    expect(state.patches).toEqual([{ primary_color: '#12AB3C' }]);
  });
});

describe('small truths (W-13, W-15)', () => {
  it('the size label measures the kit\'s 60px button; icons are named, not their ids', () => {
    state.row.fab_scale = 120;
    const view = mount();
    expect(view.container.textContent).toContain('72px');
    expect(screen.getByRole('button', { name: A.iconSparkles })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'sparkles' })).toBeNull();
  });

  it('the launcher image follows the icon\'s plan capability; the pill starts in the widget\'s language', () => {
    state.denied = new Set(['widget_launcher_icon']);
    mount();
    expect((screen.getByRole('button', { name: A.fabImageUpload }) as HTMLButtonElement).disabled).toBe(true);
    expect(state.pickerProps!.widgetLocale).toBe('en');
  });

  it('the team photos hint describes the template visitors wear', () => {
    state.row.widget_template_id = 't2';
    const view = mount();
    expect(view.container.textContent).toContain(A.showTeamAvatarsHintT2);
  });
});

describe('legacy columns shown (W-16)', () => {
  it('a chosen widget language is the one shown; "Automatic" exists where there are languages to choose', () => {
    state.locales = ['en', 'tr'];
    state.row.locale = 'tr';
    state.row.widget_language = 'en';
    mount();
    expect(state.previewProps!.settings).toMatchObject({ locale: 'en', widget_language: 'en' });
  });

  it('a logo link from an older version is shown, and can be replaced by the uploaded logo', async () => {
    state.row.logo_url = 'https://cdn.example/logo.png';
    const view = mount();
    const box = view.container.querySelector('[data-logo-link]')!;
    expect(box.textContent).toContain('https://cdn.example/logo.png');
    fireEvent.click(screen.getByRole('button', { name: A.logoLinkClear }));
    await settle();
    expect(state.patches.at(-1)).toEqual({ logo_url: null });
  });
});

describe('Widget → Domains says which sites may show the widget (W-03)', () => {
  it('an empty list: any site; a list: its sites and, read-only, the verified domains', () => {
    state.domains = [
      { id: 'd1', domain: 'shop.com', verified: true, is_primary: true },
      { id: 'd2', domain: 'pending.com', verified: false, is_primary: false },
    ];
    const empty = mount();
    tabOpen(en.widgetPage.tabs.domains);
    expect(empty.container.querySelector('[data-domains-any]')!.textContent).toBe(en.widgetPage.domains.emptyAllowsAll);
    expect(empty.container.querySelector('[data-domains-verified]')).toBeNull();
    cleanup();

    state.row.allowed_domains = ['shop2.com'];
    const listed = mount();
    tabOpen(en.widgetPage.tabs.domains);
    const verified = listed.container.querySelector('[data-domains-verified]')!;
    expect(verified.textContent).toContain('shop.com');
    expect(verified.textContent).not.toContain('pending.com');
    expect(verified.querySelector('a')!.getAttribute('href')).toBe('/acme/settings/domains');
    expect(listed.container.querySelector('[data-domains-any]')).toBeNull();
  });
});

describe('the “Powered by” credit follows the Super Admin’s master switch (S-04)', () => {
  const card = () => document.querySelector('[data-powered-by-card]') as HTMLElement;
  const toggle = () => card().querySelector('[role="switch"]') as HTMLButtonElement;

  it('switched off for the platform: the card says the widget shows none, never a locked “on”', async () => {
    state.platform = { powered_by_enabled: false, powered_by_text: '', powered_by_brand_text: null, powered_by_url: null };
    state.denied = new Set(['widget_powered_by_toggle']);
    mount();
    await screen.findByText(A.showPoweredBy);
    expect(card().textContent).toContain(A.showPoweredByPlatformOff);
    expect(card().textContent).not.toContain(A.showPoweredByLocked);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().disabled).toBe(true);
    // The preview draws no credit either.
    expect(state.previewProps?.poweredBy).toBeNull();
  });

  it('on for the platform, a plan without the toggle: locked on, as visitors see it', async () => {
    state.platform = { powered_by_enabled: true, powered_by_text: '', powered_by_brand_text: 'WebYar', powered_by_url: null };
    state.denied = new Set(['widget_powered_by_toggle']);
    mount();
    await screen.findByText(A.showPoweredBy);
    expect(card().textContent).toContain(A.showPoweredByLocked);
    expect(card().textContent).not.toContain(A.showPoweredByPlatformOff);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().disabled).toBe(true);
  });

  it('on for the platform, a plan with the toggle: the owner may switch it off', async () => {
    state.platform = { powered_by_enabled: true, powered_by_text: '', powered_by_brand_text: 'WebYar', powered_by_url: null };
    mount();
    await screen.findByText(A.showPoweredBy);
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    await settle();
    expect(state.patches).toContainEqual({ show_powered_by: false });
  });
});
