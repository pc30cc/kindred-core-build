/**
 * Widget → Availability (the chat's business hours): what the editor writes.
 *
 * The weekly schedule, its time zone and the date overrides moved into a
 * shared WeeklyHoursEditor (the call center's callback hours use it too,
 * 2026-10 call widget design, B4). The chat's editor must write exactly what
 * it wrote before: the whole normalised hours object through onSave, every
 * control disabled while the hours are off, Monday first.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { WidgetSettings } from '@/types/models';

vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'single', allowedLocales: ['en'], canSwitchLanguage: false, currency: 'USD' }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const { AvailabilitySection } = await import('@/components/app/widget/AvailabilitySection');

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

afterEach(cleanup);

const HOURS = {
  enabled: true,
  timezone: 'Europe/Istanbul',
  weekly: { mon: [{ from: '09:00', to: '18:00' }], tue: [], sat: [{ from: '10:00', to: '14:00' }] },
  overrides: [{ date: '2026-10-29', closed: true }],
};

function mount(hours: unknown = HOURS) {
  const onSave = vi.fn();
  const settings = { business_hours: hours, offline_mode: 'capture_message', live_chat_enabled: true } as unknown as WidgetSettings;
  const view = render(
    <I18nProvider initialLocale="en" initialTranslations={en}>
      <AvailabilitySection workspaceId="ws-1" settings={settings} onSave={onSave} saving={false} />
    </I18nProvider>,
  );
  return { onSave, view };
}

/** The normalised hours (every day present, Monday first) the editor saves. */
const normalised = {
  enabled: true,
  timezone: 'Europe/Istanbul',
  weekly: {
    mon: [{ from: '09:00', to: '18:00' }], tue: [], wed: [], thu: [], fri: [], sat: [{ from: '10:00', to: '14:00' }], sun: [],
  },
  overrides: [{ date: '2026-10-29', closed: true }],
};

describe('the chat business hours editor', () => {
  it('lists the seven days Monday first, a closed day marked, the stored intervals as time fields', () => {
    const { view } = mount();
    const text = view.container.textContent || '';
    const order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => text.indexOf(d));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const times = [...view.container.querySelectorAll<HTMLInputElement>('input[type="time"]')].map((i) => i.value);
    expect(times).toEqual(['09:00', '18:00', '10:00', '14:00']);
    expect(view.container.querySelector<HTMLInputElement>('input[type="date"]')!.value).toBe('2026-10-29');
  });

  it('adding an interval saves the whole normalised hours object with 09:00–17:00 on that day', () => {
    const { onSave, view } = mount();
    const addButtons = within(view.container).getAllByRole('button', { name: /Add interval/ });
    fireEvent.click(addButtons[1]); // Tuesday
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toEqual({
      business_hours: { ...normalised, weekly: { ...normalised.weekly, tue: [{ from: '09:00', to: '17:00' }] } },
    });
  });

  it('editing a time, removing an interval and copying Monday to Friday write the same shape', () => {
    const { onSave, view } = mount();
    fireEvent.change(view.container.querySelectorAll<HTMLInputElement>('input[type="time"]')[1], { target: { value: '17:30' } });
    expect(onSave.mock.calls[0][0].business_hours.weekly.mon).toEqual([{ from: '09:00', to: '17:30' }]);
    fireEvent.click(screen.getByRole('button', { name: /Copy Mon/ }));
    const copied = onSave.mock.calls[1][0].business_hours.weekly;
    for (const d of ['tue', 'wed', 'thu', 'fri']) expect(copied[d]).toEqual([{ from: '09:00', to: '18:00' }]);
    expect(copied.sat).toEqual([{ from: '10:00', to: '14:00' }]);
  });

  it('an interval that ends before it starts shows the error under its day', () => {
    const { view } = mount({ ...HOURS, weekly: { mon: [{ from: '18:00', to: '09:00' }] } });
    expect(view.container.textContent).toContain(en.widgetPage.availability.endAfterStart);
  });

  it('a new override is today, closed', () => {
    const { onSave } = mount();
    fireEvent.click(screen.getByRole('button', { name: /Add override/ }));
    const overrides = onSave.mock.calls[0][0].business_hours.overrides;
    expect(overrides).toHaveLength(2);
    expect(overrides[1]).toEqual({ date: new Date().toISOString().slice(0, 10), closed: true });
  });

  it('every hours control is disabled while the hours are off; a stored {} reads as the hours off, UTC', () => {
    const { view } = mount({});
    const times = view.container.querySelectorAll<HTMLInputElement>('input[type="time"]');
    expect(times.length).toBe(0);
    for (const b of within(view.container).getAllByRole('button', { name: /Add interval/ })) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.textContent).toContain('UTC');
  });
});
