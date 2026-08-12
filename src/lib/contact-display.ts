/**
 * Display name for a contact in operator surfaces.
 *
 * THE single resolver for "what do we call this contact" — Inbox, Contacts
 * (list/detail/drawer) and anything else showing a contact identity should
 * go through here instead of re-deriving a fallback locally. See
 * src/features/contacts/utils.ts's getDisplayName for the Contacts-surface
 * wrapper.
 *
 * NOT YET WIRED: Call Center (LiveQueuePage/CallsPage/OverviewPage/
 * RecordingsPage) still shows its own hardcoded `callCenter.common.anonymous`
 * string instead of this resolver. That's a deliberately deferred follow-up,
 * not an architectural dead end — `call_sessions`/`call_queue_entries`/
 * `callback_requests` all already carry `visitor_session_id`
 * (server/routes/calls.ts reuses networkProfile.ts's own
 * resolveConversationSessionId to stamp it, so it's the SAME session Inbox
 * resolves for that conversation), and `visitor_sessions.contact_id` is
 * already populated for every session touched by ensureVisitorContact/
 * identityMerge. So the join back to a `contacts` row — and this resolver —
 * is already there; nothing new needs to ship in the schema. What's
 * missing is purely surface-level: a batched
 * call-session(s)→contact resolver (mirroring
 * server/services/visitors/networkProfile.ts's
 * resolveConversationNetworkProfiles) plus a server route Call Center's
 * client-side Supabase reads don't have today, and then wiring that into
 * 4 files. Left undone here rather than rushed, since Call Center already
 * has its own denormalized visitor_name/visitor_email display fields and
 * changing those falls outside a display-precedence fix.
 *
 * Precedence:
 *   1. a real human name (anything but empty or the literal placeholder
 *      'Visitor' that ensureVisitorContact/mergeVisitorIdentity used to seed
 *      every anonymous contact with — see anonymousContact.ts's module doc
 *      comment; new rows use `name: null` instead, so this is a legacy-row
 *      compatibility check, not the primary path)
 *   2. anonymous fallback — localized "Visitor from {city} · {code}" (or
 *      "Visitor · {code}" without a city). `code` is `contacts.visitor_code`
 *      (021 migration; see server/services/widget/visitorCode.ts), falling
 *      back to the legacy `metadata.anon_code` hash, and finally to a
 *      display-only derivation from fallbackId for contacts that predate
 *      both and haven't been touched since (never written back).
 *
 * Email/phone are CONTACT METADATA, not a display-name fallback — a contact
 * known only by email still renders as "Visitor from {city} · {code}" here.
 * Callers show the email/phone separately (Contacts row/detail already do;
 * Inbox shows it in the contact header) — this function is only ever asked
 * "what is this contact called", not "what contact info do we have".
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

/** True when there is no real human name on file — email/phone don't count. */
export function isAnonymousContact(contact?: DisplayableContact | null): boolean {
  if (!contact) return true;
  const n = (contact.name ?? '').trim().toLowerCase();
  return !n || n === PLACEHOLDER;
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
  const code = resolveVisitorCode(contact, fallbackId);
  const cleanCity = sanitizeCity(city);
  return cleanCity
    ? t('inbox.visitorAnonymousFromCity', { city: cleanCity, code })
    : t('inbox.visitorAnonymous', { code });
}
