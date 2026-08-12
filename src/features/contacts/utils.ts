import type { Contact } from '@/types/models';
import { formatRelative } from '@/lib/date';
import { contactDisplayName, type ContactDisplayT } from '@/lib/contact-display';

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
 * called. City comes from `metadata.city` (already read by
 * getLocationFromMetadata below) — the same value this page already shows
 * in its location column/row, not a new geo lookup.
 */
export function getDisplayName(c: Contact, t: ContactDisplayT): string {
  const city = getLocationFromMetadata(c).city ?? null;
  return contactDisplayName(c, c.id, t, city);
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

export function getLocationFromMetadata(c: Contact): { city?: string; country?: string; flag?: string } {
  const meta = (c.metadata ?? {}) as Record<string, unknown>;
  return {
    city: (meta.city as string) || undefined,
    country: (meta.country as string) || undefined,
    flag: (meta.country_flag as string) || undefined,
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
