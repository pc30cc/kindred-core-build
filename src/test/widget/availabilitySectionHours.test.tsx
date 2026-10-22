/**
 * Widget → Availability (the chat's business hours): what the editor writes,
 * and what the tab says.
 *
 * The weekly schedule, its time zone and the date overrides live in the
 * shared WeeklyHoursEditor (the call center's callback hours use it too).
 * The tab writes the whole normalised hours object through `onChange`,
 * drafted at once and saved after a delay (the page's draft layer, W-05);
 * hours an interval of which would never match stay a draft (W-12).
 *
 *   - the week starts on the edition's first day (Saturday in Iran, Monday
 *     International); with no schedule yet the zone shown is the one turning
 *     the hours on writes (Tehran / the admin's zone), and turning them on
 *     with no interval starts the edition's working week (W-12);
 *   - the offline behaviour applies with or without business hours (the
 *     widget is offline whenever no operator is available): its radios are
 *     always enabled, an old stored value reads as the form (W-01, R-08);
 *   - "Online during business hours" only applies with a schedule (W-09);
 *   - the "Now" card is the server's answer, never "always online" (R-08);
 *   - the copy fields carry the server's caps (W-02).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { WidgetSettings } from '@/types/models';

const flags = vi.hoisted(() => ({ edition: 'international' as 'iran' | 'international' }));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'single', allowedLocales: ['en'], canSwitchLanguage: false, currency: 'USD' }),
}));
vi.mock('@/hooks/useEdition', () => ({
  useEdition: () => ({ edition: flags.edition, isInternational: flags.edition === 'international', ready: true }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { AvailabilitySection } = await import('@/components/app/widget/AvailabilitySection');

const A = en.widgetPage.availability;
let nowAnswer: Record<string, unknown>;
const fetchMock = vi.fn(async (url: string) => {
  if (String(url).includes('/availability')) return new Response(JSON.stringify(nowAnswer), { status: 200 });
  return new Response('{}', { status: 404 });
});

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  flags.edition = 'international';
  nowAnswer = {
    state: 'online', reason: 'within_hours', next_open_at: null, timezone: 'Europe/Istanbul', offline_mode: 'capture_message',
    business_hours_allowed: true, operators: { members: 2, available: 1 }, checked_at: '2026-10-21T10:00:00Z',
  };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HOURS = {
  enabled: true,
  timezone: 'Europe/Istanbul',
  weekly: { mon: [{ from: '09:00', to: '18:00' }], tue: [], sat: [{ from: '10:00', to: '14:00' }] },
  overrides: [{ date: '2026-10-29', closed: true }],
};

function mount(hours: unknown = HOURS, extra: Record<string, unknown> = {}) {
  const onChange = vi.fn();
  const settings = { business_hours: hours, offline_mode: 'capture_message', live_chat_enabled: true, ...extra } as unknown as WidgetSettings;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <AvailabilitySection workspaceId="ws-1" settings={settings} onChange={onChange} saving={false} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onChange, view };
}

/** The normalised hours (every day present) the editor saves. */
const normalised = {
  enabled: true,
  timezone: 'Europe/Istanbul',
  weekly: {
    mon: [{ from: '09:00', to: '18:00' }], tue: [], wed: [], thu: [], fri: [], sat: [{ from: '10:00', to: '14:00' }], sun: [],
  },
  overrides: [{ date: '2026-10-29', closed: true }],
};
const dayOrder = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-hours-day]')].map((el) => el.getAttribute('data-hours-day'));

describe('the chat business hours editor', () => {
  it('International: Monday first; Iran: Saturday first; the stored intervals as time fields', () => {
    const { view } = mount();
    expect(dayOrder(view.container)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    const times = [...view.container.querySelectorAll<HTMLInputElement>('[data-hours-day] input[type="time"]')].map((i) => i.value);
    expect(times).toEqual(['09:00', '18:00', '10:00', '14:00']);
    expect(view.container.querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-10-29');
    cleanup();
    flags.edition = 'iran';
    const iran = mount();
    expect(dayOrder(iran.view.container)).toEqual(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']);
  });

  it('adding an interval drafts the whole normalised hours object and saves it after a delay', () => {
    const { onChange, view } = mount();
    const tue = view.container.querySelector<HTMLElement>('[data-hours-day="tue"]')!;
    fireEvent.click(within(tue).getByRole('button', { name: /Add interval/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]).toEqual([
      { business_hours: { ...normalised, weekly: { ...normalised.weekly, tue: [{ from: '09:00', to: '17:00' }] } } },
      { delay: 500, draftOnly: false },
    ]);
  });

  it('editing a time and copying Monday to Friday write the same shape', () => {
    const { onChange, view } = mount();
    const mon = view.container.querySelector<HTMLElement>('[data-hours-day="mon"]')!;
    fireEvent.change(mon.querySelectorAll<HTMLInputElement>('input[type="time"]')[1], { target: { value: '17:30' } });
    expect(onChange.mock.calls[0][0].business_hours.weekly.mon).toEqual([{ from: '09:00', to: '17:30' }]);
    fireEvent.click(screen.getByRole('button', { name: /Copy Mon/ }));
    const copied = onChange.mock.calls[1][0].business_hours.weekly;
    for (const d of ['tue', 'wed', 'thu', 'fri']) expect(copied[d]).toEqual([{ from: '09:00', to: '18:00' }]);
    expect(copied.sat).toEqual([{ from: '10:00', to: '14:00' }]);
  });

  it('an interval that ends before it starts (overnight) shows the error under its day and is never saved', () => {
    const { onChange, view } = mount();
    const mon = view.container.querySelector<HTMLElement>('[data-hours-day="mon"]')!;
    fireEvent.change(mon.querySelectorAll<HTMLInputElement>('input[type="time"]')[1], { target: { value: '02:00' } });
    expect(onChange.mock.calls[0][1]).toEqual({ delay: 500, draftOnly: true });
    cleanup();
    const shown = mount({ ...HOURS, weekly: { mon: [{ from: '22:00', to: '02:00' }] } });
    expect(within(shown.view.container.querySelector<HTMLElement>('[data-hours-day="mon"]')!).getByRole('alert').textContent)
      .toBe(A.endAfterStart);
  });

  it('a new override is today, closed; opening it starts from that weekday\'s hours, editable, never saved while invalid', () => {
    const { onChange } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Add override/ }));
    const overrides = onChange.mock.calls[0][0].business_hours.overrides;
    expect(overrides).toHaveLength(2);
    expect(overrides[1]).toEqual({ date: new Date().toISOString().slice(0, 10), closed: true });
    cleanup();

    // 2026-10-26 is a Monday: its special hours start from Monday's.
    const open = mount({ ...HOURS, overrides: [{ date: '2026-10-26', closed: true }] });
    const ov = open.view.container.querySelector<HTMLElement>('[data-hours-override="0"]')!;
    fireEvent.click(within(ov).getByRole('switch', { name: A.overrideClosed }));
    expect(open.onChange.mock.calls[0][0].business_hours.overrides).toEqual([
      { date: '2026-10-26', closed: false, intervals: [{ from: '09:00', to: '18:00' }] },
    ]);
    cleanup();

    const special = mount({ ...HOURS, overrides: [{ date: '2026-10-26', closed: false, intervals: [{ from: '10:00', to: '13:00' }] }] });
    const box = special.view.container.querySelector<HTMLElement>('[data-hours-override="0"]')!;
    expect([...box.querySelectorAll<HTMLInputElement>('input[type="time"]')].map((i) => i.value)).toEqual(['10:00', '13:00']);
    fireEvent.change(box.querySelectorAll<HTMLInputElement>('input[type="time"]')[1], { target: { value: '09:00' } });
    expect(special.onChange.mock.calls[0]).toEqual([
      { business_hours: { ...normalised, overrides: [{ date: '2026-10-26', closed: false, intervals: [{ from: '10:00', to: '09:00' }] }] } },
      { delay: 500, draftOnly: true },
    ]);
    fireEvent.click(within(box).getByRole('button', { name: /Add interval/ }));
    expect(special.onChange.mock.calls[1][0].business_hours.overrides[0].intervals).toEqual([
      { from: '10:00', to: '13:00' }, { from: '09:00', to: '17:00' },
    ]);
  });

  it('an open override without hours says it is closed all day', () => {
    const { view } = mount({ ...HOURS, overrides: [{ date: '2026-10-26', closed: false, intervals: [] }] });
    expect(view.container.querySelector('[data-hours-override="0"]')!.textContent).toContain(A.overrideNoHours);
  });

  it('every hours control is disabled while the hours are off; with no schedule the zone is the one turning them on writes', () => {
    flags.edition = 'iran';
    const { view } = mount({ enabled: false, timezone: 'UTC', schedule: [] });
    expect(view.container.querySelectorAll('[data-hours-day] input[type="time"]').length).toBe(0);
    for (const b of within(view.container).getAllByRole('button', { name: /Add interval/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.querySelector('[data-hours-timezone]')!.textContent).toContain('(UTC+3:30)');
    cleanup();
    // Hours on (or a schedule) and no zone stored: what the server uses, UTC.
    const legacy = mount({ enabled: true, weekly: { mon: [{ from: '09:00', to: '17:00' }] } });
    expect(legacy.view.container.querySelector('[data-hours-timezone]')!.textContent).toContain('(UTC)');
  });

  it('turning the hours on with no interval starts the edition\'s working week (Iran: Saturday to Wednesday, Tehran), saved at once', () => {
    flags.edition = 'iran';
    const { onChange } = mount({ enabled: false, timezone: 'UTC', schedule: [] });
    fireEvent.click(screen.getByRole('switch', { name: A.enableHours }));
    const [patch, opts] = onChange.mock.calls[0];
    expect(opts).toEqual({ delay: 0, draftOnly: false });
    expect(patch.business_hours.enabled).toBe(true);
    expect(patch.business_hours.timezone).toBe('Asia/Tehran');
    const open = Object.entries(patch.business_hours.weekly).filter(([, list]) => (list as unknown[]).length).map(([d]) => d).sort();
    expect(open).toEqual(['mon', 'sat', 'sun', 'tue', 'wed']);
    expect(patch.business_hours.weekly.sat).toEqual([{ from: '09:00', to: '17:00' }]);
  });

  it('turning the hours off is saved even while an interval is wrong (it applies to nothing then)', () => {
    const { onChange } = mount({ ...HOURS, weekly: { mon: [{ from: '22:00', to: '02:00' }] } });
    fireEvent.click(screen.getByRole('switch', { name: A.enableHours }));
    expect(onChange.mock.calls[0][0].business_hours.enabled).toBe(false);
    expect(onChange.mock.calls[0][1]).toEqual({ delay: 0, draftOnly: false });
  });

  it('turning hours on that already name intervals keeps them', () => {
    const { onChange } = mount({ ...HOURS, enabled: false });
    fireEvent.click(screen.getByRole('switch', { name: A.enableHours }));
    expect(onChange.mock.calls[0][0].business_hours).toEqual(normalised);
  });
});

describe('the offline behaviour and "Online during business hours"', () => {
  it('the offline radios stay enabled with business hours off; choosing one saves at once', () => {
    const { onChange } = mount({ enabled: false, timezone: 'UTC' });
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    for (const r of radios) expect(r.disabled).toBe(false);
    fireEvent.click(radios.find((r) => r.value === 'hide_widget')!);
    expect(onChange).toHaveBeenCalledWith({ offline_mode: 'hide_widget' }, { delay: 0 });
  });

  it('an old stored value (accept_messages) shows the form as chosen', () => {
    mount(HOURS, { offline_mode: 'accept_messages' });
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.filter((r) => r.checked).map((r) => r.value)).toEqual(['capture_message']);
  });

  it('"Online during business hours" is disabled without a schedule, and saves at once with one', () => {
    mount({ enabled: false, timezone: 'UTC' });
    expect((screen.getByRole('switch', { name: A.liveChatEnabled }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain(A.liveChatHintHoursOff);
    cleanup();
    const { onChange } = mount();
    fireEvent.click(screen.getByRole('switch', { name: A.liveChatEnabled }));
    expect(onChange).toHaveBeenCalledWith({ live_chat_enabled: false }, { delay: 0 });
  });

  it('the copy fields carry the server\'s caps', () => {
    const { view } = mount();
    const inputs = [...view.container.querySelectorAll<HTMLInputElement>('input')].filter((i) =>
      i.placeholder === A.onlinePlaceholder || i.placeholder === A.offlinePlaceholder);
    expect(inputs).toHaveLength(2);
    for (const i of inputs) expect(i.maxLength).toBe(100);
    const message = [...view.container.querySelectorAll<HTMLTextAreaElement>('textarea')].find((x) => x.placeholder === A.offlineMessagePlaceholder)!;
    expect(message.maxLength).toBe(2000);
  });
});

describe('the "Now" card (the server\'s answer)', () => {
  it('business hours off and nobody available: offline, with the reason and the operators, never "always online"', async () => {
    nowAnswer = { ...nowAnswer, state: 'offline', reason: 'no_operators_online', operators: { members: 3, available: 0 } };
    const { view } = mount({ enabled: false, timezone: 'UTC' });
    await waitFor(() => expect(view.container.querySelector('[data-availability-now="offline"]')).not.toBeNull());
    const card = view.container.querySelector<HTMLElement>('[data-availability-now]')!;
    expect(card.textContent).toContain(A.offline);
    expect(card.textContent).toContain(A.reasonNoOperators);
    expect(card.textContent).toContain('Operators available to visitors now: 0 of 3');
    expect(view.container.textContent).not.toMatch(/always online/i);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/widget-settings\/ws-1\/availability\?locale=en$/);
  });

  it('outside business hours: when it opens again; a plan without hours says they are not applied', async () => {
    nowAnswer = { ...nowAnswer, state: 'offline', reason: 'outside_hours', next_open_at: '2026-10-22T06:00:00Z', business_hours_allowed: false };
    const { view } = mount();
    await waitFor(() => expect(view.container.querySelector('[data-availability-now="offline"]')).not.toBeNull());
    const card = view.container.querySelector<HTMLElement>('[data-availability-now]')!;
    expect(card.textContent).toContain(A.reasonOutside);
    expect(card.textContent).toMatch(/Opens again Thursday,? 09:00/);
    expect(card.textContent).toContain(A.planNotApplied);
  });

  it('always_offline: live chat paused vs no interval', async () => {
    nowAnswer = { ...nowAnswer, state: 'offline', reason: 'always_offline' };
    const paused = mount(HOURS, { live_chat_enabled: false });
    await waitFor(() => expect(paused.view.container.textContent).toContain(A.reasonChatDisabled));
    cleanup();
    const empty = mount({ enabled: true, timezone: 'UTC', weekly: {} });
    await waitFor(() => expect(empty.view.container.textContent).toContain(A.reasonNoIntervals));
  });

  it('an unanswered check says so instead of guessing', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{"error":"x"}', { status: 500 }));
    const { view } = mount();
    await waitFor(() => expect(view.container.querySelector('[data-availability-now="error"]')).not.toBeNull());
    expect(view.container.querySelector('[data-availability-now]')!.textContent).toContain(A.nowUnavailable);
  });
});
