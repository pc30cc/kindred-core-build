/**
 * Display name for a contact in operator surfaces.
 *
 * THE single resolver for "what do we call this contact" — Inbox, Contacts
 * (list/detail/drawer) and anything else showing a contact identity should
 * go through here instead of re-deriving a fallback locally. See
 * src/features/contacts/utils.ts's getDisplayName for the Contacts-surface
 * wrapper.
 *
 * Precedence:
 *   1. a real name (anything but empty or the literal placeholder 'Visitor'
 *      that ensureVisitorContact/mergeVisitorIdentity seed every anonymous
 *      contact with)
 *   2. an email address — pre-existing behavior kept as-is: this codebase's
 *      own notion of "identified" already treats email/phone as sufficient
 *      (`anonymous: !(name || email || phone)` in anonymousContact.ts /
 *      identityMerge.ts), so an email-only contact is not the "anonymous"
 *      case below, it's just a contact with no name on file yet.
 *   3. anonymous fallback — localized "Visitor from {city} · {code}" (or
 *      "Visitor · {code}" without a city). `code` is `contacts.visitor_code`
 *      (021 migration; see server/services/widget/visitorCode.ts), falling
 *      back to the legacy `metadata.anon_code` hash, and finally to a
 *      display-only derivation from fallbackId for contacts that predate
 *      both and haven't been touched since (never written back).
 *
 * The anonymous label is a PRESENTATION string only — never persist it into
 * `name`/`display_name`. The real identity stays `name: null` (or the
 * literal placeholder) + `visitor_code` + city metadata; this function just
 * renders them together.
 */
export interface DisplayableContact {
  name?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown> | null;
  visitor_code?: string | null;
}

export type ContactDisplayT = (key: string, vars?: Record<string, string>) => string;

const PLACEHOLDER = 'visitor';

export function isAnonymousContact(contact?: DisplayableContact | null): boolean {
  if (!contact) return true;
  const n = (contact.name ?? '').trim().toLowerCase();
  return (!n || n === PLACEHOLDER) && !contact.email;
}

/** Treats null/undefined/blank/whitespace-only/literal "null"/"undefined" as unavailable. */
export function sanitizeCity(city: unknown): string | null {
  if (typeof city !== 'string') return null;
  const trimmed = city.trim();
  if (!trimmed) return null;
  if (/^(null|undefined|n\/a|unknown)$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Legacy, display-only derivation for a contact that predates both
 * `visitor_code` and `metadata.anon_code` (or lost the collision-retry race
 * and was never backfilled). Mirrors
 * server/services/widget/anonymousContact.ts's anonCodeFrom exactly so a
 * contact shows the same code the server would have assigned it, but this
 * copy is never written back — it's purely so the UI has *something* stable
 * to render instead of crashing or showing a blank code.
 */
function legacyCodeFrom(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(36).toUpperCase().padStart(4, '0').slice(-4);
}

export function resolveVisitorCode(
  contact: DisplayableContact | null | undefined,
  fallbackId?: string | null,
): string {
  const persisted = contact?.visitor_code;
  if (typeof persisted === 'string' && persisted.trim()) return persisted.trim();
  const legacy = (contact?.metadata as Record<string, unknown> | undefined)?.anon_code;
  if (typeof legacy === 'string' && legacy.trim()) return legacy.trim();
  return fallbackId ? legacyCodeFrom(fallbackId) : '----';
}

/**
 * @param contact the contact row (or the embedded `conversation.contacts`)
 * @param fallbackId a stable id to derive a legacy code from ONLY when the
 *   contact carries neither `visitor_code` nor `metadata.anon_code` — pass
 *   the contact's own id, never a conversation/session id (those aren't
 *   stable across the same visitor's repeat conversations).
 * @param t translate function (i18next-style `t(key, vars)`)
 * @param city optional current city for this visitor — pass whatever the
 *   caller already has (Inbox: `conversation.visitor_network.geo.city`;
 *   Contacts: `metadata.city`); never fetched by this function.
 */
export function contactDisplayName(
  contact: DisplayableContact | null | undefined,
  fallbackId: string | null | undefined,
  t: ContactDisplayT,
  city?: string | null,
): string {
  const name = (contact?.name ?? '').trim();
  if (name && name.toLowerCase() !== PLACEHOLDER) return name;
  if (contact?.email) return contact.email;
  const code = resolveVisitorCode(contact, fallbackId);
  const cleanCity = sanitizeCity(city);
  return cleanCity
    ? t('inbox.visitorAnonymousFromCity', { city: cleanCity, code })
    : t('inbox.visitorAnonymous', { code });
}
