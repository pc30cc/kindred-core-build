/**
 * The weekly hours editor shared by the chat's business hours and the call
 * center's callback hours (WeeklyHoursEditor, 2026-10 call widget design B4):
 * the time zone, the seven days and the date overrides, written as one
 * hours object through onChange.
 *
 *   - the days start on Monday (the chat, as before) or Saturday (the
 *     Iranian week, the call center in the Iranian edition);
 *   - a zone that is not in the short list (an International browser's own
 *     zone) is still offered and shown;
 *   - disabled: every control.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { BusinessHoursConfig } from '@/types/models';
import { WeeklyHoursEditor } from '@/components/app/widget/WeeklyHoursEditor';
import { hoursProblem, intervalsProblem } from '@/components/app/widget/businessHoursProblems';

vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

afterEach(cleanup);

const HOURS: BusinessHoursConfig = {
  enabled: true,
  timezone: 'America/Sao_Paulo',
  weekly: { mon: [{ from: '09:00', to: '17:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
  overrides: [],
};

function mount(props: Partial<Parameters<typeof WeeklyHoursEditor>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <I18nProvider initialLocale="en" initialTranslations={en}>
      <WeeklyHoursEditor hours={HOURS} onChange={onChange} {...props} />
    </I18nProvider>,
  );
  return { onChange, view };
}

const dayOrder = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-hours-day]')].map((el) => el.getAttribute('data-hours-day'));

describe('WeeklyHoursEditor', () => {
  it('Monday first by default; Saturday first when asked', () => {
    const a = mount();
    expect(dayOrder(a.view.container)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    cleanup();
    const b = mount({ firstDay: 'sat' });
    expect(dayOrder(b.view.container)).toEqual(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']);
  });

  it('a zone outside the short list is shown and offered', async () => {
    const { view } = mount();
    const trigger = view.container.querySelector<HTMLElement>('[data-hours-timezone]')!;
    // Its name in the page's language and its offset (Brazil keeps UTC-3 all year).
    expect(trigger.textContent).toContain('(UTC-3)');
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(14);
    expect(options[13].textContent).toContain('(UTC-3)');
  });

  it('choosing a zone writes it', async () => {
    const { onChange, view } = mount();
    fireEvent.keyDown(view.container.querySelector<HTMLElement>('[data-hours-timezone]')!, { key: 'Enter' });
    fireEvent.click((await screen.findAllByRole('option')).find((o) => (o.textContent || '').includes('UTC+3:30'))!);
    expect(onChange).toHaveBeenCalledWith({ ...HOURS, timezone: 'Asia/Tehran' });
  });

  it('adding, editing and removing an interval write the whole hours object', () => {
    const { onChange, view } = mount();
    const tue = view.container.querySelector<HTMLElement>('[data-hours-day="tue"]')!;
    fireEvent.click(within(tue).getByRole('button', { name: /Add interval/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...HOURS, weekly: { ...HOURS.weekly, tue: [{ from: '09:00', to: '17:00' }] } });
    const mon = view.container.querySelector<HTMLElement>('[data-hours-day="mon"]')!;
    fireEvent.change(mon.querySelectorAll('input[type="time"]')[0], { target: { value: '08:30' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...HOURS, weekly: { ...HOURS.weekly, mon: [{ from: '08:30', to: '17:00' }] } });
    fireEvent.click(within(mon).getByRole('button', { name: en.widgetPage.availability.removeInterval }));
    expect(onChange).toHaveBeenLastCalledWith({ ...HOURS, weekly: { ...HOURS.weekly, mon: [] } });
  });

  it('limits (the call center\'s strict hours): no seventh interval a day, no 61st override, labels up to 120 characters', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` }));
    const sixty = Array.from({ length: 60 }, () => ({ date: '2026-10-29', closed: true }));
    const { view } = mount({
      hours: { ...HOURS, weekly: { ...HOURS.weekly, mon: six }, overrides: sixty },
      limits: { intervalsPerDay: 6, overrides: 60, labelLength: 120 },
    });
    const mon = view.container.querySelector<HTMLElement>('[data-hours-day="mon"]')!;
    const tue = view.container.querySelector<HTMLElement>('[data-hours-day="tue"]')!;
    expect(within(mon).getByRole<HTMLButtonElement>('button', { name: /Add interval/ }).disabled).toBe(true);
    expect(within(tue).getByRole<HTMLButtonElement>('button', { name: /Add interval/ }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Add override/ }).disabled).toBe(true);
    for (const label of screen.getAllByPlaceholderText(en.widgetPage.availability.overrideLabel)) {
      expect((label as HTMLInputElement).maxLength).toBe(120);
    }
  });

  it('without limits: no cap', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ from: `0${i}:00`, to: `0${i}:30` }));
    const { view } = mount({ hours: { ...HOURS, weekly: { ...HOURS.weekly, mon: six }, overrides: [{ date: '2026-10-29', closed: true }] } });
    const mon = view.container.querySelector<HTMLElement>('[data-hours-day="mon"]')!;
    expect(within(mon).getByRole<HTMLButtonElement>('button', { name: /Add interval/ }).disabled).toBe(false);
    expect(screen.getByPlaceholderText(en.widgetPage.availability.overrideLabel).hasAttribute('maxlength')).toBe(false);
  });

  it('hoursProblem: what the server refuses (an end not after its start, a bad time, an unknown zone), a closed override aside', () => {
    expect(hoursProblem(HOURS)).toBeNull();
    expect(intervalsProblem([{ from: '22:00', to: '02:00' }])).toBe('endAfterStart');
    expect(intervalsProblem([{ from: '09:00', to: '09:00' }])).toBe('endAfterStart');
    expect(intervalsProblem([{ from: '24:00', to: '25:00' }])).toBe('invalidTime');
    expect(hoursProblem({ ...HOURS, weekly: { ...HOURS.weekly, fri: [{ from: '9', to: '17:00' }] } })).toBe('invalidTime');
    expect(hoursProblem({ ...HOURS, timezone: 'Mars/Olympus' })).toBe('invalidTimezone');
    expect(hoursProblem({ ...HOURS, overrides: [{ date: '2026-10-29', intervals: [{ from: '18:00', to: '10:00' }] }] })).toBe('endAfterStart');
    expect(hoursProblem({ ...HOURS, overrides: [{ date: '2026-10-29', closed: true, intervals: [{ from: '18:00', to: '10:00' }] }] })).toBeNull();
  });

  it('a timezone this browser does not know is flagged under the select', () => {
    const { view } = mount({ hours: { ...HOURS, timezone: 'Mars/Olympus' } });
    expect(view.container.textContent).toContain(en.widgetPage.availability.invalidTimezone);
  });

  it('disabled: every control', () => {
    const { view } = mount({ disabled: true });
    const controls = view.container.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button');
    expect(controls.length).toBeGreaterThan(5);
    for (const c of controls) expect(c.disabled).toBe(true);
  });
});
