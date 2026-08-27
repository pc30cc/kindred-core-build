import type { Contact } from '@/types/models';
import { formatRelative } from '@/lib/date';
import { contactDisplayName, type ContactDisplayT, type DisplayGeoInfo } from '@/lib/contact-display';
import { localizedLocationLabel } from '@/lib/geo/localizedGeo';
import { flagEmoji } from '@/hooks/useVisitorNetwork';

export function getInitials(name?: string | null, email?: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
  }
  if (email) return email.charAt(0).toUpperCase();
  return '?';
}

/**
 * Delegates to the canonical resolver (src/lib/contact-display.ts) so
 * Contacts never disagrees with Inbox about what an anonymous visitor is
 * called.
 *
 * City precedence: `networkGeo` (when the caller has one — the live
 * session-based geo from useVisitorNetworkBatchByContact/useVisitorNetwork,
 * the SAME canonical source Inbox reads) wins over `metadata.city` (a
 * snapshot only ever written once a visitor identifies — see
 * identityMerge.ts's resolveContactGeoPatch — so it can be stale or, for a
 * still-anonymous contact, simply absent). Callers that don't have a
 * network profile handy (or haven't fetched one) still get the
 * metadata.city fallback for free, so this stays a drop-in for existing
 * call sites.
 *
 * @param networkGeo the live network profile's `geo` (preferred — carries
 *   `country_code` so city localization can't collide two same-named
 *   cities), a bare city string (legacy call sites), or omitted.
 * @param locale active UI locale — drives city/country localization.
 */
export function getDisplayName(
  c: Contact,
  t: ContactDisplayT,
  networkGeo?: DisplayGeoInfo | string | null,
  locale?: string,
): string {
  let geoInfo: DisplayGeoInfo;
  if (typeof networkGeo === 'object' && networkGeo !== null) {
    geoInfo = { ...networkGeo };
  } else {
    geoInfo = { city: typeof networkGeo === 'string' ? networkGeo : undefined };
  }
  if (!geoInfo.city) {
    const meta = getLocationFromMetadata(c);
    geoInfo.city = meta.city ?? null;
    geoInfo.country_code = geoInfo.country_code ?? meta.countryCode ?? null;
  }
  return contactDisplayName(c, c.id, t, geoInfo, locale);
}

/**
 * Localized "City, Country" label for the Contacts location column/rows.
 * Prefers the live network profile (has `country_code`) over the
 * `metadata.city`/`metadata.country` snapshot, mirroring `getDisplayName`'s
 * own precedence so Contacts never shows two different cities for the same
 * contact in the same view.
 */
export function getLocalizedLocation(
  c: Contact,
  locale: string,
  networkGeo?: DisplayGeoInfo | null,
): { label: string | null; flag: string | null } {
  const meta = getLocationFromMetadata(c);
  const geo: DisplayGeoInfo = networkGeo?.city || networkGeo?.country_code
    ? networkGeo
    : { city: meta.city ?? null, country_code: meta.countryCode ?? null };
  const label = localizedLocationLabel(
    { city: geo.city, country_code: geo.country_code, region: geo.region, country: meta.country ?? null },
    locale,
  );
  // metadata.country_flag is only written once a visitor identifies, so fall
  // back to deriving the flag from whichever country code we actually have.
  const flag = meta.flag ?? (flagEmoji(geo.country_code) || null);
  return { label, flag };
}


/** Locale-aware relative time (Persian/Turkish/English follow the active UI locale). */
export function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return '—';
  return formatRelative(dateStr);
}

export function getCompanyFromMetadata(c: Contact): string | null {
  const meta = (c.metadata ?? {}) as Record<string, unknown>;
  const company = (meta.company ?? meta.org ?? meta.organization) as string | undefined;
  return company || null;
}

export function getLocationFromMetadata(c: Contact): { city?: string; country?: string; flag?: string; countryCode?: string } {
  const meta = (c.metadata ?? {}) as Record<string, unknown>;
  return {
    city: (meta.city as string) || undefined,
    country: (meta.country as string) || undefined,
    flag: (meta.country_flag as string) || undefined,
    countryCode: (meta.country_code as string) || undefined,
  };
}

export function getScoreFromMetadata(c: Contact): number {
  const meta = (c.metadata ?? {}) as Record<string, unknown>;
  const s = Number(meta.score);
  if (Number.isFinite(s) && s >= 0 && s <= 5) return s;
  return 0;
}

export function exportContactsToCSV(contacts: Contact[], columns?: string[]): string {
  const cols = columns ?? ['name', 'email', 'phone', 'tags', 'company', 'created_at', 'updated_at'];
  const header = cols.join(',');
  const rows = contacts.map((c) => {
    return cols
      .map((col) => {
        let val: unknown = '';
        if (col === 'tags') val = (c.tags ?? []).join('|');
        else if (col === 'company') val = getCompanyFromMetadata(c) ?? '';
        else val = (c as any)[col] ?? '';
        const s = String(val ?? '').replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
      })
      .join(',');
  });
  return [header, ...rows].join('\n');
}

export function downloadFile(filename: string, content: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim().length > 0);
  if (!lines.length) return { headers: [], rows: [] };
  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') {
          inQ = false;
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

export const CONTACT_FIELDS = [
  { key: 'name', label: 'Full Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'tags', label: 'Tags (pipe-separated)' },
  { key: 'company', label: 'Company' },
  { key: 'notes', label: 'Notes' },
] as const;
