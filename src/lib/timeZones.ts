/**
 * IANA time zones for a picker: every zone the browser knows
 * (Intl.supportedValuesOf), each with a name in the reader's language and its
 * offset from UTC, and a search over the three. Pure apart from Intl.
 */

/** Zones offered first: the ones the platforms' people use most. */
export const SUGGESTED_TIME_ZONES = [
  'Asia/Tehran',
  'UTC',
  'Europe/Istanbul',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
] as const;

/** A small list for an engine without Intl.supportedValuesOf (older browsers). */
const FALLBACK_ZONES = [
  ...SUGGESTED_TIME_ZONES,
  'Europe/Paris',
  'America/Chicago',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
];

export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Every zone, UTC included, sorted by its id. */
export function allTimeZones(): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    zones = typeof supported === 'function' ? supported('timeZone') : [];
  } catch {
    zones = [];
  }
  if (!zones.length) zones = [...FALLBACK_ZONES];
  return [...new Set(['UTC', ...zones])].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

/** The zone's offset now, as people read it: "UTC+03:30", "UTC" for UTC itself. */
export function timeZoneOffset(zone: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName');
    const value = part?.value?.replace('GMT', 'UTC') || 'UTC';
    return value === 'UTC+00:00' || value === 'UTC-00:00' ? 'UTC' : value;
  } catch {
    return 'UTC';
  }
}

/** The zone's name in a language ("Iran Standard Time"), or its id when the engine has none. */
export function timeZoneName(zone: string, locale: string, at: Date = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (name && name !== zone && !/^GMT[+-]/.test(name)) return name;
  } catch {
    /* an engine without the zone's name */
  }
  return zone;
}

export interface TimeZoneEntry {
  id: string;
  name: string;
  offset: string;
  /** Lower-cased words a search matches against. */
  search: string;
}

export function timeZoneEntries(locale: string, zones: readonly string[] = allTimeZones(), at: Date = new Date()): TimeZoneEntry[] {
  return zones.map((id) => {
    const name = timeZoneName(id, locale, at);
    const offset = timeZoneOffset(id, at);
    // "Asia/Tehran" is also found as "tehran"; "America/New_York" as "new york".
    const words = `${id} ${id.replace(/[/_]/g, ' ')} ${name} ${offset}`;
    return { id, name, offset, search: words.toLowerCase() };
  });
}

/** The entries a query finds: every word of it somewhere in the zone's id, name or offset. */
export function filterTimeZones(entries: readonly TimeZoneEntry[], query: string): TimeZoneEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => words.every((w) => e.search.includes(w)));
}
