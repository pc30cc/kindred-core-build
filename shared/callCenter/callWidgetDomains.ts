/**
 * The call widget's sites, counted the same way by the Install page and the
 * server (server/services/callCenter/callWidgetDomains.ts; owner,
 * 2026-11-28): the registered website counts as one of the plan's
 * `max_call_widget_domains` (-1 = unlimited), the call center's own list
 * holds the rest, and an entry that only spells the registered website (its
 * `www.` twin included) takes no slot of its own.
 */

export const CALL_WIDGET_DOMAINS_LIMIT_KEY = 'max_call_widget_domains';

/** One list entry: an optional `*.` and ASCII labels, no scheme, path or port. */
const DOMAIN_RE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;

/** A list entry as stored: trimmed and lower case. */
export function cleanDomainEntry(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

export function isValidDomainEntry(entry: string): boolean {
  return entry.length > 0 && entry.length <= 253 && DOMAIN_RE.test(entry);
}

/** The list as stored: trimmed, lower case, no blanks, each once, in order. */
export function cleanDomainList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const entry = cleanDomainEntry(raw);
    if (entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/** A host without its leading `www.`. */
export function bareDomain(domain: string): string {
  const d = cleanDomainEntry(domain);
  return d.startsWith('www.') ? d.slice(4) : d;
}

/** The list entries that take a slot: a spelling of the registered website does not. */
export function listEntriesTakingSlots(registered: string[], list: unknown): string[] {
  const own = new Set(registered.map(bareDomain));
  return cleanDomainList(list).filter((entry) => entry.startsWith('*.') || !own.has(bareDomain(entry)));
}

/** The slots used: the registered website (one, however many verified rows) and the list's others. */
export function domainSlotsUsed(registered: string[], list: unknown): number {
  return (registered.length > 0 ? 1 : 0) + listEntriesTakingSlots(registered, list).length;
}

/** May one more site be added? `max` null = not known yet (nothing offered). */
export function canAddDomain(registered: string[], list: unknown, max: number | null): boolean {
  if (max === null) return false;
  if (max < 0) return true;
  return domainSlotsUsed(registered, list) < max;
}
