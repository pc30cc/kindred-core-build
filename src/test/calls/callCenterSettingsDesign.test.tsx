/**
 * Call Center → Settings with the 2026-10 call widget design (contract §5.4,
 * B1–B6, B8): the real page, its save payload and its live preview.
 *
 *   - rolling deploy: a migration-277 setting is sent only when the loaded
 *     settings have it and the admin changed it (an old backend's strict PUT
 *     refuses unknown keys; a backend without 277 returns none), and the new
 *     controls wait (disabled, with a note) until the server has them;
 *   - the launcher style picker, the five placements (a stored older
 *     spelling shown as its placement and resent untouched), the edge note
 *     and the chat-side hint;
 *   - callback hours: the slots switch, the shared weekly editor, slot length,
 *     days offered, callbacks per slot, a legacy value kept read-only until
 *     replaced, the edition's default zone, nothing invalid sent;
 *   - the edition's colour defaults and the logo-direction note;
 *   - the text overrides of the new design;
 *   - 503 migration_pending: "try again in a few minutes";
 *   - the preview: the panel module before the engine, the bootstrap of the
 *     new design (fonts, assets, launcher, placement, logo direction, sample
 *     operators without photos, slots from the draft hours, dates per
 *     edition), a desktop frame wide and tall enough for the 400×660 panel,
 *     and a phone frame.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import type { CallCenterWorkspaceSettings } from '@/lib/call-center-api';

const h = vi.hoisted(() => ({
  edition: 'iran' as 'iran' | 'international',
  data: null as unknown,
  mutateAsync: vi.fn(),
  toast: vi.fn(),
  chat: null as unknown,
  members: [] as unknown[],
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', name: 'Nilufar' }, notFound: false }),
}));
vi.mock('@/hooks/useCallCenter', () => ({
  useCallCenterSettings: () => ({ data: h.data, isLoading: false }),
  useUpdateCallCenterSettings: () => ({ mutateAsync: h.mutateAsync, isPending: false }),
}));
vi.mock('@/lib/workspace-departments-api', () => ({ listDepartments: async () => [] }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'multi', allowedLocales: ['en', 'fa', 'tr'], canSwitchLanguage: true, currency: 'USD' }),
}));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: h.edition, isInternational: h.edition === 'international', ready: true }),
  useKnownEdition: () => h.edition,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: h.toast }));
vi.mock('@/hooks/useWidgetSettings', () => ({ useWidgetSettings: () => ({ data: h.chat }) }));
vi.mock('@/hooks/useWorkspaceMembers', () => ({ useWorkspaceMembers: () => ({ data: h.members }) }));

const SettingsPage = (await import('@/pages/app/call-center/SettingsPage')).default;

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const S = en.callCenter.settingsPage;

const PLATFORM = {
  call_center_enabled: true, voice_calls_enabled: true, video_calls_enabled: true, callback_requests_enabled: true,
  call_recording_enabled: false, widget_available_locales: ['fa', 'en', 'tr'], widget_default_locale: 'fa',
  callback_show_when_online: true, callback_require_contact: true, callback_min_message_length: 0,
};
const DESIGN = {
  launcher_style: 'round_label', callback_slots_enabled: false, callback_slot_minutes: 30, callback_days_ahead: 4, callback_slot_capacity: null,
};
const OLD_KEYS = [
  'enabled', 'display_name', 'voice_enabled', 'video_enabled', 'callback_enabled', 'pre_call_form_enabled',
  'offline_behavior', 'recording_enabled', 'recording_consent_required', 'routing_mode', 'widget_position',
  'widget_template_id', 'widget_theme', 'pre_call_form_schema', 'default_department_id', 'widget_default_locale',
  'widget_enabled_locales', 'widget_custom_texts', 'operator_video_visible_to_visitor',
];
const DESIGN_KEYS = Object.keys(DESIGN);

function settings(over: Record<string, unknown> = {}): CallCenterWorkspaceSettings {
  return {
    id: 's1', workspace_id: 'ws-1', enabled: true, public_key: 'pk', allowed_domains: [], widget_position: 'right',
    widget_theme: {}, widget_template_id: 'default', display_name: 'Support', avatar_url: null, voice_enabled: true,
    video_enabled: true, callback_enabled: true, pre_call_form_enabled: false, pre_call_form_schema: [], business_hours: {},
    offline_behavior: 'show_callback', recording_enabled: false, recording_consent_required: false,
    operator_video_visible_to_visitor: true, routing_mode: 'broadcast', default_department_id: null, created_at: '', updated_at: '',
    widget_default_locale: 'fa', widget_enabled_locales: ['fa', 'en'], widget_custom_texts: {},
    ...over,
  } as CallCenterWorkspaceSettings;
}

function mount(rowOver: Record<string, unknown> = {}, opts: { design?: boolean; platform?: Record<string, unknown>; locale?: 'en' | 'fa' } = {}) {
  h.data = {
    settings: settings({ ...(opts.design === false ? {} : DESIGN), ...rowOver }),
    platform: { ...PLATFORM, ...(opts.platform || {}) },
    effective: {},
    recording: null,
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <I18nProvider initialLocale={opts.locale ?? 'en'} initialTranslations={opts.locale === 'fa' ? fa : en}>
          <SettingsPage />
        </I18nProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

async function save(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: en.callCenter.common.saveChanges }));
  await waitFor(() => expect(h.mutateAsync).toHaveBeenCalledTimes(1));
  return h.mutateAsync.mock.calls[0][0] as Record<string, unknown>;
}

async function choose(trigger: HTMLElement, option: string | RegExp) {
  fireEvent.keyDown(trigger, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

function displayName() {
  return screen.getByDisplayValue('Support');
}

/** The parts of the preview's bootstrap these tests read. */
interface PreviewBoot {
  edition: string;
  calendar: string;
  time_zone: string | null;
  assets: Record<string, string>;
  config: Record<string, unknown>;
  presence: unknown;
  capabilities: Record<string, unknown>;
  callback_policy: Record<string, unknown>;
  i18n: { default_locale: string; available_locales: string[] };
}

/** The preview's bootstrap, as the frame's mount reads it. */
function previewBoot(container: HTMLElement = document.body) {
  const frame = container.querySelector<HTMLIFrameElement>('iframe[title="Call Widget live preview"]')!;
  const doc = new DOMParser().parseFromString(frame.getAttribute('srcdoc') || '', 'text/html');
  const json = doc.getElementById('ccw-preview-bootstrap')!.textContent || '';
  return { frame, doc, boot: JSON.parse(json) as PreviewBoot };
}

beforeEach(() => {
  h.edition = 'iran';
  h.chat = null;
  h.members = [];
  h.toast.mockReset();
  h.mutateAsync.mockReset();
  h.mutateAsync.mockImplementation(async (patch: Record<string, unknown>) => ({ settings: patch }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('rolling deploy: the migration-277 settings', () => {
  it('loaded without them (old backend or no 277): a save sends the old keys only, and the new controls wait with a note', async () => {
    mount({}, { design: false });
    fireEvent.change(displayName(), { target: { value: 'Help desk' } });
    const patch = await save();
    expect(patch.display_name).toBe('Help desk');
    expect(Object.keys(patch).sort()).toEqual([...OLD_KEYS].sort());
    for (const k of [...DESIGN_KEYS, 'business_hours']) expect(patch).not.toHaveProperty(k);
    openTab(S.tabs.presentation);
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-call-launcher-style]')) expect(b.disabled).toBe(true);
    expect(document.body.textContent).toContain(S.designSettingsPending);
    openTab(S.tabs.availability);
    expect(document.querySelector('[data-callback-slots]')).toBeNull();
    expect(document.body.textContent).toContain(S.designSettingsPending);
  });

  it('loaded with them and untouched: none is sent', async () => {
    mount();
    fireEvent.change(displayName(), { target: { value: 'Help desk' } });
    const patch = await save();
    for (const k of [...DESIGN_KEYS, 'business_hours']) expect(patch).not.toHaveProperty(k);
  });

  it('a chosen style makes the page dirty and is sent alone of the 277 keys', async () => {
    mount();
    openTab(S.tabs.presentation);
    expect(screen.queryByRole('button', { name: en.callCenter.common.saveChanges })).toBeNull();
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-call-launcher-style="pill"]')!);
    const patch = await save();
    expect(patch.launcher_style).toBe('pill');
    for (const k of DESIGN_KEYS.filter((k) => k !== 'launcher_style')) expect(patch).not.toHaveProperty(k);
  });

  it('after a save the page is clean again (the saved draft is the new baseline)', async () => {
    mount();
    openTab(S.tabs.presentation);
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-call-launcher-style="card"]')!);
    await save();
    await waitFor(() => expect(screen.queryByRole('button', { name: en.callCenter.common.saveChanges })).toBeNull());
  });
});

describe('save errors', () => {
  it('503 migration_pending: the "try again in a few minutes" message', async () => {
    h.mutateAsync.mockRejectedValueOnce(Object.assign(new Error('migration_pending'), { status: 503, code: 'migration_pending' }));
    mount();
    fireEvent.change(displayName(), { target: { value: 'Help desk' } });
    await save();
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: S.migrationPending, variant: 'destructive' })));
    expect(screen.getByRole('button', { name: en.callCenter.common.saveChanges })).toBeTruthy();
  });

  it('any other failure: a failure message with the reason, the draft kept', async () => {
    h.mutateAsync.mockRejectedValueOnce(Object.assign(new Error('invalid_body'), { status: 400, code: 'invalid_body' }));
    mount();
    fireEvent.change(displayName(), { target: { value: 'Help desk' } });
    await save();
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: S.saveFailed, description: 'invalid_body', variant: 'destructive' })));
    expect(screen.getByDisplayValue('Help desk')).toBeTruthy();
  });
});

describe('placement (General)', () => {
  it('five placements, in order', async () => {
    mount();
    fireEvent.keyDown(document.querySelector<HTMLElement>('[data-call-position]')!, { key: 'Enter' });
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual([S.positionOptions.right, S.positionOptions.left, S.positionOptions.top_right, S.positionOptions.top_left, S.positionOptions.bottom_center]);
  });

  it('a stored older spelling shows as its placement and is resent untouched', async () => {
    mount({ widget_position: 'bottom-left' });
    expect(document.querySelector<HTMLElement>('[data-call-position]')!.textContent).toBe(S.positionOptions.left);
    fireEvent.change(displayName(), { target: { value: 'Help desk' } });
    const patch = await save();
    expect(patch.widget_position).toBe('bottom-left');
  });

  it('a chosen placement is stored as its canonical id', async () => {
    mount();
    await choose(document.querySelector<HTMLElement>('[data-call-position]')!, S.positionOptions.top_right);
    const patch = await save();
    expect(patch.widget_position).toBe('top_right');
  });

  it('the edge tab note shows only with the edge tab', () => {
    mount({ launcher_style: 'edge_tab' });
    expect(document.body.textContent).toContain(S.positionEdgeNote);
    cleanup();
    mount();
    expect(document.body.textContent).not.toContain(S.positionEdgeNote);
  });

  it('the chat button on the same side: the stacking hint (not on the other side, not with the edge tab)', () => {
    h.chat = { enabled: true, position: 'bottom-right' };
    mount({ widget_position: 'right' });
    expect(document.body.textContent).toContain(S.positionStacksAboveChat);
    cleanup();
    mount({ widget_position: 'left' });
    expect(document.body.textContent).not.toContain(S.positionStacksAboveChat);
    cleanup();
    mount({ widget_position: 'right', launcher_style: 'edge_tab' });
    expect(document.body.textContent).not.toContain(S.positionStacksAboveChat);
    cleanup();
    h.chat = { enabled: false, position: 'bottom-right' };
    mount({ widget_position: 'right' });
    expect(document.body.textContent).not.toContain(S.positionStacksAboveChat);
  });
});

describe('presentation: colours and logo direction', () => {
  const field = (label: string) => {
    const box = screen.getByText(label).closest('div')!;
    return box.querySelector<HTMLInputElement>('input:not([type="color"])')!;
  };

  it('the Iranian edition: the design defaults as placeholders', () => {
    mount();
    openTab(S.tabs.presentation);
    expect(field(S.primaryColor).placeholder).toBe('#0B7D6C');
    expect(field(S.accentColor).placeholder).toBe('#12A150');
    expect(field(S.surfaceColor).placeholder).toBe('#FFFFFF');
    expect(field(S.textColor).placeholder).toBe('#0F1217');
    expect(field(S.mutedColor).placeholder).toBe('#626A77');
    expect(field(S.dangerColor).placeholder).toBe('#E5484D');
    expect(document.body.textContent).not.toContain(S.logoDirectionNote);
  });

  it('the International edition: its own defaults, and the logo-direction note', () => {
    h.edition = 'international';
    mount({ widget_template_id: 'intl' });
    openTab(S.tabs.presentation);
    expect(field(S.primaryColor).placeholder).toBe('#16142B');
    expect(field(S.accentColor).placeholder).toBe('#FF5A3C');
    expect(field(S.surfaceColor).placeholder).toBe('#FFFFFF');
    expect(field(S.textColor).placeholder).toBe('#16142B');
    expect(field(S.mutedColor).placeholder).toBe('#5E5C75');
    expect(field(S.dangerColor).placeholder).toBe('#E5432A');
    expect(document.body.textContent).toContain(S.logoDirectionNote);
  });

  it('a stored colour wins over the default', () => {
    mount({ widget_theme: { primary: '#2563eb' } });
    openTab(S.tabs.presentation);
    expect(field(S.primaryColor).value).toBe('#2563eb');
  });
});

describe('callback hours (Availability)', () => {
  it('hidden while the platform or the workspace has no callbacks', () => {
    mount({}, { platform: { callback_requests_enabled: false } });
    openTab(S.tabs.availability);
    expect(document.querySelector('[data-callback-hours]')).toBeNull();
    cleanup();
    mount({ callback_enabled: false });
    openTab(S.tabs.availability);
    expect(document.querySelector('[data-callback-hours]')).toBeNull();
  });

  it('turning slots on with no hours yet: the edition default hours (Iran: Tehran, Saturday first) are sent with it', async () => {
    mount();
    openTab(S.tabs.availability);
    const section = document.querySelector<HTMLElement>('[data-callback-hours]')!;
    expect([...section.querySelectorAll('[data-hours-day]')].map((d) => d.getAttribute('data-hours-day'))[0]).toBe('sat');
    for (const c of section.querySelectorAll<HTMLInputElement>('input[type="time"]')) expect(c.disabled).toBe(true);
    fireEvent.click(section.querySelector<HTMLElement>('[data-callback-slots]')!);
    for (const c of section.querySelectorAll<HTMLInputElement>('input[type="time"]')) expect(c.disabled).toBe(false);
    const patch = await save();
    expect(patch.callback_slots_enabled).toBe(true);
    expect(patch.business_hours).toMatchObject({ timezone: 'Asia/Tehran', weekly: { sat: [{ from: '09:00', to: '17:00' }], thu: [], fri: [] } });
  });

  it('International: a new schedule is in the browser zone', async () => {
    h.edition = 'international';
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: 'Europe/London' };
    });
    mount({ widget_template_id: 'intl' });
    openTab(S.tabs.availability);
    const section = document.querySelector<HTMLElement>('[data-callback-hours]')!;
    expect([...section.querySelectorAll('[data-hours-day]')].map((d) => d.getAttribute('data-hours-day'))[0]).toBe('mon');
    fireEvent.click(section.querySelector<HTMLElement>('[data-callback-slots]')!);
    const patch = await save();
    expect(patch.business_hours).toMatchObject({ timezone: 'Europe/London', weekly: { mon: [{ from: '09:00', to: '17:00' }], sat: [], sun: [] } });
  });

  it('slot length, days offered and callbacks per slot are sent; an emptied capacity is unlimited (null)', async () => {
    const hours = { enabled: true, timezone: 'Asia/Tehran', weekly: { sat: [{ from: '09:00', to: '12:00' }] } };
    mount({ callback_slots_enabled: true, business_hours: hours, callback_slot_capacity: 2 });
    openTab(S.tabs.availability);
    await choose(document.querySelector<HTMLElement>('[data-callback-slot-minutes]')!, '45 minutes');
    await choose(document.querySelector<HTMLElement>('[data-callback-days-ahead]')!, '7 days');
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-callback-capacity]')!, { target: { value: '' } });
    const patch = await save();
    expect(patch).toMatchObject({ callback_slot_minutes: 45, callback_days_ahead: 7, callback_slot_capacity: null });
    expect(patch).not.toHaveProperty('business_hours');
    expect(patch).not.toHaveProperty('callback_slots_enabled');
  });

  it('a capacity out of range is clamped to 1–100', async () => {
    mount({ callback_slots_enabled: true, business_hours: { weekly: { mon: [{ from: '09:00', to: '12:00' }] } } });
    openTab(S.tabs.availability);
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-callback-capacity]')!, { target: { value: '500' } });
    const patch = await save();
    expect(patch.callback_slot_capacity).toBe(100);
  });

  it('a legacy value is shown read-only, never sent, the switch waits; Replace starts a new schedule', async () => {
    mount({ business_hours: { mon: '9-5', note: 'old' } });
    openTab(S.tabs.availability);
    const section = document.querySelector<HTMLElement>('[data-callback-hours]')!;
    const legacy = section.querySelector<HTMLElement>('[data-callback-hours-legacy]')!;
    expect(legacy.textContent).toContain('"note": "old"');
    expect(section.querySelector('[data-hours-day]')).toBeNull();
    expect(section.querySelector<HTMLButtonElement>('[data-callback-slots]')!.disabled).toBe(true);
    expect(section.textContent).toContain(S.callbackHoursNeedsReplace);
    fireEvent.click(within(section).getByRole('button', { name: S.callbackHoursReplace }));
    expect(section.querySelector('[data-hours-day]')).not.toBeNull();
    expect(section.querySelector<HTMLButtonElement>('[data-callback-slots]')!.disabled).toBe(false);
    const patch = await save();
    expect(patch.business_hours).toMatchObject({ timezone: 'Asia/Tehran', weekly: { sat: [{ from: '09:00', to: '17:00' }] } });
  });

  it('a legacy value untouched is not sent with another change', async () => {
    mount({ business_hours: { mon: '9-5' } });
    fireEvent.change(displayName(), { target: { value: 'x' } });
    const patch = await save();
    expect(patch).not.toHaveProperty('business_hours');
  });

  it('slots on without any open interval: the warning', () => {
    mount({ callback_slots_enabled: true, business_hours: { timezone: 'Asia/Tehran', weekly: {} } });
    openTab(S.tabs.availability);
    expect(document.body.textContent).toContain(S.callbackHoursNoInterval);
  });

  it('a cleared time field: nothing is sent, the admin is told what to fix', async () => {
    mount({ callback_slots_enabled: true, business_hours: { timezone: 'Asia/Tehran', weekly: { sat: [{ from: '09:00', to: '12:00' }] } } });
    openTab(S.tabs.availability);
    fireEvent.change(document.querySelector<HTMLInputElement>('[data-callback-hours] input[type="time"]')!, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: en.callCenter.common.saveChanges }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: S.callbackHoursInvalid, variant: 'destructive' })));
    expect(h.mutateAsync).not.toHaveBeenCalled();
  });
});

describe('text overrides', () => {
  it('the new design texts are editable with their copy as placeholder; the home row title is named as such', () => {
    mount();
    const labels = S.widgetTextKeys;
    for (const [key, ph] of [['launcher_pill', 'تماس با پشتیبانی'], ['launcher_tab', 'تماس با ما'], ['callback_intro', 'راه ارتباطی را وارد کنید؛ تیم ما سریع تماس می‌گیرد.']] as const) {
      const label = screen.getByText(labels[key]);
      const input = label.parentElement!.querySelector<HTMLInputElement>('input')!;
      expect(input.placeholder).toBe(ph);
    }
    expect(labels.request_callback_instead).toBe('Home callback row title');
    expect(screen.getByText(labels.request_callback_instead)).toBeTruthy();
  });

  it('an override is saved under its locale', async () => {
    mount();
    const input = screen.getByText(S.widgetTextKeys.launcher_pill).parentElement!.querySelector<HTMLInputElement>('input')!;
    fireEvent.change(input, { target: { value: 'زنگ بزنید' } });
    const patch = await save();
    expect(patch.widget_custom_texts).toEqual({ fa: { launcher_pill: 'زنگ بزنید' } });
  });

  it('grouped by where they show, every text the widget draws there (offline status, badge, short labels included)', () => {
    const { container } = mount();
    expect([...container.querySelectorAll('[data-cc-texts-group]')].map((g) => g.getAttribute('data-cc-texts-group')))
      .toEqual(['launcher', 'header', 'home', 'offline']);
    for (const key of ['support', 'offline', 'no_operator_now', 'live_now', 'channel_voice', 'video', 'offline_title', 'offline_message']) {
      expect(container.querySelector(`[data-cc-text="${key}"]`), key).not.toBeNull();
    }
    expect(container.querySelector<HTMLInputElement>('[data-cc-text="talk_now"]')!.maxLength).toBe(200);
  });

  it('a text is saved trimmed; one left blank is not saved at all', async () => {
    const { container } = mount();
    fireEvent.change(container.querySelector('[data-cc-text="talk_now"]')!, { target: { value: '  همین حالا  ' } });
    fireEvent.change(container.querySelector('[data-cc-text="live_support"]')!, { target: { value: '   ' } });
    const patch = await save();
    expect(patch.widget_custom_texts).toEqual({ fa: { talk_now: 'همین حالا' } });
  });

  it('the preview shows the language being edited, with its texts, and the state of the field being edited', async () => {
    const { container } = mount();
    expect(previewBoot().boot.i18n.default_locale).toBe('fa');
    await choose(container.querySelector<HTMLElement>('[data-cc-texts-locale]')!, 'English');
    expect(previewBoot().boot.i18n.default_locale).toBe('en');
    fireEvent.change(container.querySelector('[data-cc-text="talk_to_team"]')!, { target: { value: 'Hello there' } });
    expect((previewBoot().boot.config.custom_texts as Record<string, Record<string, string>>).en.talk_to_team).toBe('Hello there');
    fireEvent.focus(container.querySelector('[data-cc-text="offline_title"]')!);
    expect(previewBoot().boot.capabilities.voice).toBe(false);
    fireEvent.focus(container.querySelector('[data-cc-text="talk_now"]')!);
    expect(previewBoot().boot.capabilities.voice).toBe(true);
  });

  it('callback texts are hidden while the workspace takes no callbacks', () => {
    const { container } = mount({ callback_enabled: false });
    expect(container.querySelector('[data-cc-text="request_callback"]')).toBeNull();
    expect(container.querySelector('[data-cc-text="offline_title"]')).not.toBeNull();
  });
});

describe('the live preview', () => {
  it('loads the panel module before the engine and mounts the new design bootstrap (Iranian edition)', () => {
    h.members = [
      { user_id: 'u2', role: 'agent', full_name: 'Sara Ahmadi', email: 'sara@x.test', avatar_url: 'https://cdn/x.png', created_at: '2026-01-02T00:00:00Z' },
      { user_id: 'u1', role: 'owner', full_name: null, email: 'boss@x.test', avatar_url: null, created_at: '2026-01-01T00:00:00Z' },
    ];
    mount({ launcher_style: 'card', widget_position: 'bottom-left' });
    const { doc, boot } = previewBoot();
    const scripts = [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
    expect(scripts).toEqual([
      '/call-widget/presentation-registry.js',
      '/call-widget/presentation-default.js',
      '/call-widget/presentation-default-panel.js',
      '/call-widget/runtime.js',
    ]);
    expect(boot.edition).toBe('iran');
    expect(boot.calendar).toBe('jalali');
    expect(boot.time_zone).toBe('Asia/Tehran');
    expect(boot.assets).toEqual({
      font_style_url: '/widget/presentation-default-fonts.css',
      presentation_style_url: '/call-widget/presentation-default.css',
      presentation_panel_script_url: '/call-widget/presentation-default-panel.js',
      presentation_panel_style_url: '/call-widget/presentation-default-panel.css',
    });
    expect(boot.config.launcher_style).toBe('card');
    expect(boot.config.widget_position).toBe('left');
    expect(boot.config).not.toHaveProperty('logoDirection');
    expect(boot.presence).toEqual({
      any_available: true,
      operators: [{ name: null, initial: '', avatar_url: null }, { name: 'Sara Ahmadi', initial: 'S', avatar_url: null }],
    });
    expect(JSON.stringify(boot)).not.toContain('@');
  });

  it('styles without operators get presence without names; offline: no voice or video, nobody available', async () => {
    h.members = [{ user_id: 'u2', role: 'agent', full_name: 'Sara', email: null, avatar_url: null, created_at: null }];
    mount({ launcher_style: 'pill' });
    expect(previewBoot().boot.presence).toEqual({ any_available: true });
    await choose(document.querySelector<HTMLElement>('[data-preview-state]')!, S.previewOffline);
    const { boot } = previewBoot();
    expect(boot.capabilities).toMatchObject({ voice: false, video: false, callback: true });
    expect(boot.presence).toEqual({ any_available: false });
  });

  it('an unknown stored style previews as round_label; the draft style follows the picker', () => {
    mount({ launcher_style: 'sparkle' });
    expect(previewBoot().boot.config.launcher_style).toBe('round_label');
    cleanup();
    mount({}, { design: false });
    expect(previewBoot().boot.config.launcher_style).toBe('round_label');
  });

  it('International: its skin, Gregorian dates in the visitor zone, the chat widget logo direction', () => {
    h.edition = 'international';
    h.chat = { enabled: true, position: 'bottom-right', widget_template_id: 't1-intl', widget_template_options: { logoDirection: 'open' } };
    mount({ widget_template_id: 'intl' });
    const { boot } = previewBoot();
    expect(boot.edition).toBe('international');
    expect(boot.calendar).toBe('gregorian');
    expect(boot.time_zone).toBeNull();
    expect(boot.assets.presentation_style_url).toBe('/call-widget/presentation-intl.css');
    expect(boot.assets.font_style_url).toBe('/widget/presentation-default-fonts.css');
    expect(boot.config.widget_template_id).toBe('intl');
    expect(boot.config.logoDirection).toBe('open');
    cleanup();
    h.chat = { enabled: true, position: 'bottom-right', widget_template_id: 'intl', widget_template_options: { logoDirection: 'open' } };
    mount({ widget_template_id: 'intl' });
    expect(previewBoot().boot.config.logoDirection).toBe('thread');
  });

  it('slots from the draft hours while slots are on; none while off', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T07:30:00Z')); // Thursday 11:00 in Tehran
    const hours = { timezone: 'Asia/Tehran', weekly: { thu: [{ from: '10:00', to: '12:00' }], sat: [{ from: '09:00', to: '10:00' }] } };
    mount({ callback_slots_enabled: true, business_hours: hours, callback_slot_minutes: 30, callback_days_ahead: 2 });
    const slots = previewBoot().boot.callback_policy.slots as Array<{ at: string; available: boolean }>;
    expect(slots).toEqual([
      { at: '2026-10-22T10:00:00+03:30', available: false },
      { at: '2026-10-22T10:30:00+03:30', available: false },
      { at: '2026-10-22T11:00:00+03:30', available: false },
      { at: '2026-10-22T11:30:00+03:30', available: true },
      { at: '2026-10-24T09:00:00+03:30', available: true },
      { at: '2026-10-24T09:30:00+03:30', available: true },
    ]);
    cleanup();
    mount({ callback_slots_enabled: false, business_hours: hours });
    expect(previewBoot().boot.callback_policy).not.toHaveProperty('slots');
  });

  it('desktop: a frame wider than the phone breakpoint and tall enough for the whole panel, scaled to fit; phone: 390 wide', () => {
    mount();
    const frame = previewBoot().frame;
    const width = parseFloat(frame.style.width);
    const height = parseFloat(frame.style.height);
    expect(width).toBeGreaterThan(640);
    expect(height - 130).toBeGreaterThanOrEqual(660);
    expect(frame.closest('[data-preview-frame]')!.getAttribute('data-device')).toBe('desktop');
    fireEvent.click(screen.getByRole('radio', { name: S.previewPhone }));
    const phone = previewBoot().frame;
    expect(parseFloat(phone.style.width)).toBe(390);
    expect(phone.closest('[data-preview-frame]')!.getAttribute('data-device')).toBe('phone');
  });

  it('the bootstrap is inert JSON in the frame (no "<" can close the script)', () => {
    mount({ display_name: '</script><script>alert(1)</script>' });
    const { frame, boot } = previewBoot();
    expect(boot.config.display_name).toBe('</script><script>alert(1)</script>');
    expect((frame.getAttribute('srcdoc') || '').match(/<script>alert/)).toBeNull();
  });
});

describe('act warnings stay away', () => {
  it('renders without throwing in both editions', async () => {
    for (const edition of ['iran', 'international'] as const) {
      h.edition = edition;
      await act(async () => { mount(); });
      cleanup();
    }
  });
});

describe('review fixes (verify round 4)', () => {
  it('Persian: slot lengths and days offered print Persian digits, like the one-day option (no mixed digits)', async () => {
    const F = fa.callCenter.settingsPage;
    mount({ callback_slots_enabled: true, business_hours: { weekly: { sat: [{ from: '09:00', to: '12:00' }] } } }, { locale: 'fa' });
    openTab(F.tabs.availability);
    const minutes = document.querySelector<HTMLElement>('[data-callback-slot-minutes]')!;
    expect(minutes.textContent).toBe('۳۰ دقیقه');
    const days = document.querySelector<HTMLElement>('[data-callback-days-ahead]')!;
    expect(days.textContent).toBe('۴ روز');
    fireEvent.keyDown(days, { key: 'Enter' });
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent || '');
    expect(names).toHaveLength(14);
    expect(names[0]).toBe(F.callbackHoursDayOne);
    for (const name of names) expect(name).not.toMatch(/[0-9]/);
  });

  it('the preview speaks the languages the bootstrap would: the platform\'s while the workspace chose none', () => {
    mount({ widget_default_locale: null, widget_enabled_locales: null });
    expect(previewBoot().boot.i18n).toEqual({ default_locale: 'fa', available_locales: ['fa', 'en', 'tr'] });
    cleanup();
    mount({ widget_default_locale: 'en', widget_enabled_locales: ['en', 'tr'] });
    expect(previewBoot().boot.i18n).toEqual({ default_locale: 'en', available_locales: ['en', 'tr'] });
  });

  it('the preview offers only the channels the platform allows', () => {
    mount({}, { platform: { voice_calls_enabled: false, callback_requests_enabled: false } });
    const { boot } = previewBoot();
    expect(boot.capabilities).toMatchObject({ voice: false, video: true, callback: false });
    expect(boot.callback_policy.enabled).toBe(false);
  });

  it('an old backend refusing a new key (rolling deploy): the "try again in a few minutes" message, not a bare invalid_body', async () => {
    h.mutateAsync.mockRejectedValueOnce(Object.assign(new Error('invalid_body'), {
      status: 400, code: 'invalid_body', details: { formErrors: ["Unrecognized key(s) in object: 'launcher_style'"], fieldErrors: {} },
    }));
    mount();
    openTab(S.tabs.presentation);
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-call-launcher-style="pill"]')!);
    await save();
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: S.migrationPending, variant: 'destructive' })));
  });

  it('the new controls have names: placement, the slots switch, slot length, days offered', () => {
    mount({ callback_slots_enabled: true, business_hours: { weekly: { sat: [{ from: '09:00', to: '12:00' }] } } });
    expect(screen.getByRole('combobox', { name: S.widgetPosition })).toBeTruthy();
    openTab(S.tabs.availability);
    expect(screen.getByRole('switch', { name: S.callbackHoursSlots })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: S.callbackHoursSlotMinutes })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: S.callbackHoursDaysAhead })).toBeTruthy();
  });
});
