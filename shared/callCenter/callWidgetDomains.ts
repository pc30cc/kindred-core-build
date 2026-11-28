/**
 * The call widget's sites, counted the same way by the Install page and the
 * server (server/services/callCenter/callWidgetDomains.ts; owner,
 * 2026-11-28): the registered website counts as one of the plan's
 * `max_call_widget_domains` (-1 = unlimited), the call center's own list
 * holds the rest, and an entry that only spells the registered website (its
 * `www.` twin included) takes no slot of its own.
 */

export const CALL_WIDGET_DOMAINS_LIMIT_KEY = 'max_call_widget_domains';

/**
 * One list entry: an optional `*.` and ASCII labels (punycode `xn--` ones
 * included, top level too), no scheme, path or port. The server also refuses
 * a `*.` on a public suffix (`*.com.tr`).
 */
const DOMAIN_RE = /^(\*\.)?([a-z0-9-]+\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/;

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

/**
 * The sites the list adds, one key each: a host and its `www.` twin are one
 * site (the matcher takes either for both), a `*.` entry is its own, and a
 * spelling of the registered website is none.
 */
export function listSlotKeys(registered: string[], list: unknown): string[] {
  const own = new Set(registered.map(bareDomain));
  const keys: string[] = [];
  for (const entry of cleanDomainList(list)) {
    const key = entry.startsWith('*.') ? entry : bareDomain(entry);
    if (!entry.startsWith('*.') && own.has(key)) continue;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** The slots used: the registered website (one, however many verified rows) and the list's sites. */
export function domainSlotsUsed(registered: string[], list: unknown): number {
  return (registered.length > 0 ? 1 : 0) + listSlotKeys(registered, list).length;
}

/**
 * Past the number with a site the stored list did not have? A list that is
 * resent, shortened or respelled adds no site, so it never is.
 */
export function addsSitePastLimit(input: { list: unknown; stored: unknown; registered: string[]; max: number }): boolean {
  if (input.max < 0) return false;
  const before = new Set(listSlotKeys(input.registered, input.stored));
  const added = listSlotKeys(input.registered, input.list).filter((key) => !before.has(key));
  return added.length > 0 && domainSlotsUsed(input.registered, input.list) > input.max;
}

/**
 * May one more row be added? A row not filled in yet holds a slot too, so the
 * page never offers more rows than the plan allows. `max` null = not known
 * yet (nothing offered), -1 = unlimited.
 */
export function canAddDomain(registered: string[], rows: string[], max: number | null): boolean {
  if (max === null) return false;
  if (max < 0) return true;
  const blank = rows.filter((row) => !cleanDomainEntry(row)).length;
  return domainSlotsUsed(registered, rows) + blank < max;
}
