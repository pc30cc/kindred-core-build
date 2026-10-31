/**
 * Super Admin → Branding → General → Time zone (owner, 2026-10-31: "make the
 * time zone selectable"): a searchable list of every IANA zone, each by its
 * name and offset (src/lib/timeZones.ts, src/components/common/TimeZoneSelect.tsx).
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  allTimeZones,
  filterTimeZones,
  isValidTimeZone,
  timeZoneEntries,
  timeZoneOffset,
} from '@/lib/timeZones';
import { TimeZoneSelect } from '@/components/common/TimeZoneSelect';

// cmdk scrolls items into view; jsdom has no layout.
Element.prototype.scrollIntoView ??= () => undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const LABELS = { search: 'Search', noResults: 'None', suggested: 'Suggested', all: 'All' };
const WINTER = new Date('2026-01-15T12:00:00Z');

describe('the time zones', () => {
  it('lists every zone the runtime knows, UTC first, Tehran and Istanbul among them', () => {
    const zones = allTimeZones();
    expect(zones[0]).toBe('UTC');
    expect(zones.length).toBeGreaterThan(300);
    expect(zones).toContain('Asia/Tehran');
    expect(zones).toContain('Europe/Istanbul');
  });

  it('reads each zone\'s offset as people do', () => {
    expect(timeZoneOffset('Asia/Tehran', WINTER)).toBe('UTC+03:30');
    expect(timeZoneOffset('Europe/Istanbul', WINTER)).toBe('UTC+03:00');
    expect(timeZoneOffset('UTC', WINTER)).toBe('UTC');
    expect(timeZoneOffset('America/New_York', WINTER)).toBe('UTC-05:00');
  });

  it('finds a zone by its city, its id or its offset', () => {
    const entries = timeZoneEntries('en', allTimeZones(), WINTER);
    expect(filterTimeZones(entries, 'tehran').map((e) => e.id)).toContain('Asia/Tehran');
    expect(filterTimeZones(entries, 'new york').map((e) => e.id)).toContain('America/New_York');
    expect(filterTimeZones(entries, '+03:30').map((e) => e.id)).toContain('Asia/Tehran');
    expect(filterTimeZones(entries, 'no such place')).toEqual([]);
  });

  it('tells a real zone from anything else', () => {
    expect(isValidTimeZone('Asia/Tehran')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('the picker', () => {
  it('shows the chosen zone, searches, and picks the one chosen', () => {
    const onChange = vi.fn();
    render(<TimeZoneSelect value="UTC" onChange={onChange} locale="en" labels={LABELS} />);
    expect(screen.getByTestId('timezone-trigger').textContent).toContain('UTC');
    fireEvent.click(screen.getByTestId('timezone-trigger'));
    fireEvent.change(screen.getByTestId('timezone-search'), { target: { value: 'tehran' } });
    fireEvent.click(screen.getByTestId('timezone-option-Asia/Tehran'));
    expect(onChange).toHaveBeenCalledWith('Asia/Tehran');
  });

  it('Enter in the search picks the first zone found', () => {
    const onChange = vi.fn();
    render(<TimeZoneSelect value="UTC" onChange={onChange} locale="en" labels={LABELS} />);
    fireEvent.click(screen.getByTestId('timezone-trigger'));
    const search = screen.getByTestId('timezone-search');
    fireEvent.change(search, { target: { value: 'istanbul' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('Europe/Istanbul');
  });

  it('a stored zone is shown even before the list opens, with its offset', () => {
    render(<TimeZoneSelect value="Asia/Tehran" onChange={() => undefined} locale="en" labels={LABELS} />);
    expect(screen.getByTestId('timezone-trigger').textContent).toMatch(/UTC\+03:30/);
  });
});
